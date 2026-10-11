import { describe, expect, it } from 'vitest';
import {
  parseCsvDocument,
  reviewOpeningInventorySheet,
  suggestOpeningInventoryMappings,
  validateOpeningInventoryMappings,
} from '../../index.js';

describe('opening inventory migration canonical review', () => {
  it('maps business keys and Arabic opening quantities without UUID authority', () => {
    const sheet = parseCsvDocument('كود الفرع,رقم الصنف,الكمية الافتتاحية\njed-1,sku-1,١٢٫٥')
      .sheets[0]!;
    const suggestions = suggestOpeningInventoryMappings(sheet.rows[0]!);
    expect(suggestions.map((entry) => entry.targetField)).toEqual([
      'branchCode',
      'sku',
      'openingQuantity',
    ]);
    const mapping = suggestions.map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    expect(reviewOpeningInventorySheet(sheet, mapping)[0]).toMatchObject({
      classification: 'VALID',
      record: {
        branchCode: 'JED-1',
        sku: 'SKU-1',
        quantityScaled: '12500',
      },
    });
  });

  it('requires branch, SKU and opening quantity mappings', () => {
    const sheet = parseCsvDocument('كود الفرع,رقم الصنف\nMAIN,A1').sheets[0]!;
    expect(
      validateOpeningInventoryMappings(sheet.rows[0]!, [
        { sourceColumn: 0, targetField: 'branchCode' },
        { sourceColumn: 1, targetField: 'sku' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'required-field-unmapped',
          targetField: 'openingQuantity',
        }),
      ]),
    );
  });

  it('rejects zero, ambiguous punctuation and duplicate branch/SKU rows', () => {
    const sheet = parseCsvDocument(
      'الفرع,SKU,الرصيد الافتتاحي\nMAIN,A1,0\nMAIN,A2,"1,000"\nMAIN,A3,2\nMAIN,A3,3',
    ).sheets[0]!;
    const mapping = suggestOpeningInventoryMappings(sheet.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    const rows = reviewOpeningInventorySheet(sheet, mapping);
    expect(rows.map((row) => row.classification)).toEqual(['ERROR', 'ERROR', 'VALID', 'ERROR']);
    expect(rows[3]!.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate-opening-stock-in-file' }),
      ]),
    );
  });

  it('blocks formulas rather than trusting spreadsheet results', () => {
    const sheet = parseCsvDocument('كود الفرع,SKU,الرصيد الافتتاحي\nMAIN,A1,=10+2').sheets[0]!;
    const mapping = suggestOpeningInventoryMappings(sheet.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    expect(reviewOpeningInventorySheet(sheet, mapping)[0]).toMatchObject({
      classification: 'BLOCKED',
      record: null,
      issues: [expect.objectContaining({ code: 'formula-not-authority' })],
    });
  });
});
