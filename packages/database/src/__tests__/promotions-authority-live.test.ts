import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantId as brandTenantId } from '@korvi/domain';
import { createPrismaClient, withTenant } from '../index.js';
import type { PrismaClient } from '../index.js';
import type { TenantScope } from '@korvi/domain';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '018fd200-0000-7000-8000-00000000000a',
  branch: '018fd200-0000-7000-8000-0000000000b1',
  terminal: '018fd200-0000-7000-8000-0000000000c1',
  shift: '018fd200-0000-7000-8000-0000000000d1',
  user: '018fd200-0000-7000-8000-0000000000e1',
  product: '018fd200-0000-7000-8000-0000000000f1',
  sale1: '018fd200-0000-7000-8000-000000000101',
  sale2: '018fd200-0000-7000-8000-000000000102',
  line1: '018fd200-0000-7000-8000-000000000111',
  line2: '018fd200-0000-7000-8000-000000000112',
  promotion1: '018fd200-0000-7000-8000-000000000201',
  promotion2: '018fd200-0000-7000-8000-000000000202',
  coupon1: '018fd200-0000-7000-8000-000000000211',
  coupon2: '018fd200-0000-7000-8000-000000000212',
  application1: '018fd200-0000-7000-8000-000000000221',
  allocation1: '018fd200-0000-7000-8000-000000000231',
  redemption1: '018fd200-0000-7000-8000-000000000241',
} as const;

const B = {
  tenant: '018fd200-0000-7000-8000-00000000001a',
} as const;

