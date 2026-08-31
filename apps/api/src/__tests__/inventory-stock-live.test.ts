import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { StockRequestError, newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  StockOperationRefusedError,
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
  listBalancePage,
  listInventoryBranchPage,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  recordInventoryCostBootstrap,
  recordInventoryAdjustment,
  recordInventoryCount,
  recordInventoryTransfer,
  withTenant,
} from '@korvi/database';
import { createCheckoutService } from '../checkout/service.js';
import { createReturnService } from '../returns/service.js';
import {
  fingerprintAdjustment,
  fingerprintCostBootstrap,
  fingerprintCount,
  fingerprintTransfer,
} from '../inventory/fingerprint.js';
import type { CheckoutService } from '../checkout/service.js';
import type { ReturnService } from '../returns/service.js';
import type { PrismaClient, StockActor } from '@korvi/database';
import type {
  AdjustmentRequest,
  AuthenticatedPrincipal,
  CountRequest,
  TenantScope,
  TransferRequest,
} from '@korvi/domain';

/**
 * Strike 5A against a real PostgreSQL server.
 *
 * Every claim in this strike is a claim about what the database does when two
 * transactions arrive together, when a transfer fails halfway, or when somebody
 * counts a shelf that is being sold from. None of that can be answered by a
 * fake, so none of it is asserted anywhere but here.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with every
 * migration applied, connected as the application role — not a superuser and
 * not a BYPASSRLS role. That is asserted rather than assumed.
 *
 * Concurrency tests are time-bounded so a deadlock fails the test instead of
 * hanging the suite.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const T = {
  tenant: '018f5a00-0000-7000-8000-00000000000a',
  slug: 'stock-live-a',
  branchA: '018f5a00-0000-7000-8000-0000000000a1',
  branchB: '018f5a00-0000-7000-8000-0000000000a2',
  branchClosed: '018f5a00-0000-7000-8000-0000000000a3',
  branchDoomed: '018f5a00-0000-7000-8000-0000000000ae',
  terminal: '018f5a00-0000-7000-8000-0000000000a4',
  shift: '018f5a00-0000-7000-8000-0000000000a5',
  user: '018f5a00-0000-7000-8000-0000000000a6',
  membership: '018f5a00-0000-7000-8000-0000000000a7',
  milk: '018f5a00-0000-7000-8000-0000000000a8',
  rice: '018f5a00-0000-7000-8000-0000000000a9',
  scale: '018f5a00-0000-7000-8000-0000000000aa',
  untracked: '018f5a00-0000-7000-8000-0000000000ab',
  inactive: '018f5a00-0000-7000-8000-0000000000ac',
  customRole: '018f5a00-0000-7000-8000-0000000000ad',
  costSale: '018f5a00-0000-7000-8000-0000000000b0',
  costTransfer: '018f5a00-0000-7000-8000-0000000000b1',
} as const;

const OTHER = {
  tenant: '018f5a00-0000-7000-8000-00000000000b',
  slug: 'stock-live-b',
  branch: '018f5a00-0000-7000-8000-0000000000b1',
  user: '018f5a00-0000-7000-8000-0000000000b2',
  membership: '018f5a00-0000-7000-8000-0000000000b3',
  product: '018f5a00-0000-7000-8000-0000000000b4',
} as const;

const NEW_TABLES = [
  'inventory_adjustments',
  'inventory_adjustment_lines',
  'inventory_counts',
  'inventory_count_lines',
  'inventory_transfers',
  'inventory_transfer_lines',
] as const;

/** Fail rather than hang: an un-ordered lock would otherwise block forever. */
function within<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not settle within ${String(ms)}ms`)), ms),
    ),
  ]);
}

describe.skipIf(url === '')('inventory stock ledger, live', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;
  let checkout: CheckoutService;
  let returns: ReturnService;

  const scope: TenantScope = { tenantId: brandTenantId(T.tenant) };
  const actor: StockActor = { tenantId: T.tenant, userId: T.user };

  async function removeTenant(id: string): Promise<void> {
    await withTenant(prisma, id, async (tx) => {
      await tx.tenant.deleteMany({ where: { id } });
    });
  }

  const adjust = (request: AdjustmentRequest, who: StockActor = actor) =>
    recordInventoryAdjustment(prisma, who, request, fingerprintAdjustment(request, who.userId));

  const countStock = (request: CountRequest, who: StockActor = actor, client = prisma) =>
    recordInventoryCount(client, who, request, fingerprintCount(request, who.userId));

  const transfer = (request: TransferRequest, who: StockActor = actor, client = prisma) =>
    recordInventoryTransfer(client, who, request, fingerprintTransfer(request, who.userId));

  async function refusal(work: () => Promise<unknown>): Promise<Error> {
    try {
      await work();
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error('expected a refusal, and the call succeeded');
  }

  async function balanceOf(
    branchId: string,
    productId: string,
    tenant: string = T.tenant,
  ): Promise<{ quantityScaled: bigint; revision: bigint } | null> {
    return withTenant(prisma, tenant, async (tx) => {
      const row = await tx.inventoryBalance.findFirst({
        where: { tenantId: tenant, branchId, productId },
        select: { quantityScaled: true, revision: true },
      });
      return row;
    });
  }

  async function costOf(branchId: string, productId: string) {
    return withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryCostBalance.findFirst({
        where: { tenantId: T.tenant, branchId, productId },
        select: {
          knownQuantityScaled: true,
          knownValueMinor: true,
          stockRevision: true,
          costRevision: true,
        },
      }),
    );
  }

  async function setQuantity(
    branchId: string,
    productId: string,
    quantityScaled: bigint,
  ): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.inventoryBalance.upsert({
        where: {
          tenantId_branchId_productId: { tenantId: T.tenant, branchId, productId },
        },
        create: { tenantId: T.tenant, branchId, productId, quantityScaled, updatedAt: new Date() },
        update: { quantityScaled },
      });
    });
  }

  async function allowNegative(allowed: boolean): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenantSettings.updateMany({
        where: { tenantId: T.tenant },
        data: { allowNegativeStock: allowed },
      });
    });
  }

  /** Every movement this tenant has, so "wrote nothing" is measured whole. */
  async function totalMovements(): Promise<number> {
    return withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryMovement.count({ where: { tenantId: T.tenant } }),
    );
  }

  async function movementsFor(sourceId: string): Promise<
    {
      branchId: string;
      productId: string;
      quantityScaled: bigint;
      kind: string;
      sourceLineId: string | null;
    }[]
  > {
    return withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryMovement.findMany({
        where: { tenantId: T.tenant, sourceId },
        select: {
          branchId: true,
          productId: true,
          quantityScaled: true,
          kind: true,
          sourceLineId: true,
        },
        orderBy: { quantityScaled: 'asc' },
      }),
    );
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    second = createPrismaClient(url);
    await second.$queryRaw`SELECT 1`;
    await removeTenant(T.tenant);
    await removeTenant(OTHER.tenant);
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: T.tenant,
          name: 'متجر المخزون',
          slug: T.slug,
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({
        data: { tenantId: T.tenant, allowNegativeStock: false, updatedAt: new Date() },
      });
      for (const [id, code, active] of [
        [T.branchA, '01', true],
        [T.branchB, '02', true],
        [T.branchClosed, '03', false],
        [T.branchDoomed, '04', true],
      ] as const) {
        await tx.branch.create({
          data: {
            id,
            tenantId: T.tenant,
            code,
            nameAr: `فرع ${code}`,
            isActive: active,
            updatedAt: new Date(),
          },
        });
      }
      await tx.user.create({
        data: {
          id: T.user,
          tenantId: T.tenant,
          email: 'sara@stock-live-a.test',
          displayName: 'سارة',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: T.membership, tenantId: T.tenant, userId: T.user, updatedAt: new Date() },
      });
      await tx.terminal.create({
        data: {
          id: T.terminal,
          tenantId: T.tenant,
          branchId: T.branchA,
          code: '01',
          label: 'صندوق 01',
          updatedAt: new Date(),
        },
      });
      await tx.shift.create({
        data: {
          id: T.shift,
          tenantId: T.tenant,
          branchId: T.branchA,
          terminalId: T.terminal,
          userId: T.user,
          openingFloatMinor: 20_000n,
          openedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      for (const [id, sku, type, track, active] of [
        [T.milk, 'MILK-1L', 'unit', true, true],
        [T.rice, 'RICE-5K', 'unit', true, true],
        [T.scale, 'TOMATO', 'weighted', true, true],
        [T.untracked, 'SERVICE', 'unit', false, true],
        [T.inactive, 'OLD-SKU', 'unit', true, false],
        [T.costSale, 'COST-SALE', 'unit', true, true],
        [T.costTransfer, 'COST-TRANSFER', 'unit', true, true],
      ] as const) {
        await tx.product.create({
          data: {
            id,
            tenantId: T.tenant,
            sku,
            nameAr: sku,
            productType: type,
            trackInventory: track,
            isActive: active,
            priceMinor: 1150n,
            vatBasisPoints: 1500,
            updatedAt: new Date(),
          },
        });
      }
    });

    await withTenant(prisma, OTHER.tenant, async (tx) => {
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
      await tx.tenantSettings.create({
        data: { tenantId: OTHER.tenant, updatedAt: new Date() },
      });
      await tx.branch.create({
        data: {
          id: OTHER.branch,
          tenantId: OTHER.tenant,
          code: '01',
          nameAr: 'فرع',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: OTHER.user,
          tenantId: OTHER.tenant,
          email: 'omar@stock-live-b.test',
          displayName: 'عمر',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: {
          id: OTHER.membership,
          tenantId: OTHER.tenant,
          userId: OTHER.user,
          updatedAt: new Date(),
        },
      });
      await tx.product.create({
        data: {
          id: OTHER.product,
          tenantId: OTHER.tenant,
          sku: 'THEIR-SKU',
          nameAr: 'صنف',
          priceMinor: 500n,
          vatBasisPoints: 1500,
          updatedAt: new Date(),
        },
      });
    });

    await provisionTenantRbac(prisma, scope);
    await provisionTenantRbac(prisma, { tenantId: brandTenantId(OTHER.tenant) });
    await assignRole(prisma, scope, T.user, 'cashier');

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
      returns: createReturnRepository(prisma),
      terminals: createTerminalRepository(prisma),
      shifts: createShiftRepository(prisma),
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });
  }, 180_000);

  afterAll(async () => {
    await removeTenant(T.tenant);
    await removeTenant(OTHER.tenant);
    await prisma.$disconnect();
    await second.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1 & 2 — the ground the rest stands on
  // -------------------------------------------------------------------------

  it('runs as a role the policies actually apply to, on every new table', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();

    const { rows: role } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    const { rows: tables } = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = ANY($1) AND relkind = 'r'
        ORDER BY relname`,
      [[...NEW_TABLES]],
    );
    expect(tables).toHaveLength(NEW_TABLES.length);
    for (const table of tables) {
      expect(table.relrowsecurity, table.relname).toBe(true);
      expect(table.relforcerowsecurity, table.relname).toBe(true);
    }

    // The revision column exists and defaults to zero — migrated balances keep
    // an honest "unknown history" rather than a fabricated one.
    const { rows: column } = await client.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'inventory_balances' AND column_name = 'revision'`,
    );
    expect(column[0]?.column_default).toBe('0');
    await client.end();
  }, 60_000);

  it('keeps one merchant out of another merchant s stock documents', async () => {
    await setQuantity(T.branchA, T.milk, 10_000n);
    const mine = await adjust({
      operationId: `rls-${newId()}`,
      branchId: T.branchA,
      reason: 'جرد',
      lines: [{ productId: T.milk, deltaQuantityScaled: '1000' }],
    });

    // Under the other tenant's context, none of my documents exist.
    const seen = await withTenant(prisma, OTHER.tenant, async (tx) => ({
      adjustments: await tx.inventoryAdjustment.count({}),
      lines: await tx.inventoryAdjustmentLine.count({}),
      counts: await tx.inventoryCount.count({}),
      transfers: await tx.inventoryTransfer.count({}),
      mine: await tx.inventoryAdjustment.count({ where: { id: mine.id } }),
    }));
    expect(seen.mine).toBe(0);
    expect(seen.adjustments).toBe(0);
    expect(seen.lines).toBe(0);
    expect(seen.counts).toBe(0);
    expect(seen.transfers).toBe(0);

    // And a write cannot be aimed across the boundary: RLS refuses the row.
    const across = await refusal(() =>
      withTenant(prisma, OTHER.tenant, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "inventory_adjustments"
            ("id","tenantId","branchId","operationId","requestHash","reason","actorUserId","occurredAt","createdAt")
          VALUES (${newId()}::uuid, ${T.tenant}::uuid, ${T.branchA}::uuid, 'smuggled',
                  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'x', ${T.user}::uuid, now(), now())`;
      }),
    );
    expect(across.message).toMatch(/row-level security/i);

    // A cross-tenant product id discloses nothing and mutates nothing.
    const foreign = await refusal(() =>
      adjust({
        operationId: `cross-${newId()}`,
        branchId: T.branchA,
        reason: 'محاولة',
        lines: [{ productId: OTHER.product, deltaQuantityScaled: '1000' }],
      }),
    );
    expect((foreign as StockOperationRefusedError).detail).toBe('unknown-product');
    expect(await balanceOf(OTHER.branch, OTHER.product, OTHER.tenant)).toBeNull();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 3, 4, 20 — adjustment atomicity
  // -------------------------------------------------------------------------

  it('writes document, lines, movement, balance, revision, audit and idempotency together', async () => {
    await setQuantity(T.branchA, T.milk, 10_000n);
    const before = await balanceOf(T.branchA, T.milk);
    if (before === null) throw new Error('no opening balance');

    const operationId = `adjust-${newId()}`;
    const result = await adjust({
      operationId,
      branchId: T.branchA,
      reason: 'تلف أثناء النقل',
      lines: [{ productId: T.milk, deltaQuantityScaled: '-2000' }],
    });

    const after = await balanceOf(T.branchA, T.milk);
    expect(after?.quantityScaled).toBe(before.quantityScaled - 2000n);
    // Exactly one step, for exactly one movement.
    expect(after?.revision).toBe(before.revision + 1n);

    const rows = await withTenant(prisma, scope.tenantId, async (tx) => ({
      header: await tx.inventoryAdjustment.findFirst({ where: { id: result.id } }),
      lines: await tx.inventoryAdjustmentLine.findMany({
        where: { adjustmentId: result.id },
      }),
      audit: await tx.auditEvent.count({
        where: { entityId: result.id, eventType: 'inventory.adjustment.finalized' },
      }),
      key: await tx.idempotencyKey.findFirst({
        where: { scope: 'inventory-adjustment', operationId },
      }),
    }));

    expect(rows.header?.actorUserId).toBe(T.user);
    expect(rows.lines).toHaveLength(1);
    expect(rows.lines[0]?.beforeQuantityScaled).toBe(before.quantityScaled);
    expect(rows.lines[0]?.afterQuantityScaled).toBe(before.quantityScaled - 2000n);
    expect(rows.lines[0]?.resultRevision).toBe(before.revision + 1n);
    expect(rows.audit).toBe(1);
    expect(rows.key?.status).toBe('completed');
    expect(rows.key?.resultId).toBe(result.id);

    // The movement carries causality back to the line that explains it.
    const movements = await movementsFor(result.id);
    expect(movements).toHaveLength(1);
    expect(movements[0]?.kind).toBe('adjustment');
    expect(movements[0]?.sourceLineId).toBe(rows.lines[0]?.id);
  }, 60_000);

  it('rolls a multi-line adjustment back entirely when one line fails', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.milk, 10_000n);
    await setQuantity(T.branchA, T.rice, 1_000n);
    const before = {
      milk: await balanceOf(T.branchA, T.milk),
      rice: await balanceOf(T.branchA, T.rice),
    };

    const operationId = `partial-${newId()}`;
    const failed = await refusal(() =>
      adjust({
        operationId,
        branchId: T.branchA,
        reason: 'جرد شهري',
        lines: [
          // Lawful on its own.
          { productId: T.milk, deltaQuantityScaled: '-1000' },
          // Impossible: only 1 unit is held.
          { productId: T.rice, deltaQuantityScaled: '-5000' },
        ],
      }),
    );
    expect((failed as StockOperationRefusedError).detail).toBe('insufficient-stock');

    // Neither line survived — not the one that would have succeeded, not the
    // document, not the audit row, and not the reservation.
    expect(await balanceOf(T.branchA, T.milk)).toEqual(before.milk);
    expect(await balanceOf(T.branchA, T.rice)).toEqual(before.rice);
    const residue = await withTenant(prisma, scope.tenantId, async (tx) => ({
      documents: await tx.inventoryAdjustment.count({ where: { operationId } }),
      key: await tx.idempotencyKey.count({
        where: { scope: 'inventory-adjustment', operationId },
      }),
    }));
    expect(residue).toEqual({ documents: 0, key: 0 });
  }, 60_000);

  it('rolls back document, ledger, balance, audit and idempotency when a write fails late', async () => {
    await setQuantity(T.branchA, T.milk, 10_000n);
    const before = await balanceOf(T.branchA, T.milk);

    // A fault installed in the database rather than the code under test. The
    // audit insert is the last write of the transaction, so refusing it fails
    // the operation at the one point where the ledger and the balance have
    // already moved.
    const fault = new pg.Client({ connectionString: url });
    await fault.connect();
    await fault.query(`
      CREATE FUNCTION korvi_test_refuse_stock_audit() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."eventType" = 'inventory.adjustment.finalized' THEN
          RAISE EXCEPTION 'korvi test fault: stock audit refused';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER korvi_test_refuse_stock_audit
        BEFORE INSERT ON "audit_events"
        FOR EACH ROW EXECUTE FUNCTION korvi_test_refuse_stock_audit();`);

    const operationId = `late-${newId()}`;
    const failed = await refusal(() =>
      adjust({
        operationId,
        branchId: T.branchA,
        reason: 'تلف',
        lines: [{ productId: T.milk, deltaQuantityScaled: '-1000' }],
      }),
    );
    expect(failed.message).toMatch(/korvi test fault/);

    await fault.query(`
      DROP TRIGGER korvi_test_refuse_stock_audit ON "audit_events";
      DROP FUNCTION korvi_test_refuse_stock_audit();`);
    await fault.end();

    // The movement is gone with the balance it moved, and the revision did not
    // step. Half an adjustment is not a state Korvi has.
    expect(await balanceOf(T.branchA, T.milk)).toEqual(before);
    const residue = await withTenant(prisma, scope.tenantId, async (tx) => ({
      documents: await tx.inventoryAdjustment.count({ where: { operationId } }),
      movements: await tx.inventoryMovement.count({
        where: { tenantId: T.tenant, sourceType: 'inventory-adjustment', reason: 'تلف' },
      }),
      key: await tx.idempotencyKey.count({
        where: { scope: 'inventory-adjustment', operationId },
      }),
    }));
    expect(residue.documents).toBe(0);
    expect(residue.key).toBe(0);
    expect(residue.movements).toBe(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 5, 6, 7 — idempotency
  // -------------------------------------------------------------------------

  it('replays the same intent and refuses a changed one under the same operation id', async () => {
    await setQuantity(T.branchA, T.milk, 10_000n);
    const operationId = `replay-${newId()}`;
    const request: AdjustmentRequest = {
      operationId,
      branchId: T.branchA,
      reason: 'جرد',
      lines: [{ productId: T.milk, deltaQuantityScaled: '-1000' }],
    };

    const first = await adjust(request);
    const afterFirst = await balanceOf(T.branchA, T.milk);

    // Same intent, different line order and padded whitespace: still a replay.
    const replayed = await adjust({
      ...request,
      reason: '  جرد  ',
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.id).toBe(first.id);
    expect(replayed.lines).toEqual(first.lines);
    // And the stock did not move a second time.
    expect(await balanceOf(T.branchA, T.milk)).toEqual(afterFirst);

    const conflict = await refusal(() =>
      adjust({ ...request, lines: [{ productId: T.milk, deltaQuantityScaled: '-2000' }] }),
    );
    expect((conflict as StockOperationRefusedError).detail).toBe('idempotency-conflict');
    expect(await balanceOf(T.branchA, T.milk)).toEqual(afterFirst);

    const documents = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryAdjustment.count({ where: { operationId } }),
    );
    expect(documents).toBe(1);
  }, 60_000);

  it('commits exactly once when duplicate submissions arrive together', async () => {
    await setQuantity(T.branchA, T.milk, 10_000n);
    const before = await balanceOf(T.branchA, T.milk);
    if (before === null) throw new Error('no opening balance');

    const request: AdjustmentRequest = {
      operationId: `race-${newId()}`,
      branchId: T.branchA,
      reason: 'ازدواج',
      lines: [{ productId: T.milk, deltaQuantityScaled: '-1000' }],
    };

    // Two connections, one operation id. `ON CONFLICT DO NOTHING` blocks on the
    // uncommitted row, so the loser waits and then reads the winner's document
    // rather than ringing up a second adjustment.
    const settled = await within(
      'duplicate submissions',
      30_000,
      Promise.allSettled([
        recordInventoryAdjustment(prisma, actor, request, fingerprintAdjustment(request, T.user)),
        recordInventoryAdjustment(second, actor, request, fingerprintAdjustment(request, T.user)),
      ]),
    );

    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);
    const ids = new Set(
      fulfilled.map((entry) =>
        entry.status === 'fulfilled' ? (entry.value as { id: string }).id : '',
      ),
    );
    // Both callers were answered, and both were answered with one document.
    expect(ids.size).toBe(1);

    const after = await balanceOf(T.branchA, T.milk);
    expect(after?.quantityScaled).toBe(before.quantityScaled - 1000n);
    expect(after?.revision).toBe(before.revision + 1n);

    const committedId = [...ids][0] ?? '';
    const documents = await withTenant(prisma, scope.tenantId, async (tx) => ({
      headers: await tx.inventoryAdjustment.count({ where: { operationId: request.operationId } }),
      movements: await tx.inventoryMovement.count({
        where: { tenantId: T.tenant, sourceId: committedId },
      }),
    }));
    expect(documents).toEqual({ headers: 1, movements: 1 });
  }, 60_000);

  // -------------------------------------------------------------------------
  // 8 — the negative-stock floor, under concurrency
  // -------------------------------------------------------------------------

  it('cannot race a negative adjustment below zero when the merchant forbids it', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.rice, 3_000n);

    const one: AdjustmentRequest = {
      operationId: `floor-a-${newId()}`,
      branchId: T.branchA,
      reason: 'صرف',
      lines: [{ productId: T.rice, deltaQuantityScaled: '-2000' }],
    };
    const two: AdjustmentRequest = { ...one, operationId: `floor-b-${newId()}` };

    // Both would pass a preflight read of 3 units. Only one can pass the
    // mutation, because the second evaluates its floor after the first's lock
    // is released and sees 1 unit left.
    const settled = await within(
      'concurrent negative adjustments',
      30_000,
      Promise.allSettled([
        recordInventoryAdjustment(prisma, actor, one, fingerprintAdjustment(one, T.user)),
        recordInventoryAdjustment(second, actor, two, fingerprintAdjustment(two, T.user)),
      ]),
    );

    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((entry) => entry.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(StockOperationRefusedError);
    expect(((rejected as PromiseRejectedResult).reason as StockOperationRefusedError).detail).toBe(
      'insufficient-stock',
    );

    const after = await balanceOf(T.branchA, T.rice);
    expect(after?.quantityScaled).toBe(1_000n);
    expect(after?.quantityScaled).toBeGreaterThanOrEqual(0n);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 9, 10, 11 — counting
  // -------------------------------------------------------------------------

  it('derives the exact delta from an absolute observation under the lock', async () => {
    await setQuantity(T.branchA, T.milk, 10_000n);
    const before = await balanceOf(T.branchA, T.milk);
    if (before === null) throw new Error('no opening balance');

    const result = await countStock({
      operationId: `count-${newId()}`,
      branchId: T.branchA,
      reason: 'جرد نصف سنوي',
      lines: [
        {
          productId: T.milk,
          countedQuantityScaled: '7000',
          expectedRevision: before.revision.toString(),
        },
      ],
    });

    // The client said "there are seven"; the server worked out "that is three
    // fewer than the book" and wrote that.
    expect(result.lines[0]?.deltaQuantityScaled).toBe((7_000n - before.quantityScaled).toString());
    expect(result.lines[0]?.countedQuantityScaled).toBe('7000');

    const after = await balanceOf(T.branchA, T.milk);
    expect(after?.quantityScaled).toBe(7_000n);
    expect(after?.revision).toBe(before.revision + 1n);

    const movements = await movementsFor(result.id);
    expect(movements).toHaveLength(1);
    // The stock effect is an adjustment; the source says a count caused it.
    expect(movements[0]?.kind).toBe('adjustment');
  }, 60_000);

  it('records a zero-delta count as evidence with no movement and no revision step', async () => {
    await setQuantity(T.branchA, T.milk, 5_000n);
    const before = await balanceOf(T.branchA, T.milk);
    if (before === null) throw new Error('no opening balance');

    const result = await countStock({
      operationId: `count-zero-${newId()}`,
      branchId: T.branchA,
      reason: null,
      lines: [
        {
          productId: T.milk,
          countedQuantityScaled: '5000',
          expectedRevision: before.revision.toString(),
        },
      ],
    });

    expect(result.lines[0]?.deltaQuantityScaled).toBe('0');
    expect(result.lines[0]?.resultRevision).toBe(before.revision.toString());

    const after = await balanceOf(T.branchA, T.milk);
    // The shelf agreed with the book: nothing happened, so nothing is recorded
    // as having happened.
    expect(after).toEqual(before);
    expect(await movementsFor(result.id)).toHaveLength(0);

    // But the evidence that somebody looked is kept.
    const evidence = await withTenant(prisma, scope.tenantId, async (tx) => ({
      header: await tx.inventoryCount.count({ where: { id: result.id } }),
      lines: await tx.inventoryCountLine.count({ where: { countId: result.id } }),
      audit: await tx.auditEvent.count({
        where: { entityId: result.id, eventType: 'inventory.count.finalized' },
      }),
    }));
    expect(evidence).toEqual({ header: 1, lines: 1, audit: 1 });
  }, 60_000);

  it('refuses a count whose revision was overtaken, and writes nothing', async () => {
    await allowNegative(true);
    await setQuantity(T.branchA, T.milk, 20_000n);
    const observed = await balanceOf(T.branchA, T.milk);
    if (observed === null) throw new Error('no opening balance');

    // The counter walks the aisle. Meanwhile a sale happens.
    const sale = await checkout.checkout({
      principal: {
        tenantId: T.tenant,
        tenantSlug: T.slug,
        userId: T.user,
        sessionId: newId(),
        email: 'sara@stock-live-a.test',
        displayName: 'سارة',
        roles: ['cashier'],
        permissions: ['sale.create', 'product.read'],
        maxDiscountBasisPoints: 0n,
        branchId: T.branchA,
      } satisfies AuthenticatedPrincipal,
      operationId: newId(),
      terminalId: T.terminal,
      cashReceivedMinor: '10000',
      lines: [{ productId: T.milk, quantityScaled: '2000' }],
    });
    if (sale.outcome !== 'success') throw new Error(`checkout failed: ${sale.reason}`);

    const moved = await balanceOf(T.branchA, T.milk);
    // The sale went through the shared primitive, so it stepped the revision —
    // which is the only reason the count below can notice it.
    expect(moved?.revision).toBe(observed.revision + 1n);

    // Totals, so "wrote nothing" is measured against the whole tenant rather
    // than against a filter that another test's rows could satisfy.
    const totalsBefore = await withTenant(prisma, scope.tenantId, async (tx) => ({
      counts: await tx.inventoryCount.count({ where: { tenantId: T.tenant } }),
      lines: await tx.inventoryCountLine.count({ where: { tenantId: T.tenant } }),
      movements: await tx.inventoryMovement.count({ where: { tenantId: T.tenant } }),
      keys: await tx.idempotencyKey.count({
        where: { tenantId: T.tenant, scope: 'inventory-count' },
      }),
    }));

    const operationId = `stale-${newId()}`;
    const stale = await refusal(() =>
      countStock({
        operationId,
        branchId: T.branchA,
        reason: 'جرد',
        lines: [
          {
            productId: T.milk,
            countedQuantityScaled: '20000',
            expectedRevision: observed.revision.toString(),
          },
        ],
      }),
    );
    expect((stale as StockOperationRefusedError).detail).toBe('stock-changed');

    // Zero residue, and — the point of the whole mechanism — the sale is still
    // there. A silent overwrite would have restored the sold stock.
    expect(await balanceOf(T.branchA, T.milk)).toEqual(moved);
    const totalsAfter = await withTenant(prisma, scope.tenantId, async (tx) => ({
      counts: await tx.inventoryCount.count({ where: { tenantId: T.tenant } }),
      lines: await tx.inventoryCountLine.count({ where: { tenantId: T.tenant } }),
      movements: await tx.inventoryMovement.count({ where: { tenantId: T.tenant } }),
      keys: await tx.idempotencyKey.count({
        where: { tenantId: T.tenant, scope: 'inventory-count' },
      }),
    }));
    // Not one row anywhere: no header, no line, no movement, no reservation.
    expect(totalsAfter).toEqual(totalsBefore);
    const named = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryCount.count({ where: { operationId } }),
    );
    expect(named).toBe(0);

    // Recounting against current truth succeeds.
    const fresh = await balanceOf(T.branchA, T.milk);
    const recount = await countStock({
      operationId: `recount-${newId()}`,
      branchId: T.branchA,
      reason: 'إعادة جرد',
      lines: [
        {
          productId: T.milk,
          countedQuantityScaled: '20000',
          expectedRevision: (fresh?.revision ?? 0n).toString(),
        },
      ],
    });
    expect(recount.lines[0]?.deltaQuantityScaled).toBe('2000');
  }, 90_000);

  it('treats an absent balance as revision zero and still notices a first movement', async () => {
    // A product that has never moved in this branch has no row at all.
    const missing = await balanceOf(T.branchB, T.rice);
    expect(missing).toBeNull();

    // A first movement lands while the counter is walking.
    await adjust({
      operationId: `first-${newId()}`,
      branchId: T.branchB,
      reason: 'استلام',
      lines: [{ productId: T.rice, deltaQuantityScaled: '4000' }],
    });
    const created = await balanceOf(T.branchB, T.rice);
    expect(created?.revision).toBe(1n);

    // The counter still believes it was absent, i.e. revision zero.
    const stale = await refusal(() =>
      countStock({
        operationId: `absent-${newId()}`,
        branchId: T.branchB,
        reason: null,
        lines: [{ productId: T.rice, countedQuantityScaled: '0', expectedRevision: '0' }],
      }),
    );
    expect((stale as StockOperationRefusedError).detail).toBe('stock-changed');
    expect(await balanceOf(T.branchB, T.rice)).toEqual(created);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 12, 13, 14, 15 — transfers
  // -------------------------------------------------------------------------

  it('writes exactly two legs per product and conserves total tenant quantity', async () => {
    await setQuantity(T.branchA, T.milk, 10_000n);
    await setQuantity(T.branchB, T.milk, 1_000n);
    const before = {
      a: await balanceOf(T.branchA, T.milk),
      b: await balanceOf(T.branchB, T.milk),
    };
    const total = (before.a?.quantityScaled ?? 0n) + (before.b?.quantityScaled ?? 0n);

    const result = await transfer({
      operationId: `transfer-${newId()}`,
      fromBranchId: T.branchA,
      toBranchId: T.branchB,
      reason: 'إعادة توزيع',
      lines: [{ productId: T.milk, quantityScaled: '3000' }],
    });

    const after = {
      a: await balanceOf(T.branchA, T.milk),
      b: await balanceOf(T.branchB, T.milk),
    };
    expect(after.a?.quantityScaled).toBe((before.a?.quantityScaled ?? 0n) - 3_000n);
    expect(after.b?.quantityScaled).toBe((before.b?.quantityScaled ?? 0n) + 3_000n);
    // Nothing was created and nothing destroyed: stock moved.
    expect((after.a?.quantityScaled ?? 0n) + (after.b?.quantityScaled ?? 0n)).toBe(total);
    expect(after.a?.revision).toBe((before.a?.revision ?? 0n) + 1n);
    expect(after.b?.revision).toBe((before.b?.revision ?? 0n) + 1n);

    const movements = await movementsFor(result.id);
    expect(movements).toHaveLength(2);
    expect(movements.map((row) => row.quantityScaled)).toEqual([-3_000n, 3_000n]);
    expect(movements.every((row) => row.kind === 'transfer')).toBe(true);
    // Both legs name the same line, which is what makes them one movement of
    // goods rather than two unrelated ledger rows.
    expect(new Set(movements.map((row) => row.sourceLineId)).size).toBe(1);
    expect(movements[0]?.sourceLineId).not.toBeNull();
  }, 60_000);

  it('writes neither leg when the source cannot cover the transfer', async () => {
    // Even with oversell enabled for the till: a branch cannot carry goods it
    // does not physically have to another branch.
    await allowNegative(true);
    await setQuantity(T.branchA, T.rice, 1_000n);
    await setQuantity(T.branchB, T.rice, 0n);
    const before = {
      a: await balanceOf(T.branchA, T.rice),
      b: await balanceOf(T.branchB, T.rice),
    };

    const operationId = `short-${newId()}`;
    const failed = await refusal(() =>
      transfer({
        operationId,
        fromBranchId: T.branchA,
        toBranchId: T.branchB,
        reason: null,
        lines: [{ productId: T.rice, quantityScaled: '5000' }],
      }),
    );
    expect((failed as StockOperationRefusedError).detail).toBe('insufficient-stock');

    expect(await balanceOf(T.branchA, T.rice)).toEqual(before.a);
    expect(await balanceOf(T.branchB, T.rice)).toEqual(before.b);
    const residue = await withTenant(prisma, scope.tenantId, async (tx) => ({
      documents: await tx.inventoryTransfer.count({ where: { operationId } }),
      key: await tx.idempotencyKey.count({ where: { scope: 'inventory-transfer', operationId } }),
    }));
    expect(residue).toEqual({ documents: 0, key: 0 });
    await allowNegative(false);
  }, 60_000);

  it('completes opposite-direction concurrent transfers without deadlocking', async () => {
    await setQuantity(T.branchA, T.milk, 50_000n);
    await setQuantity(T.branchB, T.milk, 50_000n);
    await setQuantity(T.branchA, T.rice, 50_000n);
    await setQuantity(T.branchB, T.rice, 50_000n);

    const totalBefore =
      (await balanceOf(T.branchA, T.milk))!.quantityScaled +
      (await balanceOf(T.branchB, T.milk))!.quantityScaled +
      (await balanceOf(T.branchA, T.rice))!.quantityScaled +
      (await balanceOf(T.branchB, T.rice))!.quantityScaled;

    // A→B and B→A over the same two products at the same instant. Without a
    // canonical lock order each would hold one row and wait for the other.
    // The products are listed in opposite orders too, so the ordering cannot
    // come from the request.
    const forward: TransferRequest = {
      operationId: `dead-a-${newId()}`,
      fromBranchId: T.branchA,
      toBranchId: T.branchB,
      reason: null,
      lines: [
        { productId: T.milk, quantityScaled: '1000' },
        { productId: T.rice, quantityScaled: '1000' },
      ],
    };
    const backward: TransferRequest = {
      operationId: `dead-b-${newId()}`,
      fromBranchId: T.branchB,
      toBranchId: T.branchA,
      reason: null,
      lines: [
        { productId: T.rice, quantityScaled: '1000' },
        { productId: T.milk, quantityScaled: '1000' },
      ],
    };

    const settled = await within(
      'opposite-direction transfers',
      30_000,
      Promise.allSettled([
        recordInventoryTransfer(prisma, actor, forward, fingerprintTransfer(forward, T.user)),
        recordInventoryTransfer(second, actor, backward, fingerprintTransfer(backward, T.user)),
      ]),
    );

    for (const entry of settled) {
      if (entry.status === 'rejected') {
        // A deadlock would surface here as 40P01. Naming it makes the failure
        // legible rather than "something rejected".
        throw new Error(`a transfer failed: ${String((entry.reason as Error).message)}`);
      }
    }

    const totalAfter =
      (await balanceOf(T.branchA, T.milk))!.quantityScaled +
      (await balanceOf(T.branchB, T.milk))!.quantityScaled +
      (await balanceOf(T.branchA, T.rice))!.quantityScaled +
      (await balanceOf(T.branchB, T.rice))!.quantityScaled;
    expect(totalAfter).toBe(totalBefore);
  }, 90_000);

  it('cannot let a sale and a transfer oversell the same branch', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.milk, 3_000n);
    await setQuantity(T.branchB, T.milk, 0n);

    const principal: AuthenticatedPrincipal = {
      tenantId: T.tenant,
      tenantSlug: T.slug,
      userId: T.user,
      sessionId: newId(),
      email: 'sara@stock-live-a.test',
      displayName: 'سارة',
      roles: ['cashier'],
      permissions: ['sale.create', 'product.read'],
      maxDiscountBasisPoints: 0n,
      branchId: T.branchA,
    };

    const move: TransferRequest = {
      operationId: `oversell-${newId()}`,
      fromBranchId: T.branchA,
      toBranchId: T.branchB,
      reason: null,
      lines: [{ productId: T.milk, quantityScaled: '2000' }],
    };

    const settled = await within(
      'sale against transfer',
      30_000,
      Promise.allSettled([
        recordInventoryTransfer(prisma, actor, move, fingerprintTransfer(move, T.user)),
        checkout.checkout({
          principal,
          operationId: newId(),
          terminalId: T.terminal,
          cashReceivedMinor: '10000',
          lines: [{ productId: T.milk, quantityScaled: '2000' }],
        }),
      ]),
    );

    // Neither contender was allowed to hang: a deadlock here would have been a
    // timeout rather than a result.
    expect(settled).toHaveLength(2);
    for (const entry of settled) {
      if (entry.status === 'rejected') {
        const message = String((entry.reason as Error).message);
        // A refusal is a legitimate outcome; a deadlock is not.
        expect(message, 'transfer must not deadlock').not.toMatch(/deadlock/i);
      }
    }

    const [transferOutcome, saleOutcome] = settled;
    const transferCommitted = transferOutcome?.status === 'fulfilled';
    const saleCommitted =
      saleOutcome?.status === 'fulfilled' &&
      (saleOutcome.value as { outcome: string }).outcome === 'success';

    // The invariant this test exists for. Three units cannot satisfy a sale of
    // two *and* a transfer of two, so the two consumptions cannot both commit —
    // whichever of them wins the race.
    expect(
      transferCommitted && saleCommitted,
      'a sale of 2 and a transfer of 2 both committed against 3 units',
    ).toBe(false);
    // And the pair is not allowed to both fail for want of a lock: exactly one
    // of two lawful operations against sufficient stock must get through.
    expect(transferCommitted || saleCommitted).toBe(true);

    const after = await balanceOf(T.branchA, T.milk);
    const destination = await balanceOf(T.branchB, T.milk);
    const source = after?.quantityScaled ?? 0n;
    const moved = destination?.quantityScaled ?? 0n;

    // The source never goes below zero, whichever committed.
    expect(source).toBeGreaterThanOrEqual(0n);
    expect(moved).toBeGreaterThanOrEqual(0n);

    // Conservation, stated exactly rather than as a disjunction of guesses:
    // a transfer moves stock and conserves the pair's total, a sale consumes
    // it. Started at 3 in the source and 0 in the destination.
    const consumedBySale = saleCommitted ? 2_000n : 0n;
    expect(source + moved).toBe(3_000n - consumedBySale);
    // And the destination holds exactly what the transfer moved, or nothing.
    expect(moved).toBe(transferCommitted ? 2_000n : 0n);
  }, 90_000);

  it('serialises cost bootstrap against a sale without losing stock or value', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.costSale, 10_000n);
    const before = await balanceOf(T.branchA, T.costSale);
    if (before === null) throw new Error('no opening bootstrap/sale balance');

    const bootstrapRequest = {
      operationId: `bootstrap-sale-${newId()}`,
      branchId: T.branchA,
      productId: T.costSale,
      totalValueMinor: '100',
    };
    const principal: AuthenticatedPrincipal = {
      tenantId: T.tenant,
      tenantSlug: T.slug,
      userId: T.user,
      sessionId: newId(),
      email: 'sara@stock-live-a.test',
      displayName: 'سارة',
      roles: ['cashier'],
      permissions: ['sale.create', 'product.read'],
      maxDiscountBasisPoints: 0n,
      branchId: T.branchA,
    };

    const raced = await behindBalanceGate(T.costSale, 'bootstrap against sale', () =>
      Promise.allSettled([
        recordInventoryCostBootstrap(
          second,
          actor,
          bootstrapRequest,
          fingerprintCostBootstrap(bootstrapRequest, T.user),
        ),
        checkout.checkout({
          principal,
          operationId: newId(),
          terminalId: T.terminal,
          cashReceivedMinor: '10000',
          lines: [{ productId: T.costSale, quantityScaled: '2000' }],
        }),
      ]),
    );
    expect(raced.blocked, 'bootstrap and sale were not both waiting behind the held row').toBe(2);

    const [bootstrapOutcome, saleOutcome] = raced.result;
    if (bootstrapOutcome?.status !== 'fulfilled') {
      throw new Error(`bootstrap failed: ${String(bootstrapOutcome?.reason)}`);
    }
    if (saleOutcome === undefined) throw new Error('sale failed: missing result');
    if (saleOutcome.status === 'rejected') {
      throw new Error(`sale failed: ${String(saleOutcome.reason)}`);
    }
    if (saleOutcome.value.outcome !== 'success') {
      throw new Error(`sale refused: ${saleOutcome.value.reason}`);
    }

    const valuedQuantity = BigInt(bootstrapOutcome.value.valuedQuantityScaled);
    expect([8_000n, 10_000n]).toContain(valuedQuantity);
    const stock = await balanceOf(T.branchA, T.costSale);
    const cost = await costOf(T.branchA, T.costSale);
    expect(stock).toEqual({ quantityScaled: 8_000n, revision: before.revision + 1n });
    expect(cost).toMatchObject({
      knownQuantityScaled: 8_000n,
      knownValueMinor: valuedQuantity === 10_000n ? 80n : 100n,
      stockRevision: stock?.revision,
      costRevision: valuedQuantity === 10_000n ? 2n : 1n,
    });
  }, 90_000);

  it('serialises cost bootstrap against transfer and conserves the exact basis', async () => {
    await setQuantity(T.branchA, T.costTransfer, 10_000n);
    await setQuantity(T.branchB, T.costTransfer, 0n);

    const bootstrapRequest = {
      operationId: `bootstrap-transfer-${newId()}`,
      branchId: T.branchA,
      productId: T.costTransfer,
      totalValueMinor: '100',
    };
    const move: TransferRequest = {
      operationId: `bootstrap-race-transfer-${newId()}`,
      fromBranchId: T.branchA,
      toBranchId: T.branchB,
      reason: null,
      lines: [{ productId: T.costTransfer, quantityScaled: '2000' }],
    };

    const raced = await behindBalanceGate(T.costTransfer, 'bootstrap against transfer', () =>
      Promise.allSettled([
        recordInventoryCostBootstrap(
          second,
          actor,
          bootstrapRequest,
          fingerprintCostBootstrap(bootstrapRequest, T.user),
        ),
        recordInventoryTransfer(prisma, actor, move, fingerprintTransfer(move, T.user)),
      ]),
    );
    expect(raced.blocked, 'bootstrap and transfer were not both waiting behind the held row').toBe(
      2,
    );

    const [bootstrapOutcome, transferOutcome] = raced.result;
    if (bootstrapOutcome?.status !== 'fulfilled') {
      throw new Error(`bootstrap failed: ${String(bootstrapOutcome?.reason)}`);
    }
    if (transferOutcome?.status !== 'fulfilled') {
      throw new Error(`transfer failed: ${String(transferOutcome?.reason)}`);
    }

    const valuedQuantity = BigInt(bootstrapOutcome.value.valuedQuantityScaled);
    expect([8_000n, 10_000n]).toContain(valuedQuantity);
    const [sourceStock, destinationStock, sourceCost, destinationCost] = await Promise.all([
      balanceOf(T.branchA, T.costTransfer),
      balanceOf(T.branchB, T.costTransfer),
      costOf(T.branchA, T.costTransfer),
      costOf(T.branchB, T.costTransfer),
    ]);
    expect(sourceStock?.quantityScaled).toBe(8_000n);
    expect(destinationStock?.quantityScaled).toBe(2_000n);
    expect(sourceCost?.knownQuantityScaled).toBe(8_000n);
    expect(sourceCost?.knownValueMinor).toBe(valuedQuantity === 10_000n ? 80n : 100n);
    expect(destinationCost?.knownQuantityScaled).toBe(valuedQuantity === 10_000n ? 2_000n : 0n);
    expect(destinationCost?.knownValueMinor).toBe(valuedQuantity === 10_000n ? 20n : 0n);
    expect(
      (sourceCost?.knownQuantityScaled ?? 0n) + (destinationCost?.knownQuantityScaled ?? 0n),
    ).toBe(valuedQuantity);
    expect((sourceCost?.knownValueMinor ?? 0n) + (destinationCost?.knownValueMinor ?? 0n)).toBe(
      100n,
    );
  }, 90_000);

  // -------------------------------------------------------------------------
  // Stale authority facts
  //
  // Each of these holds an *uncommitted* change to a fact the operation depends
  // on, then starts the operation. If the operation read the fact instead of
  // holding it, it would sail past the uncommitted change and commit against a
  // world that is about to disagree with it.
  // -------------------------------------------------------------------------

  /** Hold an uncommitted change on another connection, then release it. */
  async function whileUncommitted<T>(
    sql: string,
    params: readonly unknown[],
    work: () => Promise<T>,
  ): Promise<{ blocked: boolean; result: PromiseSettledResult<T> }> {
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query("SELECT set_config('app.tenant_id', $1, true)", [T.tenant]);
    await holder.query(sql, [...params]);

    // Settled immediately rather than awaited later. The operation may reject
    // while this test is still sleeping, and a rejection nobody is awaiting yet
    // is an unhandled rejection — which Vitest reports as a run-level error
    // even though every assertion passes.
    const started = work().then(
      (value) => ({ status: 'fulfilled', value }) as PromiseSettledResult<T>,
      (reason: unknown) => ({ status: 'rejected', reason }) as PromiseSettledResult<T>,
    );

    // Give the operation a chance to run past the fact if it is going to.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const { rows } = await holder.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
    );
    const blocked = Number(rows[0]?.n ?? '0') > 0;

    await holder.query('COMMIT');
    await holder.end();
    return { blocked, result: await within('operation under uncommitted change', 30_000, started) };
  }

  /** Start real contenders behind one held stock row, then release them together. */
  async function behindBalanceGate<T>(
    productId: string,
    label: string,
    work: () => Promise<T>,
  ): Promise<{ blocked: number; result: T }> {
    const gate = new pg.Client({ connectionString: url });
    await gate.connect();
    await gate.query('BEGIN');
    await gate.query("SELECT set_config('app.tenant_id', $1, true)", [T.tenant]);
    const gatePidResult = await gate.query<{ pid: number }>(
      'SELECT pg_backend_pid()::integer AS pid',
    );
    const gatePid = gatePidResult.rows[0]?.pid;
    if (gatePid === undefined) throw new Error('balance gate backend PID was not returned');
    await gate.query(
      `SELECT "revision" FROM "inventory_balances"
        WHERE "tenantId" = $1::uuid AND "branchId" = $2::uuid AND "productId" = $3::uuid
        FOR UPDATE`,
      [T.tenant, T.branchA, productId],
    );

    const started = work();
    let blocked = 0;
    for (let attempt = 0; attempt < 50 && blocked < 2; attempt += 1) {
      const { rows } = await gate.query<{ n: string }>(
        `WITH RECURSIVE waiters(pid) AS (
           SELECT pid
             FROM pg_stat_activity
            WHERE $1::integer = ANY(pg_blocking_pids(pid))
           UNION
           SELECT activity.pid
             FROM pg_stat_activity AS activity
             JOIN waiters ON waiters.pid = ANY(pg_blocking_pids(activity.pid))
         )
         SELECT count(*)::text AS n FROM waiters`,
        [gatePid],
      );
      blocked = Number(rows[0]?.n ?? '0');
      if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await gate.query('COMMIT');
    await gate.end();
    return { blocked, result: await within(label, 30_000, started) };
  }

  it('cannot commit a stock mutation on a branch that is being deactivated', async () => {
    await setQuantity(T.branchA, T.milk, 10_000n);
    const before = await balanceOf(T.branchA, T.milk);

    const { blocked, result } = await whileUncommitted(
      `UPDATE "branches" SET "isActive" = FALSE, "updatedAt" = now()
        WHERE "tenantId" = $1::uuid AND "id" = '${T.branchA}'::uuid`,
      [T.tenant],
      () =>
        adjust({
          operationId: `stale-branch-${newId()}`,
          branchId: T.branchA,
          reason: 'محاولة',
          lines: [{ productId: T.milk, deltaQuantityScaled: '-1000' }],
        }),
    );

    // It waited for the deactivation rather than reading around it...
    expect(blocked, 'the adjustment did not block on the branch row').toBe(true);
    // ...and then saw the committed truth and refused.
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(StockOperationRefusedError);
    expect(((result as PromiseRejectedResult).reason as StockOperationRefusedError).detail).toBe(
      'inactive-branch',
    );
    expect(await balanceOf(T.branchA, T.milk)).toEqual(before);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.branch.updateMany({
        where: { tenantId: T.tenant, id: T.branchA },
        data: { isActive: true },
      });
    });
  }, 90_000);

  it('cannot commit a stock mutation on a product whose tracking is being turned off', async () => {
    await setQuantity(T.branchA, T.rice, 10_000n);
    const before = await balanceOf(T.branchA, T.rice);

    const { blocked, result } = await whileUncommitted(
      `UPDATE "products" SET "trackInventory" = FALSE, "updatedAt" = now()
        WHERE "tenantId" = $1::uuid AND "id" = '${T.rice}'::uuid`,
      [T.tenant],
      () =>
        adjust({
          operationId: `stale-product-${newId()}`,
          branchId: T.branchA,
          reason: 'محاولة',
          lines: [{ productId: T.rice, deltaQuantityScaled: '-1000' }],
        }),
    );

    expect(blocked, 'the adjustment did not block on the product row').toBe(true);
    expect(result.status).toBe('rejected');
    expect(((result as PromiseRejectedResult).reason as StockOperationRefusedError).detail).toBe(
      'untracked-product',
    );
    expect(await balanceOf(T.branchA, T.rice)).toEqual(before);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.updateMany({
        where: { tenantId: T.tenant, id: T.rice },
        data: { trackInventory: true },
      });
    });
  }, 90_000);

  it('cannot commit a negative adjustment on a stale allowNegativeStock', async () => {
    await allowNegative(true);
    await setQuantity(T.branchA, T.scale, 1_000n);
    const before = await balanceOf(T.branchA, T.scale);

    // The merchant turns overselling off while an adjustment that depends on it
    // is in flight. Reading the setting rather than holding it would let the
    // adjustment commit a negative balance the merchant has just forbidden.
    const { blocked, result } = await whileUncommitted(
      `UPDATE "tenant_settings" SET "allowNegativeStock" = FALSE, "updatedAt" = now()
        WHERE "tenantId" = $1::uuid`,
      [T.tenant],
      () =>
        adjust({
          operationId: `stale-policy-${newId()}`,
          branchId: T.branchA,
          reason: 'سحب',
          lines: [{ productId: T.scale, deltaQuantityScaled: '-5000' }],
        }),
    );

    expect(blocked, 'the adjustment did not block on tenant_settings').toBe(true);
    expect(result.status).toBe('rejected');
    expect(((result as PromiseRejectedResult).reason as StockOperationRefusedError).detail).toBe(
      'insufficient-stock',
    );
    expect(await balanceOf(T.branchA, T.scale)).toEqual(before);
    expect((await balanceOf(T.branchA, T.scale))?.quantityScaled).toBeGreaterThanOrEqual(0n);
    await allowNegative(false);
  }, 90_000);

  it('serialises against the branch lock checkout and returns already take', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.milk, 10_000n);

    // A third connection holds the branch row exactly as checkout's
    // `allocateReceipt` does. If Stage-5 did not join that boundary it would
    // sail straight past and mutate stock beside an in-flight sale.
    const gate = new pg.Client({ connectionString: url });
    await gate.connect();
    await gate.query('BEGIN');
    await gate.query("SELECT set_config('app.tenant_id', $1, true)", [T.tenant]);
    await gate.query(
      'SELECT "code" FROM "branches" WHERE "tenantId" = $1::uuid AND "id" = $2::uuid FOR UPDATE',
      [T.tenant, T.branchA],
    );

    const running = adjust({
      operationId: `branch-gate-${newId()}`,
      branchId: T.branchA,
      reason: 'جرد',
      lines: [{ productId: T.milk, deltaQuantityScaled: '-1000' }],
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    const { rows } = await gate.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
    );
    expect(Number(rows[0]?.n ?? '0'), 'Stage-5 did not wait on the branch row').toBeGreaterThan(0);

    await gate.query('COMMIT');
    await gate.end();

    // Released, it completes normally — the boundary serialises, it does not
    // refuse.
    const done = await within('adjustment after branch gate', 30_000, running);
    expect(done.lines).toHaveLength(1);
  }, 90_000);

  it('does not deadlock a multi-product transfer against a multi-product sale', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.milk, 50_000n);
    await setQuantity(T.branchA, T.rice, 50_000n);
    await setQuantity(T.branchB, T.milk, 0n);
    await setQuantity(T.branchB, T.rice, 0n);

    // Opposite product ordering on purpose: the sale lists milk then rice, the
    // transfer rice then milk. Any lock order taken from the request rather
    // than from the rows would cross here.
    const move: TransferRequest = {
      operationId: `multi-${newId()}`,
      fromBranchId: T.branchA,
      toBranchId: T.branchB,
      reason: null,
      lines: [
        { productId: T.rice, quantityScaled: '1000' },
        { productId: T.milk, quantityScaled: '1000' },
      ],
    };

    const settled = await within(
      'multi-product sale against multi-product transfer',
      30_000,
      Promise.allSettled([
        recordInventoryTransfer(prisma, actor, move, fingerprintTransfer(move, T.user)),
        checkout.checkout({
          principal: {
            tenantId: T.tenant,
            tenantSlug: T.slug,
            userId: T.user,
            sessionId: newId(),
            email: 'sara@stock-live-a.test',
            displayName: 'سارة',
            roles: ['cashier'],
            permissions: ['sale.create', 'product.read'],
            maxDiscountBasisPoints: 0n,
            branchId: T.branchA,
          },
          operationId: newId(),
          terminalId: T.terminal,
          cashReceivedMinor: '100000',
          lines: [
            { productId: T.milk, quantityScaled: '1000' },
            { productId: T.rice, quantityScaled: '1000' },
          ],
        }),
      ]),
    );

    for (const entry of settled) {
      if (entry.status === 'rejected') {
        expect(String((entry.reason as Error).message)).not.toMatch(/deadlock/i);
      }
    }
    // Both are lawful against 50 units each, so both must commit.
    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(2);

    // Conservation across both branches for both products.
    const total =
      (await balanceOf(T.branchA, T.milk))!.quantityScaled +
      (await balanceOf(T.branchB, T.milk))!.quantityScaled +
      (await balanceOf(T.branchA, T.rice))!.quantityScaled +
      (await balanceOf(T.branchB, T.rice))!.quantityScaled;
    // 100 in, minus the two units the sale consumed.
    expect(total).toBe(100_000n - 2_000n);
  }, 90_000);

  // -------------------------------------------------------------------------
  // Deterministic multi-line replay
  // -------------------------------------------------------------------------

  it('answers a multi-line replay identically however the lines were ordered', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.milk, 20_000n);
    await setQuantity(T.branchA, T.rice, 20_000n);

    const operationId = `multi-replay-${newId()}`;
    const first = await adjust({
      operationId,
      branchId: T.branchA,
      reason: 'جرد',
      // Submitted in one order...
      lines: [
        { productId: T.rice, deltaQuantityScaled: '-1000' },
        { productId: T.milk, deltaQuantityScaled: '-2000' },
      ],
    });
    const afterFirst = {
      milk: await balanceOf(T.branchA, T.milk),
      rice: await balanceOf(T.branchA, T.rice),
    };

    const replayed = await adjust({
      operationId,
      branchId: T.branchA,
      reason: 'جرد',
      // ...and retried in the other. The canonical form calls these one intent,
      // so the answer has to be one answer.
      lines: [
        { productId: T.milk, deltaQuantityScaled: '-2000' },
        { productId: T.rice, deltaQuantityScaled: '-1000' },
      ],
    });

    expect(replayed.replayed).toBe(true);
    expect(replayed.id).toBe(first.id);
    // Identical ordering, not merely identical contents.
    expect(replayed.lines).toEqual(first.lines);
    expect(first.lines.map((line) => line.productId)).toEqual(
      [...first.lines.map((line) => line.productId)].sort(),
    );
    // And nothing moved a second time.
    expect(await balanceOf(T.branchA, T.milk)).toEqual(afterFirst.milk);
    expect(await balanceOf(T.branchA, T.rice)).toEqual(afterFirst.rice);

    const written = await withTenant(prisma, scope.tenantId, async (tx) => ({
      documents: await tx.inventoryAdjustment.count({ where: { operationId } }),
      movements: await tx.inventoryMovement.count({
        where: { tenantId: T.tenant, sourceId: first.id },
      }),
    }));
    expect(written).toEqual({ documents: 1, movements: 2 });

    // A changed quantity under the same id is a different decision.
    const conflict = await refusal(() =>
      adjust({
        operationId,
        branchId: T.branchA,
        reason: 'جرد',
        lines: [
          { productId: T.milk, deltaQuantityScaled: '-2000' },
          { productId: T.rice, deltaQuantityScaled: '-9000' },
        ],
      }),
    );
    expect((conflict as StockOperationRefusedError).detail).toBe('idempotency-conflict');
  }, 90_000);

  it('answers a multi-line count replay identically however the lines were ordered', async () => {
    await setQuantity(T.branchA, T.milk, 8_000n);
    await setQuantity(T.branchA, T.rice, 8_000n);
    const milk = await balanceOf(T.branchA, T.milk);
    const rice = await balanceOf(T.branchA, T.rice);

    const operationId = `multi-count-${newId()}`;
    const build = (order: 'forward' | 'reverse'): CountRequest => {
      const lines = [
        {
          productId: T.milk,
          countedQuantityScaled: '7000',
          expectedRevision: (milk?.revision ?? 0n).toString(),
        },
        {
          productId: T.rice,
          countedQuantityScaled: '9000',
          expectedRevision: (rice?.revision ?? 0n).toString(),
        },
      ];
      return {
        operationId,
        branchId: T.branchA,
        reason: 'جرد',
        lines: order === 'forward' ? lines : [...lines].reverse(),
      };
    };

    const first = await countStock(build('forward'));
    const replayed = await countStock(build('reverse'));

    expect(replayed.replayed).toBe(true);
    expect(replayed.id).toBe(first.id);
    expect(replayed.lines).toEqual(first.lines);
    // Deltas derived by the server, one down and one up.
    expect(first.lines.map((line) => line.deltaQuantityScaled).sort()).toEqual(['-1000', '1000']);

    const conflict = await refusal(() =>
      countStock({
        ...build('forward'),
        branchId: T.branchB,
      }),
    );
    expect((conflict as StockOperationRefusedError).detail).toBe('idempotency-conflict');
  }, 90_000);

  it('answers a multi-line transfer replay identically however the lines were ordered', async () => {
    await setQuantity(T.branchA, T.milk, 30_000n);
    await setQuantity(T.branchA, T.rice, 30_000n);
    await setQuantity(T.branchB, T.milk, 0n);
    await setQuantity(T.branchB, T.rice, 0n);

    const operationId = `multi-transfer-${newId()}`;
    const lines = [
      { productId: T.milk, quantityScaled: '1000' },
      { productId: T.rice, quantityScaled: '2000' },
    ];

    const first = await transfer({
      operationId,
      fromBranchId: T.branchA,
      toBranchId: T.branchB,
      reason: null,
      lines,
    });
    const afterFirst = {
      milk: await balanceOf(T.branchB, T.milk),
      rice: await balanceOf(T.branchB, T.rice),
    };

    const replayed = await transfer({
      operationId,
      fromBranchId: T.branchA,
      toBranchId: T.branchB,
      reason: null,
      lines: [...lines].reverse(),
    });

    expect(replayed.replayed).toBe(true);
    expect(replayed.id).toBe(first.id);
    expect(replayed.lines).toEqual(first.lines);
    expect(await balanceOf(T.branchB, T.milk)).toEqual(afterFirst.milk);
    expect(await balanceOf(T.branchB, T.rice)).toEqual(afterFirst.rice);

    // Two legs per line, four movements, and no duplicates from the replay.
    expect(await movementsFor(first.id)).toHaveLength(4);

    // Reversing the direction under the same id is a different transfer.
    const conflict = await refusal(() =>
      transfer({
        operationId,
        fromBranchId: T.branchB,
        toBranchId: T.branchA,
        reason: null,
        lines,
      }),
    );
    expect((conflict as StockOperationRefusedError).detail).toBe('idempotency-conflict');
  }, 90_000);

  // -------------------------------------------------------------------------
  // Stock history outlives the branch record
  // -------------------------------------------------------------------------

  it('refuses to delete a branch that has finalized stock history', async () => {
    // A branch nothing else references: no terminal, no shift, no sale, no
    // return, no membership. Whatever refuses the delete below is therefore an
    // inventory-history constraint and not an unrelated one.
    const doomed = T.branchDoomed;
    const untouched = await withTenant(prisma, scope.tenantId, async (tx) => ({
      terminals: await tx.terminal.count({ where: { tenantId: T.tenant, branchId: doomed } }),
      shifts: await tx.shift.count({ where: { tenantId: T.tenant, branchId: doomed } }),
      sales: await tx.sale.count({ where: { tenantId: T.tenant, branchId: doomed } }),
      returns: await tx.return.count({ where: { tenantId: T.tenant, branchId: doomed } }),
      memberships: await tx.tenantMembership.count({
        where: { tenantId: T.tenant, defaultBranchId: doomed },
      }),
    }));
    expect(untouched).toEqual({
      terminals: 0,
      shifts: 0,
      sales: 0,
      returns: 0,
      memberships: 0,
    });

    // One finalized operation, writing every kind of evidence at once.
    const operationId = `history-${newId()}`;
    const finalized = await adjust({
      operationId,
      branchId: doomed,
      reason: 'استلام',
      lines: [{ productId: T.milk, deltaQuantityScaled: '5000' }],
    });
    const balanceBefore = await balanceOf(doomed, T.milk);
    expect(balanceBefore?.quantityScaled).toBe(5_000n);

    // The delete, attempted directly under the tenant's own RLS context —
    // exactly what an administrative tidy-up would do.
    const refused = await refusal(() =>
      withTenant(prisma, scope.tenantId, async (tx) => {
        await tx.$executeRaw`
          DELETE FROM "branches"
           WHERE "tenantId" = ${T.tenant}::uuid AND "id" = ${doomed}::uuid`;
      }),
    );
    // Refused by referential integrity, not by RLS and not silently ignored.
    expect(refused.message).toMatch(/foreign key|violates/i);

    // Everything the operation wrote is still there, and the branch with it.
    const after = await withTenant(prisma, scope.tenantId, async (tx) => ({
      branch: await tx.branch.count({ where: { tenantId: T.tenant, id: doomed } }),
      document: await tx.inventoryAdjustment.count({ where: { id: finalized.id } }),
      lines: await tx.inventoryAdjustmentLine.count({
        where: { tenantId: T.tenant, adjustmentId: finalized.id },
      }),
      movements: await tx.inventoryMovement.count({
        where: { tenantId: T.tenant, sourceId: finalized.id },
      }),
      audit: await tx.auditEvent.count({
        where: { entityId: finalized.id, eventType: 'inventory.adjustment.finalized' },
      }),
      key: await tx.idempotencyKey.count({
        where: { tenantId: T.tenant, scope: 'inventory-adjustment', operationId },
      }),
    }));
    expect(after).toEqual({
      branch: 1,
      document: 1,
      lines: 1,
      movements: 1,
      audit: 1,
      key: 1,
    });
    // The balance and its revision are exactly as the operation left them.
    expect(await balanceOf(doomed, T.milk)).toEqual(balanceBefore);
  }, 90_000);

  it('declares NO ACTION on every branch foreign key that carries stock history', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype::text AS confdeltype
         FROM pg_constraint WHERE conname = ANY($1) ORDER BY conname`,
      [
        [
          'inventory_movements_tenantId_branchId_fkey',
          'inventory_adjustments_tenantId_branchId_fkey',
          'inventory_counts_tenantId_branchId_fkey',
          'inventory_transfers_tenantId_fromBranchId_fkey',
          'inventory_transfers_tenantId_toBranchId_fkey',
        ],
      ],
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      // 'a' is NO ACTION; 'c' would be CASCADE, which is what would quietly
      // delete the ledger along with the branch (ADR-0024 §10).
      expect(row.confdeltype, row.conname).toBe('a');
    }

    // The materialized balance deliberately still cascades: it is current
    // state, not evidence, and it is rebuildable from the ledger.
    const { rows: balance } = await client.query<{ confdeltype: string }>(
      `SELECT confdeltype::text AS confdeltype FROM pg_constraint
        WHERE conname = 'inventory_balances_tenantId_branchId_fkey'`,
    );
    expect(balance[0]?.confdeltype).toBe('c');
    await client.end();
  }, 60_000);

  // -------------------------------------------------------------------------
  // UUID identity against the real database
  //
  // PostgreSQL's `uuid` type accepts either casing and stores one identity, so
  // these three prove Korvi agrees with the database about what "the same row"
  // means — rather than discovering it at a constraint.
  // -------------------------------------------------------------------------

  it('J. replays an operation whose UUIDs were re-spelled in a different case', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.milk, 20_000n);
    await setQuantity(T.branchA, T.rice, 20_000n);

    const operationId = `case-replay-${newId()}`;
    const first = await adjust({
      operationId,
      branchId: T.branchA,
      reason: 'جرد',
      lines: [
        { productId: T.milk, deltaQuantityScaled: '-2000' },
        { productId: T.rice, deltaQuantityScaled: '-1000' },
      ],
    });
    const afterFirst = {
      milk: await balanceOf(T.branchA, T.milk),
      rice: await balanceOf(T.branchA, T.rice),
    };

    // The same operation, every UUID re-spelled in upper case. Same physical
    // rows, so this is a retry — not a different intent.
    const replayed = await adjust({
      operationId,
      branchId: T.branchA.toUpperCase(),
      reason: 'جرد',
      lines: [
        { productId: T.rice.toUpperCase(), deltaQuantityScaled: '-1000' },
        { productId: T.milk.toUpperCase(), deltaQuantityScaled: '-2000' },
      ],
    });

    expect(replayed.replayed).toBe(true);
    expect(replayed.id).toBe(first.id);
    // Identical canonical result lines, in identical order.
    expect(replayed.lines).toEqual(first.lines);
    // The first response was already canonical, so it matches what the replay
    // reads back out of the database.
    expect(first.branchId).toBe(T.branchA);
    expect(first.lines.map((line) => line.productId)).toEqual(
      [...first.lines.map((line) => line.productId)].map((id) => id.toLowerCase()),
    );

    // No second movement and no second balance or revision change.
    expect(await balanceOf(T.branchA, T.milk)).toEqual(afterFirst.milk);
    expect(await balanceOf(T.branchA, T.rice)).toEqual(afterFirst.rice);
    const written = await withTenant(prisma, scope.tenantId, async (tx) => ({
      documents: await tx.inventoryAdjustment.count({ where: { operationId } }),
      movements: await tx.inventoryMovement.count({
        where: { tenantId: T.tenant, sourceId: first.id },
      }),
    }));
    expect(written).toEqual({ documents: 1, movements: 2 });
  }, 90_000);

  it('K. refuses a mixed-case duplicate product without touching anything', async () => {
    await setQuantity(T.branchA, T.milk, 10_000n);
    const before = await balanceOf(T.branchA, T.milk);
    // The whole tenant's movement total, not a filtered subset: a filter that
    // a successful operation would not have matched anyway proves nothing.
    const movementsBefore = await totalMovements();

    const operationId = `case-dup-${newId()}`;
    const refused = await refusal(() =>
      adjust({
        operationId,
        branchId: T.branchA,
        reason: 'جرد',
        lines: [
          { productId: T.milk, deltaQuantityScaled: '1000' },
          { productId: T.milk.toUpperCase(), deltaQuantityScaled: '-1000' },
        ],
      }),
    );
    // The typed domain refusal, not a unique-index violation from the database.
    expect(refused).toBeInstanceOf(StockRequestError);
    expect((refused as StockRequestError).detail).toBe('duplicate-product');

    expect(await balanceOf(T.branchA, T.milk)).toEqual(before);
    const residue = await withTenant(prisma, scope.tenantId, async (tx) => ({
      documents: await tx.inventoryAdjustment.count({ where: { operationId } }),
      lines: await tx.inventoryAdjustmentLine.count({
        where: { tenantId: T.tenant, adjustment: { operationId } },
      }),
      key: await tx.idempotencyKey.count({
        where: { tenantId: T.tenant, scope: 'inventory-adjustment', operationId },
      }),
    }));
    expect(residue).toEqual({ documents: 0, lines: 0, key: 0 });
    expect(await totalMovements()).toBe(movementsBefore);
  }, 90_000);

  it('L. refuses a mixed-case same-branch transfer without touching anything', async () => {
    await setQuantity(T.branchA, T.milk, 10_000n);
    const before = await balanceOf(T.branchA, T.milk);
    const movementsBefore = await totalMovements();

    const operationId = `case-same-${newId()}`;
    const refused = await refusal(() =>
      transfer({
        operationId,
        fromBranchId: T.branchA,
        toBranchId: T.branchA.toUpperCase(),
        reason: null,
        lines: [{ productId: T.milk, quantityScaled: '1000' }],
      }),
    );
    // The typed refusal, not the table's distinct-branches CHECK.
    expect(refused).toBeInstanceOf(StockRequestError);
    expect((refused as StockRequestError).detail).toBe('same-branch');

    expect(await balanceOf(T.branchA, T.milk)).toEqual(before);
    const residue = await withTenant(prisma, scope.tenantId, async (tx) => ({
      transfers: await tx.inventoryTransfer.count({ where: { operationId } }),
      key: await tx.idempotencyKey.count({
        where: { tenantId: T.tenant, scope: 'inventory-transfer', operationId },
      }),
    }));
    expect(residue).toEqual({ transfers: 0, key: 0 });
    // Measured as a before/after total. The earlier form filtered on
    // `sourceLineId: null`, which a committed transfer leg never carries — so
    // it would have read zero whether or not anything had been written.
    expect(await totalMovements()).toBe(movementsBefore);
  }, 90_000);

  // -------------------------------------------------------------------------
  // 16, 17 — sale and return regressions
  // -------------------------------------------------------------------------

  it('keeps the checkout stock movement in the sale transaction and steps revision', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.milk, 10_000n);
    const before = await balanceOf(T.branchA, T.milk);
    if (before === null) throw new Error('no opening balance');

    const result = await checkout.checkout({
      principal: {
        tenantId: T.tenant,
        tenantSlug: T.slug,
        userId: T.user,
        sessionId: newId(),
        email: 'sara@stock-live-a.test',
        displayName: 'سارة',
        roles: ['cashier'],
        permissions: ['sale.create', 'product.read'],
        maxDiscountBasisPoints: 0n,
        branchId: T.branchA,
      },
      operationId: newId(),
      terminalId: T.terminal,
      cashReceivedMinor: '10000',
      lines: [{ productId: T.milk, quantityScaled: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(`checkout failed: ${result.reason}`);

    const after = await balanceOf(T.branchA, T.milk);
    expect(after?.quantityScaled).toBe(before.quantityScaled - 2_000n);
    // The revision column is new; the sale path must move it, or a count could
    // not detect a sale.
    expect(after?.revision).toBe(before.revision + 1n);

    // The movement is attached to the sale, which is what "in the sale
    // transaction" means when the sale committed.
    const saleEvidence = await withTenant(prisma, scope.tenantId, async (tx) => ({
      line: await tx.saleLine.findFirst({
        where: { tenantId: T.tenant, saleId: result.sale.saleId, productId: T.milk },
        select: { id: true },
      }),
      movements: await tx.inventoryMovement.findMany({
        where: { tenantId: T.tenant, sourceType: 'sale', sourceId: result.sale.saleId },
      }),
    }));
    const movements = saleEvidence.movements;
    expect(movements).toHaveLength(1);
    expect(movements[0]?.quantityScaled).toBe(-2_000n);
    // 5C freezes the movement basis on the exact sale line. The causal link
    // must name that line rather than merely being non-null.
    expect(saleEvidence.line).not.toBeNull();
    expect(movements[0]?.sourceLineId).toBe(saleEvidence.line?.id);
  }, 60_000);

  it('keeps the original-sale return reversal in the return transaction and steps revision', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.milk, 10_000n);

    const principal: AuthenticatedPrincipal = {
      tenantId: T.tenant,
      tenantSlug: T.slug,
      userId: T.user,
      sessionId: newId(),
      email: 'sara@stock-live-a.test',
      displayName: 'سارة',
      roles: ['cashier'],
      permissions: ['sale.create', 'product.read', 'sale.refund'],
      maxDiscountBasisPoints: 0n,
      branchId: T.branchA,
    };

    const sale = await checkout.checkout({
      principal,
      operationId: newId(),
      terminalId: T.terminal,
      cashReceivedMinor: '10000',
      lines: [{ productId: T.milk, quantityScaled: '2000' }],
    });
    if (sale.outcome !== 'success') throw new Error(`checkout failed: ${sale.reason}`);

    const afterSale = await balanceOf(T.branchA, T.milk);
    if (afterSale === null) throw new Error('no balance after sale');

    const returnable = await returns.returnable(principal, sale.sale.saleId);
    if ('outcome' in returnable) throw new Error('sale is not returnable');
    const saleLineId = returnable.lines[0]?.saleLineId;
    if (saleLineId === undefined) throw new Error('no returnable line');

    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: T.terminal,
      saleId: sale.sale.saleId,
      lines: [{ saleLineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(`return failed: ${result.reason}`);

    const afterReturn = await balanceOf(T.branchA, T.milk);
    // The goods are back on the shelf, and the revision moved with them.
    expect(afterReturn?.quantityScaled).toBe(afterSale.quantityScaled + 1_000n);
    expect(afterReturn?.revision).toBe(afterSale.revision + 1n);

    const returnEvidence = await withTenant(prisma, scope.tenantId, async (tx) => ({
      line: await tx.returnLine.findFirst({
        where: {
          tenantId: T.tenant,
          returnId: result.document.returnId,
          saleLineId,
        },
        select: { id: true },
      }),
      movements: await tx.inventoryMovement.findMany({
        where: {
          tenantId: T.tenant,
          sourceType: 'return',
          sourceId: result.document.returnId,
        },
      }),
    }));
    const movements = returnEvidence.movements;
    expect(movements).toHaveLength(1);
    expect(movements[0]?.quantityScaled).toBe(1_000n);
    expect(movements[0]?.kind).toBe('return');
    expect(returnEvidence.line).not.toBeNull();
    expect(movements[0]?.sourceLineId).toBe(returnEvidence.line?.id);
  }, 90_000);

  it('keeps a refused checkout from moving stock or stepping revision', async () => {
    await allowNegative(false);
    await setQuantity(T.branchA, T.rice, 1_000n);
    const before = await balanceOf(T.branchA, T.rice);

    const result = await checkout.checkout({
      principal: {
        tenantId: T.tenant,
        tenantSlug: T.slug,
        userId: T.user,
        sessionId: newId(),
        email: 'sara@stock-live-a.test',
        displayName: 'سارة',
        roles: ['cashier'],
        permissions: ['sale.create', 'product.read'],
        maxDiscountBasisPoints: 0n,
        branchId: T.branchA,
      },
      operationId: newId(),
      terminalId: T.terminal,
      cashReceivedMinor: '100000',
      lines: [{ productId: T.rice, quantityScaled: '9000' }],
    });
    expect(result.outcome).toBe('failure');
    expect(await balanceOf(T.branchA, T.rice)).toEqual(before);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 18, 19 — product/branch rules and the permission migration
  // -------------------------------------------------------------------------

  it('fails closed on inactive branches, inactive products and untracked products', async () => {
    const cases: readonly [string, AdjustmentRequest][] = [
      [
        'inactive-branch',
        {
          operationId: `rule-a-${newId()}`,
          branchId: T.branchClosed,
          reason: 'محاولة',
          lines: [{ productId: T.milk, deltaQuantityScaled: '1000' }],
        },
      ],
      [
        'inactive-product',
        {
          operationId: `rule-b-${newId()}`,
          branchId: T.branchA,
          reason: 'محاولة',
          lines: [{ productId: T.inactive, deltaQuantityScaled: '1000' }],
        },
      ],
      [
        'untracked-product',
        {
          operationId: `rule-c-${newId()}`,
          branchId: T.branchA,
          reason: 'محاولة',
          lines: [{ productId: T.untracked, deltaQuantityScaled: '1000' }],
        },
      ],
      [
        'unknown-branch',
        {
          operationId: `rule-d-${newId()}`,
          branchId: newId(),
          reason: 'محاولة',
          lines: [{ productId: T.milk, deltaQuantityScaled: '1000' }],
        },
      ],
    ];

    for (const [detail, request] of cases) {
      const error = await refusal(() => adjust(request));
      expect((error as StockOperationRefusedError).detail, detail).toBe(detail);
      const residue = await withTenant(prisma, scope.tenantId, async (tx) =>
        tx.inventoryAdjustment.count({ where: { operationId: request.operationId } }),
      );
      expect(residue, detail).toBe(0);
    }
  }, 60_000);

  it('refuses a fractional quantity on a unit product and allows one on a weighted product', async () => {
    const fractional = await refusal(() =>
      adjust({
        operationId: `frac-${newId()}`,
        branchId: T.branchA,
        reason: 'كسر',
        lines: [{ productId: T.milk, deltaQuantityScaled: '1500' }],
      }),
    );
    expect(fractional.message).toMatch(/whole number of units/);

    // 1.5 kg of tomatoes is a real quantity.
    const weighed = await adjust({
      operationId: `weighed-${newId()}`,
      branchId: T.branchA,
      reason: 'استلام',
      lines: [{ productId: T.scale, deltaQuantityScaled: '1500' }],
    });
    expect(weighed.lines[0]?.deltaQuantityScaled).toBe('1500');
  }, 60_000);

  it('gave the new permission to system roles only, and not to custom ones', async () => {
    // Provisioning installs the canonical map, which is the future-tenant half
    // of the contract; the migration is the existing-tenant half. Both are
    // asserted here against a tenant that was provisioned in this suite.
    const granted = await withTenant(prisma, scope.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ key: string; isSystem: boolean }[]>`
        SELECT r."key", r."isSystem"
          FROM "role_permissions" rp
          JOIN "roles" r ON r."tenantId" = rp."tenantId" AND r."id" = rp."roleId"
         WHERE rp."tenantId" = ${T.tenant}::uuid
           AND rp."permissionKey" = 'inventory.transfer'
         ORDER BY r."key"`;
      return rows;
    });
    expect(granted.map((row) => row.key).sort()).toEqual(['admin', 'manager', 'owner']);
    expect(granted.every((row) => row.isSystem)).toBe(true);

    // A merchant's own role gets nothing automatically.
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.role.create({
        data: {
          id: T.customRole,
          tenantId: T.tenant,
          key: 'floor-supervisor',
          nameAr: 'مشرف الصالة',
          maxDiscountBasisPoints: 0,
          isSystem: false,
        },
      });
    });
    const custom = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.rolePermission.count({
        where: { tenantId: T.tenant, roleId: T.customRole, permissionKey: 'inventory.transfer' },
      }),
    );
    expect(custom).toBe(0);

    // And the catalogue row itself exists exactly once, globally.
    const catalogue = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "permissions" WHERE "key" = 'inventory.transfer'`;
    expect(catalogue[0]?.count).toBe(1n);
  }, 60_000);

  it('reads balances as bounded pages of strings, with the revision a count needs', async () => {
    await setQuantity(T.branchA, T.milk, 4_000n);
    await setQuantity(T.branchA, T.rice, 4_000n);

    const first = await listBalancePage(prisma, T.tenant, T.branchA, 1, null);
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(typeof first.rows[0]?.quantityScaled).toBe('string');
    expect(typeof first.rows[0]?.revision).toBe('string');
    expect(first.rows[0]).toMatchObject({
      sku: 'MILK-1L',
      nameAr: 'MILK-1L',
      productType: 'unit',
      unitLabel: 'each',
    });

    const second_ = await listBalancePage(prisma, T.tenant, T.branchA, 1, first.nextCursor);
    expect(second_.rows[0]?.productId).not.toBe(first.rows[0]?.productId);

    // The other tenant's branch id yields nothing under this tenant's scope.
    const foreign = await listBalancePage(prisma, T.tenant, OTHER.branch, 50, null);
    expect(foreign.rows).toHaveLength(0);

    await setQuantity(T.branchA, T.inactive, 2_000n);
    const withInactive = await listBalancePage(prisma, T.tenant, T.branchA, 50, null);
    expect(withInactive.rows).toContainEqual(
      expect.objectContaining({ productId: T.inactive, sku: 'OLD-SKU' }),
    );
  }, 60_000);

  it('lists bounded operational branch identity under tenant scope', async () => {
    const first = await listInventoryBranchPage(prisma, scope, 1, null);
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(first.rows[0]).toEqual(
      expect.objectContaining({
        id: T.branchA,
        code: '01',
        nameAr: 'فرع 01',
        isActive: true,
      }),
    );
    expect(first.rows[0]).not.toHaveProperty('tenantId');
    expect(first.rows[0]).not.toHaveProperty('createdAt');

    const secondPage = await listInventoryBranchPage(prisma, scope, 1, first.nextCursor);
    expect(secondPage.rows[0]?.id).not.toBe(first.rows[0]?.id);

    const allTenantBranches = await listInventoryBranchPage(prisma, scope, 100, null);
    expect(allTenantBranches.rows).toContainEqual(
      expect.objectContaining({ id: T.branchClosed, isActive: false }),
    );
    expect(allTenantBranches.rows.some((branch) => branch.id === OTHER.branch)).toBe(false);

    const foreign = await listInventoryBranchPage(
      prisma,
      { tenantId: brandTenantId(OTHER.tenant) },
      100,
      T.branchA,
    );
    expect(foreign.rows.every((branch) => branch.id !== T.branchA)).toBe(true);
  }, 60_000);
});

describe.skipIf(url !== '')('inventory stock ledger, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
