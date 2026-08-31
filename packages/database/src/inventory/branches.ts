import { withTenant } from '../tenant-context.js';
import { tenantParam } from '../repositories/mapping.js';
import type { PrismaClient } from '../client.js';
import type { TenantScope } from '@korvi/domain';

/**
 * The branch identity an inventory operator needs, and no administration
 * authority with it.
 *
 * Inactive branches stay in this read model because deactivation stops new
 * operations; it does not erase the stock history an operator must reconcile.
 */
export interface InventoryBranch {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
}

export interface InventoryBranchPage {
  readonly rows: readonly InventoryBranch[];
  /** The branch id to pass as the next cursor, or null on the last page. */
  readonly nextCursor: string | null;
}

export const MAX_INVENTORY_BRANCH_PAGE = 100;

export async function listInventoryBranchPage(
  prisma: PrismaClient,
  scope: TenantScope,
  limit: number,
  cursor: string | null,
): Promise<InventoryBranchPage> {
  const bounded = Math.max(1, Math.min(limit, MAX_INVENTORY_BRANCH_PAGE));

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const rows = await tx.branch.findMany({
      where: {
        tenantId: tenantParam(scope),
        ...(cursor === null ? {} : { id: { gt: cursor } }),
      },
      orderBy: { id: 'asc' },
      take: bounded + 1,
      select: { id: true, code: true, nameAr: true, nameEn: true, isActive: true },
    });

    const page = rows.slice(0, bounded);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor: rows.length > bounded && last !== undefined ? last.id : null,
    };
  });
}
