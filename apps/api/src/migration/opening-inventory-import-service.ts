import { createHash } from 'node:crypto';
import { XlsxParseError, parseXlsxDocument } from './xlsx.js';
import {
  ImportParseError,
  parseCsvDocument,
  requirePrincipalPermission,
  suggestOpeningInventoryMappings,
  tenantId as brandTenantId,
  validateOpeningInventoryMappings,
} from '@korvi/domain';
import {
  OpeningInventoryImportRefusedError,
  commitOpeningInventoryImport,
  createOpeningInventoryImportJob,
  dryRunOpeningInventoryImport,
  readOpeningInventoryImportJob,
  readOpeningInventoryImportRows,
} from '@korvi/database';
import type {
  ImportCell,
  OpeningInventoryColumnMapping,
  OpeningInventoryMappingSuggestion,
  TenantScope,
} from '@korvi/domain';
import type {
  PrismaClient,
  OpeningInventoryImportRefusal,
  OpeningInventoryImportRowPage,
  OpeningInventoryImportSummary,
} from '@korvi/database';
import type { AuthenticatedPrincipal } from '@korvi/domain';

export const MAX_OPENING_INVENTORY_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_OPENING_INVENTORY_IMPORT_DATA_ROWS = 50_000;
export const MAX_OPENING_INVENTORY_IMPORT_PREVIEW_ROWS = 20;

export type OpeningInventoryCsvDelimiter = ',' | ';' | '\t';

export type OpeningInventoryMigrationFailureReason =
  OpeningInventoryImportRefusal | 'file-too-large' | 'invalid-csv' | 'invalid-xlsx' | 'empty-file';

export type OpeningInventoryMigrationResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: OpeningInventoryMigrationFailureReason };

export interface CsvOpeningInventorySourceInput {
  readonly csvText: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
  readonly delimiter: OpeningInventoryCsvDelimiter;
}

export interface CreateCsvOpeningInventoryImportRequest extends CsvOpeningInventorySourceInput {
  readonly operationId: string;
  readonly mapping: readonly OpeningInventoryColumnMapping[];
}

export interface XlsxOpeningInventorySourceInput {
  readonly xlsxBase64: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
}

export interface CreateXlsxOpeningInventoryImportRequest extends XlsxOpeningInventorySourceInput {
  readonly operationId: string;
  readonly mapping: readonly OpeningInventoryColumnMapping[];
}

export interface OpeningInventorySourceInspection {
  readonly sourceSha256: string;
  readonly fileBytes: number;
  readonly totalRows: number;
  readonly header: readonly OpeningInventoryMappingSuggestion[];
  readonly mappingIssues: ReturnType<typeof validateOpeningInventoryMappings>;
  readonly previewRows: readonly {
    readonly sourceRow: number;
    readonly cells: readonly ImportCell[];
  }[];
}

