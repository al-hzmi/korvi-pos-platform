import { createHash } from 'node:crypto';
import { XlsxParseError, parseXlsxDocument } from './xlsx.js';
import {
  ImportParseError,
  parseCsvDocument,
  requirePrincipalPermission,
  suggestCategoryMappings,
  tenantId as brandTenantId,
  validateCategoryMappings,
} from '@korvi/domain';
import {
  CategoryImportRefusedError,
  commitCategoryImport,
  createCategoryImportJob,
  dryRunCategoryImport,
  readCategoryImportJob,
  readCategoryImportRows,
} from '@korvi/database';
import type {
  CategoryColumnMapping,
  CategoryMappingSuggestion,
  ImportCell,
  TenantScope,
} from '@korvi/domain';
import type {
  CategoryImportRefusal,
  CategoryImportRowPage,
  CategoryImportSummary,
  PrismaClient,
} from '@korvi/database';
import type { AuthenticatedPrincipal } from '@korvi/domain';

export const MAX_CATEGORY_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_CATEGORY_IMPORT_DATA_ROWS = 50_000;
export const MAX_CATEGORY_IMPORT_PREVIEW_ROWS = 20;

export type CategoryCsvDelimiter = ',' | ';' | '\t';

export type CategoryMigrationFailureReason =
  CategoryImportRefusal | 'file-too-large' | 'invalid-csv' | 'invalid-xlsx' | 'empty-file';

export type CategoryMigrationResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: CategoryMigrationFailureReason };

export interface CsvCategorySourceInput {
  readonly csvText: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
  readonly delimiter: CategoryCsvDelimiter;
}

export interface CreateCsvCategoryImportRequest extends CsvCategorySourceInput {
  readonly operationId: string;
  readonly mapping: readonly CategoryColumnMapping[];
}

export interface XlsxCategorySourceInput {
  readonly xlsxBase64: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
}

export interface CreateXlsxCategoryImportRequest extends XlsxCategorySourceInput {
  readonly operationId: string;
  readonly mapping: readonly CategoryColumnMapping[];
}

export interface CategorySourceInspection {
  readonly sourceSha256: string;
  readonly fileBytes: number;
  readonly totalRows: number;
  readonly header: readonly CategoryMappingSuggestion[];
  readonly mappingIssues: ReturnType<typeof validateCategoryMappings>;
  readonly previewRows: readonly {
    readonly sourceRow: number;
    readonly cells: readonly ImportCell[];
  }[];
}

