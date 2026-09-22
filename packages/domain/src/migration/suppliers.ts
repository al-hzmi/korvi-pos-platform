import { assertSupplierName, PurchasingRequestError } from '../purchasing/purchasing.js';
import { importCellText, normalizeHeaderKey } from './normalization.js';
import { classifyImportIssues } from './model.js';
import type { ImportCell, ImportIssue, ImportRowReview, ImportSheet } from './model.js';

export type SupplierImportField = 'name';

export interface SupplierColumnMapping {
  readonly sourceColumn: number;
  readonly targetField: SupplierImportField | null;
}

export interface SupplierMappingSuggestion {
  readonly sourceColumn: number;
  readonly sourceHeader: string;
  readonly targetField: SupplierImportField | null;
  readonly reason: 'exact-alias' | 'unmapped';
}

export interface CanonicalSupplierImportRow {
  readonly name: string;
}

const ALIASES: readonly string[] = [
  'supplier',
  'supplier name',
  'vendor',
  'vendor name',
  'المورد',
  'اسم المورد',
  'الموردين',
  'اسم الشركة',
];

const ALIAS_TO_FIELD = new Map<string, SupplierImportField>();
for (const alias of ALIASES) ALIAS_TO_FIELD.set(normalizeHeaderKey(alias), 'name');

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

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function rawCell(cell: ImportCell | undefined): {
  readonly value: string | null;
  readonly formula: boolean;
  readonly controlCharacter: boolean;
} {
  if (cell === undefined || cell.kind === 'blank') {
    return { value: null, formula: false, controlCharacter: false };
  }
  if (cell.kind === 'formula') {
    return { value: null, formula: true, controlCharacter: false };
  }
  if (cell.kind === 'text' && cell.formulaLike) {
    return { value: null, formula: true, controlCharacter: false };
  }
  const value = importCellText(cell);
  return {
    value,
    formula: false,
    controlCharacter: value !== null && hasAsciiControlCharacter(value),
  };
}

export function suggestSupplierMappings(
  headerRow: readonly ImportCell[],
): readonly SupplierMappingSuggestion[] {
  return headerRow.map((cell, sourceColumn) => {
    try {
      const raw = rawCell(cell);
      const sourceHeader = raw.value ?? '';
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

export function validateSupplierMappings(
  headerRow: readonly ImportCell[],
  mappings: readonly SupplierColumnMapping[],
): readonly ImportIssue[] {
  const issues: ImportIssue[] = [];
  const sources = new Set<number>();
  let nameColumn: number | null = null;

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
    if (mapping.targetField !== 'name') continue;
    if (nameColumn !== null) {
      issues.push(
        issue(
          'BLOCKED',
          'duplicate-target-mapping',
          'A Korvi field may be mapped from only one source column.',
          null,
          mapping.sourceColumn,
          'name',
        ),
      );
      continue;
    }
    nameColumn = mapping.sourceColumn;
  }

  if (nameColumn === null) {
    issues.push(
      issue(
        'BLOCKED',
        'required-field-unmapped',
        'Required Korvi supplier field is not mapped: name.',
        null,
        null,
        'name',
      ),
    );
  }
  return issues;
}

export function reviewSupplierSheet(
  sheet: ImportSheet,
  mappings: readonly SupplierColumnMapping[],
): readonly ImportRowReview<CanonicalSupplierImportRow>[] {
  const header = sheet.rows[0] ?? [];
  const mappingIssues = validateSupplierMappings(header, mappings);
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

  const nameColumn = mappings.find((mapping) => mapping.targetField === 'name')!.sourceColumn;
  const reviews: ImportRowReview<CanonicalSupplierImportRow>[] = [];
  for (const [rowIndex, row] of sheet.rows.slice(1).entries()) {
    const sourceRow = sheet.sourceRowNumbers?.[rowIndex + 1] ?? rowIndex + 2;
    const raw = rawCell(row[nameColumn]);
    const issues: ImportIssue[] = [];
    let record: CanonicalSupplierImportRow | null = null;

    if (raw.formula) {
      issues.push(
        issue(
          'BLOCKED',
          'formula-not-authority',
          'Spreadsheet formulas are never import authority.',
          sourceRow,
          nameColumn,
          'name',
        ),
      );
    } else if (raw.controlCharacter) {
      issues.push(
        issue(
          'ERROR',
          'control-character-not-allowed',
          'Control characters are not valid supplier data.',
          sourceRow,
          nameColumn,
          'name',
        ),
      );
    } else {
      try {
        record = { name: assertSupplierName(raw.value ?? '') };
      } catch (error) {
        if (!(error instanceof PurchasingRequestError)) throw error;
        issues.push(
          issue(
            'ERROR',
            'invalid-supplier-row',
            error.message,
            sourceRow,
            nameColumn,
            'name',
          ),
        );
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
