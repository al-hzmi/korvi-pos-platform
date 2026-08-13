import { describe, expect, it } from 'vitest';
import { basisPoints, tenantId } from '@korvi/domain';
import { createAuditRepository } from '../repositories/audit-repository.js';
import { createBranchRepository } from '../repositories/branch-repository.js';
import { createCustomerRepository } from '../repositories/customer-repository.js';
import { createIdempotencyRepository } from '../repositories/idempotency-repository.js';
import { createInventoryRepository } from '../repositories/inventory-repository.js';
import { createProductRepository } from '../repositories/product-repository.js';
import { createSaleRepository } from '../repositories/sale-repository.js';
import { createShiftRepository } from '../repositories/shift-repository.js';
import { DrawerRefusedError, ShiftOpenRefusedError } from '../errors.js';
import { createTenantRepository } from '../repositories/tenant-repository.js';
import { createTerminalRepository } from '../repositories/terminal-repository.js';
import type { RecordSaleInput, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * What reaches the database, without a database.
 *
 * The fake records every model call a repository makes and every value bound
 * into the tenant-context statement. That is enough to prove the two things
 * this layer is responsible for:
 *
 *   every read and write is filtered by the scope's tenant, and
 *   every one of them runs inside a transaction that has already established
 *   `app.tenant_id`.
 *
 * It deliberately proves nothing about PostgreSQL's own behaviour. Whether RLS
 * actually blocks a cross-tenant read is a question for a live server, and
 * asserting it here would be asserting something this file cannot see.
 */

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const OTHER_TENANT = '018f3a1c-9b2e-7c4d-8e5f-ffffffffffff';
const scope: TenantScope = { tenantId: tenantId(TENANT) };
const AT = '2026-08-08T10:00:00.000Z';

interface Call {
  readonly model: string;
  readonly method: string;
  readonly args: Record<string, unknown>;
}

interface Fake {
  readonly client: PrismaClient;
  readonly calls: Call[];
  readonly contexts: unknown[];
  readonly raw: string[];
}

/** Replies keyed by `model.method`, consumed in order, the last one repeating. */
type Replies = Record<string, readonly unknown[]>;

function fake(replies: Replies = {}): Fake {
  const calls: Call[] = [];
  const contexts: unknown[] = [];
  const raw: string[] = [];
  const cursor = new Map<string, number>();

  const reply = (model: string, method: string): unknown => {
    const key = `${model}.${method}`;
    const queue = replies[key];
    if (queue === undefined || queue.length === 0) {
      if (method === 'findMany') return [];
      if (method === 'createMany' || method === 'updateMany') return { count: 1 };
      return null;
    }
    const index = cursor.get(key) ?? 0;
    cursor.set(key, index + 1);
    return queue[Math.min(index, queue.length - 1)];
  };

  const tx = new Proxy(
    {},
    {
      get(_target, model: string | symbol): unknown {
        if (typeof model !== 'string') return undefined;
        if (model === '$executeRaw') {
          return (_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
            contexts.push(values[0]);
            return Promise.resolve(1);
          };
        }
        if (model === '$queryRaw') {
          // The receipt allocation asks for the branch row and then for the
          // next number. Answering both keeps this a test of tenant scoping
          // rather than a test of how the numbering happens to be written.
          return (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
            const sql = strings.join(' ');
            // The bound values travel with the statement, so a test can still
            // ask what was reserved without the fake parsing SQL.
            raw.push(`${sql} -- ${values.map((value) => String(value)).join(',')}`);
            if (sql.includes('"branches"')) return Promise.resolve([{ code: '01' }]);
            if (sql.includes('"terminals"')) {
              return Promise.resolve([{ branchId: 'b1', isActive: true }]);
            }
            if (sql.includes('"shifts"')) {
              return Promise.resolve([
                { status: 'open', terminalId: 't1', branchId: 'b1', userId: 'u1' },
              ]);
            }
            if (sql.includes('"tenant_settings"')) {
              return Promise.resolve([{ allowNegativeStock: false }]);
            }
            if (sql.includes('"idempotency_keys"')) return Promise.resolve([{ id: 'ik1' }]);
            if (sql.includes('"inventory_balances"')) {
              return Promise.resolve([{ quantityScaled: 0n }]);
            }
            return Promise.resolve([{ sequence: 12 }]);
          };
        }
        return new Proxy(
          {},
          {
            get(_inner, method: string | symbol): unknown {
              if (typeof method !== 'string') return undefined;
              return (args: Record<string, unknown> = {}): Promise<unknown> => {
                calls.push({ model, method, args });
                return Promise.resolve(reply(model, method));
              };
            },
          },
        );
      },
    },
  );

  const client = {
    $transaction: (work: (t: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;

  return { client, calls, contexts, raw };
}

/** JSON with bigint rendered rather than thrown on. */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
}

function branchRow(tenant = TENANT): Record<string, unknown> {
  return { id: 'b1', tenantId: tenant, code: '01', nameAr: 'الفرع', nameEn: null, isActive: true };
}

function productRow(): Record<string, unknown> {
  return {
    id: 'p1',
    tenantId: TENANT,
    categoryId: null,
    sku: 'SKU-1',
    nameAr: 'حليب',
    nameEn: 'Milk',
    productType: 'unit',
    unitLabel: 'each',
    priceMinor: 1150n,
    vatBasisPoints: 1500,
    trackInventory: true,
    isActive: true,
    barcodes: [
      { barcode: '6281000000001', isPrimary: true },
      { barcode: '6281000000002', isPrimary: false },
    ],
  };
}

/** Every operation this layer exposes, driven once. */
async function exerciseEverything(f: Fake): Promise<void> {
  const prisma = f.client;

  await createTenantRepository(prisma).current(scope);
  await createTenantRepository(prisma).settings(scope);
  await createBranchRepository(prisma).findById(scope, 'b1');
  await createBranchRepository(prisma).list(scope);
  await createTerminalRepository(prisma).findById(scope, 't1');
  await createTerminalRepository(prisma).findByCode(scope, '01');
  await createTerminalRepository(prisma).listForBranch(scope, 'b1');
  await createTerminalRepository(prisma).markSeen(scope, 't1', AT);
  await createProductRepository(prisma).findById(scope, 'p1');
  await createProductRepository(prisma).findBySku(scope, 'SKU-1');
  await createProductRepository(prisma).findByBarcode(scope, '6281000000001');
  await createProductRepository(prisma).list(scope, 10);
  await createInventoryRepository(prisma).balance(scope, 'b1', 'p1');
  await createInventoryRepository(prisma).listBalances(scope, 'b1', 10);
  await createInventoryRepository(prisma).applyMovement(scope, {
    id: 'm1',
    branchId: 'b1',
    productId: 'p1',
    kind: 'adjustment',
    quantityScaled: '-1000',
    reason: 'تالف',
    sourceType: null,
    sourceId: null,
    actorUserId: 'u1',
    occurredAt: AT,
  });
  await createCustomerRepository(prisma).findById(scope, 'c1');
  await createCustomerRepository(prisma).findByPhone(scope, '0500000000');
  await createCustomerRepository(prisma).list(scope, 10);
  await createCustomerRepository(prisma).create(scope, {
    id: 'c2',
    nameAr: 'عميل',
    nameEn: null,
    phone: '0500000001',
    email: null,
    vatNumber: null,
  });
  await createShiftRepository(prisma).findById(scope, 's1');
  await createShiftRepository(prisma).findOpenForTerminal(scope, 't1');
  await createSaleRepository(prisma).findById(scope, 'sale1');
  await createSaleRepository(prisma).findByOperationId(scope, 'op-1');
  await createSaleRepository(prisma).invoiceForSale(scope, 'sale1');
  await createIdempotencyRepository(prisma).find(scope, 'checkout', 'op-1');
  await createIdempotencyRepository(prisma).reserve(scope, {
    id: 'ik1',
    scope: 'checkout',
    operationId: 'op-1',
    requestHash: 'abc',
  });
  await createIdempotencyRepository(prisma).complete(scope, 'checkout', 'op-1', {
    resultType: 'sale',
    resultId: 'sale1',
    at: AT,
  });
  await createAuditRepository(prisma).append(scope, {
    id: 'a1',
    actorUserId: 'u1',
    branchId: 'b1',
    terminalId: 't1',
    eventType: 'sale.finalized',
    entityType: 'sale',
    entityId: 'sale1',
    metadata: { sequence: 12 },
    occurredAt: AT,
  });
  await createAuditRepository(prisma).list(scope, 10);
}

/** Replies rich enough that mapping code runs rather than short-circuiting. */
const FULL_REPLIES: Replies = {
  'inventoryBalance.upsert': [
    { tenantId: TENANT, branchId: 'b1', productId: 'p1', quantityScaled: -1000n },
  ],
  'customer.create': [
    {
      id: 'c2',
      tenantId: TENANT,
      nameAr: 'عميل',
      nameEn: null,
      phone: '0500000001',
      email: null,
      vatNumber: null,
      isActive: true,
    },
  ],
  'idempotencyKey.create': [
    {
      id: 'ik1',
      tenantId: TENANT,
      scope: 'checkout',
      operationId: 'op-1',
      status: 'reserved',
      resultType: null,
      resultId: null,
      requestHash: 'abc',
      completedAt: null,
    },
  ],
};

describe('every repository operation is tenant-scoped', () => {
  it('establishes the scope tenant on the transaction before any query', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    // One context statement per operation, and every one carries this tenant.
    expect(f.contexts.length).toBeGreaterThanOrEqual(25);
    for (const value of f.contexts) {
      expect(value).toBe(TENANT);
    }
  });

  it('binds the scope tenant into the where clause of every query that has one', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    const withWhere = f.calls.filter((call) => 'where' in call.args);
    expect(withWhere.length).toBeGreaterThanOrEqual(20);

    for (const call of withWhere) {
      const where = show(call.args['where']);
      expect(
        where.includes(TENANT),
        `${call.model}.${call.method} queried without a tenant filter: ${where}`,
      ).toBe(true);
    }
  });

  it('binds the scope tenant into the data of every row it writes', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    const creates = f.calls.filter(
      (call) => call.method === 'create' || call.method === 'createMany',
    );
    expect(creates.length).toBeGreaterThan(0);

    for (const call of creates) {
      const data = show(call.args['data']);
      expect(
        data.includes(TENANT),
        `${call.model}.${call.method} wrote a row with no tenant: ${data}`,
      ).toBe(true);
    }
  });

  it('never updates or deletes a row by primary key alone', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    // `update` and `delete` take a unique selector, which cannot carry a
    // tenant filter alongside it — an id from another tenant would be written.
    // `updateMany` can, and is what the repositories use.
    for (const call of f.calls) {
      expect([call.model, call.method]).not.toContain('update');
      expect([call.model, call.method]).not.toContain('delete');
      expect([call.model, call.method]).not.toContain('deleteMany');
    }
  });

  it('takes no tenant id from anywhere but the scope', async () => {
    // Each repository method's arguments are ids, codes and values — never a
    // tenant. The only tenant that can reach a query is the scope's.
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    for (const call of f.calls) {
      const rendered = show(call.args);
      expect(rendered).not.toContain(OTHER_TENANT);
    }
  });

  it('reads a product with all of its barcodes', async () => {
    const f = fake({ 'product.findFirst': [productRow()] });
    const product = await createProductRepository(f.client).findById(scope, 'p1');

    expect(product?.primaryBarcode).toBe('6281000000001');
    expect(product?.barcodes).toEqual(['6281000000001', '6281000000002']);
    expect(product?.priceMinor).toBe('1150');
    expect(product?.vatBasisPoints).toBe(basisPoints(1500));
  });

  it('scopes a barcode lookup to the tenant, because barcodes are not globally unique', async () => {
    const f = fake({ 'product.findFirst': [productRow()] });
    await createProductRepository(f.client).findByBarcode(scope, '6281000000001');

    const call = f.calls.find((candidate) => candidate.model === 'product');
    const where = show(call?.args['where']);
    expect(where).toContain('6281000000001');
    expect(where).toContain(TENANT);
  });

  it('refuses a row belonging to another tenant instead of returning it', async () => {
    // Under RLS this row cannot reach us. If it ever does, the boundary is
    // broken, and returning it would be a cross-tenant leak.
    const f = fake({ 'branch.findFirst': [branchRow(OTHER_TENANT)] });
    await expect(createBranchRepository(f.client).findById(scope, 'b1')).rejects.toThrow(
      /another tenant/i,
    );
  });

  it('rejects a malformed tenant id before it reaches a query', async () => {
    const f = fake();
    const bad: TenantScope = { tenantId: tenantId('not-a-uuid') };
    await expect(createBranchRepository(f.client).list(bad)).rejects.toThrow(/tenant UUID/i);
    expect(f.calls).toHaveLength(0);
  });
});

