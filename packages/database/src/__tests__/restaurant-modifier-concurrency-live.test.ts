import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrismaClient,
  createRestaurantModifierGroup,
  createRestaurantModifierOption,
  setRestaurantProductModifierGroups,
  updateRestaurantModifierOption,
  withTenant,
} from '../index.js';
import { resolveRestaurantModifierPolicyWithin } from '../restaurant/modifier-policy.js';
import { tenantId as brandTenantId } from '@korvi/domain';
import type { PrismaClient } from '../index.js';
import type { TenantScope } from '@korvi/domain';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const A = {
  tenant: '019b6500-0000-7000-8000-00000000000a',
  branch: '019b6500-0000-7000-8000-0000000000a1',
  user: '019b6500-0000-7000-8000-0000000000a2',
  product: '019b6500-0000-7000-8000-0000000000a3',
};
const B = { tenant: '019b6500-0000-7000-8000-00000000000b' };
const scope: TenantScope = { tenantId: brandTenantId(A.tenant) };
const foreignScope: TenantScope = { tenantId: brandTenantId(B.tenant) };
const actor = { userId: A.user, branchId: A.branch };

describe.skipIf(url === '')('restaurant modifier live tenant and concurrency authority', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;
  let groupId: string;
  let optionId: string;

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    second = createPrismaClient(url);
    for (const tenant of [A.tenant, B.tenant]) {
      await withTenant(prisma, tenant, async (tx) => {
        await tx.tenant.deleteMany({ where: { id: tenant } });
      });
    }
    await withTenant(prisma, A.tenant, async (tx) => {
      await tx.tenant.create({
        data: {
          id: A.tenant,
          slug: 'v25-modifier-lock-a',
          name: 'مطعم برهان الإضافات',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({
        data: { tenantId: A.tenant, vertical: 'restaurant', updatedAt: new Date() },
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
          email: 'owner@v25-lock.test',
          displayName: 'مدير',
          updatedAt: new Date(),
        },
      });
      await tx.product.create({
        data: {
          id: A.product,
          tenantId: A.tenant,
          sku: 'V25-LOCK-PRODUCT',
          nameAr: 'منتج الإضافات',
          productType: 'unit',
          trackInventory: false,
          priceMinor: 1250n,
          vatBasisPoints: 1500,
          updatedAt: new Date(),
        },
      });
    });
    await withTenant(prisma, B.tenant, async (tx) => {
      await tx.tenant.create({
        data: {
          id: B.tenant,
          slug: 'v25-modifier-lock-b',
          name: 'مطعم مستقل',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({
        data: { tenantId: B.tenant, vertical: 'restaurant', updatedAt: new Date() },
      });
    });

    const group = await createRestaurantModifierGroup(prisma, scope, actor, {
      code: 'SIZE',
      nameAr: 'الحجم',
      nameEn: null,
      minSelections: 1,
      maxSelections: 1,
      sortOrder: 0,
    });
    groupId = group.id;
    const updated = await createRestaurantModifierOption(prisma, scope, actor, groupId, {
      code: 'LARGE',
      nameAr: 'كبير',
      nameEn: null,
      priceDeltaMinor: '200',
      sortOrder: 0,
    });
    optionId = updated.options[0]!.id;
    await setRestaurantProductModifierGroups(prisma, scope, actor, A.product, {
      expectedGroupIds: [],
      groupIds: [groupId],
    });
  }, 120_000);

  afterAll(async () => {
    for (const tenant of [A.tenant, B.tenant]) {
      await withTenant(prisma, tenant, async (tx) => {
        await tx.tenant.deleteMany({ where: { id: tenant } });
      });
    }
    await prisma.$disconnect();
    await second.$disconnect();
  });

  it('cannot read or mutate another tenant modifier policy under FORCE RLS', async () => {
    const hidden = await withTenant(second, B.tenant, (tx) =>
      tx.restaurantModifierOption.findMany({ where: { id: optionId } }),
    );
    expect(hidden).toEqual([]);
    await expect(
      withTenant(second, B.tenant, (tx) =>
        resolveRestaurantModifierPolicyWithin(tx, foreignScope, A.product, 1250n, [optionId]),
      ),
    ).rejects.toThrow();
    await expect(
      updateRestaurantModifierOption(second, foreignScope, actor, optionId, {
        expectedRevision: '1',
        priceDeltaMinor: '900',
      }),
    ).rejects.toMatchObject({ detail: 'unknown-option' });
  });

  it('serializes preview snapshots against merchant writes and refuses stale concurrent revisions', async () => {
    let release!: () => void;
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const untilRelease = new Promise<void>((resolve) => {
      release = resolve;
    });

    const heldRead = withTenant(prisma, A.tenant, async (tx) => {
      const snapshot = await resolveRestaurantModifierPolicyWithin(tx, scope, A.product, 1250n, [
        optionId,
      ]);
      markReady();
      await untilRelease;
      return snapshot;
    });
    await ready;
    try {
      const attempt = await withTenant(second, A.tenant, async (tx) => {
        return tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(
            hashtextextended('korvi:restaurant-menu-policy:' || ${A.tenant}::text, 0)
          ) AS "acquired"
        `;
      });
      expect(attempt[0]?.acquired).toBe(false);
    } finally {
      release();
    }
    const immutable = await heldRead;
    expect(immutable.unitPriceMinor).toBe(1450n);
    expect(immutable.selections[0]?.optionRevision).toBe(1n);

    const concurrent = await Promise.allSettled([
      updateRestaurantModifierOption(prisma, scope, actor, optionId, {
        expectedRevision: '1',
        priceDeltaMinor: '300',
      }),
      updateRestaurantModifierOption(second, scope, actor, optionId, {
        expectedRevision: '1',
        priceDeltaMinor: '350',
      }),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = concurrent.filter((result) => result.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      status: 'rejected',
      reason: { detail: 'stale-revision' },
    });

    const changed = await withTenant(prisma, A.tenant, (tx) =>
      resolveRestaurantModifierPolicyWithin(tx, scope, A.product, 1250n, [optionId]),
    );
    expect(changed.selections[0]?.optionRevision).toBe(2n);
    expect([1550n, 1600n]).toContain(changed.unitPriceMinor);
    expect(immutable.unitPriceMinor).toBe(1450n);
    expect(immutable.selections[0]?.priceDeltaMinor).toBe(200n);
  }, 60_000);
});
