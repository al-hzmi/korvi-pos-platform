import { afterAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '@korvi/database';
import { tenantId, VAT_STANDARD_BP } from '@korvi/domain';
import { createLazyProductionCheckoutFiscalization } from '../zatca/checkout-fiscalization-infrastructure.js';
import type { InvoiceRecord, SaleRecord, TenantScope } from '@korvi/domain';

const prisma = createPrismaClient('postgresql://127.0.0.1:1/unused');
const scope: TenantScope = { tenantId: tenantId('018f2e20-7b7a-7c00-8000-000000000001') };

const sale: SaleRecord = {
  id: '018f2e20-7b7a-7c00-8000-000000000002',
  tenantId: scope.tenantId,
  branchId: '018f2e20-7b7a-7c00-8000-000000000003',
  terminalId: '018f2e20-7b7a-7c00-8000-000000000004',
  shiftId: '018f2e20-7b7a-7c00-8000-000000000005',
  userId: '018f2e20-7b7a-7c00-8000-000000000006',
  customerId: null,
  operationId: '018f2e20-7b7a-7c00-8000-000000000007',
  status: 'finalized',
  sequence: 1,
  priceMode: 'tax-inclusive',
  currency: 'SAR',
  grossMinor: '1150',
  lineDiscountMinor: '0',
  basketDiscountMinor: '0',
  netMinor: '1000',
  vatMinor: '150',
  totalMinor: '1150',
  tenderedMinor: '1150',
  changeMinor: '0',
  issuedAt: '2026-09-18T12:00:00Z',
  lines: [],
  discounts: [],
  tenders: [],
};

const invoice: InvoiceRecord = {
  id: '018f2e20-7b7a-7c00-8000-000000000008',
  tenantId: scope.tenantId,
  saleId: sale.id,
  invoiceNumber: 'TEST-1',
  invoiceType: 'simplified',
  sellerName: 'شركة كورفي',
  sellerVatNumber: '310123456789013',
  buyerName: null,
  buyerVatNumber: null,
  netMinor: '1000',
  vatMinor: '150',
  totalMinor: '1150',
  currency: 'SAR',
  issuedAt: sale.issuedAt,
  taxBreakdown: [{ vatBasisPoints: VAT_STANDARD_BP, netMinor: '1000', vatMinor: '150' }],
};

afterAll(async () => {
  await prisma.$disconnect();
});

describe('production checkout fiscalization lifecycle', () => {
  it('leaves dashboard and terminal reads independent from missing Azure provider configuration', () => {
    expect(() => createLazyProductionCheckoutFiscalization({ prisma, env: {} })).not.toThrow();
  });

  it('resolves the production provider at checkout and fails closed when it is not configured', async () => {
    const fiscalization = createLazyProductionCheckoutFiscalization({ prisma, env: {} });

    await expect(fiscalization.fiscalize(scope, sale, invoice)).rejects.toThrow(
      /AZURE_KEY_VAULT_NAME is required/,
    );
  });
});
