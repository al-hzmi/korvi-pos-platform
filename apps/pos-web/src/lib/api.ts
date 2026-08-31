import type {
  AdminAccessChange,
  AdminBranch,
  AdminMember,
  AdminPage,
  AdminProductBootstrap,
  AdminProductCreateInput,
  AdminRole,
  AdminRoleAssignmentResult,
  AdminSettingsPatch,
  AdminTenantSettings,
  AdminTerminal,
  CheckoutRequest,
  DashboardSummary,
  CheckoutResponse,
  InventoryBalancePage,
  InventoryAdjustmentRequest,
  InventoryAdjustmentResult,
  InventoryBranchPage,
  InventoryCostBalancePage,
  InventoryCostBootstrapRequest,
  InventoryCostBootstrapResult,
  InventoryCountRequest,
  InventoryCountResult,
  InventoryTransferRequest,
  InventoryTransferResult,
  OnboardingReadiness,
  Principal,
  PurchaseOrder,
  PurchaseOrderCreateRequest,
  PurchaseOrderCreateResult,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  PurchaseReceiptCreateRequest,
  PurchaseReceiptResult,
  PurchaseReceiptSummary,
  ProductSummary,
  PurchasingBranch,
  PurchasingPage,
  PurchasingProduct,
  PurchasingSupplier,
  ShiftSummary,
  SupplierCreateRequest,
  SupplierMutationResult,
  SupplierUpdateRequest,
  TerminalsResponse,
} from './api-types';

/**
 * The browser's only door to the server.
 *
 * One place that knows about JSON, cookies, aborts and what an HTTP failure
 * means, so no component ever writes fetch('/v1/...') and no component ever
 * has to remember `credentials`.
 *
 * Requests go to this app's own origin and Next forwards them (ADR-0014).
 * There is no base URL to configure and no token to attach: the session is an
 * HttpOnly cookie the browser manages and JavaScript cannot read. If you find
 * yourself wanting a token here, the design has gone wrong.
 */

/**
 * How long a checkout may go unanswered before the till stops waiting.
 *
 * The server holds a branch row lock for the length of the sale transaction,
 * so a checkout behind a queue of tills legitimately takes longer than a
 * search. Twenty seconds is well past any healthy checkout and well short of a
 * cashier deciding the machine is broken.
 *
 * What matters more than the number: a timeout here is NOT a cancellation. The
 * request may have committed. It is reported as ambiguous, keeps its operation
 * id, and is retried unchanged (ADR-0013).
 */
export const CHECKOUT_TIMEOUT_MS = 20_000;
export const INVENTORY_COMMAND_TIMEOUT_MS = 20_000;
export const PURCHASING_COMMAND_TIMEOUT_MS = 20_000;

export type ApiFailureKind = 'network' | 'http';

export class ApiError extends Error {
  public override readonly name = 'ApiError';
  /** 0 when the request never got an answer — a timeout, a dropped link, a stopped server. */
  public readonly status: number;
  /** The server's own `error` code where there is one; otherwise a local label. */
  public readonly code: string;
  public readonly serverMessage: string | null;

  public constructor(status: number, code: string, serverMessage: string | null) {
    super(`${code} (${String(status)})`);
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
  }

  /** True when the request may or may not have been carried out. */
  public get ambiguous(): boolean {
    return this.status === 0;
  }

  public get unauthenticated(): boolean {
    return this.status === 401;
  }

  public get forbidden(): boolean {
    return this.status === 403;
  }
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  me(options?: RequestOptions): Promise<Principal>;
  login(input: {
    readonly tenantSlug: string;
    readonly email: string;
    readonly password: string;
  }): Promise<Principal>;
  logout(): Promise<void>;
  terminals(options?: RequestOptions): Promise<TerminalsResponse>;
  dashboardSummary(options?: RequestOptions): Promise<DashboardSummary>;
  products(
    query: { readonly q?: string; readonly limit?: number },
    options?: RequestOptions,
  ): Promise<readonly ProductSummary[]>;
  currentShift(terminalId: string, options?: RequestOptions): Promise<ShiftSummary | null>;
  openShift(input: {
    readonly terminalId: string;
    readonly openingFloatMinor: string;
  }): Promise<ShiftSummary>;
  checkout(request: CheckoutRequest): Promise<CheckoutResponse>;

