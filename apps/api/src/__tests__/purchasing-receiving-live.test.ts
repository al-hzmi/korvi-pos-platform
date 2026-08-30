import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PurchasingRequestError, newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  PurchasingRefusedError,
  assignRole,
  createPrismaClient,
  createPurchaseOrder,
  createSupplier,
  getPurchaseOrder,
  getSupplier,
  listPurchaseOrders,
  listPurchaseReceipts,
  listSuppliers,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  recordInventoryCostBootstrap,
  recordPurchaseReceipt,
  updateSupplier,
  withTenant,
} from '@korvi/database';
import { fingerprintCostBootstrap } from '../inventory/fingerprint.js';
import {
  fingerprintPurchaseOrder,
  fingerprintPurchaseReceipt,
  fingerprintSupplierCreate,
  fingerprintSupplierUpdate,
} from '../purchasing/fingerprint.js';
import type { PrismaClient, PurchasingActor } from '@korvi/database';
import type {
  PurchaseOrderRequest,
  PurchaseReceiptRequest,
  SupplierCreateRequest,
  SupplierUpdateRequest,
  TenantScope,
} from '@korvi/domain';

/**
 * Strike 5B against a real PostgreSQL server.
 *
 * Every claim this strike makes is a claim about what the database does: what
 * happens when two clerks book the same delivery at once, what survives when a
 * write fails after the stock has already moved, and whether a purchase order
 * really leaves the shelf alone. None of that can be answered by a fake, so
 * none of it is asserted anywhere but here.
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
  tenant: '018f5b00-0000-7000-8000-00000000000a',
  slug: 'purchasing-live-a',
  branchA: '018f5b00-0000-7000-8000-0000000000a1',
  branchClosed: '018f5b00-0000-7000-8000-0000000000a2',
  branchDoomed: '018f5b00-0000-7000-8000-0000000000a3',
  user: '018f5b00-0000-7000-8000-0000000000a4',
  membership: '018f5b00-0000-7000-8000-0000000000a5',
  milk: '018f5b00-0000-7000-8000-0000000000a6',
  rice: '018f5b00-0000-7000-8000-0000000000a7',
  scale: '018f5b00-0000-7000-8000-0000000000a8',
  untracked: '018f5b00-0000-7000-8000-0000000000a9',
  inactive: '018f5b00-0000-7000-8000-0000000000aa',
  doomedProduct: '018f5b00-0000-7000-8000-0000000000ab',
  customRole: '018f5b00-0000-7000-8000-0000000000ac',
  costReceipt: '018f5b00-0000-7000-8000-0000000000b0',
} as const;

const OTHER = {
  tenant: '018f5b00-0000-7000-8000-00000000000b',
  slug: 'purchasing-live-b',
  branch: '018f5b00-0000-7000-8000-0000000000b1',
  user: '018f5b00-0000-7000-8000-0000000000b2',
  membership: '018f5b00-0000-7000-8000-0000000000b3',
  product: '018f5b00-0000-7000-8000-0000000000b4',
} as const;

const NEW_TABLES = [
  'suppliers',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
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

describe.skipIf(url === '')('purchasing and receiving, live', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;

  const scope: TenantScope = { tenantId: brandTenantId(T.tenant) };
  const actor: PurchasingActor = { tenantId: T.tenant, userId: T.user };

  /** Filled in `beforeAll`: the tenant's two suppliers. */
  let supplierMain = '';
  let supplierOff = '';

  async function removeTenant(id: string): Promise<void> {
    await withTenant(prisma, id, async (tx) => {
      await tx.tenant.deleteMany({ where: { id } });
    });
  }

  const newSupplier = (request: SupplierCreateRequest, who: PurchasingActor = actor) =>
    createSupplier(prisma, who, request, fingerprintSupplierCreate(request, who.userId));

  const editSupplier = (request: SupplierUpdateRequest, who: PurchasingActor = actor) =>
    updateSupplier(prisma, who, request, fingerprintSupplierUpdate(request, who.userId));

  const order = (
    request: PurchaseOrderRequest,
    who: PurchasingActor = actor,
    client: PrismaClient = prisma,
  ) => createPurchaseOrder(client, who, request, fingerprintPurchaseOrder(request, who.userId));

  const receive = (
    request: PurchaseReceiptRequest,
    who: PurchasingActor = actor,
    client: PrismaClient = prisma,
  ) => recordPurchaseReceipt(client, who, request, fingerprintPurchaseReceipt(request, who.userId));

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
  ): Promise<{ quantityScaled: bigint; revision: bigint } | null> {
    return withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { tenantId: T.tenant, branchId, productId },
        select: { quantityScaled: true, revision: true },
      }),
    );
  }

  /**
   * The whole stock footprint of this tenant, in one value.
   *
   * "Creating a purchase order changed nothing" is only meaningful if
   * "nothing" is measured across every movement, every balance and the sum of
   * every revision — a per-row check would miss a row that appeared.
   */
  async function stockFootprint(): Promise<{
    movements: number;
    balances: number;
    quantityTotal: string;
    revisionTotal: string;
  }> {
    return withTenant(prisma, scope.tenantId, async (tx) => {
      const movements = await tx.inventoryMovement.count({ where: { tenantId: T.tenant } });
      const rows = await tx.inventoryBalance.findMany({
        where: { tenantId: T.tenant },
        select: { quantityScaled: true, revision: true },
      });
      let quantityTotal = 0n;
      let revisionTotal = 0n;
      for (const row of rows) {
        quantityTotal += row.quantityScaled;
        revisionTotal += row.revision;
      }
      return {
        movements,
        balances: rows.length,
        quantityTotal: quantityTotal.toString(),
        revisionTotal: revisionTotal.toString(),
      };
    });
  }

  /** The tenant's complete mutable valuation state plus immutable evidence count. */
  async function costFootprint(): Promise<{
    balances: number;
    events: number;
    knownQuantityTotal: string;
    knownValueTotal: string;
    stockRevisionTotal: string;
    costRevisionTotal: string;
  }> {
    return withTenant(prisma, scope.tenantId, async (tx) => {
      const rows = await tx.inventoryCostBalance.findMany({
        where: { tenantId: T.tenant },
        select: {
          knownQuantityScaled: true,
          knownValueMinor: true,
          stockRevision: true,
          costRevision: true,
        },
      });
      let knownQuantityTotal = 0n;
      let knownValueTotal = 0n;
      let stockRevisionTotal = 0n;
      let costRevisionTotal = 0n;
      for (const row of rows) {
        knownQuantityTotal += row.knownQuantityScaled;
        knownValueTotal += row.knownValueMinor;
        stockRevisionTotal += row.stockRevision;
        costRevisionTotal += row.costRevision;
      }
      return {
        balances: rows.length,
        events: await tx.inventoryValuationEvent.count({ where: { tenantId: T.tenant } }),
        knownQuantityTotal: knownQuantityTotal.toString(),
        knownValueTotal: knownValueTotal.toString(),
        stockRevisionTotal: stockRevisionTotal.toString(),
        costRevisionTotal: costRevisionTotal.toString(),
      };
    });
  }

  async function movementsFor(receiptId: string): Promise<
    {
      branchId: string;
      productId: string;
      quantityScaled: bigint;
      kind: string;
      sourceType: string | null;
      sourceLineId: string | null;
      costKnownQuantityScaled: bigint;
      costUnknownQuantityScaled: bigint;
      costValueMinor: bigint;
      costProvenance: string;
    }[]
  > {
    return withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryMovement.findMany({
        where: { tenantId: T.tenant, sourceId: receiptId },
        select: {
          branchId: true,
          productId: true,
          quantityScaled: true,
          kind: true,
          sourceType: true,
          sourceLineId: true,
          costKnownQuantityScaled: true,
          costUnknownQuantityScaled: true,
          costValueMinor: true,
          costProvenance: true,
        },
        orderBy: { productId: 'asc' },
      }),
    );
  }

  /**
   * A fresh order, so each test starts from a state it fully controls.
   *
   * Returns the order with its line ids, which is what a receipt names.
   */
  async function freshOrder(
    lines: readonly { productId: string; orderedQuantityScaled: string }[],
    over: { branchId?: string; supplierId?: string } = {},
  ): Promise<{ id: string; lineIdFor: (productId: string) => string }> {
    const created = await order({
      operationId: `po-${newId()}`,
      supplierId: over.supplierId ?? supplierMain,
      branchId: over.branchId ?? T.branchA,
      reference: null,
      lines: [...lines],
    });
    const byProduct = new Map(created.order.lines.map((line) => [line.productId, line.id]));
    return {
      id: created.order.id,
      lineIdFor: (productId) => {
        const found = byProduct.get(productId);
        if (found === undefined) throw new Error(`no purchase order line for ${productId}`);
        return found;
      },
    };
  }

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
          name: 'متجر المشتريات',
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
        [T.branchClosed, '02', false],
        [T.branchDoomed, '03', true],
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
          email: 'nora@purchasing-live-a.test',
          displayName: 'نورة',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: T.membership, tenantId: T.tenant, userId: T.user, updatedAt: new Date() },
      });
      for (const [id, sku, type, track, active] of [
        [T.milk, 'MILK-1L', 'unit', true, true],
        [T.rice, 'RICE-5K', 'unit', true, true],
        [T.scale, 'TOMATO', 'weighted', true, true],
        [T.untracked, 'SERVICE', 'unit', false, true],
        [T.inactive, 'OLD-SKU', 'unit', true, false],
        [T.doomedProduct, 'DOOMED', 'unit', true, true],
        [T.costReceipt, 'COST-RECEIPT', 'unit', true, true],
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
          email: 'faisal@purchasing-live-b.test',
          displayName: 'فيصل',
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
    await assignRole(prisma, scope, T.user, 'manager');

    const main = await newSupplier({ operationId: `sup-${newId()}`, name: 'مؤسسة الرياض' });
    supplierMain = main.supplier.id;
    const off = await newSupplier({ operationId: `sup-${newId()}`, name: 'مورد متوقف' });
    supplierOff = off.supplier.id;
    await editSupplier({
      operationId: `sup-off-${newId()}`,
      supplierId: supplierOff,
      isActive: false,
    });
  }, 180_000);

  afterAll(async () => {
    await removeTenant(T.tenant);
    await removeTenant(OTHER.tenant);
    await prisma.$disconnect();
    await second.$disconnect();
  });

  // -------------------------------------------------------------------------
  // A & B — the ground the rest stands on
  // -------------------------------------------------------------------------

  it('A/B: runs as a role the policies apply to, on every new table', async () => {
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

    // FORCE was lifted inside the permission migration's own transaction, so
    // it has to be back on afterwards — in the catalogue and in behaviour.
    const { rows: rbac } = await client.query<{
      relname: string;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE relname IN ('roles','role_permissions') AND relkind = 'r'`,
    );
    expect(rbac).toHaveLength(2);
    for (const table of rbac) expect(table.relforcerowsecurity, table.relname).toBe(true);

    // Behaviour, not only catalogue state: with no tenant context set, a
    // FORCE-RLS table shows the owner nothing.
    const { rows: blind } = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM "role_permissions"',
    );
    expect(blind[0]?.n).toBe('0');

    await client.end();
  }, 60_000);

  // -------------------------------------------------------------------------
  // C — tenant isolation
  // -------------------------------------------------------------------------

  it('C: cannot see, order from, or receive against another tenant', async () => {
    const theirSupplier = await createSupplier(
      prisma,
      { tenantId: OTHER.tenant, userId: OTHER.user },
      { operationId: `their-sup-${newId()}`, name: 'مورد الغير' },
      'x'.repeat(43),
    );
    const theirOrder = await createPurchaseOrder(
      prisma,
      { tenantId: OTHER.tenant, userId: OTHER.user },
      {
        operationId: `their-po-${newId()}`,
        supplierId: theirSupplier.supplier.id,
        branchId: OTHER.branch,
        reference: null,
        lines: [{ productId: OTHER.product, orderedQuantityScaled: '5000' }],
      },
      'y'.repeat(43),
    );

    // Every read answers "not here", identically to a missing id.
    const suppliers = await listSuppliers(prisma, T.tenant, {
      limit: 100,
      cursor: null,
      activeOnly: false,
    });
    expect(suppliers.rows.map((row) => row.id)).not.toContain(theirSupplier.supplier.id);

    const orders = await listPurchaseOrders(prisma, T.tenant, {
      limit: 100,
      cursor: null,
      status: null,
      supplierId: null,
      branchId: null,
    });
    expect(orders.rows.map((row) => row.id)).not.toContain(theirOrder.order.id);
    expect(await getPurchaseOrder(prisma, T.tenant, theirOrder.order.id)).toBeNull();
    expect(await listPurchaseReceipts(prisma, T.tenant, theirOrder.order.id, 50)).toEqual([]);

    // And no write reaches across either: the order simply is not there.
    const refused = await refusal(() =>
      receive({
        operationId: `cross-${newId()}`,
        purchaseOrderId: theirOrder.order.id,
        reference: null,
        lines: [
          {
            purchaseOrderLineId: theirOrder.order.lines[0]?.id ?? '',
            acceptedQuantityScaled: '1000',
          },
        ],
      }),
    );
    expect(refused).toBeInstanceOf(PurchasingRefusedError);
    expect((refused as PurchasingRefusedError).detail).toBe('unknown-purchase-order');

    // Ordering a foreign product through our own supplier fails closed too.
    const foreignProduct = await refusal(() =>
      order({
        operationId: `cross-po-${newId()}`,
        supplierId: supplierMain,
        branchId: T.branchA,
        reference: null,
        lines: [{ productId: OTHER.product, orderedQuantityScaled: '1000' }],
      }),
    );
    expect((foreignProduct as PurchasingRefusedError).detail).toBe('unknown-product');

    // Nothing above wrote into the other tenant.
    const theirs = await withTenant(prisma, OTHER.tenant, async (tx) => ({
      receipts: await tx.purchaseReceipt.count({ where: { tenantId: OTHER.tenant } }),
      lines: await tx.purchaseOrderLine.count({
        where: { tenantId: OTHER.tenant, receivedQuantityScaled: { gt: 0n } },
      }),
    }));
    expect(theirs).toEqual({ receipts: 0, lines: 0 });
  }, 90_000);

  // -------------------------------------------------------------------------
  // D — the immutable rule
  // -------------------------------------------------------------------------

  it('D: creating a purchase order moves no stock at all', async () => {
    const before = await stockFootprint();

    const created = await order({
      operationId: `po-nostock-${newId()}`,
      supplierId: supplierMain,
      branchId: T.branchA,
      reference: 'PO-1001',
      lines: [
        { productId: T.milk, orderedQuantityScaled: '100000' },
        { productId: T.rice, orderedQuantityScaled: '50000' },
      ],
    });

    // The order exists, is open, and has received nothing.
    expect(created.order.status).toBe('open');
    expect(created.order.lines.map((line) => line.receivedQuantityScaled)).toEqual(['0', '0']);
    expect(created.order.lines.map((line) => line.remainingQuantityScaled)).toEqual([
      '100000',
      '50000',
    ]);

    // And the shelf is exactly as it was: no movement, no new balance row, no
    // quantity, no revision step. A purchase order is intent, not arrival.
    expect(await stockFootprint()).toEqual(before);
  }, 60_000);

  // -------------------------------------------------------------------------
  // E, F — partial then final receiving
  // -------------------------------------------------------------------------

  it('E/F: partial receipt writes everything once, and the final one closes the order', async () => {
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '100000' }]);
    const lineId = po.lineIdFor(T.milk);
    const before = (await balanceOf(T.branchA, T.milk)) ?? {
      quantityScaled: 0n,
      revision: 0n,
    };

    const partial = await receive({
      operationId: `rc-partial-${newId()}`,
      purchaseOrderId: po.id,
      reference: 'DN-77',
      lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '30000' }],
    });

    expect(partial.purchaseOrderStatus).toBe('partially_received');
    expect(partial.lines).toHaveLength(1);
    const line = partial.lines[0];
    expect(line?.acceptedQuantityScaled).toBe('30000');
    expect(line?.beforeReceivedQuantityScaled).toBe('0');
    expect(line?.afterReceivedQuantityScaled).toBe('30000');

    // The balance moved by exactly the accepted quantity, and the revision by
    // exactly one.
    const after = await balanceOf(T.branchA, T.milk);
    expect(after?.quantityScaled).toBe(before.quantityScaled + 30_000n);
    expect(after?.revision).toBe(before.revision + 1n);
    expect(line?.resultRevision).toBe(after?.revision.toString());

    // Exactly one causal movement, carrying the receipt and the receipt line.
    const movements = await movementsFor(partial.id);
    expect(movements).toHaveLength(1);
    expect(movements[0]?.kind).toBe('receipt');
    expect(movements[0]?.sourceType).toBe('purchase-receipt');
    expect(movements[0]?.sourceLineId).toBe(line?.id);
    expect(movements[0]?.quantityScaled).toBe(30_000n);
    expect(movements[0]?.branchId).toBe(T.branchA);
    expect(movements[0]).toMatchObject({
      costKnownQuantityScaled: 0n,
      costUnknownQuantityScaled: 30_000n,
      costValueMinor: 0n,
      costProvenance: 'unknown',
    });

    // The accumulator, the audit event and the idempotency reservation all
    // landed in the same transaction as the stock.
    const evidence = await withTenant(prisma, scope.tenantId, async (tx) => ({
      accumulated: (
        await tx.purchaseOrderLine.findFirstOrThrow({
          where: { tenantId: T.tenant, id: lineId },
          select: { receivedQuantityScaled: true },
        })
      ).receivedQuantityScaled.toString(),
      audit: await tx.auditEvent.count({
        where: {
          tenantId: T.tenant,
          eventType: 'purchasing.receipt.finalized',
          entityId: partial.id,
        },
      }),
      key: await tx.idempotencyKey.count({
        where: { tenantId: T.tenant, scope: 'purchasing-receipt-create', resultId: partial.id },
      }),
      receiptLines: await tx.purchaseReceiptLine.count({
        where: { tenantId: T.tenant, purchaseReceiptId: partial.id },
      }),
      receiptCost: await tx.purchaseReceiptLine.findFirstOrThrow({
        where: { tenantId: T.tenant, purchaseReceiptId: partial.id },
        select: {
          inventoryValueMinor: true,
          costKnownQuantityScaled: true,
          costUnknownQuantityScaled: true,
          costValueMinor: true,
          costProvenance: true,
        },
      }),
    }));
    expect(evidence).toEqual({
      accumulated: '30000',
      audit: 1,
      key: 1,
      receiptLines: 1,
      receiptCost: {
        inventoryValueMinor: null,
        costKnownQuantityScaled: 0n,
        costUnknownQuantityScaled: 30_000n,
        costValueMinor: 0n,
        costProvenance: 'unknown',
      },
    });

    // F — the balance of the order, and the status moves to received.
    const final = await receive({
      operationId: `rc-final-${newId()}`,
      purchaseOrderId: po.id,
      reference: 'DN-78',
      lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '70000' }],
    });
    expect(final.purchaseOrderStatus).toBe('received');
    expect(final.lines[0]?.beforeReceivedQuantityScaled).toBe('30000');
    expect(final.lines[0]?.afterReceivedQuantityScaled).toBe('100000');

    const closed = await getPurchaseOrder(prisma, T.tenant, po.id);
    expect(closed?.status).toBe('received');
    expect(closed?.lines[0]?.remainingQuantityScaled).toBe('0');
    expect((await balanceOf(T.branchA, T.milk))?.quantityScaled).toBe(
      before.quantityScaled + 100_000n,
    );

    // Both receipts survive as separate evidence; the first was never rewritten.
    const receipts = await listPurchaseReceipts(prisma, T.tenant, po.id, 50);
    expect(receipts).toHaveLength(2);
    expect(receipts.flatMap((r) => r.lines.map((l) => l.acceptedQuantityScaled)).sort()).toEqual([
      '30000',
      '70000',
    ]);

    // A closed order takes no more deliveries.
    const closedRefusal = await refusal(() =>
      receive({
        operationId: `rc-after-${newId()}`,
        purchaseOrderId: po.id,
        reference: null,
        lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '1000' }],
      }),
    );
    expect((closedRefusal as PurchasingRefusedError).detail).toBe('purchase-order-closed');
  }, 120_000);

  it('5C: serialises cost bootstrap against a valued receipt and preserves both bases', async () => {
    const po = await freshOrder([{ productId: T.costReceipt, orderedQuantityScaled: '2000' }]);

    // This is the exact state bootstrap exists to resolve: five historical
    // units are on hand, but no cost pool or invented valuation exists yet.
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.inventoryBalance.create({
        data: {
          tenantId: T.tenant,
          branchId: T.branchA,
          productId: T.costReceipt,
          quantityScaled: 5_000n,
          revision: 0n,
          updatedAt: new Date(),
        },
      });
    });

    const bootstrapRequest = {
      operationId: `bootstrap-receipt-${newId()}`,
      branchId: T.branchA,
      productId: T.costReceipt,
      totalValueMinor: '100',
    };
    const receiptRequest: PurchaseReceiptRequest = {
      operationId: `valued-receipt-${newId()}`,
      purchaseOrderId: po.id,
      reference: null,
      lines: [
        {
          purchaseOrderLineId: po.lineIdFor(T.costReceipt),
          acceptedQuantityScaled: '2000',
          inventoryValueMinor: '40',
        },
      ],
    };

    const raced = await behindBalanceGate(T.costReceipt, 'bootstrap against valued receipt', () =>
      Promise.allSettled([
        recordInventoryCostBootstrap(
          second,
          actor,
          bootstrapRequest,
          fingerprintCostBootstrap(bootstrapRequest, T.user),
        ),
        receive(receiptRequest, actor, prisma),
      ]),
    );
    expect(
      raced.blocked,
      'bootstrap and receipt were not both waiting behind the held stock row',
    ).toBe(2);

    const [bootstrapOutcome, receiptOutcome] = raced.result;
    if (bootstrapOutcome === undefined || bootstrapOutcome.status === 'rejected') {
      throw new Error(
        `bootstrap failed: ${String(bootstrapOutcome?.status === 'rejected' ? bootstrapOutcome.reason : 'missing result')}`,
      );
    }
    if (receiptOutcome === undefined || receiptOutcome.status === 'rejected') {
      throw new Error(
        `receipt failed: ${String(receiptOutcome?.status === 'rejected' ? receiptOutcome.reason : 'missing result')}`,
      );
    }

    // Whichever transaction reached the row first, bootstrap values only the
    // same five historical unknown units. The receipt contributes its own
    // independently recorded 2-unit / 40-minor-unit acquisition basis.
    expect(bootstrapOutcome.value.valuedQuantityScaled).toBe('5000');
    expect(['0', '1']).toContain(bootstrapOutcome.value.stockRevision);
    expect(['1', '2']).toContain(bootstrapOutcome.value.costRevision);
    expect(receiptOutcome.value.purchaseOrderStatus).toBe('received');

    const evidence = await withTenant(prisma, scope.tenantId, async (tx) => ({
      stock: await tx.inventoryBalance.findFirstOrThrow({
        where: { tenantId: T.tenant, branchId: T.branchA, productId: T.costReceipt },
        select: { quantityScaled: true, revision: true },
      }),
      cost: await tx.inventoryCostBalance.findFirstOrThrow({
        where: { tenantId: T.tenant, branchId: T.branchA, productId: T.costReceipt },
        select: {
          knownQuantityScaled: true,
          knownValueMinor: true,
          stockRevision: true,
          costRevision: true,
        },
      }),
      receiptLine: await tx.purchaseReceiptLine.findFirstOrThrow({
        where: { tenantId: T.tenant, purchaseReceiptId: receiptOutcome.value.id },
        select: {
          id: true,
          inventoryValueMinor: true,
          costKnownQuantityScaled: true,
          costUnknownQuantityScaled: true,
          costValueMinor: true,
          costProvenance: true,
        },
      }),
      movement: await tx.inventoryMovement.findFirstOrThrow({
        where: {
          tenantId: T.tenant,
          sourceType: 'purchase-receipt',
          sourceId: receiptOutcome.value.id,
        },
        select: {
          sourceLineId: true,
          costKnownQuantityScaled: true,
          costUnknownQuantityScaled: true,
          costValueMinor: true,
          costProvenance: true,
        },
      }),
      valuationEvents: await tx.inventoryValuationEvent.findMany({
        where: { tenantId: T.tenant, branchId: T.branchA, productId: T.costReceipt },
        select: {
          eventKind: true,
          knownQuantityScaled: true,
          unknownQuantityScaled: true,
          knownValueMinor: true,
        },
        orderBy: { eventKind: 'asc' },
      }),
    }));

    expect(evidence.stock).toEqual({ quantityScaled: 7_000n, revision: 1n });
    expect(evidence.cost).toEqual({
      knownQuantityScaled: 7_000n,
      knownValueMinor: 140n,
      stockRevision: 1n,
      costRevision: 2n,
    });
    expect(evidence.receiptLine).toMatchObject({
      inventoryValueMinor: 40n,
      costKnownQuantityScaled: 2_000n,
      costUnknownQuantityScaled: 0n,
      costValueMinor: 40n,
      costProvenance: 'recorded',
    });
    expect(evidence.movement).toEqual({
      sourceLineId: evidence.receiptLine.id,
      costKnownQuantityScaled: 2_000n,
      costUnknownQuantityScaled: 0n,
      costValueMinor: 40n,
      costProvenance: 'recorded',
    });
    expect(evidence.valuationEvents).toEqual([
      {
        eventKind: 'bootstrap',
        knownQuantityScaled: 5_000n,
        unknownQuantityScaled: 0n,
        knownValueMinor: 100n,
      },
      {
        eventKind: 'movement',
        knownQuantityScaled: 2_000n,
        unknownQuantityScaled: 0n,
        knownValueMinor: 40n,
      },
    ]);
  }, 120_000);

  // -------------------------------------------------------------------------
  // G, H — idempotency
  // -------------------------------------------------------------------------

  it('G: replaying a receipt moves nothing a second time', async () => {
    const po = await freshOrder([{ productId: T.rice, orderedQuantityScaled: '40000' }]);
    const request: PurchaseReceiptRequest = {
      operationId: `rc-replay-${newId()}`,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: po.lineIdFor(T.rice), acceptedQuantityScaled: '10000' }],
    };

    const first = await receive(request);
    const footprint = await stockFootprint();

    const replay = await receive(request);
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);
    expect(replay.lines.map((line) => line.acceptedQuantityScaled)).toEqual(
      first.lines.map((line) => line.acceptedQuantityScaled),
    );
    expect(replay.lines.map((line) => line.resultRevision)).toEqual(
      first.lines.map((line) => line.resultRevision),
    );

    // Not one movement more, not one revision more, not one halala of stock.
    expect(await stockFootprint()).toEqual(footprint);
    const accumulated = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.purchaseOrderLine.findFirstOrThrow({
        where: { tenantId: T.tenant, id: po.lineIdFor(T.rice) },
        select: { receivedQuantityScaled: true },
      }),
    );
    expect(accumulated.receivedQuantityScaled).toBe(10_000n);

    // And exactly one receipt exists under that operation id.
    const count = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.purchaseReceipt.count({
        where: { tenantId: T.tenant, operationId: request.operationId },
      }),
    );
    expect(count).toBe(1);
  }, 90_000);

  it('H: the same operation id with a different intent is a conflict, not a replay', async () => {
    const po = await freshOrder([{ productId: T.rice, orderedQuantityScaled: '40000' }]);
    const lineId = po.lineIdFor(T.rice);
    const operationId = `rc-conflict-${newId()}`;

    await receive({
      operationId,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '5000' }],
    });
    const footprint = await stockFootprint();

    const conflict = await refusal(() =>
      receive({
        operationId,
        purchaseOrderId: po.id,
        reference: null,
        // A different quantity is a different decision wearing the first one's
        // name. It is never a retry.
        lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '6000' }],
      }),
    );
    expect(conflict).toBeInstanceOf(PurchasingRefusedError);
    expect((conflict as PurchasingRefusedError).detail).toBe('idempotency-conflict');
    expect(await stockFootprint()).toEqual(footprint);

    // The same conflict rule protects orders and suppliers.
    const poOperation = `po-conflict-${newId()}`;
    await order({
      operationId: poOperation,
      supplierId: supplierMain,
      branchId: T.branchA,
      reference: null,
      lines: [{ productId: T.milk, orderedQuantityScaled: '1000' }],
    });
    const orderConflict = await refusal(() =>
      order({
        operationId: poOperation,
        supplierId: supplierMain,
        branchId: T.branchA,
        reference: null,
        lines: [{ productId: T.milk, orderedQuantityScaled: '2000' }],
      }),
    );
    expect((orderConflict as PurchasingRefusedError).detail).toBe('idempotency-conflict');
  }, 90_000);

  // -------------------------------------------------------------------------
  // I — over-receipt under concurrency
  // -------------------------------------------------------------------------

  it('I: two concurrent receipts cannot both spend the same remaining quantity', async () => {
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '10000' }]);
    const lineId = po.lineIdFor(T.milk);

    // Ordered 10000, already received 6000, so 4000 remains. Two clerks each
    // try to book 3000 at the same moment; together that would be 12000.
    await receive({
      operationId: `rc-seed-${newId()}`,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '6000' }],
    });
    const before = await balanceOf(T.branchA, T.milk);

    const settled = await within(
      'two concurrent receipts',
      30_000,
      Promise.allSettled([
        receive(
          {
            operationId: `rc-race-a-${newId()}`,
            purchaseOrderId: po.id,
            reference: null,
            lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '3000' }],
          },
          actor,
          prisma,
        ),
        receive(
          {
            operationId: `rc-race-b-${newId()}`,
            purchaseOrderId: po.id,
            reference: null,
            lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '3000' }],
          },
          actor,
          second,
        ),
      ]),
    );

    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PurchasingRefusedError);
    expect(((rejected[0] as PromiseRejectedResult).reason as PurchasingRefusedError).detail).toBe(
      'over-receipt',
    );

    // Exactly one of the two 3000s landed: 9000 received, never 12000.
    const line = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.purchaseOrderLine.findFirstOrThrow({
        where: { tenantId: T.tenant, id: lineId },
        select: { receivedQuantityScaled: true, orderedQuantityScaled: true },
      }),
    );
    expect(line.receivedQuantityScaled).toBe(9_000n);
    expect(line.receivedQuantityScaled).toBeLessThanOrEqual(line.orderedQuantityScaled);

    // And the stock moved by exactly the quantity that was accepted.
    expect((await balanceOf(T.branchA, T.milk))?.quantityScaled).toBe(
      (before?.quantityScaled ?? 0n) + 3_000n,
    );
    expect((await getPurchaseOrder(prisma, T.tenant, po.id))?.status).toBe('partially_received');
  }, 120_000);

  it('I: a single over-sized receipt is refused with nothing written', async () => {
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '5000' }]);
    const footprint = await stockFootprint();

    const refused = await refusal(() =>
      receive({
        operationId: `rc-over-${newId()}`,
        purchaseOrderId: po.id,
        reference: null,
        // Six whole units against an order for five. Whole units on purpose,
        // so the refusal is the over-receipt rule rather than the unit-shape
        // rule catching it first.
        lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '6000' }],
      }),
    );
    expect((refused as PurchasingRefusedError).detail).toBe('over-receipt');

    expect(await stockFootprint()).toEqual(footprint);
    const residue = await withTenant(prisma, scope.tenantId, async (tx) => ({
      receipts: await tx.purchaseReceipt.count({
        where: { tenantId: T.tenant, purchaseOrderId: po.id },
      }),
      received: (
        await tx.purchaseOrderLine.findFirstOrThrow({
          where: { tenantId: T.tenant, id: po.lineIdFor(T.milk) },
          select: { receivedQuantityScaled: true },
        })
      ).receivedQuantityScaled.toString(),
      status: (
        await tx.purchaseOrder.findFirstOrThrow({
          where: { tenantId: T.tenant, id: po.id },
          select: { status: true },
        })
      ).status,
    }));
    expect(residue).toEqual({ receipts: 0, received: '0', status: 'open' });
  }, 90_000);

  // -------------------------------------------------------------------------
  // J — determinism
  // -------------------------------------------------------------------------

  it('J: a multi-line receipt is the same operation whatever order the lines arrive in', async () => {
    const po = await freshOrder([
      { productId: T.milk, orderedQuantityScaled: '20000' },
      { productId: T.rice, orderedQuantityScaled: '20000' },
    ]);
    const milkLine = po.lineIdFor(T.milk);
    const riceLine = po.lineIdFor(T.rice);
    const operationId = `rc-order-${newId()}`;

    const forward = await receive({
      operationId,
      purchaseOrderId: po.id,
      reference: null,
      lines: [
        { purchaseOrderLineId: milkLine, acceptedQuantityScaled: '1000' },
        { purchaseOrderLineId: riceLine, acceptedQuantityScaled: '2000' },
      ],
    });
    const footprint = await stockFootprint();

    // The same intent, listed the other way round. It must replay, not conflict.
    const reversed = await receive({
      operationId,
      purchaseOrderId: po.id,
      reference: null,
      lines: [
        { purchaseOrderLineId: riceLine, acceptedQuantityScaled: '2000' },
        { purchaseOrderLineId: milkLine, acceptedQuantityScaled: '1000' },
      ],
    });

    expect(reversed.replayed).toBe(true);
    expect(reversed.id).toBe(forward.id);
    // Byte-identical results, so one committed operation never tells two
    // callers two different things.
    expect(JSON.stringify(reversed.lines)).toBe(JSON.stringify(forward.lines));
    expect(await stockFootprint()).toEqual(footprint);

    // Two movements, one per line, each attributable to its own receipt line.
    const movements = await movementsFor(forward.id);
    expect(movements).toHaveLength(2);
    expect(new Set(movements.map((movement) => movement.sourceLineId)).size).toBe(2);
    expect(movements.map((movement) => movement.quantityScaled).reduce((a, b) => a + b, 0n)).toBe(
      3_000n,
    );
  }, 90_000);

  // -------------------------------------------------------------------------
  // K, L, X — quantity and identity shape
  // -------------------------------------------------------------------------

  it('K: a unit product cannot accept a fractional quantity', async () => {
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '10000' }]);
    const footprint = await stockFootprint();

    const refused = await refusal(() =>
      receive({
        operationId: `rc-frac-${newId()}`,
        purchaseOrderId: po.id,
        reference: null,
        lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '1500' }],
      }),
    );
    expect(refused).toBeInstanceOf(PurchasingRequestError);
    expect((refused as PurchasingRequestError).detail).toBe('fractional-unit-quantity');
    expect(await stockFootprint()).toEqual(footprint);

    // The same rule holds when the order is placed, not only when it arrives.
    const ordering = await refusal(() =>
      order({
        operationId: `po-frac-${newId()}`,
        supplierId: supplierMain,
        branchId: T.branchA,
        reference: null,
        lines: [{ productId: T.milk, orderedQuantityScaled: '1500' }],
      }),
    );
    expect((ordering as PurchasingRequestError).detail).toBe('fractional-unit-quantity');
  }, 90_000);

  it('L: a weighted product accepts a scaled fractional quantity', async () => {
    const po = await freshOrder([{ productId: T.scale, orderedQuantityScaled: '12500' }]);
    const before = (await balanceOf(T.branchA, T.scale))?.quantityScaled ?? 0n;

    const received = await receive({
      operationId: `rc-weighted-${newId()}`,
      purchaseOrderId: po.id,
      reference: null,
      // 7.25 kg — meaningful for a weighed product and refused for a unit one.
      lines: [{ purchaseOrderLineId: po.lineIdFor(T.scale), acceptedQuantityScaled: '7250' }],
    });

    expect(received.lines[0]?.acceptedQuantityScaled).toBe('7250');
    expect((await balanceOf(T.branchA, T.scale))?.quantityScaled).toBe(before + 7_250n);
    expect(received.purchaseOrderStatus).toBe('partially_received');
  }, 90_000);

  it('X: UUID case variants name one thing, not two', async () => {
    // Two spellings of one product in one order is one product, refused as a
    // duplicate rather than dying on the unique index.
    const duplicate = await refusal(() =>
      order({
        operationId: `po-case-${newId()}`,
        supplierId: supplierMain,
        branchId: T.branchA,
        reference: null,
        lines: [
          { productId: T.milk, orderedQuantityScaled: '1000' },
          { productId: T.milk.toUpperCase(), orderedQuantityScaled: '2000' },
        ],
      }),
    );
    expect((duplicate as PurchasingRequestError).detail).toBe('duplicate-product');

    // An upper-cased identity reaches the same rows, and comes back canonical.
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '4000' }]);
    const operationId = `rc-case-${newId()}`;
    const upper = await receive({
      operationId,
      purchaseOrderId: po.id.toUpperCase(),
      reference: null,
      lines: [
        { purchaseOrderLineId: po.lineIdFor(T.milk).toUpperCase(), acceptedQuantityScaled: '1000' },
      ],
    });
    expect(upper.purchaseOrderId).toBe(po.id);
    expect(upper.lines[0]?.purchaseOrderLineId).toBe(po.lineIdFor(T.milk));

    // The same submission re-spelled in lower case is the *same intent*, so it
    // replays rather than conflicting — which is only true because the
    // fingerprint canonicalizes identity before hashing it.
    const footprint = await stockFootprint();
    const replay = await receive({
      operationId,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '1000' }],
    });
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(upper.id);
    expect(await stockFootprint()).toEqual(footprint);

    // The control: a genuinely new operation id does commit a second time, so
    // the replay above was the fingerprint agreeing rather than the authority
    // refusing to work twice.
    const before = (await balanceOf(T.branchA, T.milk))?.quantityScaled ?? 0n;
    const again = await receive({
      operationId: `rc-case-again-${newId()}`,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '1000' }],
    });
    expect(again.replayed).toBe(false);
    expect((await balanceOf(T.branchA, T.milk))?.quantityScaled).toBe(before + 1_000n);
  }, 90_000);

  // -------------------------------------------------------------------------
  // M, N — branch and product authority
  // -------------------------------------------------------------------------

  it('M/N: an inactive branch, an inactive product and an untracked product are all refused', async () => {
    // An order into a stood-down branch is refused at ordering time.
    const closedBranch = await refusal(() =>
      order({
        operationId: `po-closed-${newId()}`,
        supplierId: supplierMain,
        branchId: T.branchClosed,
        reference: null,
        lines: [{ productId: T.milk, orderedQuantityScaled: '1000' }],
      }),
    );
    expect((closedBranch as PurchasingRefusedError).detail).toBe('inactive-branch');

    for (const [productId, expected] of [
      [T.inactive, 'inactive-product'],
      [T.untracked, 'untracked-product'],
    ] as const) {
      const refused = await refusal(() =>
        order({
          operationId: `po-bad-product-${newId()}`,
          supplierId: supplierMain,
          branchId: T.branchA,
          reference: null,
          lines: [{ productId, orderedQuantityScaled: '1000' }],
        }),
      );
      expect((refused as PurchasingRefusedError).detail, productId).toBe(expected);
    }

    // A deactivated supplier cannot be chosen for a new order...
    const offSupplier = await refusal(() =>
      order({
        operationId: `po-off-supplier-${newId()}`,
        supplierId: supplierOff,
        branchId: T.branchA,
        reference: null,
        lines: [{ productId: T.milk, orderedQuantityScaled: '1000' }],
      }),
    );
    expect((offSupplier as PurchasingRefusedError).detail).toBe('inactive-supplier');

    // ...but goods already ordered from a supplier who has since been stood
    // down still arrive. Deactivation is an administrative state, not a claim
    // that the merchant never bought from them.
    const stillGood = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '2000' }]);
    await editSupplier({
      operationId: `sup-pause-${newId()}`,
      supplierId: supplierMain,
      isActive: false,
    });
    const delivered = await receive({
      operationId: `rc-off-supplier-${newId()}`,
      purchaseOrderId: stillGood.id,
      reference: null,
      lines: [{ purchaseOrderLineId: stillGood.lineIdFor(T.milk), acceptedQuantityScaled: '2000' }],
    });
    expect(delivered.purchaseOrderStatus).toBe('received');
    await editSupplier({
      operationId: `sup-resume-${newId()}`,
      supplierId: supplierMain,
      isActive: true,
    });
  }, 120_000);

  it('N: a receipt is refused if the product stopped being tracked after the order', async () => {
    const po = await freshOrder([{ productId: T.rice, orderedQuantityScaled: '5000' }]);
    const footprint = await stockFootprint();

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.updateMany({
        where: { tenantId: T.tenant, id: T.rice },
        data: { trackInventory: false },
      });
    });

    // What was true when the order went out is not authority for a physical
    // stock mutation today (§17).
    const refused = await refusal(() =>
      receive({
        operationId: `rc-untracked-${newId()}`,
        purchaseOrderId: po.id,
        reference: null,
        lines: [{ purchaseOrderLineId: po.lineIdFor(T.rice), acceptedQuantityScaled: '1000' }],
      }),
    );
    expect((refused as PurchasingRefusedError).detail).toBe('untracked-product');
    expect(await stockFootprint()).toEqual(footprint);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.updateMany({
        where: { tenantId: T.tenant, id: T.rice },
        data: { trackInventory: true },
      });
    });
  }, 90_000);

  // -------------------------------------------------------------------------
  // O, P — serialization against concurrent authority changes
  // -------------------------------------------------------------------------

  it('O: a receipt waits for an in-flight branch deactivation and then refuses', async () => {
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '3000' }]);
    const footprint = await stockFootprint();

    const { blocked, result } = await whileUncommitted(
      `UPDATE "branches" SET "isActive" = FALSE, "updatedAt" = now()
        WHERE "tenantId" = $1::uuid AND "id" = '${T.branchA}'::uuid`,
      [T.tenant],
      () =>
        receive({
          operationId: `rc-branch-off-${newId()}`,
          purchaseOrderId: po.id,
          reference: null,
          lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '1000' }],
        }),
    );

    // It waited for the deactivation rather than reading around it...
    expect(blocked, 'the receipt did not block on the branch row').toBe(true);
    // ...and then saw the committed truth and refused.
    expect(result.status).toBe('rejected');
    const reason = (result as PromiseRejectedResult).reason as PurchasingRefusedError;
    expect(reason).toBeInstanceOf(PurchasingRefusedError);
    expect(reason.detail).toBe('inactive-branch');
    expect(await stockFootprint()).toEqual(footprint);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.branch.updateMany({
        where: { tenantId: T.tenant, id: T.branchA },
        data: { isActive: true },
      });
    });
  }, 120_000);

  it('P: a receipt waits for an in-flight trackInventory change and then refuses', async () => {
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '3000' }]);
    const footprint = await stockFootprint();

    const { blocked, result } = await whileUncommitted(
      `UPDATE "products" SET "trackInventory" = FALSE, "updatedAt" = now()
        WHERE "tenantId" = $1::uuid AND "id" = '${T.milk}'::uuid`,
      [T.tenant],
      () =>
        receive({
          operationId: `rc-untrack-race-${newId()}`,
          purchaseOrderId: po.id,
          reference: null,
          lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '1000' }],
        }),
    );

    expect(blocked, 'the receipt did not block on the product row').toBe(true);
    expect(result.status).toBe('rejected');
    expect(((result as PromiseRejectedResult).reason as PurchasingRefusedError).detail).toBe(
      'untracked-product',
    );
    expect(await stockFootprint()).toEqual(footprint);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.updateMany({
        where: { tenantId: T.tenant, id: T.milk },
        data: { trackInventory: true },
      });
    });
  }, 120_000);

  // -------------------------------------------------------------------------
  // Q — atomicity
  // -------------------------------------------------------------------------

  it('Q: a late failure rolls back receipt, stock, cost, audit and idempotency', async () => {
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '8000' }]);
    const lineId = po.lineIdFor(T.milk);
    const footprint = await stockFootprint();
    const costBefore = await costFootprint();

    // A fault installed in the database rather than the code under test. The
    // audit insert is the last write of the receipt transaction, so refusing it
    // fails the operation at the one point where the receipt, the accumulator,
    // the status, the movement and the balance have all already moved.
    const fault = new pg.Client({ connectionString: url });
    await fault.connect();
    await fault.query(`
      CREATE FUNCTION korvi_test_refuse_receipt_audit() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."eventType" = 'purchasing.receipt.finalized' THEN
          RAISE EXCEPTION 'korvi test fault: purchasing audit refused';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER korvi_test_refuse_receipt_audit
        BEFORE INSERT ON "audit_events"
        FOR EACH ROW EXECUTE FUNCTION korvi_test_refuse_receipt_audit();`);

    const operationId = `rc-late-${newId()}`;
    const request: PurchaseReceiptRequest = {
      operationId,
      purchaseOrderId: po.id,
      reference: null,
      lines: [
        {
          purchaseOrderLineId: lineId,
          acceptedQuantityScaled: '4000',
          inventoryValueMinor: '80',
        },
      ],
    };
    const failed = await refusal(() => receive(request));
    expect(failed.message).toMatch(/korvi test fault/);

    await fault.query(`
      DROP TRIGGER korvi_test_refuse_receipt_audit ON "audit_events";
      DROP FUNCTION korvi_test_refuse_receipt_audit();`);
    await fault.end();

    // Nothing survives. Half a receipt is stock that arrived with no evidence.
    expect(await stockFootprint()).toEqual(footprint);
    expect(await costFootprint()).toEqual(costBefore);
    const residue = await withTenant(prisma, scope.tenantId, async (tx) => ({
      receipts: await tx.purchaseReceipt.count({ where: { tenantId: T.tenant, operationId } }),
      receiptLines: await tx.purchaseReceiptLine.count({
        where: { tenantId: T.tenant, purchaseOrderLineId: lineId },
      }),
      received: (
        await tx.purchaseOrderLine.findFirstOrThrow({
          where: { tenantId: T.tenant, id: lineId },
          select: { receivedQuantityScaled: true },
        })
      ).receivedQuantityScaled.toString(),
      status: (
        await tx.purchaseOrder.findFirstOrThrow({
          where: { tenantId: T.tenant, id: po.id },
          select: { status: true },
        })
      ).status,
      key: await tx.idempotencyKey.count({
        where: { tenantId: T.tenant, scope: 'purchasing-receipt-create', operationId },
      }),
    }));
    expect(residue).toEqual({
      receipts: 0,
      receiptLines: 0,
      received: '0',
      status: 'open',
      key: 0,
    });

    // The operation id is free again, because its reservation rolled back with
    // everything else. A retry succeeds rather than being told it conflicts.
    const retried = await receive(request);
    expect(retried.replayed).toBe(false);
    expect(retried.purchaseOrderStatus).toBe('partially_received');
  }, 120_000);

  // -------------------------------------------------------------------------
  // W — historical immutability
  // -------------------------------------------------------------------------

  it('W: purchasing evidence blocks destructive branch, supplier and product deletion', async () => {
    const doomedSupplier = await newSupplier({
      operationId: `sup-doomed-${newId()}`,
      name: 'مورد سيُحذف',
    });
    const po = await freshOrder([{ productId: T.doomedProduct, orderedQuantityScaled: '1000' }], {
      branchId: T.branchDoomed,
      supplierId: doomedSupplier.supplier.id,
    });

    async function deletion(table: string, id: string): Promise<Error> {
      return refusal(async () => {
        await withTenant(prisma, scope.tenantId, async (tx) => {
          await tx.$executeRawUnsafe(
            `DELETE FROM "${table}" WHERE "tenantId" = $1::uuid AND "id" = $2::uuid`,
            T.tenant,
            id,
          );
        });
      });
    }

    // Each of these is `NO ACTION` on purpose: an administrative tidy-up must
    // not silently erase the record of what was ordered and what arrived
    // (ADR-0024 §10).
    expect((await deletion('branches', T.branchDoomed)).message).toMatch(
      /purchase_orders_tenantId_branchId_fkey/,
    );
    expect((await deletion('suppliers', doomedSupplier.supplier.id)).message).toMatch(
      /purchase_orders_tenantId_supplierId_fkey/,
    );
    expect((await deletion('products', T.doomedProduct)).message).toMatch(
      /purchase_order_lines_tenantId_productId_fkey/,
    );

    // The evidence is all still there afterwards.
    expect(await getPurchaseOrder(prisma, T.tenant, po.id)).not.toBeNull();
  }, 90_000);

  it('W: receiving evidence outlives the order it was booked against', async () => {
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '2000' }]);
    const receipt = await receive({
      operationId: `rc-immutable-${newId()}`,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '2000' }],
    });

    // A receipt is not a detail of its order: the movements it caused are in
    // the ledger, and deleting the order would leave balance history that no
    // document explains.
    const failed = await refusal(async () => {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        await tx.$executeRaw`
          DELETE FROM "purchase_orders"
           WHERE "tenantId" = ${T.tenant}::uuid AND "id" = ${po.id}::uuid`;
      });
    });
    expect(failed.message).toMatch(/purchase_receipts_tenantId_purchaseOrderId_fkey/);

    const still = await listPurchaseReceipts(prisma, T.tenant, po.id, 50);
    expect(still.map((row) => row.id)).toContain(receipt.id);
  }, 90_000);

  // -------------------------------------------------------------------------
  // V — permissions are not widened
  // -------------------------------------------------------------------------

  it('V: cashier and custom roles receive no purchasing authority', async () => {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.role.create({
        data: {
          id: T.customRole,
          tenantId: T.tenant,
          key: `custom-${T.customRole}`,
          nameAr: 'دور مخصص',
          nameEn: 'Custom',
          maxDiscountBasisPoints: 0,
          isSystem: false,
        },
      });
    });

    const granted = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.rolePermission.findMany({
        where: { tenantId: T.tenant, permissionKey: { startsWith: 'purchasing.' } },
        select: { roleId: true, permissionKey: true },
      }),
    );
    const roles = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.role.findMany({
        where: { tenantId: T.tenant },
        select: { id: true, key: true, isSystem: true },
      }),
    );
    const keyOf = new Map(roles.map((role) => [role.id, role.key]));

    const holders = new Set(granted.map((row) => keyOf.get(row.roleId) ?? '?'));
    expect([...holders].sort()).toEqual(['admin', 'manager', 'owner']);
    expect(holders.has('cashier')).toBe(false);
    expect(holders.has(`custom-${T.customRole}`)).toBe(false);

    // All three permissions, to all three roles, and nothing else.
    expect(granted).toHaveLength(9);
    expect(new Set(granted.map((row) => row.permissionKey))).toEqual(
      new Set(['purchasing.read', 'purchasing.manage', 'purchasing.receive']),
    );
  }, 60_000);

  // -------------------------------------------------------------------------
  // Stable replay — the committed answer, not today's state
  //
  // Every test below performs a *later legitimate mutation* between the
  // original operation and its retry, which is the case that separates
  // "replays the committed result" from "reads the document back". Without the
  // intervening mutation these would pass against either implementation and
  // prove nothing.
  // -------------------------------------------------------------------------

  it('A: a supplier create replays its own answer after the supplier is renamed and deactivated', async () => {
    const operationId = `sup-stable-${newId()}`;
    const request: SupplierCreateRequest = { operationId, name: 'مؤسسة الخبر' };
    const created = await newSupplier(request);
    expect(created.replayed).toBe(false);

    // The later, entirely legitimate change.
    const renamed = await editSupplier({
      operationId: `sup-stable-edit-${newId()}`,
      supplierId: created.supplier.id,
      name: 'مؤسسة الخبر للتجارة',
      isActive: false,
    });
    expect(renamed.supplier.name).not.toBe(created.supplier.name);
    expect(renamed.supplier.isActive).toBe(false);

    const replay = await newSupplier(request);

    // The creation's own answer, unchanged — not the supplier as it reads now.
    expect(replay.replayed).toBe(true);
    expect(replay.supplier).toEqual(created.supplier);
    expect(replay.supplier.name).toBe('مؤسسة الخبر');
    expect(replay.supplier.isActive).toBe(true);
    expect(replay.supplier.updatedAt).toBe(created.supplier.updatedAt);

    // And the live supplier really did move on, so the equality above is the
    // snapshot holding rather than the update having failed.
    const current = await getSupplier(prisma, T.tenant, created.supplier.id);
    expect(current?.name).toBe('مؤسسة الخبر للتجارة');
    expect(current?.isActive).toBe(false);
  }, 90_000);

  it('B: a supplier update replays its own answer after a second update', async () => {
    const supplier = await newSupplier({ operationId: `sup-b-${newId()}`, name: 'مورد ب' });
    const operationId = `sup-update-stable-${newId()}`;
    const request: SupplierUpdateRequest = {
      operationId,
      supplierId: supplier.supplier.id,
      name: 'مورد ب — تعديل أول',
    };

    const first = await editSupplier(request);
    expect(first.replayed).toBe(false);
    expect(first.supplier.name).toBe('مورد ب — تعديل أول');

    await editSupplier({
      operationId: `sup-update-second-${newId()}`,
      supplierId: supplier.supplier.id,
      name: 'مورد ب — تعديل ثانٍ',
      isActive: false,
    });

    const replay = await editSupplier(request);
    expect(replay.replayed).toBe(true);
    expect(replay.supplier).toEqual(first.supplier);
    expect(replay.supplier.name).toBe('مورد ب — تعديل أول');
    expect(replay.supplier.isActive).toBe(true);

    const current = await getSupplier(prisma, T.tenant, supplier.supplier.id);
    expect(current?.name).toBe('مورد ب — تعديل ثانٍ');
    expect(current?.isActive).toBe(false);
  }, 90_000);

  it('C: a purchase order create replays its creation answer after goods arrive', async () => {
    const operationId = `po-stable-${newId()}`;
    const request: PurchaseOrderRequest = {
      operationId,
      supplierId: supplierMain,
      branchId: T.branchA,
      reference: 'PO-STABLE',
      lines: [{ productId: T.milk, orderedQuantityScaled: '20000' }],
    };

    const created = await order(request);
    expect(created.replayed).toBe(false);
    expect(created.order.status).toBe('open');
    expect(created.order.lines[0]?.receivedQuantityScaled).toBe('0');
    expect(created.order.lines[0]?.remainingQuantityScaled).toBe('20000');

    const lineId = created.order.lines[0]?.id ?? '';
    await receive({
      operationId: `po-stable-rc1-${newId()}`,
      purchaseOrderId: created.order.id,
      reference: null,
      lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '5000' }],
    });
    await receive({
      operationId: `po-stable-rc2-${newId()}`,
      purchaseOrderId: created.order.id,
      reference: null,
      lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '15000' }],
    });

    const footprint = await stockFootprint();
    const replay = await order(request);

    // The order the creation produced: open, nothing received, everything
    // outstanding. Reading the document back would have said `received`,
    // 20000 and 0.
    expect(replay.replayed).toBe(true);
    expect(replay.order).toEqual(created.order);
    expect(replay.order.status).toBe('open');
    expect(replay.order.lines[0]?.receivedQuantityScaled).toBe('0');
    expect(replay.order.lines[0]?.remainingQuantityScaled).toBe('20000');

    // The live order really is finished, and the replay moved nothing.
    const current = await getPurchaseOrder(prisma, T.tenant, created.order.id);
    expect(current?.status).toBe('received');
    expect(current?.lines[0]?.receivedQuantityScaled).toBe('20000');
    expect(await stockFootprint()).toEqual(footprint);
  }, 120_000);

  it('D: receipt A replays its own status after receipt B completes the order', async () => {
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '100000' }]);
    const lineId = po.lineIdFor(T.milk);

    const operationId = `rc-stable-a-${newId()}`;
    const requestA: PurchaseReceiptRequest = {
      operationId,
      purchaseOrderId: po.id,
      reference: 'DN-A',
      lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '30000' }],
    };

    const receiptA = await receive(requestA);
    expect(receiptA.replayed).toBe(false);
    expect(receiptA.purchaseOrderStatus).toBe('partially_received');

    const receiptB = await receive({
      operationId: `rc-stable-b-${newId()}`,
      purchaseOrderId: po.id,
      reference: 'DN-B',
      lines: [{ purchaseOrderLineId: lineId, acceptedQuantityScaled: '70000' }],
    });
    expect(receiptB.purchaseOrderStatus).toBe('received');

    // Everything the replay must not disturb, measured first.
    const footprint = await stockFootprint();
    const before = await withTenant(prisma, scope.tenantId, async (tx) => ({
      receipts: await tx.purchaseReceipt.count({ where: { tenantId: T.tenant } }),
      receiptLines: await tx.purchaseReceiptLine.count({ where: { tenantId: T.tenant } }),
      audit: await tx.auditEvent.count({
        where: { tenantId: T.tenant, eventType: 'purchasing.receipt.finalized' },
      }),
      received: (
        await tx.purchaseOrderLine.findFirstOrThrow({
          where: { tenantId: T.tenant, id: lineId },
          select: { receivedQuantityScaled: true },
        })
      ).receivedQuantityScaled.toString(),
    }));

    const replay = await receive(requestA);

    // Receipt A's committed result. The order says `received` now; A never
    // produced that, and must not be made to claim it.
    expect(replay.replayed).toBe(true);
    expect(replay.purchaseOrderStatus).toBe('partially_received');
    expect(replay.id).toBe(receiptA.id);
    expect(replay.reference).toBe('DN-A');
    expect(replay.receivedAt).toBe(receiptA.receivedAt);
    // Byte-identical line evidence, revisions included.
    expect(JSON.stringify(replay.lines)).toBe(JSON.stringify(receiptA.lines));
    expect(replay.lines[0]?.beforeReceivedQuantityScaled).toBe('0');
    expect(replay.lines[0]?.afterReceivedQuantityScaled).toBe('30000');

    // The order genuinely is complete, so the assertion above is the snapshot
    // holding rather than receipt B having failed.
    expect((await getPurchaseOrder(prisma, T.tenant, po.id))?.status).toBe('received');

    // Nothing happened a second time.
    expect(await stockFootprint()).toEqual(footprint);
    const after = await withTenant(prisma, scope.tenantId, async (tx) => ({
      receipts: await tx.purchaseReceipt.count({ where: { tenantId: T.tenant } }),
      receiptLines: await tx.purchaseReceiptLine.count({ where: { tenantId: T.tenant } }),
      audit: await tx.auditEvent.count({
        where: { tenantId: T.tenant, eventType: 'purchasing.receipt.finalized' },
      }),
      received: (
        await tx.purchaseOrderLine.findFirstOrThrow({
          where: { tenantId: T.tenant, id: lineId },
          select: { receivedQuantityScaled: true },
        })
      ).receivedQuantityScaled.toString(),
    }));
    expect(after).toEqual(before);
  }, 120_000);

  it('E: changed intent still conflicts, in every purchasing scope', async () => {
    // The stable-replay mechanism must not have widened what counts as "the
    // same request". Each pair below differs materially and must be refused.
    const supplierOperation = `sup-intent-${newId()}`;
    await newSupplier({ operationId: supplierOperation, name: 'مورد النية' });
    expect(
      (
        (await refusal(() =>
          newSupplier({ operationId: supplierOperation, name: 'اسم مختلف' }),
        )) as PurchasingRefusedError
      ).detail,
    ).toBe('idempotency-conflict');

    const target = await newSupplier({ operationId: `sup-target-${newId()}`, name: 'هدف' });
    const updateOperation = `sup-update-intent-${newId()}`;
    await editSupplier({
      operationId: updateOperation,
      supplierId: target.supplier.id,
      name: 'اسم أول',
    });
    expect(
      (
        (await refusal(() =>
          editSupplier({
            operationId: updateOperation,
            supplierId: target.supplier.id,
            name: 'اسم ثانٍ',
          }),
        )) as PurchasingRefusedError
      ).detail,
    ).toBe('idempotency-conflict');

    const orderOperation = `po-intent-${newId()}`;
    await order({
      operationId: orderOperation,
      supplierId: supplierMain,
      branchId: T.branchA,
      reference: null,
      lines: [{ productId: T.milk, orderedQuantityScaled: '1000' }],
    });
    expect(
      (
        (await refusal(() =>
          order({
            operationId: orderOperation,
            supplierId: supplierMain,
            branchId: T.branchA,
            reference: null,
            lines: [{ productId: T.milk, orderedQuantityScaled: '2000' }],
          }),
        )) as PurchasingRefusedError
      ).detail,
    ).toBe('idempotency-conflict');

    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '10000' }]);
    const receiptOperation = `rc-intent-${newId()}`;
    await receive({
      operationId: receiptOperation,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '1000' }],
    });
    const footprint = await stockFootprint();
    expect(
      (
        (await refusal(() =>
          receive({
            operationId: receiptOperation,
            purchaseOrderId: po.id,
            reference: null,
            lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '2000' }],
          }),
        )) as PurchasingRefusedError
      ).detail,
    ).toBe('idempotency-conflict');
    expect(await stockFootprint()).toEqual(footprint);
  }, 120_000);

  it('freezes the answer in the same transaction, so a rolled-back operation leaves none', async () => {
    // The snapshot is evidence rather than a cache, and this is what that
    // means: the operation that failed late in proof Q wrote no snapshot, so
    // its operation id is genuinely free rather than pointing at a half-answer.
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '4000' }]);
    const operationId = `rc-snapshot-${newId()}`;

    const committed = await receive({
      operationId,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '1000' }],
    });

    const stored = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.idempotencyKey.findFirst({
        where: { tenantId: T.tenant, scope: 'purchasing-receipt-create', operationId },
        select: { resultSnapshot: true, resultId: true },
      }),
    );
    expect(stored?.resultId).toBe(committed.id);
    // Present, structured, and carrying the status this receipt produced.
    expect(stored?.resultSnapshot).not.toBeNull();
    expect(JSON.stringify(stored?.resultSnapshot)).toContain('partially_received');

    // Nothing that predates Strike 5B was given an invented one: the 5A stock
    // scopes still store no snapshot at all.
    const stockKeys = await withTenant(prisma, scope.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "idempotency_keys"
         WHERE "tenantId" = ${T.tenant}::uuid
           AND "scope" IN ('inventory-adjustment', 'inventory-count', 'inventory-transfer')
           AND "resultSnapshot" IS NOT NULL`;
      return Number(rows.at(0)?.n ?? -1n);
    });
    expect(stockKeys).toBe(0);
  }, 90_000);

  it('fails loudly if a committed purchasing replay has lost its snapshot, with zero second effect', async () => {
    const po = await freshOrder([{ productId: T.milk, orderedQuantityScaled: '4000' }]);
    const operationId = `rc-missing-snapshot-${newId()}`;
    const request: PurchaseReceiptRequest = {
      operationId,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: po.lineIdFor(T.milk), acceptedQuantityScaled: '1000' }],
    };

    const committed = await receive(request);
    expect(committed.replayed).toBe(false);

    const footprint = await stockFootprint();
    const before = await withTenant(prisma, scope.tenantId, async (tx) => ({
      receipts: await tx.purchaseReceipt.count({ where: { tenantId: T.tenant } }),
      receiptLines: await tx.purchaseReceiptLine.count({ where: { tenantId: T.tenant } }),
      movements: await tx.inventoryMovement.count({ where: { tenantId: T.tenant } }),
      audit: await tx.auditEvent.count({
        where: { tenantId: T.tenant, eventType: 'purchasing.receipt.finalized' },
      }),
      received: (
        await tx.purchaseOrderLine.findFirstOrThrow({
          where: { tenantId: T.tenant, id: po.lineIdFor(T.milk) },
          select: { receivedQuantityScaled: true },
        })
      ).receivedQuantityScaled.toString(),
    }));

    // Simulate storage corruption after a lawful commit. The idempotency row,
    // request hash and result id remain; only the historical answer is missing.
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE "idempotency_keys"
           SET "resultSnapshot" = NULL
         WHERE "tenantId" = ${T.tenant}::uuid
           AND "scope" = 'purchasing-receipt-create'
           AND "operationId" = ${operationId}`;
    });

    const failed = await refusal(() => receive(request));
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(PurchasingRefusedError);
    expect(failed.message).toContain('Purchasing snapshot invariant failure');
    expect(failed.message).toContain('purchasing-receipt-create');
    expect(failed.message).not.toContain('idempotency-conflict');

    // A corrupted replay is not allowed to improvise by doing the business
    // operation again. Nothing in the receipt/stock/audit footprint moves.
    expect(await stockFootprint()).toEqual(footprint);
    const after = await withTenant(prisma, scope.tenantId, async (tx) => ({
      receipts: await tx.purchaseReceipt.count({ where: { tenantId: T.tenant } }),
      receiptLines: await tx.purchaseReceiptLine.count({ where: { tenantId: T.tenant } }),
      movements: await tx.inventoryMovement.count({ where: { tenantId: T.tenant } }),
      audit: await tx.auditEvent.count({
        where: { tenantId: T.tenant, eventType: 'purchasing.receipt.finalized' },
      }),
      received: (
        await tx.purchaseOrderLine.findFirstOrThrow({
          where: { tenantId: T.tenant, id: po.lineIdFor(T.milk) },
          select: { receivedQuantityScaled: true },
        })
      ).receivedQuantityScaled.toString(),
    }));
    expect(after).toEqual(before);
  }, 90_000);

  // -------------------------------------------------------------------------
  // R/S/T — the shared stock primitive still behaves
  // -------------------------------------------------------------------------

  it('R/S/T: receiving uses the shared primitive, so 5A revision semantics are unchanged', async () => {
    // The full sale, return, adjustment, count and transfer regressions are the
    // existing `checkout-live`, `returns-live` and `inventory-stock-live`
    // suites, which run unmodified. What is asserted here is the property that
    // links them to this strike: receiving goes through the *same*
    // `applyMovementWithin`, so it steps the same revision counter that a stock
    // count compares against (ADR-0024 §1, §9).
    const po = await freshOrder([{ productId: T.scale, orderedQuantityScaled: '9000' }]);
    const before = (await balanceOf(T.branchA, T.scale)) ?? {
      quantityScaled: 0n,
      revision: 0n,
    };

    const first = await receive({
      operationId: `rc-rev-a-${newId()}`,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: po.lineIdFor(T.scale), acceptedQuantityScaled: '3000' }],
    });
    const secondReceipt = await receive({
      operationId: `rc-rev-b-${newId()}`,
      purchaseOrderId: po.id,
      reference: null,
      lines: [{ purchaseOrderLineId: po.lineIdFor(T.scale), acceptedQuantityScaled: '3000' }],
    });

    // Exactly one revision step per receipt line, never two and never none.
    expect(BigInt(first.lines[0]?.resultRevision ?? '0')).toBe(before.revision + 1n);
    expect(BigInt(secondReceipt.lines[0]?.resultRevision ?? '0')).toBe(before.revision + 2n);
    const after = await balanceOf(T.branchA, T.scale);
    expect(after?.revision).toBe(before.revision + 2n);
    expect(after?.quantityScaled).toBe(before.quantityScaled + 6_000n);
  }, 90_000);

  // -------------------------------------------------------------------------
  // Supplier authority
  // -------------------------------------------------------------------------

  it('creates, lists and updates suppliers without ever deleting one', async () => {
    const created = await newSupplier({ operationId: `sup-x-${newId()}`, name: 'مؤسسة جدة' });
    expect(created.supplier.isActive).toBe(true);
    expect(created.replayed).toBe(false);

    // Duplicate names are allowed: two companies can trade under one name, and
    // a merchant with two accounts at one wholesaler is ordinary.
    const twin = await newSupplier({ operationId: `sup-y-${newId()}`, name: 'مؤسسة جدة' });
    expect(twin.supplier.id).not.toBe(created.supplier.id);

    const renamed = await editSupplier({
      operationId: `sup-rename-${newId()}`,
      supplierId: created.supplier.id,
      name: 'مؤسسة جدة التجارية',
      isActive: false,
    });
    expect(renamed.supplier.name).toBe('مؤسسة جدة التجارية');
    expect(renamed.supplier.isActive).toBe(false);

    // Deactivated suppliers stay in the list unless the caller asks otherwise.
    const all = await listSuppliers(prisma, T.tenant, {
      limit: 200,
      cursor: null,
      activeOnly: false,
    });
    const activeOnly = await listSuppliers(prisma, T.tenant, {
      limit: 200,
      cursor: null,
      activeOnly: true,
    });
    expect(all.rows.map((row) => row.id)).toContain(created.supplier.id);
    expect(activeOnly.rows.map((row) => row.id)).not.toContain(created.supplier.id);

    // An update that names an unknown supplier fails closed.
    const unknown = await refusal(() =>
      editSupplier({
        operationId: `sup-missing-${newId()}`,
        supplierId: '018f5b00-0000-7000-8000-0000000000ff',
        name: 'لا أحد',
      }),
    );
    expect((unknown as PurchasingRefusedError).detail).toBe('unknown-supplier');
  }, 90_000);

  it('pages suppliers by keyset without repeating or skipping a row', async () => {
    const all = await listSuppliers(prisma, T.tenant, {
      limit: 200,
      cursor: null,
      activeOnly: false,
    });
    expect(all.rows.length).toBeGreaterThan(2);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const next: Awaited<ReturnType<typeof listSuppliers>> = await listSuppliers(
        prisma,
        T.tenant,
        { limit: 2, cursor, activeOnly: false },
      );
      seen.push(...next.rows.map((row) => row.id));
      if (next.nextCursor === null) break;
      cursor = next.nextCursor;
    }

    expect(seen).toEqual(all.rows.map((row) => row.id));
    expect(new Set(seen).size).toBe(seen.length);
  }, 60_000);
});
