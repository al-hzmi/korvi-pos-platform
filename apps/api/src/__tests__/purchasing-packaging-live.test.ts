import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  createPrismaClient,
  createPurchaseOrder,
  createSupplier,
  getPurchaseOrder,
  recordPurchaseReceipt,
  withTenant,
} from '@korvi/database';
import {
  fingerprintPurchaseOrder,
  fingerprintPurchaseReceipt,
  fingerprintSupplierCreate,
} from '../purchasing/fingerprint.js';
import type { PrismaClient, PurchasingActor } from '@korvi/database';
import type { TenantScope } from '@korvi/domain';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const T = {
  tenant: '018fd300-0000-7000-8000-00000000000a',
  slug: 'v2-three-purchasing-package',
  branch: '018fd300-0000-7000-8000-0000000000b1',
  user: '018fd300-0000-7000-8000-0000000000c1',
  membership: '018fd300-0000-7000-8000-0000000000c2',
  product: '018fd300-0000-7000-8000-0000000000d1',
  package: '018fd300-0000-7000-8000-0000000000e1',
} as const;

describe.skipIf(url === '')('V2-3 package-aware purchasing, PostgreSQL live', () => {
  let prisma: PrismaClient;
  let supplierId = '';

  const scope: TenantScope = { tenantId: brandTenantId(T.tenant) };
  const actor: PurchasingActor = { tenantId: T.tenant, userId: T.user };

  beforeAll(async () => {
    prisma = createPrismaClient(url);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: T.tenant } });
      await tx.tenant.create({
        data: {
          id: T.tenant,
          name: 'متجر V2-3 للمشتريات',
          slug: T.slug,
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({
        data: {
          tenantId: T.tenant,
          vertical: 'retail',
          priceMode: 'tax-inclusive',
          currency: 'SAR',
          allowNegativeStock: false,
          updatedAt: new Date(),
        },
      });
      await tx.branch.create({
        data: {
          id: T.branch,
          tenantId: T.tenant,
          code: 'V23',
          nameAr: 'فرع V2-3',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: T.user,
          tenantId: T.tenant,
          email: 'manager@v2-three-purchasing.test',
          displayName: 'مدير V2-3',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: {
          id: T.membership,
          tenantId: T.tenant,
          userId: T.user,
          defaultBranchId: T.branch,
          updatedAt: new Date(),
        },
      });
      await tx.product.create({
        data: {
          id: T.product,
          tenantId: T.tenant,
          sku: 'V23-CAN',
          nameAr: 'علبة V2-3',
          productType: 'unit',
          unitLabel: 'حبة',
          priceMinor: 500n,
          vatBasisPoints: 1500,
          trackInventory: true,
          isActive: true,
          updatedAt: new Date(),
        },
      });
      await tx.productPackage.create({
        data: {
          id: T.package,
          tenantId: T.tenant,
          productId: T.product,
          code: 'CTN12',
          nameAr: 'كرتون 12',
          unitLabel: 'كرتون',
          baseQuantityScaled: 12_000n,
          isActive: true,
          revision: 1n,
          updatedAt: new Date(),
        },
      });
    });

    const supplier = await createSupplier(
      prisma,
      actor,
      { operationId: `supplier-${newId()}`, name: 'مورد V2-3' },
      fingerprintSupplierCreate(
        { operationId: 'ignored-by-form', name: 'مورد V2-3' },
        actor.userId,
      ),
    );
    supplierId = supplier.supplier.id;
  }, 90_000);

  afterAll(async () => {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: T.tenant } });
    });
    await prisma.$disconnect();
  });

  it('freezes package conversion on the PO and receives stock/cost from that snapshot', async () => {
    const orderRequest = {
      operationId: `package-po-${newId()}`,
      supplierId,
      branchId: T.branch,
      reference: 'PO-PACK-12',
      lines: [
        {
          productId: T.product,
          packageId: T.package,
          orderedQuantityScaled: '2000',
        },
      ],
    };

    const before = await withTenant(prisma, scope.tenantId, async (tx) => ({
      movements: await tx.inventoryMovement.count({ where: { productId: T.product } }),
      balance: await tx.inventoryBalance.findFirst({
        where: { branchId: T.branch, productId: T.product },
      }),
    }));

    const created = await createPurchaseOrder(
      prisma,
      actor,
      orderRequest,
      fingerprintPurchaseOrder(orderRequest, actor.userId),
    );

    expect(created.order.lines).toHaveLength(1);
    const orderLine = created.order.lines[0];
    if (orderLine === undefined) throw new Error('package purchase-order line missing');

    expect(orderLine).toMatchObject({
      productId: T.product,
      packageId: T.package,
      commercialQuantityScaled: '2000',
      packageCode: 'CTN12',
      packageUnitLabel: 'كرتون',
      packageBaseQuantityScaled: '12000',
      orderedQuantityScaled: '24000',
      receivedQuantityScaled: '0',
      remainingQuantityScaled: '24000',
      remainingCommercialQuantityScaled: '2000',
    });

    const afterOrder = await withTenant(prisma, scope.tenantId, async (tx) => ({
      movements: await tx.inventoryMovement.count({ where: { productId: T.product } }),
      balance: await tx.inventoryBalance.findFirst({
        where: { branchId: T.branch, productId: T.product },
      }),
    }));
    expect(afterOrder).toEqual(before);

    // Current catalogue policy may change after ordering. Receiving must use the
    // immutable PO-line package snapshot, not re-resolve this now-inactive row.
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.productPackage.update({
        where: { id: T.package },
        data: { isActive: false, revision: 2n, updatedAt: new Date() },
      });
    });

    const receiptRequest = {
      operationId: `package-receipt-${newId()}`,
      purchaseOrderId: created.order.id,
      reference: 'DN-PACK-1',
      lines: [
        {
          purchaseOrderLineId: orderLine.id,
          acceptedQuantityScaled: '1000',
          inventoryValueMinor: '6000',
        },
      ],
    };

    const receipt = await recordPurchaseReceipt(
      prisma,
      actor,
      receiptRequest,
      fingerprintPurchaseReceipt(receiptRequest, actor.userId),
    );

    expect(receipt.replayed).toBe(false);
    expect(receipt.purchaseOrderStatus).toBe('partially_received');
    expect(receipt.lines[0]).toMatchObject({
      purchaseOrderLineId: orderLine.id,
      productId: T.product,
      packageId: T.package,
      acceptedCommercialQuantityScaled: '1000',
      packageCode: 'CTN12',
      packageUnitLabel: 'كرتون',
      packageBaseQuantityScaled: '12000',
      acceptedQuantityScaled: '12000',
      orderedQuantityScaled: '24000',
      beforeReceivedQuantityScaled: '0',
      afterReceivedQuantityScaled: '12000',
    });

    const evidence = await withTenant(prisma, scope.tenantId, async (tx) => ({
      balance: await tx.inventoryBalance.findFirstOrThrow({
        where: { tenantId_branchId_productId: {
          tenantId: T.tenant,
          branchId: T.branch,
          productId: T.product,
        } },
      }),
      movement: await tx.inventoryMovement.findFirstOrThrow({
        where: { sourceId: receipt.id, productId: T.product },
      }),
      receiptLine: await tx.purchaseReceiptLine.findFirstOrThrow({
        where: { purchaseReceiptId: receipt.id, productId: T.product },
      }),
    }));

    expect(evidence.balance.quantityScaled).toBe(12_000n);
    expect(evidence.movement.quantityScaled).toBe(12_000n);
    expect(evidence.movement.costKnownQuantityScaled).toBe(12_000n);
    expect(evidence.movement.costUnknownQuantityScaled).toBe(0n);
    expect(evidence.movement.costValueMinor).toBe(6_000n);
    expect(evidence.receiptLine.acceptedCommercialQuantityScaled).toBe(1_000n);
    expect(evidence.receiptLine.acceptedQuantityScaled).toBe(12_000n);

    const currentOrder = await getPurchaseOrder(prisma, T.tenant, created.order.id);
    expect(currentOrder?.lines[0]).toMatchObject({
      receivedQuantityScaled: '12000',
      remainingQuantityScaled: '12000',
      remainingCommercialQuantityScaled: '1000',
    });

    const replay = await recordPurchaseReceipt(
      prisma,
      actor,
      receiptRequest,
      fingerprintPurchaseReceipt(receiptRequest, actor.userId),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(receipt.id);
    expect(replay.lines[0]?.acceptedQuantityScaled).toBe('12000');

    const afterReplay = await withTenant(prisma, scope.tenantId, async (tx) => ({
      movements: await tx.inventoryMovement.count({
        where: { sourceId: receipt.id, productId: T.product },
      }),
      balance: await tx.inventoryBalance.findFirstOrThrow({
        where: { tenantId_branchId_productId: {
          tenantId: T.tenant,
          branchId: T.branch,
          productId: T.product,
        } },
      }),
    }));
    expect(afterReplay.movements).toBe(1);
    expect(afterReplay.balance.quantityScaled).toBe(12_000n);
  }, 90_000);
});
