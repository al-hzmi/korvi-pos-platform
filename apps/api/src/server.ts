import Fastify from 'fastify';
import {
  createAuditRepository,
  createDashboardRepository,
  createAuthRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createRestaurantFloorRepository,
  createSaleRepository,
  createReturnRepository,
  createShiftRepository,
  createTenantRepository,
  createTerminalRepository,
  readRestaurantOrder,
  readTenantOnboardingReadiness,
} from '@korvi/database';
import { newId } from '@korvi/domain';
import { createMerchantAdminService } from './admin/service.js';
import { createAuthService } from './auth/service.js';
import { createGuards } from './auth/guards.js';
import { createOwnerBootstrapService } from './bootstrap/service.js';
import { createMerchantProductService } from './catalog/service.js';
import { createCheckoutService } from './checkout/service.js';
import { createMerchantCustomerService } from './customers/service.js';
import { createMerchantInventoryService } from './inventory/service.js';
import { createMerchantOnboardingService } from './onboarding/service.js';
import { createPlatformAuth } from './platform/auth.js';
import { registerPlatformDeviceRoutes } from './platform/device-routes.js';
import { registerPlatformRoutes } from './platform/routes.js';
import { createPlatformService } from './platform/service.js';
import { registerPlatformSupportRoutes } from './platform/support-routes.js';
import { createPlatformSupportService } from './platform/support-service.js';
import { createMerchantPurchasingService } from './purchasing/service.js';
import { createMerchantRestaurantOrderService } from './restaurant/order-service.js';
import { createMerchantPreparationService } from './restaurant/preparation-service.js';
import { createMerchantRestaurantRecipeService } from './restaurant/recipe-service.js';
import { createMerchantRestaurantWasteService } from './restaurant/waste-service.js';
import { createReturnService } from './returns/service.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBootstrapRoutes } from './routes/bootstrap.js';
import { registerBusinessRoutes } from './routes/business.js';
import { registerCatalogAdminRoutes } from './routes/catalog-admin.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInventoryAdminRoutes } from './routes/inventory-admin.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerPurchasingAdminRoutes } from './routes/purchasing-admin.js';
import { registerRestaurantOrderRoutes } from './routes/restaurant-orders.js';
import { registerRestaurantPreparationRoutes } from './routes/restaurant-preparation.js';
import { registerRestaurantRecipeRoutes } from './routes/restaurant-recipes.js';
import { registerRestaurantWasteRoutes } from './routes/restaurant-waste.js';
import { registerSalesReadRoutes } from './routes/sales-read.js';
import { registerZatcaRoutes } from './routes/zatca.js';
import { registerOperationalObservability } from './runtime/observability.js';
import { createMerchantSalesReadService } from './sales/read-service.js';
import { createDrawerService } from './shifts/service.js';
import { createMerchantZatcaService } from './zatca/merchant-service.js';
import { createLazyProductionCheckoutFiscalization } from './zatca/checkout-fiscalization-infrastructure.js';
import { createStagingSimulationCheckoutFiscalization } from './zatca/staging-simulation-checkout-fiscalization.js';
import type { MerchantAdminService } from './admin/service.js';
import type { AuthService } from './auth/service.js';
import type { OwnerBootstrapService } from './bootstrap/service.js';
import type { MerchantProductService } from './catalog/service.js';
import type { MerchantCustomerService } from './customers/service.js';
import type { MerchantInventoryService } from './inventory/service.js';
import type { MerchantOnboardingService } from './onboarding/service.js';
import type { PlatformService } from './platform/service.js';
import type { PlatformSupportService } from './platform/support-service.js';
import type { MerchantPurchasingService } from './purchasing/service.js';
import type { MerchantRestaurantOrderService } from './restaurant/order-service.js';
import type { MerchantPreparationService } from './restaurant/preparation-service.js';
import type { MerchantRestaurantRecipeService } from './restaurant/recipe-service.js';
import type { MerchantRestaurantWasteService } from './restaurant/waste-service.js';
import type { BusinessDeps } from './routes/business.js';
import type { MerchantSalesReadService } from './sales/read-service.js';
import type { MerchantZatcaService } from './zatca/merchant-service.js';
import type { ApiConfig } from './config.js';
import type { FastifyInstance } from 'fastify';