export interface MerchantOpeningInventoryMigrationService {
  inspectCsv(
    principal: AuthenticatedPrincipal,
    input: CsvOpeningInventorySourceInput,
  ): Promise<OpeningInventoryMigrationResult<OpeningInventorySourceInspection>>;
  createCsvJob(
    principal: AuthenticatedPrincipal,
    request: CreateCsvOpeningInventoryImportRequest,
  ): Promise<OpeningInventoryMigrationResult<OpeningInventoryImportSummary>>;
  inspectXlsx(
    principal: AuthenticatedPrincipal,
    input: XlsxOpeningInventorySourceInput,
  ): Promise<OpeningInventoryMigrationResult<OpeningInventorySourceInspection>>;
  createXlsxJob(
    principal: AuthenticatedPrincipal,
    request: CreateXlsxOpeningInventoryImportRequest,
  ): Promise<OpeningInventoryMigrationResult<OpeningInventoryImportSummary>>;
  readJob(
    principal: AuthenticatedPrincipal,
    jobId: string,
  ): Promise<OpeningInventoryMigrationResult<OpeningInventoryImportSummary | null>>;
  rows(
    principal: AuthenticatedPrincipal,
    jobId: string,
    options: {
      readonly limit: number;
      readonly afterSourceRow: number | null;
      readonly problemsOnly: boolean;
    },
  ): Promise<OpeningInventoryMigrationResult<OpeningInventoryImportRowPage | null>>;
  dryRun(
    principal: AuthenticatedPrincipal,
    jobId: string,
  ): Promise<OpeningInventoryMigrationResult<OpeningInventoryImportSummary>>;
  commit(
    principal: AuthenticatedPrincipal,
    jobId: string,
    operationId: string,
  ): Promise<OpeningInventoryMigrationResult<OpeningInventoryImportSummary>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

function sourceSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseSource(input: CsvOpeningInventorySourceInput): OpeningInventoryMigrationResult<{
  readonly sheet: ReturnType<typeof parseCsvDocument>['sheets'][number];
  readonly sha256: string;
  readonly bytes: number;
}> {
  const bytes = Buffer.byteLength(input.csvText, 'utf8');
  if (bytes > MAX_OPENING_INVENTORY_IMPORT_BYTES) {
    return { outcome: 'failure', reason: 'file-too-large' };
  }
  try {
    const document = parseCsvDocument(input.csvText, {
      delimiter: input.delimiter,
      maxRows: MAX_OPENING_INVENTORY_IMPORT_DATA_ROWS + 1,
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

function parseXlsxSource(input: XlsxOpeningInventorySourceInput): OpeningInventoryMigrationResult<{
  readonly sheet: ReturnType<typeof parseXlsxDocument>['sheets'][number];
  readonly sha256: string;
  readonly bytes: number;
}> {
  const decoded = decodeBase64Strict(input.xlsxBase64);
  if (decoded === null) return { outcome: 'failure', reason: 'invalid-xlsx' };
  if (decoded.length > MAX_OPENING_INVENTORY_IMPORT_BYTES) {
    return { outcome: 'failure', reason: 'file-too-large' };
  }
  try {
    const document = parseXlsxDocument(decoded, {
      fileName: input.fileName,
      sourceSystem: input.sourceSystem,
      maxRows: MAX_OPENING_INVENTORY_IMPORT_DATA_ROWS + 1,
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

async function databaseAttempt<T>(
  work: () => Promise<T>,
): Promise<OpeningInventoryMigrationResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof OpeningInventoryImportRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantOpeningInventoryMigrationService(
  prisma: PrismaClient,
): MerchantOpeningInventoryMigrationService {
  return {
    async inspectCsv(principal, input) {
      requirePrincipalPermission(principal, 'settings.manage');
      const parsed = parseSource(input);
      if (parsed.outcome === 'failure') return parsed;
      const { sheet, sha256, bytes } = parsed.value;
      const header = suggestOpeningInventoryMappings(sheet.rows[0]!);
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
          mappingIssues: validateOpeningInventoryMappings(sheet.rows[0]!, suggestedMapping),
          previewRows: sheet.rows
            .slice(1, MAX_OPENING_INVENTORY_IMPORT_PREVIEW_ROWS + 1)
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
        createOpeningInventoryImportJob(
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
      const header = suggestOpeningInventoryMappings(sheet.rows[0]!);
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
          mappingIssues: validateOpeningInventoryMappings(sheet.rows[0]!, suggestedMapping),
          previewRows: sheet.rows
            .slice(1, MAX_OPENING_INVENTORY_IMPORT_PREVIEW_ROWS + 1)
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
        createOpeningInventoryImportJob(
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
      return databaseAttempt(() =>
        readOpeningInventoryImportJob(prisma, scopeOf(principal), jobId),
      );
    },

    async rows(principal, jobId, options) {
      requirePrincipalPermission(principal, 'settings.manage');
      return databaseAttempt(() =>
        readOpeningInventoryImportRows(prisma, scopeOf(principal), jobId, options),
      );
    },

    async dryRun(principal, jobId) {
      requirePrincipalPermission(principal, 'settings.manage');
      return databaseAttempt(() =>
        dryRunOpeningInventoryImport(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          jobId,
        ),
      );
    },

    async commit(principal, jobId, operationId) {
      requirePrincipalPermission(principal, 'settings.manage');
      requirePrincipalPermission(principal, 'inventory.adjust');
      return databaseAttempt(() =>
        commitOpeningInventoryImport(
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