  onboardingReadiness(options?: RequestOptions): Promise<OnboardingReadiness>;
  inventoryBranches(
    query?: { readonly limit?: number; readonly cursor?: string },
    options?: RequestOptions,
  ): Promise<InventoryBranchPage>;
  inventoryBalances(
    query: { readonly branchId: string; readonly limit?: number; readonly cursor?: string },
    options?: RequestOptions,
  ): Promise<InventoryBalancePage>;
  inventoryCostBalances(
    query: { readonly branchId: string; readonly limit?: number; readonly cursor?: string },
    options?: RequestOptions,
  ): Promise<InventoryCostBalancePage>;
  inventoryCostBootstrap(
    request: InventoryCostBootstrapRequest,
  ): Promise<InventoryCostBootstrapResult>;
  inventoryAdjust(request: InventoryAdjustmentRequest): Promise<InventoryAdjustmentResult>;
  inventoryCount(request: InventoryCountRequest): Promise<InventoryCountResult>;
  inventoryTransfer(request: InventoryTransferRequest): Promise<InventoryTransferResult>;
  purchasingBranches(
    query?: { readonly limit?: number; readonly cursor?: string },
    options?: RequestOptions,
  ): Promise<PurchasingPage<PurchasingBranch>>;
  purchasingProducts(
    query?: { readonly limit?: number; readonly cursor?: string },
    options?: RequestOptions,
  ): Promise<PurchasingPage<PurchasingProduct>>;
  purchasingSuppliers(
    query?: { readonly limit?: number; readonly cursor?: string; readonly activeOnly?: boolean },
    options?: RequestOptions,
  ): Promise<PurchasingPage<PurchasingSupplier>>;
  purchasingOrders(
    query?: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly status?: PurchaseOrderStatus;
      readonly supplierId?: string;
      readonly branchId?: string;
    },
    options?: RequestOptions,
  ): Promise<PurchasingPage<PurchaseOrderSummary>>;
  purchasingOrder(purchaseOrderId: string, options?: RequestOptions): Promise<PurchaseOrder>;
  purchasingReceipts(
    purchaseOrderId: string,
    options?: RequestOptions,
  ): Promise<readonly PurchaseReceiptSummary[]>;
  createPurchasingSupplier(request: SupplierCreateRequest): Promise<SupplierMutationResult>;
  updatePurchasingSupplier(request: SupplierUpdateRequest): Promise<SupplierMutationResult>;
  createPurchaseOrder(request: PurchaseOrderCreateRequest): Promise<PurchaseOrderCreateResult>;
  receivePurchaseOrder(request: PurchaseReceiptCreateRequest): Promise<PurchaseReceiptResult>;
  createAdminProduct(input: AdminProductCreateInput): Promise<AdminProductBootstrap>;
  adminSettings(options?: RequestOptions): Promise<AdminTenantSettings>;
  updateAdminSettings(patch: AdminSettingsPatch): Promise<AdminTenantSettings>;
  adminBranches(
    query?: { readonly limit?: number; readonly cursor?: string },
    options?: RequestOptions,
  ): Promise<AdminPage<AdminBranch>>;
  createAdminBranch(input: {
    readonly code: string;
    readonly nameAr: string;
    readonly nameEn?: string | null;
  }): Promise<AdminBranch>;
  updateAdminBranch(
    branchId: string,
    patch: { readonly nameAr?: string; readonly nameEn?: string | null },
  ): Promise<AdminBranch>;
  setAdminBranchActive(branchId: string, isActive: boolean): Promise<AdminBranch>;
  adminTerminals(
    query?: { readonly limit?: number; readonly branchId?: string; readonly cursor?: string },
    options?: RequestOptions,
  ): Promise<AdminPage<AdminTerminal>>;
  createAdminTerminal(input: {
    readonly branchId: string;
    readonly code: string;
    readonly label: string;
  }): Promise<AdminTerminal>;
  updateAdminTerminal(terminalId: string, label: string): Promise<AdminTerminal>;
  setAdminTerminalActive(terminalId: string, isActive: boolean): Promise<AdminTerminal>;

  adminMembers(
    query?: { readonly limit?: number; readonly cursor?: string },
    options?: RequestOptions,
  ): Promise<AdminPage<AdminMember>>;
  createAdminMember(input: {
    readonly email: string;
    readonly displayName: string;
    readonly defaultBranchId?: string | null;
  }): Promise<AdminMember>;
  updateAdminMember(
    userId: string,
    patch: { readonly displayName?: string; readonly defaultBranchId?: string | null },
  ): Promise<AdminMember>;
  setAdminMemberUserActive(userId: string, isActive: boolean): Promise<AdminAccessChange>;
  setAdminMemberMembershipActive(userId: string, isActive: boolean): Promise<AdminAccessChange>;
  adminRoles(options?: RequestOptions): Promise<readonly AdminRole[]>;
  assignAdminRole(userId: string, roleId: string): Promise<AdminRoleAssignmentResult>;
  removeAdminRole(userId: string, roleId: string): Promise<AdminRoleAssignmentResult>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function readErrorCode(body: unknown, status: number): { code: string; message: string | null } {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = typeof record['error'] === 'string' ? record['error'] : `http_${String(status)}`;
    const message = typeof record['message'] === 'string' ? record['message'] : null;
    return { code, message };
  }
  return { code: `http_${String(status)}`, message: null };
}

