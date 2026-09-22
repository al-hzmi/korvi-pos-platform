import { withTenant } from '../tenant-context.js';
import { scoped, tenantParam } from './mapping.js';
import type {
  RestaurantFloorRepository,
  RestaurantTable,
  RestaurantZone,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

interface ZoneRow {
  id: string;
  tenantId: string;
  branchId: string;
  nameAr: string;
  sortOrder: number;
  isActive: boolean;
}

interface TableRow {
  id: string;
  tenantId: string;
  branchId: string;
  zoneId: string;
  code: string;
  nameAr: string;
  capacity: number | null;
  isActive: boolean;
}

function zoneToDomain(scope: TenantScope, row: ZoneRow): RestaurantZone {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    nameAr: row.nameAr,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

function tableToDomain(scope: TenantScope, row: TableRow): RestaurantTable {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    zoneId: row.zoneId,
    code: row.code,
    nameAr: row.nameAr,
    capacity: row.capacity,
    isActive: row.isActive,
  };
}

export function createRestaurantFloorRepository(prisma: PrismaClient): RestaurantFloorRepository {
  return {
    async findTableById(scope, id) {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: TableRow | null = await tx.restaurantTable.findFirst({
          where: { id, tenantId: tenantParam(scope) },
        });
        return row === null ? null : tableToDomain(scope, row);
      });
    },

    async listZonesForBranch(scope, branchId, activeOnly) {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: ZoneRow[] = await tx.restaurantZone.findMany({
          where: {
            tenantId: tenantParam(scope),
            branchId,
            ...(activeOnly ? { isActive: true } : {}),
          },
          orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }, { id: 'asc' }],
        });
        return rows.map((row) => zoneToDomain(scope, row));
      });
    },

    async listTablesForBranch(scope, branchId, activeOnly) {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: TableRow[] = await tx.restaurantTable.findMany({
          where: {
            tenantId: tenantParam(scope),
            branchId,
            ...(activeOnly ? { isActive: true } : {}),
          },
          orderBy: [{ zoneId: 'asc' }, { code: 'asc' }, { id: 'asc' }],
        });
        return rows.map((row) => tableToDomain(scope, row));
      });
    },
  };
}
