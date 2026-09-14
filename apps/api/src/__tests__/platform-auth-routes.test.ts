import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformAuth } from '../platform/auth.js';
import { registerPlatformRoutes } from '../platform/routes.js';
import { loadConfig } from '../config.js';
import type { PlatformActor, PlatformService } from '../platform/service.js';
import type { FastifyInstance } from 'fastify';

const ACCESS_KEY = 'a'.repeat(40);
const SIGNING_KEY = 'b'.repeat(40);
const ACTOR = 'platform:test-operator';
const TENANT_ID = '018fb000-0000-7000-8000-00000000000a';

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PLATFORM_ADMIN_ACCESS_KEY: ACCESS_KEY,
    PLATFORM_SESSION_SIGNING_KEY: SIGNING_KEY,
    PLATFORM_ADMIN_ACTOR_REF: ACTOR,
    PLATFORM_SESSION_TTL_HOURS: '1',
  });
}

function unused(): Promise<never> {
  return Promise.reject(new Error('unexpected platform service call'));
}

function recordingService(onList?: (actor: PlatformActor) => void): PlatformService {
  return {
    async listTenants(actor) {
      onList?.(actor);
      return { items: [], nextCursor: null };
    },
    getTenant: unused,
    createTenant: unused,
    activateTenant: unused,
    suspendTenant: unused,
    reactivateTenant: unused,
    assignPlan: unused,
    listAudit: unused,
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
});

describe('platform auth', () => {
  it('uses an independent signed short-lived session and rejects tampering or expiry', () => {
    const auth = createPlatformAuth(config());
    const principal = auth.authenticateAccessKey(ACCESS_KEY);
    expect(principal).not.toBeNull();
    expect(auth.authenticateAccessKey(`${ACCESS_KEY}x`)).toBeNull();

    const now = new Date('2026-09-14T10:00:00.000Z');
    const token = auth.issueSession(principal!, now);
    expect(
      auth.verifySession(token, new Date('2026-09-14T10:59:59.000Z'))?.controlPlaneActorRef,
    ).toBe(ACTOR);
    expect(auth.verifySession(token, new Date('2026-09-14T11:00:00.000Z'))).toBeNull();

    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(auth.verifySession(tampered, new Date('2026-09-14T10:30:00.000Z'))).toBeNull();
    expect(() =>
      auth.issueSession({
        ...principal!,
        controlPlaneActorRef: 'platform:other-operator',
      }),
    ).toThrow(/does not match configuration/i);
  });
});

describe('platform routes', () => {
  it('fails closed when the platform realm is not configured', async () => {
    app = Fastify({ logger: false });
    registerPlatformRoutes(app, {
      auth: createPlatformAuth(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })),
      service: recordingService(),
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/platform/session',
      payload: { accessKey: ACCESS_KEY },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'platform_admin_not_configured' });
  });

  it('derives the control-plane actor from the signed session, never the request', async () => {
    let seenActor: PlatformActor | undefined;
    app = Fastify({ logger: false });
    registerPlatformRoutes(app, {
      auth: createPlatformAuth(config()),
      service: recordingService((actor) => {
        seenActor = actor;
      }),
    });
    await app.ready();

    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/platform/tenants' });
    expect(unauthenticated.statusCode).toBe(401);

    const badLogin = await app.inject({
      method: 'POST',
      url: '/v1/platform/session',
      payload: { accessKey: 'not-the-key' },
    });
    expect(badLogin.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/platform/session',
      payload: { accessKey: ACCESS_KEY },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ authenticated: true });
    const setCookie = login.headers['set-cookie'];
    expect(typeof setCookie).toBe('string');
    const cookie = String(setCookie).split(';', 1)[0];
    expect(cookie).toContain('korvi_platform_session=');
    expect(String(setCookie)).toContain('HttpOnly');
    expect(String(setCookie)).toContain('SameSite=Lax');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/platform/tenants?limit=25',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [], nextCursor: null });
    expect(seenActor).toEqual({ controlPlaneActorRef: ACTOR });

    const authorityInjection = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      headers: { cookie },
      payload: {
        operationId: '018fb000-0000-7000-8000-000000000010',
        slug: 'merchant-a',
        name: 'Merchant A',
        vatNumber: null,
        vertical: 'retail',
        controlPlaneActorRef: 'platform:attacker',
      },
    });
    expect(authorityInjection.statusCode).toBe(400);
    expect(authorityInjection.json()).toEqual({ error: 'invalid_body' });
  });

  it('clears a malformed signed session instead of treating it as merchant auth', async () => {
    app = Fastify({ logger: false });
    registerPlatformRoutes(app, {
      auth: createPlatformAuth(config()),
      service: recordingService(),
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/platform/tenants/${TENANT_ID}`,
      headers: { cookie: 'korvi_platform_session=malformed.token' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'platform_unauthenticated' });
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
  });
});
