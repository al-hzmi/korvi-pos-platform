import { resolveContextPrice } from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { oneOf, rate, scoped, tenantParam } from './mapping.js';
import type {
  ContextPriceList,
  PriceContext,
  Product,
  ProductType,
  RetailBarcodeResolution,
  RetailPackageRecord,
  RetailPriceAuthority,
  RetailPricingRepository,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const PRODUCT_TYPES: readonly ProductType[] = ['unit', 'weighted'];
const PRICE_CONTEXTS: readonly PriceContext[] = ['retail', 'wholesale'];

const PRODUCT_INCLUDE = {
  barcodes: {
    select: { barcode: true, isPrimary: true },
    orderBy: { isPrimary: 'desc' as const },
  },
  category: { select: { nameAr: true, sortOrder: true, isActive: true } },
} as const;

interface ProductRow {
  id: string;
  tenantId: string;
  categoryId: string | null;
  imageUrl: string | null;
  category: { nameAr: string; sortOrder: number; isActive: boolean } | null;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  productType: string;
  unitLabel: string;
  priceMinor: bigint;
  vatBasisPoints: number;
  trackInventory: boolean;
  isActive: boolean;
  barcodes: { barcode: string; isPrimary: boolean }[];
}

interface PackageRow {
  id: string;
  productId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  unitLabel: string;
  baseQuantityScaled: bigint;
  isActive: boolean;
  revision: bigint;
  barcodes: { barcode: string }[];
}

function productToDomain(scope: TenantScope, row: ProductRow): Product {
  const primary = row.barcodes.find((candidate) => candidate.isPrimary) ?? row.barcodes.at(0);
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    categoryId: row.categoryId,
    categoryNameAr: row.category?.isActive === true ? row.category.nameAr : null,
    categorySortOrder: row.category?.isActive === true ? row.category.sortOrder : null,
    imageUrl: row.imageUrl,
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    productType: oneOf(PRODUCT_TYPES, row.productType, 'products.productType'),
    unitLabel: row.unitLabel,
    priceMinor: row.priceMinor.toString(),
    vatBasisPoints: rate(row.vatBasisPoints),
    primaryBarcode: primary?.barcode ?? null,
    barcodes: row.barcodes.map((candidate) => candidate.barcode),
    trackInventory: row.trackInventory,
    isActive: row.isActive,
  };
}

function packageToDomain(row: PackageRow): RetailPackageRecord {
  return {
    id: row.id,
    productId: row.productId,
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    unitLabel: row.unitLabel,
    baseQuantityScaled: row.baseQuantityScaled.toString(),
    barcodes: row.barcodes.map((entry) => entry.barcode),
    isActive: row.isActive,
    revision: row.revision.toString(),
  };
}

