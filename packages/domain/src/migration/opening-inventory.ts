import { MerchantAdminError, normalizeAdminCode } from '../administration/merchant-admin.js';
import { ProductBootstrapError, normalizeProductSku } from '../catalog/product-bootstrap.js';
import { InvalidAmountError } from '../errors.js';
import { quantityFromDecimalString } from '../quantity/quantity.js';
import {
  ImportNormalizationError,
  importCellText,
  normalizeArabicDigits,
  normalizeHeaderKey,
} from './normalization.js';
import { classifyImportIssues } from './model.js';
import type { ImportCell, ImportIssue, ImportRowReview, ImportSheet } from './model.js';

export type OpeningInventoryImportField = 'branchCode' | 'sku' | 'openingQuantity';

export interface OpeningInventoryColumnMapping {
  readonly sourceColumn: number;
  readonly targetField: OpeningInventoryImportField | null;
}

export interface OpeningInventoryMappingSuggestion {
  readonly sourceColumn: number;
  readonly sourceHeader: string;
  readonly targetField: OpeningInventoryImportField | null;
  readonly reason: 'exact-alias' | 'unmapped';
}

export interface CanonicalOpeningInventoryImportRow {
  readonly branchCode: string;
  readonly sku: string;
  /** Non-zero opening quantity, scaled by 1000 as exact integer text. */
  readonly quantityScaled: string;
}

const REQUIRED_FIELDS = new Set<OpeningInventoryImportField>([
  'branchCode',
  'sku',
  'openingQuantity',
]);

const ALIASES: Readonly<Record<OpeningInventoryImportField, readonly string[]>> = {
  branchCode: ['branch', 'branch code', 'store code', 'كود الفرع', 'رمز الفرع', 'الفرع'],
  sku: ['sku', 'item code', 'item no', 'item number', 'رقم الصنف', 'كود الصنف', 'رمز الصنف'],
  openingQuantity: [
    'opening quantity',
    'opening qty',
    'opening stock',
    'initial stock',
    'initial quantity',
    'الكمية الافتتاحية',
    'الرصيد الافتتاحي',
    'رصيد افتتاحي',
    'مخزون افتتاحي',
  ],
};

const ALIAS_TO_FIELD = new Map<string, OpeningInventoryImportField>();
for (const [field, aliases] of Object.entries(ALIASES) as Array<
  [OpeningInventoryImportField, readonly string[]]
>) {
  for (const alias of aliases) ALIAS_TO_FIELD.set(normalizeHeaderKey(alias), field);
}

function issue(
  classification: 'WARNING' | 'ERROR' | 'BLOCKED',
  code: string,
  message: string,
  row: number | null,
  sourceColumn: number | null,
  targetField: string | null,
): ImportIssue {
  return { classification, code, message, row, sourceColumn, targetField };
}

function cellValue(
  row: readonly ImportCell[],
  mappings: readonly OpeningInventoryColumnMapping[],
  field: OpeningInventoryImportField,
): { readonly value: string | null; readonly column: number | null; readonly formula: boolean } {
  const mapping = mappings.find((candidate) => candidate.targetField === field);
  if (mapping === undefined) return { value: null, column: null, formula: false };
  const cell = row[mapping.sourceColumn];
  if (cell?.kind === 'formula' || (cell?.kind === 'text' && cell.formulaLike)) {
    return { value: null, column: mapping.sourceColumn, formula: true };
  }
  return {
    value: cell === undefined ? null : importCellText(cell),
    column: mapping.sourceColumn,
    formula: false,
  };
}

function openingQuantityScaled(value: string): string {
  const normalized = normalizeArabicDigits(value).trim().replace('٫', '.');
  if (normalized.includes(',')) {
    throw new ImportNormalizationError(
      'Opening quantity does not accept ambiguous comma punctuation.',
    );
  }
  const quantity = quantityFromDecimalString(normalized);
  if (quantity === 0n) {
    throw new ImportNormalizationError('Opening quantity must be greater than zero.');
  }
  return quantity.toString();
}

export function suggestOpeningInventoryMappings(
  headerRow: readonly ImportCell[],
): readonly OpeningInventoryMappingSuggestion[] {
  return headerRow.map((cell, sourceColumn) => {
    try {
      const sourceHeader = importCellText(cell) ?? '';
      const targetField = ALIAS_TO_FIELD.get(normalizeHeaderKey(sourceHeader)) ?? null;
      return {
        sourceColumn,
        sourceHeader,
        targetField,
        reason: targetField === null ? 'unmapped' : 'exact-alias',
      } as const;
    } catch {
      return { sourceColumn, sourceHeader: '', targetField: null, reason: 'unmapped' } as const;
    }
  });
}

