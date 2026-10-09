import { describe, expect, it, vi } from 'vitest';
import { InvalidRestaurantModifierSelectionError } from '@korvi/domain';
import { resolveRestaurantModifierPolicyWithin } from '../restaurant/modifier-policy.js';
import type { TenantScope } from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';

const scope = {
  tenantId: '018fd200-0000-7000-8000-00000000000a',
} as TenantScope;

const attached = [
  {
    sortOrder: 2,
    groupId: 'group-1',
    group: {
      id: 'group-1',
      revision: 3n,
      code: 'MILK',
      nameAr: 'نوع الحليب',
      minSelections: 1,
      maxSelections: 1,
      sortOrder: 2,
      isActive: true,
      options: [
        {
          id: 'option-1',
          revision: 2n,
          code: 'OAT',
          nameAr: 'شوفان',
          priceDeltaMinor: 250n,
          sortOrder: 1,
          isActive: true,
        },
        {
          id: 'option-2',
          revision: 1n,
          code: 'REGULAR',
          nameAr: 'عادي',
          priceDeltaMinor: 0n,
          sortOrder: 0,
          isActive: true,
        },
      ],
    },
  },
] as const;

function fakeTransaction(attachments: readonly unknown[]): {
  readonly tx: TransactionClient;
  readonly lock: ReturnType<typeof vi.fn>;
  readonly findMany: ReturnType<typeof vi.fn>;
} {
  const lock = vi.fn().mockResolvedValue([{ locked: 1 }]);
  const findMany = vi.fn().mockResolvedValue(attachments);
  const tx = {
    $queryRaw: lock,
    restaurantProductModifierGroup: { findMany },
  } as unknown as TransactionClient;
  return { tx, lock, findMany };
}

describe('transaction-scoped restaurant modifier policy', () => {
  it('locks policy before reading and keeps a product without groups at base price', async () => {
    const { tx, lock, findMany } = fakeTransaction([]);
    const result = await resolveRestaurantModifierPolicyWithin(tx, scope, 'product-1', 1_500n, []);
    expect(result).toEqual({
      baseUnitPriceMinor: 1_500n,
      modifierTotalMinor: 0n,
      unitPriceMinor: 1_500n,
      selections: [],
    });
    expect(lock).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: scope.tenantId, productId: 'product-1' },
      }),
    );
    expect(lock.mock.invocationCallOrder[0]!).toBeLessThan(findMany.mock.invocationCallOrder[0]!);
  });

  it('derives the final price and immutable snapshot from the linked group and option', async () => {
    const { tx } = fakeTransaction(attached);
    const result = await resolveRestaurantModifierPolicyWithin(tx, scope, 'product-1', 1_500n, [
      'option-1',
    ]);
    expect(result.baseUnitPriceMinor).toBe(1_500n);
    expect(result.modifierTotalMinor).toBe(250n);
    expect(result.unitPriceMinor).toBe(1_750n);
    expect(result.selections).toEqual([
      {
        groupId: 'group-1',
        groupRevision: 3n,
        groupCode: 'MILK',
        groupNameAr: 'نوع الحليب',
        groupSortOrder: 2,
        optionId: 'option-1',
        optionRevision: 2n,
        optionCode: 'OAT',
        optionNameAr: 'شوفان',
        optionSortOrder: 1,
        priceDeltaMinor: 250n,
      },
    ]);
  });

  it('refuses a required group without a selected option', async () => {
    const { tx } = fakeTransaction(attached);
    await expect(
      resolveRestaurantModifierPolicyWithin(tx, scope, 'product-1', 1_500n, []),
    ).rejects.toThrow(InvalidRestaurantModifierSelectionError);
  });

  it('refuses options that were not attached to the requested product', async () => {
    const { tx } = fakeTransaction(attached);
    await expect(
      resolveRestaurantModifierPolicyWithin(tx, scope, 'product-1', 1_500n, ['option-unknown']),
    ).rejects.toThrow(InvalidRestaurantModifierSelectionError);
  });
});
