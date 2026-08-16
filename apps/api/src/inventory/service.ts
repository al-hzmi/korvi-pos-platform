import { StockRequestError } from '@korvi/domain';
import {
  StockOperationRefusedError,
  listBalancePage,
  recordInventoryAdjustment,
  recordInventoryCount,
  recordInventoryTransfer,
} from '@korvi/database';
import { fingerprintAdjustment, fingerprintCount, fingerprintTransfer } from './fingerprint.js';
import type {
  AdjustmentRequest,
  AuthenticatedPrincipal,
  CountRequest,
  StockRequestRefusal,
  TransferRequest,
} from '@korvi/domain';
import type {
  AdjustmentResult,
  BalancePage,
  CountResult,
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

export type StockFailureReason = StockRequestRefusal | StockOperationRefusal;

export type StockResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | {
      readonly outcome: 'failure';
      readonly reason: StockFailureReason;
      readonly productId: string | null;
    };

export interface MerchantInventoryService {
  balances(
    principal: AuthenticatedPrincipal,
    query: { readonly branchId: string; readonly limit: number; readonly cursor: string | null },
  ): Promise<BalancePage>;
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
 * Turn the two deliberate refusal vocabularies into one result value.
 *
 * `StockRequestError` is a malformed request and `StockOperationRefusedError`
 * is a refusal decided under the row locks. Both are answers; anything else is
 * rethrown, because an unexpected failure must not be laundered into a tidy
 * "your request was invalid".
 */
async function attempt<T>(work: () => Promise<T>): Promise<StockResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof StockRequestError) {
      return { outcome: 'failure', reason: error.detail, productId: null };
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
    async balances(principal, query) {
      // The tenant is the session's. A branch id is a legitimate filter, and
      // under RLS one belonging to another merchant simply matches nothing.
      return listBalancePage(prisma, principal.tenantId, query.branchId, query.limit, query.cursor);
    },

    async adjust(principal, request) {
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
