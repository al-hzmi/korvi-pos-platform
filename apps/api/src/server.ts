import Fastify from 'fastify';
import {
  createAuditRepository,
  createDashboardRepository,
  createAuthRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createSaleRepository,
  createReturnRepository,
  createShiftRepository,
  createTenantRepository,
  createTerminalRepository,
} from '@korvi/database';
import { newId } from '@korvi/domain';
import { createGuards } from './auth/guards.js';
import { createCheckoutService } from './checkout/service.js';
import { createReturnService } from './returns/service.js';
import { createDrawerService } from './shifts/service.js';
import { registerBusinessRoutes } from './routes/business.js';
import { createMerchantAdminService } from './admin/service.js';
import { registerAdminRoutes } from './routes/admin.js';
import { createAuthService } from './auth/service.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import type { AuthService } from './auth/service.js';
import type { MerchantAdminService } from './admin/service.js';
import type { BusinessDeps } from './routes/business.js';
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
   * The merchant's own administration authority.
   *
   * Supplied by tests; built from DATABASE_URL on first use otherwise, for the
   * same reason the two above are. It is a separate dependency rather than a
   * member of `business` because the till and the back office are different
   * surfaces with different permissions, and bundling them would make it
   * easy to hand a cashier's route an administrator's service.
   */
  readonly admin?: MerchantAdminService;
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

/**
 * The cashier's persistence, built once, on first use.
 *
 * Same shape as the auth service above and for the same reason: a process that
 * only answers /health should not open a connection, and a missing
 * DATABASE_URL is an operator's problem reported as 503 rather than a
 * credential failure.
 */
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

/**
 * Merchant administration, built once, on first use.
 *
 * Reading settings goes through the same tenant repository the till uses, so
 * there is one definition of what a tenant's settings are rather than two that
 * can drift.
 */
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
          // The persisted value, from the one settings model. A constant here
          // would mean PATCH true, GET false — a read that contradicts the row
          // it claims to describe.
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

export function buildServer(config: ApiConfig, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // The central Korvi generator, not crypto.randomUUID. A v4 carries no
    // time, so a request log line could not be ordered against a sale that was
    // rung up offline and synced later. Every identifier in the system comes
    // from one place (ADR-0003).
    genReqId: () => newId(),
  });

  const service = deps.auth ?? lazyAuthService(config);
  const guards = createGuards(service, config);
  const business = deps.business ?? lazyBusinessDeps(config);

  // Before anything else: a state-changing request from an origin this
  // deployment does not know never reaches a handler.
  app.addHook('onRequest', guards.enforceOrigin);

  // A configuration gap must not read as a credential failure. Without a
  // database the auth routes answer 503, which is what it is.
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AuthUnavailableError) {
      request.log.error('authentication is not configured; DATABASE_URL is missing');
      return reply.code(503).send({ error: 'unavailable' });
    }
    // The message stays in the log. A handler that echoes it has told the
    // caller what the database is called.
    request.log.error(error);
    return reply.code(error.statusCode ?? 500).send({ error: 'internal_error' });
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app, { service, guards, config });
  registerBusinessRoutes(app, { deps: business, guards, newId });
  registerAdminRoutes(app, { service: deps.admin ?? lazyAdminService(config), guards });
  return app;
}
