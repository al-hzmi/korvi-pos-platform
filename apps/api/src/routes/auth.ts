import { z } from 'zod';
import {
  buildClearedCookieHeader,
  buildSessionCookie,
  readCookie,
  sessionCookieName,
} from '../auth/cookie.js';
import { createLoginAdmissionController } from '../auth/login-admission.js';
import type { LoginAdmissionController } from '../auth/login-admission.js';
import type { Guards } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import type { ApiConfig } from '../config.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

/**
 * The authentication surface. Three routes, plus one convenience.
 *
 * Nothing here reads a tenant, a role or a permission from the request. The
 * only thing the client supplies is a slug, an address and a password on the
 * way in, and a cookie afterwards; everything else is read from the database
 * on the server (ADR-0012).
 */

const loginBody = z.object({
  tenantSlug: z.string().min(1).max(64),
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
});

/** One body for every credential failure, whatever actually went wrong. */
const INVALID_CREDENTIALS = { error: 'invalid_credentials' } as const;
const TOO_MANY_REQUESTS = { error: 'too_many_requests' } as const;

/**
 * What a client is allowed to know about itself.
 *
 * Built field by field rather than by spreading the principal: a spread picks
 * up whatever is added to the type later, and the next field added might be one
 * that should not cross the wire.
 */
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
    // A bigint cannot be JSON-serialised, and a number would lose precision at
    // a scale this value will never reach — but the convention is the same
    // everywhere in Korvi, so it crosses as a string (ADR-0002).
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

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { service, guards, config } = options;
  // One controller per server process. Creating it inside the handler would
  // reset counters on every request and turn the protection into decoration.
  const loginAdmission =
    options.loginAdmission ??
    createLoginAdmissionController({
      globalLimit: config.AUTH_LOGIN_GLOBAL_LIMIT,
      identityLimit: config.AUTH_LOGIN_IDENTITY_LIMIT,
      windowMs: config.AUTH_LOGIN_WINDOW_MS,
      maxConcurrent: config.AUTH_LOGIN_MAX_CONCURRENT,
      maxTrackedIdentities: config.AUTH_LOGIN_MAX_TRACKED_IDENTITIES,
    });

  app.post('/v1/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      // A malformed body never reaches tenant lookup or a KDF, so rejecting it
      // immediately is both cheaper and reveals no account-existence fact.
      return reply.code(401).send(INVALID_CREDENTIALS);
    }

    // Admission happens before tenant lookup and before every real/dummy scrypt
    // verification. The identity key is canonical and hashed inside the
    // controller; rotating identities is still bounded by the process-wide
    // budget, and KDF work is never queued without bound.
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
      // The token is in the cookie and nowhere else. A copy in the body would be
      // readable by any script on the page, which is the whole thing HttpOnly is
      // there to prevent.
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

    // The cookie is cleared whether or not a session was found. A logout that
    // reports "no such session" tells a caller their stolen token has already
    // been revoked, and leaves the browser holding it either way.
    reply.header('set-cookie', buildClearedCookieHeader(config.isProduction));
    return reply.code(204).send();
  });

  app.post('/v1/auth/logout-all', { preHandler: guards.requireSession }, async (request, reply) => {
    const raw = readCookie(request.headers.cookie, sessionCookieName(config.isProduction));
    const revoked = raw === null ? 0 : await service.logoutAll(raw);
    reply.header('set-cookie', buildClearedCookieHeader(config.isProduction));
    return reply.code(200).send({ revoked });
  });
}
