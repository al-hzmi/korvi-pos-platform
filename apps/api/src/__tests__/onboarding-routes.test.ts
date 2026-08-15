import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import {
  MemoryAuthStore,
  memoryAuditRepository,
  memoryAuthRepository,
} from './support/memory-auth.js';
import type { AuthenticatedPrincipal, OnboardingReadiness, RoleName } from '@korvi/domain';
import type { MerchantOnboardingService } from '../onboarding/service.js';
import type { FastifyInstance } from 'fastify';

const FAST = {
  N: 16_384,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
} as const;

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-real-password-9!';

const TENANT = '018fb100-0000-7000-8000-000000000001';
const USER = '018fb100-0000-7000-8000-000000000002';
const BRANCH = '018fb100-0000-7000-8000-000000000003';
const FOREIGN_TENANT = '018fb100-0000-7000-8000-000000000099';

const READY: OnboardingReadiness = {
  ready: true,
  checks: [
    { key: 'tenant-active', ready: true, blocker: null, remediation: null },
    { key: 'settings-present', ready: true, blocker: null, remediation: null },
    { key: 'active-branch', ready: true, blocker: null, remediation: null },
    { key: 'active-terminal', ready: true, blocker: null, remediation: null },
    {
      key: 'viable-administrator',
      ready: true,
      blocker: null,
      remediation: null,
    },
    { key: 'active-product', ready: true, blocker: null, remediation: null },
  ],
};

let app: FastifyInstance;
let calls: AuthenticatedPrincipal[];

async function build(
  role: RoleName,
  result: OnboardingReadiness | null = READY,
): Promise<FastifyInstance> {
  const auth = new MemoryAuthStore();

  auth.tenants.push({
    id: TENANT,
    slug: 'korvi-onboarding',
    name: 'Korvi Onboarding',
    status: 'active',
  });

  auth.users.push({
    id: USER,
    tenantId: TENANT,
    email: 'owner@korvi-onboarding.test',
    displayName: 'مالك',
    passwordHash: await hashPassword(PASSWORD, FAST),
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    authVersion: 1,
    lastLoginAt: null,
  });

  auth.memberships.push({
    tenantId: TENANT,
    userId: USER,
    status: 'active',
    defaultBranchId: BRANCH,
  });

  auth.grants.push({
    tenantId: TENANT,
    userId: USER,
    roles: [role],
    permissions: [...ROLE_PERMISSIONS[role]],
  });

  calls = [];

  const onboarding: MerchantOnboardingService = {
    async readReadiness(principal) {
      calls.push(principal);
      return result;
    },
  };

  app = buildServer(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
    }),
    {
      auth: createAuthService({
        repository: memoryAuthRepository(auth),
        audit: memoryAuditRepository(auth),
        sessionTtlSeconds: 3600,
        scrypt: FAST,
      }),
      onboarding,
    },
  );

  await app.ready();
  return app;
}

async function cookieFor(server: FastifyInstance): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: {
      tenantSlug: 'korvi-onboarding',
      email: 'owner@korvi-onboarding.test',
      password: PASSWORD,
    },
  });

  expect(response.statusCode).toBe(200);

  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');

  return header.split(';')[0] ?? '';
}

afterEach(async () => {
  await app.close();
});

describe('onboarding readiness route authority', () => {
  it('refuses an anonymous caller before the authority layer runs', async () => {
    await build('owner');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/onboarding/readiness',
      headers: { origin: ORIGIN },
    });

    expect(response.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('refuses a cashier without settings.manage', async () => {
    await build('cashier');
    const cookie = await cookieFor(app);

    expect(ROLE_PERMISSIONS.cashier).not.toContain('settings.manage');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/onboarding/readiness',
      headers: { cookie, origin: ORIGIN },
    });

    expect(response.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('derives tenant and actor only from the authenticated session', async () => {
    await build('owner');
    const cookie = await cookieFor(app);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/onboarding/readiness',
      headers: { cookie, origin: ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(READY);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.tenantId).toBe(TENANT);
    expect(calls[0]?.userId).toBe(USER);
  });

  it('rejects request-controlled tenant identity instead of ignoring it', async () => {
    await build('owner');
    const cookie = await cookieFor(app);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/admin/onboarding/readiness?tenantId=${FOREIGN_TENANT}`,
      headers: { cookie, origin: ORIGIN },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_query' });
    expect(calls).toHaveLength(0);
  });

  it('fails closed when authenticated tenant evidence cannot be read', async () => {
    await build('owner', null);
    const cookie = await cookieFor(app);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/onboarding/readiness',
      headers: { cookie, origin: ORIGIN },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    expect(calls).toHaveLength(1);
  });
});
