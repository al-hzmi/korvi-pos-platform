import {
  ProductBootstrapError,
  normalizeProductBarcode,
  normalizeProductName,
  normalizeProductPriceMinor,
  normalizeProductSku,
  normalizeUnitLabel,
} from '../catalog/product-bootstrap.js';
import {
  ImportNormalizationError,
  importCellText,
  normalizeHeaderKey,
  parseExactSarToMinor,
  parseVatBasisPoints,
} from './normalization.js';
import { classifyImportIssues } from './model.js';
import type { ImportCell, ImportIssue, ImportRowReview, ImportSheet } from './model.js';
import type { ProductType } from '../ports/persistence.js';

export type ProductImportField =
  | 'sku'
  | 'barcode'
  | 'nameAr'
  | 'nameEn'
  | 'productType'
  | 'unitLabel'
  | 'sellingPrice'
  | 'vatRate';

export interface ProductColumnMapping {
  readonly sourceColumn: number;
  readonly targetField: ProductImportField | null;
}

export interface ProductMappingSuggestion {
  readonly sourceColumn: number;
  readonly sourceHeader: string;
  readonly targetField: ProductImportField | null;
  readonly reason: 'exact-alias' | 'unmapped';
}

export interface CanonicalProductImportRow {
  readonly sku: string;
  readonly barcode: string | null;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType;
  readonly unitLabel: string;
  readonly priceMinor: string;
  readonly vatBasisPoints: number | undefined;
}

const REQUIRED_FIELDS = new Set<ProductImportField>([
  'sku',
  'nameAr',
  'productType',
  'unitLabel',
  'sellingPrice',
]);

const ALIASES: Readonly<Record<ProductImportField, readonly string[]>> = {
  sku: ['sku', 'item no', 'item number', 'item code', 'رقم الصنف', 'كود الصنف', 'رمز الصنف'],
  barcode: ['barcode', 'bar code', 'ean', 'باركود', 'الباركود', 'رقم الباركود'],
  nameAr: ['arabic name', 'name ar', 'اسم عربي', 'الاسم العربي', 'اسم الصنف', 'اسم المنتج'],
  nameEn: ['english name', 'name en', 'اسم انجليزي', 'الاسم الانجليزي', 'اسم الصنف انجليزي'],
  productType: ['product type', 'item type', 'نوع الصنف', 'نوع المنتج'],
  unitLabel: ['unit', 'uom', 'unit label', 'الوحدة', 'وحدة', 'وحدة القياس'],
  sellingPrice: ['price', 'selling price', 'sale price', 'سعر البيع', 'السعر', 'سعر الحبة'],
  vatRate: [
    'vat',
    'vat rate',
    'tax',
    'tax rate',
    'الضريبة',
    'نسبة الضريبة',
    'ضريبة القيمة المضافة',
  ],
};

const ALIAS_TO_FIELD = new Map<string, ProductImportField>();
for (const [field, aliases] of Object.entries(ALIASES) as Array<
  [ProductImportField, readonly string[]]
>) {
  for (const alias of aliases) ALIAS_TO_FIELD.set(normalizeHeaderKey(alias), field);
}

