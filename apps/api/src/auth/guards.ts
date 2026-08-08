import { readCookie, buildClearedCookieHeader, sessionCookieName } from './cookie.js';
import { checkOrigin } from './origin.js';
import type { AuthService } from './service.js';
import type { ApiConfig } from '../config.js';
import type { AuthenticatedPrincipal, Permission } from '@korvi/domain';
import type {
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';

/**
 * `request.auth` is the only place a handler may learn who is calling.
 *
 * Declared optional rather than always present, so TypeScript forces a route
 * that reads it to have run the guard that sets it. A non-optional field would
 * typecheck in a handler nobody guarded.
 */
declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedPrincipal;
  }
}

/**
 * The two responses this layer gives, and the difference between them.
 *
 * 401 means "I do not know who you are" — no session, or one that has expired,
 * been revoked, or belongs to a user who has been deactivated. 403 means "I
 * know exactly who you are and you may not do this". Collapsing them would make
 * an expired session look like a permissions bug to every support call.
 *
 * Neither says which. `reason` stays in the log.
 */
const UNAUTHENTICATED = { error: 'unauthenticated' } as const;
const FORBIDDEN = { error: 'forbidden' } as const;

export interface Guards {
  readonly enforceOrigin: onRequestAsyncHookHandler;
  readonly requireSession: preHandlerAsyncHookHandler;
  requirePermission(permission: Permission): preHandlerAsyncHookHandler;
}

export function createGuards(service: AuthService, config: ApiConfig): Guards {
  function clearCookie(reply: FastifyReply): void {
    reply.header('set-cookie', buildClearedCookieHeader(config.isProduction));
  }

  const enforceOrigin: onRequestAsyncHookHandler = async (request, reply) => {
    const decision = checkOrigin(request.method, request.headers.origin, config.APP_ORIGINS);
    if (!decision.allowed) {
      request.log.warn({ reason: decision.reason }, 'origin check refused a write');
      await reply.code(403).send(FORBIDDEN);
    }
  };

  const requireSession: preHandlerAsyncHookHandler = async (request, reply) => {
    const raw = readCookie(request.headers.cookie, sessionCookieName(config.isProduction));
    if (raw === null) {
      await reply.code(401).send(UNAUTHENTICATED);
      return;
    }

    const result = await service.authenticate(raw);
    if (result.outcome === 'failure') {
      // The cookie is cleared on the way out. Leaving a dead token in the
      // browser means every subsequent request pays for a database lookup that
      // cannot succeed.
      request.log.info({ reason: result.reason }, 'session rejected');
      clearCookie(reply);
      await reply.code(401).send(UNAUTHENTICATED);
      return;
    }

    request.auth = result.principal;
  };

  function requirePermission(permission: Permission): preHandlerAsyncHookHandler {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.auth;
      if (principal === undefined) {
        // Reached only if a route wires requirePermission without
        // requireSession. Refusing is the correct answer; so is saying so.
        request.log.error('requirePermission ran without a session guard');
        await reply.code(401).send(UNAUTHENTICATED);
        return;
      }
      if (!principal.permissions.includes(permission)) {
        request.log.info({ permission, userId: principal.userId }, 'permission denied');
        await reply.code(403).send(FORBIDDEN);
      }
    };
  }

  return { enforceOrigin, requireSession, requirePermission };
}
