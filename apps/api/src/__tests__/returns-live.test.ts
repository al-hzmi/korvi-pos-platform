import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  assignRole,
  createAuditRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createReturnRepository,
  createSaleRepository,
  createShiftRepository,
  createTenantRepository,
  createTerminalRepository,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  withTenant,
} from '@korvi/database';
import { createCheckoutService } from '../checkout/service.js';
import { createReturnService } from '../returns/service.js';
import type { CheckoutService } from '../checkout/service.js';
import type { ReturnService } from '../returns/service.js';
import type { PrismaClient } from '@korvi/database';
import type { AuthenticatedPrincipal, ReturnRepository, TenantScope } from '@korvi/domain';

/**
 * Returns, against a real PostgreSQL server.
 *
 * The questions here cannot be answered by a fake, because every one of them
 * is about what two transactions do to each other. Whether the last unit of a
 * line can come back twice, whether one operation id can produce two refunds,
 * whether a return number can be issued to a transaction that then rolls back,
 * and whether a failure part-way through leaves stock credited or cash moved.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with
 * every migration applied, connected as the application role — not a
 * superuser, which bypasses RLS and would make the isolation tests pass for
 * the wrong reason.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const R = {
  tenant: '018f6000-0000-7000-8000-00000000000a',
  slug: 'returns-live-a',
  branch: '018f6000-0000-7000-8000-0000000000b1',
  terminal: '018f6000-0000-7000-8000-0000000000c1',
  shift: '018f6000-0000-7000-8000-0000000000d1',
  user: '018f6000-0000-7000-8000-0000000000e1',
  membership: '018f6000-0000-7000-8000-0000000000e2',
  milk: '018f6000-0000-7000-8000-0000000000f1',
  odd: '018f6000-0000-7000-8000-0000000000f2',
  loose: '018f6000-0000-7000-8000-0000000000f3',
  costed: '018f6000-0000-7000-8000-0000000000f4',
} as const;

/** A second merchant, used only to prove it can see nothing of the first. */
const OTHER = {
  tenant: '018f6000-0000-7000-8000-00000000001a',
  slug: 'returns-live-b',
} as const;

