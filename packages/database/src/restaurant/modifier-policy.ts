import { resolveRestaurantModifiers } from '@korvi/domain';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type { RestaurantModifierResolution } from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';

/**
 * Menu policy is read while holding the shared PostgreSQL policy lock.
 *
 * This helper deliberately accepts an already tenant-scoped transaction:
 * callers must use the SAME transaction for policy resolution and the
 * authoritative order/sale write. A separate preview transaction cannot
 * establish commit-time modifier-price authority.
 */
export async function resolveRestaurantModifierPolicyWithin(
  tx: TransactionClient,
  scope: TenantScope,
  productId: string,
  baseUnitPriceMinor: bigint,
  selectedOptionIds: readonly string[],
): Promise<RestaurantModifierResolution> {
  const tenant = tenantParam(scope);

  // PostgreSQL advisory lock returns void, which Prisma cannot decode as a
  // result column. Return a real int4 while still acquiring the shared lock.
  await tx.$queryRaw<{ locked: number }[]>`
    SELECT 1::int4 AS "locked"
    FROM (
      SELECT pg_advisory_xact_lock_shared(
        hashtextextended('korvi:restaurant-menu-policy:' || ${tenant}, 0)
      )
    ) AS menu_lock`;

  const attachments = await tx.restaurantProductModifierGroup.findMany({
    where: { tenantId: tenant, productId },
    include: {
      group: {
        include: {
          options: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
        },
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { groupId: 'asc' }],
  });

  return resolveRestaurantModifiers({
    baseUnitPriceMinor,
    groups: attachments.map(({ group }) => ({
      groupId: group.id,
      revision: group.revision,
      code: group.code,
      nameAr: group.nameAr,
      minSelections: group.minSelections,
      maxSelections: group.maxSelections,
      // The group snapshot must retain its revision's canonical display order.
      sortOrder: group.sortOrder,
      isActive: group.isActive,
      options: group.options.map((option) => ({
        optionId: option.id,
        revision: option.revision,
        code: option.code,
        nameAr: option.nameAr,
        priceDeltaMinor: option.priceDeltaMinor,
        sortOrder: option.sortOrder,
        isActive: option.isActive,
      })),
    })),
    selectedOptionIds,
  });
}

export interface RestaurantModifierPolicyRepository {
  resolve(
    scope: TenantScope,
    productId: string,
    baseUnitPriceMinor: bigint,
    selectedOptionIds: readonly string[],
  ): Promise<RestaurantModifierResolution>;
  read(scope: TenantScope, productId: string): Promise<readonly RestaurantModifierMenuGroup[]>;
}

/**
 * Read-side resolver used by API preview/finalization preparation.
 *
 * This is deliberately not commit authority. recordSaleWithin re-runs the same
 * resolver inside the sale transaction before any financial write.
 */
export function createRestaurantModifierPolicyRepository(
  prisma: PrismaClient,
): RestaurantModifierPolicyRepository {
  return {
    resolve(scope, productId, baseUnitPriceMinor, selectedOptionIds) {
      return withTenant(prisma, scope.tenantId, (tx) =>
        resolveRestaurantModifierPolicyWithin(
          tx,
          scope,
          productId,
          baseUnitPriceMinor,
          selectedOptionIds,
        ),
      );
    },
    read(scope, productId) {
      return readRestaurantModifierMenu(prisma, scope, productId);
    },
  };
}

export interface RestaurantModifierMenuOption {
  readonly optionId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly priceDeltaMinor: string;
  readonly sortOrder: number;
  readonly revision: string;
}

export interface RestaurantModifierMenuGroup {
  readonly groupId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly sortOrder: number;
  readonly revision: string;
  readonly options: readonly RestaurantModifierMenuOption[];
}

async function lockMenuPolicyShared(tx: TransactionClient, tenant: string): Promise<void> {
  await tx.$queryRawUnsafe<{ locked: number }[]>(
    'SELECT 1::int4 AS "locked" FROM (SELECT pg_advisory_xact_lock_shared(hashtextextended(\'korvi:restaurant-menu-policy:\' || $1, 0))) AS menu_lock',
    tenant,
  );
}

export async function readRestaurantModifierMenuWithin(
  tx: TransactionClient,
  scope: TenantScope,
  productId: string,
): Promise<readonly RestaurantModifierMenuGroup[]> {
  const tenant = tenantParam(scope);
  await lockMenuPolicyShared(tx, tenant);

  const attachments = await tx.restaurantProductModifierGroup.findMany({
    where: { tenantId: tenant, productId, group: { isActive: true } },
    include: {
      group: {
        include: {
          options: {
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          },
        },
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { groupId: 'asc' }],
  });

  return attachments.map(({ group }) => ({
    groupId: group.id,
    code: group.code,
    nameAr: group.nameAr,
    nameEn: group.nameEn,
    minSelections: group.minSelections,
    maxSelections: group.maxSelections,
    sortOrder: group.sortOrder,
    revision: group.revision.toString(),
    options: group.options.map((option) => ({
      optionId: option.id,
      code: option.code,
      nameAr: option.nameAr,
      nameEn: option.nameEn,
      priceDeltaMinor: option.priceDeltaMinor.toString(),
      sortOrder: option.sortOrder,
      revision: option.revision.toString(),
    })),
  }));
}

export async function readRestaurantModifierMenu(
  prisma: PrismaClient,
  scope: TenantScope,
  productId: string,
): Promise<readonly RestaurantModifierMenuGroup[]> {
  return withTenant(prisma, scope.tenantId, (tx) =>
    readRestaurantModifierMenuWithin(tx, scope, productId),
  );
}
