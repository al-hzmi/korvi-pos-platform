import type { BasisPoints } from '../tax/basis-points.js';

/**
 * Repository ports.
 *
 * The domain declares what it needs; packages/database supplies it. Prisma
 * types never cross this line, which is what keeps the core liftable into
 * Korvi ERP later (ADR-0001) and stops ORM shapes reaching the UI (ADR-0004).
 */

/** Branded so a bare string cannot be passed where a tenant is expected. */
export type TenantId = string & { readonly __brand: 'TenantId' };

export function tenantId(value: string): TenantId {
  return value as TenantId;
}

/**
 * Every tenant-owned read and write carries this.
 *
 * GlobalCatalog is deliberately outside it: the national barcode catalogue is
 * shared infrastructure, not tenant data, and giving it a tenantId would mean
 * storing hundreds of thousands of duplicate rows per merchant (ADR-0004).
 */
export interface TenantScope {
  readonly tenantId: TenantId;
}

export interface Product {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  /** Minor units, as a string at this boundary. See ADR-0002. */
  readonly priceMinor: string;
  /**
   * Branded and validated, not a bare number. The adapter narrows the integer
   * column through `basisPointsFromColumn`, so a corrupt row fails at the
   * boundary instead of producing a wrong tax figure downstream.
   */
  readonly vatBasisPoints: BasisPoints;
  readonly barcode: string | null;
}

export interface GlobalCatalogItem {
  readonly barcode: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly vatBasisPoints: BasisPoints;
}

export interface ProductRepository {
  findById(scope: TenantScope, id: string): Promise<Product | null>;
  findByBarcode(scope: TenantScope, barcode: string): Promise<Product | null>;
  list(scope: TenantScope, limit: number): Promise<readonly Product[]>;
}

export interface GlobalCatalogRepository {
  findByBarcode(barcode: string): Promise<GlobalCatalogItem | null>;
}
