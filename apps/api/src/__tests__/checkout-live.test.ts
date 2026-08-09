import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { basisPoints, newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  InsufficientStockError,
  ShiftOpenRefusedError,
  assignRole,
  createAuditRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createSaleRepository,
  createShiftRepository,
  createTenantRepository,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  withTenant,
} from '@korvi/database';
import { createCheckoutService } from '../checkout/service.js';
import type { CheckoutService } from '../checkout/service.js';
import type { PrismaClient } from '@korvi/database';
import type {
  AuthenticatedPrincipal,
  RecordSaleInput,
  SaleRepository,
  ShiftRepository,
  TenantScope,
} from '@korvi/domain';

/**
 * The checkout against a real PostgreSQL server.
 *
 * Three things only a live database can settle: that the whole sale commits or
 * none of it does, that two tills checking out at the same instant receive
 * different receipt numbers, and that a rolled-back attempt leaves nothing —
 * not a sale, not a movement, not a reserved operation id.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with every
 * migration applied, connected as the application role — not a superuser, which
 * bypasses RLS.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const T = {
  tenant: '018f3000-0000-7000-8000-00000000000a',
  slug: 'sale-live-a',
  branch: '018f3000-0000-7000-8000-0000000000a1',
  terminal: '018f3000-0000-7000-8000-0000000000a2',
  terminal2: '018f3000-0000-7000-8000-0000000000a7',
  shift: '018f3000-0000-7000-8000-0000000000a3',
  shift2: '018f3000-0000-7000-8000-0000000000a8',
  user: '018f3000-0000-7000-8000-0000000000a4',
  membership: '018f3000-0000-7000-8000-0000000000a5',
  milk: '018f3000-0000-7000-8000-0000000000a6',
} as const;

describe.skipIf(url === '')('cash checkout, live', () => {
  let prisma: PrismaClient;
  let service: CheckoutService;
  let principal: AuthenticatedPrincipal;

  const scope: TenantScope = { tenantId: brandTenantId(T.tenant) };

  async function remove(): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: T.tenant } });
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: T.tenant,
          name: 'متجر كورفي',
          slug: T.slug,
          vatNumber: '300000000000003',
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({ data: { tenantId: T.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: {
          id: T.branch,
          tenantId: T.tenant,
          code: '01',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: T.user,
          tenantId: T.tenant,
          email: 'sara@sale-live-a.test',
          displayName: 'سارة',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: T.membership, tenantId: T.tenant, userId: T.user, updatedAt: new Date() },
      });
      for (const [id, code] of [
        [T.terminal, '01'],
        [T.terminal2, '02'],
      ] as const) {
        await tx.terminal.create({
          data: {
            id,
            tenantId: T.tenant,
            branchId: T.branch,
            code,
            label: `صندوق ${code}`,
            updatedAt: new Date(),
          },
        });
      }
      for (const [id, terminal] of [
        [T.shift, T.terminal],
        [T.shift2, T.terminal2],
      ] as const) {
        await tx.shift.create({
          data: {
            id,
            tenantId: T.tenant,
            branchId: T.branch,
            terminalId: terminal,
            userId: T.user,
            openingFloatMinor: 20_000n,
            openedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }
      await tx.product.create({
        data: {
          id: T.milk,
          tenantId: T.tenant,
          sku: 'MILK-1L',
          nameAr: 'حليب طازج',
          priceMinor: 1150n,
          vatBasisPoints: 1500,
          updatedAt: new Date(),
        },
      });
      await tx.inventoryBalance.create({
        data: {
          tenantId: T.tenant,
          branchId: T.branch,
          productId: T.milk,
          quantityScaled: 1_000_000n,
          updatedAt: new Date(),
        },
      });
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, T.user, 'cashier');

    const products = createProductRepository(prisma);
    service = createCheckoutService({
      tenants: createTenantRepository(prisma),
      products,
      inventory: createInventoryRepository(prisma),
      shifts: createShiftRepository(prisma),
      sales: createSaleRepository(prisma),
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });

    principal = {
      tenantId: T.tenant,
      tenantSlug: T.slug,
      userId: T.user,
      sessionId: newId(),
      email: 'sara@sale-live-a.test',
      displayName: 'سارة',
      roles: ['cashier'],
      permissions: ['sale.create', 'product.read'],
      maxDiscountBasisPoints: 0n,
      branchId: T.branch,
    };
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  function checkout(terminalId: string, operationId: string, quantityScaled = '2000') {
    return service.checkout({
      principal,
      operationId,
      terminalId,
      cashReceivedMinor: '10000',
      lines: [{ productId: T.milk, quantityScaled }],
    });
  }

  it('persists a whole sale: lines, invoice, tender, stock and cash', async () => {
    const result = await checkout(T.terminal, newId());
    if (result.outcome !== 'success') throw new Error(result.reason);

    const rows = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sale: await tx.sale.findFirst({
        where: { id: result.sale.saleId },
        include: { lines: true, tenders: true, invoice: { include: { taxBreakdown: true } } },
      }),
      movements: await tx.inventoryMovement.count({ where: { sourceId: result.sale.saleId } }),
      cash: await tx.cashMovement.count({ where: { shiftId: T.shift, kind: 'sale' } }),
    }));

    expect(rows.sale?.lines).toHaveLength(1);
    expect(rows.sale?.tenders).toHaveLength(1);
    expect(rows.sale?.invoice?.taxBreakdown).toHaveLength(1);
    expect(rows.sale?.totalMinor).toBe(2300n);
    expect(rows.movements).toBe(1);
    expect(rows.cash).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('gives two simultaneous checkouts in one branch different receipt numbers', async () => {
    // The branch row lock is the whole point. Without it both transactions read
    // the same MAX(sequence) and one dies on the unique key.
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { tenantId: T.tenant, branchId: T.branch } }),
    );

    const [left, right] = await Promise.all([
      checkout(T.terminal, newId()),
      checkout(T.terminal2, newId()),
    ]);

    if (left.outcome !== 'success' || right.outcome !== 'success') {
      throw new Error('both concurrent checkouts must succeed');
    }
    expect(left.sale.sequence).not.toBe(right.sale.sequence);
    expect([left.sale.sequence, right.sale.sequence].sort((a, b) => a - b)).toEqual([
      before + 1,
      before + 2,
    ]);
    expect(left.sale.invoiceNumber).not.toBe(right.sale.invoiceNumber);

    const after = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { tenantId: T.tenant, branchId: T.branch } }),
    );
    expect(after).toBe(before + 2);
  }, 30_000);

  it('keeps numbering dense: a rolled-back attempt hands its number on', async () => {
    // The rollback releases the branch lock without inserting, so the number it
    // would have used is still the next one available. Documented in ADR-0013.
    const operation = newId();
    const doomed = service.checkout({
      principal,
      operationId: operation,
      terminalId: T.terminal,
      cashReceivedMinor: '10000',
      // A whole number of units, far beyond the seeded balance, so the stock
      // guard is what refuses it rather than the quantity check.
      lines: [{ productId: T.milk, quantityScaled: '999999999000' }],
    });
    const refused = await doomed;
    expect(refused.outcome === 'failure' && refused.reason).toBe('insufficient-stock');

    const nothing = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { operationId: operation } }),
      keys: await tx.idempotencyKey.count({ where: { operationId: operation } }),
    }));
    expect(nothing).toEqual({ sales: 0, keys: 0 });

    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.aggregate({
        where: { tenantId: T.tenant, branchId: T.branch },
        _max: { sequence: true },
      }),
    );
    const next = await checkout(T.terminal, newId());
    if (next.outcome !== 'success') throw new Error(next.reason);
    expect(next.sale.sequence).toBe((before._max.sequence ?? 0) + 1);
  }, 30_000);

  it('replays an operation id without writing a second sale', async () => {
    const operation = newId();
    const first = await checkout(T.terminal, operation);
    const second = await checkout(T.terminal, operation);
    if (first.outcome !== 'success' || second.outcome !== 'success')
      throw new Error('expected success');

    expect(second.replayed).toBe(true);
    expect(second.sale.saleId).toBe(first.sale.saleId);
    expect(second.sale.sequence).toBe(first.sale.sequence);

    const count = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { operationId: operation } }),
    );
    expect(count).toBe(1);
  }, 30_000);

  it('refuses the same operation id with a different basket', async () => {
    const operation = newId();
    await checkout(T.terminal, operation, '2000');
    const conflicting = await checkout(T.terminal, operation, '3000');
    expect(conflicting.outcome === 'failure' && conflicting.reason).toBe('idempotency-conflict');

    const count = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { operationId: operation } }),
    );
    expect(count).toBe(1);
  }, 30_000);

  it('cannot sell another tenant’s product', async () => {
    const foreign = { ...principal, tenantId: '018f3000-0000-7000-8000-00000000000f' };
    const result = await service.checkout({
      principal: foreign,
      operationId: newId(),
      terminalId: T.terminal,
      cashReceivedMinor: '10000',
      lines: [{ productId: T.milk, quantityScaled: '1000' }],
    });
    // The shift belongs to another tenant and is invisible under this scope.
    expect(result.outcome === 'failure' && result.reason).toBe('no-open-shift');
  }, 30_000);
});

/**
 * The races.
 *
 * Everything here is a question a single-threaded test cannot ask: whether the
 * last unit on the shelf can be sold twice, whether one operation id can
 * produce two sales, whether one till can have two open shifts, and whether a
 * transaction that dies after taking a receipt number leaves anything behind.
 *
 * Its own tenant, because each of these leaves stock, numbering or shifts in a
 * state the next would otherwise inherit.
 */
