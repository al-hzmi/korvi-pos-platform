import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { createCheckoutService } from '../checkout/service.js';
import { createReturnService } from '../returns/service.js';
import { createDrawerService } from '../shifts/service.js';
import {
  MemoryAuthStore,
  memoryAuditRepository as memoryAuthAudit,
  memoryAuthRepository,
} from './support/memory-auth.js';
import {
  MemoryBusinessStore,
  memoryAuditRepository,
  memoryDashboardRepository,
  memoryIdempotencyRepository,
  memoryInventoryRepository,
  memoryProductRepository,
  memoryReturnRepository,
  memorySaleRepository,
  memoryShiftRepository,
  memoryTenantRepository,
  memoryTerminalRepository,
  seedStore,
} from './support/memory-business.js';
import { recordingAdminService } from './support/recording-admin.js';
import type { AdminCall, RecordingAdmin } from './support/recording-admin.js';
import type { AdminFailureReason } from '../admin/service.js';
import type { Fixture } from './support/memory-business.js';
import type { RoleName } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

/**
 * The merchant administration surface, over a real Fastify instance.
 *
 * What is proved here is authority and shape, not persistence: that the routes
 * exist behind the right permission, that a client cannot say who it is or
 * which merchant it is administering, and that a malformed body is refused
 * before anything downstream sees it. Whether the change actually commits — and
 * what it does to sessions — is a claim about PostgreSQL and is proved in
 * `merchant-admin-live.test.ts`.
 *
 * The service is a recorder rather than a fake database, deliberately. The
 * question these tests ask is "what did the route pass down, and did it get
 * there at all", and a recorder answers it without a second implementation of
 * the rules drifting away from the real one.
 */

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-real-password-9!';

const A: Fixture = {
  tenant: '018fb000-0000-7000-8000-00000000000a',
  branch: '018fb000-0000-7000-8000-0000000000a1',
  terminal: '018fb000-0000-7000-8000-0000000000a2',
  shift: '018fb000-0000-7000-8000-0000000000a3',
  user: '018fb000-0000-7000-8000-0000000000a4',
  milk: '018fb000-0000-7000-8000-0000000000a5',
  rice: '018fb000-0000-7000-8000-0000000000a6',
};

/** An id belonging to somebody else's merchant, used as bait. */
const FOREIGN_TENANT = '018fb000-0000-7000-8000-00000000000b';
const FOREIGN_USER = '018fb000-0000-7000-8000-0000000000b4';
const TARGET_USER = '018fb000-0000-7000-8000-0000000000c4';
const ROLE_ID = '018fb000-0000-7000-8000-0000000000d1';

let app: FastifyInstance;
let calls: AdminCall[];
let recorder: RecordingAdmin;

async function build(role: RoleName): Promise<FastifyInstance> {
  const business = new MemoryBusinessStore();
  seedStore(business, A, true);

  const auth = new MemoryAuthStore();
  auth.tenants.push({ id: A.tenant, slug: 'korvi-a', name: 'Korvi A', status: 'active' });
  auth.users.push({
    id: A.user,
    tenantId: A.tenant,
    email: 'sara@korvi-a.test',
    displayName: 'سارة',
    passwordHash: await hashPassword(PASSWORD, FAST),
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    authVersion: 1,
    lastLoginAt: null,
  });
  auth.memberships.push({
    tenantId: A.tenant,
    userId: A.user,
    status: 'active',
    defaultBranchId: A.branch,
  });
  auth.grants.push({
    tenantId: A.tenant,
    userId: A.user,
    roles: [role],
    permissions: [...ROLE_PERMISSIONS[role]],
  });

  const shifts = memoryShiftRepository(business);
  const terminals = memoryTerminalRepository(business);
  const idempotency = memoryIdempotencyRepository(business);
  const audit = memoryAuditRepository(business);
  recorder = recordingAdminService();
  calls = recorder.calls;

  const server = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: createAuthService({
      repository: memoryAuthRepository(auth),
      audit: memoryAuthAudit(auth),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    }),
    business: {
      tenants: memoryTenantRepository(business),
      dashboard: memoryDashboardRepository(business),
      products: memoryProductRepository(business),
      shifts,
      terminals,
      checkout: createCheckoutService({
        tenants: memoryTenantRepository(business),
        products: memoryProductRepository(business),
        inventory: memoryInventoryRepository(business),
        shifts,
        sales: memorySaleRepository(business),
        idempotency,
        audit,
      }),
      returns: createReturnService({
        returns: memoryReturnRepository(business),
        terminals,
        shifts,
        idempotency,
        audit,
      }),
      drawer: createDrawerService({ shifts, terminals, idempotency, audit }),
    },
    admin: recorder.service,
  });
  await server.ready();
  app = server;
  return server;
}