export interface ServerDeps {
  /**
   * The cashier's repositories and checkout pipeline.
   *
   * Supplied by tests with in-memory implementations; built from DATABASE_URL
   * on first use otherwise, for the same reason `auth` is.
   */
  readonly business?: BusinessDeps;
  /**
   * Supplied by tests with an in-memory implementation.
   *
   * Left out in production, where it is built from DATABASE_URL on first use —
   * lazily, so a process that only answers /health never opens a connection.
   */
  readonly auth?: AuthService;
  /**
   * The public owner-bootstrap surface.
   *
   * Explicitly nullable rather than optional-undefined: `null` means "this
   * deployment has no signing key", which the route answers 503 to, and
   * `undefined` means "build it from configuration". A test that wants the
   * route off says so.
   */
  readonly bootstrap?: OwnerBootstrapService | null;
  /** Merchant settings, branches, tills, members and roles. */
  readonly admin?: MerchantAdminService;
  /** Narrow catalogue write used by onboarding and back-office product creation. */
  readonly catalog?: MerchantProductService;
  /** Merchant stock authority: adjustments, counts and branch transfers. */
  readonly inventory?: MerchantInventoryService;
  /** Purchasing and receiving authority: suppliers, orders and receipts. */
  readonly purchasing?: MerchantPurchasingService;
  /** Read-only onboarding readiness authority. */
  readonly onboarding?: MerchantOnboardingService;
  /** Operational restaurant open-order authority; non-fiscal until checkout. */
  readonly restaurantOrders?: MerchantRestaurantOrderService;
  /** Non-fiscal preparation-station configuration and routing authority. */
  readonly restaurantPreparation?: MerchantPreparationService;
  /** Restaurant recipe/BOM configuration plus governed batch-production inventory authority. */
  readonly restaurantRecipes?: MerchantRestaurantRecipeService;
  /** Explicit waste/spoilage stock-loss authority; separate from generic inventory adjustments. */
  readonly restaurantWaste?: MerchantRestaurantWasteService;
  /** Merchant customer directory and mutation authority. */
  readonly customers?: MerchantCustomerService;
  /** Read-only merchant sales history and financial reports, authorized by report.read. */
  readonly salesRead?: MerchantSalesReadService;
  /** Merchant-safe ZATCA operational status, authorized by zatca.manage. */
  readonly zatca?: MerchantZatcaService;
  /** Korvi's own SaaS control plane, separate from merchant administration. */
  readonly platform?: PlatformService;
  /** Append-only internal support ledger for the SaaS control plane. */
  readonly platformSupport?: PlatformSupportService;
}

class AuthUnavailableError extends Error {
  public override readonly name = 'AuthUnavailableError';
}

function lazyAuthService(config: ApiConfig): AuthService {
  let built: AuthService | null = null;

  const resolve = (): AuthService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) {
      throw new AuthUnavailableError('DATABASE_URL is not configured.');
    }
    const prisma = createPrismaClient(url);
    built = createAuthService({
      repository: createAuthRepository(prisma),
      audit: createAuditRepository(prisma),
      sessionTtlSeconds: config.SESSION_TTL_SECONDS,
    });
    return built;
  };

  return {
    login: (input) => resolve().login(input),
    authenticate: (token) => resolve().authenticate(token),
    logout: (token) => resolve().logout(token),
    logoutAll: (token) => resolve().logoutAll(token),
  };
}

