import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  createPrismaClient,
  recordRestaurantRecipeProduction,
  setRestaurantRecipe,
  withTenant,
} from '@korvi/database';
import type { PrismaClient, RestaurantProductionRefusedError } from '@korvi/database';
import type { TenantScope } from '@korvi/domain';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '01994f00-0000-7000-8000-00000000000a',
  branch: '01994f00-0000-7000-8000-0000000000a1',
  user: '01994f00-0000-7000-8000-0000000000a2',
  finished: '01994f00-0000-7000-8000-0000000000a3',
  ingredient: '01994f00-0000-7000-8000-0000000000a4',
  finishedUnknown: '01994f00-0000-7000-8000-0000000000a5',
  ingredientUnknown: '01994f00-0000-7000-8000-0000000000a6',
  finishedOverflow: '01994f00-0000-7000-8000-0000000000a7',
  ingredientOverflowA: '01994f00-0000-7000-8000-0000000000a8',
  ingredientOverflowB: '01994f00-0000-7000-8000-0000000000a9',
} as const;

const B = {
  tenant: '01994f00-0000-7000-8000-00000000000b',
  user: '01994f00-0000-7000-8000-0000000000b1',
} as const;

describe.skipIf(url === '')('restaurant recipe production inventory authority, live', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;
  const scope: TenantScope = { tenantId: brandTenantId(A.tenant) };
  const actor = { userId: A.user };

  async function removeTenant(id: string): Promise<void> {
    await withTenant(prisma, id, async (tx) => {
      await tx.tenant.deleteMany({ where: { id } });
    });
  }

  async function seedBalance(
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
    second = createPrismaClient(url);
    await second.$queryRaw`SELECT 1`;
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);

    await withTenant(prisma, A.tenant, async (tx) => {
      await tx.tenant.create({
        data: {
          id: A.tenant,
          name: 'مطعم الإنتاج',
          slug: 'restaurant-production-a',
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
          nameAr: 'الفرع الرئيسي',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: A.user,
          tenantId: A.tenant,
          email: 'production@restaurant.test',
          displayName: 'مدير الإنتاج',
          updatedAt: new Date(),
        },
      });
      for (const [id, sku, type] of [
        [A.finished, 'LATTE', 'unit'],
        [A.ingredient, 'MILK', 'weighted'],
        [A.finishedUnknown, 'SOUP', 'unit'],
        [A.ingredientUnknown, 'BROTH', 'weighted'],
        [A.finishedOverflow, 'OVERFLOW-OUTPUT', 'unit'],
        [A.ingredientOverflowA, 'OVERFLOW-A', 'weighted'],
        [A.ingredientOverflowB, 'OVERFLOW-B', 'weighted'],
      ] as const) {
        await tx.product.create({
          data: {
            id,
            tenantId: A.tenant,
            sku,
            nameAr: sku,
            productType: type,
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
          slug: 'restaurant-production-b',
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
          email: 'other@restaurant.test',
          displayName: 'آخر',
          updatedAt: new Date(),
        },
      });
    });

    await setRestaurantRecipe(prisma, scope, actor, A.finished, {
      operationId: newId(),
      expectedRevision: null,
      yieldQuantityScaled: '1000',
      ingredients: [{ productId: A.ingredient, quantityScaled: '250' }],
    });
    await setRestaurantRecipe(prisma, scope, actor, A.finishedUnknown, {
      operationId: newId(),
      expectedRevision: null,
      yieldQuantityScaled: '1000',
      ingredients: [{ productId: A.ingredientUnknown, quantityScaled: '250' }],
    });
    await setRestaurantRecipe(prisma, scope, actor, A.finishedOverflow, {
      operationId: newId(),
      expectedRevision: null,
      yieldQuantityScaled: '1000',
      ingredients: [
        { productId: A.ingredientOverflowA, quantityScaled: '1000' },
        { productId: A.ingredientOverflowB, quantityScaled: '1000' },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await prisma.$disconnect();
    await second.$disconnect();
  });

  it('runs production tables under FORCE RLS with a restricted runtime role', async () => {
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
      [['restaurant_recipe_production_lines', 'restaurant_recipe_productions']],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
    await client.end();
  });

  it('atomically consumes known-cost ingredients and produces finished stock with exact carried cost', async () => {
    await seedBalance(A.ingredient, 1_000n, 1_000n, 400n);
    await seedBalance(A.finished, 0n, 0n, 0n);
    const operationId = newId();
    const result = await recordRestaurantRecipeProduction(prisma, scope, actor, A.finished, {
      operationId,
      branchId: A.branch,
      recipeRevision: '1',
      batchCount: '2',
    });

    expect(result).toMatchObject({
      productId: A.finished,
      recipeRevision: '1',
      batchCount: '2',
      replayed: false,
      outputCostStatus: 'known',
      lines: [
        {
          role: 'ingredient',
          productId: A.ingredient,
          deltaQuantityScaled: '-500',
          costUnknownQuantityScaled: '0',
          costValueMinor: '200',
        },
        {
          role: 'output',
          productId: A.finished,
          deltaQuantityScaled: '2000',
          costKnownQuantityScaled: '2000',
          costUnknownQuantityScaled: '0',
          costValueMinor: '200',
        },
      ],
    });

    const facts = await withTenant(prisma, A.tenant, async (tx) => ({
      ingredient: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.ingredient,
          },
        },
      }),
      output: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.finished,
          },
        },
      }),
      outputCost: await tx.inventoryCostBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.finished,
          },
        },
      }),
      movements: await tx.inventoryMovement.count({
        where: {
          tenantId: A.tenant,
          sourceType: 'restaurant-recipe-production',
          sourceId: result.id,
        },
      }),
    }));
    expect(facts.ingredient?.quantityScaled).toBe(500n);
    expect(facts.output?.quantityScaled).toBe(2_000n);
    expect(facts.outputCost).toMatchObject({
      knownQuantityScaled: 2_000n,
      knownValueMinor: 200n,
    });
    expect(facts.movements).toBe(2);

    const replay = await recordRestaurantRecipeProduction(prisma, scope, actor, A.finished, {
      operationId,
      branchId: A.branch,
      recipeRevision: '1',
      batchCount: '2',
    });
    expect(replay.id).toBe(result.id);
    expect(replay.replayed).toBe(true);
    const movementCount = await withTenant(prisma, A.tenant, (tx) =>
      tx.inventoryMovement.count({
        where: {
          tenantId: A.tenant,
          sourceType: 'restaurant-recipe-production',
          sourceId: result.id,
        },
      }),
    );
    expect(movementCount).toBe(2);
  });

  it('serializes concurrent duplicate submissions into one production and one replay', async () => {
    await seedBalance(A.ingredient, 1_000n, 1_000n, 400n);
    await seedBalance(A.finished, 0n, 0n, 0n);
    const operationId = newId();
    const request = {
      operationId,
      branchId: A.branch,
      recipeRevision: '1',
      batchCount: '1',
    };

    const [left, right] = await Promise.all([
      recordRestaurantRecipeProduction(prisma, scope, actor, A.finished, request),
      recordRestaurantRecipeProduction(second, scope, actor, A.finished, request),
    ]);

    expect(left.id).toBe(right.id);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    const facts = await withTenant(prisma, A.tenant, async (tx) => ({
      productions: await tx.restaurantRecipeProduction.count({
        where: { tenantId: A.tenant, operationId },
      }),
      movements: await tx.inventoryMovement.count({
        where: {
          tenantId: A.tenant,
          sourceType: 'restaurant-recipe-production',
          sourceId: left.id,
        },
      }),
      ingredient: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.ingredient,
          },
        },
      }),
      output: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.finished,
          },
        },
      }),
    }));
    expect(facts.productions).toBe(1);
    expect(facts.movements).toBe(2);
    expect(facts.ingredient?.quantityScaled).toBe(750n);
    expect(facts.output?.quantityScaled).toBe(1_000n);
  });

  it('rolls back document, movements, balances, valuation, audit and idempotency after a late costing failure', async () => {
    const hugeValue = 5_000_000_000_000_000_000n;
    await seedBalance(A.ingredientOverflowA, 1_000n, 1_000n, hugeValue);
    await seedBalance(A.ingredientOverflowB, 1_000n, 1_000n, hugeValue);
    await seedBalance(A.finishedOverflow, 0n, 0n, 0n);
    const operationId = newId();

    const before = await withTenant(prisma, A.tenant, async (tx) => ({
      productions: await tx.restaurantRecipeProduction.count({}),
      movements: await tx.inventoryMovement.count({}),
      valuations: await tx.inventoryValuationEvent.count({}),
      audits: await tx.auditEvent.count({
        where: { tenantId: A.tenant, eventType: 'restaurant.recipe.production.recorded' },
      }),
    }));

    await expect(
      recordRestaurantRecipeProduction(prisma, scope, actor, A.finishedOverflow, {
        operationId,
        branchId: A.branch,
        recipeRevision: '1',
        batchCount: '1',
      }),
    ).rejects.toThrow('exceeds PostgreSQL BIGINT storage');

    const after = await withTenant(prisma, A.tenant, async (tx) => ({
      productions: await tx.restaurantRecipeProduction.count({}),
      movements: await tx.inventoryMovement.count({}),
      valuations: await tx.inventoryValuationEvent.count({}),
      audits: await tx.auditEvent.count({
        where: { tenantId: A.tenant, eventType: 'restaurant.recipe.production.recorded' },
      }),
      idempotency: await tx.idempotencyKey.count({
        where: { tenantId: A.tenant, scope: 'restaurant.recipe.production', operationId },
      }),
      ingredientA: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.ingredientOverflowA,
          },
        },
      }),
      ingredientB: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.ingredientOverflowB,
          },
        },
      }),
      output: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.finishedOverflow,
          },
        },
      }),
    }));

    expect(after.productions).toBe(before.productions);
    expect(after.movements).toBe(before.movements);
    expect(after.valuations).toBe(before.valuations);
    expect(after.audits).toBe(before.audits);
    expect(after.idempotency).toBe(0);
    expect(after.ingredientA?.quantityScaled).toBe(1_000n);
    expect(after.ingredientB?.quantityScaled).toBe(1_000n);
    expect(after.output?.quantityScaled).toBe(0n);
  });

  it('keeps produced cost UNKNOWN when any consumed ingredient cost is unknown', async () => {
    await seedBalance(A.ingredientUnknown, 1_000n, 0n, 0n);
    await seedBalance(A.finishedUnknown, 0n, 0n, 0n);

    const result = await recordRestaurantRecipeProduction(prisma, scope, actor, A.finishedUnknown, {
      operationId: newId(),
      branchId: A.branch,
      recipeRevision: '1',
      batchCount: '1',
    });
    expect(result.outputCostStatus).toBe('unknown');
    expect(result.lines.at(-1)).toMatchObject({
      role: 'output',
      costKnownQuantityScaled: '0',
      costUnknownQuantityScaled: '1000',
      costValueMinor: '0',
      costProvenance: 'unknown',
    });
  });

  it('refuses physical over-consumption even when ordinary sale oversell is enabled and rolls everything back', async () => {
    await seedBalance(A.ingredient, 100n, 100n, 40n);
    await seedBalance(A.finished, 0n, 0n, 0n);
    const before = await withTenant(prisma, A.tenant, async (tx) => ({
      productions: await tx.restaurantRecipeProduction.count({}),
      movements: await tx.inventoryMovement.count({}),
    }));

    await expect(
      recordRestaurantRecipeProduction(prisma, scope, actor, A.finished, {
        operationId: newId(),
        branchId: A.branch,
        recipeRevision: '1',
        batchCount: '1',
      }),
    ).rejects.toMatchObject<Partial<RestaurantProductionRefusedError>>({
      detail: 'insufficient-stock',
    });

    const after = await withTenant(prisma, A.tenant, async (tx) => ({
      productions: await tx.restaurantRecipeProduction.count({}),
      movements: await tx.inventoryMovement.count({}),
      ingredient: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.ingredient,
          },
        },
      }),
      output: await tx.inventoryBalance.findUnique({
        where: {
          tenantId_branchId_productId: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: A.finished,
          },
        },
      }),
    }));
    expect(after.productions).toBe(before.productions);
    expect(after.movements).toBe(before.movements);
    expect(after.ingredient?.quantityScaled).toBe(100n);
    expect(after.output?.quantityScaled).toBe(0n);
  });

  it('refuses stale recipe revision and keeps production tenant-private', async () => {
    await seedBalance(A.ingredient, 1_000n, 1_000n, 400n);
    await expect(
      recordRestaurantRecipeProduction(prisma, scope, actor, A.finished, {
        operationId: newId(),
        branchId: A.branch,
        recipeRevision: '99',
        batchCount: '1',
      }),
    ).rejects.toMatchObject<Partial<RestaurantProductionRefusedError>>({
      detail: 'stale-revision',
    });

    const mine = await recordRestaurantRecipeProduction(prisma, scope, actor, A.finished, {
      operationId: newId(),
      branchId: A.branch,
      recipeRevision: '1',
      batchCount: '1',
    });
    const foreignView = await withTenant(prisma, B.tenant, async (tx) => ({
      header: await tx.restaurantRecipeProduction.count({ where: { id: mine.id } }),
      lines: await tx.restaurantRecipeProductionLine.count({ where: { productionId: mine.id } }),
    }));
    expect(foreignView).toEqual({ header: 0, lines: 0 });
  });
});
