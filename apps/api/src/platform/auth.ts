import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeControlPlaneActor } from '@korvi/domain';
import { readCookie } from '../auth/cookie.js';
import type { ApiConfig } from '../config.js';
import type { FastifyReply, preHandlerAsyncHookHandler } from 'fastify';

const PRODUCTION_COOKIE = '__Host-korvi_platform_session';
const DEVELOPMENT_COOKIE = 'korvi_platform_session';
const TOKEN_VERSION = 2;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PLATFORM_PERMISSIONS = [
  'platform.tenants.read',
  'platform.tenants.manage',
  'platform.commercial.manage',
  'platform.audit.read',
  'platform.support.read',
  'platform.support.manage',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export interface PlatformPrincipal {
  readonly controlPlaneActorRef: string;
  readonly expiresAt: number;
  readonly permissions: readonly PlatformPermission[];
  /** Null only before an access key has been exchanged for a persisted session. */
  readonly sessionId: string | null;
}

export interface PlatformSessionStore {
  create(input: {
    readonly id: string;
    readonly actorRef: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): Promise<void>;
  isActive(input: {
    readonly id: string;
    readonly actorRef: string;
    readonly at: Date;
  }): Promise<boolean>;
  revoke(input: {
    readonly id: string;
    readonly actorRef: string;
    readonly at: Date;
  }): Promise<boolean>;
}

export interface PlatformAuth {
  readonly configured: boolean;
  authenticateAccessKey(accessKey: string): PlatformPrincipal | null;
  issueSession(principal: PlatformPrincipal, now?: Date): Promise<string>;
  verifySession(token: string, now?: Date): Promise<PlatformPrincipal | null>;
  revokeCookieSession(cookieHeader: string | undefined, now?: Date): Promise<boolean>;
  requireSession: preHandlerAsyncHookHandler;
  requirePermission(permission: PlatformPermission): preHandlerAsyncHookHandler;
  setSessionCookie(reply: FastifyReply, token: string): void;
  clearSessionCookie(reply: FastifyReply): void;
}

declare module 'fastify' {
  interface FastifyRequest {
    platformAuth?: PlatformPrincipal;
  }
}

interface TokenPayload {
  readonly v: number;
  readonly actor: string;
  readonly sid: string;
  readonly exp: number;
}

interface MemorySession {
  readonly actorRef: string;
  readonly expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Test/development fallback only. Production buildServer injects the durable
 * PostgreSQL-backed store. Keeping this implementation here lets focused auth
 * tests prove cryptographic and revocation behavior without a database.
 */
export function createMemoryPlatformSessionStore(): PlatformSessionStore {
  const sessions = new Map<string, MemorySession>();

  return {
    async create(input) {
      const at = input.createdAt.getTime();
      for (const [id, row] of sessions) {
        if (row.expiresAt.getTime() <= at) sessions.delete(id);
      }
      sessions.set(input.id, {
        actorRef: input.actorRef,
        expiresAt: input.expiresAt,
        revokedAt: null,
      });
    },

    async isActive(input) {
      const row = sessions.get(input.id);
      return (
        row !== undefined &&
        row.actorRef === input.actorRef &&
        row.revokedAt === null &&
        row.expiresAt > input.at
      );
    },

    async revoke(input) {
      const row = sessions.get(input.id);
      if (
        row === undefined ||
        row.actorRef !== input.actorRef ||
        row.revokedAt !== null ||
        row.expiresAt <= input.at
      ) {
        return false;
      }
      row.revokedAt = input.at;
      return true;
    },
  };
}

function cookieName(isProduction: boolean): string {
  return isProduction ? PRODUCTION_COOKIE : DEVELOPMENT_COOKIE;
}

function buildCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAge)}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function digestSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function signature(input: string, key: string): string {
  return createHmac('sha256', key).update(input, 'utf8').digest('base64url');
}

function configuredValues(config: ApiConfig): {
  accessKey: string;
  signingKey: string;
  actor: string;
  ttl: number;
} | null {
  const accessKey = config.PLATFORM_ADMIN_ACCESS_KEY;
  const signingKey = config.PLATFORM_SESSION_SIGNING_KEY;
  const actor = config.PLATFORM_ADMIN_ACTOR_REF;
  if (accessKey === undefined || signingKey === undefined || actor === undefined) return null;
  return {
    accessKey,
    signingKey,
    actor: normalizeControlPlaneActor(actor),
    ttl: config.PLATFORM_SESSION_TTL_SECONDS ?? 4 * 3600,
  };
}

function principal(actor: string, expiresAt: number, sessionId: string | null): PlatformPrincipal {
  return {
    controlPlaneActorRef: actor,
    expiresAt,
    permissions: PLATFORM_PERMISSIONS,
    sessionId,
  };
}

export function createPlatformAuth(
  config: ApiConfig,
  sessionStore?: PlatformSessionStore,
): PlatformAuth {
  const values = configuredValues(config);
  if (config.isProduction && values !== null && sessionStore === undefined) {
    throw new Error('Production Platform administration requires a durable session store.');
  }
  const sessions = sessionStore ?? createMemoryPlatformSessionStore();
  const name = cookieName(config.isProduction);

  function authenticateAccessKey(accessKey: string): PlatformPrincipal | null {
    if (values === null) return null;
    const expected = digestSecret(values.accessKey);
    const provided = digestSecret(accessKey);
    if (!timingSafeEqual(expected, provided)) return null;
    return principal(values.actor, Math.floor(Date.now() / 1000) + values.ttl, null);
  }

  function parseSignedSession(token: string): TokenPayload | null {
    if (values === null || token.length > 2048) return null;
    const separator = token.lastIndexOf('.');
    if (separator <= 0 || separator === token.length - 1) return null;
    const encoded = token.slice(0, separator);
    const suppliedSignature = token.slice(separator + 1);
    const expectedSignature = signature(encoded, values.signingKey);
    const supplied = Buffer.from(suppliedSignature, 'utf8');
    const expected = Buffer.from(expectedSignature, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

    try {
      const payload = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as Partial<TokenPayload>;
      if (
        payload.v !== TOKEN_VERSION ||
        payload.actor !== values.actor ||
        typeof payload.sid !== 'string' ||
        !UUID_PATTERN.test(payload.sid) ||
        !Number.isInteger(payload.exp)
      ) {
        return null;
      }
      return payload as TokenPayload;
    } catch {
      return null;
    }
  }

  async function issueSession(subject: PlatformPrincipal, now: Date = new Date()): Promise<string> {
    if (values === null) throw new Error('Platform administration is not configured.');
    const actor = normalizeControlPlaneActor(subject.controlPlaneActorRef);
    if (actor !== values.actor) {
      throw new Error('Platform principal does not match configuration.');
    }

    const sid = randomUUID();
    const exp = Math.floor(now.getTime() / 1000) + values.ttl;
    const payload: TokenPayload = { v: TOKEN_VERSION, actor, sid, exp };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const token = `${encoded}.${signature(encoded, values.signingKey)}`;

    await sessions.create({
      id: sid,
      actorRef: actor,
      createdAt: now,
      expiresAt: new Date(exp * 1000),
    });
    return token;
  }

  async function verifySession(
    token: string,
    now: Date = new Date(),
  ): Promise<PlatformPrincipal | null> {
    const payload = parseSignedSession(token);
    if (payload === null || values === null) return null;
    if (payload.exp <= Math.floor(now.getTime() / 1000)) return null;

    const active = await sessions.isActive({
      id: payload.sid,
      actorRef: values.actor,
      at: now,
    });
    if (!active) return null;
    return principal(values.actor, payload.exp, payload.sid);
  }

  async function revokeCookieSession(
    cookieHeader: string | undefined,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (values === null) return false;
    const token = readCookie(cookieHeader, name);
    if (token === null) return false;
    const payload = parseSignedSession(token);
    if (payload === null || payload.exp <= Math.floor(now.getTime() / 1000)) return false;

    return sessions.revoke({
      id: payload.sid,
      actorRef: values.actor,
      at: now,
    });
  }

  const requireSession: preHandlerAsyncHookHandler = async (request, reply) => {
    if (values === null) {
      await reply.code(503).send({ error: 'platform_admin_not_configured' });
      return;
    }
    const token = readCookie(request.headers.cookie, name);
    if (token === null) {
      await reply.code(401).send({ error: 'platform_unauthenticated' });
      return;
    }
    const subject = await verifySession(token);
    if (subject === null) {
      clearSessionCookie(reply);
      await reply.code(401).send({ error: 'platform_unauthenticated' });
      return;
    }
    request.platformAuth = subject;
  };

  function requirePermission(permission: PlatformPermission): preHandlerAsyncHookHandler {
    return async (request, reply) => {
      const subject = request.platformAuth;
      if (subject === undefined) {
        await reply.code(401).send({ error: 'platform_unauthenticated' });
        return;
      }
      if (!subject.permissions.includes(permission)) {
        await reply.code(403).send({ error: 'platform_forbidden' });
      }
    };
  }

  function setSessionCookie(reply: FastifyReply, token: string): void {
    if (values === null) throw new Error('Platform administration is not configured.');
    reply.header('set-cookie', buildCookie(name, token, values.ttl, config.isProduction));
  }

  function clearSessionCookie(reply: FastifyReply): void {
    reply.header('set-cookie', buildCookie(name, '', 0, config.isProduction));
  }

  return {
    configured: values !== null,
    authenticateAccessKey,
    issueSession,
    verifySession,
    revokeCookieSession,
    requireSession,
    requirePermission,
    setSessionCookie,
    clearSessionCookie,
  };
}
