import { describe, expect, it } from 'vitest';
import { money } from '../../money/money.js';
import { basisPoints } from '../../tax/basis-points.js';
import {
  DuplicateNoReceiptExchangeProductError,
  InvalidNoReceiptExchangeQuantityError,
  NoReceiptExchangeAllowanceError,
  planNoReceiptExchangePolicy,
} from '../no-receipt-exchange.js';

function accepted(
  overrides: Partial<Parameters<typeof planNoReceiptExchangePolicy>[0]['accepted'][number]> = {},
) {
  return {
    productId: '00000000-0000-7000-8000-000000000001',
    sku: 'SKU-1',
    nameAr: 'صنف',
    nameEn: null,
    productType: 'unit' as const,
    quantityScaled: 1_000n,
    currentUnitReferencePrice: money(1_000n),
    currentVatBasisPoints: basisPoints(1500),
    trackInventory: true,
    ...overrides,
  };
}

describe('no-receipt exchange policy', () => {
  it('uses current policy facts to produce a deterministic reference ceiling', () => {
    const plan = planNoReceiptExchangePolicy({
      priceMode: 'tax-exclusive',
      currency: 'SAR',
      accepted: [accepted()],
      approvedAllowanceMinor: 1_000n,
    });
    expect(plan.referenceCeilingMinor).toBe(1_150n);
    expect(plan.approvedAllowanceMinor).toBe(1_000n);
    expect(plan.lines[0]?.currentReferenceTotalMinor).toBe(1_150n);
  });

  it('never permits an allowance above the current reference ceiling', () => {
    expect(() =>
      planNoReceiptExchangePolicy({
        priceMode: 'tax-exclusive',
        currency: 'SAR',
        accepted: [accepted()],
        approvedAllowanceMinor: 1_151n,
      }),
    ).toThrow(NoReceiptExchangeAllowanceError);
  });

  it('allows zero allowance without inventing customer value', () => {
    expect(
      planNoReceiptExchangePolicy({
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        accepted: [accepted()],
        approvedAllowanceMinor: 0n,
      }).approvedAllowanceMinor,
    ).toBe(0n);
  });

  it('refuses duplicate products and non-positive quantities', () => {
    expect(() =>
      planNoReceiptExchangePolicy({
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        accepted: [accepted(), accepted()],
        approvedAllowanceMinor: 0n,
      }),
    ).toThrow(DuplicateNoReceiptExchangeProductError);
    expect(() =>
      planNoReceiptExchangePolicy({
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        accepted: [accepted({ quantityScaled: 0n })],
        approvedAllowanceMinor: 0n,
      }),
    ).toThrow(InvalidNoReceiptExchangeQuantityError);
  });

  it('refuses fractional unit intake but allows weighted intake', () => {
    expect(() =>
      planNoReceiptExchangePolicy({
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        accepted: [accepted({ quantityScaled: 500n })],
        approvedAllowanceMinor: 0n,
      }),
    ).toThrow(InvalidNoReceiptExchangeQuantityError);
    expect(() =>
      planNoReceiptExchangePolicy({
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        accepted: [accepted({ productType: 'weighted', quantityScaled: 500n })],
        approvedAllowanceMinor: 0n,
      }),
    ).not.toThrow();
  });
});
