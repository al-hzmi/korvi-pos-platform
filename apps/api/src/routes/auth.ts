import { z } from 'zod';
import {
  buildClearedCookieHeader,
  buildSessionCookie,
  readCookie,
  sessionCookieName,
} from '../auth/cookie.js';
import { createLoginAdmissionController } from '../auth/login-admission.js';
import { nativeAuthServiceFor } from '../native-auth/lazy.js';
import { registerNativeAuthRoutes } from './native-auth.js';
import type { LoginAdmissionController } from '../auth/login-admission.js';
import type { Guards } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import type { ApiConfig } from '../config.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

/**
 * The browser authentication surface. Native installed-cashier authentication
 * is registered alongside it but has a separate token format, persistence
 * table and route prefix.
 */

const loginBody = z.object({
  tenantSlug: z.string().min(1).max(64),
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
});

/** One body for every credential failure, whatever actually went wrong. */
const INVALID_CREDENTIALS = { error: 'invalid_credentials' } as const;
const TOO_MANY_REQUESTS = { error: 'too_many_requests' } as const;

function safePrincipal(principal: AuthenticatedPrincipal): Record<string, unknown> {
  return {
    user: {
      id: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
    },
    tenant: {
      id: principal.tenantId,
      ...(principal.tenantSlug === '' ? {} : { slug: principal.tenantSlug }),
    },
    session: { id: principal.sessionId },
    roles: principal.roles,
    permissions: principal.permissions,
    maxDiscountBasisPoints: principal.maxDiscountBasisPoints.toString(),
    branchId: principal.branchId,
  };
}

export interface AuthRouteOptions {
  readonly service: AuthService;
  readonly guards: Guards;
  readonly config: ApiConfig;
  /** Test seam; production uses the fail-closed application admission policy. */
  readonly loginAdmission?: LoginAdmissionController;
}

function admissionController(config: ApiConfig): LoginAdmissionController {
  const globalLimit = config.AUTH_LOGIN_GLOBAL_LIMIT;
  const identityLimit = config.AUTH_LOGIN_IDENTITY_LIMIT;
  const windowMs = config.AUTH_LOGIN_WINDOW_MS;
  const maxConcurrent = config.AUTH_LOGIN_MAX_CONCURRENT;
  const maxTrackedIdentities = config.AUTH_LOGIN_MAX_TRACKED_IDENTITIES;

  const allAbsent =
    globalLimit === undefined &&
    identityLimit === undefined &&
    windowMs === undefined &&
    maxConcurrent === undefined &&
    maxTrackedIdentities === undefined;

  if (allAbsent) {
    if (config.NODE_ENV !== 'test') {
      throw new Error('Login admission policy is required outside NODE_ENV=test.');
    }
    return createLoginAdmissionController();
  }

  if (
    globalLimit === undefined ||
    identityLimit === undefined ||
    windowMs === undefined ||
    maxConcurrent === undefined ||
    maxTrackedIdentities === undefined
  ) {
    throw new Error('Login admission policy must define all five controls together.');
  }

  return createLoginAdmissionController({
    globalLimit,
    identityLimit,
    windowMs,
    maxConcurrent,
    maxTrackedIdentities,
  });
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { service, guards, config } = options;
  const loginAdmission = options.loginAdmission ?? admissionController(config);

  app.post('/v1/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(401).send(INVALID_CREDENTIALS);

    const permit = loginAdmission.admit(parsed.data.tenantSlug, parsed.data.email);
    if (!permit.allowed) {
      request.log.warn({ reason: permit.reason }, 'login admission refused');
      reply.header('retry-after', String(permit.retryAfterSeconds));
      return reply.code(429).send(TOO_MANY_REQUESTS);
    }

    try {
      const result = await service.login({
        tenantSlug: parsed.data.tenantSlug,
        email: parsed.data.email,
        password: parsed.data.password,
        userAgent: request.headers['user-agent'] ?? null,
      });

      if (result.outcome === 'failure') {
        request.log.info({ reason: result.reason }, 'login refused');
        return reply.code(401).send(INVALID_CREDENTIALS);
      }

      reply.header(
        'set-cookie',
        buildSessionCookie(result.token, {
          isProduction: config.isProduction,
          maxAgeSeconds: config.SESSION_TTL_SECONDS,
        }),
      );
      return reply
        .code(200)
        .send({ ...safePrincipal(result.principal), expiresAt: result.expiresAt });
    } finally {
      permit.release();
    }
  });

  app.get('/v1/auth/me', { preHandler: guards.requireSession }, async (request, reply) => {
    const principal = request.auth;
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.code(200).send(safePrincipal(principal));
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const raw = readCookie(request.headers.cookie, sessionCookieName(config.isProduction));
    if (raw !== null) await service.logout(raw);
    reply.header('set-cookie', buildClearedCookieHeader(config.isProduction));
    return reply.code(204).send();
  });

  app.post('/v1/auth/logout-all', { preHandler: guards.requireSession }, async (request, reply) => {
    const raw = readCookie(request.headers.cookie, sessionCookieName(config.isProduction));
    const revoked = raw === null ? 0 : await service.logoutAll(raw);
    reply.header('set-cookie', buildClearedCookieHeader(config.isProduction));
    return reply.code(200).send({ revoked });
  });

  const native = nativeAuthServiceFor(config);
  if (native !== undefined) registerNativeAuthRoutes(app, { service: native });
}
