import { classifyImportIssues } from './model.js';
import type { ImportCell, ImportIssue, ImportRowReview, ImportSheet } from './model.js';

export type CustomerImportField = 'nameAr' | 'nameEn' | 'phone' | 'email' | 'vatNumber';

export interface CustomerColumnMapping {
  readonly sourceColumn: number;
  readonly targetField: CustomerImportField | null;
}

export interface CustomerMappingSuggestion {
  readonly sourceColumn: number;
  readonly sourceHeader: string;
  readonly targetField: CustomerImportField | null;
  readonly reason: 'exact-alias' | 'unmapped';
}

export interface CanonicalCustomerImportRow {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
}

const REQUIRED_FIELDS = new Set<CustomerImportField>(['nameAr']);

const ALIASES: Readonly<Record<CustomerImportField, readonly string[]>> = {
  nameAr: [
    'customer',
    'customer name',
    'name ar',
    'arabic name',
    'اسم العميل',
    'العميل',
    'اسم عربي',
    'الاسم العربي',
  ],
  nameEn: [
    'customer english',
    'customer name english',
    'name en',
    'english name',
    'اسم العميل انجليزي',
    'الاسم الانجليزي',
  ],
  phone: ['phone', 'mobile', 'telephone', 'رقم الجوال', 'الجوال', 'الهاتف', 'رقم الهاتف'],
  email: ['email', 'e-mail', 'البريد', 'البريد الالكتروني', 'البريد الإلكتروني'],
  vatNumber: [
    'vat number',
    'vat no',
    'tax number',
    'tax registration number',
    'الرقم الضريبي',
    'رقم الضريبة',
    'الرقم الضريبي للعميل',
  ],
};

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s_\-./\\()[\]{}:،,]+/gu, '');
}

const ALIAS_TO_FIELD = new Map<string, CustomerImportField>();
for (const [field, aliases] of Object.entries(ALIASES) as Array<
  [CustomerImportField, readonly string[]]
>) {
  for (const alias of aliases) ALIAS_TO_FIELD.set(normalizeHeader(alias), field);
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
  if (cell.kind === 'text') {
    if (cell.formulaLike) return { value: null, formula: true, controlCharacter: false };
    return {
      value: cell.value,
      formula: false,
      controlCharacter: hasAsciiControlCharacter(cell.value),
    };
  }
  const value = cell.kind === 'boolean' ? (cell.value ? 'true' : 'false') : cell.value;
  return { value, formula: false, controlCharacter: false };
}

function cleanRequired(value: string | null, max: number, label: string): string {
  const candidate = (value ?? '').trim();
  if (candidate === '' || candidate.length > max || hasAsciiControlCharacter(candidate)) {
    throw new Error('Invalid ' + label + '.');
  }
  return candidate;
}

function cleanOptional(value: string | null, max: number, label: string): string | null {
  if (value === null) return null;
  const candidate = value.trim();
  if (candidate === '') return null;
  if (candidate.length > max || hasAsciiControlCharacter(candidate)) {
    throw new Error('Invalid ' + label + '.');
  }
  return candidate;
}

function cleanEmail(value: string | null): string | null {
  const candidate = cleanOptional(value, 320, 'customer email');
  if (candidate === null) return null;
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(candidate) ||
    candidate.startsWith('.') ||
    candidate.endsWith('.')
  ) {
    throw new Error('Invalid customer email.');
  }
  return candidate;
}

function cleanVatNumber(value: string | null): string | null {
  const candidate = cleanOptional(value, 15, 'customer VAT number');
  if (candidate === null) return null;
  if (!/^[0-9]{15}$/u.test(candidate)) throw new Error('Customer VAT number must be 15 digits.');
  return candidate;
}

export function suggestCustomerMappings(
  headerRow: readonly ImportCell[],
): readonly CustomerMappingSuggestion[] {
  return headerRow.map((cell, sourceColumn) => {
    try {
      const raw = rawCell(cell);
      const sourceHeader = raw.value ?? '';
      const targetField = ALIAS_TO_FIELD.get(normalizeHeader(sourceHeader)) ?? null;
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

export function validateCustomerMappings(
  headerRow: readonly ImportCell[],
  mappings: readonly CustomerColumnMapping[],
): readonly ImportIssue[] {
  const issues: ImportIssue[] = [];
  const targets = new Map<CustomerImportField, number>();
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
    if (targets.has(mapping.targetField)) {
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
          `Required Korvi customer field is not mapped: ${required}.`,
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
  mappings: readonly CustomerColumnMapping[],
  field: CustomerImportField,
): {
  readonly value: string | null;
  readonly column: number | null;
  readonly formula: boolean;
  readonly controlCharacter: boolean;
} {
  const mapping = mappings.find((candidate) => candidate.targetField === field);
  if (mapping === undefined) {
    return { value: null, column: null, formula: false, controlCharacter: false };
  }
  const raw = rawCell(row[mapping.sourceColumn]);
  return { ...raw, column: mapping.sourceColumn };
}

export function reviewCustomerSheet(
  sheet: ImportSheet,
  mappings: readonly CustomerColumnMapping[],
): readonly ImportRowReview<CanonicalCustomerImportRow>[] {
  const header = sheet.rows[0] ?? [];
  const mappingIssues = validateCustomerMappings(header, mappings);
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

  const reviews: ImportRowReview<CanonicalCustomerImportRow>[] = [];
  const seenPhone = new Map<string, number>();

  for (const [rowIndex, row] of sheet.rows.slice(1).entries()) {
    const sourceRow = sheet.sourceRowNumbers?.[rowIndex + 1] ?? rowIndex + 2;
    const issues: ImportIssue[] = [];
    const values = new Map<CustomerImportField, ReturnType<typeof mappedValue>>();
    for (const field of Object.keys(ALIASES) as CustomerImportField[]) {
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
      } else if (value.controlCharacter) {
        issues.push(
          issue(
            'ERROR',
            'control-character-not-allowed',
            'Control characters are not valid customer data.',
            sourceRow,
            value.column,
            field,
          ),
        );
      }
    }

    let record: CanonicalCustomerImportRow | null = null;
    if (
      !issues.some(
        (entry) => entry.classification === 'BLOCKED' || entry.classification === 'ERROR',
      )
    ) {
      try {
        const nameAr = cleanRequired(values.get('nameAr')?.value ?? null, 160, 'customer name');
        const nameEn = cleanOptional(
          values.get('nameEn')?.value ?? null,
          160,
          'customer English name',
        );
        const phone = cleanOptional(values.get('phone')?.value ?? null, 40, 'customer phone');
        if (phone !== null && phone.length < 3) throw new Error('Customer phone is too short.');
        const email = cleanEmail(values.get('email')?.value ?? null);
        const vatNumber = cleanVatNumber(values.get('vatNumber')?.value ?? null);

        if (phone !== null) {
          const previous = seenPhone.get(phone);
          if (previous !== undefined) {
            issues.push(
              issue(
                'ERROR',
                'duplicate-phone-in-file',
                `Customer phone duplicates source row ${String(previous)}.`,
                sourceRow,
                values.get('phone')?.column ?? null,
                'phone',
              ),
            );
          } else {
            seenPhone.set(phone, sourceRow);
          }
        }

        record = { nameAr, nameEn, phone, email, vatNumber };
      } catch (error) {
        issues.push(
          issue(
            'ERROR',
            'invalid-customer-row',
            error instanceof Error ? error.message : 'Invalid customer row.',
            sourceRow,
            null,
            null,
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
