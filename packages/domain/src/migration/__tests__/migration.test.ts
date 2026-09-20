import { describe, expect, it } from 'vitest';
import {
  ImportNormalizationError,
  ImportParseError,
  normalizeArabicDigits,
  parseCsvDocument,
  parseExactSarToMinor,
  reviewProductSheet,
  suggestProductMappings,
  summarizeImportReviews,
} from '../../index.js';

describe('migration canonical model', () => {
  it('normalizes Arabic and Eastern Arabic digits without touching leading zeros', () => {
    expect(normalizeArabicDigits('٠٠١٢-۱۲۳')).toBe('0012-123');
  });

  it('parses CSV quotes, blank rows and dangerous formula-like text without executing it', () => {
    const document = parseCsvDocument(
      '\uFEFFرقم الصنف,اسم الصنف,نوع الصنف,الوحدة,سعر البيع\r\n"0012","قهوة, كبيرة",وحدة,حبة,١٢٫٥٠\r\n\r\n=1+1,خطر,unit,each,10',
    );
    expect(document.sheets[0]!.rows).toHaveLength(3);
    expect(document.sheets[0]!.rows[1]![0]).toMatchObject({ kind: 'text', value: '0012' });
    expect(document.sheets[0]!.rows[2]![0]).toMatchObject({
      kind: 'text',
      formulaLike: true,
    });
  });

  it('preserves physical CSV row numbers when blank rows are skipped', () => {
    const sheet = parseCsvDocument(
      'SKU,اسم الصنف,نوع الصنف,الوحدة,السعر\n\nA1,قهوة,unit,each,10',
    ).sheets[0]!;
    expect(sheet.sourceRowNumbers).toEqual([1, 3]);
    const mappings = suggestProductMappings(sheet.rows[0]!).map((suggestion) => ({
      sourceColumn: suggestion.sourceColumn,
      targetField: suggestion.targetField,
    }));
    expect(reviewProductSheet(sheet, mappings)[0]?.sourceRow).toBe(3);
  });

  it('refuses malformed or unbounded CSV deterministically', () => {
    expect(() => parseCsvDocument('"open')).toThrow(ImportParseError);
    expect(() => parseCsvDocument('a,b,c\n1,2,3', { maxColumns: 2 })).toThrow(ImportParseError);
    expect(() => parseCsvDocument('a\n1\n2', { maxRows: 2 })).toThrow(ImportParseError);
  });

  it('does not guess grouped or mixed monetary punctuation', () => {
    expect(parseExactSarToMinor('١٢,٥')).toBe('1250');
    expect(parseExactSarToMinor('١٢٫٥٠')).toBe('1250');
    expect(parseExactSarToMinor('12.50')).toBe('1250');
    expect(() => parseExactSarToMinor('1,000.00')).toThrow(ImportNormalizationError);
    expect(() => parseExactSarToMinor('1.2.3')).toThrow(ImportNormalizationError);
  });

  it('suggests Arabic and English product mappings using deterministic aliases only', () => {
    const sheet = parseCsvDocument(
      'Item Code,اسم الصنف,نوع الصنف,وحدة القياس,Selling Price,رقم الباركود,ملاحظة\nA,قهوة,unit,each,10,00123,x',
    ).sheets[0]!;
    expect(suggestProductMappings(sheet.rows[0]!)).toEqual([
      expect.objectContaining({ targetField: 'sku', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: 'nameAr', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: 'productType', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: 'unitLabel', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: 'sellingPrice', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: 'barcode', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: null, reason: 'unmapped' }),
    ]);
  });

  it('produces row-level duplicate diagnostics instead of invalidating the whole file', () => {
    const sheet = parseCsvDocument(
      'SKU,اسم الصنف,نوع الصنف,الوحدة,السعر,باركود\nA1,قهوة,unit,each,10,00123\nA1,شاي,unit,each,5,00124\nA3,ماء,unit,each,2,00123',
    ).sheets[0]!;
    const suggestions = suggestProductMappings(sheet.rows[0]!);
    const mappings = suggestions.map((suggestion) => ({
      sourceColumn: suggestion.sourceColumn,
      targetField: suggestion.targetField,
    }));
    const rows = reviewProductSheet(sheet, mappings);
    expect(rows.map((row) => row.classification)).toEqual(['VALID', 'ERROR', 'ERROR']);
    expect(rows[1]!.issues[0]?.code).toBe('duplicate-sku-in-file');
    expect(rows[2]!.issues[0]?.code).toBe('duplicate-barcode-in-file');
    expect(summarizeImportReviews(rows)).toEqual({
      totalRows: 3,
      validRows: 1,
      warningRows: 0,
      errorRows: 2,
      blockedRows: 0,
    });
  });

  it('blocks formula-like product authority and missing required mappings', () => {
    const sheet = parseCsvDocument('SKU,اسم الصنف,نوع الصنف,الوحدة,السعر\n=1+1,قهوة,unit,each,10')
      .sheets[0]!;
    const mappings = suggestProductMappings(sheet.rows[0]!).map((suggestion) => ({
      sourceColumn: suggestion.sourceColumn,
      targetField: suggestion.targetField,
    }));
    expect(reviewProductSheet(sheet, mappings)[0]).toMatchObject({
      classification: 'BLOCKED',
      record: null,
    });

    const incomplete = mappings.filter((mapping) => mapping.targetField !== 'sellingPrice');
    expect(reviewProductSheet(sheet, incomplete)[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'required-field-unmapped',
          classification: 'BLOCKED',
          targetField: 'sellingPrice',
        }),
      ]),
    );
  });

  it('rejects one source column mapped to multiple Korvi fields', () => {
    const sheet = parseCsvDocument('SKU,اسم الصنف,نوع الصنف,الوحدة,السعر\nA1,قهوة,unit,each,10')
      .sheets[0]!;
    const mappings = suggestProductMappings(sheet.rows[0]!).map((suggestion) => ({
      sourceColumn: suggestion.sourceColumn,
      targetField: suggestion.targetField,
    }));
    const duplicatedSource = [...mappings, { sourceColumn: 0, targetField: 'barcode' as const }];
    expect(reviewProductSheet(sheet, duplicatedSource)[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'duplicate-source-mapping',
          classification: 'BLOCKED',
          sourceColumn: 0,
        }),
      ]),
    );
  });

  it('rejects duplicate target mappings even when source headers are duplicated', () => {
    const sheet = parseCsvDocument(
      'SKU,Item Code,اسم الصنف,نوع الصنف,الوحدة,السعر\nA1,A1,قهوة,unit,each,10',
    ).sheets[0]!;
    const mappings = suggestProductMappings(sheet.rows[0]!).map((suggestion) => ({
      sourceColumn: suggestion.sourceColumn,
      targetField: suggestion.targetField,
    }));
    expect(reviewProductSheet(sheet, mappings)[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'duplicate-target-mapping',
          classification: 'BLOCKED',
          targetField: 'sku',
        }),
      ]),
    );
  });
});
