import { describe, expect, it } from 'vitest';
import {
  parseCsvDocument,
  reviewCategorySheet,
  suggestCategoryMappings,
  validateCategoryMappings,
} from '../../index.js';

describe('category migration canonical review', () => {
  it('maps Arabic and English category headers deterministically', () => {
    const sheet = parseCsvDocument(
      'اسم الفئة,English Name,الترتيب,Parent Category\nمشروبات,Drinks,10,Root',
    ).sheets[0]!;
    expect(suggestions).toEqual([
      expect.objectContaining({ targetField: 'nameAr', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: 'nameEn', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: 'sortOrder', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: null, reason: 'unmapped' }),
    ]);
  });

  it('normalizes category rows and preserves unsupported hierarchy as unmapped source data', () => {
    const sheet = parseCsvDocument(
      'اسم الفئة,الاسم الانجليزي,الترتيب,الفئة الأب\n  مشروبات   باردة  , Cold  Drinks ,١٢,Root',
    ).sheets[0]!;
    const mapping = suggestCategoryMappings(sheet.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    expect(reviewCategorySheet(sheet, mapping)).toEqual([
      expect.objectContaining({
        sourceRow: 2,
        classification: 'VALID',
        record: {
          nameAr: 'مشروبات باردة',
          nameEn: 'Cold Drinks',
          sortOrder: 12,
        },
      }),
    ]);
  });

  it('blocks formulas and rejects duplicate category names row-by-row', () => {
    const sheet = parseCsvDocument('اسم الفئة,الترتيب\nمشروبات,1\nمشروبات,2\n=1+1,3').sheets[0]!;
    const mapping = suggestCategoryMappings(sheet.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    const rows = reviewCategorySheet(sheet, mapping);
    expect(rows.map((row) => row.classification)).toEqual(['VALID', 'ERROR', 'BLOCKED']);
    expect(rows[1]!.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'duplicate-category-in-file' })]),
    );
    expect(rows[2]!.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'formula-not-authority' })]),
    );
  });

  it('rejects missing required mapping and ambiguous duplicate mappings', () => {
    const sheet = parseCsvDocument('اسم الفئة,Category Name,الترتيب\nمشروبات,Drinks,1').sheets[0]!;
    const suggestions = suggestCategoryMappings(sheet.rows[0]!);
    expect(
      validateCategoryMappings(sheet.rows[0]!, [
        { sourceColumn: 0, targetField: 'nameAr' },
        { sourceColumn: 1, targetField: 'nameAr' },
        { sourceColumn: 2, targetField: 'sortOrder' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: 'BLOCKED',
          code: 'duplicate-target-mapping',
          targetField: 'nameAr',
        }),
      ]),
    );

    expect(
      validateCategoryMappings(sheet.rows[0]!, [
        { sourceColumn: 0, targetField: null },
        { sourceColumn: 2, targetField: 'sortOrder' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: 'BLOCKED',
          code: 'required-field-unmapped',
          targetField: 'nameAr',
        }),
      ]),
    );
  });

  it('rejects control characters and unsafe sort orders rather than repairing them', () => {
    const sheet = parseCsvDocument('اسم الفئة,الترتيب\n"قهوة\nساخنة",1\nمخبوزات,1000001')
      .sheets[0]!;
    const mapping = suggestCategoryMappings(sheet.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    const rows = reviewCategorySheet(sheet, mapping);
    expect(rows.map((row) => row.classification)).toEqual(['ERROR', 'ERROR']);
    expect(rows.every((row) => row.record === null)).toBe(true);
  });
});
