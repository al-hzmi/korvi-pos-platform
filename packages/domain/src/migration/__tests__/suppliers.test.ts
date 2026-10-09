import { describe, expect, it } from 'vitest';
import {
  parseCsvDocument,
  reviewSupplierSheet,
  suggestSupplierMappings,
  validateSupplierMappings,
} from '../../index.js';

describe('supplier migration canonical review', () => {
  it('maps only the supplier name supported by the current purchasing domain', () => {
    const sheet = parseCsvDocument(
      'اسم المورد,الجوال,الرقم الضريبي\nشركة ألف,0500000000,310000000000003',
    ).sheets[0]!;
    expect(suggestSupplierMappings(sheet.rows[0]!)).toEqual([
      expect.objectContaining({ targetField: 'name', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: null, reason: 'unmapped' }),
      expect.objectContaining({ targetField: null, reason: 'unmapped' }),
    ]);
  });

  it('uses the authoritative supplier name normalization and allows legitimate duplicate names', () => {
    const sheet = parseCsvDocument('اسم المورد\n  شركة ألف  \nشركة ألف').sheets[0]!;
    const mapping = [{ sourceColumn: 0, targetField: 'name' as const }];
    const rows = reviewSupplierSheet(sheet, mapping);
    expect(rows.map((row) => row.classification)).toEqual(['VALID', 'VALID']);
    expect(rows.map((row) => row.record)).toEqual([{ name: 'شركة ألف' }, { name: 'شركة ألف' }]);
  });

  it('blocks formulas and rejects embedded control characters', () => {
    const formula = parseCsvDocument('اسم المورد\n=1+1').sheets[0]!;
    const control = parseCsvDocument('اسم المورد\n"شركة\nألف"').sheets[0]!;
    const mapping = [{ sourceColumn: 0, targetField: 'name' as const }];

    expect(reviewSupplierSheet(formula, mapping)[0]).toMatchObject({
      classification: 'BLOCKED',
      record: null,
      issues: [expect.objectContaining({ code: 'formula-not-authority' })],
    });
    expect(reviewSupplierSheet(control, mapping)[0]).toMatchObject({
      classification: 'ERROR',
      record: null,
      issues: [expect.objectContaining({ code: 'control-character-not-allowed' })],
    });
  });

  it('requires exactly one supplier-name mapping', () => {
    const sheet = parseCsvDocument('اسم المورد,Supplier Name\nأ,A').sheets[0]!;
    expect(
      validateSupplierMappings(sheet.rows[0]!, [
        { sourceColumn: 0, targetField: 'name' },
        { sourceColumn: 1, targetField: 'name' },
      ]),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'duplicate-target-mapping' })]),
    );
    expect(
      validateSupplierMappings(sheet.rows[0]!, [
        { sourceColumn: 0, targetField: null },
        { sourceColumn: 1, targetField: null },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'required-field-unmapped', targetField: 'name' }),
      ]),
    );
  });
});
