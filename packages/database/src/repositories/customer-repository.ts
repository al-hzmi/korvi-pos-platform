import { withTenant } from '../tenant-context.js';
import { scoped, tenantParam } from './mapping.js';
import type { CreateCustomerInput, Customer, CustomerRepository, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

interface CustomerRow {
  id: string;
  tenantId: string;
  nameAr: string;
  nameEn: string | null;
  phone: string | null;
  email: string | null;
  vatNumber: string | null;
  isActive: boolean;
}

function toDomain(scope: TenantScope, row: CustomerRow): Customer {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    phone: row.phone,
    email: row.email,
    vatNumber: row.vatNumber,
    isActive: row.isActive,
  };
}

export function createCustomerRepository(prisma: PrismaClient): CustomerRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<Customer | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: CustomerRow | null = await tx.customer.findFirst({
          where: { id, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findByPhone(scope: TenantScope, phone: string): Promise<Customer | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: CustomerRow | null = await tx.customer.findFirst({
          where: { phone, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async list(scope: TenantScope, limit: number): Promise<readonly Customer[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: CustomerRow[] = await tx.customer.findMany({
          where: { tenantId: tenantParam(scope) },
          orderBy: { nameAr: 'asc' },
          take: limit,
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },

    async create(scope: TenantScope, input: CreateCustomerInput): Promise<Customer> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        // tenantId comes from the scope, never from the input. A create that
        // accepted a tenant id in its payload would be a way to write a row
        // into somebody else's shop.
        const row: CustomerRow = await tx.customer.create({
          data: {
            id: input.id,
            tenantId: tenantParam(scope),
            nameAr: input.nameAr,
            nameEn: input.nameEn,
            phone: input.phone,
            email: input.email,
            vatNumber: input.vatNumber,
          },
        });
        return toDomain(scope, row);
      });
    },
  };
}
