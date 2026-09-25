import type {
  AdminAccessChange,
  AdminBranch,
  AdminMember,
  AdminPage,
  AdminProductBootstrap,
  AdminProductCreateInput,
  AdminPromotion,
  AdminPromotionCreateInput,
  AdminPromotionUpdateInput,
  AdminPromotionCoupon,
  AdminCouponCreateInput,
  AdminCouponUpdateInput,
  AdminRole,
  AdminRoleAssignmentResult,
  AdminSettingsPatch,
  AdminTenantSettings,
  AdminTerminal,
  CheckoutRequest,
  CheckoutPreviewRequest,
  CheckoutPreviewResponse,
  CreateReturnRequest,
  CreateReturnResponse,
  NoReceiptExchangeRequest,
  NoReceiptExchangeResponse,
  CategoryMigrationInspection,
  CategoryMigrationRowPage,
  CategoryMigrationSummary,
  CustomerMigrationInspection,
  CustomerMigrationRowPage,
  CustomerMigrationSummary,
  SupplierMigrationInspection,
  SupplierMigrationRowPage,
  SupplierMigrationSummary,
  OpeningInventoryMigrationInspection,
  OpeningInventoryMigrationRowPage,
  OpeningInventoryMigrationSummary,
  CreateCsvCategoryMigrationJobRequest,
  CreateCsvCustomerMigrationJobRequest,
  CreateCsvSupplierMigrationJobRequest,
  CreateCsvOpeningInventoryMigrationJobRequest,
  CreateCsvProductMigrationJobRequest,
  CreateXlsxCategoryMigrationJobRequest,
  CreateXlsxCustomerMigrationJobRequest,
  CreateXlsxSupplierMigrationJobRequest,
  CreateXlsxOpeningInventoryMigrationJobRequest,
  CreateXlsxProductMigrationJobRequest,
  CsvCategoryMigrationSource,
  CsvCustomerMigrationSource,
  CsvSupplierMigrationSource,
  CsvOpeningInventoryMigrationSource,
  CsvProductMigrationSource,
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
  ProductMigrationInspection,
  ProductMigrationRowPage,
  ProductMigrationSummary,
  PurchaseOrder,
  PurchaseOrderCreateRequest,
  PurchaseOrderCreateResult,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  PurchaseReceiptCreateRequest,
  PurchaseReceiptResult,
  PurchaseReceiptSummary,
  ProductSummary,
  RestaurantFloorResponse,
  RestaurantOrderCancelRequest,
  RestaurantOrderCreateRequest,
  RestaurantOrderDetail,
  RestaurantOrderMutationResult,
  RestaurantOrderReplaceLinesRequest,
  RestaurantOrderSummary,
  RestaurantOrderTransferTableRequest,
  RestaurantPreparationFireMutation,
  RestaurantPreparationFireRequest,
  RestaurantPreparationStation,
  RestaurantPreparationTask,
  RestaurantPreparationTaskMutation,
  RestaurantPreparationTaskUpdateRequest,
  PurchasingBranch,
  PurchasingPage,
  PurchasingProduct,
  PurchasingSupplier,
  SaleLookupResult,
  ReturnableSale,
  ShiftCloseRequest,
  ShiftCloseResponse,
  ShiftSummary,
  SupplierCreateRequest,
  SupplierMutationResult,
  SupplierUpdateRequest,
  TerminalsResponse,
  XlsxCategoryMigrationSource,
  XlsxCustomerMigrationSource,
  XlsxSupplierMigrationSource,
  XlsxOpeningInventoryMigrationSource,
  XlsxProductMigrationSource,
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
export const MIGRATION_COMMAND_TIMEOUT_MS = 120_000;
const RESTAURANT_COMMAND_TIMEOUT_MS = 20_000;

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
  restaurantFloor(options?: RequestOptions): Promise<RestaurantFloorResponse>;
  restaurantOrders(options?: RequestOptions): Promise<readonly RestaurantOrderSummary[]>;
  restaurantOrder(orderId: string, options?: RequestOptions): Promise<RestaurantOrderDetail>;
  createRestaurantOrder(
    request: RestaurantOrderCreateRequest,
  ): Promise<RestaurantOrderMutationResult>;
  replaceRestaurantOrderLines(
    orderId: string,
    request: RestaurantOrderReplaceLinesRequest,
  ): Promise<RestaurantOrderMutationResult>;
  transferRestaurantOrderTable(
    orderId: string,
    request: RestaurantOrderTransferTableRequest,
  ): Promise<RestaurantOrderMutationResult>;
  cancelRestaurantOrder(
    orderId: string,
    request: RestaurantOrderCancelRequest,
  ): Promise<RestaurantOrderMutationResult>;
  fireRestaurantPreparation(
    orderId: string,
    request: RestaurantPreparationFireRequest,
  ): Promise<RestaurantPreparationFireMutation>;
  restaurantPreparationStations(
    options?: RequestOptions,
  ): Promise<readonly RestaurantPreparationStation[]>;
  restaurantPreparationTasks(
    stationId: string,
    options?: RequestOptions,
  ): Promise<readonly RestaurantPreparationTask[]>;
  updateRestaurantPreparationTask(
    taskId: string,
    request: RestaurantPreparationTaskUpdateRequest,
  ): Promise<RestaurantPreparationTaskMutation>;
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
  saleLookup(
    term: string,
    limit?: number,
    options?: RequestOptions,
  ): Promise<readonly SaleLookupResult[]>;
  returnableSale(saleId: string, options?: RequestOptions): Promise<ReturnableSale>;
  createReturn(request: CreateReturnRequest): Promise<CreateReturnResponse>;
  createNoReceiptExchange(request: NoReceiptExchangeRequest): Promise<NoReceiptExchangeResponse>;
  closeShift(request: ShiftCloseRequest): Promise<ShiftCloseResponse>;
  checkoutPreview(
    request: CheckoutPreviewRequest,
    options?: RequestOptions,
  ): Promise<CheckoutPreviewResponse>;
  checkout(request: CheckoutRequest): Promise<CheckoutResponse>;

  onboardingReadiness(options?: RequestOptions): Promise<OnboardingReadiness>;
  inspectProductMigrationCsv(
    input: CsvProductMigrationSource,
    options?: RequestOptions,
  ): Promise<ProductMigrationInspection>;
  inspectProductMigrationXlsx(
    input: XlsxProductMigrationSource,
    options?: RequestOptions,
  ): Promise<ProductMigrationInspection>;
  createProductMigrationCsvJob(
    request: CreateCsvProductMigrationJobRequest,
  ): Promise<ProductMigrationSummary>;
  createProductMigrationXlsxJob(
    request: CreateXlsxProductMigrationJobRequest,
  ): Promise<ProductMigrationSummary>;
  productMigrationJob(jobId: string, options?: RequestOptions): Promise<ProductMigrationSummary>;
  productMigrationRows(
    jobId: string,
    query?: {
      readonly limit?: number;
      readonly afterSourceRow?: number | null;
      readonly problemsOnly?: boolean;
    },
    options?: RequestOptions,
  ): Promise<ProductMigrationRowPage>;
  dryRunProductMigration(jobId: string): Promise<ProductMigrationSummary>;
  commitProductMigration(jobId: string, operationId: string): Promise<ProductMigrationSummary>;

  inspectCategoryMigrationCsv(
    input: CsvCategoryMigrationSource,
    options?: RequestOptions,
  ): Promise<CategoryMigrationInspection>;
  inspectCategoryMigrationXlsx(
    input: XlsxCategoryMigrationSource,
    options?: RequestOptions,
  ): Promise<CategoryMigrationInspection>;
  createCategoryMigrationCsvJob(
    request: CreateCsvCategoryMigrationJobRequest,
  ): Promise<CategoryMigrationSummary>;
  createCategoryMigrationXlsxJob(
    request: CreateXlsxCategoryMigrationJobRequest,
  ): Promise<CategoryMigrationSummary>;
  categoryMigrationJob(jobId: string, options?: RequestOptions): Promise<CategoryMigrationSummary>;
  categoryMigrationRows(
    jobId: string,
    query?: {
      readonly limit?: number;
      readonly afterSourceRow?: number | null;
      readonly problemsOnly?: boolean;
    },
    options?: RequestOptions,
  ): Promise<CategoryMigrationRowPage>;
  dryRunCategoryMigration(jobId: string): Promise<CategoryMigrationSummary>;
  commitCategoryMigration(jobId: string, operationId: string): Promise<CategoryMigrationSummary>;

  inspectCustomerMigrationCsv(
    input: CsvCustomerMigrationSource,
    options?: RequestOptions,
  ): Promise<CustomerMigrationInspection>;
  inspectCustomerMigrationXlsx(
    input: XlsxCustomerMigrationSource,
    options?: RequestOptions,
  ): Promise<CustomerMigrationInspection>;
  createCustomerMigrationCsvJob(
    request: CreateCsvCustomerMigrationJobRequest,
  ): Promise<CustomerMigrationSummary>;
  createCustomerMigrationXlsxJob(
    request: CreateXlsxCustomerMigrationJobRequest,
  ): Promise<CustomerMigrationSummary>;
  customerMigrationJob(jobId: string, options?: RequestOptions): Promise<CustomerMigrationSummary>;
  customerMigrationRows(
    jobId: string,
    query?: {
      readonly limit?: number;
      readonly afterSourceRow?: number | null;
      readonly problemsOnly?: boolean;
    },
    options?: RequestOptions,
  ): Promise<CustomerMigrationRowPage>;
  dryRunCustomerMigration(jobId: string): Promise<CustomerMigrationSummary>;
  commitCustomerMigration(jobId: string, operationId: string): Promise<CustomerMigrationSummary>;

  inspectSupplierMigrationCsv(
    input: CsvSupplierMigrationSource,
    options?: RequestOptions,
  ): Promise<SupplierMigrationInspection>;
  inspectSupplierMigrationXlsx(
    input: XlsxSupplierMigrationSource,
    options?: RequestOptions,
  ): Promise<SupplierMigrationInspection>;
  createSupplierMigrationCsvJob(
    request: CreateCsvSupplierMigrationJobRequest,
  ): Promise<SupplierMigrationSummary>;
  createSupplierMigrationXlsxJob(
    request: CreateXlsxSupplierMigrationJobRequest,
  ): Promise<SupplierMigrationSummary>;
  supplierMigrationJob(jobId: string, options?: RequestOptions): Promise<SupplierMigrationSummary>;
  supplierMigrationRows(
    jobId: string,
    query?: {
      readonly limit?: number;
      readonly afterSourceRow?: number | null;
      readonly problemsOnly?: boolean;
    },
    options?: RequestOptions,
  ): Promise<SupplierMigrationRowPage>;
  dryRunSupplierMigration(jobId: string): Promise<SupplierMigrationSummary>;
  commitSupplierMigration(jobId: string, operationId: string): Promise<SupplierMigrationSummary>;

  inspectOpeningInventoryMigrationCsv(
    input: CsvOpeningInventoryMigrationSource,
    options?: RequestOptions,
  ): Promise<OpeningInventoryMigrationInspection>;
  inspectOpeningInventoryMigrationXlsx(
    input: XlsxOpeningInventoryMigrationSource,
    options?: RequestOptions,
  ): Promise<OpeningInventoryMigrationInspection>;
  createOpeningInventoryMigrationCsvJob(
    request: CreateCsvOpeningInventoryMigrationJobRequest,
  ): Promise<OpeningInventoryMigrationSummary>;
  createOpeningInventoryMigrationXlsxJob(
    request: CreateXlsxOpeningInventoryMigrationJobRequest,
  ): Promise<OpeningInventoryMigrationSummary>;
  openingInventoryMigrationJob(
    jobId: string,
    options?: RequestOptions,
  ): Promise<OpeningInventoryMigrationSummary>;
  openingInventoryMigrationRows(
    jobId: string,
    query?: {
      readonly limit?: number;
      readonly afterSourceRow?: number | null;
      readonly problemsOnly?: boolean;
    },
    options?: RequestOptions,
  ): Promise<OpeningInventoryMigrationRowPage>;
  dryRunOpeningInventoryMigration(jobId: string): Promise<OpeningInventoryMigrationSummary>;
  commitOpeningInventoryMigration(
    jobId: string,
    operationId: string,
  ): Promise<OpeningInventoryMigrationSummary>;

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
  adminPromotions(options?: RequestOptions): Promise<readonly AdminPromotion[]>;
  createAdminPromotion(input: AdminPromotionCreateInput): Promise<AdminPromotion>;
  updateAdminPromotion(
    promotionId: string,
    input: AdminPromotionUpdateInput,
  ): Promise<AdminPromotion>;
  createAdminCoupon(promotionId: string, input: AdminCouponCreateInput): Promise<AdminPromotionCoupon>;
  updateAdminCoupon(couponId: string, input: AdminCouponUpdateInput): Promise<AdminPromotionCoupon>;
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

  const json = (payload: unknown, method: 'POST' | 'PATCH' | 'PUT' = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const retryableCommand = async <T>(
    path: string,
    payload: unknown,
    timeoutMs: number,
    method: 'POST' | 'PATCH' | 'PUT' = 'POST',
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

    async restaurantFloor(options) {
      return (await call(
        '/v1/restaurant/floor',
        { method: 'GET' },
        options,
      )) as RestaurantFloorResponse;
    },

    async restaurantOrders(options) {
      const body = (await call('/v1/restaurant/orders', { method: 'GET' }, options)) as {
        readonly orders: readonly RestaurantOrderSummary[];
      };
      return body.orders;
    },

    async restaurantOrder(orderId, options) {
      return (await call(
        `/v1/restaurant/orders/${encodeURIComponent(orderId)}`,
        { method: 'GET' },
        options,
      )) as RestaurantOrderDetail;
    },

    async createRestaurantOrder(request) {
      return retryableCommand<RestaurantOrderMutationResult>(
        '/v1/restaurant/orders',
        request,
        RESTAURANT_COMMAND_TIMEOUT_MS,
      );
    },

    async replaceRestaurantOrderLines(orderId, request) {
      return retryableCommand<RestaurantOrderMutationResult>(
        `/v1/restaurant/orders/${encodeURIComponent(orderId)}/lines`,
        request,
        RESTAURANT_COMMAND_TIMEOUT_MS,
        'PUT',
      );
    },

    async transferRestaurantOrderTable(orderId, request) {
      return retryableCommand<RestaurantOrderMutationResult>(
        `/v1/restaurant/orders/${encodeURIComponent(orderId)}/transfer-table`,
        request,
        RESTAURANT_COMMAND_TIMEOUT_MS,
      );
    },

    async cancelRestaurantOrder(orderId, request) {
      return retryableCommand<RestaurantOrderMutationResult>(
        `/v1/restaurant/orders/${encodeURIComponent(orderId)}/cancel`,
        request,
        RESTAURANT_COMMAND_TIMEOUT_MS,
      );
    },

    async fireRestaurantPreparation(orderId, request) {
      return retryableCommand<RestaurantPreparationFireMutation>(
        `/v1/restaurant/orders/${encodeURIComponent(orderId)}/preparation/fire`,
        request,
        RESTAURANT_COMMAND_TIMEOUT_MS,
      );
    },

    async restaurantPreparationStations(options) {
      return (await call(
        '/v1/restaurant/preparation-stations',
        { method: 'GET' },
        options,
      )) as readonly RestaurantPreparationStation[];
    },

    async restaurantPreparationTasks(stationId, options) {
      return (await call(
        `/v1/restaurant/preparation-stations/${encodeURIComponent(stationId)}/tasks`,
        { method: 'GET' },
        options,
      )) as readonly RestaurantPreparationTask[];
    },

    async updateRestaurantPreparationTask(taskId, request) {
      return retryableCommand<RestaurantPreparationTaskMutation>(
        `/v1/restaurant/preparation-tasks/${encodeURIComponent(taskId)}/status`,
        request,
        RESTAURANT_COMMAND_TIMEOUT_MS,
      );
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

    async saleLookup(term, limit = 10, options) {
      const search = new URLSearchParams({ q: term, limit: String(limit) });
      const body = (await call(
        `/v1/sales/lookup?${search.toString()}`,
        { method: 'GET' },
        options,
      )) as { sales: readonly SaleLookupResult[] };
      return body.sales;
    },

    async returnableSale(saleId, options) {
      const body = (await call(
        `/v1/sales/${encodeURIComponent(saleId)}/returnable`,
        { method: 'GET' },
        options,
      )) as { sale: ReturnableSale };
      return body.sale;
    },

    async createReturn(request) {
      return retryableCommand<CreateReturnResponse>(
        '/v1/returns',
        {
          operationId: request.operationId,
          terminalId: request.terminalId,
          saleId: request.saleId,
          ...(request.reason === undefined || request.reason.trim() === ''
            ? {}
            : { reason: request.reason.trim() }),
          refund:
            request.refund.kind === 'cash'
              ? { kind: 'cash' as const }
              : {
                  kind: 'electronic' as const,
                  scheme: request.refund.scheme,
                  reference: request.refund.reference.trim(),
                },
          lines: request.lines.map((line) => ({
            saleLineId: line.saleLineId,
            quantityScaled: line.quantityScaled,
          })),
        },
        CHECKOUT_TIMEOUT_MS,
      );
    },

    async createNoReceiptExchange(request) {
      return retryableCommand<NoReceiptExchangeResponse>(
        '/v1/no-receipt-exchanges',
        {
          operationId: request.operationId,
          terminalId: request.terminalId,
          ...(request.expectedShiftId === undefined
            ? {}
            : { expectedShiftId: request.expectedShiftId }),
          reason: request.reason,
          ...(request.evidenceNote === undefined || request.evidenceNote.trim() === ''
            ? {}
            : { evidenceNote: request.evidenceNote.trim() }),
          approvedAllowanceMinor: request.approvedAllowanceMinor,
          acceptedLines: request.acceptedLines,
          replacementLines: request.replacementLines,
          tenders: request.tenders.map((tender) =>
            tender.kind === 'cash'
              ? { kind: 'cash' as const, amountMinor: tender.amountMinor }
              : {
                  kind: 'electronic' as const,
                  amountMinor: tender.amountMinor,
                  scheme: tender.scheme,
                  reference: tender.reference.trim(),
                },
          ),
        },
        CHECKOUT_TIMEOUT_MS,
      );
    },

    async closeShift(request) {
      return retryableCommand<ShiftCloseResponse>(
        '/v1/shifts/close',
        {
          operationId: request.operationId,
          terminalId: request.terminalId,
          shiftId: request.shiftId,
          declaredCashMinor: request.declaredCashMinor,
        },
        CHECKOUT_TIMEOUT_MS,
      );
    },

    async checkoutPreview(request, options) {
      return (await call(
        '/v1/checkout/preview',
        json({
          ...(request.couponCodes === undefined ? {} : { couponCodes: request.couponCodes }),
          lines: request.lines.map((line) => ({
            productId: line.productId,
            quantityScaled: line.quantityScaled,
          })),
        }),
        options,
      )) as CheckoutPreviewResponse;
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
            ...(request.expectedShiftId === undefined
              ? {}
              : { expectedShiftId: request.expectedShiftId }),
            ...(request.orderType === undefined ? {} : { orderType: request.orderType }),
            ...(request.tableId === undefined ? {} : { tableId: request.tableId }),
            ...(request.restaurantOrderId === undefined
              ? {}
              : { restaurantOrderId: request.restaurantOrderId }),
            ...(request.expectedRestaurantOrderRevision === undefined
              ? {}
              : { expectedRestaurantOrderRevision: request.expectedRestaurantOrderRevision }),
            ...(request.cashReceivedMinor === undefined
              ? {}
              : { cashReceivedMinor: request.cashReceivedMinor }),
            ...(request.tenders === undefined
              ? {}
              : {
                  tenders: request.tenders.map((tender) =>
                    tender.kind === 'cash'
                      ? { kind: 'cash' as const, amountMinor: tender.amountMinor }
                      : {
                          kind: 'electronic' as const,
                          amountMinor: tender.amountMinor,
                          scheme: tender.scheme,
                          reference: tender.reference,
                        },
                  ),
                }),
            ...(request.couponCodes === undefined ? {} : { couponCodes: request.couponCodes }),
            ...(request.expectedPricingHash === undefined
              ? {}
              : { expectedPricingHash: request.expectedPricingHash }),
            ...(request.offlineCaptured === undefined
              ? {}
              : { offlineCaptured: request.offlineCaptured }),
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

    async inspectProductMigrationCsv(input, options) {
      return (await call(
        '/v1/admin/migrations/products/inspect-csv',
        json(input),
        options,
      )) as ProductMigrationInspection;
    },

    async inspectProductMigrationXlsx(input, options) {
      return (await call(
        '/v1/admin/migrations/products/inspect-xlsx',
        json(input),
        options,
      )) as ProductMigrationInspection;
    },

    async createProductMigrationCsvJob(request) {
      return retryableCommand<ProductMigrationSummary>(
        '/v1/admin/migrations/products/jobs',
        request,
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async createProductMigrationXlsxJob(request) {
      return retryableCommand<ProductMigrationSummary>(
        '/v1/admin/migrations/products/jobs/xlsx',
        request,
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async productMigrationJob(jobId, options) {
      return (await call(
        `/v1/admin/migrations/products/jobs/${encodeURIComponent(jobId)}`,
        { method: 'GET' },
        options,
      )) as ProductMigrationSummary;
    },

    async productMigrationRows(jobId, query = {}, options) {
      const search = new URLSearchParams();
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      if (query.afterSourceRow !== undefined && query.afterSourceRow !== null) {
        search.set('afterSourceRow', String(query.afterSourceRow));
      }
      if (query.problemsOnly !== undefined) {
        search.set('problemsOnly', String(query.problemsOnly));
      }
      const suffix = search.toString();
      return (await call(
        `/v1/admin/migrations/products/jobs/${encodeURIComponent(jobId)}/rows${
          suffix === '' ? '' : `?${suffix}`
        }`,
        { method: 'GET' },
        options,
      )) as ProductMigrationRowPage;
    },

    async dryRunProductMigration(jobId) {
      return retryableCommand<ProductMigrationSummary>(
        `/v1/admin/migrations/products/jobs/${encodeURIComponent(jobId)}/dry-run`,
        {},
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async commitProductMigration(jobId, operationId) {
      return retryableCommand<ProductMigrationSummary>(
        `/v1/admin/migrations/products/jobs/${encodeURIComponent(jobId)}/commit`,
        { operationId },
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async inspectCategoryMigrationCsv(input, options) {
      return (await call(
        '/v1/admin/migrations/categories/inspect-csv',
        json(input),
        options,
      )) as CategoryMigrationInspection;
    },

    async inspectCategoryMigrationXlsx(input, options) {
      return (await call(
        '/v1/admin/migrations/categories/inspect-xlsx',
        json(input),
        options,
      )) as CategoryMigrationInspection;
    },

    async createCategoryMigrationCsvJob(request) {
      return retryableCommand<CategoryMigrationSummary>(
        '/v1/admin/migrations/categories/jobs',
        request,
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async createCategoryMigrationXlsxJob(request) {
      return retryableCommand<CategoryMigrationSummary>(
        '/v1/admin/migrations/categories/jobs/xlsx',
        request,
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async categoryMigrationJob(jobId, options) {
      return (await call(
        `/v1/admin/migrations/categories/jobs/${encodeURIComponent(jobId)}`,
        { method: 'GET' },
        options,
      )) as CategoryMigrationSummary;
    },

    async categoryMigrationRows(jobId, query = {}, options) {
      const search = new URLSearchParams();
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      if (query.afterSourceRow !== undefined && query.afterSourceRow !== null) {
        search.set('afterSourceRow', String(query.afterSourceRow));
      }
      if (query.problemsOnly !== undefined) {
        search.set('problemsOnly', String(query.problemsOnly));
      }
      const suffix = search.toString();
      return (await call(
        `/v1/admin/migrations/categories/jobs/${encodeURIComponent(jobId)}/rows${
          suffix === '' ? '' : `?${suffix}`
        }`,
        { method: 'GET' },
        options,
      )) as CategoryMigrationRowPage;
    },

    async dryRunCategoryMigration(jobId) {
      return retryableCommand<CategoryMigrationSummary>(
        `/v1/admin/migrations/categories/jobs/${encodeURIComponent(jobId)}/dry-run`,
        {},
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async commitCategoryMigration(jobId, operationId) {
      return retryableCommand<CategoryMigrationSummary>(
        `/v1/admin/migrations/categories/jobs/${encodeURIComponent(jobId)}/commit`,
        { operationId },
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async inspectCustomerMigrationCsv(input, options) {
      return (await call(
        '/v1/admin/migrations/customers/inspect-csv',
        json(input),
        options,
      )) as CustomerMigrationInspection;
    },

    async inspectCustomerMigrationXlsx(input, options) {
      return (await call(
        '/v1/admin/migrations/customers/inspect-xlsx',
        json(input),
        options,
      )) as CustomerMigrationInspection;
    },

    async createCustomerMigrationCsvJob(request) {
      return retryableCommand<CustomerMigrationSummary>(
        '/v1/admin/migrations/customers/jobs',
        request,
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async createCustomerMigrationXlsxJob(request) {
      return retryableCommand<CustomerMigrationSummary>(
        '/v1/admin/migrations/customers/jobs/xlsx',
        request,
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async customerMigrationJob(jobId, options) {
      return (await call(
        `/v1/admin/migrations/customers/jobs/${encodeURIComponent(jobId)}`,
        { method: 'GET' },
        options,
      )) as CustomerMigrationSummary;
    },

    async customerMigrationRows(jobId, query = {}, options) {
      const search = new URLSearchParams();
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      if (query.afterSourceRow !== undefined && query.afterSourceRow !== null) {
        search.set('afterSourceRow', String(query.afterSourceRow));
      }
      if (query.problemsOnly !== undefined) {
        search.set('problemsOnly', String(query.problemsOnly));
      }
      const suffix = search.toString();
      return (await call(
        `/v1/admin/migrations/customers/jobs/${encodeURIComponent(jobId)}/rows${
          suffix === '' ? '' : `?${suffix}`
        }`,
        { method: 'GET' },
        options,
      )) as CustomerMigrationRowPage;
    },

    async dryRunCustomerMigration(jobId) {
      return retryableCommand<CustomerMigrationSummary>(
        `/v1/admin/migrations/customers/jobs/${encodeURIComponent(jobId)}/dry-run`,
        {},
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async commitCustomerMigration(jobId, operationId) {
      return retryableCommand<CustomerMigrationSummary>(
        `/v1/admin/migrations/customers/jobs/${encodeURIComponent(jobId)}/commit`,
        { operationId },
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async inspectSupplierMigrationCsv(input, options) {
      return (await call(
        '/v1/admin/migrations/suppliers/inspect-csv',
        json(input),
        options,
      )) as SupplierMigrationInspection;
    },

    async inspectSupplierMigrationXlsx(input, options) {
      return (await call(
        '/v1/admin/migrations/suppliers/inspect-xlsx',
        json(input),
        options,
      )) as SupplierMigrationInspection;
    },

    async createSupplierMigrationCsvJob(request) {
      return retryableCommand<SupplierMigrationSummary>(
        '/v1/admin/migrations/suppliers/jobs',
        request,
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async createSupplierMigrationXlsxJob(request) {
      return retryableCommand<SupplierMigrationSummary>(
        '/v1/admin/migrations/suppliers/jobs/xlsx',
        request,
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async supplierMigrationJob(jobId, options) {
      return (await call(
        `/v1/admin/migrations/suppliers/jobs/${encodeURIComponent(jobId)}`,
        { method: 'GET' },
        options,
      )) as SupplierMigrationSummary;
    },

    async supplierMigrationRows(jobId, query = {}, options) {
      const search = new URLSearchParams();
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      if (query.afterSourceRow !== undefined && query.afterSourceRow !== null) {
        search.set('afterSourceRow', String(query.afterSourceRow));
      }
      if (query.problemsOnly !== undefined) {
        search.set('problemsOnly', String(query.problemsOnly));
      }
      const suffix = search.toString();
      return (await call(
        `/v1/admin/migrations/suppliers/jobs/${encodeURIComponent(jobId)}/rows${
          suffix === '' ? '' : `?${suffix}`
        }`,
        { method: 'GET' },
        options,
      )) as SupplierMigrationRowPage;
    },

    async dryRunSupplierMigration(jobId) {
      return retryableCommand<SupplierMigrationSummary>(
        `/v1/admin/migrations/suppliers/jobs/${encodeURIComponent(jobId)}/dry-run`,
        {},
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async commitSupplierMigration(jobId, operationId) {
      return retryableCommand<SupplierMigrationSummary>(
        `/v1/admin/migrations/suppliers/jobs/${encodeURIComponent(jobId)}/commit`,
        { operationId },
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async inspectOpeningInventoryMigrationCsv(input, options) {
      return (await call(
        '/v1/admin/migrations/opening-inventory/inspect-csv',
        json(input),
        options,
      )) as OpeningInventoryMigrationInspection;
    },

    async inspectOpeningInventoryMigrationXlsx(input, options) {
      return (await call(
        '/v1/admin/migrations/opening-inventory/inspect-xlsx',
        json(input),
        options,
      )) as OpeningInventoryMigrationInspection;
    },

    async createOpeningInventoryMigrationCsvJob(request) {
      return retryableCommand<OpeningInventoryMigrationSummary>(
        '/v1/admin/migrations/opening-inventory/jobs',
        request,
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async createOpeningInventoryMigrationXlsxJob(request) {
      return retryableCommand<OpeningInventoryMigrationSummary>(
        '/v1/admin/migrations/opening-inventory/jobs/xlsx',
        request,
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async openingInventoryMigrationJob(jobId, options) {
      return (await call(
        `/v1/admin/migrations/opening-inventory/jobs/${encodeURIComponent(jobId)}`,
        { method: 'GET' },
        options,
      )) as OpeningInventoryMigrationSummary;
    },

    async openingInventoryMigrationRows(jobId, query = {}, options) {
      const search = new URLSearchParams();
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      if (query.afterSourceRow !== undefined && query.afterSourceRow !== null) {
        search.set('afterSourceRow', String(query.afterSourceRow));
      }
      if (query.problemsOnly !== undefined) {
        search.set('problemsOnly', String(query.problemsOnly));
      }
      const suffix = search.toString();
      return (await call(
        `/v1/admin/migrations/opening-inventory/jobs/${encodeURIComponent(jobId)}/rows${
          suffix === '' ? '' : `?${suffix}`
        }`,
        { method: 'GET' },
        options,
      )) as OpeningInventoryMigrationRowPage;
    },

    async dryRunOpeningInventoryMigration(jobId) {
      return retryableCommand<OpeningInventoryMigrationSummary>(
        `/v1/admin/migrations/opening-inventory/jobs/${encodeURIComponent(jobId)}/dry-run`,
        {},
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
    },

    async commitOpeningInventoryMigration(jobId, operationId) {
      return retryableCommand<OpeningInventoryMigrationSummary>(
        `/v1/admin/migrations/opening-inventory/jobs/${encodeURIComponent(jobId)}/commit`,
        { operationId },
        MIGRATION_COMMAND_TIMEOUT_MS,
      );
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
          expectedStockRevision: request.expectedStockRevision,
          expectedCostRevision: request.expectedCostRevision,
          expectedUnknownPositiveQuantityScaled: request.expectedUnknownPositiveQuantityScaled,
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

    async adminPromotions(options) {
      const body = (await call(
        '/v1/admin/promotions',
        { method: 'GET' },
        options,
      )) as { promotions: readonly AdminPromotion[] };
      return body.promotions;
    },

    async createAdminPromotion(input) {
      return (await call(
        '/v1/admin/promotions',
        json({
          merchantCode: input.merchantCode,
          name: input.name,
          activationMode: input.activationMode,
          priority: input.priority,
          stackingMode: input.stackingMode,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          effectKind: input.effectKind,
          effectValue: input.effectValue,
          minimumEligibleSubtotalMinor: input.minimumEligibleSubtotalMinor,
          targetKind: input.targetKind,
          productIds: [...input.productIds],
        }),
      )) as AdminPromotion;
    },

    async updateAdminPromotion(promotionId, input) {
      return (await call(
        `/v1/admin/promotions/${encodeURIComponent(promotionId)}`,
        json(
          {
            expectedRevision: input.expectedRevision,
            ...(input.merchantCode === undefined ? {} : { merchantCode: input.merchantCode }),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.activationMode === undefined
              ? {}
              : { activationMode: input.activationMode }),
            ...(input.priority === undefined ? {} : { priority: input.priority }),
            ...(input.stackingMode === undefined ? {} : { stackingMode: input.stackingMode }),
            ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
            ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
            ...(input.effectKind === undefined ? {} : { effectKind: input.effectKind }),
            ...(input.effectValue === undefined ? {} : { effectValue: input.effectValue }),
            ...(input.minimumEligibleSubtotalMinor === undefined
              ? {}
              : { minimumEligibleSubtotalMinor: input.minimumEligibleSubtotalMinor }),
            ...(input.targetKind === undefined ? {} : { targetKind: input.targetKind }),
            ...(input.productIds === undefined ? {} : { productIds: [...input.productIds] }),
          },
          'PATCH',
        ),
      )) as AdminPromotion;
    },

    async createAdminCoupon(promotionId, input) {
      return (await call(
        `/v1/admin/promotions/${encodeURIComponent(promotionId)}/coupons`,
        json({
          code: input.code,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
          ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
          ...(input.totalRedemptionLimit === undefined
            ? {}
            : { totalRedemptionLimit: input.totalRedemptionLimit }),
        }),
      )) as AdminPromotionCoupon;
    },

    async updateAdminCoupon(couponId, input) {
      return (await call(
        `/v1/admin/coupons/${encodeURIComponent(couponId)}`,
        json(
          {
            expectedRevision: input.expectedRevision,
            ...(input.code === undefined ? {} : { code: input.code }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
            ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
            ...(input.totalRedemptionLimit === undefined
              ? {}
              : { totalRedemptionLimit: input.totalRedemptionLimit }),
          },
          'PATCH',
        ),
      )) as AdminPromotionCoupon;
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