function lazyBusinessDeps(config: ApiConfig): BusinessDeps {
  let built: BusinessDeps | null = null;

  const resolve = (): BusinessDeps => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    const prisma = createPrismaClient(url);
    const products = createProductRepository(prisma);
    const shifts = createShiftRepository(prisma);
    const terminals = createTerminalRepository(prisma);
    const tenants = createTenantRepository(prisma);
    const dashboard = createDashboardRepository(prisma);
    const restaurantFloor = createRestaurantFloorRepository(prisma);
    const idempotency = createIdempotencyRepository(prisma);
    const audit = createAuditRepository(prisma);
    const sales = createSaleRepository(prisma);
    const fiscalization =
      config.checkoutFiscalizationMode === 'simulation'
        ? createStagingSimulationCheckoutFiscalization()
        : config.checkoutFiscalizationMode === 'production'
          ? createLazyProductionCheckoutFiscalization({ prisma })
          : undefined;
    built = {
      tenants,
      dashboard,
      products,
      shifts,
      terminals,
      restaurantFloor,
      checkout: createCheckoutService({
        tenants,
        products,
        inventory: createInventoryRepository(prisma),
        shifts,
        sales,
        restaurantFloor,
        restaurantOrders: {
          read: (scope, branchId, orderId) => readRestaurantOrder(prisma, scope, branchId, orderId),
        },
        idempotency,
        audit,
        ...(fiscalization === undefined ? {} : { fiscalization }),
      }),
      drawer: createDrawerService({ shifts, terminals, idempotency, audit }),
      returns: createReturnService({
        returns: createReturnRepository(prisma),
        terminals,
        shifts,
        idempotency,
        audit,
      }),
    };
    return built;
  };

  return {
    tenants: {
      current: (scope) => resolve().tenants.current(scope),
      settings: (scope) => resolve().tenants.settings(scope),
    },
    dashboard: { summary: (scope, since) => resolve().dashboard.summary(scope, since) },
    products: {
      findById: (scope, id) => resolve().products.findById(scope, id),
      findBySku: (scope, sku) => resolve().products.findBySku(scope, sku),
      findByBarcode: (scope, barcode) => resolve().products.findByBarcode(scope, barcode),
      search: (scope, query) => resolve().products.search(scope, query),
      list: (scope, limit) => resolve().products.list(scope, limit),
    },
    shifts: {
      findById: (scope, id) => resolve().shifts.findById(scope, id),
      findOpenForTerminal: (scope, terminalId) =>
        resolve().shifts.findOpenForTerminal(scope, terminalId),
      open: (scope, input) => resolve().shifts.open(scope, input),
      findMovementById: (scope, id) => resolve().shifts.findMovementById(scope, id),
      recordManualMovement: (scope, input) => resolve().shifts.recordManualMovement(scope, input),
      close: (scope, input) => resolve().shifts.close(scope, input),
    },
    restaurantFloor: {
      findTableById: (scope, id) => resolve().restaurantFloor.findTableById(scope, id),
      listZonesForBranch: (scope, branchId, activeOnly) =>
        resolve().restaurantFloor.listZonesForBranch(scope, branchId, activeOnly),
      listTablesForBranch: (scope, branchId, activeOnly) =>
        resolve().restaurantFloor.listTablesForBranch(scope, branchId, activeOnly),
    },
    terminals: {
      findById: (scope, id) => resolve().terminals.findById(scope, id),
      findByCode: (scope, code) => resolve().terminals.findByCode(scope, code),
      listForBranch: (scope, branchId) => resolve().terminals.listForBranch(scope, branchId),
      markSeen: (scope, id, at) => resolve().terminals.markSeen(scope, id, at),
    },
    checkout: { checkout: (input) => resolve().checkout.checkout(input) },
    drawer: {
      recordMovement: (input) => resolve().drawer.recordMovement(input),
      close: (input) => resolve().drawer.close(input),
    },
    returns: {
      create: (input) => resolve().returns.create(input),
      lookup: (principal, term, limit) => resolve().returns.lookup(principal, term, limit),
      returnable: (principal, saleId) => resolve().returns.returnable(principal, saleId),
    },
  };
}

function lazyAdminService(config: ApiConfig): MerchantAdminService {
  let built: MerchantAdminService | null = null;

  const resolve = (): MerchantAdminService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    const prisma = createPrismaClient(url);
    const tenants = createTenantRepository(prisma);
    built = createMerchantAdminService({
      prisma,
      readSettings: async (scope) => {
        const settings = await tenants.settings(scope);
        if (settings === null) return null;
        return {
          tenantId: settings.tenantId as string,
          vertical: settings.vertical,
          priceMode: settings.priceMode,
          defaultVatBasisPoints: Number(settings.defaultVatBasisPoints),
          currency: settings.currency,
          requireBarcode: settings.requireBarcode,
          allowWeightedItems: settings.allowWeightedItems,
          trackInventory: settings.trackInventory,
          allowNegativeStock: settings.allowNegativeStock,
          enableProductImages: settings.enableProductImages,
          receiptHeaderAr: settings.receiptHeaderAr,
          receiptFooterAr: settings.receiptFooterAr,
        };
      },
    });
    return built;
  };

  return {
    readSettings: (principal) => resolve().readSettings(principal),
    updateSettings: (principal, patch) => resolve().updateSettings(principal, patch),
    listBranches: (principal, limit, cursor) => resolve().listBranches(principal, limit, cursor),
    createBranch: (principal, input) => resolve().createBranch(principal, input),
    updateBranch: (principal, id, patch) => resolve().updateBranch(principal, id, patch),
    setBranchActive: (principal, id, isActive) =>
      resolve().setBranchActive(principal, id, isActive),
    listTerminals: (principal, limit, branchId, cursor) =>
      resolve().listTerminals(principal, limit, branchId, cursor),
    createTerminal: (principal, input) => resolve().createTerminal(principal, input),
    updateTerminal: (principal, id, label) => resolve().updateTerminal(principal, id, label),
    setTerminalActive: (principal, id, isActive) =>
      resolve().setTerminalActive(principal, id, isActive),
    listMembers: (principal, limit, cursor) => resolve().listMembers(principal, limit, cursor),
    createMember: (principal, input) => resolve().createMember(principal, input),
    updateMember: (principal, id, patch) => resolve().updateMember(principal, id, patch),
    setUserActive: (principal, id, isActive) => resolve().setUserActive(principal, id, isActive),
    setMembershipActive: (principal, id, isActive) =>
      resolve().setMembershipActive(principal, id, isActive),
    listRoles: (principal) => resolve().listRoles(principal),
    assignRole: (principal, userId, roleId) => resolve().assignRole(principal, userId, roleId),
    removeRole: (principal, userId, roleId) => resolve().removeRole(principal, userId, roleId),
  };
}