export function validateOpeningInventoryMappings(
  headerRow: readonly ImportCell[],
  mappings: readonly OpeningInventoryColumnMapping[],
): readonly ImportIssue[] {
  const issues: ImportIssue[] = [];
  const sources = new Set<number>();
  const targets = new Map<OpeningInventoryImportField, number>();

  for (const mapping of mappings) {
    if (
      !Number.isInteger(mapping.sourceColumn) ||
      mapping.sourceColumn < 0 ||
      mapping.sourceColumn >= headerRow.length
    ) {
      issues.push(
        issue(
          'BLOCKED',
          'source-column-out-of-range',
          'Mapped source column does not exist.',
          null,
          mapping.sourceColumn,
          mapping.targetField,
        ),
      );
      continue;
    }
    if (sources.has(mapping.sourceColumn)) {
      issues.push(
        issue(
          'BLOCKED',
          'duplicate-source-mapping',
          'A source column may map to at most one Korvi field.',
          null,
          mapping.sourceColumn,
          mapping.targetField,
        ),
      );
      continue;
    }
    sources.add(mapping.sourceColumn);
    if (mapping.targetField === null) continue;
    const existing = targets.get(mapping.targetField);
    if (existing !== undefined) {
      issues.push(
        issue(
          'BLOCKED',
          'duplicate-target-mapping',
          'A Korvi field may be mapped from only one source column.',
          null,
          mapping.sourceColumn,
          mapping.targetField,
        ),
      );
      continue;
    }
    targets.set(mapping.targetField, mapping.sourceColumn);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!targets.has(field)) {
      issues.push(
        issue(
          'BLOCKED',
          'required-field-unmapped',
          `Required opening inventory field is not mapped: ${field}.`,
          null,
          null,
          field,
        ),
      );
    }
  }
  return issues;
}

export function reviewOpeningInventorySheet(
  sheet: ImportSheet,
  mappings: readonly OpeningInventoryColumnMapping[],
): readonly ImportRowReview<CanonicalOpeningInventoryImportRow>[] {
  const header = sheet.rows[0] ?? [];
  const mappingIssues = validateOpeningInventoryMappings(header, mappings);
  if (mappingIssues.some((entry) => entry.classification === 'BLOCKED')) {
    return sheet.rows.slice(1).map((_row, index) => {
      const sourceRow = sheet.sourceRowNumbers?.[index + 1] ?? index + 2;
      return {
        sourceRow,
        classification: 'BLOCKED' as const,
        record: null,
        issues: mappingIssues.map((entry) => ({ ...entry, row: sourceRow })),
      };
    });
  }

  const reviews: ImportRowReview<CanonicalOpeningInventoryImportRow>[] = [];
  const seen = new Map<string, number>();

  for (const [rowIndex, row] of sheet.rows.slice(1).entries()) {
    const sourceRow = sheet.sourceRowNumbers?.[rowIndex + 1] ?? rowIndex + 2;
    const issues: ImportIssue[] = [];
    const branch = cellValue(row, mappings, 'branchCode');
    const sku = cellValue(row, mappings, 'sku');
    const opening = cellValue(row, mappings, 'openingQuantity');

    for (const [field, value] of [
      ['branchCode', branch],
      ['sku', sku],
      ['openingQuantity', opening],
    ] as const) {
      if (value.formula) {
        issues.push(
          issue(
            'BLOCKED',
            'formula-not-authority',
            'Spreadsheet formulas are never import authority.',
            sourceRow,
            value.column,
            field,
          ),
        );
      }
    }

    let record: CanonicalOpeningInventoryImportRow | null = null;
    if (!issues.some((entry) => entry.classification === 'BLOCKED')) {
      try {
        const branchRaw = branch.value ?? '';
        const skuRaw = sku.value ?? '';
        const openingRaw = opening.value ?? '';
        if ([branchRaw, skuRaw, openingRaw].some((value) => value.trim() === '')) {
          throw new ImportNormalizationError(
            'One or more required opening inventory fields are blank.',
          );
        }

        const branchCode = normalizeAdminCode(branchRaw);
        const normalizedSku = normalizeProductSku(skuRaw);
        const quantityScaled = openingQuantityScaled(openingRaw);
        const key = branchCode + '\u0000' + normalizedSku;
        const previous = seen.get(key);
        if (previous !== undefined) {
          issues.push(
            issue(
              'ERROR',
              'duplicate-opening-stock-in-file',
              `Opening stock for this branch/SKU duplicates source row ${String(previous)}.`,
              sourceRow,
              null,
              null,
            ),
          );
        } else {
          seen.set(key, sourceRow);
        }
        record = { branchCode, sku: normalizedSku, quantityScaled };
      } catch (error) {
        if (
          error instanceof ImportNormalizationError ||
          error instanceof MerchantAdminError ||
          error instanceof ProductBootstrapError ||
          error instanceof InvalidAmountError
        ) {
          issues.push(
            issue('ERROR', 'invalid-opening-inventory-row', error.message, sourceRow, null, null),
          );
        } else {
          throw error;
        }
      }
    }

    const classification = classifyImportIssues(issues);
    reviews.push({
      sourceRow,
      classification,
      record: classification === 'ERROR' || classification === 'BLOCKED' ? null : record,
      issues,
    });
  }

  return reviews;
}
