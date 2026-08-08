import { withTenant } from '../tenant-context.js';
import { scoped, tenantParam } from './mapping.js';
import type { Branch, BranchRepository, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

interface BranchRow {
  id: string;
  tenantId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  isActive: boolean;
}

function toDomain(scope: TenantScope, row: BranchRow): Branch {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    isActive: row.isActive,
  };
}

export function createBranchRepository(prisma: PrismaClient): BranchRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<Branch | null> {
      // Both halves matter. `tenantId` in the filter is the application saying
      // what it means; RLS is Postgres enforcing it even when a future edit
      // forgets. Neither alone is a boundary.
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: BranchRow | null = await tx.branch.findFirst({
          where: { id, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async list(scope: TenantScope): Promise<readonly Branch[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: BranchRow[] = await tx.branch.findMany({
          where: { tenantId: tenantParam(scope) },
          orderBy: { code: 'asc' },
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },
  };
}
