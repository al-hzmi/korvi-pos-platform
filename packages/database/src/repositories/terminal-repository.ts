import { withTenant } from '../tenant-context.js';
import { isoOrNull, scoped, tenantParam } from './mapping.js';
import type { TenantScope, Terminal, TerminalRepository } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

interface TerminalRow {
  id: string;
  tenantId: string;
  branchId: string;
  code: string;
  label: string;
  isActive: boolean;
  lastSeenAt: Date | null;
}

function toDomain(scope: TenantScope, row: TerminalRow): Terminal {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    code: row.code,
    label: row.label,
    isActive: row.isActive,
    lastSeenAt: isoOrNull(row.lastSeenAt),
  };
}

export function createTerminalRepository(prisma: PrismaClient): TerminalRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<Terminal | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: TerminalRow | null = await tx.terminal.findFirst({
          where: { id, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findByCode(scope: TenantScope, code: string): Promise<Terminal | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: TerminalRow | null = await tx.terminal.findFirst({
          where: { code, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async listForBranch(scope: TenantScope, branchId: string): Promise<readonly Terminal[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: TerminalRow[] = await tx.terminal.findMany({
          where: { branchId, tenantId: tenantParam(scope) },
          orderBy: { code: 'asc' },
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },

    async markSeen(scope: TenantScope, id: string, at: string): Promise<void> {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        // updateMany, not update: `update` targets a primary key alone, which
        // would let a terminal id from another tenant be written to. The
        // tenant filter is only expressible on a many-update.
        await tx.terminal.updateMany({
          where: { id, tenantId: tenantParam(scope) },
          data: { lastSeenAt: new Date(at) },
        });
      });
    },
  };
}
