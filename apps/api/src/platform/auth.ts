import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { normalizeControlPlaneActor } from '@korvi/domain';
import { readCookie } from '../auth/cookie.js';
import type { ApiConfig } from '../config.js';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

const PRODUCTION_COOKIE = '__Host-korvi_platform_session';
const DEVELOPMENT_COOKIE = 'korvi_platform_session';
const TOKEN_VERSION = 1;

export interface PlatformPrincipal {
  readonly controlPlaneActorRef: string;
  readonly expiresAt: number;
}

export interface PlatformAuth {
  readonly configured: boolean;
  authenticateAccessKey(accessKey: string): PlatformPrincipal | null;
  issueSession(principal: PlatformPrincipal, now?: Date): string;
  verifySession(token: string, now?: Date): PlatformPrincipal | null;
  requireSession: preHandlerAsyncHookHandler;
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
  readonly exp: number;
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

export function createPlatformAuth(config: ApiConfig): PlatformAuth {
  const values = configuredValues(config);
  const name = cookieName(config.isProduction);

  function authenticateAccessKey(accessKey: string): PlatformPrincipal | null {
    if (values === null) return null;
    const expected = digestSecret(values.accessKey);
    const provided = digestSecret(accessKey);
    if (!timingSafeEqual(expected, provided)) return null;
    return {
      controlPlaneActorRef: values.actor,
      expiresAt: Math.floor(Date.now() / 1000) + values.ttl,
    };
  }

  function issueSession(principal: PlatformPrincipal, now: Date = new Date()): string {
    if (values === null) throw new Error('Platform administration is not configured.');
    const payload: TokenPayload = {
      v: TOKEN_VERSION,
      actor: normalizeControlPlaneActor(principal.controlPlaneActorRef),
      exp: Math.floor(now.getTime() / 1000) + values.ttl,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${encoded}.${signature(encoded, values.signingKey)}`;
  }

  function verifySession(token: string, now: Date = new Date()): PlatformPrincipal | null {
    if (values === null) return null;
    const separator = token.lastIndexOf('.');
    if (separator <= 0 || separator === token.length - 1) return null;
    const encoded = token.slice(0, separator);
    const suppliedSignature = token.slice(separator + 1);
    const expectedSignature = signature(encoded, values.signingKey);
    const supplied = Buffer.from(suppliedSignature, 'utf8');
    const expected = Buffer.from(expectedSignature, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<TokenPayload>;
      if (payload.v !== TOKEN_VERSION || payload.actor !== values.actor) return null;
      if (!Number.isInteger(payload.exp)) return null;
      const exp = payload.exp as number;
      if (exp <= Math.floor(now.getTime() / 1000)) return null;
      return { controlPlaneActorRef: values.actor, expiresAt: exp };
    } catch {
      return null;
    }
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
    const principal = verifySession(token);
    if (principal === null) {
      clearSessionCookie(reply);
      await reply.code(401).send({ error: 'platform_unauthenticated' });
      return;
    }
    request.platformAuth = principal;
  };

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
    requireSession,
    setSessionCookie,
    clearSessionCookie,
  };
}
