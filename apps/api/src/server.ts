import Fastify from 'fastify';
import {
  createAuditRepository,
  createAuthRepository,
  createDashboardRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createReturnRepository,
  createSaleRepository,
  createShiftRepository,
  createTenantRepository,
  createTerminalRepository,
  readTenantOnboardingReadiness,
} from '@korvi/database';
import { newId } from '@korvi/domain';
import { createMerchantAdminService } from './admin/service.js';
import { createGuards } from './auth/guards.js';
import { createAuthService } from './auth/service.js';
import { createOwnerBootstrapService } from './bootstrap/service.js';
import { createMerchantProductService } from './catalog/service.js';
import { createCheckoutService } from './checkout/service.js';
import { createMerchantInventoryService } from './inventory/service.js';
import { createMerchantOnboardingService } from './onboarding/service.js';
import { createMerchantPurchasingService } from './purchasing/service.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBootstrapRoutes } from './routes/bootstrap.js';
import { registerBusinessRoutes } from './routes/business.js';
import { registerCatalogAdminRoutes } from './routes/catalog-admin.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInventoryAdminRoutes } from './routes/inventory-admin.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerPurchasingAdminRoutes } from './routes/purchasing-admin.js';
import { createReturnService } from './returns/service.js';
import { createDrawerService } from './shifts/service.js';
import type { PrismaClient } from '@korvi/database';
import type { MerchantAdminService } from './admin/service.js';
import type { AuthService } from './auth/service.js';
import type { OwnerBootstrapService } from './bootstrap/service.js';
import type { MerchantProductService } from './catalog/service.js';
import type { ApiConfig } from './config.js';
import type { MerchantInventoryService } from './inventory/service.js';
import type { MerchantOnboardingService } from './onboarding/service.js';
import type { MerchantPurchasingService } from './purchasing/service.js';
import type { BusinessDeps } from './routes/business.js';
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
  /** The merchant's own administration authority. */
  readonly admin?: MerchantAdminService;
  /** Narrow catalogue write used by onboarding and back-office product creation. */
  readonly catalog?: MerchantProductService;
  /** Merchant stock authority: adjustments, counts and branch transfers. */
  readonly inventory?: MerchantInventoryService;
  /** Purchasing and receiving authority: suppliers, purchase orders, receipts. */
  readonly purchasing?: MerchantPurchasingService;
  /** Read-only onboarding readiness authority. */
  readonly onboarding?: MerchantOnboardingService;
  /**
   * Operational readiness override for tests. Production uses the shared
   * restricted application database authority below.
   */
  readonly readiness?: () => Promise<boolean>;
}

class AuthUnavailableError extends Error {
  public override readonly name = 'AuthUnavailableError';
}

interface DatabaseAuthority {
  readonly get: () => PrismaClient;
  readonly ready: () => Promise<boolean>;
  readonly close: () => Promise<void>;
}

/**
 * One application database authority per process.
 *
 * Before this authority existed, each lazy service created its own Prisma
 * client/pool. That multiplied database connections by API surface and left no
 * single lifecycle hook capable of draining them. Sharing the client is safe
 * because tenant authority is transaction-local (`SET LOCAL`) rather than
 * mutable client-global state.
 */