describe.skipIf(url === '')('V2-2 promotions/coupons PostgreSQL authority, live', () => {
  let prisma: PrismaClient;
  const scope: TenantScope = { tenantId: brandTenantId(A.tenant) };
  const otherScope: TenantScope = { tenantId: brandTenantId(B.tenant) };

  async function remove(): Promise<void> {
    for (const id of [A.tenant, B.tenant]) {
      await withTenant(prisma, brandTenantId(id), async (tx) => {
        await tx.tenant.deleteMany({ where: { id } });
      });
    }
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: A.tenant,
          name: 'متجر عروض V2-2',
          slug: 'promotions-live-a',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.branch.create({
        data: {
          id: A.branch,
          tenantId: A.tenant,
          code: 'P22',
          nameAr: 'فرع العروض',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: A.user,
          tenantId: A.tenant,
          email: 'owner@promotions-live.test',
          displayName: 'مالك العروض',
          updatedAt: new Date(),
        },
      });
      await tx.terminal.create({
        data: {
          id: A.terminal,
          tenantId: A.tenant,
          branchId: A.branch,
          code: '01',
          label: 'صندوق العروض',
          updatedAt: new Date(),
        },
      });
      await tx.shift.create({
        data: {
          id: A.shift,
          tenantId: A.tenant,
          branchId: A.branch,
          terminalId: A.terminal,
          userId: A.user,
          openingFloatMinor: 0n,
          openedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.product.create({
        data: {
          id: A.product,
          tenantId: A.tenant,
          sku: 'PROMO-LIVE-1',
          nameAr: 'صنف العرض',
          productType: 'unit',
          priceMinor: 1_150n,
          vatBasisPoints: 1500,
          trackInventory: false,
          updatedAt: new Date(),
        },
      });

      for (const [id, operationId, sequence] of [
        [A.sale1, 'promo-live-sale-1', 1],
        [A.sale2, 'promo-live-sale-2', 2],
      ] as const) {
        await tx.sale.create({
          data: {
            id,
            tenantId: A.tenant,
            branchId: A.branch,
            terminalId: A.terminal,
            shiftId: A.shift,
            userId: A.user,
            operationId,
            status: 'finalized',
            sequence,
            priceMode: 'tax-inclusive',
            currency: 'SAR',
            grossMinor: 1_150n,
            lineDiscountMinor: 0n,
            promotionDiscountMinor: 100n,
            basketDiscountMinor: 0n,
            netMinor: 913n,
            vatMinor: 137n,
            totalMinor: 1_050n,
            tenderedMinor: 1_050n,
            changeMinor: 0n,
            issuedAt: new Date('2026-09-25T12:00:00.000Z'),
          },
        });
      }

      for (const [id, saleId] of [
        [A.line1, A.sale1],
        [A.line2, A.sale2],
      ] as const) {
        await tx.saleLine.create({
          data: {
            id,
            tenantId: A.tenant,
            saleId,
            productId: A.product,
            lineNumber: 1,
            sku: 'PROMO-LIVE-1',
            nameAr: 'صنف العرض',
            productType: 'unit',
            unitPriceMinor: 1_150n,
            vatBasisPoints: 1500,
            quantityScaled: 1_000n,
            grossMinor: 1_150n,
            lineDiscountMinor: 0n,
            promotionDiscountMinor: 100n,
            basketDiscountMinor: 0n,
            netMinor: 913n,
            vatMinor: 137n,
            totalMinor: 1_050n,
          },
        });
      }

      await tx.promotion.createMany({
        data: [
          {
            id: A.promotion1,
            tenantId: A.tenant,
            merchantCode: 'PROMO-1',
            name: 'عرض واحد',
            status: 'active',
            activationMode: 'coupon',
            priority: 100,
            stackingMode: 'stackable',
            effectKind: 'fixed',
            effectValue: 100n,
            minimumEligibleSubtotalMinor: 0n,
            targetKind: 'basket',
            revision: 1n,
            updatedAt: new Date(),
          },
          {
            id: A.promotion2,
            tenantId: A.tenant,
            merchantCode: 'PROMO-2',
            name: 'عرض اثنان',
            status: 'active',
            activationMode: 'coupon',
            priority: 90,
            stackingMode: 'stackable',
            effectKind: 'fixed',
            effectValue: 100n,
            minimumEligibleSubtotalMinor: 0n,
            targetKind: 'basket',
            revision: 1n,
            updatedAt: new Date(),
          },
        ],
      });

      await tx.coupon.createMany({
        data: [
          {
            id: A.coupon1,
            tenantId: A.tenant,
            promotionId: A.promotion1,
            normalizedCode: 'SAVE-10',
            status: 'active',
            revision: 1n,
            updatedAt: new Date(),
          },
          {
            id: A.coupon2,
            tenantId: A.tenant,
            promotionId: A.promotion2,
            normalizedCode: 'SAVE-20',
            status: 'active',
            revision: 1n,
            updatedAt: new Date(),
          },
        ],
      });
    });

    await withTenant(prisma, otherScope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: B.tenant,
          name: 'متجر آخر',
          slug: 'promotions-live-b',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  it('A. stores a valid coupon-backed historical application and same-sale allocation', async () => {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.salePromotionApplication.create({
        data: {
          id: A.application1,
          tenantId: A.tenant,
          saleId: A.sale1,
          promotionId: A.promotion1,
          couponId: A.coupon1,
          promotionRevision: 1n,
          merchantCode: 'PROMO-1',
          name: 'عرض واحد',
          priority: 100,
          stackingMode: 'stackable',
          activationMode: 'coupon',
          effectKind: 'fixed',
          effectValue: 100n,
          eligibleBaseMinor: 1_150n,
          amountMinor: 100n,
          couponCode: 'SAVE-10',
        },
      });
      await tx.salePromotionAllocation.create({
        data: {
          id: A.allocation1,
          tenantId: A.tenant,
          applicationId: A.application1,
          saleLineId: A.line1,
          amountMinor: 100n,
        },
      });
    });

    const stored = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.salePromotionApplication.findFirst({
        where: { id: A.application1 },
        include: { allocations: true },
      }),
    );
    expect(stored?.couponCode).toBe('SAVE-10');
    expect(stored?.allocations).toHaveLength(1);
    expect(stored?.allocations[0]?.saleLineId).toBe(A.line1);
  });

  it('B. refuses a coupon from a different promotion even inside the same tenant', async () => {
    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.salePromotionApplication.create({
          data: {
            id: '018fd200-0000-7000-8000-000000000222',
            tenantId: A.tenant,
            saleId: A.sale2,
            promotionId: A.promotion1,
            couponId: A.coupon2,
            promotionRevision: 1n,
            merchantCode: 'PROMO-1',
            name: 'عرض واحد',
            priority: 100,
            stackingMode: 'stackable',
            activationMode: 'coupon',
            effectKind: 'fixed',
            effectValue: 100n,
            eligibleBaseMinor: 1_150n,
            amountMinor: 100n,
            couponCode: 'SAVE-20',
          },
        }),
      ),
    ).rejects.toThrow(/does not match its coupon instrument/i);
  });

  it('C. refuses an allocation to a line from a different sale', async () => {
    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.salePromotionAllocation.create({
          data: {
            id: '018fd200-0000-7000-8000-000000000232',
            tenantId: A.tenant,
            applicationId: A.application1,
            saleLineId: A.line2,
            amountMinor: 100n,
          },
        }),
      ),
    ).rejects.toThrow(/different sale/i);
  });

  it('D. redemption identities and operation id must reconcile to the application sale', async () => {
    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.couponRedemption.create({
          data: {
            id: '018fd200-0000-7000-8000-000000000242',
            tenantId: A.tenant,
            couponId: A.coupon1,
            promotionId: A.promotion1,
            saleId: A.sale1,
            applicationId: A.application1,
            operationId: 'wrong-operation',
            redeemedAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/does not reconcile/i);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.couponRedemption.create({
        data: {
          id: A.redemption1,
          tenantId: A.tenant,
          couponId: A.coupon1,
          promotionId: A.promotion1,
          saleId: A.sale1,
          applicationId: A.application1,
          operationId: 'promo-live-sale-1',
          redeemedAt: new Date(),
        },
      });
    });

    const row = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.couponRedemption.findFirst({ where: { id: A.redemption1 } }),
    );
    expect(row?.operationId).toBe('promo-live-sale-1');
  });

  it('E. RLS keeps all policy and historical rows invisible to another tenant', async () => {
    const counts = await withTenant(prisma, otherScope.tenantId, async (tx) => ({
      promotions: await tx.promotion.count(),
      coupons: await tx.coupon.count(),
      applications: await tx.salePromotionApplication.count(),
      allocations: await tx.salePromotionAllocation.count(),
      redemptions: await tx.couponRedemption.count(),
    }));
    expect(counts).toEqual({
      promotions: 0,
      coupons: 0,
      applications: 0,
      allocations: 0,
      redemptions: 0,
    });
  });

  it('F. finalized promotion history cannot be updated or directly deleted', async () => {
    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.salePromotionApplication.update({
          where: { id: A.application1 },
          data: { amountMinor: 99n },
        }),
      ),
    ).rejects.toThrow(/immutable/i);

    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.couponRedemption.delete({ where: { id: A.redemption1 } }),
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('G. active promotion/coupon configuration uses lifecycle instead of direct delete', async () => {
    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.coupon.delete({ where: { id: A.coupon1 } }),
      ),
    ).rejects.toThrow(/archived or retired/i);

    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.promotion.delete({ where: { id: A.promotion1 } }),
      ),
    ).rejects.toThrow(/archived or retired/i);
  });

  it('H. product-target edits advance policy revision and active policy cannot lose its last target', async () => {
    const promotionId = '018fd200-0000-7000-8000-000000000203';
    const targetId = '018fd200-0000-7000-8000-000000000251';

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.promotion.create({
        data: {
          id: promotionId,
          tenantId: A.tenant,
          merchantCode: 'PROMO-TARGET',
          name: 'عرض صنف محدد',
          status: 'draft',
          activationMode: 'automatic',
          priority: 80,
          stackingMode: 'stackable',
          effectKind: 'fixed',
          effectValue: 50n,
          minimumEligibleSubtotalMinor: 0n,
          targetKind: 'products',
          revision: 1n,
          updatedAt: new Date(),
        },
      });

      await tx.promotionProduct.create({
        data: {
          id: targetId,
          tenantId: A.tenant,
          promotionId,
          productId: A.product,
        },
      });
    });

    const afterTarget = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.promotion.findFirst({ where: { id: promotionId } }),
    );
    expect(afterTarget?.revision).toBe(2n);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.promotion.update({
        where: { id: promotionId },
        data: { status: 'active', revision: 3n },
      });
    });

    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.promotionProduct.delete({ where: { id: targetId } }),
      ),
    ).rejects.toThrow(/requires at least one product/i);

    const [promotion, target] = await withTenant(prisma, scope.tenantId, async (tx) => [
      await tx.promotion.findFirst({ where: { id: promotionId } }),
      await tx.promotionProduct.findFirst({ where: { id: targetId } }),
    ]);
    expect(promotion?.status).toBe('active');
    expect(promotion?.revision).toBe(3n);
    expect(target?.productId).toBe(A.product);
  });

  it('I. product-targeted policy cannot enter active state before its allow-list exists', async () => {
    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.promotion.create({
          data: {
            id: '018fd200-0000-7000-8000-000000000204',
            tenantId: A.tenant,
            merchantCode: 'PROMO-EMPTY-TARGET',
            name: 'عرض بلا أصناف',
            status: 'active',
            activationMode: 'automatic',
            priority: 70,
            stackingMode: 'stackable',
            effectKind: 'fixed',
            effectValue: 50n,
            minimumEligibleSubtotalMinor: 0n,
            targetKind: 'products',
            revision: 1n,
            updatedAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/configured before activation/i);
  });

});