function lazyCatalogService(config: ApiConfig): MerchantProductService {
  let built: MerchantProductService | null = null;

  const resolve = (): MerchantProductService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createMerchantProductService(createPrismaClient(url));
    return built;
  };

  return { create: (principal, input) => resolve().create(principal, input) };
}

function lazyInventoryService(config: ApiConfig): MerchantInventoryService {
  let built: MerchantInventoryService | null = null;

  const resolve = (): MerchantInventoryService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createMerchantInventoryService({ prisma: createPrismaClient(url) });
    return built;
  };

  return {
    branches: (principal, query) => resolve().branches(principal, query),
    balances: (principal, query) => resolve().balances(principal, query),
    costBalances: (principal, query) => resolve().costBalances(principal, query),
    bootstrapCost: (principal, request) => resolve().bootstrapCost(principal, request),
    adjust: (principal, request) => resolve().adjust(principal, request),
    count: (principal, request) => resolve().count(principal, request),
    transfer: (principal, request) => resolve().transfer(principal, request),
  };
}

function lazyPurchasingService(config: ApiConfig): MerchantPurchasingService {
  let built: MerchantPurchasingService | null = null;

  const resolve = (): MerchantPurchasingService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createMerchantPurchasingService({ prisma: createPrismaClient(url) });
    return built;
  };

  return {
    listBranches: (principal, query) => resolve().listBranches(principal, query),
    listProducts: (principal, query) => resolve().listProducts(principal, query),
    listSuppliers: (principal, query) => resolve().listSuppliers(principal, query),
    getSupplier: (principal, supplierId) => resolve().getSupplier(principal, supplierId),
    createSupplier: (principal, request) => resolve().createSupplier(principal, request),
    updateSupplier: (principal, request) => resolve().updateSupplier(principal, request),
    listPurchaseOrders: (principal, query) => resolve().listPurchaseOrders(principal, query),
    getPurchaseOrder: (principal, id) => resolve().getPurchaseOrder(principal, id),
    createPurchaseOrder: (principal, request) => resolve().createPurchaseOrder(principal, request),
    listReceipts: (principal, id, limit) => resolve().listReceipts(principal, id, limit),
    receive: (principal, request) => resolve().receive(principal, request),
  };
}

function lazyOnboardingService(config: ApiConfig): MerchantOnboardingService {
  let built: MerchantOnboardingService | null = null;

  const resolve = (): MerchantOnboardingService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    const prisma = createPrismaClient(url);
    built = createMerchantOnboardingService({
      readReadiness: (scope) => readTenantOnboardingReadiness(prisma, scope),
    });
    return built;
  };

  return { readReadiness: (principal) => resolve().readReadiness(principal) };
}

function lazyRestaurantOrderService(config: ApiConfig): MerchantRestaurantOrderService {
  let built: MerchantRestaurantOrderService | null = null;

  const resolve = (): MerchantRestaurantOrderService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createMerchantRestaurantOrderService(createPrismaClient(url));
    return built;
  };

  return {
    listOpen: (principal) => resolve().listOpen(principal),
    detail: (principal, orderId) => resolve().detail(principal, orderId),
    create: (principal, request) => resolve().create(principal, request),
    cancel: (principal, orderId, request) => resolve().cancel(principal, orderId, request),
    transferTable: (principal, orderId, request) =>
      resolve().transferTable(principal, orderId, request),
    replaceLines: (principal, orderId, request) =>
      resolve().replaceLines(principal, orderId, request),
  };
}

