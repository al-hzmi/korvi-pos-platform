import { describe, expect, it } from 'vitest';
import { CostingCapacityError } from '@korvi/domain';
import { createMerchantPurchasingService } from '../purchasing/service.js';
import type { AuthenticatedPrincipal, Permission, PurchaseReceiptRequest } from '@korvi/domain';
import type { PrismaClient } from '@korvi/database';

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const USER = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4001';
const SESSION = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4002';
const ORDER = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4003';
const LINE = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4004';

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

function request(inventoryValueMinor?: string): PurchaseReceiptRequest {
  return {
    operationId: 'receipt-op',
    purchaseOrderId: ORDER,
    reference: null,
    lines: [
      {
        purchaseOrderLineId: LINE,
        acceptedQuantityScaled: '1000',
        ...(inventoryValueMinor === undefined ? {} : { inventoryValueMinor }),
      },
    ],
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

describe('purchasing service costing authority', () => {
  it('refuses acquisition value before touching persistence without inventory.cost.manage', async () => {
    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });

    await expect(
      service.receive(principal(['purchasing.receive']), request('4500')),
    ).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'inventory.cost.manage',
    });
  });

  it('does not require costing authority when cost evidence is omitted', async () => {
    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });
    await expect(service.receive(principal(['purchasing.receive']), request())).rejects.toThrow(
      'database touched',
    );
  });

  it('allows a cost-bearing receipt to reach persistence when both authorities are present', async () => {
    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });
    await expect(
      service.receive(principal(['purchasing.receive', 'inventory.cost.manage']), request('0')),
    ).rejects.toThrow('database touched');
  });

  it('returns a deliberate refusal when receipt value would overflow the stored aggregate', async () => {
    const service = createMerchantPurchasingService({ prisma: databaseThatRefusesCapacity() });

    await expect(
      service.receive(principal(['purchasing.receive', 'inventory.cost.manage']), request('1')),
    ).resolves.toEqual({ outcome: 'failure', reason: 'invalid-money', subjectId: null });
  });
});
