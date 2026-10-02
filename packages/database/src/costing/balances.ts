import { assertPoolFitsStock } from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { oneOf } from '../repositories/mapping.js';
import type { ProductType } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * The current valuation facts a cost reader may inspect.
 *
 * Total stock remains owned by `inventory_balances`; the unknown positive
 * quantity is derived beside the known pool in this read. Every integer leaves
 * the database as text, and no unit-cost quotient is invented from a pool whose
 * exact remainder doctrine belongs to movements rather than presentation.
 */
export interface CostBalancePageRow {
  readonly branchId: string;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType;
  readonly unitLabel: string;
  readonly isActive: boolean;
  readonly trackInventory: boolean;
  readonly quantityScaled: string;
  readonly knownQuantityScaled: string;
  readonly unknownPositiveQuantityScaled: string;
  readonly knownValueMinor: string;
  readonly stockRevision: string;
  readonly costRevision: string;
}

export interface CostBalancePage {
  readonly rows: readonly CostBalancePageRow[];
  readonly nextCursor: string | null;
}

export const MAX_COST_BALANCE_PAGE = 200;

const PRODUCT_TYPES: readonly ProductType[] = ['unit', 'weighted'];

interface CostReadRow {
  readonly branchId: string;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: string;
  readonly unitLabel: string;
  readonly isActive: boolean;
  readonly trackInventory: boolean;
  readonly quantityScaled: bigint;
  readonly stockMaterialized: boolean;
  readonly inventoryRevision: bigint;
  readonly costMaterialized: boolean;
  readonly knownQuantityScaled: bigint;
  readonly knownValueMinor: bigint;
  readonly costStockRevision: bigint;
  readonly costRevision: bigint;
}

function mapRow(row: CostReadRow): CostBalancePageRow {
  // An absent cost row is legitimate only for an unmaterialized zero balance.
  // Every real stock movement and the 5C migration materialize a synchronized
  // cost cursor. Treating a missing/divergent cursor as "all unknown" would
  // hide a broken historical chain from the very screen meant to expose it.
  if (
    (row.costMaterialized && !row.stockMaterialized) ||
    (!row.costMaterialized && (row.quantityScaled !== 0n || row.inventoryRevision !== 0n)) ||
    (row.costMaterialized && row.costStockRevision !== row.inventoryRevision)
  ) {
    throw new Error('Costing invariant failed: valuation read found an unsynchronized cursor.');
  }
  assertPoolFitsStock(row.quantityScaled, {
    knownQuantityScaled: row.knownQuantityScaled,
    knownValueMinor: row.knownValueMinor,
  });

  const positiveOnHand = row.quantityScaled > 0n ? row.quantityScaled : 0n;
  return {
    branchId: row.branchId,
    productId: row.productId,
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    productType: oneOf(PRODUCT_TYPES, row.productType, 'products.productType'),
    unitLabel: row.unitLabel,
    isActive: row.isActive,
    trackInventory: row.trackInventory,
    quantityScaled: row.quantityScaled.toString(),
    knownQuantityScaled: row.knownQuantityScaled.toString(),
    unknownPositiveQuantityScaled: (positiveOnHand - row.knownQuantityScaled).toString(),
    knownValueMinor: row.knownValueMinor.toString(),
    stockRevision: row.inventoryRevision.toString(),
    costRevision: row.costRevision.toString(),
  };
}

/**
 * Bounded, tenant-scoped cost balances for one branch.
 *
 * As with the stock page, active tracked products in an active branch appear
 * as exact zero without being materialized. Historical products/branches stay
 * visible only where a stock or cost row already exists. A foreign branch id
 * cannot satisfy the tenant-bound branch join and therefore returns no rows.
 */
export async function listCostBalancePage(
  prisma: PrismaClient,
  tenantId: string,
  branchId: string,
  limit: number,
  cursor: string | null,
): Promise<CostBalancePage> {
  const bounded = Math.max(1, Math.min(limit, MAX_COST_BALANCE_PAGE));

  return withTenant(prisma, tenantId, async (tx) => {
    const rows = await tx.$queryRaw<CostReadRow[]>`
      SELECT br."id" AS "branchId", p."id" AS "productId", p."sku", p."nameAr",
             p."nameEn", p."productType", p."unitLabel", p."isActive", p."trackInventory",
             COALESCE(b."quantityScaled", 0::bigint) AS "quantityScaled",
             (b."productId" IS NOT NULL) AS "stockMaterialized",
             COALESCE(b."revision", 0::bigint) AS "inventoryRevision",
             (c."productId" IS NOT NULL) AS "costMaterialized",
             COALESCE(c."knownQuantityScaled", 0::bigint) AS "knownQuantityScaled",
             COALESCE(c."knownValueMinor", 0::bigint) AS "knownValueMinor",
             COALESCE(c."stockRevision", 0::bigint) AS "costStockRevision",
             COALESCE(c."costRevision", 0::bigint) AS "costRevision"
        FROM "products" p
        JOIN "branches" br
          ON br."tenantId" = p."tenantId"
         AND br."id" = ${branchId}::uuid
        LEFT JOIN "inventory_balances" b
          ON b."tenantId" = p."tenantId"
         AND b."branchId" = ${branchId}::uuid
         AND b."productId" = p."id"
        LEFT JOIN "inventory_cost_balances" c
          ON c."tenantId" = p."tenantId"
         AND c."branchId" = ${branchId}::uuid
         AND c."productId" = p."id"
       WHERE p."tenantId" = ${tenantId}::uuid
         AND (
           (br."isActive" AND p."isActive" AND p."trackInventory")
           OR b."productId" IS NOT NULL
           OR c."productId" IS NOT NULL
         )
         AND (${cursor}::uuid IS NULL OR p."id" > ${cursor}::uuid)
       ORDER BY p."id" ASC
       LIMIT ${bounded + 1}`;

    const page = rows.slice(0, bounded);
    const last = page.at(-1);
    return {
      rows: page.map(mapRow),
      nextCursor: rows.length > bounded && last !== undefined ? last.productId : null,
    };
  });
}
