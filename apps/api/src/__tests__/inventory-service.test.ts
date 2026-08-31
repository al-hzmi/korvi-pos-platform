import { describe, expect, it } from 'vitest';
import { createMerchantInventoryService } from '../inventory/service.js';
import { CostingCapacityError } from '@korvi/domain';
import type { AuthenticatedPrincipal, CostBootstrapRequest, Permission } from '@korvi/domain';
import type { PrismaClient } from '@korvi/database';

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const USER = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4001';
const SESSION = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4002';
const BRANCH = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4003';
const PRODUCT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4004';

function principal(permissions: readonly Permission[]): AuthenticatedPrincipal {
  return {
    tenantId: TENANT,
    tenantSlug: 'tenant',
    userId: USER,
    sessionId: SESSION,
    email: 'manager@example.test',
    displayName: 'Manager',
    roles: ['manager'],
    permissions,
    maxDiscountBasisPoints: 0n,
    branchId: null,
  };
}

function request(totalValueMinor: string = '4500'): CostBootstrapRequest {
  return {
    operationId: 'bootstrap-op',
    branchId: BRANCH,
    productId: PRODUCT,
    totalValueMinor,
  };
}

function databaseThatMustNotBeTouched(): PrismaClient {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('database touched');
      },
    },
  ) as PrismaClient;
}

function databaseThatRefusesCapacity(): PrismaClient {
  return {
    $transaction: async () => {
      throw new CostingCapacityError();
    },
  } as unknown as PrismaClient;
}

describe('inventory service costing authority', () => {
  it('refuses bootstrap before touching persistence without inventory.cost.manage', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatMustNotBeTouched() });

    await expect(
      service.bootstrapCost(principal(['inventory.adjust']), request()),
    ).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'inventory.cost.manage',
    });
  });

  it('allows an authorized bootstrap to reach persistence', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatMustNotBeTouched() });

    await expect(
      service.bootstrapCost(principal(['inventory.cost.manage']), request()),
    ).rejects.toThrow('database touched');
  });

  it('refuses malformed or out-of-range BIGINT value before touching persistence', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatMustNotBeTouched() });
    const authorized = principal(['inventory.cost.manage']);

    for (const totalValueMinor of ['1.5', '9223372036854775808']) {
      await expect(service.bootstrapCost(authorized, request(totalValueMinor))).resolves.toEqual({
        outcome: 'failure',
        reason: 'invalid-money',
        productId: null,
      });
    }
  });

  it('returns a deliberate refusal when the stored aggregate would overflow', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatRefusesCapacity() });

    await expect(
      service.bootstrapCost(principal(['inventory.cost.manage']), request('1')),
    ).resolves.toEqual({
      outcome: 'failure',
      reason: 'invalid-money',
      productId: null,
    });
  });
});

describe('inventory service read authority', () => {
  it('refuses branch and balance reads before persistence without inventory.read', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatMustNotBeTouched() });
    const denied = principal(['sale.create']);

    await expect(service.branches(denied, { limit: 50, cursor: null })).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'inventory.read',
    });
    await expect(
      service.balances(denied, { branchId: BRANCH, limit: 50, cursor: null }),
    ).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'inventory.read',
    });
  });

  it('allows inventory.read to reach the tenant-scoped branch and balance repositories', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatMustNotBeTouched() });
    const allowed = principal(['inventory.read']);

    await expect(service.branches(allowed, { limit: 50, cursor: null })).rejects.toThrow(
      'database touched',
    );
    await expect(
      service.balances(allowed, { branchId: BRANCH, limit: 50, cursor: null }),
    ).rejects.toThrow('database touched');
  });
});
