import { describe, expect, it } from 'vitest';
import {
  tenantId,
  type InvoiceRecord,
  type SaleRecord,
  type ZatcaDurableFiscalization,
  type ZatcaFiscalizationRepository,
} from '@korvi/domain';
import { createCheckoutFiscalizationPort } from '../zatca/fiscalize-checkout.js';
import type { ZatcaSimplifiedInvoiceSealer } from '../zatca/seal-simplified-invoice.js';

const tenant = tenantId('018f1000-0000-7000-8000-00000000000a');
const terminal = '018f1000-0000-7000-8000-0000000000a2';
const invoiceId = '018f1000-0000-7000-8000-0000000000b1';
const saleId = '018f1000-0000-7000-8000-0000000000b2';
const seller = {
  registrationName: 'Korvi Merchant',
  vatRegistrationNumber: '300000000000003',
  legalId: '1010123456',
  legalIdScheme: 'CRN' as const,
  streetName: 'King Road',
  buildingNumber: '1234',
  citySubdivisionName: 'Olaya',
  cityName: 'Riyadh',
  postalZone: '12345',
  countryCode: 'SA' as const,
};
const sale = {
  id: saleId,
  tenantId: tenant,
  terminalId: terminal,
  status: 'finalized',
  issuedAt: '2026-09-17T12:00:00.500Z',
} as SaleRecord;
const invoice = {
  id: invoiceId,
  tenantId: tenant,
  saleId,
  invoiceType: 'simplified',
} as InvoiceRecord;

describe('checkout fiscalization orchestration', () => {
  it('reserves, seals and persists once, then reuses the sealed artifact', async () => {
    let durable: ZatcaDurableFiscalization | null = null;
    let reserveCalls = 0;
    let sealerCalls = 0;
    let persistCalls = 0;
    const repository: ZatcaFiscalizationRepository = {
      readSellerProfile: async () => seller,
      upsertSellerProfile: async () => seller,
      findByInvoice: async () => durable,
      reserve: async () => {
        reserveCalls += 1;
        durable = {
          scope: { tenantId: tenant },
          invoiceId,
          terminalId: terminal,
          invoiceCounterValue: '41',
          previousInvoiceHash: 'YWJjZA==',
          seller,
          reservedAt: '2026-09-17T12:00:01Z',
          state: 'reserved',
        };
        return durable;
      },
      seal: async (_scope, input) => {
        persistCalls += 1;
        durable = {
          scope: { tenantId: tenant },
          invoiceId,
          terminalId: terminal,
          invoiceCounterValue: '41',
          previousInvoiceHash: 'YWJjZA==',
          seller,
          reservedAt: '2026-09-17T12:00:01Z',
          state: 'sealed',
          invoiceHash: Uint8Array.from(input.invoiceHash),
          sealedInvoiceXml: Uint8Array.from(input.sealedInvoiceXml),
          qrCodeBase64: input.qrCodeBase64,
          signatureValueBase64: input.signatureValueBase64,
          sealedAt: input.sealedAt,
        };
        return durable;
      },
    };
    const sealer: ZatcaSimplifiedInvoiceSealer = {
      seal: async (input) => {
        sealerCalls += 1;
        expect(input.invoice.invoiceCounterValue).toBe('41');
        expect(input.invoice.previousInvoiceHash).toBe('YWJjZA==');
        return {
          xml: '<Invoice>sealed</Invoice>',
          invoiceHashBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          invoiceHash: new Uint8Array(32),
          qrCodeBase64: 'cXI=',
          signatureValueBase64: 'c2ln',
          signingPublicKeySpkiDer: new Uint8Array([1]),
          technicalCaSignatureDer: new Uint8Array([2]),
          trustAnchorSha256Hex: '0'.repeat(64),
        };
      },
    };
    const fiscalization = createCheckoutFiscalizationPort({
      repository,
      sealer,
      now: () => new Date('2026-09-17T12:00:01.900Z'),
    });

    const first = await fiscalization.fiscalize({ tenantId: tenant }, sale, invoice);
    const replay = await fiscalization.fiscalize({ tenantId: tenant }, sale, invoice);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({ state: 'sealed', qrCodeBase64: 'cXI=' });
    expect(reserveCalls).toBe(1);
    expect(sealerCalls).toBe(1);
    expect(persistCalls).toBe(1);
    expect(durable).toMatchObject({ state: 'sealed' });
  });
});
