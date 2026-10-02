import { describe, expect, it } from 'vitest';
import { tenantId, VAT_STANDARD_BP } from '@korvi/domain';
import { buildCheckoutReceipt } from '../checkout/receipt.js';
import { createStagingSimulationCheckoutFiscalization } from '../zatca/staging-simulation-checkout-fiscalization.js';
import type { InvoiceRecord, SaleRecord, TenantScope } from '@korvi/domain';

const scope: TenantScope = { tenantId: tenantId('018f2e20-7b7a-7c00-8000-000000000011') };
const sale: SaleRecord = {
  id: '018f2e20-7b7a-7c00-8000-000000000012',
  tenantId: scope.tenantId,
  branchId: '018f2e20-7b7a-7c00-8000-000000000013',
  terminalId: '018f2e20-7b7a-7c00-8000-000000000014',
  shiftId: '018f2e20-7b7a-7c00-8000-000000000015',
  userId: '018f2e20-7b7a-7c00-8000-000000000016',
  customerId: null,
  operationId: '018f2e20-7b7a-7c00-8000-000000000017',
  status: 'finalized',
  sequence: 7,
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
  id: '018f2e20-7b7a-7c00-8000-000000000018',
  tenantId: scope.tenantId,
  saleId: sale.id,
  invoiceNumber: 'SIM-7',
  invoiceType: 'simplified',
  sellerName: 'Demo Merchant',
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

describe('staging-only ZATCA simulation fiscalization', () => {
  it('completes deterministically without Azure or Production CSID and marks the receipt', async () => {
    const provider = createStagingSimulationCheckoutFiscalization();
    const first = await provider.fiscalize(scope, sale, invoice);
    const replay = await provider.fiscalize(scope, sale, invoice);

    expect(first).toBeDefined();
    expect(first).toEqual(replay);
    expect(first?.state).toBe('simulation');
    if (first === undefined || first.state !== 'simulation') throw new Error('simulation missing');

    expect(new TextDecoder().decode(first.artifact)).toContain('NOT FOR TAX USE');
    expect(buildCheckoutReceipt(sale, invoice, first)).toMatchObject({
      fiscalizationMode: 'simulation',
      disclaimer: 'SIMULATION / NOT FOR TAX USE',
      invoiceNumber: 'SIM-7',
    });
  });
});
