import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { createGuards } from '../auth/guards.js';
import { hashPassword } from '../auth/password.js';
import { DEVELOPMENT_COOKIE_NAME } from '../auth/cookie.js';
import {
  MemoryAuthStore,
  memoryAuditRepository,
  memoryAuthRepository,
} from './support/memory-auth.js';
import type { FastifyInstance } from 'fastify';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const TENANT = '018f3a1c-9b2e-7c4d-8e5f-00000000000a';
const USER = '018f3a1c-9b2e-7c4d-8e5f-0000000000a1';
const PASSWORD = 'a-real-password-9!';
const ORIGIN = 'http://localhost:3000';

let app: FastifyInstance;
let store: MemoryAuthStore;

beforeEach(async () => {
  store = new MemoryAuthStore();
  store.tenants.push({ id: TENANT, slug: 'korvi-a', name: 'Korvi A', status: 'active' });
  store.users.push({
    id: USER,
    tenantId: TENANT,
    email: 'sara@korvi-a.test',
    displayName: 'سارة',
    passwordHash: await hashPassword(PASSWORD, FAST),
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    authVersion: 1,
    lastLoginAt: null,
  });
  store.memberships.push({
    tenantId: TENANT,
    userId: USER,
    status: 'active',
    defaultBranchId: null,
  });
  store.grants.push({
    tenantId: TENANT,
    userId: USER,
    roles: ['cashier'],
    permissions: [...ROLE_PERMISSIONS.cashier],
  });

  const auth = createAuthService({
    repository: memoryAuthRepository(store),
    audit: memoryAuditRepository(store),
    sessionTtlSeconds: 3600,
    scrypt: FAST,
  });

  app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), { auth });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function cookieFrom(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  return raw.split(';')[0] ?? '';
}

async function loginOk(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return cookieFrom(response.headers['set-cookie']);
}

describe('POST /v1/auth/login', () => {
  it('sets an HttpOnly, SameSite=Lax, host-scoped cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });

    const header = Array.isArray(response.headers['set-cookie'])
      ? (response.headers['set-cookie'][0] ?? '')
      : (response.headers['set-cookie'] ?? '');
    expect(header).toContain(`${DEVELOPMENT_COOKIE_NAME}=kps1.`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).not.toContain('Domain=');
  });

  it('returns a principal and no secret of any kind', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });

    const body = response.json<Record<string, unknown>>();
    expect(body['roles']).toEqual(['cashier']);
    expect(body['permissions']).toEqual([...ROLE_PERMISSIONS.cashier]);
    // A cashier may not discount. The figure is derived from the role on the
    // server; the client has no way to influence it.
    expect(body['maxDiscountBasisPoints']).toBe('0');

    const raw = response.payload;
    expect(raw).not.toContain('kps1.');
    expect(raw).not.toContain('scrypt$');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('tokenHash');
    expect(raw).not.toContain(PASSWORD);
  });

  it.each([
    ['a wrong password', { password: 'nope' }],
    ['an unknown email', { email: 'ghost@korvi-a.test' }],
    ['an unknown tenant', { tenantSlug: 'ghost-shop' }],
    ['a malformed body', { email: '' }],
  ])('answers %s with one indistinguishable failure', async (_label, overrides) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: {
        tenantSlug: 'korvi-a',
        email: 'sara@korvi-a.test',
        password: PASSWORD,
        ...overrides,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'invalid_credentials' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a login posted from another origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a login posted with no origin at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /v1/auth/me', () => {
  it('refuses without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthenticated' });
  });

  it('refuses a forged cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: `${DEVELOPMENT_COOKIE_NAME}=kps1.${TENANT}.${'a'.repeat(43)}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the server-derived principal for a live session', async () => {
    const cookie = await loginOk();
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body['user']).toMatchObject({ id: USER, email: 'sara@korvi-a.test' });
    expect(body['tenant']).toMatchObject({ id: TENANT });
    expect(response.payload).not.toContain('kps1.');
  });

  it('ignores a role or permission the client tries to assert', async () => {
    // The one thing this whole strike exists to guarantee. Nothing on the
    // request can add a capability the database did not grant.
    const cookie = await loginOk();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me?role=owner&permissions=sale.discount',
      headers: { cookie, 'x-korvi-role': 'owner', 'x-korvi-permissions': 'settings.manage' },
    });

    const body = response.json<Record<string, unknown>>();
    expect(body['roles']).toEqual(['cashier']);
    expect(body['permissions']).not.toContain('settings.manage');
    expect(body['maxDiscountBasisPoints']).toBe('0');
  });

  it('stops working the moment the session is revoked', async () => {
    const cookie = await loginOk();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: ORIGIN },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /v1/auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const cookie = await loginOk();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: ORIGIN },
    });

    expect(response.statusCode).toBe(204);
    const header = Array.isArray(response.headers['set-cookie'])
      ? (response.headers['set-cookie'][0] ?? '')
      : (response.headers['set-cookie'] ?? '');
    expect(header).toContain('Max-Age=0');
    expect(store.sessions.every((session) => session.revokedAt !== null)).toBe(true);
  });

  it('clears the cookie even when there was no session to revoke', async () => {
    // Otherwise the answer distinguishes "already revoked" from "never
    // existed", and the browser keeps a dead token either way.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(204);
  });
});

