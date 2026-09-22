import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { tenantId as brandTenantId } from '@korvi/domain';
import {
  RestaurantWasteRefusedError,
  createPrismaClient,
  recordRestaurantWaste,
  withTenant,
} from '@korvi/database';
import type { PrismaClient } from '@korvi/database';
import type { TenantScope } from '@korvi/domain';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '01995000-0000-7000-8000-00000000000a',
  branch: '01995000-0000-7000-8000-0000000000a1',
  user: '01995000-0000-7000-8000-0000000000a2',
  known: '01995000-0000-7000-8000-0000000000a3',
  unknown: '01995000-0000-7000-8000-0000000000a4',
  second: '01995000-0000-7000-8000-0000000000a5',
} as const;

const B = {
  tenant: '01995000-0000-7000-8000-00000000000b',
  user: '01995000-0000-7000-8000-0000000000b1',
} as const;

function fixedIds(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error('test id sequence exhausted');
    index += 1;
    return value;
  };
}

describe.skipIf(url === '')('restaurant waste/spoilage inventory authority, live', () => {
  let prisma: PrismaClient;
  const scope: TenantScope = { tenantId: brandTenantId(A.tenant) };
  const actor = { userId: A.user };

  async function removeTenant(id: string): Promise<void> {
    await withTenant(prisma, id, async (tx) => {
      await tx.tenant.deleteMany({ where: { id } });
    });
  }

  async function seed(
    productId: string,
    quantityScaled: bigint,
    knownQuantityScaled: bigint,
    knownValueMinor: bigint,
  ): Promise<void> {
    await withTenant(prisma, A.tenant, async (tx) => {
      await tx.inventoryBalance.upsert({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId,
          },
        },
        create: {
          tenantId: A.tenant,
          branchId: A.branch,
          productId,
          quantityScaled,
          revision: 0n,
          updatedAt: new Date(),
        },
        update: { quantityScaled, revision: 0n },
      });
      await tx.inventoryCostBalance.upsert({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId,
          },
        },
        create: {
          tenantId: A.tenant,
          branchId: A.branch,
          productId,
          knownQuantityScaled,
          knownValueMinor,
          stockRevision: 0n,
          costRevision: knownQuantityScaled > 0n ? 1n : 0n,
          updatedAt: new Date(),
        },
        update: {
          knownQuantityScaled,
          knownValueMinor,
          stockRevision: 0n,
          costRevision: knownQuantityScaled > 0n ? 1n : 0n,
        },
      });
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);

    await withTenant(prisma, A.tenant, async (tx) => {
      await tx.tenant.create({
        data: {
          id: A.tenant,
          name: 'مطعم الهدر',
          slug: 'restaurant-waste-a',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({
        data: {
          tenantId: A.tenant,
          vertical: 'restaurant',
          allowNegativeStock: true,
          updatedAt: new Date(),
        },
      });
      await tx.branch.create({
        data: {
          id: A.branch,
          tenantId: A.tenant,
          code: '01',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: A.user,
          tenantId: A.tenant,
          email: 'waste@restaurant.test',
          displayName: 'مدير الهدر',
          updatedAt: new Date(),
        },
      });
      for (const [id, sku, productType] of [
        [A.known, 'KNOWN-WASTE', 'unit'],
        [A.unknown, 'UNKNOWN-SPOILAGE', 'weighted'],
        [A.second, 'SECOND-WASTE', 'unit'],
      ] as const) {
        await tx.product.create({
          data: {
            id,
            tenantId: A.tenant,
            sku,
            nameAr: sku,
            productType,
            trackInventory: true,
            priceMinor: 1000n,
            vatBasisPoints: 1500,
            updatedAt: new Date(),
          },
        });
      }
    });

    await withTenant(prisma, B.tenant, async (tx) => {
      await tx.tenant.create({
        data: {
          id: B.tenant,
          name: 'مطعم آخر',
          slug: 'restaurant-waste-b',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({
        data: { tenantId: B.tenant, vertical: 'restaurant', updatedAt: new Date() },
      });
      await tx.user.create({
        data: {
          id: B.user,
          tenantId: B.tenant,
          email: 'other-waste@restaurant.test',
          displayName: 'آخر',
          updatedAt: new Date(),
        },
      });
    });
  }, 120_000);

  afterAll(async () => {
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await prisma.$disconnect();
  });

  it('runs waste tables under FORCE RLS as the restricted runtime role', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const { rows: role } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const { rows } = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY($1)
        ORDER BY c.relname`,
      [['restaurant_waste_lines', 'restaurant_wastes']],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
    await client.end();
  });

  it('records exact known-cost waste through the shared stock/cost ledger and replays safely', async () => {
    await seed(A.known, 5_000n, 5_000n, 500n);
    const operationId = '01995000-0000-7000-8000-0000000000c1';
    const request = {
      operationId,
      branchId: A.branch,
      reasonType: 'waste' as const,
      note: 'تجهيز زائد',
      lines: [{ productId: A.known, quantityScaled: '2000' }],
    };
    const result = await recordRestaurantWaste(prisma, scope, actor, request);

    expect(result).toMatchObject({
      branchId: A.branch,
      reasonType: 'waste',
      note: 'تجهيز زائد',
      replayed: false,
      lines: [
        {
          productId: A.known,
          quantityScaled: '2000',
          beforeQuantityScaled: '5000',
          afterQuantityScaled: '3000',
          costKnownQuantityScaled: '2000',
          costUnknownQuantityScaled: '0',
          costValueMinor: '200',
          costProvenance: 'recorded',
        },
      ],
    });

    const facts = await withTenant(prisma, A.tenant, async (tx) => ({
      balance: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.known,
          },
        },
      }),
      cost: await tx.inventoryCostBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.known,
          },
        },
      }),
      movements: await tx.inventoryMovement.findMany({
        where: { tenantId: A.tenant, sourceType: 'restaurant-waste', sourceId: result.id },
      }),
    }));
    expect(facts.balance?.quantityScaled).toBe(3_000n);
    expect(facts.cost).toMatchObject({ knownQuantityScaled: 3_000n, knownValueMinor: 300n });
    expect(facts.movements).toHaveLength(1);
    expect(facts.movements[0]).toMatchObject({
      kind: 'adjustment',
      quantityScaled: -2_000n,
      reason: 'waste',
      costKnownQuantityScaled: 2_000n,
      costUnknownQuantityScaled: 0n,
      costValueMinor: 200n,
    });

    const replay = await recordRestaurantWaste(prisma, scope, actor, request);
    expect(replay.id).toBe(result.id);
    expect(replay.replayed).toBe(true);
    const movementCount = await withTenant(prisma, A.tenant, (tx) =>
      tx.inventoryMovement.count({
        where: { tenantId: A.tenant, sourceType: 'restaurant-waste', sourceId: result.id },
      }),
    );
    expect(movementCount).toBe(1);
  });

  it('preserves unknown cost on spoilage and refuses physical over-consumption', async () => {
    await seed(A.unknown, 1_000n, 0n, 0n);
    const result = await recordRestaurantWaste(prisma, scope, actor, {
      operationId: '01995000-0000-7000-8000-0000000000c2',
      branchId: A.branch,
      reasonType: 'spoilage',
      note: null,
      lines: [{ productId: A.unknown, quantityScaled: '250' }],
    });
    expect(result.lines[0]).toMatchObject({
      quantityScaled: '250',
      costKnownQuantityScaled: '0',
      costUnknownQuantityScaled: '250',
      costValueMinor: '0',
      costProvenance: 'unknown',
    });

    await seed(A.known, 1_000n, 1_000n, 100n);
    await expect(
      recordRestaurantWaste(prisma, scope, actor, {
        operationId: '01995000-0000-7000-8000-0000000000c3',
        branchId: A.branch,
        reasonType: 'waste',
        note: null,
        lines: [{ productId: A.known, quantityScaled: '2000' }],
      }),
    ).rejects.toMatchObject<Partial<RestaurantWasteRefusedError>>({
      detail: 'insufficient-stock',
    });
    const residue = await withTenant(prisma, A.tenant, async (tx) => ({
      key: await tx.idempotencyKey.count({
        where: {
          tenantId: A.tenant,
          scope: 'restaurant.waste',
          operationId: '01995000-0000-7000-8000-0000000000c3',
        },
      }),
      waste: await tx.restaurantWaste.count({
        where: {
          tenantId: A.tenant,
          operationId: '01995000-0000-7000-8000-0000000000c3',
        },
      }),
    }));
    expect(residue).toEqual({ key: 0, waste: 0 });
  });

  it('rolls back document, movements, costing, audit and idempotency after a late line failure', async () => {
    await seed(A.known, 3_000n, 3_000n, 300n);
    await seed(A.second, 3_000n, 3_000n, 600n);
    const before = await withTenant(prisma, A.tenant, async (tx) => ({
      movements: await tx.inventoryMovement.count({ where: { tenantId: A.tenant } }),
      audits: await tx.auditEvent.count({ where: { tenantId: A.tenant } }),
    }));
    const duplicateLine = '01995000-0000-7000-8000-0000000000d2';
    const ids = fixedIds([
      '01995000-0000-7000-8000-0000000000d1',
      duplicateLine,
      '01995000-0000-7000-8000-0000000000d3',
      duplicateLine,
      '01995000-0000-7000-8000-0000000000d4',
    ]);

    await expect(
      recordRestaurantWaste(
        prisma,
        scope,
        actor,
        {
          operationId: '01995000-0000-7000-8000-0000000000c4',
          branchId: A.branch,
          reasonType: 'spoilage',
          note: 'اختبار تراجع',
          lines: [
            { productId: A.known, quantityScaled: '1000' },
            { productId: A.second, quantityScaled: '1000' },
          ],
        },
        () => new Date('2026-09-22T12:00:00.000Z'),
        ids,
      ),
    ).rejects.toThrow();

    const after = await withTenant(prisma, A.tenant, async (tx) => ({
      first: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.known,
          },
        },
      }),
      second: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.second,
          },
        },
      }),
      movements: await tx.inventoryMovement.count({ where: { tenantId: A.tenant } }),
      wastes: await tx.restaurantWaste.count({
        where: {
          tenantId: A.tenant,
          operationId: '01995000-0000-7000-8000-0000000000c4',
        },
      }),
      key: await tx.idempotencyKey.count({
        where: {
          tenantId: A.tenant,
          scope: 'restaurant.waste',
          operationId: '01995000-0000-7000-8000-0000000000c4',
        },
      }),
      audits: await tx.auditEvent.count({ where: { tenantId: A.tenant } }),
    }));
    expect(after.first?.quantityScaled).toBe(3_000n);
    expect(after.second?.quantityScaled).toBe(3_000n);
    expect(after.movements).toBe(before.movements);
    expect(after.wastes).toBe(0);
    expect(after.key).toBe(0);
    expect(after.audits).toBe(before.audits);
  });

  it('keeps waste documents tenant-private under FORCE RLS', async () => {
    await seed(A.known, 2_000n, 2_000n, 200n);
    const mine = await recordRestaurantWaste(prisma, scope, actor, {
      operationId: '01995000-0000-7000-8000-0000000000c5',
      branchId: A.branch,
      reasonType: 'waste',
      note: null,
      lines: [{ productId: A.known, quantityScaled: '1000' }],
    });
    const foreign = await withTenant(prisma, B.tenant, async (tx) => ({
      header: await tx.restaurantWaste.count({ where: { id: mine.id } }),
      lines: await tx.restaurantWasteLine.count({ where: { wasteId: mine.id } }),
    }));
    expect(foreign).toEqual({ header: 0, lines: 0 });
  });
});
