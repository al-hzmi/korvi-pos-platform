import { beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { createCheckoutService } from '../checkout/service.js';
import { fingerprintIntent } from '../checkout/fingerprint.js';
import {
  MemoryBusinessStore,
  memoryAuditRepository,
  memoryIdempotencyRepository,
  memoryInventoryRepository,
  memoryProductRepository,
  memorySaleRepository,
  memoryShiftRepository,
  memoryTenantRepository,
  seedStore,
} from './support/memory-business.js';
import type { CheckoutService } from '../checkout/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Fixture } from './support/memory-business.js';

const A: Fixture = {
  tenant: '018f1000-0000-7000-8000-00000000000a',
  branch: '018f1000-0000-7000-8000-0000000000a1',
  terminal: '018f1000-0000-7000-8000-0000000000a2',
  shift: '018f1000-0000-7000-8000-0000000000a3',
  user: '018f1000-0000-7000-8000-0000000000a4',
  milk: '018f1000-0000-7000-8000-0000000000a5',
  rice: '018f1000-0000-7000-8000-0000000000a6',
};

const OPERATION = '018f1000-0000-7000-8000-0000000000f1';

let store: MemoryBusinessStore;
let service: CheckoutService;
let counter: number;

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    tenantId: A.tenant,
    tenantSlug: 'korvi',
    userId: A.user,
    sessionId: '018f1000-0000-7000-8000-0000000000e1',
    email: 'sara@korvi.test',
    displayName: 'سارة',
    roles: ['cashier'],
    permissions: [...ROLE_PERMISSIONS.cashier],
    maxDiscountBasisPoints: 0n,
    branchId: A.branch,
    ...overrides,
  };
}