async function cookieFor(server: FastifyInstance): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return header.split(';')[0] ?? '';
}

const send = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: { cookie, origin: ORIGIN },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

/** Every write on the surface, so no route can be forgotten by a new test. */
const WRITES = [
  ['PATCH', '/v1/admin/settings', { requireBarcode: true }],
  ['POST', '/v1/admin/branches', { code: 'B1', nameAr: 'فرع' }],
  ['PATCH', `/v1/admin/branches/${A.branch}`, { nameAr: 'فرع' }],
  ['POST', `/v1/admin/branches/${A.branch}/activation`, { isActive: false }],
  ['POST', '/v1/admin/terminals', { branchId: A.branch, code: 'T1', label: 'صندوق' }],
  ['PATCH', `/v1/admin/terminals/${A.terminal}`, { label: 'صندوق' }],
  ['POST', `/v1/admin/terminals/${A.terminal}/activation`, { isActive: false }],
  ['POST', '/v1/admin/members', { email: 'new@korvi-a.test', displayName: 'جديد' }],
  ['PATCH', `/v1/admin/members/${TARGET_USER}`, { displayName: 'اسم' }],
  ['POST', `/v1/admin/members/${TARGET_USER}/user-activation`, { isActive: false }],
  ['POST', `/v1/admin/members/${TARGET_USER}/membership-activation`, { isActive: false }],
  ['POST', `/v1/admin/members/${TARGET_USER}/roles`, { roleId: ROLE_ID }],
  ['DELETE', `/v1/admin/members/${TARGET_USER}/roles/${ROLE_ID}`, undefined],
] as const;

const READS = [
  '/v1/admin/settings',
  '/v1/admin/branches',
  '/v1/admin/terminals',
  '/v1/admin/members',
  '/v1/admin/roles',
] as const;

afterEach(async () => {
  await app.close();
});

