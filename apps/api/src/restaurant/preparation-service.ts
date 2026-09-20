import {
  RestaurantPreparationRefusedError,
  createPreparationStation,
  listPreparationRoutes,
  listPreparationStations,
  routeRestaurantOrderForPreparation,
  setProductPreparationRoutes,
} from '@korvi/database';
import { brandTenantId, requirePermission } from '@korvi/domain';
import type {
  CreatePreparationStationRequest,
  PreparationMutationResult,
  PreparationRoute,
  PreparationRoutingPlan,
  PreparationStation,
  RestaurantPreparationRefusal,
  SetProductPreparationRoutesRequest,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '@korvi/database';

export type PreparationServiceResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: RestaurantPreparationRefusal };

export interface MerchantPreparationService {
  listStations(
    principal: AuthenticatedPrincipal,
    branchId: string,
    activeOnly: boolean,
  ): Promise<PreparationServiceResult<readonly PreparationStation[]>>;
  createStation(
    principal: AuthenticatedPrincipal,
    request: CreatePreparationStationRequest,
  ): Promise<PreparationServiceResult<PreparationMutationResult<PreparationStation>>>;
  listRoutes(
    principal: AuthenticatedPrincipal,
    branchId: string,
  ): Promise<PreparationServiceResult<readonly PreparationRoute[]>>;
  setProductRoutes(
    principal: AuthenticatedPrincipal,
    request: SetProductPreparationRoutesRequest,
  ): Promise<PreparationServiceResult<PreparationMutationResult<readonly PreparationRoute[]>>>;
  routing(
    principal: AuthenticatedPrincipal,
    orderId: string,
  ): Promise<PreparationServiceResult<PreparationRoutingPlan | null>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

async function attempt<T>(work: () => Promise<T>): Promise<PreparationServiceResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof RestaurantPreparationRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantPreparationService(prisma: PrismaClient): MerchantPreparationService {
  return {
    async listStations(principal, branchId, activeOnly) {
      requirePermission(principal, 'settings.manage');
      return attempt(() =>
        listPreparationStations(prisma, scopeOf(principal), branchId, activeOnly),
      );
    },
    async createStation(principal, request) {
      requirePermission(principal, 'settings.manage');
      return attempt(() =>
        createPreparationStation(prisma, scopeOf(principal), { userId: principal.userId }, request),
      );
    },
    async listRoutes(principal, branchId) {
      requirePermission(principal, 'settings.manage');
      return attempt(() => listPreparationRoutes(prisma, scopeOf(principal), branchId));
    },
    async setProductRoutes(principal, request) {
      requirePermission(principal, 'settings.manage');
      return attempt(() =>
        setProductPreparationRoutes(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          request,
        ),
      );
    },
    async routing(principal, orderId) {
      requirePermission(principal, 'sale.create');
      if (principal.branchId === null) {
        return { outcome: 'failure', reason: 'unknown-branch' };
      }
      return attempt(() =>
        routeRestaurantOrderForPreparation(
          prisma,
          scopeOf(principal),
          principal.branchId!,
          orderId,
        ),
      );
    },
  };
}
