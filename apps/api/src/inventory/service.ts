import {
  CostingCapacityError,
  CostingRequestError,
  StockRequestError,
  requirePrincipalPermission,
  tenantId as brandTenantId,
} from '@korvi/domain';
import {
  StockOperationRefusedError,
  listBalancePage,
  listCostBalancePage,
  listInventoryBranchPage,
  recordInventoryAdjustment,
  recordInventoryCostBootstrap,
  recordInventoryCount,
  recordInventoryTransfer,
} from '@korvi/database';
import {
  fingerprintAdjustment,
  fingerprintCostBootstrap,
  fingerprintCount,
  fingerprintTransfer,
} from './fingerprint.js';
import type {
  AdjustmentRequest,
  AuthenticatedPrincipal,
  CostBootstrapRequest,
  CostingRequestRefusal,
  CountRequest,
  StockRequestRefusal,
  TransferRequest,
} from '@korvi/domain';
import type {
  AdjustmentResult,
  BalancePage,
  CostBalancePage,
  CountResult,
  InventoryCostBootstrapResult,
  InventoryBranchPage,
  PrismaClient,
  StockOperationRefusal,
  TransferResult,
} from '@korvi/database';

/**
 * The merchant stock surface, as the API layer sees it.
 *
 * Every method takes the authenticated principal as its first argument and
 * derives the tenant and the actor from it. There is deliberately no parameter
 * on this interface into which a caller could thread a tenant id, a user id, a
 * resulting balance or a revision the server is supposed to compute — the
 * compiler enforces here what a handler would otherwise have to remember
 * (ADR-0024 §4).
 */

export type StockFailureReason =
  StockRequestRefusal | CostingRequestRefusal | StockOperationRefusal;

export type StockResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | {
      readonly outcome: 'failure';
      readonly reason: StockFailureReason;
      readonly productId: string | null;
    };

export interface MerchantInventoryService {
  branches(
    principal: AuthenticatedPrincipal,
    query: { readonly limit: number; readonly cursor: string | null },
  ): Promise<InventoryBranchPage>;
  balances(
    principal: AuthenticatedPrincipal,
    query: { readonly branchId: string; readonly limit: number; readonly cursor: string | null },
  ): Promise<BalancePage>;
  costBalances(
    principal: AuthenticatedPrincipal,
    query: { readonly branchId: string; readonly limit: number; readonly cursor: string | null },
  ): Promise<CostBalancePage>;
  bootstrapCost(
    principal: AuthenticatedPrincipal,
    request: CostBootstrapRequest,
  ): Promise<StockResult<InventoryCostBootstrapResult>>;
  adjust(
    principal: AuthenticatedPrincipal,
    request: AdjustmentRequest,
  ): Promise<StockResult<AdjustmentResult>>;
  count(
    principal: AuthenticatedPrincipal,
    request: CountRequest,
  ): Promise<StockResult<CountResult>>;
  transfer(
    principal: AuthenticatedPrincipal,
    request: TransferRequest,
  ): Promise<StockResult<TransferResult>>;
}

/**
 * Turn deliberate request, capacity and locked-operation refusals into one
 * result value.
 *
 * `StockRequestError` is a malformed request, `CostingCapacityError` means an
 * otherwise valid value cannot fit beside the locked aggregate, and
 * `StockOperationRefusedError` is another refusal decided under row locks.
 * All are answers; anything else is rethrown, because an unexpected failure
 * must not be laundered into a tidy "your request was invalid".
 */
async function attempt<T>(work: () => Promise<T>): Promise<StockResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof StockRequestError || error instanceof CostingRequestError) {
      return { outcome: 'failure', reason: error.detail, productId: null };
    }
    if (error instanceof CostingCapacityError) {
      return { outcome: 'failure', reason: 'invalid-money', productId: null };
    }
    if (error instanceof StockOperationRefusedError) {
      return { outcome: 'failure', reason: error.detail, productId: error.productId };
    }
    throw error;
  }
}

export function createMerchantInventoryService(deps: {
  readonly prisma: PrismaClient;
}): MerchantInventoryService {
  const { prisma } = deps;

  return {
    async branches(principal, query) {
      requirePrincipalPermission(principal, 'inventory.read');
      return listInventoryBranchPage(
        prisma,
        { tenantId: brandTenantId(principal.tenantId) },
        query.limit,
        query.cursor,
      );
    },

    async balances(principal, query) {
      requirePrincipalPermission(principal, 'inventory.read');
      // The tenant is the session's. A branch id is a legitimate filter, and
      // under RLS one belonging to another merchant simply matches nothing.
      return listBalancePage(prisma, principal.tenantId, query.branchId, query.limit, query.cursor);
    },

    async costBalances(principal, query) {
      // Cost visibility is independent of ordinary stock visibility. Repeating
      // the check here prevents an internal caller from turning a route-only
      // guard into accidental margin disclosure.
      requirePrincipalPermission(principal, 'inventory.cost.read');
      return listCostBalancePage(
        prisma,
        principal.tenantId,
        query.branchId,
        query.limit,
        query.cursor,
      );
    },

    async bootstrapCost(principal, request) {
      // Defense in depth: internal callers cannot bypass the route's permission.
      requirePrincipalPermission(principal, 'inventory.cost.manage');
      return attempt(() =>
        recordInventoryCostBootstrap(
          prisma,
          { tenantId: principal.tenantId, userId: principal.userId },
          request,
          fingerprintCostBootstrap(request, principal.userId),
        ),
      );
    },

    async adjust(principal, request) {
      // A future internal caller must not be able to bypass the HTTP guard and
      // write stock merely because it can obtain the service object.
      requirePrincipalPermission(principal, 'inventory.adjust');
      return attempt(() =>
        recordInventoryAdjustment(
          prisma,
          { tenantId: principal.tenantId, userId: principal.userId },
          request,
          fingerprintAdjustment(request, principal.userId),
        ),
      );
    },

    async count(principal, request) {
      requirePrincipalPermission(principal, 'inventory.adjust');
      return attempt(() =>
        recordInventoryCount(
          prisma,
          { tenantId: principal.tenantId, userId: principal.userId },
          request,
          fingerprintCount(request, principal.userId),
        ),
      );
    },

    async transfer(principal, request) {
      requirePrincipalPermission(principal, 'inventory.transfer');
      return attempt(() =>
        recordInventoryTransfer(
          prisma,
          { tenantId: principal.tenantId, userId: principal.userId },
          request,
          fingerprintTransfer(request, principal.userId),
        ),
      );
    },
  };
}