export function createRetailPricingRepository(prisma: PrismaClient): RetailPricingRepository {
  return {
    async resolve(scope, input): Promise<RetailPriceAuthority | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const context = oneOf(PRICE_CONTEXTS, input.context, 'price_lists.context');

        const product = await tx.product.findFirst({
          where: { tenantId: tenant, id: input.productId, isActive: true },
          include: PRODUCT_INCLUDE,
        });
        if (product === null) return null;

        const packageRow =
          input.packageId === null
            ? null
            : await tx.productPackage.findFirst({
                where: {
                  tenantId: tenant,
                  id: input.packageId,
                  productId: input.productId,
                  isActive: true,
                },
                include: {
                  barcodes: { select: { barcode: true }, orderBy: { barcode: 'asc' } },
                },
              });
        if (input.packageId !== null && packageRow === null) return null;

        const lists = await tx.priceList.findMany({
          where: { tenantId: tenant, context, status: 'active' },
          include: {
            entries: {
              where: { tenantId: tenant, productId: input.productId },
              orderBy: [{ packageId: 'asc' }, { id: 'asc' }],
            },
          },
          orderBy: { id: 'asc' },
        });

        const domainLists: ContextPriceList[] = lists.map((list) => ({
          id: list.id,
          code: list.code,
          context: oneOf(PRICE_CONTEXTS, list.context, 'price_lists.context'),
          status: oneOf(
            ['draft', 'active', 'paused', 'archived'] as const,
            list.status,
            'price_lists.status',
          ),
          revision: list.revision,
          entries: list.entries.map((entry) => ({
            productId: entry.productId,
            packageId: entry.packageId,
            priceMinor: entry.priceMinor,
          })),
        }));

        const resolved = resolveContextPrice({
          context,
          target: {
            productId: product.id,
            packageId: packageRow?.id ?? null,
            packageBaseQuantityScaled: packageRow?.baseQuantityScaled ?? null,
            productBasePriceMinor: product.priceMinor,
          },
          lists: domainLists,
        });

        const selectedList =
          resolved.priceListId === null
            ? null
            : (lists.find((candidate) => candidate.id === resolved.priceListId) ?? null);

        let selectedEntry: {
          id: string;
          revision: bigint;
        } | null = null;
        if (selectedList !== null) {
          const selectedPackageId =
            resolved.provenance === 'price-list-package' ? (packageRow?.id ?? null) : null;
          const entry =
            selectedList.entries.find(
              (candidate) =>
                candidate.productId === product.id && candidate.packageId === selectedPackageId,
            ) ?? null;
          if (entry !== null) selectedEntry = { id: entry.id, revision: entry.revision };
        }

        return {
          product: productToDomain(scope, product),
          package: packageRow === null ? null : packageToDomain(packageRow),
          context,
          unitPriceMinor: resolved.unitPriceMinor.toString(),
          inventoryFactorScaled: (packageRow?.baseQuantityScaled ?? 1_000n).toString(),
          provenance: resolved.provenance,
          priceListId: resolved.priceListId,
          priceListCode: resolved.priceListCode,
          priceListRevision: resolved.priceListRevision?.toString() ?? null,
          priceListEntryId: selectedEntry?.id ?? null,
          priceListEntryRevision: selectedEntry?.revision.toString() ?? null,
        };
      });
    },

    async resolveBarcode(scope, barcode): Promise<RetailBarcodeResolution | null> {
      const normalized = barcode.trim();
      if (normalized === '') return null;

      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const row = await tx.productBarcode.findFirst({
          where: { tenantId: tenant, barcode: normalized },
          include: {
            product: { include: PRODUCT_INCLUDE },
            package: {
              include: {
                barcodes: { select: { barcode: true }, orderBy: { barcode: 'asc' } },
              },
            },
          },
        });
        if (row === null || !row.product.isActive) return null;
        if (row.packageId !== null && (row.package === null || !row.package.isActive)) return null;

        return {
          barcode: row.barcode,
          product: productToDomain(scope, row.product),
          package: row.package === null ? null : packageToDomain(row.package),
        };
      });
    },

    async listPackagesForProduct(scope, productId) {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const rows = await tx.productPackage.findMany({
          where: { tenantId: tenant, productId, isActive: true },
          include: {
            barcodes: { select: { barcode: true }, orderBy: { barcode: 'asc' } },
          },
          orderBy: [{ code: 'asc' }, { id: 'asc' }],
        });
        return rows.map(packageToDomain);
      });
    },

    async listPackagesForProducts(scope, productIds) {
      const ids = [...new Set(productIds)];
      if (ids.length === 0) return [];
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const rows = await tx.productPackage.findMany({
          where: { tenantId: tenant, productId: { in: ids }, isActive: true },
          include: {
            barcodes: { select: { barcode: true }, orderBy: { barcode: 'asc' } },
          },
          orderBy: [{ productId: 'asc' }, { code: 'asc' }, { id: 'asc' }],
        });
        return rows.map(packageToDomain);
      });
    },
  };
}
