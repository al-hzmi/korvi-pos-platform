import { describe, expect, it } from 'vitest';
import { createMerchantInventoryService } from '../inventory/service.js';
import { CostingCapacityError } from '@korvi/domain';
import { CostBootstrapRefusedError } from '@korvi/database';
import type {
  AdjustmentRequest,
  AuthenticatedPrincipal,
  CostBootstrapRequest,
  CountRequest,
  Permission,
  TransferRequest,
} from '@korvi/domain';
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
    expectedStockRevision: '12',
    expectedCostRevision: '8',
    expectedUnknownPositiveQuantityScaled: '3000',
  };
}

function adjustment(): AdjustmentRequest {
  return {
    operationId: 'adjust-op',
    branchId: BRANCH,
    reason: 'تلف',
    lines: [{ productId: PRODUCT, deltaQuantityScaled: '-1000' }],
  };
}

function count(): CountRequest {
  return {
    operationId: 'count-op',
    branchId: BRANCH,
    reason: null,
    lines: [{ productId: PRODUCT, countedQuantityScaled: '1000', expectedRevision: '0' }],
  };
}

function transfer(): TransferRequest {
  return {
    operationId: 'transfer-op',
    fromBranchId: BRANCH,
    toBranchId: '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4005',
    reason: null,
    lines: [{ productId: PRODUCT, quantityScaled: '1000' }],
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

function databaseThatRefusesStaleCost(): PrismaClient {
  return {
    $transaction: async () => {
      throw new CostBootstrapRefusedError(PRODUCT);
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

  it('returns a product-scoped conflict when the reviewed cost facts changed', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatRefusesStaleCost() });

    await expect(
      service.bootstrapCost(principal(['inventory.cost.manage']), request()),
    ).resolves.toEqual({
      outcome: 'failure',
      reason: 'cost-state-changed',
      productId: PRODUCT,
    });
  });
});

describe('inventory service read authority', () => {
  it('refuses branch, stock and cost reads before persistence without their exact permission', async () => {
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
    await expect(
      service.costBalances(denied, { branchId: BRANCH, limit: 50, cursor: null }),
    ).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'inventory.cost.read',
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

  it('keeps cost visibility separate from inventory.read', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatMustNotBeTouched() });

    for (const permissions of [['inventory.read'], ['inventory.cost.manage']] as const) {
      await expect(
        service.costBalances(principal(permissions), {
          branchId: BRANCH,
          limit: 50,
          cursor: null,
        }),
      ).rejects.toMatchObject({ permission: 'inventory.cost.read' });
    }
    await expect(
      service.costBalances(principal(['inventory.cost.read']), {
        branchId: BRANCH,
        limit: 50,
        cursor: null,
      }),
    ).rejects.toThrow('database touched');
  });
});

describe('inventory service stock mutation authority', () => {
  it('refuses adjustment and count before persistence without inventory.adjust', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatMustNotBeTouched() });
    const denied = principal(['inventory.read']);

    await expect(service.adjust(denied, adjustment())).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'inventory.adjust',
    });
    await expect(service.count(denied, count())).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'inventory.adjust',
    });
  });

  it('keeps transfer under its separate service-level permission', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatMustNotBeTouched() });

    await expect(
      service.transfer(principal(['inventory.adjust']), transfer()),
    ).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'inventory.transfer',
    });
    await expect(service.transfer(principal(['inventory.transfer']), transfer())).rejects.toThrow(
      'database touched',
    );
  });

  it('allows inventory.adjust to reach the adjustment and count authorities', async () => {
    const service = createMerchantInventoryService({ prisma: databaseThatMustNotBeTouched() });
    const allowed = principal(['inventory.adjust']);

    await expect(service.adjust(allowed, adjustment())).rejects.toThrow('database touched');
    await expect(service.count(allowed, count())).rejects.toThrow('database touched');
  });
});
