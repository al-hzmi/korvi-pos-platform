import { describe, expect, it } from 'vitest';
import {
  tenantId,
  type InvoiceRecord,
  type SaleRecord,
  type ZatcaSealedFiscalization,
} from '@korvi/domain';
import { buildCheckoutReceipt } from '../checkout/receipt.js';

const tenant = tenantId('018f1000-0000-7000-8000-00000000000a');
const saleId = '018f1000-0000-7000-8000-0000000000b2';
const invoiceId = '018f1000-0000-7000-8000-0000000000b1';
const terminalId = '018f1000-0000-7000-8000-0000000000a2';

const sale = {
  id: saleId,
  tenantId: tenant,
  terminalId,
  status: 'finalized',
  issuedAt: '2026-09-17T12:00:00Z',
  currency: 'SAR',
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  lines: [
    {
      lineNumber: 1,
      nameAr: 'صنف مختوم',
      quantityScaled: '2000',
      totalMinor: '2300',
    },
  ],
} as unknown as SaleRecord;

const invoice = {
  id: invoiceId,
  tenantId: tenant,
  saleId,
  invoiceNumber: 'INV-42',
  invoiceType: 'simplified',
  issuedAt: '2026-09-17T12:00:00Z',
  currency: 'SAR',
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
} as InvoiceRecord;

const artifact = {
  scope: { tenantId: tenant },
  invoiceId,
  terminalId,
  invoiceCounterValue: '42',
  previousInvoiceHash: 'YWJjZA==',
  seller: {
    registrationName: 'Merchant Snapshot',
    vatRegistrationNumber: '300000000000003',
    legalId: '1010123456',
    legalIdScheme: 'CRN',
    streetName: 'King Road',
    buildingNumber: '1234',
    citySubdivisionName: 'Olaya',
    cityName: 'Riyadh',
    postalZone: '12345',
    countryCode: 'SA',
  },
  reservedAt: '2026-09-17T12:00:01Z',
  state: 'sealed',
  invoiceHash: Uint8Array.from([1, 2, 3]),
  sealedInvoiceXml: new TextEncoder().encode('<Invoice>sealed</Invoice>'),
  qrCodeBase64: 'PERSISTED_PHASE_2_QR',
  signatureValueBase64: 'c2ln',
  sealedAt: '2026-09-17T12:00:01Z',
} satisfies ZatcaSealedFiscalization;

describe('canonical checkout receipt', () => {
  it('uses the persisted sealed fiscal artifact instead of inventing QR, hash, or seller truth', () => {
    expect(buildCheckoutReceipt(sale, invoice, artifact)).toEqual({
      invoiceId,
      invoiceNumber: 'INV-42',
      issuedAt: '2026-09-17T12:00:00Z',
      currency: 'SAR',
      sellerName: 'Merchant Snapshot',
      vatRegistrationNumber: '300000000000003',
      lines: [
        {
          lineNumber: 1,
          description: 'صنف مختوم',
          quantityScaled: '2000',
          totalMinor: '2300',
        },
      ],
      netMinor: '2000',
      vatMinor: '300',
      totalMinor: '2300',
      invoiceHashBase64: 'AQID',
      qrCodeBase64: 'PERSISTED_PHASE_2_QR',
      fiscalizationMode: 'production',
      disclaimer: null,
    });
  });

  it('refuses evidence belonging to a different invoice', () => {
    expect(() =>
      buildCheckoutReceipt(sale, invoice, { ...artifact, invoiceId: 'other-invoice' }),
    ).toThrow(/does not belong/);
  });
});