describe('POST /v1/auth/logout-all', () => {
  it('revokes every session the user holds', async () => {
    await loginOk();
    const cookie = await loginOk();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { cookie, origin: ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: 2 });
  });
});

describe('requirePermission, over HTTP', () => {
  /**
   * A probe route, registered only here.
   *
   * The guard is worth nothing if it is only ever exercised as a function: what
   * matters is what Fastify returns when it refuses. Adding a real business
   * endpoint to prove that would be shipping a route for a test's benefit, so
   * the probe lives in the test file and nowhere else.
   */
  async function probeServer(role: 'cashier' | 'manager'): Promise<FastifyInstance> {
    const grant = store.grants.findIndex((candidate) => candidate.userId === USER);
    store.grants[grant] = {
      tenantId: TENANT,
      userId: USER,
      roles: [role],
      permissions: [...ROLE_PERMISSIONS[role]],
    };

    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
    const service = createAuthService({
      repository: memoryAuthRepository(store),
      audit: memoryAuditRepository(store),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    });
    const guards = createGuards(service, config);
    const probe = buildServer(config, { auth: service });
    const preHandler = [guards.requireSession, guards.requirePermission('sale.discount')];
    probe.get('/__probe__/discount', { preHandler }, (request) => ({
      ok: true,
      userId: request.auth?.userId,
      roles: request.auth?.roles,
    }));
    probe.post('/__probe__/discount', { preHandler }, (request) => ({
      ok: true,
      userId: request.auth?.userId,
    }));
    await probe.ready();
    return probe;
  }

  async function cookieFor(probe: FastifyInstance): Promise<string> {
    const response = await probe.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieFrom(response.headers['set-cookie']);
  }

  it('runs the handler when the principal holds the permission', async () => {
    const probe = await probeServer('manager');
    const cookie = await cookieFor(probe);

    const response = await probe.inject({
      method: 'GET',
      url: '/__probe__/discount',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, userId: USER, roles: ['manager'] });
    await probe.close();
  });

  it('answers 403 when the principal does not', async () => {
    const probe = await probeServer('cashier');
    const cookie = await cookieFor(probe);

    const response = await probe.inject({
      method: 'GET',
      url: '/__probe__/discount',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden' });
    await probe.close();
  });

  it('answers 401 when there is no session at all', async () => {
    // Not 403: the difference between "I do not know you" and "I know you and
    // the answer is no" is the difference between two support calls.
    const probe = await probeServer('cashier');
    const response = await probe.inject({ method: 'GET', url: '/__probe__/discount' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthenticated' });
    await probe.close();
  });

  it.each([
    ['a query string', '/__probe__/discount?role=owner&permission=sale.discount', {}],
    [
      'headers',
      '/__probe__/discount',
      { 'x-korvi-role': 'owner', 'x-korvi-permissions': 'sale.discount,settings.manage' },
    ],
  ])('ignores %s claiming the permission', async (_label, url, headers) => {
    const probe = await probeServer('cashier');
    const cookie = await cookieFor(probe);

    const response = await probe.inject({
      method: 'GET',
      url,
      headers: { cookie, ...headers },
    });
    expect(response.statusCode).toBe(403);
    await probe.close();
  });

  it('ignores a body claiming the permission on a write', async () => {
    const probe = await probeServer('cashier');
    const cookie = await cookieFor(probe);

    const response = await probe.inject({
      method: 'POST',
      url: '/__probe__/discount',
      headers: { cookie, origin: ORIGIN },
      payload: { role: 'owner', permissions: ['sale.discount'], tenantId: TENANT },
    });
    expect(response.statusCode).toBe(403);
    await probe.close();
  });

  it('grants the same route to a manager, so the 403s above are the guard', async () => {
    // Without this the four refusals could all be a broken route rather than a
    // working permission check.
    const probe = await probeServer('manager');
    const cookie = await cookieFor(probe);

    const response = await probe.inject({
      method: 'POST',
      url: '/__probe__/discount',
      headers: { cookie, origin: ORIGIN },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    await probe.close();
  });
});

describe('when authentication is not configured', () => {
  it('answers 503 rather than a credential failure', async () => {
    // A missing DATABASE_URL is an operator's problem. Reporting it as
    // "invalid credentials" sends everyone looking in the wrong place.
    const bare = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }));
    await bare.ready();
    const response = await bare.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(503);
    await bare.close();
  });
});
