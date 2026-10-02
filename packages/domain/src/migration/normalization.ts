import type { ImportCell } from './model.js';

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC = '۰۱۲۳۴۵۶۷۸۹';
const ASCII = '0123456789';
const FORMULA_PREFIX = /^[=+\-@]/u;
const WHOLE_PERCENT = /^(0|[1-9][0-9]?|100)%?$/u;
const BASIS_POINTS = /^(0|[1-9][0-9]{0,3}|10000)\s*(?:bps|نقطة)$/iu;
const EXACT_MONEY = /^(0|[1-9][0-9]{0,14})(?:[.,]([0-9]{1,2}))?$/u;

export class ImportNormalizationError extends Error {
  public override readonly name = 'ImportNormalizationError';
}

export function normalizeArabicDigits(value: string): string {
  let result = '';
  for (const character of value.normalize('NFKC')) {
    const arabicIndex = ARABIC_INDIC.indexOf(character);
    if (arabicIndex >= 0) {
      result += ASCII[arabicIndex]!;
      continue;
    }
    const easternIndex = EASTERN_ARABIC.indexOf(character);
    result += easternIndex >= 0 ? ASCII[easternIndex]! : character;
  }
  return result;
}

export function normalizeImportText(value: string): string {
  return normalizeArabicDigits(value).replace(/\s+/gu, ' ').trim();
}

export function normalizeHeaderKey(value: string): string {
  return normalizeImportText(value)
    .toLocaleLowerCase('en-US')
    .replace(/[\s_\-./\\()[\]{}:،,]+/gu, '');
}

export function isFormulaLikeText(value: string): boolean {
  return FORMULA_PREFIX.test(value.trimStart());
}

export function textCell(value: string): ImportCell {
  const normalized = value.replace(/^\uFEFF/u, '');
  if (normalized === '') return { kind: 'blank' };
  return {
    kind: 'text',
    value: normalized,
    formulaLike: isFormulaLikeText(normalized),
  };
}

/**
 * Parses a human-entered SAR amount without thousands-separator guessing.
 *
 * One decimal separator (dot OR comma) is accepted. Mixed/grouped forms such
 * as "1,000.00" are intentionally rejected because guessing whether a comma
 * is grouping or decimal punctuation is financial reinterpretation.
 */
export function parseExactSarToMinor(value: string): string {
  const candidate = normalizeArabicDigits(value).replace(/\s+/gu, '').replace('٫', '.');
  const match = EXACT_MONEY.exec(candidate);
  if (match === null) {
    throw new ImportNormalizationError('Ambiguous or invalid monetary value.');
  }
  const whole = match[1]!;
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const minor = BigInt(whole) * 100n + BigInt(fraction === '' ? '0' : fraction);
  if (minor > 999_999_999_999_999n) {
    throw new ImportNormalizationError('Monetary value exceeds Korvi product price capacity.');
  }
  return minor.toString();
}

export function parseVatBasisPoints(value: string): number {
  const candidate = normalizeImportText(value);
  const percent = WHOLE_PERCENT.exec(candidate);
  if (percent !== null) return Number(percent[1]) * 100;
  const bps = BASIS_POINTS.exec(candidate);
  if (bps !== null) return Number(bps[1]);
  throw new ImportNormalizationError(
    'VAT must be an explicit whole percent or basis-points value.',
  );
}

export function importCellText(cell: ImportCell): string | null {
  switch (cell.kind) {
    case 'blank':
      return null;
    case 'text':
      return normalizeImportText(cell.value);
    case 'number':
      return normalizeImportText(cell.value);
    case 'boolean':
      return cell.value ? 'true' : 'false';
    case 'formula':
      throw new ImportNormalizationError('Spreadsheet formulas are not import authority.');
  }
}
