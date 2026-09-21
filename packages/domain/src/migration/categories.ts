import {
  CategoryBootstrapError,
  normalizeCategoryBootstrap,
} from '../catalog/category-bootstrap.js';
import {
  ImportNormalizationError,
  importCellText,
  normalizeArabicDigits,
  normalizeHeaderKey,
} from './normalization.js';
import { classifyImportIssues } from './model.js';
import type {
  ImportCell,
  ImportIssue,
  ImportRowReview,
  ImportSheet,
} from './model.js';

export type CategoryImportField = 'nameAr' | 'nameEn' | 'sortOrder';

export interface CategoryColumnMapping {
  readonly sourceColumn: number;
  readonly targetField: CategoryImportField | null;
}

export interface CategoryMappingSuggestion {
  readonly sourceColumn: number;
  readonly sourceHeader: string;
  readonly targetField: CategoryImportField | null;
  readonly reason: 'exact-alias' | 'unmapped';
}

export interface CanonicalCategoryImportRow {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sortOrder: number;
}

const REQUIRED_FIELDS = new Set<CategoryImportField>(['nameAr']);

const ALIASES: Readonly<Record<CategoryImportField, readonly string[]>> = {
  nameAr: [
    'category',
    'category name',
    'name ar',
    'arabic name',
    'الفئة',
    'اسم الفئة',
    'التصنيف',
    'اسم التصنيف',
    'القسم',
    'اسم القسم',
  ],
  nameEn: [
    'category english',
    'category name english',
    'name en',
    'english name',
    'الاسم الانجليزي',
    'اسم الفئة انجليزي',
    'اسم التصنيف انجليزي',
  ],
  sortOrder: ['sort order', 'sort', 'order', 'الترتيب', 'ترتيب', 'ترتيب العرض'],
};

const ALIAS_TO_FIELD = new Map<string, CategoryImportField>();
for (const [field, aliases] of Object.entries(ALIASES) as Array<
  [CategoryImportField, readonly string[]]
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

function rawCell(cell: ImportCell | undefined): string | null {
  if (cell === undefined) return null;
  return importCellText(cell);
}

export function suggestCategoryMappings(
  headerRow: readonly ImportCell[],
): readonly CategoryMappingSuggestion[] {
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
      return {
        sourceColumn,
        sourceHeader: '',
        targetField: null,
        reason: 'unmapped',
      } as const;
    }
  });
}

export function validateCategoryMappings(
  headerRow: readonly ImportCell[],
  mappings: readonly CategoryColumnMapping[],
): readonly ImportIssue[] {
  const issues: ImportIssue[] = [];
  const targets = new Map<CategoryImportField, number>();
  const sources = new Set<number>();

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

  for (const required of REQUIRED_FIELDS) {
    if (!targets.has(required)) {
      issues.push(
        issue(
          'BLOCKED',
          'required-field-unmapped',
          `Required Korvi category field is not mapped: ${required}.`,
          null,
          null,
          required,
        ),
      );
    }
  }
  return issues;
}

function mappedValue(
  row: readonly ImportCell[],
  mappings: readonly CategoryColumnMapping[],
  field: CategoryImportField,
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

function parseSortOrder(value: string | null): number {
  if (value === null || value.trim() === '') return 0;
  const normalized = normalizeArabicDigits(value).trim();
  if (!/^(?:0|[1-9][0-9]{0,6})$/u.test(normalized)) {
    throw new ImportNormalizationError('Category sort order must be a non-negative integer.');
  }
  return Number(normalized);
}

export function reviewCategorySheet(
  sheet: ImportSheet,
  mappings: readonly CategoryColumnMapping[],
): readonly ImportRowReview<CanonicalCategoryImportRow>[] {
  const header = sheet.rows[0] ?? [];
  const mappingIssues = validateCategoryMappings(header, mappings);
  if (mappingIssues.some((entry) => entry.classification === 'BLOCKED')) {
    return sheet.rows.slice(1).map((_row, index) => ({
      sourceRow: sheet.sourceRowNumbers?.[index + 1] ?? index + 2,
      classification: 'BLOCKED',
      record: null,
      issues: mappingIssues.map((entry) => ({
        ...entry,
        row: sheet.sourceRowNumbers?.[index + 1] ?? index + 2,
      })),
    }));
  }

  const reviews: ImportRowReview<CanonicalCategoryImportRow>[] = [];
  const seenNameAr = new Map<string, number>();

  for (const [index, row] of sheet.rows.slice(1).entries()) {
    const sourceRow = sheet.sourceRowNumbers?.[index + 1] ?? index + 2;
    const issues: ImportIssue[] = [];
    const values = new Map<CategoryImportField, ReturnType<typeof mappedValue>>();
    for (const field of Object.keys(ALIASES) as CategoryImportField[]) {
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

    let record: CanonicalCategoryImportRow | null = null;
    if (!issues.some((entry) => entry.classification === 'BLOCKED')) {
      try {
        const nameArRaw = values.get('nameAr')?.value ?? '';
        if (nameArRaw.trim() === '') {
          throw new ImportNormalizationError('Arabic category name is required.');
        }
        const normalized = normalizeCategoryBootstrap({
          nameAr: nameArRaw,
          nameEn: values.get('nameEn')?.value ?? null,
          sortOrder: parseSortOrder(values.get('sortOrder')?.value ?? null),
        });

        const previous = seenNameAr.get(normalized.nameAr);
        if (previous !== undefined) {
          issues.push(
            issue(
              'ERROR',
              'duplicate-category-in-file',
              `Category name duplicates source row ${String(previous)}.`,
              sourceRow,
              values.get('nameAr')?.column ?? null,
              'nameAr',
            ),
          );
        } else {
          seenNameAr.set(normalized.nameAr, sourceRow);
        }

        record = normalized;
      } catch (error) {
        if (error instanceof ImportNormalizationError || error instanceof CategoryBootstrapError) {
          issues.push(issue('ERROR', 'invalid-category-row', error.message, sourceRow, null, null));
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
