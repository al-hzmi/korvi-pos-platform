import Fastify from 'fastify';
import {
  createAuditRepository,
  createAuthRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createSaleRepository,
  createShiftRepository,
  createTenantRepository,
  createTerminalRepository,
} from '@korvi/database';
import { newId } from '@korvi/domain';
import { createGuards } from './auth/guards.js';
import { createCheckoutService } from './checkout/service.js';
import { registerBusinessRoutes } from './routes/business.js';
import { createAuthService } from './auth/service.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import type { AuthService } from './auth/service.js';
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
    built = {
      products,
      shifts,
      terminals,
      checkout: createCheckoutService({
        tenants: createTenantRepository(prisma),
        products,
        inventory: createInventoryRepository(prisma),
        shifts,
        sales: createSaleRepository(prisma),
        idempotency: createIdempotencyRepository(prisma),
        audit: createAuditRepository(prisma),
      }),
    };
    return built;
  };

  return {
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
      recordCashMovement: (scope, movement) => resolve().shifts.recordCashMovement(scope, movement),
      close: (scope, input) => resolve().shifts.close(scope, input),
    },
    terminals: {
      findById: (scope, id) => resolve().terminals.findById(scope, id),
      findByCode: (scope, code) => resolve().terminals.findByCode(scope, code),
      listForBranch: (scope, branchId) => resolve().terminals.listForBranch(scope, branchId),
      markSeen: (scope, id, at) => resolve().terminals.markSeen(scope, id, at),
    },
    checkout: { checkout: (input) => resolve().checkout.checkout(input) },
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
  return app;
}