function createDatabaseAuthority(config: ApiConfig): DatabaseAuthority {
  let prisma: PrismaClient | null = null;

  const get = (): PrismaClient => {
    if (prisma !== null) return prisma;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    prisma = createPrismaClient(url);
    return prisma;
  };

  return {
    get,
    ready: async () => {
      try {
        await get().$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    close: async () => {
      if (prisma === null) return;
      const current = prisma;
      prisma = null;
      await current.$disconnect();
    },
  };
}

function lazyAuthService(config: ApiConfig, database: DatabaseAuthority): AuthService {
  let built: AuthService | null = null;

  const resolve = (): AuthService => {
    if (built !== null) return built;
    const prisma = database.get();
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

/** The cashier's persistence, built once on first use from the shared client. */
function lazyBusinessDeps(database: DatabaseAuthority): BusinessDeps {
  let built: BusinessDeps | null = null;

  const resolve = (): BusinessDeps => {
    if (built !== null) return built;
    const prisma = database.get();
    const products = createProductRepository(prisma);
    const shifts = createShiftRepository(prisma);
    const terminals = createTerminalRepository(prisma);
    const tenants = createTenantRepository(prisma);
    const dashboard = createDashboardRepository(prisma);
    const idempotency = createIdempotencyRepository(prisma);
    const audit = createAuditRepository(prisma);
    built = {
      tenants,
      dashboard,
      products,
      shifts,
      terminals,
      checkout: createCheckoutService({
        tenants,
        products,
        inventory: createInventoryRepository(prisma),
        shifts,
        sales: createSaleRepository(prisma),
        idempotency,
        audit,
      }),
      drawer: createDrawerService({
        shifts,
        terminals,
        idempotency,
        audit,
      }),
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

/** Merchant administration, built once on first use from the shared client. */
function lazyAdminService(database: DatabaseAuthority): MerchantAdminService {
  let built: MerchantAdminService | null = null;

  const resolve = (): MerchantAdminService => {
    if (built !== null) return built;
    const prisma = database.get();
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

function lazyCatalogService(database: DatabaseAuthority): MerchantProductService {
  let built: MerchantProductService | null = null;
  const resolve = (): MerchantProductService => {
    if (built !== null) return built;
    built = createMerchantProductService(database.get());
    return built;
  };
  return { create: (principal, input) => resolve().create(principal, input) };
}

function lazyInventoryService(database: DatabaseAuthority): MerchantInventoryService {
  let built: MerchantInventoryService | null = null;
  const resolve = (): MerchantInventoryService => {
    if (built !== null) return built;
    built = createMerchantInventoryService({ prisma: database.get() });
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

function lazyPurchasingService(database: DatabaseAuthority): MerchantPurchasingService {
  let built: MerchantPurchasingService | null = null;
  const resolve = (): MerchantPurchasingService => {
    if (built !== null) return built;
    built = createMerchantPurchasingService({ prisma: database.get() });
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

function lazyOnboardingService(database: DatabaseAuthority): MerchantOnboardingService {
  let built: MerchantOnboardingService | null = null;
  const resolve = (): MerchantOnboardingService => {
    if (built !== null) return built;
    const prisma = database.get();
    built = createMerchantOnboardingService({
      readReadiness: (scope) => readTenantOnboardingReadiness(prisma, scope),
    });
    return built;
  };
  return { readReadiness: (principal) => resolve().readReadiness(principal) };
}

function bootstrapServiceFor(
  config: ApiConfig,
  database: DatabaseAuthority,
): OwnerBootstrapService | null {
  if (config.DATABASE_URL === undefined || config.BOOTSTRAP_SIGNING_KEY === undefined) return null;
  return createOwnerBootstrapService({
    prisma: database.get(),
    signingKey: config.BOOTSTRAP_SIGNING_KEY,
  });
}

export function buildServer(config: ApiConfig, deps: ServerDeps = {}): FastifyInstance {
  const database = createDatabaseAuthority(config);
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
    },
    // The central Korvi generator, not crypto.randomUUID. A v4 carries no
    // time, so a request log line could not be ordered against a sale that was
    // rung up offline and synced later. Every identifier in the system comes
    // from one place (ADR-0003).
    genReqId: () => newId(),
  });

  const service = deps.auth ?? lazyAuthService(config, database);
  const guards = createGuards(service, config);
  const business = deps.business ?? lazyBusinessDeps(database);

  // One process owns one lazy Prisma client; Fastify shutdown drains it.
  app.addHook('onClose', async () => database.close());

  // Before anything else: a state-changing request from an origin this
  // deployment does not know never reaches a handler.
  app.addHook('onRequest', guards.enforceOrigin);

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AuthUnavailableError) {
      request.log.error('database service is not configured');
      return reply.code(503).send({ error: 'unavailable' });
    }
    // The message stays in the server log. The client receives only the public
    // error code and never a database/credential-bearing exception string.
    request.log.error(error);
    return reply.code(error.statusCode ?? 500).send({ error: 'internal_error' });
  });

  registerHealthRoutes(app, { readiness: deps.readiness ?? database.ready });
  registerAuthRoutes(app, { service, guards, config });
  registerBusinessRoutes(app, { deps: business, guards, newId });
  registerAdminRoutes(app, { service: deps.admin ?? lazyAdminService(database), guards });
  registerCatalogAdminRoutes(app, {
    service: deps.catalog ?? lazyCatalogService(database),
    guards,
  });
  registerInventoryAdminRoutes(app, {
    service: deps.inventory ?? lazyInventoryService(database),
    guards,
  });
  registerPurchasingAdminRoutes(app, {
    service: deps.purchasing ?? lazyPurchasingService(database),
    guards,
  });
  registerBootstrapRoutes(app, {
    service:
      deps.bootstrap === undefined ? bootstrapServiceFor(config, database) : deps.bootstrap,
  });
  registerOnboardingRoutes(app, {
    service: deps.onboarding ?? lazyOnboardingService(database),
    guards,
  });
  return app;
}
