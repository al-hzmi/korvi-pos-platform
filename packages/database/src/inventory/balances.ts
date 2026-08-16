import { withTenant } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

/**
 * Reading balances, with the concurrency evidence a count will need.
 *
 * Keyset pagination on `productId`, not offset: a merchant's stock changes
 * while they page through it, and `OFFSET` against a moving table silently
 * skips and repeats rows. The cursor is the last product id seen, so a page
 * boundary means "after this product" and stays true whatever else commits.
 *
 * Quantity and revision leave here as decimal integer strings. A revision is
 * the value a count submits back, and rounding one through a JSON `number`
 * would turn a concurrency check into a coin toss (ADR-0024 §A).
 */

export interface BalancePageRow {
  readonly branchId: string;
  readonly productId: string;
  readonly quantityScaled: string;
  readonly revision: string;
}

export interface BalancePage {
  readonly rows: readonly BalancePageRow[];
  /** The id to pass as the next cursor, or null when the page is the last. */
  readonly nextCursor: string | null;
}

export const MAX_BALANCE_PAGE = 200;

export async function listBalancePage(
  prisma: PrismaClient,
  tenantId: string,
  branchId: string,
  limit: number,
  cursor: string | null,
): Promise<BalancePage> {
  const bounded = Math.max(1, Math.min(limit, MAX_BALANCE_PAGE));

  return withTenant(prisma, tenantId, async (tx) => {
    // One more than asked for, so "is there another page" is answered by the
    // read itself rather than by a second count query that could disagree.
    const rows = await tx.$queryRaw<
      { branchId: string; productId: string; quantityScaled: bigint; revision: bigint }[]
    >`
      SELECT "branchId", "productId", "quantityScaled", "revision"
        FROM "inventory_balances"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "branchId" = ${branchId}::uuid
         AND (${cursor}::uuid IS NULL OR "productId" > ${cursor}::uuid)
       ORDER BY "productId" ASC
       LIMIT ${bounded + 1}`;

    const page = rows.slice(0, bounded);
    const last = page.at(-1);
    return {
      rows: page.map((row) => ({
        branchId: row.branchId,
        productId: row.productId,
        quantityScaled: row.quantityScaled.toString(),
        revision: row.revision.toString(),
      })),
      nextCursor: rows.length > bounded && last !== undefined ? last.productId : null,
    };
  });
}
