import { describe, expect, it } from 'vitest';
import {
  parseCsvDocument,
  reviewProductSheet,
  suggestProductMappings,
  validateProductMappings,
} from '../../index.js';

describe('product migration category-name contract', () => {
  it('maps and safely normalizes Arabic category names without exposing category ids', () => {
    const sheet = parseCsvDocument(
      'رقم الصنف,اسم الصنف,نوع الصنف,الوحدة,سعر البيع,اسم الفئة\nSKU-1,قهوة,unit,each,12.50,  مشروبات   ساخنة  ',
    ).sheets[0]!;
    const suggestions = suggestProductMappings(sheet.rows[0]!);
    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetField: 'categoryNameAr', reason: 'exact-alias' }),
      ]),
    );
    const mapping = suggestions.map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    expect(validateProductMappings(sheet.rows[0]!, mapping)).toEqual([]);
    expect(reviewProductSheet(sheet, mapping)).toEqual([
      expect.objectContaining({
        sourceRow: 2,
        classification: 'VALID',
        record: expect.objectContaining({
          sku: 'SKU-1',
          nameAr: 'قهوة',
          categoryNameAr: 'مشروبات ساخنة',
        }),
      }),
    ]);
  });

  it('keeps category optional for backward-compatible product files', () => {
    const sheet = parseCsvDocument('SKU,اسم الصنف,نوع الصنف,الوحدة,سعر البيع\nA1,ماء,unit,each,1')
      .sheets[0]!;
    const mapping = suggestProductMappings(sheet.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    expect(reviewProductSheet(sheet, mapping)[0]).toMatchObject({
      classification: 'VALID',
      record: { categoryNameAr: null },
    });
  });

  it('rejects malformed category names instead of repairing control characters', () => {
    const sheet = parseCsvDocument(
      'SKU,اسم الصنف,نوع الصنف,الوحدة,سعر البيع,اسم الفئة\nA1,ماء,unit,each,1,مشروبات\u0000ساخنة',
    ).sheets[0]!;
    const mapping = suggestProductMappings(sheet.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    const row = reviewProductSheet(sheet, mapping)[0]!;
    expect(row.classification).toBe('ERROR');
    expect(row.record).toBeNull();
  });
});