function lazyRestaurantPreparationService(config: ApiConfig): MerchantPreparationService {
  let built: MerchantPreparationService | null = null;
  const resolve = (): MerchantPreparationService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createMerchantPreparationService(createPrismaClient(url));
    return built;
  };
  return {
    listStations: (principal, branchId, activeOnly) =>
      resolve().listStations(principal, branchId, activeOnly),
    operationalStations: (principal) => resolve().operationalStations(principal),
    createStation: (principal, request) => resolve().createStation(principal, request),
    listRoutes: (principal, branchId) => resolve().listRoutes(principal, branchId),
    setProductRoutes: (principal, request) => resolve().setProductRoutes(principal, request),
    routing: (principal, orderId) => resolve().routing(principal, orderId),
    fire: (principal, orderId, request) => resolve().fire(principal, orderId, request),
    tasks: (principal, stationId, includeServed) =>
      resolve().tasks(principal, stationId, includeServed),
    updateTask: (principal, taskId, request) => resolve().updateTask(principal, taskId, request),
  };
}

function lazyRestaurantRecipeService(config: ApiConfig): MerchantRestaurantRecipeService {
  let built: MerchantRestaurantRecipeService | null = null;
  const resolve = (): MerchantRestaurantRecipeService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createMerchantRestaurantRecipeService(createPrismaClient(url));
    return built;
  };
  return {
    detail: (principal, productId) => resolve().detail(principal, productId),
    set: (principal, productId, request) => resolve().set(principal, productId, request),
    cost: (principal, branchId, productId) => resolve().cost(principal, branchId, productId),
    produce: (principal, productId, request) => resolve().produce(principal, productId, request),
  };
}

function lazyRestaurantWasteService(config: ApiConfig): MerchantRestaurantWasteService {
  let built: MerchantRestaurantWasteService | null = null;
  const resolve = (): MerchantRestaurantWasteService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createMerchantRestaurantWasteService(createPrismaClient(url));
    return built;
  };
  return {
    record: (principal, request) => resolve().record(principal, request),
  };
}

function lazyCustomerService(config: ApiConfig): MerchantCustomerService {
  let built: MerchantCustomerService | null = null;

  const resolve = (): MerchantCustomerService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createMerchantCustomerService(createPrismaClient(url));
    return built;
  };

  return {
    list: (principal, query) => resolve().list(principal, query),
    detail: (principal, customerId) => resolve().detail(principal, customerId),
    create: (principal, request) => resolve().create(principal, request),
    update: (principal, customerId, request) => resolve().update(principal, customerId, request),
  };
}

function lazySalesReadService(config: ApiConfig): MerchantSalesReadService {
  let built: MerchantSalesReadService | null = null;

  const resolve = (): MerchantSalesReadService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createMerchantSalesReadService(createPrismaClient(url));
    return built;
  };

  return {
    list: (principal, query) => resolve().list(principal, query),
    detail: (principal, saleId) => resolve().detail(principal, saleId),
    report: (principal, query) => resolve().report(principal, query),
  };
}

function lazyZatcaService(config: ApiConfig): MerchantZatcaService {
  let built: MerchantZatcaService | null = null;

  const resolve = (): MerchantZatcaService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createMerchantZatcaService(createPrismaClient(url));
    return built;
  };

  return { status: (principal, query) => resolve().status(principal, query) };
}

function lazyPlatformService(config: ApiConfig): PlatformService {
  let built: PlatformService | null = null;

  const resolve = (): PlatformService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createPlatformService(createPrismaClient(url));
    return built;
  };

  return {
    listTenants: (actor, query) => resolve().listTenants(actor, query),
    getTenant: (actor, tenantId) => resolve().getTenant(actor, tenantId),
    createTenant: (actor, input) => resolve().createTenant(actor, input),
    activateTenant: (actor, tenantId, operationId) =>
      resolve().activateTenant(actor, tenantId, operationId),
    suspendTenant: (actor, tenantId, operationId, reason) =>
      resolve().suspendTenant(actor, tenantId, operationId, reason),
    reactivateTenant: (actor, tenantId, operationId) =>
      resolve().reactivateTenant(actor, tenantId, operationId),
    assignPlan: (actor, tenantId, input) => resolve().assignPlan(actor, tenantId, input),
    listAudit: (actor, tenantId, input) => resolve().listAudit(actor, tenantId, input),
  };
}

