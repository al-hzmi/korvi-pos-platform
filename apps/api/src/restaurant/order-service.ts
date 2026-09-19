import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import {
  RestaurantOrderRefusedError,
  cancelRestaurantOrder,
  createRestaurantOrder,
  listOpenRestaurantOrders,
  readRestaurantOrder,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';
import type {
  PrismaClient,
  RestaurantOrderCancelRequest,
  RestaurantOrderCreateRequest,
  RestaurantOrderDetail,
  RestaurantOrderMutationResult,
  RestaurantOrderRefusal,
  RestaurantOrderSummary,
} from '@korvi/database';

export type RestaurantOrderCommandResult =
  | { readonly outcome: 'success'; readonly value: RestaurantOrderMutationResult }
  | { readonly outcome: 'failure'; readonly reason: RestaurantOrderRefusal };

export interface MerchantRestaurantOrderService {
  listOpen(principal: AuthenticatedPrincipal): Promise<readonly RestaurantOrderSummary[]>;
  detail(principal: AuthenticatedPrincipal, orderId: string): Promise<RestaurantOrderDetail | null>;
  create(
    principal: AuthenticatedPrincipal,
    request: RestaurantOrderCreateRequest,
  ): Promise<RestaurantOrderCommandResult>;
  cancel(
    principal: AuthenticatedPrincipal,
    orderId: string,
    request: RestaurantOrderCancelRequest,
  ): Promise<RestaurantOrderCommandResult>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

function branchOf(principal: AuthenticatedPrincipal): string {
  if (principal.branchId === null) throw new RestaurantOrderRefusedError('branch-required');
  return principal.branchId;
}

function actorOf(principal: AuthenticatedPrincipal) {
  return {
    userId: principal.userId,
    branchId: branchOf(principal),
    boundTerminalId: principal.terminalId ?? null,
  };
}

async function attempt(
  work: () => Promise<RestaurantOrderMutationResult>,
): Promise<RestaurantOrderCommandResult> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof RestaurantOrderRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantRestaurantOrderService(
  prisma: PrismaClient,
): MerchantRestaurantOrderService {
  return {
    async listOpen(principal) {
      requirePrincipalPermission(principal, 'sale.create');
      return listOpenRestaurantOrders(prisma, scopeOf(principal), branchOf(principal));
    },

    async detail(principal, orderId) {
      requirePrincipalPermission(principal, 'sale.create');
      return readRestaurantOrder(prisma, scopeOf(principal), branchOf(principal), orderId);
    },

    async create(principal, request) {
      requirePrincipalPermission(principal, 'sale.create');
      return attempt(() =>
        createRestaurantOrder(prisma, scopeOf(principal), actorOf(principal), request),
      );
    },

    async cancel(principal, orderId, request) {
      requirePrincipalPermission(principal, 'sale.void');
      return attempt(() =>
        cancelRestaurantOrder(prisma, scopeOf(principal), actorOf(principal), orderId, request),
      );
    },
  };
}
