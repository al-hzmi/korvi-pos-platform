import { createHash } from 'node:crypto';
import { XlsxParseError, parseXlsxDocument } from './xlsx.js';
import {
  ImportParseError,
  parseCsvDocument,
  requirePrincipalPermission,
  suggestProductMappings,
  tenantId as brandTenantId,
  validateProductMappings,
} from '@korvi/domain';
import {
  ProductImportRefusedError,
  commitProductImport,
  createProductImportJob,
  dryRunProductImport,
  readProductImportJob,
} from '@korvi/database';
import type {
  ImportCell,
  ProductColumnMapping,
  ProductMappingSuggestion,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient, ProductImportRefusal, ProductImportSummary } from '@korvi/database';
import type { AuthenticatedPrincipal } from '@korvi/domain';

export const MAX_PRODUCT_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_PRODUCT_IMPORT_DATA_ROWS = 50_000;
export const MAX_PRODUCT_IMPORT_PREVIEW_ROWS = 20;

export type CsvDelimiter = ',' | ';' | '\t';

export type ProductMigrationFailureReason =
  | ProductImportRefusal
  | 'file-too-large'
  | 'invalid-csv'
  | 'invalid-xlsx'
  | 'empty-file';

export type ProductMigrationResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: ProductMigrationFailureReason };

export interface CsvProductSourceInput {
  readonly csvText: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
  readonly delimiter: CsvDelimiter;
}

export interface CreateCsvProductImportRequest extends CsvProductSourceInput {
  readonly operationId: string;
  readonly mapping: readonly ProductColumnMapping[];
}

export interface XlsxProductSourceInput {
  readonly xlsxBase64: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
}

export interface CreateXlsxProductImportRequest extends XlsxProductSourceInput {
  readonly operationId: string;
  readonly mapping: readonly ProductColumnMapping[];
}

export interface ProductSourceInspection {
  readonly sourceSha256: string;
  readonly fileBytes: number;
  readonly totalRows: number;
  readonly header: readonly ProductMappingSuggestion[];
  readonly mappingIssues: ReturnType<typeof validateProductMappings>;
  readonly previewRows: readonly {
    readonly sourceRow: number;
    readonly cells: readonly ImportCell[];
  }[];
}

