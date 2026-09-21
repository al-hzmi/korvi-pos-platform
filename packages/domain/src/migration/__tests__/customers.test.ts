import { describe, expect, it } from 'vitest';
import {
  parseCsvDocument,
  reviewCustomerSheet,
  suggestCustomerMappings,
  validateCustomerMappings,
} from '../../index.js';

describe('customer migration canonical review', () => {
  it('maps only fields supported by the current customer domain', () => {
    const sheet = parseCsvDocument(
      'اسم العميل,رقم الجوال,البريد الإلكتروني,الرقم الضريبي,العنوان\nمؤسسة ميم,0500000000,a@example.com,310000000000003,الرياض',
    ).sheets[0]!;
    const suggestions = suggestCustomerMappings(sheet.rows[0]!);
    expect(suggestions).toEqual([
      expect.objectContaining({ targetField: 'nameAr', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: 'phone', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: 'email', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: 'vatNumber', reason: 'exact-alias' }),
      expect.objectContaining({ targetField: null, reason: 'unmapped' }),
    ]);
  });

  it('normalizes only outer whitespace and preserves supported customer values', () => {
    const sheet = parseCsvDocument(
      'اسم العميل,English Name,الجوال,Email,الرقم الضريبي\n  مؤسسة ميم  , Meem Trading , 050 000 0000 , SALES@EXAMPLE.COM ,310000000000003',
    ).sheets[0]!;
    const mapping = suggestCustomerMappings(sheet.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    expect(reviewCustomerSheet(sheet, mapping)[0]).toMatchObject({
      classification: 'VALID',
      record: {
        nameAr: 'مؤسسة ميم',
        nameEn: 'Meem Trading',
        phone: '050 000 0000',
        email: 'SALES@EXAMPLE.COM',
        vatNumber: '310000000000003',
      },
    });
  });

  it('rejects duplicate non-null phones in one source without inventing email uniqueness', () => {
    const sheet = parseCsvDocument(
      'اسم العميل,الجوال,Email\nأ,0500000000,a@example.com\nب,0500000000,b@example.com\nج,,a@example.com',
    ).sheets[0]!;
    const mapping = suggestCustomerMappings(sheet.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    const rows = reviewCustomerSheet(sheet, mapping);
    expect(rows.map((row) => row.classification)).toEqual(['VALID', 'ERROR', 'VALID']);
    expect(rows[1]!.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'duplicate-phone-in-file' })]),
    );
  });

  it('blocks formulas and rejects malformed email, VAT and short phones row-by-row', () => {
    const sheet = parseCsvDocument(
      'اسم العميل,الجوال,Email,الرقم الضريبي\n=1+1,0500000000,a@example.com,310000000000003\nب,12,bad,123',
    ).sheets[0]!;
    const mapping = suggestCustomerMappings(sheet.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    const rows = reviewCustomerSheet(sheet, mapping);
    expect(rows[0]!.classification).toBe('BLOCKED');
    expect(rows[1]!.classification).toBe('ERROR');
  });

  it('requires only nameAr and rejects duplicate target mappings', () => {
    const sheet = parseCsvDocument('اسم العميل,Customer Name\nأ,A').sheets[0]!;
    expect(
      validateCustomerMappings(sheet.rows[0]!, [
        { sourceColumn: 0, targetField: 'nameAr' },
        { sourceColumn: 1, targetField: 'nameAr' },
      ]),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'duplicate-target-mapping' })]),
    );
    expect(
      validateCustomerMappings(sheet.rows[0]!, [
        { sourceColumn: 0, targetField: null },
        { sourceColumn: 1, targetField: 'nameEn' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'required-field-unmapped', targetField: 'nameAr' }),
      ]),
    );
  });
});