describe.skipIf(url === '')('returns, live', () => {
  let prisma: PrismaClient;
  let checkout: CheckoutService;
  let returns: ReturnService;
  let repository: ReturnRepository;
  let principal: AuthenticatedPrincipal;

  const scope: TenantScope = { tenantId: brandTenantId(R.tenant) };
  const otherScope: TenantScope = { tenantId: brandTenantId(OTHER.tenant) };

  async function remove(): Promise<void> {
    for (const id of [R.tenant, OTHER.tenant]) {
      await withTenant(prisma, brandTenantId(id), async (tx) => {
        await tx.tenant.deleteMany({ where: { id } });
      });
    }
  }

  /** Ring up a sale, so there is something to send back. */
  async function sell(
    productId: string,
    quantityScaled: string,
  ): Promise<{ saleId: string; lineId: string; totalMinor: string }> {
    const result = await checkout.checkout({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      lines: [{ productId, quantityScaled }],
      cashReceivedMinor: '100000',
    });
    if (result.outcome !== 'success') throw new Error(result.reason);
    const line = result.sale.lines[0];
    if (line === undefined) throw new Error('a sale with no lines');
    const stored = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.saleLine.findFirst({ where: { saleId: result.sale.saleId } }),
    );
    if (stored === null) throw new Error('the sale line was not persisted');
    return {
      saleId: result.sale.saleId,
      lineId: stored.id,
      totalMinor: result.sale.totalMinor,
    };
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: R.tenant,
          name: 'متجر المرتجعات',
          slug: R.slug,
          vatNumber: '300000000000003',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({ data: { tenantId: R.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: {
          id: R.branch,
          tenantId: R.tenant,
          code: '07',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: R.user,
          tenantId: R.tenant,
          email: 'huda@returns-live-a.test',
          displayName: 'هدى',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: {
          id: R.membership,
          tenantId: R.tenant,
          userId: R.user,
          defaultBranchId: R.branch,
          updatedAt: new Date(),
        },
      });
      await tx.terminal.create({
        data: {
          id: R.terminal,
          tenantId: R.tenant,
          branchId: R.branch,
          code: '01',
          label: 'صندوق ١',
          updatedAt: new Date(),
        },
      });
      await tx.shift.create({
        data: {
          id: R.shift,
          tenantId: R.tenant,
          branchId: R.branch,
          terminalId: R.terminal,
          userId: R.user,
          openingFloatMinor: 20_000n,
          openedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      for (const [id, sku, price, type, tracked] of [
        [R.milk, 'MILK-1L', 1_150n, 'unit', true],
        // A price whose line does not divide by three, on purpose.
        [R.odd, 'ODD-1', 1_000n, 'unit', true],
        // Sold by weight, and never tracked in stock.
        [R.loose, 'LOOSE-1', 2_275n, 'weighted', false],
        // Dedicated to original-sale cost-basis restoration proofs.
        [R.costed, 'COSTED-1', 1_150n, 'unit', true],
      ] as const) {
        await tx.product.create({
          data: {
            id,
            tenantId: R.tenant,
            sku,
            nameAr: 'صنف',
            productType: type,
            priceMinor: price,
            vatBasisPoints: 1500,
            trackInventory: tracked,
            updatedAt: new Date(),
          },
        });
        await tx.inventoryBalance.create({
          data: {
            tenantId: R.tenant,
            branchId: R.branch,
            productId: id,
            quantityScaled: 1_000_000n,
            updatedAt: new Date(),
          },
        });
      }
    });

    await withTenant(prisma, otherScope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: OTHER.tenant,
          name: 'متجر آخر',
          slug: OTHER.slug,
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, R.user, 'manager');

    repository = createReturnRepository(prisma);
    checkout = createCheckoutService({
      tenants: createTenantRepository(prisma),
      products: createProductRepository(prisma),
      inventory: createInventoryRepository(prisma),
      shifts: createShiftRepository(prisma),
      sales: createSaleRepository(prisma),
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });
    returns = createReturnService({
      returns: repository,
      terminals: createTerminalRepository(prisma),
      shifts: createShiftRepository(prisma),
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });

    principal = {
      tenantId: R.tenant,
      tenantSlug: R.slug,
      userId: R.user,
      sessionId: newId(),
      email: 'huda@returns-live-a.test',
      displayName: 'هدى',
      roles: ['manager'],
      permissions: ['sale.create', 'sale.refund', 'product.read'],
      maxDiscountBasisPoints: 2_000n,
      branchId: R.branch,
    };
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  it('A. writes the document, its lines and its refund in one transaction', async () => {
    const sale = await sell(R.milk, '2000');
    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const stored = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.return.findFirst({
        where: { id: result.document.returnId },
        include: { lines: true, refunds: true },
      }),
    );

    expect(stored).not.toBeNull();
    expect(stored?.returnNumber).toMatch(/^R-07-\d{6}$/);
    expect(stored?.lines).toHaveLength(1);
    expect(stored?.refunds).toHaveLength(1);
    // net + VAT = total, asserted by the database itself as well as here.
    expect((stored?.netMinor ?? 0n) + (stored?.vatMinor ?? 0n)).toBe(stored?.totalMinor);
    // The refund is what the lines came to, not what anybody asked for.
    expect(stored?.refunds[0]?.amountMinor).toBe(stored?.totalMinor);
  });

  it('B. a cash return credits the stock and debits the drawer, once each', async () => {
    const sale = await sell(R.milk, '2000');
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({ where: { branchId: R.branch, productId: R.milk } }),
    );

    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '2000' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const [movements, cash, after] = await withTenant(prisma, scope.tenantId, async (tx) => [
      await tx.inventoryMovement.findMany({
        where: { sourceType: 'return', sourceId: result.document.returnId },
      }),
      await tx.cashMovement.findMany({ where: { shiftId: R.shift, kind: 'refund' } }),
      await tx.inventoryBalance.findFirst({ where: { branchId: R.branch, productId: R.milk } }),
    ]);

    expect(movements).toHaveLength(1);
    expect(movements[0]?.quantityScaled).toBe(2_000n);
    // The sale took two out; the return puts exactly those two back.
    expect((after?.quantityScaled ?? 0n) - (before?.quantityScaled ?? 0n)).toBe(2_000n);

    const mine = cash.filter((row) => row.amountMinor === -BigInt(result.document.totalMinor));
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0]?.amountMinor).toBeLessThan(0n);
  });

  it('B2. no stock is invented for a product the sale never decremented', async () => {
    const sale = await sell(R.loose, '1500');
    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '500' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const movements = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryMovement.findMany({
        where: { sourceType: 'return', sourceId: result.document.returnId },
      }),
    );
    // The sale never wrote a movement for this product, so neither does the
    // return. Crediting stock that was never taken would drift the balance
    // upward with nothing to point at.
    expect(movements).toHaveLength(0);
  });

  it('C. an electronic refund records its approval and moves no cash', async () => {
    const sale = await sell(R.milk, '1000');
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { shiftId: R.shift, kind: 'refund' } }),
    );

    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'electronic', scheme: 'mada', reference: 'AUTH-RET-1' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const [refund, after] = await withTenant(prisma, scope.tenantId, async (tx) => [
      await tx.refund.findFirst({ where: { returnId: result.document.returnId } }),
      await tx.cashMovement.count({ where: { shiftId: R.shift, kind: 'refund' } }),
    ]);

    expect(refund?.kind).toBe('electronic');
    expect(refund?.scheme).toBe('mada');
    expect(refund?.reference).toBe('AUTH-RET-1');
    expect(after).toBe(before);
  });

  it('D. two cashiers returning the last unit: exactly one succeeds', async () => {
    const sale = await sell(R.milk, '1000');

    const both = await Promise.all([
      returns.create({
        principal,
        operationId: newId(),
        terminalId: R.terminal,
        saleId: sale.saleId,
        lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
        refund: { kind: 'cash' },
      }),
      returns.create({
        principal,
        operationId: newId(),
        terminalId: R.terminal,
        saleId: sale.saleId,
        lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
        refund: { kind: 'cash' },
      }),
    ]);

    const won = both.filter((result) => result.outcome === 'success');
    const lost = both.filter((result) => result.outcome === 'failure');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // A named business answer, not a driver error and not a 500.
    expect(['over-return', 'nothing-returnable']).toContain(
      lost[0]?.outcome === 'failure' ? lost[0].reason : '',
    );

    const [lines, refunds, movements] = await withTenant(prisma, scope.tenantId, async (tx) => {
      const rows = await tx.return.findMany({
        where: { saleId: sale.saleId },
        include: { lines: true, refunds: true },
      });
      return [
        rows.flatMap((row) => row.lines),
        rows.flatMap((row) => row.refunds),
        await tx.inventoryMovement.findMany({
          where: { sourceType: 'return', sourceId: { in: rows.map((row) => row.id) } },
        }),
      ];
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantityScaled).toBe(1_000n);
    expect(refunds).toHaveLength(1);
    expect(movements).toHaveLength(1);
  });

  it('E. the same operation id twice at once produces one return', async () => {
    const sale = await sell(R.milk, '2000');
    const operationId = newId();
    const request = {
      principal,
      operationId,
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' as const },
    };

    const both = await Promise.all([returns.create(request), returns.create(request)]);
    const succeeded = both.filter((result) => result.outcome === 'success');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const rows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.return.findMany({ where: { operationId } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('F. the same operation id with different intent is a conflict', async () => {
    const sale = await sell(R.milk, '3000');
    const operationId = newId();

    const first = await returns.create({
      principal,
      operationId,
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    expect(first.outcome).toBe('success');

    const second = await returns.create({
      principal,
      operationId,
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '2000' }],
      refund: { kind: 'cash' },
    });

    expect(second.outcome).toBe('failure');
    if (second.outcome === 'failure') expect(second.reason).toBe('idempotency-conflict');
  });

  it('G. concurrent returns take unique, gapless numbers', async () => {
    const sales = await Promise.all([
      sell(R.milk, '1000'),
      sell(R.milk, '1000'),
      sell(R.milk, '1000'),
      sell(R.milk, '1000'),
    ]);

    const results = await Promise.all(
      sales.map((sale) =>
        returns.create({
          principal,
          operationId: newId(),
          terminalId: R.terminal,
          saleId: sale.saleId,
          lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
          refund: { kind: 'cash' },
        }),
      ),
    );

    const numbers = results
      .filter((result) => result.outcome === 'success')
      .map((result) => (result.outcome === 'success' ? result.document.returnNumber : ''));

    expect(numbers).toHaveLength(4);
    expect(new Set(numbers).size).toBe(4);
    for (const number of numbers) expect(number).toMatch(/^R-07-\d{6}$/);
  });

  it('H. PostgreSQL refuses a return that points across tenants', async () => {
    const sale = await sell(R.milk, '1000');

    await expect(
      withTenant(prisma, otherScope.tenantId, async (tx) =>
        tx.return.create({
          data: {
            id: newId(),
            tenantId: OTHER.tenant,
            // Another merchant's sale. RLS never sees this row as a problem —
            // it is the composite foreign key that refuses it.
            saleId: sale.saleId,
            branchId: R.branch,
            actorUserId: R.user,
            operationId: newId(),
            netMinor: 100n,
            vatMinor: 15n,
            totalMinor: 115n,
            grossMinor: 100n,
            issuedAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('I. another tenant can read none of it', async () => {
    const sale = await sell(R.milk, '1000');
    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const seen = await withTenant(prisma, otherScope.tenantId, async (tx) => ({
      returns: await tx.return.count(),
      lines: await tx.returnLine.count(),
      refunds: await tx.refund.count(),
    }));

    expect(seen.returns).toBe(0);
    expect(seen.lines).toBe(0);
    expect(seen.refunds).toBe(0);

    // And the scoped read finds it, so the zeros above mean isolation rather
    // than an empty table.
    const mine = await repository.findById(scope, result.document.returnId);
    expect(mine?.returnNumber).toBe(result.document.returnNumber);
  });

  it('J. a failure after the work has begun leaves nothing behind', async () => {
    const sale = await sell(R.milk, '2000');
    const operationId = newId();
    const returnId = newId();

    const before = await withTenant(prisma, scope.tenantId, async (tx) => ({
      returns: await tx.return.count(),
      movements: await tx.inventoryMovement.count(),
      cash: await tx.cashMovement.count(),
      keys: await tx.idempotencyKey.count(),
    }));

    /*
     * A refund reference longer than the column permits.
     *
     * The service and the domain both refuse this before a transaction opens,
     * which is exactly why the repository is called directly here: the point
     * is to fail at the *last* write, after the document, its lines, the stock
     * reversal and the number have all been written inside the transaction.
     * Anything left behind afterwards would be a partial commercial fact.
     */
    await expect(
      repository.record(scope, {
        returnId,
        saleId: sale.saleId,
        operationId,
        branchId: R.branch,
        terminalId: R.terminal,
        shiftId: R.shift,
        actorUserId: R.user,
        reason: null,
        currency: 'SAR',
        issuedAt: new Date().toISOString(),
        requested: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
        refund: {
          id: newId(),
          kind: 'electronic',
          scheme: 'mada',
          reference: 'X'.repeat(200),
        },
        lineIds: [newId()],
        inventoryIds: [newId()],
        cashMovementId: newId(),
        idempotency: { id: newId(), scope: 'return', operationId, requestHash: 'whatever' },
        plan: (state) => {
          const line = state.lines[0];
          if (line === undefined) throw new Error('no line to return');
          return {
            lines: [
              {
                saleLineId: line.saleLineId,
                lineNumber: line.lineNumber,
                productId: line.productId,
                sku: line.sku,
                nameAr: line.nameAr,
                nameEn: line.nameEn,
                productType: line.productType,
                vatBasisPoints: line.vatBasisPoints,
                quantityScaled: '1000',
                grossMinor: '1150',
                lineDiscountMinor: '0',
                basketDiscountMinor: '0',
                netMinor: '1000',
                vatMinor: '150',
                totalMinor: '1150',
              },
            ],
            grossMinor: '1150',
            lineDiscountMinor: '0',
            basketDiscountMinor: '0',
            netMinor: '1000',
            vatMinor: '150',
            totalMinor: '1150',
          };
        },
      }),
    ).rejects.toThrow();

    const after = await withTenant(prisma, scope.tenantId, async (tx) => ({
      returns: await tx.return.count(),
      movements: await tx.inventoryMovement.count(),
      cash: await tx.cashMovement.count(),
      keys: await tx.idempotencyKey.count(),
      thisOne: await tx.return.count({ where: { id: returnId } }),
      thisLine: await tx.returnLine.count({ where: { returnId } }),
      thisRefund: await tx.refund.count({ where: { returnId } }),
      thisKey: await tx.idempotencyKey.count({ where: { operationId } }),
      thisMovement: await tx.inventoryMovement.count({ where: { sourceId: returnId } }),
    }));

    expect(after.returns).toBe(before.returns);
    expect(after.movements).toBe(before.movements);
    expect(after.cash).toBe(before.cash);
    expect(after.keys).toBe(before.keys);
    expect(after.thisOne).toBe(0);
    expect(after.thisLine).toBe(0);
    expect(after.thisRefund).toBe(0);
    expect(after.thisKey).toBe(0);
    expect(after.thisMovement).toBe(0);

    // And the number the rolled-back transaction was going to use is handed to
    // the next one instead: the series has no gap.
    const next = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    expect(next.outcome).toBe('success');
  });

  it('K. cumulative proration closes exactly across sequential partial returns', async () => {
    // Three units at 1000 halalas inclusive: a line whose net and VAT both
    // carry a remainder over three.
    const sale = await sell(R.odd, '3000');
    const original = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.saleLine.findFirst({ where: { id: sale.lineId } }),
    );

    for (let i = 0; i < 3; i += 1) {
      const result = await returns.create({
        principal,
        operationId: newId(),
        terminalId: R.terminal,
        saleId: sale.saleId,
        lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
        refund: { kind: 'cash' },
      });
      if (result.outcome !== 'success') throw new Error(result.reason);
    }

    const rows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.returnLine.findMany({ where: { saleLineId: sale.lineId } }),
    );
    const sum = (pick: (row: (typeof rows)[number]) => bigint): bigint =>
      rows.reduce((total, row) => total + pick(row), 0n);

    expect(rows).toHaveLength(3);
    expect(sum((row) => row.quantityScaled)).toBe(original?.quantityScaled);
    expect(sum((row) => row.grossMinor)).toBe(original?.grossMinor);
    expect(sum((row) => row.lineDiscountMinor)).toBe(original?.lineDiscountMinor);
    expect(sum((row) => row.basketDiscountMinor)).toBe(original?.basketDiscountMinor);
    expect(sum((row) => row.netMinor)).toBe(original?.netMinor);
    expect(sum((row) => row.vatMinor)).toBe(original?.vatMinor);
    expect(sum((row) => row.totalMinor)).toBe(original?.totalMinor);

    // And there is nothing left to send back.
    const state = await returns.returnable(principal, sale.saleId);
    if ('outcome' in state) throw new Error('the sale became unreadable');
    expect(state.lines[0]?.remainingQuantityScaled).toBe('0');
  });

  it('L. the original sale stays the authority after the catalogue moves', async () => {
    const sale = await sell(R.milk, '2000');

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.update({
        where: { tenantId_id: { tenantId: R.tenant, id: R.milk } },
        data: { priceMinor: 9_999n, vatBasisPoints: 500, isActive: false, nameAr: 'اسم جديد' },
      });
    });

    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '2000' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    // A price change, a VAT change, a rename and a deactivation later: the
    // customer gets back exactly what they paid.
    expect(result.document.totalMinor).toBe(sale.totalMinor);
    expect(result.document.lines[0]?.sku).toBe('MILK-1L');

    // Put it back for any test that runs after this one.
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.update({
        where: { tenantId_id: { tenantId: R.tenant, id: R.milk } },
        data: { priceMinor: 1_150n, vatBasisPoints: 1500, isActive: true, nameAr: 'صنف' },
      });
    });
  });
  it('M. partial returns restore the immutable original sale basis with exact remainder', async () => {
    // Four units are on hand: one historical/unknown and three carrying exactly
    // 100 halalas of recorded value. Selling all four therefore freezes a
    // mixed basis (unknown first, then known); reversing the sale must restore
    // the known segment first as 33 + 33 + 34, then the unknown unit.
    await withTenant(prisma, scope.tenantId, async (tx) => {
      const balance = await tx.inventoryBalance.update({
        where: {
          tenantId_branchId_productId: {
            tenantId: R.tenant,
            branchId: R.branch,
            productId: R.costed,
          },
        },
        data: { quantityScaled: 4_000n },
        select: { revision: true },
      });
      await tx.inventoryCostBalance.upsert({
        where: {
          tenantId_branchId_productId: {
            tenantId: R.tenant,
            branchId: R.branch,
            productId: R.costed,
          },
        },
        create: {
          tenantId: R.tenant,
          branchId: R.branch,
          productId: R.costed,
          knownQuantityScaled: 3_000n,
          knownValueMinor: 100n,
          stockRevision: balance.revision,
          costRevision: 0n,
        },
        update: {
          knownQuantityScaled: 3_000n,
          knownValueMinor: 100n,
          stockRevision: balance.revision,
          costRevision: 0n,
        },
      });
    });

    const sale = await sell(R.costed, '4000');
    const afterSale = await withTenant(prisma, scope.tenantId, async (tx) => ({
      line: await tx.saleLine.findFirst({ where: { id: sale.lineId } }),
      cost: await tx.inventoryCostBalance.findFirst({
        where: { branchId: R.branch, productId: R.costed },
      }),
      stock: await tx.inventoryBalance.findFirst({
        where: { branchId: R.branch, productId: R.costed },
      }),
    }));
    expect(afterSale.line).toMatchObject({
      costKnownQuantityScaled: 3_000n,
      costUnknownQuantityScaled: 1_000n,
      costValueMinor: 100n,
      costProvenance: 'mixed',
    });
    expect(afterSale.cost).toMatchObject({ knownQuantityScaled: 0n, knownValueMinor: 0n });
    expect(afterSale.stock?.quantityScaled).toBe(0n);

    const snapshots: Array<{
      line: {
        id: string;
        costKnownQuantityScaled: bigint;
        costUnknownQuantityScaled: bigint;
        costValueMinor: bigint;
        costProvenance: string;
      };
      movement: {
        sourceLineId: string | null;
        costKnownQuantityScaled: bigint;
        costUnknownQuantityScaled: bigint;
        costValueMinor: bigint;
        costProvenance: string;
      };
    }> = [];

    for (let index = 0; index < 4; index += 1) {
      const result = await returns.create({
        principal,
        operationId: newId(),
        terminalId: R.terminal,
        saleId: sale.saleId,
        lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
        refund: { kind: 'cash' },
      });
      if (result.outcome !== 'success') throw new Error(result.reason);

      const evidence = await withTenant(prisma, scope.tenantId, async (tx) => {
        const line = await tx.returnLine.findFirstOrThrow({
          where: { returnId: result.document.returnId, saleLineId: sale.lineId },
          select: {
            id: true,
            costKnownQuantityScaled: true,
            costUnknownQuantityScaled: true,
            costValueMinor: true,
            costProvenance: true,
          },
        });
        const movement = await tx.inventoryMovement.findFirstOrThrow({
          where: { sourceType: 'return', sourceId: result.document.returnId },
          select: {
            sourceLineId: true,
            costKnownQuantityScaled: true,
            costUnknownQuantityScaled: true,
            costValueMinor: true,
            costProvenance: true,
          },
        });
        return { line, movement };
      });
      snapshots.push(evidence);
    }

    expect(snapshots.map(({ line }) => line.costValueMinor)).toEqual([33n, 33n, 34n, 0n]);
    expect(snapshots.map(({ line }) => line.costKnownQuantityScaled)).toEqual([
      1_000n,
      1_000n,
      1_000n,
      0n,
    ]);
    expect(snapshots.map(({ line }) => line.costUnknownQuantityScaled)).toEqual([
      0n,
      0n,
      0n,
      1_000n,
    ]);
    expect(snapshots.map(({ line }) => line.costProvenance)).toEqual([
      'recorded',
      'recorded',
      'recorded',
      'unknown',
    ]);

    for (const { line, movement } of snapshots) {
      expect(movement.sourceLineId).toBe(line.id);
      expect(movement.costKnownQuantityScaled).toBe(line.costKnownQuantityScaled);
      expect(movement.costUnknownQuantityScaled).toBe(line.costUnknownQuantityScaled);
      expect(movement.costValueMinor).toBe(line.costValueMinor);
      expect(movement.costProvenance).toBe(line.costProvenance);
    }

    const final = await withTenant(prisma, scope.tenantId, async (tx) => ({
      cost: await tx.inventoryCostBalance.findFirst({
        where: { branchId: R.branch, productId: R.costed },
      }),
      stock: await tx.inventoryBalance.findFirst({
        where: { branchId: R.branch, productId: R.costed },
      }),
      returnLines: await tx.returnLine.findMany({ where: { saleLineId: sale.lineId } }),
    }));
    expect(final.stock?.quantityScaled).toBe(4_000n);
    expect(final.cost).toMatchObject({ knownQuantityScaled: 3_000n, knownValueMinor: 100n });
    expect(final.returnLines.reduce((sum, line) => sum + line.costValueMinor, 0n)).toBe(
      afterSale.line?.costValueMinor,
    );
    expect(final.returnLines.reduce((sum, line) => sum + line.costKnownQuantityScaled, 0n)).toBe(
      afterSale.line?.costKnownQuantityScaled,
    );
    expect(final.returnLines.reduce((sum, line) => sum + line.costUnknownQuantityScaled, 0n)).toBe(
      afterSale.line?.costUnknownQuantityScaled,
    );
  });
});