function lazyPlatformSupportService(config: ApiConfig): PlatformSupportService {
  let built: PlatformSupportService | null = null;

  const resolve = (): PlatformSupportService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    built = createPlatformSupportService(createPrismaClient(url));
    return built;
  };

  return {
    list: (actor, tenantId, query) => resolve().list(actor, tenantId, query),
    create: (actor, tenantId, input) => resolve().create(actor, tenantId, input),
  };
}

function bootstrapServiceFor(config: ApiConfig): OwnerBootstrapService | null {
  const url = config.DATABASE_URL;
  const signingKey = config.BOOTSTRAP_SIGNING_KEY;
  if (url === undefined || signingKey === undefined) return null;
  return createOwnerBootstrapService({ prisma: createPrismaClient(url), signingKey });
}

export function buildServer(config: ApiConfig, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.token',
          'req.body.accessKey',
          'request.headers.authorization',
          'request.headers.cookie',
          'request.body.password',
          'request.body.token',
          'request.body.accessKey',
          'res.headers["set-cookie"]',
        ],
        censor: '[Redacted]',
      },
    },
    genReqId: () => newId(),
  });

  registerOperationalObservability(app, config);

  const service = deps.auth ?? lazyAuthService(config);
  const guards = createGuards(service, config);
  const business = deps.business ?? lazyBusinessDeps(config);
  const platformAuth = createPlatformAuth(config);

  app.addHook('onRequest', guards.enforceOrigin);

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AuthUnavailableError) {
      request.log.error('database-backed route unavailable; DATABASE_URL is missing');
      return reply.code(503).send({ error: 'unavailable' });
    }
    request.log.error(
      { errorType: error.name, statusCode: error.statusCode ?? 500 },
      'request failed',
    );
    return reply.code(error.statusCode ?? 500).send({ error: 'internal_error' });
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app, { service, guards, config });
  registerBusinessRoutes(app, { deps: business, guards, newId });
  registerRestaurantOrderRoutes(app, {
    service: deps.restaurantOrders ?? lazyRestaurantOrderService(config),
    guards,
  });
  registerRestaurantPreparationRoutes(app, {
    service: deps.restaurantPreparation ?? lazyRestaurantPreparationService(config),
    guards,
  });
  registerRestaurantRecipeRoutes(app, {
    service: deps.restaurantRecipes ?? lazyRestaurantRecipeService(config),
    guards,
  });
  registerRestaurantWasteRoutes(app, {
    service: deps.restaurantWaste ?? lazyRestaurantWasteService(config),
    guards,
  });
  registerAdminRoutes(app, { service: deps.admin ?? lazyAdminService(config), guards });
  registerCatalogAdminRoutes(app, {
    service: deps.catalog ?? lazyCatalogService(config),
    guards,
  });
  registerInventoryAdminRoutes(app, {
    service: deps.inventory ?? lazyInventoryService(config),
    guards,
  });
  registerPurchasingAdminRoutes(app, {
    service: deps.purchasing ?? lazyPurchasingService(config),
    guards,
  });
  registerBootstrapRoutes(app, {
    service: deps.bootstrap === undefined ? bootstrapServiceFor(config) : deps.bootstrap,
  });
  registerOnboardingRoutes(app, {
    service: deps.onboarding ?? lazyOnboardingService(config),
    guards,
  });
  registerCustomerRoutes(app, {
    service: deps.customers ?? lazyCustomerService(config),
    guards,
  });
  registerSalesReadRoutes(app, {
    service: deps.salesRead ?? lazySalesReadService(config),
    guards,
  });
  registerZatcaRoutes(app, {
    service: deps.zatca ?? lazyZatcaService(config),
    guards,
  });
  registerPlatformRoutes(app, {
    auth: platformAuth,
    service: deps.platform ?? lazyPlatformService(config),
  });
  registerPlatformDeviceRoutes(app, { auth: platformAuth });
  registerPlatformSupportRoutes(app, {
    auth: platformAuth,
    service: deps.platformSupport ?? lazyPlatformSupportService(config),
  });
  return app;
}
