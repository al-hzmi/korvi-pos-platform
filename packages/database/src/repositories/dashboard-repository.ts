import { withTenant } from '../tenant-context.js';
import { tenantParam } from './mapping.js';
import type { DashboardRepository, DashboardSummary, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * The owner's first screen, assembled from rows that already exist.
 *
 * Every query runs inside `withTenant`, so RLS is the boundary rather than a
 * `where` clause somebody has to remember. There is no parameter on this
 * repository that could name another tenant, which is the point: an aggregate
 * is exactly the shape of query where one missing predicate leaks a
 * competitor's turnover, and the way to not have that bug is to have no way to
 * express it.
 *
 * Only finalized sales count. `voided` is the other status the schema allows,
 * and a voided sale is one that did not happen. Returns do not exist yet, so
 * nothing here pretends to net them off.
 */
export function createDashboardRepository(prisma: PrismaClient): DashboardRepository {
  return {
    async summary(scope: TenantScope, since: string): Promise<DashboardSummary> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const from = new Date(since);

        const [products, terminals, shifts, settings, totals] = await Promise.all([
          tx.product.count({ where: { tenantId: tenant, isActive: true } }),
          tx.terminal.count({ where: { tenantId: tenant, isActive: true } }),
          tx.shift.count({ where: { tenantId: tenant, status: 'open' } }),
          tx.tenantSettings.findFirst({ where: { tenantId: tenant } }),
          tx.sale.aggregate({
            where: { tenantId: tenant, status: 'finalized', issuedAt: { gte: from } },
            _count: { _all: true },
            // BigInt in, BigInt out. The sum never becomes a double on the way
            // through, which is the whole reason these columns are BIGINT.
            _sum: { totalMinor: true, vatMinor: true },
          }),
        ]);

        return {
          activeProductCount: products,
          terminalCount: terminals,
          openShiftCount: shifts,
          salesLast24HoursCount: totals._count._all,
          grossSalesLast24HoursMinor: (totals._sum.totalMinor ?? 0n).toString(),
          vatLast24HoursMinor: (totals._sum.vatMinor ?? 0n).toString(),
          currency: settings?.currency ?? 'SAR',
          since: from.toISOString(),
        };
      });
    },
  };
}
