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

describe('purchasing service permission authority', () => {
  it('refuses every read before touching persistence without purchasing.read', async () => {
    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });
    const calls: readonly (() => Promise<unknown>)[] = [
      () => service.listBranches(principal([]), { limit: 10, cursor: null }),
      () => service.listProducts(principal([]), { limit: 10, cursor: null }),
      () => service.listSuppliers(principal([]), { limit: 10, cursor: null, activeOnly: false }),
      () => service.getSupplier(principal([]), '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4005'),
      () =>
        service.listPurchaseOrders(principal([]), {
          limit: 10,
          cursor: null,
          status: null,
          supplierId: null,
          branchId: null,
        }),
      () => service.getPurchaseOrder(principal([]), ORDER),
      () => service.listReceipts(principal([]), ORDER, 10),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        name: 'PermissionDeniedError',
        permission: 'purchasing.read',
      });
    }
  });

  it('allows an authorized purchasing read to reach the tenant repository', async () => {
    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });
    await expect(
      service.listProducts(principal(['purchasing.read']), { limit: 10, cursor: null }),
    ).rejects.toThrow('database touched');
  });

  it('refuses supplier and order writes before persistence without purchasing.manage', async () => {
    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });
    const supplierId = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4005';
    const branchId = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4006';
    const productId = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4007';
    const calls: readonly (() => Promise<unknown>)[] = [
      () => service.createSupplier(principal(['purchasing.read']), { operationId: 'a', name: 'س' }),
      () =>
        service.updateSupplier(principal(['purchasing.read']), {
          operationId: 'b',
          supplierId,
          isActive: false,
        }),
      () =>
        service.createPurchaseOrder(principal(['purchasing.read']), {
          operationId: 'c',
          supplierId,
          branchId,
          reference: null,
          lines: [{ productId, orderedQuantityScaled: '1000' }],
        }),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        name: 'PermissionDeniedError',
        permission: 'purchasing.manage',
      });
    }
  });

  it('allows an authorized purchasing write to reach persistence', async () => {
    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });
    await expect(
      service.createSupplier(principal(['purchasing.manage']), {
        operationId: 'supplier-authorized',
        name: 'مورد',
      }),
    ).rejects.toThrow('database touched');
  });

  it('refuses even an unknown-cost receipt before persistence without purchasing.receive', async () => {
    const service = createMerchantPurchasingService({ prisma: databaseThatMustNotBeTouched() });
    await expect(service.receive(principal(['purchasing.read']), request())).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'purchasing.receive',
    });
  });
});