beforeEach(() => {
  store = new MemoryBusinessStore();
  seedStore(store, A);
  counter = 0;
  service = createCheckoutService({
    tenants: memoryTenantRepository(store),
    products: memoryProductRepository(store),
    inventory: memoryInventoryRepository(store),
    shifts: memoryShiftRepository(store),
    sales: memorySaleRepository(store),
    idempotency: memoryIdempotencyRepository(store),
    audit: memoryAuditRepository(store),
    now: () => new Date('2026-08-12T09:00:00.000Z'),
    newId: () => {
      counter += 1;
      return `018f1000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
    },
  });
});

function checkout(overrides: Partial<Parameters<CheckoutService['checkout']>[0]> = {}) {
  return service.checkout({
    principal: principal(),
    operationId: OPERATION,
    terminalId: A.terminal,
    cashReceivedMinor: '5000',
    lines: [{ productId: A.milk, quantityScaled: '2000' }],
    ...overrides,
  });
}

describe('a cash sale', () => {
  it('prices from persistence and returns exact figures', async () => {
    // Two litres of milk at 11.50 tax-inclusive: 23.00 total, of which
    // 3.00 is VAT at 15% and 20.00 is net. Cash 50.00, change 27.00.
    const result = await checkout();
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    expect(result.sale.totalMinor).toBe('2300');
    expect(result.sale.vatMinor).toBe('300');
    expect(result.sale.netMinor).toBe('2000');
    expect(result.sale.cashReceivedMinor).toBe('5000');
    expect(result.sale.changeMinor).toBe('2700');
    expect(result.replayed).toBe(false);
  });

  it('reconciles: net + vat = total, and the lines sum to it', async () => {
    const result = await checkout({
      lines: [
        { productId: A.milk, quantityScaled: '3000' },
        { productId: A.rice, quantityScaled: '1500' },
      ],
      cashReceivedMinor: '10000',
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const net = BigInt(result.sale.netMinor);
    const vat = BigInt(result.sale.vatMinor);
    const total = BigInt(result.sale.totalMinor);
    expect(net + vat).toBe(total);

    const lineTotals = result.sale.lines.reduce((sum, line) => sum + BigInt(line.totalMinor), 0n);
    expect(lineTotals).toBe(total);
    expect(BigInt(result.sale.cashReceivedMinor) - BigInt(result.sale.changeMinor)).toBe(total);
  });

  it('takes the unit price from the database, whatever the client believes', async () => {
    // The request carries no price at all — there is nowhere to put one.
    const result = await checkout();
    if (result.outcome !== 'success') throw new Error(result.reason);
    expect(result.sale.lines[0]?.unitPriceMinor).toBe('1150');

    // Replaced rather than mutated: a Product is readonly, which is the point.
    store.products[0] = { ...store.products[0]!, priceMinor: '1200' };
    const after = await checkout({ operationId: '018f1000-0000-7000-8000-0000000000f2' });
    if (after.outcome !== 'success') throw new Error(after.reason);
    expect(after.sale.lines[0]?.unitPriceMinor).toBe('1200');
  });

  it('allocates the receipt number and invoice number on the server', async () => {
    const first = await checkout();
    const second = await checkout({ operationId: '018f1000-0000-7000-8000-0000000000f2' });
    if (first.outcome !== 'success' || second.outcome !== 'success')
      throw new Error('expected two sales');

    expect(first.sale.sequence).toBe(1);
    expect(second.sale.sequence).toBe(2);
    expect(first.sale.invoiceNumber).toBe('01-000001');
    expect(second.sale.invoiceNumber).toBe('01-000002');
  });

  it('moves stock off the shelf', async () => {
    await checkout();
    const movement = store.movements.at(0);
    expect(movement?.kind).toBe('sale');
    expect(movement?.quantityScaled).toBe('-2000');
    expect(store.products[0]?.branchStock[A.branch]).toBe('8000');
  });

  it('records the sale in the audit trail without a secret', async () => {
    await checkout();
    const event = store.audit.find((entry) => entry.eventType === 'sale.completed');
    expect(event).toBeDefined();
    expect(JSON.stringify(event)).not.toContain('scrypt$');
    expect(JSON.stringify(event)).not.toContain('kps1.');
  });
});

describe('what a cash sale refuses', () => {
  it('refuses when the till has no open shift', async () => {
    store.shifts = [];
    const result = await checkout();
    expect(result.outcome === 'failure' && result.reason).toBe('no-open-shift');
  });

  it('refuses an empty cart', async () => {
    const result = await checkout({ lines: [] });
    expect(result.outcome === 'failure' && result.reason).toBe('empty-cart');
  });

  it('refuses cash that does not cover the total', async () => {
    const result = await checkout({ cashReceivedMinor: '2299' });
    expect(result.outcome === 'failure' && result.reason).toBe('insufficient-cash');
  });

  it('accepts cash that covers it exactly, with no change', async () => {
    const result = await checkout({ cashReceivedMinor: '2300' });
    if (result.outcome !== 'success') throw new Error(result.reason);
    expect(result.sale.changeMinor).toBe('0');
  });

  it('refuses a product that is not in this tenant', async () => {
    const result = await checkout({
      lines: [{ productId: '018f1000-0000-7000-8000-0000000000ff', quantityScaled: '1000' }],
    });
    expect(result.outcome === 'failure' && result.reason).toBe('unknown-product');
  });

  it('refuses a deactivated product', async () => {
    store.products[0] = { ...store.products[0]!, isActive: false };
    const result = await checkout();
    expect(result.outcome === 'failure' && result.reason).toBe('product-unavailable');
  });

  it('refuses a fractional quantity of a unit product', async () => {
    // Half a bottle of milk is not a thing a till may ring up.
    const result = await checkout({ lines: [{ productId: A.milk, quantityScaled: '1500' }] });
    expect(result.outcome === 'failure' && result.reason).toBe('invalid-quantity');
  });

  it('accepts a fractional quantity of a weighed product', async () => {
    const result = await checkout({
      lines: [{ productId: A.rice, quantityScaled: '1250' }],
      cashReceivedMinor: '5000',
    });
    if (result.outcome !== 'success') throw new Error(result.reason);
    // 1.25 kg at 24.00 = 30.00.
    expect(result.sale.totalMinor).toBe('3000');
  });

  it('refuses to sell stock the branch does not have', async () => {
    store.products[0]!.branchStock[A.branch] = '1000';
    const result = await checkout({ lines: [{ productId: A.milk, quantityScaled: '2000' }] });
    expect(result.outcome === 'failure' && result.reason).toBe('insufficient-stock');
    expect(store.sales).toHaveLength(0);
  });

  it('allows overselling only when the merchant has said so', async () => {
    store.settings[0] = { ...store.settings[0]!, allowNegativeStock: true };
    store.products[0]!.branchStock[A.branch] = '1000';
    const result = await checkout({ lines: [{ productId: A.milk, quantityScaled: '2000' }] });
    expect(result.outcome).toBe('success');
    expect(store.products[0]?.branchStock[A.branch]).toBe('-1000');
  });

  it('refuses a duplicate product line rather than aggregating it silently', async () => {
    // Six and six against a stock of ten: each line passes on its own and the
    // sum does not.
    const result = await checkout({
      lines: [
        { productId: A.milk, quantityScaled: '6000' },
        { productId: A.milk, quantityScaled: '6000' },
      ],
      cashReceivedMinor: '20000',
    });
    expect(result.outcome === 'failure' && result.reason).toBe('duplicate-line');
    expect(store.sales).toHaveLength(0);
  });

  it('refuses to ring into another cashier’s shift', async () => {
    const other = '018f1000-0000-7000-8000-0000000000c9';
    const result = await checkout({ principal: principal({ userId: other }) });
    expect(result.outcome === 'failure' && result.reason).toBe('shift-invalid');
  });

  it('refuses a till in a branch the principal is not pinned to', async () => {
    const result = await checkout({
      principal: principal({ branchId: '018f1000-0000-7000-8000-0000000000ca' }),
    });
    expect(result.outcome === 'failure' && result.reason).toBe('shift-invalid');
  });

  it('refuses at the persistence boundary when the shift closed underneath it', async () => {
    // The pre-flight read saw an open shift; the fake closes it the way the
    // database would have, and the transaction refuses.
    const closing = createCheckoutService({
      tenants: memoryTenantRepository(store),
      products: memoryProductRepository(store),
      inventory: memoryInventoryRepository(store),
      shifts: {
        ...memoryShiftRepository(store),
        findOpenForTerminal: async (scope, terminalId) => {
          const found = await memoryShiftRepository(store).findOpenForTerminal(scope, terminalId);
          store.shifts[0] = { ...store.shifts[0]!, status: 'closed' };
          return found;
        },
      },
      sales: memorySaleRepository(store),
      idempotency: memoryIdempotencyRepository(store),
      audit: memoryAuditRepository(store),
    });

    const result = await closing.checkout({
      principal: principal(),
      operationId: OPERATION,
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    expect(result.outcome === 'failure' && result.reason).toBe('shift-invalid');
    expect(store.sales).toHaveLength(0);
  });

  it('leaves nothing behind when persistence fails', async () => {
    store.recordFails = true;
    await expect(checkout()).rejects.toThrow(/persistence failed/);
    expect(store.sales).toHaveLength(0);
    expect(store.invoices).toHaveLength(0);
    expect(store.movements).toHaveLength(0);
    expect(store.keys).toHaveLength(0);
    expect(store.products[0]?.branchStock[A.branch]).toBe('10000');
  });
});

describe('idempotency', () => {
  it('returns the same sale for the same key and the same intent', async () => {
    const first = await checkout();
    const second = await checkout();
    if (first.outcome !== 'success' || second.outcome !== 'success')
      throw new Error('expected success');

    expect(second.replayed).toBe(true);
    expect(second.sale.saleId).toBe(first.sale.saleId);
    expect(second.sale.sequence).toBe(first.sale.sequence);
    // And nothing was written the second time.
    expect(store.sales).toHaveLength(1);
    expect(store.movements).toHaveLength(1);
  });

  it.each([
    ['a changed quantity', { lines: [{ productId: A.milk, quantityScaled: '3000' }] }],
    ['a changed product', { lines: [{ productId: A.rice, quantityScaled: '2000' }] }],
    ['changed cash received', { cashReceivedMinor: '6000' }],
  ])('refuses the same key with %s', async (_label, overrides) => {
    await checkout();
    const replay = await checkout(overrides);
    expect(replay.outcome === 'failure' && replay.reason).toBe('idempotency-conflict');
    expect(store.sales).toHaveLength(1);
  });

  it('is not confused by the basket being reordered', async () => {
    const lines = [
      { productId: A.milk, quantityScaled: '2000' },
      { productId: A.rice, quantityScaled: '1000' },
    ];
    const first = await checkout({ lines, cashReceivedMinor: '10000' });
    const second = await checkout({ lines: [...lines].reverse(), cashReceivedMinor: '10000' });
    if (first.outcome !== 'success' || second.outcome !== 'success')
      throw new Error('expected success');
    expect(second.replayed).toBe(true);
    expect(second.sale.saleId).toBe(first.sale.saleId);
  });
});

describe('the intent fingerprint', () => {
  const base = {
    branchId: A.branch,
    terminalId: A.terminal,
    lines: [{ productId: A.milk, quantityScaled: '2000', discount: '' }],
    tenders: [{ kind: 'cash', amountMinor: '5000', scheme: '', reference: '' }],
    basketDiscount: '',
  };

  it('is stable across line order', () => {
    const two = {
      ...base,
      lines: [...base.lines, { productId: A.rice, quantityScaled: '1000', discount: '' }],
    };
    const reversed = { ...two, lines: [...two.lines].reverse() };
    expect(fingerprintIntent(two)).toBe(fingerprintIntent(reversed));
  });

  it('is stable across tender order', () => {
    // A cashier who keys the card first and a cashier who keys the cash first
    // are describing the same payment.
    const split = {
      ...base,
      tenders: [
        { kind: 'cash', amountMinor: '2000', scheme: '', reference: '' },
        { kind: 'electronic', amountMinor: '1000', scheme: 'mada', reference: 'AUTH-1' },
      ],
    };
    const swapped = { ...split, tenders: [...split.tenders].reverse() };
    expect(fingerprintIntent(split)).toBe(fingerprintIntent(swapped));
  });

  it.each([
    ['quantity', { ...base, lines: [{ productId: A.milk, quantityScaled: '2001', discount: '' }] }],
    ['product', { ...base, lines: [{ productId: A.rice, quantityScaled: '2000', discount: '' }] }],
    ['terminal', { ...base, terminalId: A.shift }],
    [
      'cash figure',
      { ...base, tenders: [{ kind: 'cash', amountMinor: '5001', scheme: '', reference: '' }] },
    ],
    [
      'payment mix',
      {
        ...base,
        tenders: [{ kind: 'electronic', amountMinor: '2300', scheme: 'mada', reference: 'AUTH-1' }],
      },
    ],
    [
      'approval reference',
      {
        ...base,
        tenders: [{ kind: 'electronic', amountMinor: '2300', scheme: 'mada', reference: 'AUTH-2' }],
      },
    ],
    ['basket discount', { ...base, basketDiscount: 'bp:1000' }],
    [
      'line discount',
      { ...base, lines: [{ productId: A.milk, quantityScaled: '2000', discount: 'fx:150' }] },
    ],
  ])('changes with the %s', (_label, changed) => {
    // Each of these is a different commercial event. Replaying one as another
    // would be wrong in a way nobody could reconstruct from the sale row.
    expect(fingerprintIntent(changed)).not.toBe(fingerprintIntent(base));
  });

  it('carries nothing secret', () => {
    // A digest of ids, quantities, amounts, a scheme name and somebody else's
    // approval reference — the same things the sale row holds in the clear.
    expect(fingerprintIntent(base)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('what a client may not decide', () => {
  it('ignores a client-asserted tenant, taking the principal at its word instead', async () => {
    // There is no field for it, and the pipeline reads only the principal.
    const result = await service.checkout({
      principal: principal({ tenantId: A.tenant }),
      operationId: OPERATION,
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);
    expect(store.sales[0]?.tenantId).toBe(A.tenant);
    expect(store.sales[0]?.userId).toBe(A.user);
  });

  it('cannot reach another tenant’s product even with its real id', async () => {
    const B: Fixture = {
      tenant: '018f1000-0000-7000-8000-00000000000b',
      branch: '018f1000-0000-7000-8000-0000000000b1',
      terminal: '018f1000-0000-7000-8000-0000000000b2',
      shift: '018f1000-0000-7000-8000-0000000000b3',
      user: '018f1000-0000-7000-8000-0000000000b4',
      milk: '018f1000-0000-7000-8000-0000000000b5',
      rice: '018f1000-0000-7000-8000-0000000000b6',
    };
    seedStore(store, B);

    const result = await checkout({ lines: [{ productId: B.milk, quantityScaled: '1000' }] });
    expect(result.outcome === 'failure' && result.reason).toBe('unknown-product');
  });

  it('writes the cashier from the session, not from anywhere else', async () => {
    await checkout({ principal: principal({ userId: A.user }) });
    expect(store.sales[0]?.userId).toBe(A.user);
    expect(store.sales[0]?.shiftId).toBe(A.shift);
    expect(store.sales[0]?.branchId).toBe(A.branch);
  });
});

describe('the two payment shapes', () => {
  it('refuses a request that names both, and one that names neither', async () => {
    // Guessing which the client meant is how a sale gets settled twice over.
    const both = await service.checkout({
      principal: principal(),
      operationId: '018f1000-0000-7000-8000-0000000000d1',
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      tenders: [{ kind: 'cash', amountMinor: '5000' }],
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    expect(both.outcome === 'failure' && both.reason).toBe('ambiguous-payment');

    const neither = await service.checkout({
      principal: principal(),
      operationId: '018f1000-0000-7000-8000-0000000000d2',
      terminalId: A.terminal,
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    expect(neither.outcome === 'failure' && neither.reason).toBe('ambiguous-payment');
    expect(store.sales).toHaveLength(0);
  });

  it('normalises the legacy cash figure into one cash tender', async () => {
    const result = await service.checkout({
      principal: principal(),
      operationId: '018f1000-0000-7000-8000-0000000000d3',
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const tenders = store.sales[0]?.tenders ?? [];
    expect(tenders).toHaveLength(1);
    expect(tenders[0]).toMatchObject({ kind: 'cash', scheme: null, amountMinor: '5000' });
    expect(tenders[0]?.changeMinor).toBe('2700');
  });

  it('still reports an empty legacy cash amount as underpaid', async () => {
    // The refusal the till already understands. Reporting it as a malformed
    // tender would change a contract this strike promised not to break.
    const result = await service.checkout({
      principal: principal(),
      operationId: '018f1000-0000-7000-8000-0000000000d4',
      terminalId: A.terminal,
      cashReceivedMinor: '0',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    expect(result.outcome === 'failure' && result.reason).toBe('insufficient-cash');
  });
});

describe('the canonical form cannot be forged', () => {
  const base = {
    branchId: A.branch,
    terminalId: A.terminal,
    lines: [{ productId: A.milk, quantityScaled: '2000', discount: '' }],
    basketDiscount: '',
  };

  it('cannot be made to collide with a delimiter-bearing reference', () => {
    /*
     * The concrete attack on a hand-joined canonical form. Joining fields with
     * ':' and records with ',' means a reference containing both can spell out
     * a second record. One tender whose reference is
     * "R,electronic:visa:100:X" would produce the same joined string as two
     * tenders with references "R" and "X" — two materially different sales,
     * one fingerprint, and a replay that returns the wrong one.
     *
     * JSON gives the separators structure rather than meaning, so the two
     * cannot meet.
     */
    const one = {
      ...base,
      tenders: [
        {
          kind: 'electronic',
          amountMinor: '100',
          scheme: 'mada',
          reference: 'R,electronic:visa:100:X',
        },
      ],
    };
    const two = {
      ...base,
      tenders: [
        { kind: 'electronic', amountMinor: '100', scheme: 'mada', reference: 'R' },
        { kind: 'electronic', amountMinor: '100', scheme: 'visa', reference: 'X' },
      ],
    };

    expect(fingerprintIntent(one)).not.toBe(fingerprintIntent(two));
  });

  it('cannot be made to collide across the field boundary', () => {
    const spilled = {
      ...base,
      tenders: [{ kind: 'electronic', amountMinor: '100', scheme: 'mada', reference: '"],["x' }],
    };
    const plain = {
      ...base,
      tenders: [{ kind: 'electronic', amountMinor: '100', scheme: 'mada', reference: 'x' }],
    };
    expect(fingerprintIntent(spilled)).not.toBe(fingerprintIntent(plain));
  });

  it('cannot be made to collide across the line boundary', () => {
    const spilled = {
      ...base,
      tenders: [{ kind: 'cash', amountMinor: '100', scheme: '', reference: '' }],
      lines: [{ productId: A.milk, quantityScaled: '2000', discount: 'fx:1,p:2' }],
    };
    const plain = {
      ...base,
      tenders: [{ kind: 'cash', amountMinor: '100', scheme: '', reference: '' }],
      lines: [
        { productId: A.milk, quantityScaled: '2000', discount: 'fx:1' },
        { productId: A.rice, quantityScaled: 'p:2', discount: '' },
      ],
    };
    expect(fingerprintIntent(spilled)).not.toBe(fingerprintIntent(plain));
  });
});

describe('what the audit says', () => {
  it('emits sale.completed for every sale, discounted or not', async () => {
    const result = await service.checkout({
      principal: principal(),
      operationId: '018f1000-0000-7000-8000-0000000000d5',
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);
    expect(store.audit.map((event) => event.eventType)).toEqual(['sale.completed']);
  });

  it('adds sale.discounted alongside it, never instead of it', async () => {
    // Replacing the canonical event would break the invariant that every
    // completed sale emits one, and every report built on that invariant.
    const result = await service.checkout({
      principal: principal({
        roles: ['manager'],
        permissions: [...ROLE_PERMISSIONS.manager],
        maxDiscountBasisPoints: 2_000n,
      }),
      operationId: '018f1000-0000-7000-8000-0000000000d6',
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
      basketDiscount: { mode: 'basis-points', value: 1_000 },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    expect(store.audit.map((event) => event.eventType)).toEqual([
      'sale.completed',
      'sale.discounted',
    ]);
    // Nothing that belongs to somebody else's system.
    expect(JSON.stringify(store.audit)).not.toContain('AUTH-');
  });
});
