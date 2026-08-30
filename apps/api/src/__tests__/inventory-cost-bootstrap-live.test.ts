import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  CostingCapacityError,
  CostingRequestError,
  newId,
  tenantId as brandTenantId,
} from '@korvi/domain';
import {
  StockOperationRefusedError,
  createPrismaClient,
  recordInventoryCostBootstrap,
  withTenant,
} from '@korvi/database';
import { fingerprintCostBootstrap } from '../inventory/fingerprint.js';
import type { CostBootstrapRequest, TenantScope } from '@korvi/domain';
import type { CostBootstrapActor, PrismaClient } from '@korvi/database';

/**
 * Prospective valuation against real PostgreSQL.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must name a throwaway database with all
 * migrations applied and an application role with NOSUPERUSER NOBYPASSRLS.
 * The role and FORCE RLS facts are asserted below rather than assumed.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const T = {
  tenant: '018f5c00-0000-7000-8000-00000000000a',
  branch: '018f5c00-0000-7000-8000-0000000000a1',
  user: '018f5c00-0000-7000-8000-0000000000a2',
  known: '018f5c00-0000-7000-8000-0000000000a3',
  duplicate: '018f5c00-0000-7000-8000-0000000000a4',
  empty: '018f5c00-0000-7000-8000-0000000000a5',
  late: '018f5c00-0000-7000-8000-0000000000a6',
  capacity: '018f5c00-0000-7000-8000-0000000000a7',
} as const;

const OTHER = {
  tenant: '018f5c00-0000-7000-8000-00000000000b',
  branch: '018f5c00-0000-7000-8000-0000000000b1',
  user: '018f5c00-0000-7000-8000-0000000000b2',
  product: '018f5c00-0000-7000-8000-0000000000b3',
} as const;

function within<TValue>(label: string, ms: number, work: Promise<TValue>): Promise<TValue> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(label + ' did not settle within ' + String(ms) + 'ms')),
        ms,
      ),
    ),
  ]);
}

describe.skipIf(url === '')('inventory cost bootstrap, live', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;

  const scope: TenantScope = { tenantId: brandTenantId(T.tenant) };
  const actor: CostBootstrapActor = { tenantId: T.tenant, userId: T.user };

  async function removeTenant(id: string): Promise<void> {
    await withTenant(prisma, id, async (tx) => {
      await tx.tenant.deleteMany({ where: { id } });
    });
  }

  async function refusal(work: () => Promise<unknown>): Promise<Error> {
    try {
      await work();
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error('expected a refusal, and the call succeeded');
  }

  function request(
    productId: string,
    totalValueMinor: string,
    operationId: string = 'bootstrap-' + newId(),
  ): CostBootstrapRequest {
    return { operationId, branchId: T.branch, productId, totalValueMinor };
  }

  const bootstrap = (
    input: CostBootstrapRequest,
    client: PrismaClient = prisma,
    who: CostBootstrapActor = actor,
  ) =>
    recordInventoryCostBootstrap(client, who, input, fingerprintCostBootstrap(input, who.userId));

  async function setBalance(productId: string, quantityScaled: bigint, revision: bigint) {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.inventoryCostBalance.deleteMany({
        where: { tenantId: T.tenant, branchId: T.branch, productId },
      });
      await tx.inventoryBalance.upsert({
        where: {
          tenantId_branchId_productId: {
            tenantId: T.tenant,
            branchId: T.branch,
            productId,
          },
        },
        create: {
          tenantId: T.tenant,
          branchId: T.branch,
          productId,
          quantityScaled,
          revision,
          updatedAt: new Date(),
        },
        update: { quantityScaled, revision },
      });
    });
  }

  async function state(productId: string) {
    return withTenant(prisma, scope.tenantId, async (tx) => ({
      stock: await tx.inventoryBalance.findFirst({
        where: { tenantId: T.tenant, branchId: T.branch, productId },
        select: { quantityScaled: true, revision: true },
      }),
      cost: await tx.inventoryCostBalance.findFirst({
        where: { tenantId: T.tenant, branchId: T.branch, productId },
      }),
      events: await tx.inventoryValuationEvent.findMany({
        where: { tenantId: T.tenant, branchId: T.branch, productId },
      }),
    }));
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    second = createPrismaClient(url);
    await second.$queryRaw`SELECT 1`;
    await removeTenant(T.tenant);
    await removeTenant(OTHER.tenant);

    await withTenant(prisma, T.tenant, async (tx) => {
      await tx.tenant.create({
        data: {
          id: T.tenant,
          name: 'متجر التكلفة',
          slug: 'cost-bootstrap-live-a',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({ data: { tenantId: T.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: {
          id: T.branch,
          tenantId: T.tenant,
          code: '01',
          nameAr: 'فرع التكلفة',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: T.user,
          tenantId: T.tenant,
          email: 'cost-manager@bootstrap-live-a.test',
          displayName: 'مدير التكلفة',
          updatedAt: new Date(),
        },
      });
      for (const [id, sku] of [
        [T.known, 'KNOWN'],
        [T.duplicate, 'DUPLICATE'],
        [T.empty, 'EMPTY'],
        [T.late, 'LATE'],
        [T.capacity, 'CAPACITY'],
      ] as const) {
        await tx.product.create({
          data: {
            id,
            tenantId: T.tenant,
            sku,
            nameAr: sku,
            priceMinor: 1000n,
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
          slug: 'cost-bootstrap-live-b',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({ data: { tenantId: OTHER.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: {
          id: OTHER.branch,
          tenantId: OTHER.tenant,
          code: '01',
          nameAr: 'فرع آخر',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: OTHER.user,
          tenantId: OTHER.tenant,
          email: 'cost-manager@bootstrap-live-b.test',
          displayName: 'مدير آخر',
          updatedAt: new Date(),
        },
      });
      await tx.product.create({
        data: {
          id: OTHER.product,
          tenantId: OTHER.tenant,
          sku: 'OTHER',
          nameAr: 'صنف آخر',
          priceMinor: 1000n,
          vatBasisPoints: 1500,
          updatedAt: new Date(),
        },
      });
    });
  }, 180_000);

  afterAll(async () => {
    await removeTenant(T.tenant);
    await removeTenant(OTHER.tenant);
    await prisma.$disconnect();
    await second.$disconnect();
  });

  it('runs under enforced RLS with a role that cannot bypass it', async () => {
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
         FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r'
        ORDER BY relname`,
      [['inventory_cost_balances', 'inventory_valuation_events']],
    );
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(table.relrowsecurity, table.relname).toBe(true);
      expect(table.relforcerowsecurity, table.relname).toBe(true);
    }
    await client.end();
  }, 60_000);

  it('derives only unknown positive quantity and commits immutable evidence atomically', async () => {
    await setBalance(T.known, 5000n, 7n);
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.inventoryCostBalance.create({
        data: {
          tenantId: T.tenant,
          branchId: T.branch,
          productId: T.known,
          knownQuantityScaled: 2000n,
          knownValueMinor: 80n,
          stockRevision: 7n,
          costRevision: 2n,
          updatedAt: new Date(),
        },
      });
    });

    const operationId = 'derive-' + newId();
    const input = request(T.known, '150', operationId);
    const result = await bootstrap(input);
    expect(result).toMatchObject({
      branchId: T.branch,
      productId: T.known,
      valuedQuantityScaled: '3000',
      stockRevision: '7',
      costRevision: '3',
      replayed: false,
    });

    const after = await state(T.known);
    expect(after.stock).toEqual({ quantityScaled: 5000n, revision: 7n });
    expect(after.cost).toMatchObject({
      knownQuantityScaled: 5000n,
      knownValueMinor: 230n,
      stockRevision: 7n,
      costRevision: 3n,
    });
    expect(after.events).toHaveLength(1);
    expect(after.events[0]).toMatchObject({
      id: result.id,
      eventKind: 'bootstrap',
      provenance: 'recorded',
      knownQuantityScaled: 3000n,
      unknownQuantityScaled: 0n,
      knownValueMinor: 150n,
      sourceType: 'cost-bootstrap',
      sourceId: result.id,
      actorUserId: T.user,
      stockRevision: 7n,
      costRevision: 3n,
    });

    const evidence = await withTenant(prisma, scope.tenantId, async (tx) => ({
      audit: await tx.auditEvent.count({
        where: { entityId: result.id, eventType: 'inventory.cost.bootstrapped' },
      }),
      movements: await tx.inventoryMovement.count({
        where: { tenantId: T.tenant, branchId: T.branch, productId: T.known },
      }),
      key: await tx.idempotencyKey.findFirst({
        where: { tenantId: T.tenant, scope: 'inventory-cost-bootstrap', operationId },
      }),
    }));
    expect(evidence.audit).toBe(1);
    expect(evidence.movements).toBe(0);
    expect(evidence.key).toMatchObject({ status: 'completed', resultId: result.id });

    const replayed = await bootstrap(input);
    expect(replayed).toEqual({ ...result, replayed: true });
    expect(await state(T.known)).toEqual(after);

    const conflict = await refusal(() => bootstrap({ ...input, totalValueMinor: '151' }));
    expect(conflict).toBeInstanceOf(StockOperationRefusedError);
    expect((conflict as StockOperationRefusedError).detail).toBe('idempotency-conflict');
    expect(await state(T.known)).toEqual(after);
  }, 60_000);

  it('commits exactly once when duplicate submissions arrive together', async () => {
    await setBalance(T.duplicate, 3000n, 4n);
    const input = request(T.duplicate, '100', 'duplicate-' + newId());

    const results = await within(
      'duplicate cost bootstraps',
      30_000,
      Promise.all([bootstrap(input, prisma), bootstrap(input, second)]),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);

    const after = await state(T.duplicate);
    expect(after.stock).toEqual({ quantityScaled: 3000n, revision: 4n });
    expect(after.cost).toMatchObject({
      knownQuantityScaled: 3000n,
      knownValueMinor: 100n,
      stockRevision: 4n,
      costRevision: 1n,
    });
    expect(after.events).toHaveLength(1);
  }, 60_000);

  it('rolls back reservation and the materialized cost row when there is nothing to value', async () => {
    await setBalance(T.empty, 0n, 0n);
    const operationId = 'empty-' + newId();
    const failed = await refusal(() => bootstrap(request(T.empty, '0', operationId)));
    expect(failed).toBeInstanceOf(CostingRequestError);
    expect((failed as CostingRequestError).detail).toBe('nothing-to-value');

    const after = await state(T.empty);
    expect(after.stock).toEqual({ quantityScaled: 0n, revision: 0n });
    expect(after.cost).toBeNull();
    expect(after.events).toHaveLength(0);
    const residue = await withTenant(prisma, scope.tenantId, async (tx) => ({
      key: await tx.idempotencyKey.count({
        where: { tenantId: T.tenant, scope: 'inventory-cost-bootstrap', operationId },
      }),
      audit: await tx.auditEvent.count({
        where: {
          tenantId: T.tenant,
          eventType: 'inventory.cost.bootstrapped',
          metadata: { path: ['operationId'], equals: operationId },
        },
      }),
    }));
    expect(residue).toEqual({ key: 0, audit: 0 });
  }, 60_000);

  it('refuses aggregate BIGINT overflow before writing and rolls back the reservation', async () => {
    await setBalance(T.capacity, 2000n, 5n);
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.inventoryCostBalance.create({
        data: {
          tenantId: T.tenant,
          branchId: T.branch,
          productId: T.capacity,
          knownQuantityScaled: 1000n,
          knownValueMinor: 9_223_372_036_854_775_807n,
          stockRevision: 5n,
          costRevision: 3n,
          updatedAt: new Date(),
        },
      });
    });
    const before = await state(T.capacity);
    const operationId = 'capacity-' + newId();

    const failed = await refusal(() => bootstrap(request(T.capacity, '1', operationId)));
    expect(failed).toBeInstanceOf(CostingCapacityError);
    expect(await state(T.capacity)).toEqual(before);

    const residue = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.idempotencyKey.count({
        where: { tenantId: T.tenant, scope: 'inventory-cost-bootstrap', operationId },
      }),
    );
    expect(residue).toBe(0);
  }, 60_000);

  it('rolls back pool, evidence, audit and idempotency when the final write fails', async () => {
    await setBalance(T.late, 2000n, 9n);
    const before = await state(T.late);
    const fault = new pg.Client({ connectionString: url });
    await fault.connect();
    await fault.query(`
      DROP TRIGGER IF EXISTS korvi_test_refuse_cost_bootstrap_audit ON "audit_events";
      DROP FUNCTION IF EXISTS korvi_test_refuse_cost_bootstrap_audit();
      CREATE FUNCTION korvi_test_refuse_cost_bootstrap_audit() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."eventType" = 'inventory.cost.bootstrapped' THEN
          RAISE EXCEPTION 'korvi test fault: cost bootstrap audit refused';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER korvi_test_refuse_cost_bootstrap_audit
        BEFORE INSERT ON "audit_events"
        FOR EACH ROW EXECUTE FUNCTION korvi_test_refuse_cost_bootstrap_audit();`);

    const operationId = 'late-' + newId();
    let failed: Error;
    try {
      failed = await refusal(() => bootstrap(request(T.late, '91', operationId)));
    } finally {
      await fault.query(`
        DROP TRIGGER IF EXISTS korvi_test_refuse_cost_bootstrap_audit ON "audit_events";
        DROP FUNCTION IF EXISTS korvi_test_refuse_cost_bootstrap_audit();`);
      await fault.end();
    }
    expect(failed.message).toMatch(/korvi test fault/);
    expect(await state(T.late)).toEqual(before);

    const residue = await withTenant(prisma, scope.tenantId, async (tx) => ({
      key: await tx.idempotencyKey.count({
        where: { tenantId: T.tenant, scope: 'inventory-cost-bootstrap', operationId },
      }),
      audit: await tx.auditEvent.count({
        where: {
          tenantId: T.tenant,
          eventType: 'inventory.cost.bootstrapped',
          metadata: { path: ['operationId'], equals: operationId },
        },
      }),
    }));
    expect(residue).toEqual({ key: 0, audit: 0 });
  }, 60_000);

  it('cannot see or target another tenant through the costing authority', async () => {
    const hidden = await withTenant(prisma, OTHER.tenant, async (tx) => ({
      cost: await tx.inventoryCostBalance.count({}),
      evidence: await tx.inventoryValuationEvent.count({}),
    }));
    expect(hidden).toEqual({ cost: 0, evidence: 0 });

    const failed = await refusal(() =>
      bootstrap(request(OTHER.product, '100', 'cross-' + newId())),
    );
    expect(failed).toBeInstanceOf(StockOperationRefusedError);
    expect((failed as StockOperationRefusedError).detail).toBe('unknown-product');
  }, 60_000);
});
