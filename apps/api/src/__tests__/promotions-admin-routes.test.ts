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
  memoryRestaurantFloorRepository,
  memoryReturnRepository,
  memorySaleRepository,
  memoryShiftRepository,
  memoryTenantRepository,
  memoryTerminalRepository,
  seedStore,
} from './support/memory-business.js';
import type {
  MerchantPromotionAdminService,
  PromotionAdminFailureReason,
  PromotionAdminResult,
} from '../promotions/service.js';
import type { AuthenticatedPrincipal, RoleName } from '@korvi/domain';
import type {
  PromotionAdminCoupon,
  PromotionAdminRecord,
} from '@korvi/database';
import type { Fixture } from './support/memory-business.js';
import type { FastifyInstance } from 'fastify';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'promotion-admin-password-9!';

const A: Fixture = {
  tenant: '018fd400-0000-7000-8000-00000000000a',
  branch: '018fd400-0000-7000-8000-0000000000a1',
  terminal: '018fd400-0000-7000-8000-0000000000a2',
  shift: '018fd400-0000-7000-8000-0000000000a3',
  user: '018fd400-0000-7000-8000-0000000000a4',
  milk: '018fd400-0000-7000-8000-0000000000a5',
  rice: '018fd400-0000-7000-8000-0000000000a6',
};

const PROMOTION_ID = '018fd400-0000-7000-8000-000000000101';
const COUPON_ID = '018fd400-0000-7000-8000-000000000201';

interface Call {
  readonly name: string;
  readonly principal: AuthenticatedPrincipal;
  readonly args: readonly unknown[];
}

let app: FastifyInstance;
let calls: Call[];
let refuse: PromotionAdminFailureReason | null;

const promotion: PromotionAdminRecord = {
  id: PROMOTION_ID,
  merchantCode: 'SAVE-10-PROMO',
  name: 'عرض',
  status: 'draft',
  activationMode: 'coupon',
  priority: 100,
  stackingMode: 'stackable',
  startsAt: null,
  endsAt: null,
  effectKind: 'fixed',
  effectValue: '100',
  minimumEligibleSubtotalMinor: '0',
  targetKind: 'basket',
  productIds: [],
  revision: '1',
  coupons: [],
};

const coupon: PromotionAdminCoupon = {
  id: COUPON_ID,
  promotionId: PROMOTION_ID,
  normalizedCode: 'SAVE-10',
  status: 'active',
  startsAt: null,
  endsAt: null,
  totalRedemptionLimit: 10,
  observedRedemptionCount: 0,
  revision: '1',
};

function result<T>(value: T): PromotionAdminResult<T> {
  return refuse === null
    ? { outcome: 'success', value }
    : { outcome: 'failure', reason: refuse };
}

function recorder(): MerchantPromotionAdminService {
  return {
    async list(principal) {
      calls.push({ name: 'list', principal, args: [] });
      return [promotion];
    },
    async createPromotion(principal, input) {
      calls.push({ name: 'createPromotion', principal, args: [input] });
      return result(promotion);
    },
    async updatePromotion(principal, promotionId, input) {
      calls.push({ name: 'updatePromotion', principal, args: [promotionId, input] });
      return result({ ...promotion, revision: '2' });
    },
    async createCoupon(principal, promotionId, input) {
      calls.push({ name: 'createCoupon', principal, args: [promotionId, input] });
      return result(coupon);
    },
    async updateCoupon(principal, couponId, input) {
      calls.push({ name: 'updateCoupon', principal, args: [couponId, input] });
      return result({ ...coupon, revision: '2' });
    },
  };
}

async function build(role: RoleName): Promise<FastifyInstance> {
  const business = new MemoryBusinessStore();
  seedStore(business, A, true);

  const auth = new MemoryAuthStore();
  auth.tenants.push({ id: A.tenant, slug: 'promo-a', name: 'Promo A', status: 'active' });
  auth.users.push({
    id: A.user,
    tenantId: A.tenant,
    email: 'manager@promo-a.test',
    displayName: 'مدير',
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
  calls = [];
  refuse = null;

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
      restaurantFloor: memoryRestaurantFloorRepository(),
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
    promotionAdmin: recorder(),
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
    payload: { tenantSlug: 'promo-a', email: 'manager@promo-a.test', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return header.split(';')[0] ?? '';
}

function send(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  cookie?: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

const createBody = {
  merchantCode: 'SAVE-10-PROMO',
  name: 'عرض',
  activationMode: 'coupon',
  priority: 100,
  stackingMode: 'stackable',
  effectKind: 'fixed',
  effectValue: '100',
  targetKind: 'basket',
} as const;

afterEach(async () => {
  await app.close();
});

describe('promotion administration authorization', () => {
  it('requires a session before every promotion-management action', async () => {
    await build('owner');
    expect((await send('GET', '/v1/admin/promotions')).statusCode).toBe(401);
    expect((await send('POST', '/v1/admin/promotions', undefined, createBody)).statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('refuses a cashier before the promotion authority service is reached', async () => {
    await build('cashier');
    const cookie = await cookieFor(app);
    expect(ROLE_PERMISSIONS.cashier).not.toContain('promotion.manage');

    const attempts = [
      await send('GET', '/v1/admin/promotions', cookie),
      await send('POST', '/v1/admin/promotions', cookie, createBody),
      await send('PATCH', `/v1/admin/promotions/${PROMOTION_ID}`, cookie, {
        expectedRevision: '1',
        status: 'active',
      }),
      await send('POST', `/v1/admin/promotions/${PROMOTION_ID}/coupons`, cookie, {
        code: 'SAVE-10',
      }),
      await send('PATCH', `/v1/admin/coupons/${COUPON_ID}`, cookie, {
        expectedRevision: '1',
        status: 'paused',
      }),
    ];

    for (const response of attempts) expect(response.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('allows a manager and derives tenant and actor from the authenticated session', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    expect(ROLE_PERMISSIONS.manager).toContain('promotion.manage');

    expect((await send('GET', '/v1/admin/promotions', cookie)).statusCode).toBe(200);
    expect((await send('POST', '/v1/admin/promotions', cookie, createBody)).statusCode).toBe(201);

    for (const call of calls) {
      expect(call.principal.tenantId).toBe(A.tenant);
      expect(call.principal.userId).toBe(A.user);
    }
  });

  it('refuses extra authority fields instead of sanitizing them through', async () => {
    await build('manager');
    const cookie = await cookieFor(app);

    const response = await send('POST', '/v1/admin/promotions', cookie, {
      ...createBody,
      tenantId: '018fd400-0000-7000-8000-00000000000b',
      actorUserId: '018fd400-0000-7000-8000-0000000000b4',
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_body' });
    expect(calls).toHaveLength(0);
  });

  it('maps optimistic-concurrency refusal to a retryable 409', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    refuse = 'stale-revision';

    const response = await send('PATCH', `/v1/admin/promotions/${PROMOTION_ID}`, cookie, {
      expectedRevision: '1',
      status: 'active',
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'stale_revision',
    });
    expect(calls.at(-1)?.name).toBe('updatePromotion');
  });
});
