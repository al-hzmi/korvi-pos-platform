import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
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
import { createDrawerService } from '../shifts/service.js';
import type { CheckoutService } from '../checkout/service.js';
import type { ReturnService } from '../returns/service.js';
import type { DrawerService } from '../shifts/service.js';
import type { PrismaClient } from '@korvi/database';
import type { AuthenticatedPrincipal, ShiftRepository, TenantScope } from '@korvi/domain';

/**
 * The drawer, against a real PostgreSQL server.
 *
 * Everything here is a claim about what two transactions do to each other, and
 * none of it can be answered by a fake. The races are *ordered*, not raced:
 * a third connection holds the shift row, each contender is started and then
 * observed queueing on that row before the next is started, and only then is
 * the holder released. PostgreSQL grants row locks to waiters in the order
 * they arrived, so the sequence under test is the sequence that happens —
 * rather than two promises launched in hope.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with
 * every migration applied, connected as the application role — not a
 * superuser, which bypasses RLS.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const S = {
  tenant: '018f9000-0000-7000-8000-00000000000a',
  slug: 'drawer-live-a',
  branch: '018f9000-0000-7000-8000-0000000000b1',
  terminal: '018f9000-0000-7000-8000-0000000000c1',
  user: '018f9000-0000-7000-8000-0000000000e1',
  membership: '018f9000-0000-7000-8000-0000000000e2',
  supervisor: '018f9000-0000-7000-8000-0000000000e3',
  supervisorMembership: '018f9000-0000-7000-8000-0000000000e4',
  milk: '018f9000-0000-7000-8000-0000000000f1',
} as const;

const OTHER = {
  tenant: '018f9000-0000-7000-8000-00000000001a',
  slug: 'drawer-live-b',
} as const;

describe.skipIf(url === '')('shift reconciliation, live', () => {
  /**
   * Two independent clients, because two tills are two processes.
   *
   * It also removes a question the test would otherwise be asking of Prisma's
   * connection pool rather than of PostgreSQL: each contender holds its own
   * connection, so the only thing either can be waiting for is the other's
   * row lock.
   */
  let prisma: PrismaClient;
  let second: PrismaClient;
  let shifts: ShiftRepository;
  let checkout: CheckoutService;
  let returns: ReturnService;
  let drawer: DrawerService;
  /** The same services over the second connection. */
  let checkoutB: CheckoutService;
  let returnsB: ReturnService;
  let drawerB: DrawerService;
  let cashier: AuthenticatedPrincipal;
  let supervisor: AuthenticatedPrincipal;

  /** The current shift, replaced for each test so no two share a drawer. */
  let shiftId: string;

  const scope: TenantScope = { tenantId: brandTenantId(S.tenant) };
  const otherScope: TenantScope = { tenantId: brandTenantId(OTHER.tenant) };

  async function remove(): Promise<void> {
    for (const id of [S.tenant, OTHER.tenant]) {
      await withTenant(prisma, brandTenantId(id), async (tx) => {
        await tx.tenant.deleteMany({ where: { id } });
      });
    }
  }

  /** A fresh open drawer, so each test starts from a known cash position. */
  async function openDrawer(openingFloatMinor: bigint): Promise<string> {
    const id = newId();
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.shift.updateMany({
        where: { tenantId: S.tenant, terminalId: S.terminal, status: 'open' },
        data: { status: 'closed', closedAt: new Date() },
      });
      await tx.shift.create({
        data: {
          id,
          tenantId: S.tenant,
          branchId: S.branch,
          terminalId: S.terminal,
          userId: S.user,
          openingFloatMinor,
          openedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.cashMovement.create({
        data: {
          id: newId(),
          tenantId: S.tenant,
          shiftId: id,
          kind: 'opening-float',
          amountMinor: 0n,
          actorUserId: S.user,
          occurredAt: new Date(),
        },
      });
    });
    return id;
  }

  async function sell(quantityScaled: string, cash: string): Promise<string> {
    const result = await checkout.checkout({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled }],
      cashReceivedMinor: cash,
    });
    if (result.outcome !== 'success') throw new Error(result.reason);
    return result.sale.saleId;
  }

  /**
   * A connection that holds the drawer's row, so contenders can be ordered.
   *
   * Not a test convenience: it is the only way to prove *which* transaction
   * won, rather than that one of them did.
   */
  class Gate {
    private constructor(
      private readonly client: pg.Client,
      private readonly pid: number,
    ) {}

    static async hold(id: string): Promise<Gate> {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [S.tenant]);
      await client.query('SELECT "id" FROM "shifts" WHERE "id" = $1 FOR UPDATE', [id]);
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error('no backend pid');
      return new Gate(client, pid);
    }

    /**
     * Wait until `count` backends are queued behind this gate's row lock.
     *
     * `pg_blocking_pids` is computed from the lock manager at the moment it is
     * called, so it answers "is blocked now" — unlike `wait_event`, which a
     * backend keeps after it stops waiting and which therefore cannot
     * distinguish a live waiter from a historical one.
     *
     * Waiting for the first contender to be *observably* blocked before
     * starting the second is what makes the race directed: PostgreSQL grants a
     * row lock to waiters in the order they queued, so the contender proved to
     * be waiting first is the contender that wins.
     */
    async blocking(count: number): Promise<void> {
      const deadline = Date.now() + 15_000;
      for (;;) {
        // Recursive, because PostgreSQL reports the *direct* blocker: the
        // first waiter is blocked by this gate, and the second is blocked by
        // the first. Both are queued on the same drawer row, and the chain
        // roots here.
        const { rows } = await this.client.query<{ n: string }>(
          `WITH RECURSIVE queued AS (
             SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a
               JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
              WHERE a.datname = current_database()
           )
           SELECT count(*)::text AS n FROM queued`,
          [this.pid],
        );
        if (Number(rows[0]?.n ?? '0') >= count) return;
        if (Date.now() > deadline) {
          const { rows: all } = await this.client.query(
            `SELECT pid, state, wait_event_type, pg_blocking_pids(pid) AS blockers, left(query, 70) AS q
               FROM pg_stat_activity WHERE datname = current_database()`,
          );
          throw new Error(
            `Only ${rows[0]?.n ?? '0'} of ${count} blocked (gate ${this.pid}): ${JSON.stringify(all)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }

    async release(): Promise<void> {
      await this.client.query('COMMIT');
      await this.client.end();
    }
  }

  /** Everything a losing writer must not have left behind. */
  async function residue(saleId: string | null): Promise<Record<string, number>> {
    return withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { shiftId } }),
      invoices: await tx.invoice.count({ where: { sale: { shiftId } } }),
      tenders: await tx.tender.count({ where: { sale: { shiftId } } }),
      returns: saleId === null ? 0 : await tx.return.count({ where: { saleId, shiftId } }),
      returnLines:
        saleId === null ? 0 : await tx.returnLine.count({ where: { return: { shiftId } } }),
      refunds: saleId === null ? 0 : await tx.refund.count({ where: { return: { shiftId } } }),
      saleMovements: await tx.cashMovement.count({ where: { shiftId, kind: 'sale' } }),
      refundMovements: await tx.cashMovement.count({ where: { shiftId, kind: 'refund' } }),
      payInMovements: await tx.cashMovement.count({ where: { shiftId, kind: 'pay-in' } }),
      payOutMovements: await tx.cashMovement.count({ where: { shiftId, kind: 'pay-out' } }),
      stock: await tx.inventoryMovement.count({ where: { sourceType: 'return' } }),
      keys: await tx.idempotencyKey.count(),
    }));
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: S.tenant,
          name: 'متجر الصندوق',
          slug: S.slug,
          vatNumber: '300000000000003',
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({ data: { tenantId: S.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: {
          id: S.branch,
          tenantId: S.tenant,
          code: '11',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
      });
      for (const [id, email, name, membership] of [
        [S.user, 'nada@drawer-live-a.test', 'ندى', S.membership],
        [S.supervisor, 'omar@drawer-live-a.test', 'عمر', S.supervisorMembership],
      ] as const) {
        await tx.user.create({
          data: { id, tenantId: S.tenant, email, displayName: name, updatedAt: new Date() },
        });
        await tx.tenantMembership.create({
          data: {
            id: membership,
            tenantId: S.tenant,
            userId: id,
            defaultBranchId: S.branch,
            updatedAt: new Date(),
          },
        });
      }
      await tx.terminal.create({
        data: {
          id: S.terminal,
          tenantId: S.tenant,
          branchId: S.branch,
          code: '01',
          label: 'صندوق ١',
          updatedAt: new Date(),
        },
      });
      await tx.product.create({
        data: {
          id: S.milk,
          tenantId: S.tenant,
          sku: 'MILK-1L',
          nameAr: 'حليب',
          productType: 'unit',
          priceMinor: 1_150n,
          vatBasisPoints: 1500,
          updatedAt: new Date(),
        },
      });
      await tx.inventoryBalance.create({
        data: {
          tenantId: S.tenant,
          branchId: S.branch,
          productId: S.milk,
          quantityScaled: 1_000_000n,
          updatedAt: new Date(),
        },
      });
    });

    await withTenant(prisma, otherScope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: { id: OTHER.tenant, name: 'متجر آخر', slug: OTHER.slug, updatedAt: new Date() },
      });
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, S.user, 'cashier');
    await assignRole(prisma, scope, S.supervisor, 'manager');

    const stack = (
      client: PrismaClient,
    ): {
      shifts: ShiftRepository;
      checkout: CheckoutService;
      returns: ReturnService;
      drawer: DrawerService;
    } => {
      const shiftRepository = createShiftRepository(client);
      const terminals = createTerminalRepository(client);
      const idempotency = createIdempotencyRepository(client);
      const audit = createAuditRepository(client);
      return {
        shifts: shiftRepository,
        checkout: createCheckoutService({
          tenants: createTenantRepository(client),
          products: createProductRepository(client),
          inventory: createInventoryRepository(client),
          shifts: shiftRepository,
          sales: createSaleRepository(client),
          idempotency,
          audit,
        }),
        returns: createReturnService({
          returns: createReturnRepository(client),
          terminals,
          shifts: shiftRepository,
          idempotency,
          audit,
        }),
        drawer: createDrawerService({ shifts: shiftRepository, terminals, idempotency, audit }),
      };
    };

    second = createPrismaClient(url);
    // Connect eagerly: a contender that is still opening its first connection
    // is not a contender, and the directed races depend on both being live.
    await second.$queryRaw`SELECT 1`;
    const a = stack(prisma);
    const b = stack(second);
    shifts = a.shifts;
    checkout = a.checkout;
    returns = a.returns;
    drawer = a.drawer;
    checkoutB = b.checkout;
    returnsB = b.returns;
    drawerB = b.drawer;

    const base = {
      tenantId: S.tenant,
      tenantSlug: S.slug,
      sessionId: newId(),
      maxDiscountBasisPoints: 0n,
      branchId: S.branch,
    } as const;
    cashier = {
      ...base,
      userId: S.user,
      email: 'nada@drawer-live-a.test',
      displayName: 'ندى',
      roles: ['cashier'],
      permissions: [
        'sale.create',
        // A return is processed at the till whose drawer it comes out of, and
        // the shift belongs to this cashier.
        'sale.refund',
        'shift.open',
        'shift.close',
        'product.read',
      ],
    };
    supervisor = {
      ...base,
      userId: S.supervisor,
      email: 'omar@drawer-live-a.test',
      displayName: 'عمر',
      roles: ['manager'],
      permissions: ['sale.create', 'sale.refund', 'shift.cash-movement', 'product.read'],
    };
  }, 120_000);

  beforeEach(async () => {
    shiftId = await openDrawer(20_000n);
  });

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
    await second.$disconnect();
  });

  it('A. a sale proved to be waiting first wins, and the close counts it once', async () => {
    const gate = await Gate.hold(shiftId);

    const sale = checkout.checkout({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '1000' }],
      cashReceivedMinor: '2000',
    });
    // The sale is now demonstrably blocked on this drawer's row.
    await gate.blocking(1);

    const close = drawerB.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '21150',
    });
    // And so is the close, behind it. PostgreSQL grants in queue order.
    await gate.blocking(2);
    await gate.release();

    const sold = await sale;
    const result = await close;
    expect(sold.outcome).toBe('success');
    if (result.outcome !== 'success') throw new Error(result.reason);

    expect(result.shift.reconciliation.cashSalesMinor).toBe('1150');
    expect(result.shift.reconciliation.expectedCashMinor).toBe('21150');
    expect(result.shift.reconciliation.varianceMinor).toBe('0');

    const movements = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { shiftId, kind: 'sale' } }),
    );
    expect(movements).toBe(1);
  }, 30_000);

  it('B. a close proved to be waiting first wins, and the sale behind it leaves nothing', async () => {
    const before = await residue(null);
    const stockBefore = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryMovement.count({ where: { sourceType: 'sale', productId: S.milk } }),
    );
    const gate = await Gate.hold(shiftId);

    const close = drawer.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '20000',
    });
    await gate.blocking(1);

    const loser = newId();
    const sale = checkoutB.checkout({
      principal: cashier,
      operationId: loser,
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '1000' }],
      cashReceivedMinor: '2000',
    });
    await gate.blocking(2);
    await gate.release();

    const closed = await close;
    const sold = await sale;
    expect(closed.outcome).toBe('success');
    expect(sold.outcome).toBe('failure');
    if (sold.outcome === 'failure') expect(sold.reason).toBe('shift-invalid');

    // The whole commercial transaction rolled back, not merely the sale row.
    const after = await residue(null);
    expect(after.sales).toBe(before.sales);
    expect(after.invoices).toBe(before.invoices);
    expect(after.tenders).toBe(before.tenders);
    expect(after.saleMovements).toBe(before.saleMovements);

    const residues = await withTenant(prisma, scope.tenantId, async (tx) => ({
      // The loser's reservation is gone; only the winning close kept one.
      loser: await tx.idempotencyKey.count({ where: { operationId: loser } }),
      stock: await tx.inventoryMovement.count({
        where: { sourceType: 'sale', productId: S.milk },
      }),
    }));
    expect(residues.loser).toBe(0);
    // No stock left the shelf for a sale that never committed.
    expect(residues.stock).toBe(stockBefore);
  }, 30_000);

  it('C. a cash refund proved to be waiting first wins, and the close counts it once', async () => {
    const saleId = await sell('2000', '5000');
    const line = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.saleLine.findFirst({ where: { saleId } }),
    );
    const gate = await Gate.hold(shiftId);

    const refund = returns.create({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      saleId,
      lines: [{ saleLineId: line!.id, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    await gate.blocking(1);

    const close = drawerB.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '21150',
    });
    await gate.blocking(2);
    await gate.release();

    expect((await refund).outcome).toBe('success');
    const result = await close;
    if (result.outcome !== 'success') throw new Error(result.reason);

    // 20000 + 2300 sold - 1150 refunded. Subtracted once, never added and
    // never subtracted twice.
    expect(result.shift.reconciliation.cashSalesMinor).toBe('2300');
    expect(result.shift.reconciliation.cashRefundsMinor).toBe('1150');
    expect(result.shift.reconciliation.expectedCashMinor).toBe('21150');
    expect(result.shift.reconciliation.varianceMinor).toBe('0');

    const outflows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { shiftId, kind: 'refund' } }),
    );
    expect(outflows).toBe(1);
  }, 30_000);

  it('D. a close proved to be waiting first wins, and the refund behind it leaves nothing', async () => {
    const saleId = await sell('2000', '5000');
    const line = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.saleLine.findFirst({ where: { saleId } }),
    );
    const before = await residue(saleId);
    const gate = await Gate.hold(shiftId);

    const close = drawer.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '22300',
    });
    await gate.blocking(1);

    const loser = newId();
    const refund = returnsB.create({
      principal: cashier,
      operationId: loser,
      terminalId: S.terminal,
      saleId,
      lines: [{ saleLineId: line!.id, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    await gate.blocking(2);
    await gate.release();

    expect((await close).outcome).toBe('success');
    expect((await refund).outcome).toBe('failure');

    // The whole return rolled back: document, lines, refund record, the stock
    // that would have gone back on the shelf, the drawer movement, and the
    // reservation.
    const after = await residue(saleId);
    expect(after.returns).toBe(before.returns);
    expect(after.returnLines).toBe(before.returnLines);
    expect(after.refunds).toBe(before.refunds);
    expect(after.refundMovements).toBe(before.refundMovements);
    expect(after.stock).toBe(before.stock);

    const orphaned = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.idempotencyKey.count({ where: { operationId: loser } }),
    );
    expect(orphaned).toBe(0);
  }, 30_000);

  it('E. a manual movement proved to be waiting first wins, and is counted once', async () => {
    const gate = await Gate.hold(shiftId);

    const movement = drawer.recordMovement({
      principal: supervisor,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      kind: 'pay-in',
      amountMinor: '5000',
      reason: 'إيداع صرافة',
    });
    await gate.blocking(1);

    const close = drawerB.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '25000',
    });
    await gate.blocking(2);
    await gate.release();

    expect((await movement).outcome).toBe('success');
    const result = await close;
    if (result.outcome !== 'success') throw new Error(result.reason);
    expect(result.shift.reconciliation.paidInMinor).toBe('5000');
    expect(result.shift.reconciliation.expectedCashMinor).toBe('25000');
    expect(result.shift.reconciliation.varianceMinor).toBe('0');

    const rows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { shiftId, kind: 'pay-in' } }),
    );
    expect(rows).toBe(1);
  }, 30_000);

  it('F. a close proved to be waiting first wins, and the movement behind it leaves nothing', async () => {
    const before = await residue(null);
    const gate = await Gate.hold(shiftId);

    const close = drawer.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '20000',
    });
    await gate.blocking(1);

    const operationId = newId();
    const movement = drawerB.recordMovement({
      principal: supervisor,
      operationId,
      terminalId: S.terminal,
      shiftId,
      kind: 'pay-out',
      amountMinor: '750',
      reason: 'مصروف',
    });
    await gate.blocking(2);
    await gate.release();

    expect((await close).outcome).toBe('success');
    const refused = await movement;
    expect(refused.outcome).toBe('failure');
    if (refused.outcome === 'failure') expect(refused.reason).toBe('shift-closed');

    const after = await residue(null);
    expect(after.payOutMovements).toBe(before.payOutMovements);
    const mine = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.idempotencyKey.count({ where: { operationId } }),
    );
    expect(mine).toBe(0);
  }, 30_000);

  it('G. two closes under different operation ids: exactly one wins', async () => {
    const gate = await Gate.hold(shiftId);

    const first = drawer.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '20000',
    });
    const other = drawerB.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '19000',
    });
    await gate.blocking(2);
    await gate.release();

    const results = [await first, await other];
    const winners = results.filter((r) => r.outcome === 'success');
    expect(winners).toHaveLength(1);
    const loser = results.find((r) => r.outcome === 'failure');
    expect(loser?.outcome === 'failure' ? loser.reason : '').toBe('shift-closed');

    const row = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.shift.findFirst({ where: { id: shiftId } }),
    );
    // Whichever count won is the count that stands; the loser never overwrote
    // it, and no second snapshot was written on top.
    const winner = winners[0];
    if (winner?.outcome !== 'success') throw new Error('no winner');
    expect(row?.declaredCashMinor?.toString()).toBe(winner.shift.reconciliation.declaredCashMinor);
  }, 30_000);

  it('H. two identical closes at once produce one close and one replay', async () => {
    const operationId = newId();
    const request = {
      principal: cashier,
      operationId,
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '20000',
    };
    const gate = await Gate.hold(shiftId);

    const first = drawer.close(request);
    const other = drawerB.close(request);
    await gate.blocking(2);
    await gate.release();

    const results = [await first, await other];
    expect(results.every((r) => r.outcome === 'success')).toBe(true);
    const keys = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.idempotencyKey.count({ where: { scope: 'shift-close', operationId } }),
    );
    expect(keys).toBe(1);
    if (results[0]?.outcome === 'success' && results[1]?.outcome === 'success') {
      // The same immutable snapshot, not a recomputation.
      expect(results[0].shift.reconciliation).toEqual(results[1].shift.reconciliation);
      expect(results[0].shift.closedAt).toBe(results[1].shift.closedAt);
    }
  }, 30_000);

  it('I. the same close operation id with a different count is a conflict', async () => {
    const operationId = newId();
    const first = await drawer.close({
      principal: cashier,
      operationId,
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '20000',
    });
    expect(first.outcome).toBe('success');

    const second = await drawer.close({
      principal: cashier,
      operationId,
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '19999',
    });
    expect(second.outcome).toBe('failure');
    if (second.outcome === 'failure') expect(second.reason).toBe('idempotency-conflict');
  });

  it('J. two identical manual movements at once produce one movement', async () => {
    const operationId = newId();
    const request = {
      principal: supervisor,
      operationId,
      terminalId: S.terminal,
      shiftId,
      kind: 'pay-in' as const,
      amountMinor: '5000',
      reason: 'إيداع صرافة',
    };
    const gate = await Gate.hold(shiftId);

    const first = drawer.recordMovement(request);
    const other = drawerB.recordMovement(request);
    await gate.blocking(2);
    await gate.release();

    const results = [await first, await other];
    expect(results.every((r) => r.outcome === 'success')).toBe(true);
    const movements = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { shiftId, kind: 'pay-in' } }),
    );
    expect(movements).toBe(1);
  }, 30_000);

  it('K. the same movement operation id with a different amount is a conflict', async () => {
    const operationId = newId();
    const base = {
      principal: supervisor,
      operationId,
      terminalId: S.terminal,
      shiftId,
      kind: 'pay-in' as const,
      reason: 'إيداع صرافة',
    };
    expect((await drawer.recordMovement({ ...base, amountMinor: '5000' })).outcome).toBe('success');

    const conflicting = await drawer.recordMovement({ ...base, amountMinor: '6000' });
    expect(conflicting.outcome).toBe('failure');
    if (conflicting.outcome === 'failure') expect(conflicting.reason).toBe('idempotency-conflict');

    const movements = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { shiftId, kind: 'pay-in' } }),
    );
    expect(movements).toBe(1);
  });

  it('L. another tenant can see none of it, and cannot point at it', async () => {
    await drawer.recordMovement({
      principal: supervisor,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      kind: 'pay-in',
      amountMinor: '5000',
      reason: 'إيداع صرافة',
    });

    const seen = await withTenant(prisma, otherScope.tenantId, async (tx) => ({
      shifts: await tx.shift.count(),
      movements: await tx.cashMovement.count(),
    }));
    expect(seen.shifts).toBe(0);
    expect(seen.movements).toBe(0);

    // And the composite key refuses a cross-tenant reference outright.
    await expect(
      withTenant(prisma, otherScope.tenantId, async (tx) =>
        tx.cashMovement.create({
          data: {
            id: newId(),
            tenantId: OTHER.tenant,
            shiftId,
            kind: 'pay-in',
            amountMinor: 1n,
            reason: 'x',
            actorUserId: S.supervisor,
            occurredAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();

    // The scoped read still finds it, so the zeros above mean isolation.
    const mine = await shifts.findById(scope, shiftId);
    expect(mine?.movements.some((m) => m.kind === 'pay-in')).toBe(true);
  });

  it('M. one halala over and one halala short are both exactly one halala', async () => {
    const over = await drawer.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '20001',
    });
    if (over.outcome !== 'success') throw new Error(over.reason);
    expect(over.shift.reconciliation.varianceMinor).toBe('1');

    shiftId = await openDrawer(20_000n);
    const short = await drawer.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '19999',
    });
    if (short.outcome !== 'success') throw new Error(short.reason);
    expect(short.shift.reconciliation.varianceMinor).toBe('-1');
  });

  it('N. stays exact past the largest safe JavaScript integer', async () => {
    // A float would land on 9007199254740992 for both of these.
    shiftId = await openDrawer(9_007_199_254_740_993n);
    const result = await drawer.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '9007199254740994',
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    expect(result.shift.reconciliation.openingFloatMinor).toBe('9007199254740993');
    expect(result.shift.reconciliation.expectedCashMinor).toBe('9007199254740993');
    expect(result.shift.reconciliation.varianceMinor).toBe('1');

    const row = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.shift.findFirst({ where: { id: shiftId } }),
    );
    expect(row?.expectedCashMinor).toBe(9_007_199_254_740_993n);
  });

  it('O. every category keeps its own sign through an asymmetric day', async () => {
    const saleId = await sell('2000', '5000');
    const line = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.saleLine.findFirst({ where: { saleId } }),
    );
    await returns.create({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      saleId,
      lines: [{ saleLineId: line!.id, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    await drawer.recordMovement({
      principal: supervisor,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      kind: 'pay-in',
      amountMinor: '5000',
      reason: 'إيداع',
    });
    await drawer.recordMovement({
      principal: supervisor,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      kind: 'pay-out',
      amountMinor: '750',
      reason: 'مصروف',
    });

    // 20000 + 2300 - 1150 + 5000 - 750 = 25400.
    const result = await drawer.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '25400',
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    expect(result.shift.reconciliation).toMatchObject({
      openingFloatMinor: '20000',
      cashSalesMinor: '2300',
      cashRefundsMinor: '1150',
      paidInMinor: '5000',
      paidOutMinor: '750',
      expectedCashMinor: '25400',
      varianceMinor: '0',
    });

    // The persisted movements carry the signs, and the snapshot carries the
    // magnitudes. Neither is a restatement of the other.
    const signs = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.findMany({ where: { shiftId }, select: { kind: true, amountMinor: true } }),
    );
    expect(signs.find((m) => m.kind === 'refund')?.amountMinor).toBeLessThan(0n);
    expect(signs.find((m) => m.kind === 'pay-out')?.amountMinor).toBeLessThan(0n);
    expect(signs.find((m) => m.kind === 'pay-in')?.amountMinor).toBeGreaterThan(0n);
  });

  it('Q. an operation id is bound to the actor who minted it', async () => {
    // The cashier closes the drawer. The supervisor then replays that exact
    // request — same operation id, same till, same count — and must be told it
    // is a conflict rather than handed the cashier's reconciliation.
    const operationId = newId();
    const closed = await drawer.close({
      principal: cashier,
      operationId,
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '20000',
    });
    if (closed.outcome !== 'success') throw new Error(closed.reason);

    const stolen = await drawer.close({
      principal: supervisor,
      operationId,
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '20000',
    });
    expect(stolen.outcome).toBe('failure');
    if (stolen.outcome === 'failure') expect(stolen.reason).toBe('idempotency-conflict');

    const row = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.shift.findFirst({ where: { id: shiftId } }),
    );
    // Nothing about the close moved: same closer, same snapshot.
    expect(row?.closedByUserId).toBe(S.user);
    expect(row?.expectedCashMinor).toBe(20_000n);
    expect(row?.varianceMinor).toBe(0n);
  });

  it('Q2. a manual movement keeps the name of the manager who made it', async () => {
    const operationId = newId();
    const first = await drawer.recordMovement({
      principal: supervisor,
      operationId,
      terminalId: S.terminal,
      shiftId,
      kind: 'pay-in',
      amountMinor: '5000',
      reason: 'إيداع صرافة',
    });
    expect(first.outcome).toBe('success');

    // The cashier reuses the id with an otherwise identical request.
    const stolen = await drawer.recordMovement({
      principal: cashier,
      operationId,
      terminalId: S.terminal,
      shiftId,
      kind: 'pay-in',
      amountMinor: '5000',
      reason: 'إيداع صرافة',
    });
    expect(stolen.outcome).toBe('failure');
    if (stolen.outcome === 'failure') expect(stolen.reason).toBe('idempotency-conflict');

    const rows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.findMany({ where: { shiftId, kind: 'pay-in' } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorUserId).toBe(S.supervisor);
  });

  it('P0. a failure AFTER the reservation takes the reservation with it', async () => {
    /*
     * The reservation is written inside the financial transaction, and the
     * proof of that has to fail *after* it.
     *
     * `recordManualMovement` runs: lock the shift, prove addressability and
     * state, reserve the operation, then insert the movement. Calling the
     * repository directly with an actor id that is not a user in this tenant
     * gets past every one of those and dies on
     * `cash_movements_tenantId_actorUserId_fkey` — the last statement in the
     * transaction. Nothing in production can reach this: the service supplies
     * the actor from the session, and no validation was weakened to arrange
     * it. The database invariant does the work.
     */
    const operationId = newId();
    const before = await withTenant(prisma, scope.tenantId, async (tx) => ({
      keys: await tx.idempotencyKey.count(),
      movements: await tx.cashMovement.count({ where: { shiftId } }),
      shift: await tx.shift.findFirst({ where: { id: shiftId } }),
    }));

    await expect(
      shifts.recordManualMovement(scope, {
        id: newId(),
        shiftId,
        terminalId: S.terminal,
        branchId: S.branch,
        kind: 'pay-in',
        amountMinor: '5000',
        reason: 'إيداع صرافة',
        // A well-formed UUID that is nobody in this tenant.
        actorUserId: '018f9000-0000-7000-8000-0000000000ff',
        occurredAt: new Date().toISOString(),
        idempotency: { id: newId(), scope: 'cash-movement', operationId, requestHash: 'h' },
      }),
    ).rejects.toThrow();

    const after = await withTenant(prisma, scope.tenantId, async (tx) => ({
      keys: await tx.idempotencyKey.count(),
      mine: await tx.idempotencyKey.count({ where: { operationId } }),
      movements: await tx.cashMovement.count({ where: { shiftId } }),
      shift: await tx.shift.findFirst({ where: { id: shiftId } }),
    }));

    // The reservation that was written a statement earlier is gone.
    expect(after.mine).toBe(0);
    expect(after.keys).toBe(before.keys);
    expect(after.movements).toBe(before.movements);
    expect(after.shift?.status).toBe('open');
    expect(after.shift?.expectedCashMinor).toBeNull();

    // And the operation id is free: a lawful retry is not blocked by a
    // tombstone from the failed attempt.
    const retried = await drawer.recordMovement({
      principal: supervisor,
      operationId,
      terminalId: S.terminal,
      shiftId,
      kind: 'pay-in',
      amountMinor: '5000',
      reason: 'إيداع صرافة',
    });
    expect(retried.outcome).toBe('success');
  });

  it('P. a refused close leaves no reservation and no partial snapshot', async () => {
    const operationId = newId();
    const before = await withTenant(prisma, scope.tenantId, async (tx) => ({
      keys: await tx.idempotencyKey.count(),
    }));

    // Not the owner: refused inside the transaction, after the row was locked
    // and before anything was written.
    const refused = await drawer.close({
      principal: supervisor,
      operationId,
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '20000',
    });
    expect(refused.outcome).toBe('failure');

    const after = await withTenant(prisma, scope.tenantId, async (tx) => ({
      keys: await tx.idempotencyKey.count(),
      mine: await tx.idempotencyKey.count({ where: { operationId } }),
      shift: await tx.shift.findFirst({ where: { id: shiftId } }),
    }));

    expect(after.keys).toBe(before.keys);
    expect(after.mine).toBe(0);
    expect(after.shift?.status).toBe('open');
    expect(after.shift?.cashSalesMinor).toBeNull();
    expect(after.shift?.expectedCashMinor).toBeNull();
    expect(after.shift?.closedByUserId).toBeNull();

    // And the drawer still closes afterwards, under a new operation id.
    const closed = await drawer.close({
      principal: cashier,
      operationId: newId(),
      terminalId: S.terminal,
      shiftId,
      declaredCashMinor: '20000',
    });
    expect(closed.outcome).toBe('success');
  });
});
