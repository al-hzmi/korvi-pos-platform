import type { Product, ProductRepository, TenantScope } from '@korvi/domain';
import { basisPointsFromColumn, tenantId } from '@korvi/domain';
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
interface ProductRow {
  id: string;
  tenantId: string;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  priceMinor: bigint;
  vatBasisPoints: number;
  barcode: string | null;
}

function toDomain(row: ProductRow): Product {
  return {
    id: row.id,
    tenantId: tenantId(row.tenantId),
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    priceMinor: row.priceMinor.toString(),
    vatBasisPoints: basisPointsFromColumn(row.vatBasisPoints),
    barcode: row.barcode,
  };
}

export function createProductRepository(prisma: PrismaClient): ProductRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<Product | null> {
      const row = await prisma.product.findFirst({
        where: { id, tenantId: scope.tenantId },
      });
      return row === null ? null : toDomain(row);
    },

    async findByBarcode(scope: TenantScope, barcode: string): Promise<Product | null> {
      const row = await prisma.product.findFirst({
        where: { barcode, tenantId: scope.tenantId },
      });
      return row === null ? null : toDomain(row);
    },

    async list(scope: TenantScope, limit: number): Promise<readonly Product[]> {
      const rows = await prisma.product.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { sku: 'asc' },
        take: limit,
      });
      return rows.map(toDomain);
    },
  };
}