const C = {
  tenant: '018f4000-0000-7000-8000-00000000000a',
  slug: 'sale-race-a',
  branch: '018f4000-0000-7000-8000-0000000000b1',
  terminalA: '018f4000-0000-7000-8000-0000000000c1',
  terminalB: '018f4000-0000-7000-8000-0000000000c2',
  idleTerminal: '018f4000-0000-7000-8000-0000000000c3',
  shiftA: '018f4000-0000-7000-8000-0000000000d1',
  shiftB: '018f4000-0000-7000-8000-0000000000d2',
  user: '018f4000-0000-7000-8000-0000000000e1',
  membership: '018f4000-0000-7000-8000-0000000000e2',
} as const;

describe.skipIf(url === '')('checkout races, live', () => {
  let prisma: PrismaClient;
  let service: CheckoutService;
  let sales: SaleRepository;
  let shifts: ShiftRepository;
  let principal: AuthenticatedPrincipal;

  const scope: TenantScope = { tenantId: brandTenantId(C.tenant) };

  async function remove(): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: C.tenant } });
    });
  }

  /** A product with a known shelf quantity, so a test can ask for exactly one more. */
  async function seedProduct(id: string, sku: string, quantityScaled: bigint): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.create({
        data: {
          id,
          tenantId: C.tenant,
          sku,
          nameAr: 'صنف',
          priceMinor: 1150n,
          vatBasisPoints: 1500,
          updatedAt: new Date(),
        },
      });
      await tx.inventoryBalance.create({
        data: {
          tenantId: C.tenant,
          branchId: C.branch,
          productId: id,
          quantityScaled,
          updatedAt: new Date(),
        },
      });
    });
  }

  async function balanceOf(productId: string): Promise<bigint> {
    return withTenant(prisma, scope.tenantId, async (tx) => {
      const row = await tx.inventoryBalance.findFirst({
        where: { tenantId: C.tenant, branchId: C.branch, productId },
      });
      return row?.quantityScaled ?? 0n;
    });
  }

  async function movementsFor(productId: string): Promise<number> {
    return withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryMovement.count({ where: { tenantId: C.tenant, productId } }),
    );
  }

  async function salesFor(operationId: string): Promise<number> {
    return withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { tenantId: C.tenant, operationId } }),
    );
  }

  async function nextSequence(): Promise<number> {
    const row = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.aggregate({
        where: { tenantId: C.tenant, branchId: C.branch },
        _max: { sequence: true },
      }),
    );
    return (row._max.sequence ?? 0) + 1;
  }

  async function setOverselling(allowed: boolean): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenantSettings.update({
        where: { tenantId: C.tenant },
        data: { allowNegativeStock: allowed, updatedAt: new Date() },
      });
    });
  }

  function checkout(
    terminalId: string,
    operationId: string,
    productId: string,
    quantityScaled = '1000',
  ) {
    return service.checkout({
      principal,
      operationId,
      terminalId,
      cashReceivedMinor: '10000',
      lines: [{ productId, quantityScaled }],
    });
  }

  /**
   * A minimal reconciling sale, assembled by hand.
   *
   * Some of these questions are about the repository's transaction and not
   * about the service in front of it — whether the stock guard lives in the
   * UPDATE rather than in a prior read, and what survives a failure after the
   * receipt number has been taken. Going straight at `record()` asks exactly
   * that, with no pre-flight check standing in the way.
   */
  function recordInput(args: {
    saleId: string;
    productId: string;
    operationId: string;
    quantityScaled: string;
  }): RecordSaleInput {
    const issuedAt = new Date().toISOString();
    return {
      sale: {
        id: args.saleId,
        branchId: C.branch,
        terminalId: C.terminalA,
        shiftId: C.shiftA,
        userId: C.user,
        customerId: null,
        operationId: args.operationId,
        status: 'finalized',
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
        issuedAt,
        lines: [
          {
            id: newId(),
            lineNumber: 1,
            productId: args.productId,
            sku: 'RACE-1',
            nameAr: 'صنف',
            nameEn: null,
            unitPriceMinor: '1150',
            vatBasisPoints: basisPoints(1500),
            quantityScaled: args.quantityScaled,
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
          {
            id: newId(),
            kind: 'cash',
            scheme: null,
            amountMinor: '1150',
            changeMinor: '0',
            reference: null,
          },
        ],
      },
      invoice: {
        id: newId(),
        saleId: args.saleId,
        invoiceType: 'simplified',
        sellerName: 'متجر كورفي',
        sellerVatNumber: '300000000000003',
        buyerName: null,
        buyerVatNumber: null,
        netMinor: '1000',
        vatMinor: '150',
        totalMinor: '1150',
        currency: 'SAR',
        issuedAt,
        taxBreakdown: [{ vatBasisPoints: basisPoints(1500), netMinor: '1000', vatMinor: '150' }],
      },
      inventory: [
        {
          id: newId(),
          branchId: C.branch,
          productId: args.productId,
          kind: 'sale',
          quantityScaled: `-${args.quantityScaled}`,
          reason: null,
          sourceType: 'sale',
          sourceId: args.saleId,
          actorUserId: C.user,
          occurredAt: issuedAt,
        },
      ],
      cashMovement: {
        id: newId(),
        shiftId: C.shiftA,
        kind: 'sale',
        amountMinor: '1150',
        reason: null,
        actorUserId: C.user,
        occurredAt: issuedAt,
      },
      idempotency: {
        id: newId(),
        scope: 'checkout',
        operationId: args.operationId,
        requestHash: null,
      },
    };
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: C.tenant,
          name: 'متجر كورفي',
          slug: C.slug,
          vatNumber: '300000000000003',
          updatedAt: new Date(),
        },
      });
      // allowNegativeStock defaults to false: the merchant's shelf is the limit
      // until they say otherwise.
      await tx.tenantSettings.create({ data: { tenantId: C.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: {
          id: C.branch,
          tenantId: C.tenant,
          code: '09',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: C.user,
          tenantId: C.tenant,
          email: 'sara@sale-race-a.test',
          displayName: 'سارة',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: C.membership, tenantId: C.tenant, userId: C.user, updatedAt: new Date() },
      });
      for (const [id, code] of [
        [C.terminalA, '01'],
        [C.terminalB, '02'],
        [C.idleTerminal, '03'],
      ] as const) {
        await tx.terminal.create({
          data: {
            id,
            tenantId: C.tenant,
            branchId: C.branch,
            code,
            label: `صندوق ${code}`,
            updatedAt: new Date(),
          },
        });
      }
      // Two tills open, one deliberately left closed for the shift-open race.
      for (const [id, terminal] of [
        [C.shiftA, C.terminalA],
        [C.shiftB, C.terminalB],
      ] as const) {
        await tx.shift.create({
          data: {
            id,
            tenantId: C.tenant,
            branchId: C.branch,
            terminalId: terminal,
            userId: C.user,
            openingFloatMinor: 20_000n,
            openedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, C.user, 'cashier');

    sales = createSaleRepository(prisma);
    shifts = createShiftRepository(prisma);
    service = createCheckoutService({
      tenants: createTenantRepository(prisma),
      products: createProductRepository(prisma),
      inventory: createInventoryRepository(prisma),
      shifts,
      sales,
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });

    principal = {
      tenantId: C.tenant,
      tenantSlug: C.slug,
      userId: C.user,
      sessionId: newId(),
      email: 'sara@sale-race-a.test',
      displayName: 'سارة',
      roles: ['cashier'],
      permissions: ['sale.create', 'product.read'],
      maxDiscountBasisPoints: 0n,
      branchId: C.branch,
    };
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  it('sells the last unit to exactly one of two simultaneous checkouts', async () => {
    const product = '018f4000-0000-7000-8000-0000000000f1';
    await seedProduct(product, 'LAST-1', 1_000n);

    // Two tills, two shifts, one unit between them. Both read a stock of one
    // before either commits, which is precisely why the read cannot be the
    // guard.
    const results = await Promise.all([
      checkout(C.terminalA, newId(), product),
      checkout(C.terminalB, newId(), product),
    ]);

    const won = results.filter((result) => result.outcome === 'success');
    const lost = results.filter((result) => result.outcome === 'failure');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.outcome === 'failure' && lost[0].reason).toBe('insufficient-stock');

    // One sale, one movement, and a shelf at zero rather than below it.
    expect(await movementsFor(product)).toBe(1);
    expect(await balanceOf(product)).toBe(0n);
    const sold = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.saleLine.count({ where: { tenantId: C.tenant, productId: product } }),
    );
    expect(sold).toBe(1);
  }, 60_000);

  it('refuses the oversell in the UPDATE itself, and rolls the sale back with it', async () => {
    // Straight at the repository, so nothing checks stock before the mutation
    // does. This is the case the concurrent test can only reach by luck.
    const product = '018f4000-0000-7000-8000-0000000000f2';
    await seedProduct(product, 'NONE-1', 0n);

    const saleId = newId();
    const operationId = newId();
    await expect(
      sales.record(
        scope,
        recordInput({ saleId, productId: product, operationId, quantityScaled: '1000' }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    const left = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { tenantId: C.tenant, id: saleId } }),
      keys: await tx.idempotencyKey.count({ where: { tenantId: C.tenant, operationId } }),
      movements: await tx.inventoryMovement.count({
        where: { tenantId: C.tenant, productId: product },
      }),
    }));
    expect(left).toEqual({ sales: 0, keys: 0, movements: 0 });
    expect(await balanceOf(product)).toBe(0n);
  }, 60_000);

  it('lets a merchant who allows overselling sell what is not on the shelf', async () => {
    // The negative control for the guard: with the policy turned on, the same
    // movement is written and the balance goes below zero.
    const product = '018f4000-0000-7000-8000-0000000000f3';
    await seedProduct(product, 'NEG-1', 1_000n);
    await setOverselling(true);
    try {
      const results = await Promise.all([
        checkout(C.terminalA, newId(), product),
        checkout(C.terminalB, newId(), product),
      ]);
      expect(results.every((result) => result.outcome === 'success')).toBe(true);
      expect(await movementsFor(product)).toBe(2);
      expect(await balanceOf(product)).toBe(-1_000n);
    } finally {
      await setOverselling(false);
    }
  }, 60_000);

  it('answers two simultaneous identical requests with one sale', async () => {
    const product = '018f4000-0000-7000-8000-0000000000f4';
    await seedProduct(product, 'IDEM-1', 10_000n);
    const operationId = newId();

    const [left, right] = await Promise.all([
      checkout(C.terminalA, operationId, product),
      checkout(C.terminalA, operationId, product),
    ]);

    // Both callers get an answer, and it is the same answer. The loser did not
    // fail — it read what the winner committed, because ON CONFLICT DO NOTHING
    // waited for that transaction before returning nothing.
    if (left.outcome !== 'success' || right.outcome !== 'success') {
      throw new Error('both callers must receive the sale');
    }
    expect(left.sale.saleId).toBe(right.sale.saleId);
    expect(left.sale.sequence).toBe(right.sale.sequence);
    expect(left.sale.invoiceNumber).toBe(right.sale.invoiceNumber);
    // Exactly one of them actually wrote it.
    expect([left.replayed, right.replayed].filter(Boolean)).toHaveLength(1);

    expect(await salesFor(operationId)).toBe(1);
    // Stock left the shelf once, not twice.
    expect(await movementsFor(product)).toBe(1);
    expect(await balanceOf(product)).toBe(9_000n);
  }, 60_000);

  it('refuses the second of two simultaneous requests that disagree about the basket', async () => {
    const product = '018f4000-0000-7000-8000-0000000000f5';
    await seedProduct(product, 'IDEM-2', 10_000n);
    const operationId = newId();

    const settled = await Promise.allSettled([
      checkout(C.terminalA, operationId, product, '1000'),
      checkout(C.terminalA, operationId, product, '2000'),
    ]);

    // Neither call may throw: a unique-constraint violation is an internal
    // detail, and the route above this maps a reason, not an exception.
    expect(settled.every((entry) => entry.status === 'fulfilled')).toBe(true);
    const results = settled.map((entry) =>
      entry.status === 'fulfilled' ? entry.value : { outcome: 'failure' as const, reason: 'threw' },
    );
    const won = results.filter((result) => result.outcome === 'success');
    const lost = results.filter((result) => result.outcome === 'failure');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.outcome === 'failure' && lost[0].reason).toBe('idempotency-conflict');

    expect(await salesFor(operationId)).toBe(1);
    expect(await movementsFor(product)).toBe(1);
  }, 60_000);

  it('opens exactly one shift when two cashiers press the button together', async () => {
    const [left, right] = await Promise.allSettled([
      shifts.open(scope, {
        id: newId(),
        branchId: C.branch,
        terminalId: C.idleTerminal,
        userId: C.user,
        openingFloatMinor: '20000',
        openedAt: new Date().toISOString(),
        openingMovementId: newId(),
      }),
      shifts.open(scope, {
        id: newId(),
        branchId: C.branch,
        terminalId: C.idleTerminal,
        userId: C.user,
        openingFloatMinor: '20000',
        openedAt: new Date().toISOString(),
        openingMovementId: newId(),
      }),
    ]);

    const outcomes = [left, right];
    expect(outcomes.filter((entry) => entry?.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((entry) => entry?.status === 'rejected');
    if (refused === undefined || refused.status !== 'rejected') {
      throw new Error('one of the two opens must be refused');
    }
    // A defined refusal, not a raw constraint violation: there is no unique
    // index that could produce one, because a terminal legitimately has many
    // shifts over time.
    expect(refused.reason).toBeInstanceOf(ShiftOpenRefusedError);
    expect((refused.reason as ShiftOpenRefusedError).detail).toBe('already-open');

    const state = await withTenant(prisma, scope.tenantId, async (tx) => ({
      open: await tx.shift.count({
        where: { tenantId: C.tenant, terminalId: C.idleTerminal, status: 'open' },
      }),
      total: await tx.shift.count({ where: { tenantId: C.tenant, terminalId: C.idleTerminal } }),
      floats: await tx.cashMovement.count({
        where: { tenantId: C.tenant, kind: 'opening-float', shift: { terminalId: C.idleTerminal } },
      }),
    }));
    expect(state).toEqual({ open: 1, total: 1, floats: 1 });
  }, 60_000);

  it('leaves nothing behind when a sale dies after its number was taken', async () => {
    // A sale line pointing at a product that does not exist. The insert passes
    // Prisma and fails the foreign key in PostgreSQL — after allocateReceipt
    // has already taken the branch lock and the next number, and after the
    // operation id has already been reserved. Everything must go back.
    const ghost = '018f4000-0000-7000-8000-0000000000ff';
    const saleId = newId();
    const operationId = newId();
    const expected = await nextSequence();
    // Earlier tests in this file have already put sale movements in this
    // drawer, so the question is whether the count changes, not what it is.
    const cashBefore = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { tenantId: C.tenant, shiftId: C.shiftA, kind: 'sale' } }),
    );

    await expect(
      sales.record(
        scope,
        recordInput({ saleId, productId: ghost, operationId, quantityScaled: '1000' }),
      ),
    ).rejects.toThrow();

    const survivors = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { tenantId: C.tenant, id: saleId } }),
      lines: await tx.saleLine.count({ where: { tenantId: C.tenant, saleId } }),
      invoices: await tx.invoice.count({ where: { tenantId: C.tenant, saleId } }),
      tenders: await tx.tender.count({ where: { tenantId: C.tenant, saleId } }),
      movements: await tx.inventoryMovement.count({
        where: { tenantId: C.tenant, sourceId: saleId },
      }),
      cash: await tx.cashMovement.count({
        where: { tenantId: C.tenant, shiftId: C.shiftA, kind: 'sale' },
      }),
      keys: await tx.idempotencyKey.count({ where: { tenantId: C.tenant, operationId } }),
    }));
    expect(survivors).toEqual({
      sales: 0,
      lines: 0,
      invoices: 0,
      tenders: 0,
      movements: 0,
      cash: cashBefore,
      keys: 0,
    });

    // And the number it would have used is still the next one available: the
    // rollback released the branch lock without inserting, so the series has
    // no gap.
    const product = '018f4000-0000-7000-8000-0000000000f6';
    await seedProduct(product, 'GAP-1', 10_000n);
    const next = await checkout(C.terminalA, newId(), product);
    if (next.outcome !== 'success') throw new Error(next.reason);
    expect(next.sale.sequence).toBe(expected);
  }, 60_000);
});

describe.skipIf(url !== '')('cash checkout, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
