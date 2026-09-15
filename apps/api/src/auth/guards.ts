import { readCookie, buildClearedCookieHeader, sessionCookieName } from './cookie.js';
import { checkOrigin } from './origin.js';
import { readNativeAuthorization } from '../native-auth/header.js';
import { nativeAuthServiceFor } from '../native-auth/lazy.js';
import type { AuthService } from './service.js';
import type { NativeAuthService, NativeSessionBinding } from '../native-auth/service.js';
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
 * Browser and installed sessions deliberately share only the resulting
 * server-derived principal. `nativeAuth` exists only when the caller proved a
 * kns1 installed-client session; browser cookie authentication never sets it.
 */
declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedPrincipal;
    nativeAuth?: NativeSessionBinding;
  }
}

const UNAUTHENTICATED = { error: 'unauthenticated' } as const;
const FORBIDDEN = { error: 'forbidden' } as const;
const NATIVE_PREFIX = 'KorviNative ';

function nativeRealmAttempted(value: string | readonly string[] | undefined): boolean {
  return typeof value === 'string' && value.startsWith(NATIVE_PREFIX);
}

export interface Guards {
  readonly enforceOrigin: onRequestAsyncHookHandler;
  readonly requireSession: preHandlerAsyncHookHandler;
  requirePermission(permission: Permission): preHandlerAsyncHookHandler;
}

export function createGuards(
  service: AuthService,
  config: ApiConfig,
  nativeService?: NativeAuthService,
): Guards {
  const installed = nativeService ?? nativeAuthServiceFor(config);

  function clearCookie(reply: FastifyReply): void {
    reply.header('set-cookie', buildClearedCookieHeader(config.isProduction));
  }

  const enforceOrigin: onRequestAsyncHookHandler = async (request, reply) => {
    // The exact-Origin gate exists for ambient browser cookies. Installed
    // clients have no browser cookie authority: challenge/login are explicit
    // device-proof routes, and authenticated native writes carry KorviNative.
    // A malformed/invalid KorviNative attempt is still kept in the native realm
    // by requireSession below, so adding this prefix can never fall back to a
    // valid browser cookie as a CSRF bypass.
    if (
      request.url.startsWith('/v1/native-auth/') ||
      nativeRealmAttempted(request.headers.authorization)
    ) {
      return;
    }

    const decision = checkOrigin(request.method, request.headers.origin, config.APP_ORIGINS);
    if (!decision.allowed) {
      request.log.warn({ reason: decision.reason }, 'origin check refused a write');
      await reply.code(403).send(FORBIDDEN);
    }
  };

  const requireSession: preHandlerAsyncHookHandler = async (request, reply) => {
    // Realm selection is exclusive. Once a caller presents the KorviNative
    // scheme it can never be rescued by an unrelated valid browser cookie.
    // This prevents mixed-credential requests from becoming an Origin bypass.
    if (nativeRealmAttempted(request.headers.authorization)) {
      const nativeToken = readNativeAuthorization(request.headers.authorization);
      if (nativeToken === null || installed === undefined) {
        await reply.code(401).send(UNAUTHENTICATED);
        return;
      }
      const nativeResult = await installed.authenticate(nativeToken);
      if (nativeResult.outcome === 'failure') {
        request.log.info({ reason: nativeResult.reason }, 'native session rejected');
        await reply.code(401).send(UNAUTHENTICATED);
        return;
      }
      request.auth = nativeResult.principal;
      request.nativeAuth = nativeResult.binding;
      return;
    }

    const browserToken = readCookie(request.headers.cookie, sessionCookieName(config.isProduction));
    if (browserToken === null) {
      await reply.code(401).send(UNAUTHENTICATED);
      return;
    }

    const result = await service.authenticate(browserToken);
    if (result.outcome === 'failure') {
      request.log.info({ reason: result.reason }, 'browser session rejected');
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
