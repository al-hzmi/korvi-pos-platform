import { describe, expect, it } from 'vitest';
import { ZatcaInvoiceError } from '../phase2.js';
import { zatcaCsrSubject } from '../csid.js';

const valid = {
  commonName: 'KORVI-JED-01',
  egsSerialNumber: '1-Korvi|2-POS-1|3-JED-000001',
  organizationIdentifier: '310122393500003',
  organizationalUnitName: 'Jeddah Main Branch',
  organizationName: 'Korvi Test Merchant',
  countryCode: 'sa',
  invoiceType: '1100',
  location: 'Jeddah',
  industry: 'Retail',
};

describe('ZATCA CSID CSR subject', () => {
  it('normalizes presentation without inventing identity facts', () => {
    expect(zatcaCsrSubject({ ...valid, commonName: '  KORVI-JED-01  ' })).toEqual({
      ...valid,
      commonName: 'KORVI-JED-01',
      countryCode: 'SA',
    });
  });

  it('requires the published EGS serial structure', () => {
    for (const bad of [
      'Korvi-POS-JED',
      '1-Korvi|2-POS-1',
      '1-Korvi|3-JED-000001|2-POS-1',
      '1-|2-POS-1|3-JED-000001',
    ]) {
      expect(() => zatcaCsrSubject({ ...valid, egsSerialNumber: bad })).toThrow(ZatcaInvoiceError);
    }
  });

  it('requires the Saudi VAT identifier shape published for CSR organizationIdentifier', () => {
    for (const bad of ['31012239350000', '210122393500003', '310122393500002', '3ABCDEFGHIJKLM3']) {
      expect(() => zatcaCsrSubject({ ...valid, organizationIdentifier: bad })).toThrow(
        ZatcaInvoiceError,
      );
    }
  });

  it('normalizes and validates ISO alpha-2 country code', () => {
    expect(zatcaCsrSubject({ ...valid, countryCode: ' sa ' }).countryCode).toBe('SA');
    expect(() => zatcaCsrSubject({ ...valid, countryCode: 'Saudi Arabia' })).toThrow(
      ZatcaInvoiceError,
    );
  });

  it('requires a four-bit TSCZ capability map with at least one enabled type', () => {
    for (const bad of ['0000', '110', '11000', '12AA']) {
      expect(() => zatcaCsrSubject({ ...valid, invoiceType: bad })).toThrow(ZatcaInvoiceError);
    }
    expect(zatcaCsrSubject({ ...valid, invoiceType: '0100' }).invoiceType).toBe('0100');
  });

  it('rejects blank taxpayer/device identity instead of filling defaults', () => {
    for (const field of [
      'commonName',
      'organizationalUnitName',
      'organizationName',
      'location',
      'industry',
    ] as const) {
      expect(() => zatcaCsrSubject({ ...valid, [field]: '   ' })).toThrow(ZatcaInvoiceError);
    }
  });
});
