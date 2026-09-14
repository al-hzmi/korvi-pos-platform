import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import {
  CustomerAdminRefusedError,
  createMerchantCustomer,
  listMerchantCustomers,
  readMerchantCustomer,
  updateMerchantCustomer,
} from '@korvi/database/customers';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';
import type {
  CustomerAdminRefusal,
  CustomerCreateRequest,
  CustomerDetail,
  CustomerListQuery,
  CustomerMutationResult,
  CustomerPage,
  CustomerUpdateRequest,
} from '@korvi/database/customers';
import type { PrismaClient } from '@korvi/database';

export type CustomerCommandResult =
  | { readonly outcome: 'success'; readonly value: CustomerMutationResult }
  | { readonly outcome: 'failure'; readonly reason: CustomerAdminRefusal };

export interface MerchantCustomerService {
  list(principal: AuthenticatedPrincipal, query: CustomerListQuery): Promise<CustomerPage>;
  detail(principal: AuthenticatedPrincipal, customerId: string): Promise<CustomerDetail | null>;
  create(
    principal: AuthenticatedPrincipal,
    request: CustomerCreateRequest,
  ): Promise<CustomerCommandResult>;
  update(
    principal: AuthenticatedPrincipal,
    customerId: string,
    request: CustomerUpdateRequest,
  ): Promise<CustomerCommandResult>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

async function attempt(
  work: () => Promise<CustomerMutationResult>,
): Promise<CustomerCommandResult> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof CustomerAdminRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantCustomerService(prisma: PrismaClient): MerchantCustomerService {
  return {
    async list(principal, query) {
      requirePrincipalPermission(principal, 'customer.read');
      return listMerchantCustomers(prisma, scopeOf(principal), query);
    },

    async detail(principal, customerId) {
      requirePrincipalPermission(principal, 'customer.read');
      return readMerchantCustomer(prisma, scopeOf(principal), customerId);
    },

    async create(principal, request) {
      requirePrincipalPermission(principal, 'customer.write');
      return attempt(() =>
        createMerchantCustomer(prisma, scopeOf(principal), { userId: principal.userId }, request),
      );
    },

    async update(principal, customerId, request) {
      requirePrincipalPermission(principal, 'customer.write');
      return attempt(() =>
        updateMerchantCustomer(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          customerId,
          request,
        ),
      );
    },
  };
}
