export type ImportDomain =
  | 'products'
  | 'categories'
  | 'customers'
  | 'suppliers'
  | 'opening-inventory'
  | 'opening-customer-balances'
  | 'price-lists'
  | 'loyalty';

export type ImportFormat = 'csv' | 'xlsx';

export type ImportClassification = 'VALID' | 'WARNING' | 'ERROR' | 'BLOCKED';

export type ImportCell =
  | { readonly kind: 'blank' }
  | { readonly kind: 'text'; readonly value: string; readonly formulaLike: boolean }
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | {
      readonly kind: 'formula';
      readonly expression: string;
      readonly cachedValue: string | null;
    };

export interface ImportSourceDescriptor {
  readonly format: ImportFormat;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
}

export interface ImportSheet {
  readonly name: string;
  /** 1-based source row numbers are reconstructed as index + 1. */
  readonly rows: readonly (readonly ImportCell[])[];
}

export interface ImportDocument {
  readonly source: ImportSourceDescriptor;
  readonly sheets: readonly ImportSheet[];
}

export interface ImportIssue {
  readonly classification: Exclude<ImportClassification, 'VALID'>;
  readonly code: string;
  readonly message: string;
  readonly row: number | null;
  readonly sourceColumn: number | null;
  readonly targetField: string | null;
}

export interface ImportRowReview<T> {
  readonly sourceRow: number;
  readonly classification: ImportClassification;
  readonly record: T | null;
  readonly issues: readonly ImportIssue[];
}

export interface ImportReviewSummary {
  readonly totalRows: number;
  readonly validRows: number;
  readonly warningRows: number;
  readonly errorRows: number;
  readonly blockedRows: number;
}

export function classifyImportIssues(issues: readonly ImportIssue[]): ImportClassification {
  if (issues.some((issue) => issue.classification === 'BLOCKED')) return 'BLOCKED';
  if (issues.some((issue) => issue.classification === 'ERROR')) return 'ERROR';
  if (issues.some((issue) => issue.classification === 'WARNING')) return 'WARNING';
  return 'VALID';
}

export function summarizeImportReviews(
  rows: readonly ImportRowReview<unknown>[],
): ImportReviewSummary {
  let validRows = 0;
  let warningRows = 0;
  let errorRows = 0;
  let blockedRows = 0;
  for (const row of rows) {
    switch (row.classification) {
      case 'VALID':
        validRows += 1;
        break;
      case 'WARNING':
        warningRows += 1;
        break;
      case 'ERROR':
        errorRows += 1;
        break;
      case 'BLOCKED':
        blockedRows += 1;
        break;
    }
  }
  return {
    totalRows: rows.length,
    validRows,
    warningRows,
    errorRows,
    blockedRows,
  };
}
