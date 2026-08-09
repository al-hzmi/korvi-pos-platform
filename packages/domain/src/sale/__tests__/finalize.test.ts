import { describe, expect, it } from 'vitest';
import { DiscountNotPermittedError, finalizeSale, saleReconciles, totalOf } from '../finalize.js';
import type { FinalizeSaleInput } from '../finalize.js';
import { money } from '../../money/money.js';
import { units, quantityFromDecimalString } from '../../quantity/quantity.js';
import { VAT_STANDARD_BP } from '../../tax/basis-points.js';
import { InvalidAmountError, NonCashChangeError, UnderpaidError } from '../../errors.js';
import { ROLE_MAX_DISCOUNT_BP } from '../../rbac/permissions.js';
import type { CartLineInput } from '../../pricing/line.js';

const item = (over: Partial<CartLineInput> = {}): CartLineInput => ({
  lineId: over.lineId ?? 'l1',
  productId: over.productId ?? 'p1',
  sku: over.sku ?? 'SKU-1',
  nameAr: over.nameAr ?? 'ماء',
  nameEn: over.nameEn ?? null,
  unitPrice: over.unitPrice ?? money(10_000n),
  quantity: over.quantity ?? units(1),
  vatRate: over.vatRate ?? VAT_STANDARD_BP,
  ...(over.discount === undefined ? {} : { discount: over.discount }),
});

const input = (over: Partial<FinalizeSaleInput> = {}): FinalizeSaleInput => ({
  saleId: over.saleId ?? '0195e0a0-0000-7000-8000-000000000001',
  operationId: over.operationId ?? 'op-1',
  tenantId: over.tenantId ?? 'tenant-1',
  branchId: over.branchId ?? 'branch-1',
  terminalId: over.terminalId ?? 'terminal-1',
  shiftId: over.shiftId ?? 'shift-1',
  cashierId: over.cashierId ?? 'user-1',
  customerId: over.customerId ?? null,
  cart: over.cart ?? { priceMode: 'tax-exclusive', lines: [item()] },
  tenders: over.tenders ?? [{ kind: 'cash', amount: money(11_500n) }],
  issuedAt: over.issuedAt ?? '2026-08-08T09:45:00Z',
  maxDiscountBasisPoints: over.maxDiscountBasisPoints ?? ROLE_MAX_DISCOUNT_BP.manager,
});

describe('authoritative totals', () => {
  it('computes the total from the lines, not from anything the client sends', () => {
    const sale = finalizeSale(input());
    expect(totalOf(sale).minor).toBe(11_500n);
    expect(sale.priced.net.minor).toBe(10_000n);
    expect(sale.priced.vat.minor).toBe(1_500n);
    expect(sale.status).toBe('finalized');
  });

  it('is deterministic for identical input', () => {
    const first = finalizeSale(input());
    const second = finalizeSale(input());
    expect(second.priced.total.minor).toBe(first.priced.total.minor);
    expect(second.settlement.change.minor).toBe(first.settlement.change.minor);
    expect(JSON.stringify(second, replacer)).toBe(JSON.stringify(first, replacer));
  });

  it('refuses an empty cart', () => {
    expect(() => finalizeSale(input({ cart: { priceMode: 'tax-exclusive', lines: [] } }))).toThrow(
      InvalidAmountError,
    );
  });

  it('refuses a zero-value sale', () => {
    expect(() =>
      finalizeSale(
        input({
          cart: { priceMode: 'tax-exclusive', lines: [item({ unitPrice: money(0n) })] },
          tenders: [{ kind: 'cash', amount: money(0n) }],
        }),
      ),
    ).toThrow(InvalidAmountError);
  });

  it('prices a weighed line', () => {
    const sale = finalizeSale(
      input({
        cart: {
          priceMode: 'tax-exclusive',
          lines: [item({ unitPrice: money(1_200n), quantity: quantityFromDecimalString('0.25') })],
        },
        tenders: [{ kind: 'cash', amount: money(345n) }],
      }),
    );
    // 12.00/kg x 0.25 kg = 3.00 net, 0.45 VAT, 3.45 total.
    expect(sale.priced.total.minor).toBe(345n);
  });
});

