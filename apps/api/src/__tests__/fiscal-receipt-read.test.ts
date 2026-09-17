import { describe, expect, it, vi } from 'vitest';
import { tenantId } from '@korvi/domain';
import { createFiscalReceiptReadService } from '../checkout/receipt-read.js';
import type {
  AuthenticatedPrincipal,
  InvoiceRecord,
  SaleRecord,
  ZatcaSealedFiscalization,
} from '@korvi/domain';

const principal: AuthenticatedPrincipal = {
  tenantId: '018f1000-0000-7000-8000-000000000001',
  tenantSlug: 'merchant',
  userId: '018f1000-0000-7000-8000-000000000002',
  sessionId: '018f1000-0000-7000-8000-000000000003',
  email: 'cashier@example.test',
  displayName: 'Cashier One',
  roles: ['cashier'],
  permissions: ['sale.create'],
  maxDiscountBasisPoints: 0n,
  branchId: '018f1000-0000-7000-8000-000000000004',
  terminalId: '018f1000-0000-7000-8000-000000000005',
};

const sale = {
  id: '018f1000-0000-7000-8000-000000000006',
  tenantId: tenantId(principal.tenantId),
  branchId: principal.branchId,
  terminalId: principal.terminalId,
  shiftId: '018f1000-0000-7000-8000-000000000007',
  userId: principal.userId,
  operationId: '018f1000-0000-7000-8000-000000000008',
  status: 'finalized',
  sequence: 42,
  currency: 'SAR',
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  tenderedMinor: '2500',
  changeMinor: '200',
  issuedAt: '2026-09-17T12:00:00Z',
  lines: [
    {
      lineNumber: 1,
      productId: '018f1000-0000-7000-8000-000000000009',
      sku: 'SKU-1',
      nameAr: 'صنف مختوم',
      quantityScaled: '1000',
      unitPriceMinor: '2300',
      netMinor: '2000',
      vatMinor: '300',
      totalMinor: '2300',
    },
  ],
  tenders: [
    {
      kind: 'cash',
      amountMinor: '2500',
      changeMinor: '200',
      scheme: null,
      reference: null,
    },
  ],
} as unknown as SaleRecord;

const invoice = {
  id: '018f1000-0000-7000-8000-00000000000a',
  tenantId: tenantId(principal.tenantId),
  saleId: sale.id,
  invoiceNumber: 'INV-42',
  invoiceType: 'simplified',
  currency: 'SAR',
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  issuedAt: sale.issuedAt,
} as InvoiceRecord;

const fiscalization = {
  scope: { tenantId: tenantId(principal.tenantId) },
  invoiceId: invoice.id,
  terminalId: sale.terminalId,
  invoiceCounterValue: '42',
  previousInvoiceHash: 'cGlodA==',
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
  sealedAt: '2026-09-17T12:00:02Z',
} satisfies ZatcaSealedFiscalization;

function subject(overrides?: {
  readonly sale?: SaleRecord | null;
  readonly invoice?: InvoiceRecord | null;
  readonly fiscalization?: ZatcaSealedFiscalization | null;
}) {
  const findById = vi.fn(async () => overrides?.sale === undefined ? sale : overrides.sale);
  const invoiceForSale = vi.fn(async () =>
    overrides?.invoice === undefined ? invoice : overrides.invoice,
  );
  const findByInvoice = vi.fn(async () =>
    overrides?.fiscalization === undefined ? fiscalization : overrides.fiscalization,
  );
  return {
    service: createFiscalReceiptReadService({
      sales: { findById, invoiceForSale },
      fiscalizations: { findByInvoice },
    }),
    findById,
    invoiceForSale,
    findByInvoice,
  };
}

describe('historical fiscal receipt read', () => {
  it(
    'returns the same sealed QR/hash and persisted sale facts without a write dependency',
    async () => {
      const { service, findById, invoiceForSale, findByInvoice } = subject();

      const result = await service.read(principal, sale.id, sale.terminalId);

      expect(result).toMatchObject({
        outcome: 'success',
        sale: {
          saleId: sale.id,
          invoiceNumber: 'INV-42',
          terminalId: sale.terminalId,
          cashierName: principal.displayName,
          totalMinor: '2300',
          vatMinor: '300',
          cashReceivedMinor: '2500',
          changeMinor: '200',
        },
        receipt: {
          invoiceId: invoice.id,
          invoiceNumber: 'INV-42',
          invoiceHashBase64: 'AQID',
          qrCodeBase64: 'PERSISTED_PHASE_2_QR',
        },
      });
      expect(findById).toHaveBeenCalledTimes(1);
      expect(invoiceForSale).toHaveBeenCalledTimes(1);
      expect(findByInvoice).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['branch', { ...sale, branchId: 'other-branch' }],
    ['terminal', { ...sale, terminalId: 'other-terminal' }],
    ['cashier', { ...sale, userId: 'other-user' }],
    ['status', { ...sale, status: 'voided' as const }],
  ])(
    'hides a sale outside %s ownership before reading fiscal evidence',
    async (_label, candidate) => {
      const { service, invoiceForSale, findByInvoice } = subject({ sale: candidate as SaleRecord });

      await expect(service.read(principal, sale.id, sale.terminalId)).resolves.toEqual({
        outcome: 'not-found',
      });
      expect(invoiceForSale).not.toHaveBeenCalled();
      expect(findByInvoice).not.toHaveBeenCalled();
    },
  );

  it(
    'requires already-sealed durable evidence and never attempts to complete fiscalization',
    async () => {
      const reserved = {
        ...fiscalization,
        state: 'reserved' as const,
      };
      const { service } = subject({
        fiscalization: reserved as unknown as ZatcaSealedFiscalization,
      });

      await expect(service.read(principal, sale.id, sale.terminalId)).resolves.toEqual({
        outcome: 'not-sealed',
      });
    },
  );

  it('does not expose a sale when the requested authoritative terminal differs', async () => {
    const { service, invoiceForSale } = subject();

    await expect(service.read(principal, sale.id, 'other-terminal')).resolves.toEqual({
      outcome: 'not-found',
    });
    expect(invoiceForSale).not.toHaveBeenCalled();
  });
});
