import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantId as brandTenantId } from '@korvi/domain';
import {
  RetailAdminRefusedError,
  createPrismaClient,
  createRetailPriceList,
  createRetailPriceListEntry,
  createRetailPricingRepository,
  createRetailProductPackage,
  listRetailPriceLists,
  updateRetailBasePrice,
  updateRetailPriceList,
  updateRetailPriceListEntry,
  updateRetailProductPackage,
  withTenant,
} from '../index.js';
import type { PrismaClient } from '../index.js';
import type { TenantScope } from '@korvi/domain';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '018fd500-0000-7000-8000-00000000000a',
  user: '018fd500-0000-7000-8000-0000000000a1',
  product: '018fd500-0000-7000-8000-0000000000a2',
  weighted: '018fd500-0000-7000-8000-0000000000a3',
  price: '018fd500-0000-7000-8000-0000000000a4',
} as const;

const B = {
  tenant: '018fd500-0000-7000-8000-00000000000b',
} as const;

const actor = { userId: A.user };
const t0 = '2026-09-28T18:00:00.000Z';

describe.skipIf(url === '')('V2-3 retail administration PostgreSQL authority, live', () => {
  let prisma: PrismaClient;
  let packageId = '';
  let retailListId = '';
  let retailEntryId = '';
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
          name: 'متجر V2-3',
          slug: 'retail-admin-live-a',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: A.user,
          tenantId: A.tenant,
          email: 'owner@retail-admin-live.test',
          displayName: 'مالك V2-3',
          updatedAt: new Date(),
        },
      });
      await tx.product.create({
        data: {
          id: A.product,
          tenantId: A.tenant,
          sku: 'V23-UNIT-1',
          nameAr: 'صنف وحدة V2-3',
          productType: 'unit',
          unitLabel: 'حبة',
          priceMinor: 1_000n,
          vatBasisPoints: 1500,
          trackInventory: true,
          updatedAt: new Date(),
        },
      });
      await tx.product.create({
        data: {
          id: A.weighted,
          tenantId: A.tenant,
          sku: 'V23-WEIGHT-1',
          nameAr: 'صنف موزون V2-3',
          productType: 'weighted',
          unitLabel: 'كجم',
          priceMinor: 2_000n,
          vatBasisPoints: 1500,
          trackInventory: true,
          updatedAt: new Date(),
        },
      });
      await tx.productPrice.create({
        data: {
          id: A.price,
          tenantId: A.tenant,
          productId: A.product,
          priceMinor: 1_000n,
          vatBasisPoints: 1500,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          effectiveTo: null,
          provenance: 'recorded',
        },
      });
    });

    await withTenant(prisma, otherScope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: B.tenant,
          name: 'متجر V2-3 آخر',
          slug: 'retail-admin-live-b',
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
  }, 90_000);

  it('A. creates a fixed package and resolves its tenant-unique barcode to that exact commercial unit', async () => {
    const config = await createRetailProductPackage(prisma, scope, actor, {
      productId: A.product,
      code: 'CTN-12',
      nameAr: 'كرتون 12',
      nameEn: 'Carton 12',
      unitLabel: 'كرتون',
      baseQuantityScaled: '12000',
      barcode: '6280000000123',
      occurredAt: t0,
    });
    const created = config.packages.find((entry) => entry.code === 'CTN-12');
    expect(created?.baseQuantityScaled).toBe('12000');
    expect(created?.barcodes[0]?.barcode).toBe('6280000000123');
    packageId = created?.id ?? '';
    expect(packageId).not.toBe('');

    const resolved = await createRetailPricingRepository(prisma).resolveBarcode(
      scope,
      '6280000000123',
    );
    expect(resolved?.product.id).toBe(A.product);
    expect(resolved?.package?.id).toBe(packageId);
    expect(resolved?.package?.baseQuantityScaled).toBe('12000');
  });

  it('B. refuses packages for weighted products and keeps package conversion immutable', async () => {
    await expect(
      createRetailProductPackage(prisma, scope, actor, {
        productId: A.weighted,
        code: 'BAD-PACK',
        nameAr: 'تعبئة غير صالحة',
        nameEn: null,
        unitLabel: 'كرتون',
        baseQuantityScaled: '12000',
        barcode: null,
        occurredAt: t0,
      }),
    ).rejects.toMatchObject({ detail: 'unit-product-required' });

    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.productPackage.update({
          where: { id: packageId },
          data: { baseQuantityScaled: 24_000n, revision: { increment: 1n } },
        }),
      ),
    ).rejects.toThrow();
  });

  it('C. enforces optimistic package revisions instead of accepting stale administration', async () => {
    const changed = await updateRetailProductPackage(prisma, scope, actor, packageId, {
      expectedRevision: '1',
      nameAr: 'كرتون اثنا عشر',
      occurredAt: '2026-09-28T18:01:00.000Z',
    });
    expect(changed.packages.find((entry) => entry.id === packageId)?.revision).toBe('2');

    await expect(
      updateRetailProductPackage(prisma, scope, actor, packageId, {
        expectedRevision: '1',
        unitLabel: 'صندوق',
        occurredAt: '2026-09-28T18:02:00.000Z',
      }),
    ).rejects.toMatchObject({ detail: 'stale-revision' });
  });

  it('D. updates base price and its open ProductPrice history atomically', async () => {
    const updated = await updateRetailBasePrice(prisma, scope, actor, A.product, {
      expectedPriceMinor: '1000',
      priceMinor: '1200',
      occurredAt: '2026-09-28T18:03:00.000Z',
    });
    expect(updated.priceMinor).toBe('1200');

    await withTenant(prisma, scope.tenantId, async (tx) => {
      const product = await tx.product.findFirst({
        where: { tenantId: A.tenant, id: A.product },
        select: { priceMinor: true },
      });
      expect(product?.priceMinor).toBe(1_200n);
      const history = await tx.productPrice.findMany({
        where: { tenantId: A.tenant, productId: A.product },
        orderBy: { effectiveFrom: 'asc' },
      });
      expect(history).toHaveLength(2);
      expect(history[0]?.effectiveTo?.toISOString()).toBe('2026-09-28T18:03:00.000Z');
      expect(history[1]?.priceMinor).toBe(1_200n);
      expect(history[1]?.effectiveTo).toBeNull();
    });

    await expect(
      updateRetailBasePrice(prisma, scope, actor, A.product, {
        expectedPriceMinor: '1000',
        priceMinor: '1300',
        occurredAt: '2026-09-28T18:04:00.000Z',
      }),
    ).rejects.toMatchObject({ detail: 'stale-revision' });
  });

  it('E. governs list entries off-line from active policy and permits only one active list per context', async () => {
    const retail = await createRetailPriceList(prisma, scope, actor, {
      code: 'RETAIL-1',
      name: 'تجزئة رئيسية',
      context: 'retail',
      occurredAt: '2026-09-28T18:05:00.000Z',
    });
    retailListId = retail.id;

    const withBase = await createRetailPriceListEntry(prisma, scope, actor, retail.id, {
      productId: A.product,
      packageId: null,
      priceMinor: '1100',
      occurredAt: '2026-09-28T18:06:00.000Z',
    });
    retailEntryId = withBase.entries[0]?.id ?? '';
    expect(retailEntryId).not.toBe('');

    const withPackage = await createRetailPriceListEntry(prisma, scope, actor, retail.id, {
      productId: A.product,
      packageId,
      priceMinor: '12000',
      occurredAt: '2026-09-28T18:07:00.000Z',
    });
    expect(withPackage.entries).toHaveLength(2);

    const active = await updateRetailPriceList(prisma, scope, actor, retail.id, {
      expectedRevision: '1',
      status: 'active',
      occurredAt: '2026-09-28T18:08:00.000Z',
    });
    expect(active.status).toBe('active');

    await expect(
      updateRetailPriceListEntry(prisma, scope, actor, retailEntryId, {
        expectedRevision: '1',
        priceMinor: '1050',
        occurredAt: '2026-09-28T18:09:00.000Z',
      }),
    ).rejects.toMatchObject({ detail: 'invalid-state' });

    const competing = await createRetailPriceList(prisma, scope, actor, {
      code: 'RETAIL-2',
      name: 'تجزئة بديلة',
      context: 'retail',
      occurredAt: '2026-09-28T18:10:00.000Z',
    });
    await expect(
      updateRetailPriceList(prisma, scope, actor, competing.id, {
        expectedRevision: '1',
        status: 'active',
        occurredAt: '2026-09-28T18:11:00.000Z',
      }),
    ).rejects.toMatchObject({ detail: 'active-context-taken' });
  });

  it('F. isolates all commercial policy by tenant and rejects direct identity deletion', async () => {
    expect(await listRetailPriceLists(prisma, otherScope)).toEqual([]);

    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.productPackage.delete({ where: { id: packageId } }),
      ),
    ).rejects.toThrow();

    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.priceList.delete({ where: { id: retailListId } }),
      ),
    ).rejects.toThrow();

    const foreign = await withTenant(prisma, otherScope.tenantId, (tx) =>
      tx.productPackage.findFirst({ where: { id: packageId } }),
    );
    expect(foreign).toBeNull();
  });

  it('G. exposes deliberate refusal errors as typed database authority', () => {
    expect(new RetailAdminRefusedError('invalid-input')).toMatchObject({
      name: 'RetailAdminRefusedError',
      detail: 'invalid-input',
    });
  });
});