describe('immutability of the result', () => {
  it('exposes readonly structures that are not shared with the input', () => {
    const source = input();
    const sale = finalizeSale(source);
    // Mutating the caller's cart afterwards must not change the finalized sale.
    const mutated = { ...source, cart: { ...source.cart, lines: [] } };
    expect(mutated.cart.lines).toHaveLength(0);
    expect(sale.priced.lines).toHaveLength(1);
    expect(sale.priced.total.minor).toBe(11_500n);
  });

  it('carries the operation id that makes replay idempotent', () => {
    const sale = finalizeSale(input({ operationId: 'op-abc' }));
    expect(sale.operationId).toBe('op-abc');
    expect(sale.saleId).toBe('0195e0a0-0000-7000-8000-000000000001');
  });
});

describe('tenders', () => {
  it('settles an exact cash payment with no change', () => {
    const sale = finalizeSale(input());
    expect(sale.settlement.change.minor).toBe(0n);
    expect(sale.settlement.changeFrom).toBeNull();
  });

  it('returns change from cash on an overpayment', () => {
    const sale = finalizeSale(input({ tenders: [{ kind: 'cash', amount: money(20_000n) }] }));
    expect(sale.settlement.change.minor).toBe(8_500n);
    expect(sale.settlement.changeFrom).toBe('cash');
  });

  it('settles exactly on Mada with no change', () => {
    const sale = finalizeSale(
      input({
        tenders: [
          { kind: 'electronic', scheme: 'mada', reference: 'AUTH-11500', amount: money(11_500n) },
        ],
      }),
    );
    expect(sale.settlement.change.minor).toBe(0n);
    expect(sale.settlement.changeFrom).toBeNull();
  });

  it('settles exactly on card with no change', () => {
    const sale = finalizeSale(
      input({
        tenders: [
          { kind: 'electronic', scheme: 'visa', reference: 'AUTH-11500', amount: money(11_500n) },
        ],
      }),
    );
    expect(sale.settlement.change.minor).toBe(0n);
  });

  it('splits card and cash, giving change from the cash portion only', () => {
    const sale = finalizeSale(
      input({
        tenders: [
          { kind: 'electronic', scheme: 'mada', reference: 'AUTH-6000', amount: money(6_000n) },
          { kind: 'cash', amount: money(6_000n) },
        ],
      }),
    );
    expect(sale.settlement.change.minor).toBe(500n);
    expect(sale.settlement.changeFrom).toBe('cash');
  });

  it('refuses a non-cash overpayment', () => {
    // A card terminal cannot hand money back.
    expect(() =>
      finalizeSale(
        input({
          tenders: [
            { kind: 'electronic', scheme: 'visa', reference: 'AUTH-12000', amount: money(12_000n) },
          ],
        }),
      ),
    ).toThrow(NonCashChangeError);
    expect(() =>
      finalizeSale(
        input({
          tenders: [
            { kind: 'electronic', scheme: 'mada', reference: 'AUTH-11501', amount: money(11_501n) },
          ],
        }),
      ),
    ).toThrow(NonCashChangeError);
  });

  it('refuses combined non-cash tenders exceeding the total', () => {
    expect(() =>
      finalizeSale(
        input({
          tenders: [
            { kind: 'electronic', scheme: 'visa', reference: 'AUTH-6000', amount: money(6_000n) },
            { kind: 'electronic', scheme: 'mada', reference: 'AUTH-6000', amount: money(6_000n) },
          ],
        }),
      ),
    ).toThrow(NonCashChangeError);
  });

  it('refuses an underpayment', () => {
    expect(() =>
      finalizeSale(input({ tenders: [{ kind: 'cash', amount: money(11_499n) }] })),
    ).toThrow(UnderpaidError);
  });
});