describe('who may administer a merchant', () => {
  it('refuses every administration route to an anonymous caller', async () => {
    await build('owner');
    for (const url of READS) {
      const response = await app.inject({ method: 'GET', url, headers: { origin: ORIGIN } });
      expect(response.statusCode, url).toBe(401);
    }
    for (const [method, url, payload] of WRITES) {
      const response = await app.inject({
        method,
        url,
        headers: { origin: ORIGIN },
        ...(payload === undefined ? {} : { payload: payload as never }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    // Nothing reached the authority layer.
    expect(calls).toHaveLength(0);
  });

  it('refuses a cashier the whole surface, however the request is crafted', async () => {
    await build('cashier');
    const cookie = await cookieFor(app);
    expect(ROLE_PERMISSIONS.cashier).not.toContain('settings.manage');
    expect(ROLE_PERMISSIONS.cashier).not.toContain('users.manage');

    for (const url of READS) {
      expect((await send('GET', url, cookie)).statusCode, url).toBe(403);
    }
    for (const [method, url, payload] of WRITES) {
      expect((await send(method, url, cookie, payload)).statusCode, `${method} ${url}`).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a manager the people routes and allows them nothing else either', async () => {
    // The manager role holds neither administration permission. This is the
    // permission model being checked against itself rather than against the
    // author's memory of it.
    await build('manager');
    const cookie = await cookieFor(app);
    expect(ROLE_PERMISSIONS.manager).not.toContain('users.manage');
    expect(ROLE_PERMISSIONS.manager).not.toContain('settings.manage');

    expect((await send('GET', '/v1/admin/members', cookie)).statusCode).toBe(403);
    expect((await send('GET', '/v1/admin/settings', cookie)).statusCode).toBe(403);
  });

  it('lets an owner through, and records the tenant and actor from the session', async () => {
    await build('owner');
    const cookie = await cookieFor(app);

    expect((await send('GET', '/v1/admin/settings', cookie)).statusCode).toBe(200);
    const created = await send('POST', '/v1/admin/branches', cookie, {
      code: 'B1',
      nameAr: 'فرع العليا',
    });
    expect(created.statusCode).toBe(201);

    for (const call of calls) {
      expect(call.principal.tenantId).toBe(A.tenant);
      expect(call.principal.userId).toBe(A.user);
    }
  });

  it('lets an admin through as well, since both permissions are theirs', async () => {
    await build('admin');
    const cookie = await cookieFor(app);
    expect(ROLE_PERMISSIONS.admin).toContain('settings.manage');
    expect(ROLE_PERMISSIONS.admin).toContain('users.manage');
    expect((await send('GET', '/v1/admin/members', cookie)).statusCode).toBe(200);
    expect((await send('GET', '/v1/admin/roles', cookie)).statusCode).toBe(200);
  });
});

describe('what a client may not say', () => {
  it('refuses a body that asserts a tenant, an actor or a permission set', async () => {
    await build('owner');
    const cookie = await cookieFor(app);

    const attempts: readonly [string, Record<string, unknown>][] = [
      ['tenantId', { code: 'B2', nameAr: 'فرع', tenantId: FOREIGN_TENANT }],
      ['actorUserId', { code: 'B2', nameAr: 'فرع', actorUserId: FOREIGN_USER }],
      ['permissions', { code: 'B2', nameAr: 'فرع', permissions: ['users.manage'] }],
      ['roles', { code: 'B2', nameAr: 'فرع', roles: ['owner'] }],
    ];

    for (const [field, payload] of attempts) {
      const response = await send('POST', '/v1/admin/branches', cookie, payload);
      expect(response.statusCode, field).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden_field', field });
    }
    // Refused before the authority layer, not sanitised on the way through.
    expect(calls).toHaveLength(0);
  });

  it('refuses an attempt to grant raw permissions instead of a role', async () => {
    await build('owner');
    const cookie = await cookieFor(app);
    const response = await send('POST', `/v1/admin/members/${TARGET_USER}/roles`, cookie, {
      permissions: ['users.manage'],
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses lifecycle and pricing authority disguised as a setting', async () => {
    await build('owner');
    const cookie = await cookieFor(app);
    // A merchant administrator does not change their own lifecycle status,
    // their price mode or their VAT rate. Each is named, so the refusal says
    // which one was attempted.
    for (const field of ['status', 'priceMode', 'defaultVatBasisPoints', 'currency', 'vertical']) {
      const response = await send('PATCH', '/v1/admin/settings', cookie, {
        requireBarcode: true,
        [field]: 'anything',
      });
      expect(response.statusCode, field).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({ error: 'forbidden_field', field });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses an unknown field even when it asserts nothing in particular', async () => {
    await build('owner');
    const cookie = await cookieFor(app);
    const response = await send('POST', '/v1/admin/branches', cookie, {
      code: 'B3',
      nameAr: 'فرع',
      surprise: true,
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_body' });
  });
});

describe('what a client must get right', () => {
  it('refuses a malformed body on every write', async () => {
    await build('owner');
    const cookie = await cookieFor(app);

    const bad: readonly [string, string, unknown][] = [
      ['POST', '/v1/admin/branches', { code: '', nameAr: 'فرع' }],
      ['POST', '/v1/admin/branches', { code: 'B1' }],
      ['POST', '/v1/admin/terminals', { branchId: 'not-a-uuid', code: 'T1', label: 'صندوق' }],
      ['PATCH', '/v1/admin/settings', {}],
      ['PATCH', `/v1/admin/branches/${A.branch}`, {}],
      ['POST', `/v1/admin/branches/${A.branch}/activation`, { isActive: 'yes' }],
      ['POST', '/v1/admin/members', { email: 'x', displayName: '' }],
      ['POST', `/v1/admin/members/${TARGET_USER}/roles`, { roleId: 'nope' }],
    ];

    for (const [method, url, payload] of bad) {
      const response = await send(method as 'POST' | 'PATCH', url, cookie, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a path id that is not an id', async () => {
    await build('owner');
    const cookie = await cookieFor(app);
    const response = await send('PATCH', '/v1/admin/branches/not-a-uuid', cookie, {
      nameAr: 'فرع',
    });
    expect(response.statusCode).toBe(400);
  });

  it('bounds a list request rather than letting it ask for everything', async () => {
    await build('owner');
    const cookie = await cookieFor(app);
    expect((await send('GET', '/v1/admin/members?limit=1000', cookie)).statusCode).toBe(400);

    const defaulted = await send('GET', '/v1/admin/members', cookie);
    expect(defaulted.statusCode).toBe(200);
    // The default is a page, not the whole table, and no cursor means "start".
    const call = calls.at(-1);
    expect(call?.name).toBe('listMembers');
    expect(call?.args).toEqual([50, null]);
  });

  it('carries a continuation cursor through to the authority layer', async () => {
    await build('owner');
    const cookie = await cookieFor(app);

    const cursor = Buffer.from('nada@korvi-a.test', 'utf8').toString('base64url');
    expect(
      (await send('GET', `/v1/admin/members?limit=2&cursor=${cursor}`, cookie)).statusCode,
    ).toBe(200);
    expect(calls.at(-1)?.args).toEqual([2, cursor]);

    expect((await send('GET', `/v1/admin/branches?cursor=${cursor}`, cookie)).statusCode).toBe(200);
    expect(calls.at(-1)?.args).toEqual([50, cursor]);

    expect((await send('GET', `/v1/admin/terminals?cursor=${cursor}`, cookie)).statusCode).toBe(
      200,
    );
    expect(calls.at(-1)?.args).toEqual([50, null, cursor]);
  });

  it('bounds the cursor itself and maps invalid-cursor refusals', async () => {
    await build('owner');
    const cookie = await cookieFor(app);

    // A megabyte of base64 is not a page reference.
    const huge = 'a'.repeat(600);
    expect((await send('GET', `/v1/admin/members?cursor=${huge}`, cookie)).statusCode).toBe(400);

    // The authority layer may refuse an invalid cursor, and the route maps
    // that refusal to 400 rather than silently restarting pagination.
    recorder.refuseWith('invalid-cursor');
    const response = await send('GET', '/v1/admin/members?cursor=bm90LWEtY3Vyc29y', cookie);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'invalid_cursor' });
  });

  it('answers an inactive parent branch as its own thing, not as "in use"', async () => {
    await build('owner');
    const cookie = await cookieFor(app);
    recorder.refuseWith('branch-inactive');

    const response = await send('POST', '/v1/admin/terminals', cookie, {
      branchId: A.branch,
      code: 'T5',
      label: 'صندوق',
    });
    expect(response.statusCode).toBe(409);
    const body: unknown = JSON.parse(response.body);
    expect(body).toMatchObject({ error: 'branch_inactive' });
    // The message must not claim an open shift exists, which would send the
    // merchant looking for a drawer to close.
    expect(String((body as { message: string }).message)).not.toMatch(/وردية/);
  });
});

describe('what a refusal looks like', () => {
  it('gives each refusal from the authority layer its own status', async () => {
    const cases: readonly [AdminFailureReason, number][] = [
      ['unknown-branch', 404],
      ['unknown-member', 404],
      ['unknown-role', 404],
      ['code-taken', 409],
      ['email-taken', 409],
      // The shop's state, not the request's shape: a retry of the same body
      // succeeds once the drawer is closed or the other administrator exists.
      ['branch-in-use', 409],
      ['last-administrator', 409],
      ['invalid-input', 422],
    ];

    for (const [reason, status] of cases) {
      await build('owner');
      const cookie = await cookieFor(app);
      recorder.refuseWith(reason);

      const response = await send('POST', '/v1/admin/branches', cookie, {
        code: 'B9',
        nameAr: 'فرع',
      });
      expect(response.statusCode, reason).toBe(status);
      const body: unknown = JSON.parse(response.body);
      expect(body).toMatchObject({ error: reason.replace(/-/g, '_') });
      // A message the owner can act on, and nothing about why the server
      // thinks so.
      expect(String((body as { message: string }).message).length).toBeGreaterThan(0);
      await app.close();
    }
    // The last close is the shared afterEach's; reopen so it has something.
    await build('owner');
  });

  it('never leaks a credential field in a member response', async () => {
    await build('owner');
    const cookie = await cookieFor(app);
    const response = await send('GET', '/v1/admin/members', cookie);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/passwordHash|tokenHash|password/i);
  });
});
