import { withTenant, withoutTenant } from '../tenant-context.js';
import { oneOf, rate, scoped, tenantParam } from './mapping.js';
import type {
  GlobalCatalogItem,
  GlobalCatalogRepository,
  Product,
  ProductRepository,
  ProductType,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * Prisma-backed adapter for the domain's ProductRepository port.
 *
 * Every method maps the ORM row to the domain shape before returning. That
 * mapping is the boundary: no Prisma type escapes this file, so the UI and the
 * domain never learn what the ORM is (ADR-0001, ADR-0004).
 *
 * `priceMinor` crosses as a string. Prisma hands back a BigInt, and letting a
 * BigInt reach a JSON boundary either throws or silently degrades to a float.
 *
 * `vatBasisPoints` is narrowed through `basisPointsFromColumn`, which validates
 * the range. A corrupt row then fails at this boundary rather than producing a
 * wrong tax figure on a printed invoice.
 */

const PRODUCT_TYPES: readonly ProductType[] = ['unit', 'weighted'];

interface BarcodeRow {
  barcode: string;
  isPrimary: boolean;
}

interface ProductRow {
  id: string;
  tenantId: string;
  categoryId: string | null;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  productType: string;
  unitLabel: string;
  priceMinor: bigint;
  vatBasisPoints: number;
  trackInventory: boolean;
  isActive: boolean;
  barcodes: BarcodeRow[];
}

function toDomain(scope: TenantScope, row: ProductRow): Product {
  const primary = row.barcodes.find((candidate) => candidate.isPrimary) ?? row.barcodes.at(0);
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    categoryId: row.categoryId,
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    productType: oneOf(PRODUCT_TYPES, row.productType, 'products.productType'),
    unitLabel: row.unitLabel,
    priceMinor: row.priceMinor.toString(),
    vatBasisPoints: rate(row.vatBasisPoints),
    primaryBarcode: primary === undefined ? null : primary.barcode,
    barcodes: row.barcodes.map((candidate) => candidate.barcode),
    trackInventory: row.trackInventory,
    isActive: row.isActive,
  };
}

const WITH_BARCODES = {
  barcodes: { select: { barcode: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
} as const;

export function createProductRepository(prisma: PrismaClient): ProductRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<Product | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.product.findFirst({
          where: { id, tenantId: tenantParam(scope) },
          include: WITH_BARCODES,
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findBySku(scope: TenantScope, sku: string): Promise<Product | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.product.findFirst({
          where: { sku, tenantId: tenantParam(scope) },
          include: WITH_BARCODES,
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findByBarcode(scope: TenantScope, barcode: string): Promise<Product | null> {
      // The barcode is unique *within* a tenant, not globally: two merchants
      // may legitimately stock the same EAN. Scoping the lookup is therefore
      // correctness as well as isolation.
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.product.findFirst({
          where: {
            tenantId: tenantParam(scope),
            barcodes: { some: { barcode, tenantId: tenantParam(scope) } },
          },
          include: WITH_BARCODES,
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async list(scope: TenantScope, limit: number): Promise<readonly Product[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows = await tx.product.findMany({
          where: { tenantId: tenantParam(scope) },
          orderBy: { sku: 'asc' },
          take: limit,
          include: WITH_BARCODES,
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },
  };
}

/**
 * The national catalogue: shared reference data, no tenant, no RLS.
 *
 * Read-only here on purpose. A merchant scanning an unknown barcode gets a
 * name suggestion from it; nothing in the sale path writes to it, so one
 * tenant's mistake cannot become every tenant's product name.
 */
export function createGlobalCatalogRepository(prisma: PrismaClient): GlobalCatalogRepository {
  return {
    async findByBarcode(barcode: string): Promise<GlobalCatalogItem | null> {
      return withoutTenant(prisma, async (tx) => {
        const row = await tx.globalCatalogItem.findUnique({ where: { barcode } });
        if (row === null) return null;
        return {
          barcode: row.barcode,
          nameAr: row.nameAr,
          nameEn: row.nameEn,
          vatBasisPoints: rate(row.vatBasisPoints),
        };
      });
    },
  };
}
