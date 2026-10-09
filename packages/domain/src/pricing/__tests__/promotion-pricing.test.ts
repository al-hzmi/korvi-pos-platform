import { describe, expect, it } from 'vitest';
import { money } from '../../money/money.js';
import { quantity } from '../../quantity/quantity.js';
import { basisPoints } from '../../tax/basis-points.js';
import {
  PromotionAuthorizationError,
  PromotionManualDiscountConflictError,
  finalizeSale,
  saleReconciles,
} from '../../sale/finalize.js';
import { priceCart } from '../line.js';

describe('promotion pricing authority', () => {
  it.each(['tax-inclusive', 'tax-exclusive'] as const)(
    'subtracts the server policy allocation before VAT and reconciles (%s)',
    (priceMode) => {
      const priced = priceCart({
        priceMode,
        lines: [
          {
            lineId: '1',
            productId: 'p1',
            sku: 'P1',
            nameAr: 'صنف',
            nameEn: null,
            unitPrice: money(1_150n),
            quantity: quantity(1_000n),
            vatRate: basisPoints(1500),
            promotionDiscountMinor: 115n,
          },
        ],
      });

      expect(priced.promotionDiscountTotal.minor).toBe(115n);
      expect(priced.lines[0]?.promotionDiscount.minor).toBe(115n);
      if (priceMode === 'tax-inclusive') {
        expect(priced.total.minor).toBe(1_035n);
        expect(priced.net.minor + priced.vat.minor).toBe(1_035n);
      } else {
        expect(priced.net.minor).toBe(1_035n);
        expect(priced.total.minor).toBeGreaterThan(1_035n);
      }
    },
  );

  it('does not require cashier manual-discount authority for merchant promotion policy', () => {
    const sale = finalizeSale({
      saleId: '00000000-0000-7000-8000-000000000001',
      operationId: 'op-1',
      tenantId: '00000000-0000-7000-8000-000000000002',
      branchId: '00000000-0000-7000-8000-000000000003',
      terminalId: '00000000-0000-7000-8000-000000000004',
      shiftId: '00000000-0000-7000-8000-000000000005',
      cashierId: '00000000-0000-7000-8000-000000000006',
      customerId: null,
      issuedAt: '2026-09-25T12:00:00.000Z',
      maxDiscountBasisPoints: 0n,
      promotionAuthorization: {
        totalDiscountMinor: 115n,
        lineDiscounts: [{ lineId: '1', amountMinor: 115n }],
      },
      cart: {
        priceMode: 'tax-inclusive',
        lines: [
          {
            lineId: '1',
            productId: 'p1',
            sku: 'P1',
            nameAr: 'صنف',
            nameEn: null,
            unitPrice: money(1_150n),
            quantity: quantity(1_000n),
            vatRate: basisPoints(1500),
            promotionDiscountMinor: 115n,
          },
        ],
      },
      tenders: [{ kind: 'cash', amount: money(1_035n) }],
    });

    expect(sale.priced.promotionDiscountTotal.minor).toBe(115n);
    expect(saleReconciles(sale)).toBe(true);
  });

  it('refuses a promotion allocation with no server-evaluated authorization plan', () => {
    expect(() =>
      finalizeSale({
        saleId: '00000000-0000-7000-8000-000000000021',
        operationId: 'op-auth-missing',
        tenantId: '00000000-0000-7000-8000-000000000022',
        branchId: '00000000-0000-7000-8000-000000000023',
        terminalId: '00000000-0000-7000-8000-000000000024',
        shiftId: '00000000-0000-7000-8000-000000000025',
        cashierId: '00000000-0000-7000-8000-000000000026',
        customerId: null,
        issuedAt: '2026-09-25T12:00:00.000Z',
        maxDiscountBasisPoints: 0n,
        cart: {
          priceMode: 'tax-inclusive',
          lines: [
            {
              lineId: '1',
              productId: 'p1',
              sku: 'P1',
              nameAr: 'صنف',
              nameEn: null,
              unitPrice: money(1_150n),
              quantity: quantity(1_000n),
              vatRate: basisPoints(1500),
              promotionDiscountMinor: 115n,
            },
          ],
        },
        tenders: [{ kind: 'cash', amount: money(1_035n) }],
      }),
    ).toThrow(PromotionAuthorizationError);
  });

  it('refuses a promotion authorization plan that does not match the cart allocations', () => {
    expect(() =>
      finalizeSale({
        saleId: '00000000-0000-7000-8000-000000000031',
        operationId: 'op-auth-mismatch',
        tenantId: '00000000-0000-7000-8000-000000000032',
        branchId: '00000000-0000-7000-8000-000000000033',
        terminalId: '00000000-0000-7000-8000-000000000034',
        shiftId: '00000000-0000-7000-8000-000000000035',
        cashierId: '00000000-0000-7000-8000-000000000036',
        customerId: null,
        issuedAt: '2026-09-25T12:00:00.000Z',
        maxDiscountBasisPoints: 0n,
        promotionAuthorization: {
          totalDiscountMinor: 114n,
          lineDiscounts: [{ lineId: '1', amountMinor: 114n }],
        },
        cart: {
          priceMode: 'tax-inclusive',
          lines: [
            {
              lineId: '1',
              productId: 'p1',
              sku: 'P1',
              nameAr: 'صنف',
              nameEn: null,
              unitPrice: money(1_150n),
              quantity: quantity(1_000n),
              vatRate: basisPoints(1500),
              promotionDiscountMinor: 115n,
            },
          ],
        },
        tenders: [{ kind: 'cash', amount: money(1_035n) }],
      }),
    ).toThrow(PromotionAuthorizationError);
  });

  it('refuses manual discount plus promotion policy in one finalized sale', () => {
    expect(() =>
      finalizeSale({
        saleId: '00000000-0000-7000-8000-000000000011',
        operationId: 'op-2',
        tenantId: '00000000-0000-7000-8000-000000000012',
        branchId: '00000000-0000-7000-8000-000000000013',
        terminalId: '00000000-0000-7000-8000-000000000014',
        shiftId: '00000000-0000-7000-8000-000000000015',
        cashierId: '00000000-0000-7000-8000-000000000016',
        customerId: null,
        issuedAt: '2026-09-25T12:00:00.000Z',
        maxDiscountBasisPoints: 10_000n,
        promotionAuthorization: {
          totalDiscountMinor: 115n,
          lineDiscounts: [{ lineId: '1', amountMinor: 115n }],
        },
        cart: {
          priceMode: 'tax-inclusive',
          lines: [
            {
              lineId: '1',
              productId: 'p1',
              sku: 'P1',
              nameAr: 'صنف',
              nameEn: null,
              unitPrice: money(1_150n),
              quantity: quantity(1_000n),
              vatRate: basisPoints(1500),
              promotionDiscountMinor: 115n,
              discount: { kind: 'fixed', value: 1n },
            },
          ],
        },
        tenders: [{ kind: 'cash', amount: money(1_034n) }],
      }),
    ).toThrow(PromotionManualDiscountConflictError);
  });

  it('refuses a promotion allocation larger than the line value', () => {
    expect(() =>
      priceCart({
        priceMode: 'tax-inclusive',
        lines: [
          {
            lineId: '1',
            productId: 'p1',
            sku: 'P1',
            nameAr: 'صنف',
            nameEn: null,
            unitPrice: money(100n),
            quantity: quantity(1_000n),
            vatRate: basisPoints(1500),
            promotionDiscountMinor: 101n,
          },
        ],
      }),
    ).toThrow(/Promotion allocation/);
  });
});
