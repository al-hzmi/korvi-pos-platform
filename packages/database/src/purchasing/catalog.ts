import { withTenant } from '../tenant-context.js';
import { oneOf, tenantParam } from '../repositories/mapping.js';
import type { PrismaClient } from '../client.js';
import type { ProductType, TenantScope } from '@korvi/domain';

/**
 * Product identity a purchasing operator needs to state an order line.
 *
 * Retail price and stock are deliberately absent. `purchasing.read` is not a
 * back door to either catalogue pricing or inventory balances; this bounded
 * read exists only because an operator cannot safely order an opaque UUID.
 * Inactive and untracked rows remain readable so historical purchase orders
 * can still be understood, while the client offers only active tracked rows
 * for new orders and the locked authority rechecks both facts.
 */
export interface PurchasingProduct {
  readonly id: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType;
  readonly unitLabel: string;
  readonly isActive: boolean;
  readonly trackInventory: boolean;
}

export interface PurchasingProductPage {
  readonly rows: readonly PurchasingProduct[];
  readonly nextCursor: string | null;
}

export const MAX_PURCHASING_PRODUCT_PAGE = 200;

const PRODUCT_TYPES: readonly ProductType[] = ['unit', 'weighted'];

export async function listPurchasingProductPage(
  prisma: PrismaClient,
  scope: TenantScope,
  limit: number,
  cursor: string | null,
): Promise<PurchasingProductPage> {
  const bounded = Math.max(1, Math.min(limit, MAX_PURCHASING_PRODUCT_PAGE));

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const rows = await tx.product.findMany({
      where: {
        tenantId: tenantParam(scope),
        ...(cursor === null ? {} : { id: { gt: cursor } }),
      },
      orderBy: { id: 'asc' },
      take: bounded + 1,
      select: {
        id: true,
        sku: true,
        nameAr: true,
        nameEn: true,
        productType: true,
        unitLabel: true,
        isActive: true,
        trackInventory: true,
      },
    });

    const page = rows.slice(0, bounded);
    const last = page.at(-1);
    return {
      rows: page.map((row) => ({
        ...row,
        productType: oneOf(PRODUCT_TYPES, row.productType, 'products.productType'),
      })),
      nextCursor: rows.length > bounded && last !== undefined ? last.id : null,
    };
  });
}
