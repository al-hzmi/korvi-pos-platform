import { PurchasingRequestError } from '@korvi/domain';
import {
  PurchasingRefusedError,
  createPurchaseOrder,
  createSupplier,
  getPurchaseOrder,
  getSupplier,
  listPurchaseOrders,
  listPurchaseReceipts,
  listSuppliers,
  recordPurchaseReceipt,
  updateSupplier,
} from '@korvi/database';
import {
  fingerprintPurchaseOrder,
  fingerprintPurchaseReceipt,
  fingerprintSupplierCreate,
  fingerprintSupplierUpdate,
} from './fingerprint.js';
import type {
  AuthenticatedPrincipal,
  PurchaseOrderRequest,
  PurchaseOrderStatus,
  PurchaseReceiptRequest,
  PurchasingRequestRefusal,
  SupplierCreateRequest,
  SupplierUpdateRequest,
} from '@korvi/domain';
import type {
  PrismaClient,
  PurchaseOrderPage,
  PurchaseOrderRecord,
  PurchaseOrderResult,
  PurchaseReceiptResult,
  PurchaseReceiptSummary,
  PurchasingRefusal,
  SupplierPage,
  SupplierRecord,
  SupplierResult,
} from '@korvi/database';

/**
 * The purchasing surface, as the API layer sees it.
 *
 * Every method takes the authenticated principal as its first argument and
 * derives the tenant and the actor from it. There is deliberately no parameter
 * on this interface into which a caller could thread a tenant id, a user id, a
 * received quantity, a purchase-order status or a resulting balance — the
 * compiler enforces here what a handler would otherwise have to remember
 * (ADR-0024 §4).
 */

export type PurchasingFailureReason = PurchasingRequestRefusal | PurchasingRefusal;

export type PurchasingResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | {
      readonly outcome: 'failure';
      readonly reason: PurchasingFailureReason;
      readonly subjectId: string | null;
    };

export interface SupplierQuery {
  readonly limit: number;
  readonly cursor: string | null;
  readonly activeOnly: boolean;
}

export interface PurchaseOrderQuery {
  readonly limit: number;
  readonly cursor: string | null;
  readonly status: PurchaseOrderStatus | null;
  readonly supplierId: string | null;
  readonly branchId: string | null;
}

export interface MerchantPurchasingService {
  listSuppliers(principal: AuthenticatedPrincipal, query: SupplierQuery): Promise<SupplierPage>;
  getSupplier(
    principal: AuthenticatedPrincipal,
    supplierId: string,
  ): Promise<SupplierRecord | null>;
  createSupplier(
    principal: AuthenticatedPrincipal,
    request: SupplierCreateRequest,
  ): Promise<PurchasingResult<SupplierResult>>;
  updateSupplier(
    principal: AuthenticatedPrincipal,
    request: SupplierUpdateRequest,
  ): Promise<PurchasingResult<SupplierResult>>;

  listPurchaseOrders(
    principal: AuthenticatedPrincipal,
    query: PurchaseOrderQuery,
  ): Promise<PurchaseOrderPage>;
  getPurchaseOrder(
    principal: AuthenticatedPrincipal,
    purchaseOrderId: string,
  ): Promise<PurchaseOrderRecord | null>;
  createPurchaseOrder(
    principal: AuthenticatedPrincipal,
    request: PurchaseOrderRequest,
  ): Promise<PurchasingResult<PurchaseOrderResult>>;

  listReceipts(
    principal: AuthenticatedPrincipal,
    purchaseOrderId: string,
    limit: number,
  ): Promise<readonly PurchaseReceiptSummary[]>;
  receive(
    principal: AuthenticatedPrincipal,
    request: PurchaseReceiptRequest,
  ): Promise<PurchasingResult<PurchaseReceiptResult>>;
}

/**
 * Turn the two deliberate refusal vocabularies into one result value.
 *
 * `PurchasingRequestError` is a malformed request, decided before anything is
 * locked; `PurchasingRefusedError` is a refusal decided under the row locks.
 * Both are answers. Anything else is rethrown, because an unexpected failure
 * must not be laundered into a tidy "your request was invalid" — that is how a
 * database outage gets reported to a merchant as a typo.
 */
async function attempt<T>(work: () => Promise<T>): Promise<PurchasingResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof PurchasingRequestError) {
      return { outcome: 'failure', reason: error.detail, subjectId: null };
    }
    if (error instanceof PurchasingRefusedError) {
      return { outcome: 'failure', reason: error.detail, subjectId: error.subjectId };
    }
    throw error;
  }
}

export function createMerchantPurchasingService(deps: {
  readonly prisma: PrismaClient;
}): MerchantPurchasingService {
  const { prisma } = deps;

  return {
    async listSuppliers(principal, query) {
      // The tenant is the session's, always. Under RLS a filter is a filter
      // and never a way to reach another merchant's list.
      return listSuppliers(prisma, principal.tenantId, query);
    },

    async getSupplier(principal, supplierId) {
      return getSupplier(prisma, principal.tenantId, supplierId);
    },

    async createSupplier(principal, request) {
      return attempt(() =>
        createSupplier(
          prisma,
          { tenantId: principal.tenantId, userId: principal.userId },
          request,
          fingerprintSupplierCreate(request, principal.userId),
        ),
      );
    },

    async updateSupplier(principal, request) {
      return attempt(() =>
        updateSupplier(
          prisma,
          { tenantId: principal.tenantId, userId: principal.userId },
          request,
          fingerprintSupplierUpdate(request, principal.userId),
        ),
      );
    },

    async listPurchaseOrders(principal, query) {
      return listPurchaseOrders(prisma, principal.tenantId, query);
    },

    async getPurchaseOrder(principal, purchaseOrderId) {
      return getPurchaseOrder(prisma, principal.tenantId, purchaseOrderId);
    },

    async createPurchaseOrder(principal, request) {
      return attempt(() =>
        createPurchaseOrder(
          prisma,
          { tenantId: principal.tenantId, userId: principal.userId },
          request,
          fingerprintPurchaseOrder(request, principal.userId),
        ),
      );
    },

    async listReceipts(principal, purchaseOrderId, limit) {
      return listPurchaseReceipts(prisma, principal.tenantId, purchaseOrderId, limit);
    },

    async receive(principal, request) {
      return attempt(() =>
        recordPurchaseReceipt(
          prisma,
          { tenantId: principal.tenantId, userId: principal.userId },
          request,
          fingerprintPurchaseReceipt(request, principal.userId),
        ),
      );
    },
  };
}