function listQuery(input: {
  readonly limit?: number;
  readonly cursor?: string;
  readonly branchId?: string;
  readonly supplierId?: string;
  readonly status?: string;
  readonly activeOnly?: boolean;
}): string {
  const search = new URLSearchParams();
  if (input.limit !== undefined) search.set('limit', String(input.limit));
  if (input.cursor !== undefined && input.cursor !== '') search.set('cursor', input.cursor);
  if (input.branchId !== undefined && input.branchId !== '') search.set('branchId', input.branchId);
  if (input.supplierId !== undefined && input.supplierId !== '')
    search.set('supplierId', input.supplierId);
  if (input.status !== undefined && input.status !== '') search.set('status', input.status);
  if (input.activeOnly !== undefined) search.set('activeOnly', String(input.activeOnly));
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export function createApiClient(fetchImpl?: Fetch): ApiClient {
  const call = async (
    path: string,
    init: RequestInit,
    options?: RequestOptions,
  ): Promise<unknown> => {
    const doFetch: Fetch =
      fetchImpl ?? ((input, requestInit) => globalThis.fetch(input, requestInit));

    let response: Response;
    try {
      response = await doFetch(path, {
        ...init,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'network', null);
    }

    if (response.status === 204) return null;

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const { code, message } = readErrorCode(body, response.status);
      throw new ApiError(response.status, code, message);
    }
    return body;
  };

  const json = (payload: unknown, method: 'POST' | 'PATCH' = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const retryableCommand = async <T>(
    path: string,
    payload: unknown,
    timeoutMs: number,
    method: 'POST' | 'PATCH' = 'POST',
  ): Promise<T> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      return (await call(path, json(payload, method), { signal: controller.signal })) as T;
    } catch (error) {
      if (timedOut) throw new ApiError(0, 'timeout', null);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async me(options) {
      return (await call('/v1/auth/me', { method: 'GET' }, options)) as Principal;
    },

    async login(input) {
      return (await call(
        '/v1/auth/login',
        json({ tenantSlug: input.tenantSlug, email: input.email, password: input.password }),
      )) as Principal;
    },

    async logout() {
      await call('/v1/auth/logout', { method: 'POST' });
    },

    async terminals(options) {
      return (await call('/v1/terminals', { method: 'GET' }, options)) as TerminalsResponse;
    },

    async dashboardSummary(options) {
      return (await call('/v1/dashboard/summary', { method: 'GET' }, options)) as DashboardSummary;
    },

    async products(query, options) {
      const search = new URLSearchParams();
      if (query.q !== undefined && query.q !== '') search.set('q', query.q);
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      const suffix = search.toString();
      const body = (await call(
        `/v1/products${suffix === '' ? '' : `?${suffix}`}`,
        { method: 'GET' },
        options,
      )) as { products: readonly ProductSummary[] };
      return body.products;
    },

    async currentShift(terminalId, options) {
      const body = (await call(
        `/v1/shifts/current?terminalId=${encodeURIComponent(terminalId)}`,
        { method: 'GET' },
        options,
      )) as { shift: ShiftSummary | null };
      return body.shift;
    },

    async openShift(input) {
      const body = (await call(
        '/v1/shifts/open',
        json({ terminalId: input.terminalId, openingFloatMinor: input.openingFloatMinor }),
      )) as { shift: ShiftSummary };
      return body.shift;
    },

    async checkout(request) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, CHECKOUT_TIMEOUT_MS);

      try {
        return (await call(
          '/v1/sales',
          json({
            operationId: request.operationId,
            terminalId: request.terminalId,
            cashReceivedMinor: request.cashReceivedMinor,
            lines: request.lines.map((line) => ({
              productId: line.productId,
              quantityScaled: line.quantityScaled,
            })),
          }),
          { signal: controller.signal },
        )) as CheckoutResponse;
      } catch (error) {
        if (timedOut) throw new ApiError(0, 'timeout', null);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },

    async onboardingReadiness(options) {
      return (await call(
        '/v1/admin/onboarding/readiness',
        { method: 'GET' },
        options,
      )) as OnboardingReadiness;
    },

    async inventoryBranches(query = {}, options) {
      return (await call(
        `/v1/admin/inventory/branches${listQuery(query)}`,
        { method: 'GET' },
        options,
      )) as InventoryBranchPage;
    },

    async inventoryBalances(query, options) {
      return (await call(
        `/v1/admin/inventory/balances${listQuery(query)}`,
        { method: 'GET' },
        options,
      )) as InventoryBalancePage;
    },

    async inventoryCostBalances(query, options) {
      return (await call(
        `/v1/admin/inventory/cost-balances${listQuery(query)}`,
        { method: 'GET' },
        options,
      )) as InventoryCostBalancePage;
    },

    async inventoryCostBootstrap(request) {
      return retryableCommand<InventoryCostBootstrapResult>(
        '/v1/admin/inventory/cost-bootstrap',
        {
          operationId: request.operationId,
          branchId: request.branchId,
          productId: request.productId,
          totalValueMinor: request.totalValueMinor,
        },
        INVENTORY_COMMAND_TIMEOUT_MS,
      );
    },

    async inventoryAdjust(request) {
      return retryableCommand<InventoryAdjustmentResult>(
        '/v1/admin/inventory/adjustments',
        {
          operationId: request.operationId,
          branchId: request.branchId,
          reason: request.reason,
          lines: request.lines.map((line) => ({
            productId: line.productId,
            deltaQuantityScaled: line.deltaQuantityScaled,
          })),
        },
        INVENTORY_COMMAND_TIMEOUT_MS,
      );
    },

    async inventoryCount(request) {
      return retryableCommand<InventoryCountResult>(
        '/v1/admin/inventory/counts',
        {
          operationId: request.operationId,
          branchId: request.branchId,
          reason: request.reason,
          lines: request.lines.map((line) => ({
            productId: line.productId,
            countedQuantityScaled: line.countedQuantityScaled,
            expectedRevision: line.expectedRevision,
          })),
        },
        INVENTORY_COMMAND_TIMEOUT_MS,
      );
    },

    async inventoryTransfer(request) {
      return retryableCommand<InventoryTransferResult>(
        '/v1/admin/inventory/transfers',
        {
          operationId: request.operationId,
          fromBranchId: request.fromBranchId,
          toBranchId: request.toBranchId,
          reason: request.reason,
          lines: request.lines.map((line) => ({
            productId: line.productId,
            quantityScaled: line.quantityScaled,
          })),
        },
        INVENTORY_COMMAND_TIMEOUT_MS,
      );
    },

    async purchasingBranches(query = {}, options) {
      return (await call(
        `/v1/admin/purchasing/branches${listQuery(query)}`,
        { method: 'GET' },
        options,
      )) as PurchasingPage<PurchasingBranch>;
    },

    async purchasingProducts(query = {}, options) {
      return (await call(
        `/v1/admin/purchasing/products${listQuery(query)}`,
        { method: 'GET' },
        options,
      )) as PurchasingPage<PurchasingProduct>;
    },

    async purchasingSuppliers(query = {}, options) {
      return (await call(
        `/v1/admin/purchasing/suppliers${listQuery(query)}`,
        { method: 'GET' },
        options,
      )) as PurchasingPage<PurchasingSupplier>;
    },

    async purchasingOrders(query = {}, options) {
      return (await call(
        `/v1/admin/purchasing/orders${listQuery(query)}`,
        { method: 'GET' },
        options,
      )) as PurchasingPage<PurchaseOrderSummary>;
    },

    async purchasingOrder(purchaseOrderId, options) {
      return (await call(
        `/v1/admin/purchasing/orders/${encodeURIComponent(purchaseOrderId)}`,
        { method: 'GET' },
        options,
      )) as PurchaseOrder;
    },

    async purchasingReceipts(purchaseOrderId, options) {
      const body = (await call(
        `/v1/admin/purchasing/orders/${encodeURIComponent(purchaseOrderId)}/receipts?limit=100`,
        { method: 'GET' },
        options,
      )) as { readonly receipts: readonly PurchaseReceiptSummary[] };
      return body.receipts;
    },

    async createPurchasingSupplier(request) {
      return retryableCommand<SupplierMutationResult>(
        '/v1/admin/purchasing/suppliers',
        { operationId: request.operationId, name: request.name },
        PURCHASING_COMMAND_TIMEOUT_MS,
      );
    },

    async updatePurchasingSupplier(request) {
      return retryableCommand<SupplierMutationResult>(
        `/v1/admin/purchasing/suppliers/${encodeURIComponent(request.supplierId)}`,
        {
          operationId: request.operationId,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.isActive === undefined ? {} : { isActive: request.isActive }),
        },
        PURCHASING_COMMAND_TIMEOUT_MS,
        'PATCH',
      );
    },

    async createPurchaseOrder(request) {
      return retryableCommand<PurchaseOrderCreateResult>(
        '/v1/admin/purchasing/orders',
        {
          operationId: request.operationId,
          supplierId: request.supplierId,
          branchId: request.branchId,
          reference: request.reference,
          lines: request.lines.map((line) => ({
            productId: line.productId,
            orderedQuantityScaled: line.orderedQuantityScaled,
          })),
        },
        PURCHASING_COMMAND_TIMEOUT_MS,
      );
    },

    async receivePurchaseOrder(request) {
      return retryableCommand<PurchaseReceiptResult>(
        '/v1/admin/purchasing/receipts',
        {
          operationId: request.operationId,
          purchaseOrderId: request.purchaseOrderId,
          reference: request.reference,
          lines: request.lines.map((line) => ({
            purchaseOrderLineId: line.purchaseOrderLineId,
            acceptedQuantityScaled: line.acceptedQuantityScaled,
            ...(line.inventoryValueMinor === undefined
              ? {}
              : { inventoryValueMinor: line.inventoryValueMinor }),
          })),
        },
        PURCHASING_COMMAND_TIMEOUT_MS,
      );
    },

    async createAdminProduct(input) {
      return (await call(
        '/v1/admin/products',
        json({
          sku: input.sku,
          nameAr: input.nameAr,
          ...(input.nameEn === undefined ? {} : { nameEn: input.nameEn }),
          productType: input.productType,
          unitLabel: input.unitLabel,
          priceMinor: input.priceMinor,
          ...(input.barcode === undefined ? {} : { barcode: input.barcode }),
        }),
      )) as AdminProductBootstrap;
    },

    async adminSettings(options) {
      return (await call('/v1/admin/settings', { method: 'GET' }, options)) as AdminTenantSettings;
    },

    async updateAdminSettings(patch) {
      return (await call(
        '/v1/admin/settings',
        json(
          {
            ...(patch.requireBarcode === undefined ? {} : { requireBarcode: patch.requireBarcode }),
            ...(patch.allowWeightedItems === undefined
              ? {}
              : { allowWeightedItems: patch.allowWeightedItems }),
            ...(patch.trackInventory === undefined ? {} : { trackInventory: patch.trackInventory }),
            ...(patch.allowNegativeStock === undefined
              ? {}
              : { allowNegativeStock: patch.allowNegativeStock }),
            ...(patch.enableProductImages === undefined
              ? {}
              : { enableProductImages: patch.enableProductImages }),
            ...(patch.receiptHeaderAr === undefined
              ? {}
              : { receiptHeaderAr: patch.receiptHeaderAr }),
            ...(patch.receiptFooterAr === undefined
              ? {}
              : { receiptFooterAr: patch.receiptFooterAr }),
          },
          'PATCH',
        ),
      )) as AdminTenantSettings;
    },

    async adminBranches(query = {}, options) {
      return (await call(
        `/v1/admin/branches${listQuery(query)}`,
        { method: 'GET' },
        options,
      )) as AdminPage<AdminBranch>;
    },

    async createAdminBranch(input) {
      return (await call(
        '/v1/admin/branches',
        json({
          code: input.code,
          nameAr: input.nameAr,
          ...(input.nameEn === undefined ? {} : { nameEn: input.nameEn }),
        }),
      )) as AdminBranch;
    },

    async updateAdminBranch(branchId, patch) {
      return (await call(
        `/v1/admin/branches/${encodeURIComponent(branchId)}`,
        json(
          {
            ...(patch.nameAr === undefined ? {} : { nameAr: patch.nameAr }),
            ...(patch.nameEn === undefined ? {} : { nameEn: patch.nameEn }),
          },
          'PATCH',
        ),
      )) as AdminBranch;
    },

    async setAdminBranchActive(branchId, isActive) {
      return (await call(
        `/v1/admin/branches/${encodeURIComponent(branchId)}/activation`,
        json({ isActive }),
      )) as AdminBranch;
    },

    async adminTerminals(query = {}, options) {
      return (await call(
        `/v1/admin/terminals${listQuery(query)}`,
        { method: 'GET' },
        options,
      )) as AdminPage<AdminTerminal>;
    },

    async createAdminTerminal(input) {
      return (await call(
        '/v1/admin/terminals',
        json({ branchId: input.branchId, code: input.code, label: input.label }),
      )) as AdminTerminal;
    },

    async updateAdminTerminal(terminalId, label) {
      return (await call(
        `/v1/admin/terminals/${encodeURIComponent(terminalId)}`,
        json({ label }, 'PATCH'),
      )) as AdminTerminal;
    },

    async setAdminTerminalActive(terminalId, isActive) {
      return (await call(
        `/v1/admin/terminals/${encodeURIComponent(terminalId)}/activation`,
        json({ isActive }),
      )) as AdminTerminal;
    },

    async adminMembers(query = {}, options) {
      return (await call(
        `/v1/admin/members${listQuery(query)}`,
        { method: 'GET' },
        options,
      )) as AdminPage<AdminMember>;
    },

    async createAdminMember(input) {
      return (await call(
        '/v1/admin/members',
        json({
          email: input.email,
          displayName: input.displayName,
          ...(input.defaultBranchId === undefined
            ? {}
            : { defaultBranchId: input.defaultBranchId }),
        }),
      )) as AdminMember;
    },

    async updateAdminMember(userId, patch) {
      return (await call(
        `/v1/admin/members/${encodeURIComponent(userId)}`,
        json(
          {
            ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
            ...(patch.defaultBranchId === undefined
              ? {}
              : { defaultBranchId: patch.defaultBranchId }),
          },
          'PATCH',
        ),
      )) as AdminMember;
    },

    async setAdminMemberUserActive(userId, isActive) {
      return (await call(
        `/v1/admin/members/${encodeURIComponent(userId)}/user-activation`,
        json({ isActive }),
      )) as AdminAccessChange;
    },

    async setAdminMemberMembershipActive(userId, isActive) {
      return (await call(
        `/v1/admin/members/${encodeURIComponent(userId)}/membership-activation`,
        json({ isActive }),
      )) as AdminAccessChange;
    },

    async adminRoles(options) {
      return (await call('/v1/admin/roles', { method: 'GET' }, options)) as readonly AdminRole[];
    },

    async assignAdminRole(userId, roleId) {
      return (await call(
        `/v1/admin/members/${encodeURIComponent(userId)}/roles`,
        json({ roleId }),
      )) as AdminRoleAssignmentResult;
    },

    async removeAdminRole(userId, roleId) {
      return (await call(
        `/v1/admin/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
        { method: 'DELETE' },
      )) as AdminRoleAssignmentResult;
    },
  };
}