export interface MerchantCategoryMigrationService {
  inspectCsv(
    principal: AuthenticatedPrincipal,
    input: CsvCategorySourceInput,
  ): Promise<CategoryMigrationResult<CategorySourceInspection>>;
  createCsvJob(
    principal: AuthenticatedPrincipal,
    request: CreateCsvCategoryImportRequest,
  ): Promise<CategoryMigrationResult<CategoryImportSummary>>;
  inspectXlsx(
    principal: AuthenticatedPrincipal,
    input: XlsxCategorySourceInput,
  ): Promise<CategoryMigrationResult<CategorySourceInspection>>;
  createXlsxJob(
    principal: AuthenticatedPrincipal,
    request: CreateXlsxCategoryImportRequest,
  ): Promise<CategoryMigrationResult<CategoryImportSummary>>;
  readJob(
    principal: AuthenticatedPrincipal,
    jobId: string,
  ): Promise<CategoryMigrationResult<CategoryImportSummary | null>>;
  rows(
    principal: AuthenticatedPrincipal,
    jobId: string,
    options: {
      readonly limit: number;
      readonly afterSourceRow: number | null;
      readonly problemsOnly: boolean;
    },
  ): Promise<CategoryMigrationResult<CategoryImportRowPage | null>>;
  dryRun(
    principal: AuthenticatedPrincipal,
    jobId: string,
  ): Promise<CategoryMigrationResult<CategoryImportSummary>>;
  commit(
    principal: AuthenticatedPrincipal,
    jobId: string,
    operationId: string,
  ): Promise<CategoryMigrationResult<CategoryImportSummary>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

function sourceSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseCsvSource(input: CsvCategorySourceInput): CategoryMigrationResult<{
  readonly sheet: ReturnType<typeof parseCsvDocument>['sheets'][number];
  readonly sha256: string;
  readonly bytes: number;
}> {
  const bytes = Buffer.byteLength(input.csvText, 'utf8');
  if (bytes > MAX_CATEGORY_IMPORT_BYTES) {
    return { outcome: 'failure', reason: 'file-too-large' };
  }
  try {
    const document = parseCsvDocument(input.csvText, {
      delimiter: input.delimiter,
      maxRows: MAX_CATEGORY_IMPORT_DATA_ROWS + 1,
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
  return decoded.toString('base64') === value ? decoded : null;
}

function parseXlsxSource(input: XlsxCategorySourceInput): CategoryMigrationResult<{
  readonly sheet: ReturnType<typeof parseXlsxDocument>['sheets'][number];
  readonly sha256: string;
  readonly bytes: number;
}> {
  const decoded = decodeBase64Strict(input.xlsxBase64);
  if (decoded === null) return { outcome: 'failure', reason: 'invalid-xlsx' };
  if (decoded.length > MAX_CATEGORY_IMPORT_BYTES) {
    return { outcome: 'failure', reason: 'file-too-large' };
  }
  try {
    const document = parseXlsxDocument(decoded, {
      fileName: input.fileName,
      sourceSystem: input.sourceSystem,
      maxRows: MAX_CATEGORY_IMPORT_DATA_ROWS + 1,
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

async function databaseAttempt<T>(work: () => Promise<T>): Promise<CategoryMigrationResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof CategoryImportRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantCategoryMigrationService(
  prisma: PrismaClient,
): MerchantCategoryMigrationService {
  return {
    async inspectCsv(principal, input) {
      requirePrincipalPermission(principal, 'settings.manage');
      const parsed = parseCsvSource(input);
      if (parsed.outcome === 'failure') return parsed;
      const { sheet, sha256, bytes } = parsed.value;
      const header = suggestCategoryMappings(sheet.rows[0]!);
      const suggestedMapping = header.map((entry) => ({
        sourceColumn: entry.sourceColumn,
        targetField: entry.targetField,
      }));
      return {
        outcome: 'success',
        value: {
          sourceSha256: sha256,
          fileBytes: bytes,
          totalRows: Math.max(0, sheet.rows.length - 1),
          header,
          mappingIssues: validateCategoryMappings(sheet.rows[0]!, suggestedMapping),
          previewRows: sheet.rows
            .slice(1, MAX_CATEGORY_IMPORT_PREVIEW_ROWS + 1)
            .map((cells, index) => ({
              sourceRow: sheet.sourceRowNumbers?.[index + 1] ?? index + 2,
              cells,
            })),
        },
      };
    },

    async createCsvJob(principal, request) {
      requirePrincipalPermission(principal, 'settings.manage');
      const parsed = parseCsvSource(request);
      if (parsed.outcome === 'failure') return parsed;
      return databaseAttempt(() =>
        createCategoryImportJob(
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
      const header = suggestCategoryMappings(sheet.rows[0]!);
      const suggestedMapping = header.map((entry) => ({
        sourceColumn: entry.sourceColumn,
        targetField: entry.targetField,
      }));
      return {
        outcome: 'success',
        value: {
          sourceSha256: sha256,
          fileBytes: bytes,
          totalRows: Math.max(0, sheet.rows.length - 1),
          header,
          mappingIssues: validateCategoryMappings(sheet.rows[0]!, suggestedMapping),
          previewRows: sheet.rows
            .slice(1, MAX_CATEGORY_IMPORT_PREVIEW_ROWS + 1)
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
        createCategoryImportJob(
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
      return databaseAttempt(() => readCategoryImportJob(prisma, scopeOf(principal), jobId));
    },

    async rows(principal, jobId, options) {
      requirePrincipalPermission(principal, 'settings.manage');
      return databaseAttempt(() =>
        readCategoryImportRows(prisma, scopeOf(principal), jobId, options),
      );
    },

    async dryRun(principal, jobId) {
      requirePrincipalPermission(principal, 'settings.manage');
      return databaseAttempt(() =>
        dryRunCategoryImport(prisma, scopeOf(principal), { userId: principal.userId }, jobId),
      );
    },

    async commit(principal, jobId, operationId) {
      requirePrincipalPermission(principal, 'settings.manage');
      requirePrincipalPermission(principal, 'product.write');
      return databaseAttempt(() =>
        commitCategoryImport(
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
