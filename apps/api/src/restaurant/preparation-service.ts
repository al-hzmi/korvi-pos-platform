import {
  RestaurantPreparationRefusedError,
  createPreparationStation,
  fireRestaurantOrderForPreparation,
  listPreparationRoutes,
  listPreparationStations,
  listPreparationTasks,
  routeRestaurantOrderForPreparation,
  setProductPreparationRoutes,
  updatePreparationTaskStatus,
} from '@korvi/database';
import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import type {
  CreatePreparationStationRequest,
  FirePreparationRequest,
  PreparationFireResult,
  PreparationMutationResult,
  PreparationRoute,
  PreparationRoutingPlan,
  PreparationStation,
  PreparationTask,
  RestaurantPreparationRefusal,
  SetProductPreparationRoutesRequest,
  UpdatePreparationTaskStatusRequest,
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
  fire(
    principal: AuthenticatedPrincipal,
    orderId: string,
    request: FirePreparationRequest,
  ): Promise<PreparationServiceResult<PreparationMutationResult<PreparationFireResult>>>;
  tasks(
    principal: AuthenticatedPrincipal,
    stationId: string,
    includeServed: boolean,
  ): Promise<PreparationServiceResult<readonly PreparationTask[]>>;
  updateTask(
    principal: AuthenticatedPrincipal,
    taskId: string,
    request: UpdatePreparationTaskStatusRequest,
  ): Promise<PreparationServiceResult<PreparationMutationResult<PreparationTask>>>;
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
      requirePrincipalPermission(principal, 'settings.manage');
      return attempt(() =>
        listPreparationStations(prisma, scopeOf(principal), branchId, activeOnly),
      );
    },
    async createStation(principal, request) {
      requirePrincipalPermission(principal, 'settings.manage');
      return attempt(() =>
        createPreparationStation(prisma, scopeOf(principal), { userId: principal.userId }, request),
      );
    },
    async listRoutes(principal, branchId) {
      requirePrincipalPermission(principal, 'settings.manage');
      return attempt(() => listPreparationRoutes(prisma, scopeOf(principal), branchId));
    },
    async setProductRoutes(principal, request) {
      requirePrincipalPermission(principal, 'settings.manage');
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
      requirePrincipalPermission(principal, 'sale.create');
      const branchId = principal.branchId;
      if (branchId === null) {
        return { outcome: 'failure', reason: 'unknown-branch' };
      }
      return attempt(() =>
        routeRestaurantOrderForPreparation(prisma, scopeOf(principal), branchId, orderId),
      );
    },
    async fire(principal, orderId, request) {
      requirePrincipalPermission(principal, 'sale.create');
      const branchId = principal.branchId;
      if (branchId === null) return { outcome: 'failure', reason: 'unknown-branch' };
      return attempt(() =>
        fireRestaurantOrderForPreparation(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          branchId,
          orderId,
          request,
        ),
      );
    },
    async tasks(principal, stationId, includeServed) {
      requirePrincipalPermission(principal, 'sale.create');
      const branchId = principal.branchId;
      if (branchId === null) return { outcome: 'failure', reason: 'unknown-branch' };
      return attempt(() =>
        listPreparationTasks(prisma, scopeOf(principal), branchId, stationId, includeServed),
      );
    },
    async updateTask(principal, taskId, request) {
      requirePrincipalPermission(principal, 'sale.create');
      const branchId = principal.branchId;
      if (branchId === null) return { outcome: 'failure', reason: 'unknown-branch' };
      return attempt(() =>
        updatePreparationTaskStatus(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          branchId,
          taskId,
          request,
        ),
      );
    },
  };
}