export interface MerchantProductMigrationService {
  inspectCsv(
    principal: AuthenticatedPrincipal,
    input: CsvProductSourceInput,
  ): Promise<ProductMigrationResult<ProductSourceInspection>>;
  createCsvJob(
    principal: AuthenticatedPrincipal,
    request: CreateCsvProductImportRequest,
  ): Promise<ProductMigrationResult<ProductImportSummary>>;
  inspectXlsx(
    principal: AuthenticatedPrincipal,
    input: XlsxProductSourceInput,
  ): Promise<ProductMigrationResult<ProductSourceInspection>>;
  createXlsxJob(
    principal: AuthenticatedPrincipal,
    request: CreateXlsxProductImportRequest,
  ): Promise<ProductMigrationResult<ProductImportSummary>>;
  readJob(
    principal: AuthenticatedPrincipal,
    jobId: string,
  ): Promise<ProductMigrationResult<ProductImportSummary | null>>;
  dryRun(
    principal: AuthenticatedPrincipal,
    jobId: string,
  ): Promise<ProductMigrationResult<ProductImportSummary>>;
  commit(
    principal: AuthenticatedPrincipal,
    jobId: string,
    operationId: string,
  ): Promise<ProductMigrationResult<ProductImportSummary>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

function sourceSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseSource(input: CsvProductSourceInput): ProductMigrationResult<{
  readonly sheet: ReturnType<typeof parseCsvDocument>['sheets'][number];
  readonly sha256: string;
  readonly bytes: number;
}> {
  const bytes = Buffer.byteLength(input.csvText, 'utf8');
  if (bytes > MAX_PRODUCT_IMPORT_BYTES) {
    return { outcome: 'failure', reason: 'file-too-large' };
  }
  try {
    const document = parseCsvDocument(input.csvText, {
      delimiter: input.delimiter,
      maxRows: MAX_PRODUCT_IMPORT_DATA_ROWS + 1,
      maxColumns: 200,
      maxCellCharacters: 20_000,
      fileName: input.fileName,
      sourceSystem: input.sourceSystem,
    });
    const sheet = document.sheets[0];
    if (sheet === undefined || sheet.rows.length === 0) {
      return { outcome: 'failure', reason: 'empty-file' };
    }
    return {
      outcome: 'success',
      value: { sheet, sha256: sourceSha256(input.csvText), bytes },
    };
  } catch (error) {
    if (error instanceof ImportParseError) {
      return { outcome: 'failure', reason: 'invalid-csv' };
    }
    throw error;
  }
}


function decodeBase64Strict(value: string): Buffer | null {
  if (value === '' || value.length > 7_000_000 || value.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  const canonical = decoded.toString('base64');
  return canonical === value ? decoded : null;
}

function parseXlsxSource(input: XlsxProductSourceInput): ProductMigrationResult<{
  readonly sheet: ReturnType<typeof parseXlsxDocument>['sheets'][number];
  readonly sha256: string;
  readonly bytes: number;
}> {
  const decoded = decodeBase64Strict(input.xlsxBase64);
  if (decoded === null) return { outcome: 'failure', reason: 'invalid-xlsx' };
  if (decoded.length > MAX_PRODUCT_IMPORT_BYTES) {
    return { outcome: 'failure', reason: 'file-too-large' };
  }
  try {
    const document = parseXlsxDocument(decoded, {
      fileName: input.fileName,
      sourceSystem: input.sourceSystem,
      maxRows: MAX_PRODUCT_IMPORT_DATA_ROWS + 1,
      maxColumns: 200,
      maxCellCharacters: 20_000,
      maxUncompressedBytes: 40 * 1024 * 1024,
      maxEntryBytes: 12 * 1024 * 1024,
      maxEntries: 256,
      maxCompressionRatio: 250,
    });
    const sheet = document.sheets[0];
    if (sheet === undefined || sheet.rows.length === 0) {
      return { outcome: 'failure', reason: 'empty-file' };
    }
    return {
      outcome: 'success',
      value: { sheet, sha256: sourceSha256(decoded), bytes: decoded.length },
    };
  } catch (error) {
    if (error instanceof XlsxParseError) {
      return { outcome: 'failure', reason: 'invalid-xlsx' };
    }
    throw error;
  }
}

async function databaseAttempt<T>(work: () => Promise<T>): Promise<ProductMigrationResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof ProductImportRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantProductMigrationService(
  prisma: PrismaClient,
): MerchantProductMigrationService {
  return {
    async inspectCsv(principal, input) {
      requirePrincipalPermission(principal, 'settings.manage');
      const parsed = parseSource(input);
      if (parsed.outcome === 'failure') return parsed;
      const { sheet, sha256, bytes } = parsed.value;
      const header = suggestProductMappings(sheet.rows[0]!);
      const suggestedMapping = header.map((suggestion) => ({
        sourceColumn: suggestion.sourceColumn,
        targetField: suggestion.targetField,
      }));
      return {
        outcome: 'success',
        value: {
          sourceSha256: sha256,
          fileBytes: bytes,
          totalRows: Math.max(0, sheet.rows.length - 1),
          header,
          mappingIssues: validateProductMappings(sheet.rows[0]!, suggestedMapping),
          previewRows: sheet.rows
            .slice(1, MAX_PRODUCT_IMPORT_PREVIEW_ROWS + 1)
            .map((cells, index) => ({
              sourceRow: sheet.sourceRowNumbers?.[index + 1] ?? index + 2,
              cells,
            })),
        },
      };
    },

    async createCsvJob(principal, request) {
      requirePrincipalPermission(principal, 'settings.manage');
      const parsed = parseSource(request);
      if (parsed.outcome === 'failure') return parsed;
      return databaseAttempt(() =>
        createProductImportJob(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          {
            operationId: request.operationId,
            sourceSha256: parsed.value.sha256,
            format: 'csv',
            sourceFileName: request.fileName,
            sourceSystem: request.sourceSystem,
            sheet: parsed.value.sheet,
            mapping: request.mapping,
          },
        ),
      );
    },

    async inspectXlsx(principal, input) {
      requirePrincipalPermission(principal, 'settings.manage');
      const parsed = parseXlsxSource(input);
      if (parsed.outcome === 'failure') return parsed;
      const { sheet, sha256, bytes } = parsed.value;
      const header = suggestProductMappings(sheet.rows[0]!);
      const suggestedMapping = header.map((suggestion) => ({
        sourceColumn: suggestion.sourceColumn,
        targetField: suggestion.targetField,
      }));
      return {
        outcome: 'success',
        value: {
          sourceSha256: sha256,
          fileBytes: bytes,
          totalRows: Math.max(0, sheet.rows.length - 1),
          header,
          mappingIssues: validateProductMappings(sheet.rows[0]!, suggestedMapping),
          previewRows: sheet.rows
            .slice(1, MAX_PRODUCT_IMPORT_PREVIEW_ROWS + 1)
            .map((cells, index) => ({
              sourceRow: sheet.sourceRowNumbers?.[index + 1] ?? index + 2,
              cells,
            })),
        },
      };
    },

    async createXlsxJob(principal, request) {
      requirePrincipalPermission(principal, 'settings.manage');
      const parsed = parseXlsxSource(request);
      if (parsed.outcome === 'failure') return parsed;
      return databaseAttempt(() =>
        createProductImportJob(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          {
            operationId: request.operationId,
            sourceSha256: parsed.value.sha256,
            format: 'xlsx',
            sourceFileName: request.fileName,
            sourceSystem: request.sourceSystem,
            sheet: parsed.value.sheet,
            mapping: request.mapping,
          },
        ),
      );
    },

    async readJob(principal, jobId) {
      requirePrincipalPermission(principal, 'settings.manage');
      return databaseAttempt(() => readProductImportJob(prisma, scopeOf(principal), jobId));
    },

    async dryRun(principal, jobId) {
      requirePrincipalPermission(principal, 'settings.manage');
      return databaseAttempt(() =>
        dryRunProductImport(prisma, scopeOf(principal), { userId: principal.userId }, jobId),
      );
    },

    async commit(principal, jobId, operationId) {
      requirePrincipalPermission(principal, 'settings.manage');
      requirePrincipalPermission(principal, 'product.write');
      return databaseAttempt(() =>
        commitProductImport(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          jobId,
          operationId,
        ),
      );
    },
  };
}
