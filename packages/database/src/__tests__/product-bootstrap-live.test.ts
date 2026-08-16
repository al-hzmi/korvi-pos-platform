import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  ProductBootstrapRefusedError,
  activateTenant,
  createBootstrapProduct,
  createPrismaClient,
  provisionPermissionCatalogue,
  provisionTenant,
  readTenantOnboardingReadiness,
  withLoginSlug,
  withTenant,
} from '../index.js';
import type { PrismaClient } from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const OPERATOR = 'ops:platform/4d4';
const SLUGS = ['4d4-product-a', '4d4-product-b', '4d4-product-c', '4d4-product-d'] as const;

interface Shop {
  tenantId: string;
  actorUserId: string;
}

describe.skipIf(url === '')('product bootstrap authority, live', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;

  async function resolveId(slug: string): Promise<string | null> {
    return withLoginSlug(prisma, slug, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "tenants" WHERE "slug" = ${slug}`;
      return rows[0]?.id ?? null;
    });
  }

  async function purge(slug: string): Promise<void> {
    const id = await resolveId(slug);
    if (id === null) return;
    await withTenant(prisma, id, async (tx) => {
      await tx.tenant.deleteMany({ where: { id } });
    });
  }

  async function shop(slug: string): Promise<Shop> {
    const provisioned = await provisionTenant(prisma, {
      operationId: `op-${slug}`,
      slug,
      name: `متجر ${slug}`,
      vatNumber: null,
      vertical: 'retail',
      controlPlaneActorRef: OPERATOR,
    });
    await activateTenant(prisma, {
      tenantId: provisioned.id,
      operationId: `op-activate-${slug}`,
      controlPlaneActorRef: OPERATOR,
    });

    const actorUserId = newId();
    await withTenant(prisma, provisioned.id, async (tx) => {
      await tx.user.create({
        data: {
          id: actorUserId,
          tenantId: provisioned.id,
          email: `actor@${slug}.test`,
          displayName: 'مدير المنتجات',
          passwordHash: null,
          isActive: true,
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: {
          id: newId(),
          tenantId: provisioned.id,
          userId: actorUserId,
          status: 'active',
          updatedAt: new Date(),
        },
      });
    });
    return { tenantId: provisioned.id, actorUserId };
  }

  const scope = (tenantId: string) => ({ tenantId: brandTenantId(tenantId) });

  const draft = (sku: string, barcode: string) => ({
    sku,
    nameAr: `صنف ${sku}`,
    nameEn: null,
    productType: 'unit' as const,
    unitLabel: 'each',
    priceMinor: '1250',
    barcode,
  });

  async function refusal(work: () => Promise<unknown>): Promise<ProductBootstrapRefusedError> {
    try {
      await work();
    } catch (error) {
      if (error instanceof ProductBootstrapRefusedError) return error;
      throw error;
    }
    throw new Error('expected product bootstrap refusal');
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    second = createPrismaClient(url);
    await second.$queryRaw`SELECT 1`;
    for (const slug of SLUGS) await purge(slug);
    await provisionPermissionCatalogue(prisma);
  }, 180_000);

  afterAll(async () => {
    for (const slug of SLUGS) await purge(slug);
    await prisma.$disconnect();
    await second.$disconnect();
  });

  it('atomically creates active catalogue truth, price history and audit, then satisfies active-product readiness', async () => {
    const target = await shop(SLUGS[0]);
    const before = await readTenantOnboardingReadiness(prisma, scope(target.tenantId));
    expect(before?.checks.find((check) => check.key === 'active-product')?.ready).toBe(false);

    const product = await createBootstrapProduct(
      prisma,
      scope(target.tenantId),
      { userId: target.actorUserId },
      draft(' coffee-01 ', '6281000000012'),
    );

    expect(product).toMatchObject({
      sku: 'COFFEE-01',
      priceMinor: '1250',
      vatBasisPoints: 1500,
      primaryBarcode: '6281000000012',
      trackInventory: true,
      isActive: true,
    });

    await withTenant(prisma, target.tenantId, async (tx) => {
      expect(await tx.product.count({ where: { tenantId: target.tenantId, id: product.id } })).toBe(1);
      expect(
        await tx.productPrice.count({ where: { tenantId: target.tenantId, productId: product.id } }),
      ).toBe(1);
      expect(
        await tx.productBarcode.count({ where: { tenantId: target.tenantId, productId: product.id } }),
      ).toBe(1);
      expect(
        await tx.auditEvent.count({
          where: { tenantId: target.tenantId, entityId: product.id, eventType: 'product.created' },
        }),
      ).toBe(1);
    });

    const after = await readTenantOnboardingReadiness(prisma, scope(target.tenantId));
    expect(after?.checks.find((check) => check.key === 'active-product')?.ready).toBe(true);
  });

  it('derives barcode and inventory behaviour from tenant settings, not client authority', async () => {
    const target = await shop(SLUGS[1]);

    const missing = await refusal(() =>
      createBootstrapProduct(prisma, scope(target.tenantId), { userId: target.actorUserId }, {
        ...draft('NO-BARCODE-1', 'unused'),
        barcode: null,
      }),
    );
    expect(missing.detail).toBe('barcode-required');

    await withTenant(prisma, target.tenantId, async (tx) => {
      await tx.tenantSettings.update({
        where: { tenantId: target.tenantId },
        data: { requireBarcode: false, trackInventory: false },
      });
    });

    const product = await createBootstrapProduct(
      prisma,
      scope(target.tenantId),
      { userId: target.actorUserId },
      { ...draft('NO-BARCODE-2', 'unused'), barcode: null },
    );
    expect(product.primaryBarcode).toBeNull();
    expect(product.trackInventory).toBe(false);
  });

  it('fails closed for weighted products until the tenant explicitly allows them', async () => {
    const target = await shop(SLUGS[2]);
    const weighted = { ...draft('WEIGHT-1', '6281000000029'), productType: 'weighted' as const, unitLabel: 'kg' };

    expect(
      (await refusal(() =>
        createBootstrapProduct(prisma, scope(target.tenantId), { userId: target.actorUserId }, weighted),
      )).detail,
    ).toBe('weighted-disabled');

    await withTenant(prisma, target.tenantId, async (tx) => {
      await tx.tenantSettings.update({
        where: { tenantId: target.tenantId },
        data: { allowWeightedItems: true },
      });
    });

    expect(
      (
        await createBootstrapProduct(
          prisma,
          scope(target.tenantId),
          { userId: target.actorUserId },
          weighted,
        )
      ).productType,
    ).toBe('weighted');
  });

  it('rolls the whole transaction back when a primary barcode loses uniqueness', async () => {
    const target = await shop(SLUGS[3]);
    const barcode = '6281000000036';
    await createBootstrapProduct(
      prisma,
      scope(target.tenantId),
      { userId: target.actorUserId },
      draft('BARCODE-A', barcode),
    );

    expect(
      (await refusal(() =>
        createBootstrapProduct(
          prisma,
          scope(target.tenantId),
          { userId: target.actorUserId },
          draft('BARCODE-B', barcode),
        ),
      )).detail,
    ).toBe('barcode-taken');

    await withTenant(prisma, target.tenantId, async (tx) => {
      expect(await tx.product.count({ where: { tenantId: target.tenantId, sku: 'BARCODE-B' } })).toBe(0);
      expect(
        await tx.auditEvent.count({
          where: { tenantId: target.tenantId, eventType: 'product.created', metadata: { path: ['sku'], equals: 'BARCODE-B' } },
        }),
      ).toBe(0);
    });
  });

  it('lets exactly one concurrent request claim a SKU', async () => {
    const target = await resolveId(SLUGS[3]);
    if (target === null) throw new Error('test tenant missing');
    const actor = await withTenant(prisma, target, async (tx) => {
      const row = await tx.user.findFirst({ where: { tenantId: target }, select: { id: true } });
      if (row === null) throw new Error('test actor missing');
      return row.id;
    });

    const one = createBootstrapProduct(
      prisma,
      scope(target),
      { userId: actor },
      draft('RACE-SKU', '6281000000043'),
    );
    const two = createBootstrapProduct(
      second,
      scope(target),
      { userId: actor },
      draft('RACE-SKU', '6281000000050'),
    );
    const settled = await Promise.allSettled([one, two]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(ProductBootstrapRefusedError);
      expect((rejected.reason as ProductBootstrapRefusedError).detail).toBe('sku-taken');
    }

    await withTenant(prisma, target, async (tx) => {
      expect(await tx.product.count({ where: { tenantId: target, sku: 'RACE-SKU' } })).toBe(1);
    });
  });
});