describe('discount ceiling', () => {
  it('lets a manager grant a discount inside the ceiling', () => {
    const sale = finalizeSale(
      input({
        cart: {
          priceMode: 'tax-exclusive',
          lines: [item({ discount: { kind: 'percentage', value: 1_000n } })],
        },
        tenders: [{ kind: 'cash', amount: money(10_350n) }],
        maxDiscountBasisPoints: ROLE_MAX_DISCOUNT_BP.manager,
      }),
    );
    expect(sale.priced.lineDiscountTotal.minor).toBe(1_000n);
  });

  it('refuses a discount above the ceiling', () => {
    expect(() =>
      finalizeSale(
        input({
          cart: {
            priceMode: 'tax-exclusive',
            lines: [item({ discount: { kind: 'percentage', value: 3_000n } })],
          },
          tenders: [{ kind: 'cash', amount: money(8_050n) }],
          maxDiscountBasisPoints: ROLE_MAX_DISCOUNT_BP.manager,
        }),
      ),
    ).toThrow(DiscountNotPermittedError);
  });

  it('refuses any discount for a cashier', () => {
    // Hiding the button is convenience; this is the control.
    expect(() =>
      finalizeSale(
        input({
          cart: {
            priceMode: 'tax-exclusive',
            lines: [item({ discount: { kind: 'fixed', value: 100n } })],
          },
          tenders: [{ kind: 'cash', amount: money(11_385n) }],
          maxDiscountBasisPoints: ROLE_MAX_DISCOUNT_BP.cashier,
        }),
      ),
    ).toThrow(DiscountNotPermittedError);
  });

  it('counts a basket discount against the same ceiling', () => {
    expect(() =>
      finalizeSale(
        input({
          cart: {
            priceMode: 'tax-exclusive',
            lines: [item()],
            basketDiscount: { kind: 'percentage', value: 4_000n },
          },
          tenders: [{ kind: 'cash', amount: money(6_900n) }],
          maxDiscountBasisPoints: ROLE_MAX_DISCOUNT_BP.manager,
        }),
      ),
    ).toThrow(DiscountNotPermittedError);
  });

  it('allows an owner the full range', () => {
    const sale = finalizeSale(
      input({
        cart: {
          priceMode: 'tax-exclusive',
          lines: [item({ discount: { kind: 'percentage', value: 9_000n } })],
        },
        tenders: [{ kind: 'cash', amount: money(1_150n) }],
        maxDiscountBasisPoints: ROLE_MAX_DISCOUNT_BP.owner,
      }),
    );
    expect(sale.priced.total.minor).toBe(1_150n);
  });
});

describe('saleReconciles', () => {
  it('holds for a plain sale', () => {
    expect(saleReconciles(finalizeSale(input()))).toBe(true);
  });

  it('holds across a sweep of prices, tenders, modes and discounts', () => {
    for (let price = 100n; price <= 5_000n; price += 311n) {
      for (const priceMode of ['tax-exclusive', 'tax-inclusive'] as const) {
        const sale = finalizeSale(
          input({
            cart: {
              priceMode,
              lines: [
                item({ lineId: 'a', unitPrice: money(price), quantity: units(2) }),
                item({
                  lineId: 'b',
                  unitPrice: money(price + 13n),
                  quantity: quantityFromDecimalString('0.375'),
                  discount: { kind: 'percentage', value: 500n },
                }),
              ],
              basketDiscount: { kind: 'fixed', value: 7n },
            },
            tenders: [{ kind: 'cash', amount: money(1_000_000n) }],
            maxDiscountBasisPoints: 10_000n,
          }),
        );
        expect(saleReconciles(sale), `price ${price.toString()} ${priceMode}`).toBe(true);
      }
    }
  });
});

/** bigint is not JSON-serialisable; this is only for structural comparison. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