function rawCell(cell: ImportCell | undefined): string | null {
  if (cell === undefined) return null;
  return importCellText(cell);
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

export function suggestProductMappings(
  headerRow: readonly ImportCell[],
): readonly ProductMappingSuggestion[] {
  return headerRow.map((cell, sourceColumn) => {
    try {
      const header = rawCell(cell) ?? '';
      const targetField = ALIAS_TO_FIELD.get(normalizeHeaderKey(header)) ?? null;
      return {
        sourceColumn,
        sourceHeader: header,
        targetField,
        reason: targetField === null ? 'unmapped' : 'exact-alias',
      } as const;
    } catch {
      return { sourceColumn, sourceHeader: '', targetField: null, reason: 'unmapped' } as const;
    }
  });
}

export function validateProductMappings(
  headerRow: readonly ImportCell[],
  mappings: readonly ProductColumnMapping[],
): readonly ImportIssue[] {
  const issues: ImportIssue[] = [];
  const targets = new Map<ProductImportField, number>();

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

  for (const required of REQUIRED_FIELDS) {
    if (!targets.has(required)) {
      issues.push(
        issue(
          'BLOCKED',
          'required-field-unmapped',
          `Required Korvi product field is not mapped: ${required}.`,
          null,
          null,
          required,
        ),
      );
    }
  }
  return issues;
}

function parseProductType(value: string): ProductType {
  const normalized = normalizeHeaderKey(value);
  if (normalized === 'unit' || normalized === 'وحدة' || normalized === 'حبة') return 'unit';
  if (normalized === 'weighted' || normalized === 'weight' || normalized === 'وزني')
    return 'weighted';
  throw new ImportNormalizationError('Product type must be explicitly unit or weighted.');
}

function mappedValue(
  row: readonly ImportCell[],
  mappings: readonly ProductColumnMapping[],
  field: ProductImportField,
): { readonly value: string | null; readonly column: number | null; readonly formula: boolean } {
  const mapping = mappings.find((candidate) => candidate.targetField === field);
  if (mapping === undefined) return { value: null, column: null, formula: false };
  const cell = row[mapping.sourceColumn];
  if (cell?.kind === 'formula') {
    return { value: null, column: mapping.sourceColumn, formula: true };
  }
  if (cell?.kind === 'text' && cell.formulaLike) {
    return { value: null, column: mapping.sourceColumn, formula: true };
  }
  return {
    value: cell === undefined ? null : importCellText(cell),
    column: mapping.sourceColumn,
    formula: false,
  };
}

function cleanOptionalName(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  return normalizeProductName(value);
}

export function reviewProductSheet(
  sheet: ImportSheet,
  mappings: readonly ProductColumnMapping[],
): readonly ImportRowReview<CanonicalProductImportRow>[] {
  const header = sheet.rows[0] ?? [];
  const mappingIssues = validateProductMappings(header, mappings);
  if (mappingIssues.some((entry) => entry.classification === 'BLOCKED')) {
    return sheet.rows.slice(1).map((_row, index) => ({
      sourceRow: index + 2,
      classification: 'BLOCKED',
      record: null,
      issues: mappingIssues.map((entry) => ({ ...entry, row: index + 2 })),
    }));
  }

  const reviews: ImportRowReview<CanonicalProductImportRow>[] = [];
  const seenSku = new Map<string, number>();
  const seenBarcode = new Map<string, number>();

  for (const [rowIndex, row] of sheet.rows.slice(1).entries()) {
    const sourceRow = rowIndex + 2;
    const issues: ImportIssue[] = [];
    const values = new Map<ProductImportField, ReturnType<typeof mappedValue>>();
    for (const field of Object.keys(ALIASES) as ProductImportField[]) {
      values.set(field, mappedValue(row, mappings, field));
    }

    for (const [field, value] of values) {
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

    let record: CanonicalProductImportRow | null = null;
    if (!issues.some((entry) => entry.classification === 'BLOCKED')) {
      try {
        const skuRaw = values.get('sku')?.value ?? '';
        const nameArRaw = values.get('nameAr')?.value ?? '';
        const typeRaw = values.get('productType')?.value ?? '';
        const unitRaw = values.get('unitLabel')?.value ?? '';
        const priceRaw = values.get('sellingPrice')?.value ?? '';
        if ([skuRaw, nameArRaw, typeRaw, unitRaw, priceRaw].some((value) => value.trim() === '')) {
          throw new ImportNormalizationError('One or more required product fields are blank.');
        }

        const sku = normalizeProductSku(skuRaw);
        const barcode = normalizeProductBarcode(values.get('barcode')?.value);
        const nameAr = normalizeProductName(nameArRaw);
        const nameEn = cleanOptionalName(values.get('nameEn')?.value ?? null);
        const productType = parseProductType(typeRaw);
        const unitLabel = normalizeUnitLabel(unitRaw);
        const priceMinor = normalizeProductPriceMinor(parseExactSarToMinor(priceRaw));
        const vatRaw = values.get('vatRate')?.value ?? null;
        const vatBasisPoints =
          vatRaw === null || vatRaw === '' ? undefined : parseVatBasisPoints(vatRaw);

        const previousSku = seenSku.get(sku);
        if (previousSku !== undefined) {
          issues.push(
            issue(
              'ERROR',
              'duplicate-sku-in-file',
              `SKU duplicates source row ${String(previousSku)}.`,
              sourceRow,
              values.get('sku')?.column ?? null,
              'sku',
            ),
          );
        } else {
          seenSku.set(sku, sourceRow);
        }

        if (barcode !== null) {
          const previousBarcode = seenBarcode.get(barcode);
          if (previousBarcode !== undefined) {
            issues.push(
              issue(
                'ERROR',
                'duplicate-barcode-in-file',
                `Barcode duplicates source row ${String(previousBarcode)}.`,
                sourceRow,
                values.get('barcode')?.column ?? null,
                'barcode',
              ),
            );
          } else {
            seenBarcode.set(barcode, sourceRow);
          }
        }

        record = {
          sku,
          barcode,
          nameAr,
          nameEn,
          productType,
          unitLabel,
          priceMinor,
          vatBasisPoints,
        };
      } catch (error) {
        if (error instanceof ImportNormalizationError || error instanceof ProductBootstrapError) {
          issues.push(issue('ERROR', 'invalid-product-row', error.message, sourceRow, null, null));
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