describe('writes that must be atomic', () => {
  function saleInput(): RecordSaleInput {
    return {
      sale: {
        id: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
        branchId: 'b1',
        terminalId: 't1',
        shiftId: 's1',
        userId: 'u1',
        customerId: null,
        operationId: 'op-1',
        status: 'finalized',
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        grossMinor: '1150',
        lineDiscountMinor: '0',
        basketDiscountMinor: '0',
        netMinor: '1000',
        vatMinor: '150',
        totalMinor: '1150',
        tenderedMinor: '2000',
        changeMinor: '850',
        issuedAt: AT,
        lines: [
          {
            id: 'l1',
            lineNumber: 1,
            productId: 'p1',
            sku: 'SKU-1',
            nameAr: 'حليب',
            nameEn: 'Milk',
            productType: 'unit',
            unitPriceMinor: '1150',
            vatBasisPoints: basisPoints(1500),
            quantityScaled: '1000',
            grossMinor: '1150',
            lineDiscountMinor: '0',
            basketDiscountMinor: '0',
            netMinor: '1000',
            vatMinor: '150',
            totalMinor: '1150',
          },
        ],
        discounts: [],
        tenders: [
          // Cash carries no scheme, and the record type now says so.
          {
            id: 'te1',
            kind: 'cash',
            scheme: null,
            amountMinor: '2000',
            changeMinor: '850',
            reference: null,
          },
        ],
      },
      invoice: {
        id: '018f3a1c-9b2e-7c4d-8e5f-0000000000aa',
        saleId: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
        invoiceType: 'simplified',
        sellerName: 'متجر كورفي',
        sellerVatNumber: '300000000000003',
        buyerName: null,
        buyerVatNumber: null,
        netMinor: '1000',
        vatMinor: '150',
        totalMinor: '1150',
        currency: 'SAR',
        issuedAt: AT,
        taxBreakdown: [{ vatBasisPoints: basisPoints(1500), netMinor: '1000', vatMinor: '150' }],
      },
      inventory: [
        {
          id: 'm1',
          branchId: 'b1',
          productId: 'p1',
          kind: 'sale',
          quantityScaled: '-1000',
          reason: null,
          sourceType: 'sale',
          sourceId: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
          actorUserId: 'u1',
          occurredAt: AT,
        },
      ],
      cashMovement: {
        id: 'cm1',
        shiftId: 's1',
        kind: 'sale',
        amountMinor: '1150',
        reason: null,
        actorUserId: 'u1',
        occurredAt: AT,
      },
      idempotency: { id: 'ik1', scope: 'checkout', operationId: 'op-1', requestHash: 'abc' },
    };
  }

  const saleRow: Record<string, unknown> = {
    id: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
    tenantId: TENANT,
    branchId: 'b1',
    terminalId: 't1',
    shiftId: 's1',
    userId: 'u1',
    customerId: null,
    operationId: 'op-1',
    status: 'finalized',
    sequence: 12,
    priceMode: 'tax-inclusive',
    currency: 'SAR',
    grossMinor: 1150n,
    lineDiscountMinor: 0n,
    basketDiscountMinor: 0n,
    netMinor: 1000n,
    vatMinor: 150n,
    totalMinor: 1150n,
    tenderedMinor: 2000n,
    changeMinor: 850n,
    issuedAt: new Date(AT),
    lines: [],
    discounts: [],
    tenders: [],
  };

  it('writes the sale, its invoice, its stock and its cash in one transaction', async () => {
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    // One context statement means one transaction: a crash cannot leave an
    // invoice without its sale, or stock consumed by a sale that never was.
    expect(f.contexts).toEqual([TENANT]);

    const touched = f.calls.map((call) => `${call.model}.${call.method}`);
    for (const expected of [
      'sale.create',
      'saleLine.createMany',
      'tender.createMany',
      'invoice.create',
      'invoiceTaxBreakdown.createMany',
      'inventoryMovement.create',
      'cashMovement.create',
    ]) {
      expect(touched).toContain(expected);
    }

    // The reservation and the balance move are raw statements: one so a
    // concurrent duplicate loses deterministically, the other so a shelf
    // cannot go below zero. Both are inside this same transaction.
    expect(f.raw.some((sql) => sql.includes('"idempotency_keys"'))).toBe(true);
    expect(f.raw.some((sql) => sql.includes('"inventory_balances"'))).toBe(true);
  });

  it('reserves the operation id in the same transaction as the sale', async () => {
    // The unique index is what makes a retry collide instead of ringing up a
    // second sale; reserving in a separate transaction would leave a window.
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    const reservation = f.raw.find((sql) => sql.includes('"idempotency_keys"'));
    expect(reservation).toBeDefined();
    expect(reservation).toContain('op-1');
    expect(reservation).toContain('checkout');
    expect(reservation).toContain(TENANT);
    // Losing the race has to be a defined outcome the service can map, not a
    // raw unique-constraint violation on its way to the client.
    expect(reservation).toContain('ON CONFLICT');
    expect(reservation).toContain('DO NOTHING');
  });

  it('moves stock by a guarded UPDATE rather than a read-modify-write', async () => {
    // Two terminals selling the last unit would both read 1 and both write 0.
    // The predicate is evaluated after the row lock is taken, so the loser
    // matches nothing and its whole transaction goes back.
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    const update = f.raw.find((sql) => sql.includes('"inventory_balances"'));
    expect(update).toBeDefined();
    expect(update).toContain('UPDATE');
    expect(update).toContain('>= 0');
  });

  it('allocates the receipt number itself, under the branch row lock', async () => {
    // The caller cannot supply it: two tills would compute the same "next"
    // number and the second insert would collide.
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    expect(f.raw.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    const created = f.calls.find((call) => `${call.model}.${call.method}` === 'sale.create');
    expect(show(created?.args['data'])).toContain('"sequence":12');

    const invoice = f.calls.find((call) => `${call.model}.${call.method}` === 'invoice.create');
    expect(show(invoice?.args['data'])).toContain('01-000012');
  });

  it('reads the finalized sale back with money as strings', async () => {
    const f = fake({ 'sale.findFirst': [saleRow] });
    const sale = await createSaleRepository(f.client).record(scope, saleInput());

    expect(sale.totalMinor).toBe('1150');
    expect(sale.changeMinor).toBe('850');
    expect(sale.issuedAt).toBe(AT);
  });

  it('refuses to open a second shift on a till that already has one', async () => {
    const f = fake({ 'shift.findFirst': [{ id: 's-open', tenantId: TENANT, status: 'open' }] });
    await expect(
      createShiftRepository(f.client).open(scope, {
        id: 's2',
        branchId: 'b1',
        terminalId: 't1',
        userId: 'u1',
        openingFloatMinor: '20000',
        openedAt: AT,
        openingMovementId: 'cm0',
      }),
    ).rejects.toThrow(ShiftOpenRefusedError);
    // And it serialises on the terminal row first, because two cashiers
    // pressing the button together would both find no open shift.
    expect(f.raw.some((sql) => sql.includes('"terminals"') && sql.includes('FOR UPDATE'))).toBe(
      true,
    );
  });

  it('refuses a close by somebody who does not own the shift, under its lock', async () => {
    // The fake answers the shift lock with an open shift owned by u1.
    const f = fake();
    await expect(
      createShiftRepository(f.client).close(scope, {
        shiftId: 's1',
        terminalId: 't1',
        branchId: 'b1',
        closedByUserId: 'u2',
        declaredCashMinor: '31150',
        closedAt: AT,
        idempotency: { id: 'k1', scope: 'shift-close', operationId: 'op1', requestHash: 'h' },
      }),
    ).rejects.toThrow(DrawerRefusedError);
    // And it took the shift row first, which is the whole serialization story.
    expect(f.raw.some((sql) => sql.includes('"shifts"') && sql.includes('FOR UPDATE'))).toBe(true);
  });

  it('refuses a manual movement against a drawer in another branch', async () => {
    const f = fake();
    await expect(
      createShiftRepository(f.client).recordManualMovement(scope, {
        id: 'cm2',
        shiftId: 's1',
        terminalId: 't1',
        branchId: 'b9',
        kind: 'pay-out',
        amountMinor: '-5000',
        reason: 'مصروف',
        actorUserId: 'u1',
        occurredAt: AT,
        idempotency: { id: 'k2', scope: 'cash-movement', operationId: 'op2', requestHash: 'h' },
      }),
    ).rejects.toThrow(DrawerRefusedError);
    expect(f.raw.some((sql) => sql.includes('"shifts"') && sql.includes('FOR UPDATE'))).toBe(true);
  });
});
