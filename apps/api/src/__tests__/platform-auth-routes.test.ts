import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformAuth } from '../platform/auth.js';
import { createGuards } from '../auth/guards.js';
import { registerPlatformRoutes } from '../platform/routes.js';
import { loadConfig } from '../config.js';
import type { PlatformActor, PlatformService } from '../platform/service.js';
import type { AuthService } from '../auth/service.js';
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
  it('uses an independent signed short-lived session and rejects tampering or expiry', async () => {
    const auth = createPlatformAuth(config());
    const principal = auth.authenticateAccessKey(ACCESS_KEY);
    expect(principal).not.toBeNull();
    expect(auth.authenticateAccessKey(`${ACCESS_KEY}x`)).toBeNull();

    const now = new Date('2026-09-14T10:00:00.000Z');
    const token = await auth.issueSession(principal!, now);
    expect(
      (await auth.verifySession(token, new Date('2026-09-14T10:59:59.000Z')))?.controlPlaneActorRef,
    ).toBe(ACTOR);
    expect(await auth.verifySession(token, new Date('2026-09-14T11:00:00.000Z'))).toBeNull();

    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(await auth.verifySession(tampered, new Date('2026-09-14T10:30:00.000Z'))).toBeNull();
    await expect(
      auth.issueSession({
        ...principal!,
        controlPlaneActorRef: 'platform:other-operator',
      }),
    ).rejects.toThrow(/does not match configuration/i);
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
    expect(seenActor?.controlPlaneActorRef).toBe(ACTOR);

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

  it('keeps operational provisioning behind Platform authority and server-derived actor identity', async () => {
    let calls = 0;
    let seenActor: string | undefined;
    let seenTenant: string | undefined;
    let seenBranchCode: string | undefined;

    const auth = createPlatformAuth(config());
    app = Fastify({ logger: false });
    registerPlatformRoutes(app, {
      auth,
      service: recordingService(),
      operationalBootstrap: async (actor, tenantId, input) => {
        calls += 1;
        seenActor = actor.controlPlaneActorRef;
        seenTenant = tenantId;
        seenBranchCode = input.branch.code;
        return {
          branch: {
            id: '018fb000-0000-7000-8000-0000000000b1',
            code: input.branch.code,
            nameAr: input.branch.nameAr,
            nameEn: input.branch.nameEn ?? null,
            isActive: true,
          },
          terminal: {
            id: '018fb000-0000-7000-8000-0000000000c1',
            branchId: '018fb000-0000-7000-8000-0000000000b1',
            code: input.terminal.code,
            label: input.terminal.label,
            isActive: true,
          },
          replayed: false,
        };
      },
    });
    await app.ready();

    const merchantRealmCookie = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/operational-bootstrap`,
      headers: { cookie: 'korvi_session=merchant-session' },
      payload: {
        operationId: 'op-platform-1',
        branch: { code: 'BR-01', nameAr: 'الفرع الرئيسي', nameEn: null },
        terminal: { code: 'POS-01', label: 'الكاشير الرئيسي' },
      },
    });
    expect(merchantRealmCookie.statusCode).toBe(401);
    expect(calls).toBe(0);

    const principal = auth.authenticateAccessKey(ACCESS_KEY);
    if (principal === null) throw new Error('test platform credential was rejected');
    const cookie = `korvi_platform_session=${await auth.issueSession(principal)}`;

    const injectedAuthority = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/operational-bootstrap`,
      headers: { cookie },
      payload: {
        operationId: 'op-platform-1',
        controlPlaneActorRef: 'platform:attacker',
        branch: { code: 'BR-01', nameAr: 'الفرع الرئيسي', nameEn: null },
        terminal: { code: 'POS-01', label: 'الكاشير الرئيسي' },
      },
    });
    expect(injectedAuthority.statusCode).toBe(400);
    expect(injectedAuthority.json()).toEqual({ error: 'invalid_body' });
    expect(calls).toBe(0);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/operational-bootstrap`,
      headers: { cookie },
      payload: {
        operationId: 'op-platform-1',
        branch: { code: 'BR-01', nameAr: 'الفرع الرئيسي', nameEn: null },
        terminal: { code: 'POS-01', label: 'الكاشير الرئيسي' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      branch: { code: 'BR-01', isActive: true },
      terminal: { code: 'POS-01', isActive: true },
      replayed: false,
    });
    expect(calls).toBe(1);
    expect(seenActor).toBe(ACTOR);
    expect(seenTenant).toBe(TENANT_ID);
    expect(seenBranchCode).toBe('BR-01');
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

  it('revokes a platform cookie durably on logout instead of only clearing the browser copy', async () => {
    const auth = createPlatformAuth(config());
    app = Fastify({ logger: false });
    registerPlatformRoutes(app, {
      auth,
      service: recordingService(),
    });
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/v1/platform/session',
      payload: { accessKey: ACCESS_KEY },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0];

    const before = await app.inject({
      method: 'GET',
      url: '/v1/platform/tenants',
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/platform/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');

    const replay = await app.inject({
      method: 'GET',
      url: '/v1/platform/tenants',
      headers: { cookie },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: 'platform_unauthenticated' });
  });
  it('keeps the platform cookie realm behind Origin even when a request carries a KorviNative header', async () => {
    let calls = 0;
    const cfg = config();
    const auth = createPlatformAuth(cfg);
    const merchantAuth: AuthService = {
      login: async () => ({ outcome: 'failure', reason: 'unknown-tenant' }),
      authenticate: async () => ({ outcome: 'failure', reason: 'unknown-session' }),
      logout: async () => false,
      logoutAll: async () => 0,
    };

    app = Fastify({ logger: false });
    app.addHook('onRequest', createGuards(merchantAuth, cfg).enforceOrigin);
    registerPlatformRoutes(app, {
      auth,
      service: recordingService(),
      operationalBootstrap: async (_actor, _tenantId, input) => {
        calls += 1;
        return {
          branch: {
            id: '018fb000-0000-7000-8000-0000000000b1',
            code: input.branch.code,
            nameAr: input.branch.nameAr,
            nameEn: input.branch.nameEn ?? null,
            isActive: true,
          },
          terminal: {
            id: '018fb000-0000-7000-8000-0000000000c1',
            branchId: '018fb000-0000-7000-8000-0000000000b1',
            code: input.terminal.code,
            label: input.terminal.label,
            isActive: true,
          },
          replayed: false,
        };
      },
    });
    await app.ready();

    const principal = auth.authenticateAccessKey(ACCESS_KEY);
    if (principal === null) throw new Error('test platform credential was rejected');
    const cookie = `korvi_platform_session=${await auth.issueSession(principal)}`;
    const payload = {
      operationId: 'op-origin-boundary-1',
      branch: { code: 'BR-01', nameAr: 'الفرع الرئيسي', nameEn: null },
      terminal: { code: 'POS-01', label: 'الكاشير الرئيسي' },
    };

    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/operational-bootstrap`,
      headers: {
        cookie,
        origin: 'https://evil.example',
        authorization: 'KorviNative attacker-controlled',
      },
      payload,
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toEqual({ error: 'forbidden' });
    expect(calls).toBe(0);

    const legitimate = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/operational-bootstrap`,
      headers: { cookie, origin: 'http://localhost:3000' },
      payload,
    });
    expect(legitimate.statusCode).toBe(201);
    expect(calls).toBe(1);
  });
});
