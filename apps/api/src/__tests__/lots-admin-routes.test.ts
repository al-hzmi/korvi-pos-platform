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
import type { LotAdminResult, MerchantLotAdminService } from '../lots/service.js';
import type { ProductLotAdminConfig } from '@korvi/database';
import type { AuthenticatedPrincipal, RoleName } from '@korvi/domain';
import type { Fixture } from './support/memory-business.js';
import type { FastifyInstance } from 'fastify';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'lot-admin-password-9!';

const A: Fixture = {
  tenant: '018fd420-0000-7000-8000-00000000000a',
  branch: '018fd420-0000-7000-8000-0000000000a1',
  terminal: '018fd420-0000-7000-8000-0000000000a2',
  shift: '018fd420-0000-7000-8000-0000000000a3',
  user: '018fd420-0000-7000-8000-0000000000a4',
  milk: '018fd420-0000-7000-8000-0000000000a5',
  rice: '018fd420-0000-7000-8000-0000000000a6',
};

const PRODUCT_ID = A.milk;
const LOT_A = '018fd420-0000-7000-8000-000000000101';
const LOT_B = '018fd420-0000-7000-8000-000000000102';

interface Call {
  readonly name: string;
  readonly principal: AuthenticatedPrincipal;
  readonly args: readonly unknown[];
}

let app: FastifyInstance;
let calls: Call[];

const config: ProductLotAdminConfig = {
  productId: PRODUCT_ID,
  sku: 'MILK',
  nameAr: 'حليب',
  trackingMode: 'required',
  selectionPolicy: 'fefo',
  dateRequirement: 'required',
  revision: '1',
  businessTimeZone: 'Asia/Riyadh',
  expiryIntelligence: {
    observedAt: '2026-09-29T12:00:00.000Z',
    businessDate: '2026-09-29',
    totalAvailableQuantityScaled: '5000',
    eligibleQuantityScaled: '5000',
    expiredQuantityScaled: '0',
    pastBestBeforeQuantityScaled: '0',
    unknownDateQuantityScaled: '0',
    blockedOrClosedQuantityScaled: '0',
    soonestEligibleExpiryDate: '2026-10-31',
  },
  lots: [
    {
      id: LOT_A,
      internalCode: 'LOT-A',
      provenance: 'received',
      externalBatchReference: 'A',
      dateKind: 'expiry',
      dateValue: '2026-10-31',
      dateState: 'eligible',
      daysUntilDate: 32,
      totalAvailableQuantityScaled: '5000',
      eligibleForConsumptionQuantityScaled: '5000',
      status: 'active',
      revision: '1',
      firstObservedAt: '2026-09-29T00:00:00.000Z',
      availabilityByBranch: [{ branchId: A.branch, quantityScaled: '5000' }],
    },
  ],
};

function ok(): LotAdminResult<ProductLotAdminConfig> {
  return { outcome: 'success', value: config };
}

function recorder(): MerchantLotAdminService {
  return {
    async read(principal, productId) {
      calls.push({ name: 'read', principal, args: [productId] });
      return config;
    },
    async enable(principal, productId, input) {
      calls.push({ name: 'enable', principal, args: [productId, input] });
      return ok();
    },
    async updatePolicy(principal, productId, input) {
      calls.push({ name: 'updatePolicy', principal, args: [productId, input] });
      return ok();
    },
    async updateStatus(principal, lotId, input) {
      calls.push({ name: 'updateStatus', principal, args: [lotId, input] });
      return ok();
    },
    async reclassify(principal, input) {
      calls.push({ name: 'reclassify', principal, args: [input] });
      return ok();
    },
  };
}

async function build(role: RoleName): Promise<FastifyInstance> {
  const business = new MemoryBusinessStore();
  seedStore(business, A, true);

  const auth = new MemoryAuthStore();
  auth.tenants.push({ id: A.tenant, slug: 'lots-a', name: 'Lots A', status: 'active' });
  auth.users.push({
    id: A.user,
    tenantId: A.tenant,
    email: 'manager@lots-a.test',
    displayName: 'مدير الدفعات',
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
    lotAdmin: recorder(),
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
    payload: { tenantSlug: 'lots-a', email: 'manager@lots-a.test', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return header.split(';')[0] ?? '';
}

function send(method: 'GET' | 'POST' | 'PATCH', url: string, cookie?: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

const attempts = (cookie?: string) => [
  send('GET', `/v1/admin/lots/products/${PRODUCT_ID}`, cookie),
  send('POST', `/v1/admin/lots/products/${PRODUCT_ID}/enable`, cookie, {
    selectionPolicy: 'fefo',
    dateRequirement: 'required',
  }),
  send('PATCH', `/v1/admin/lots/products/${PRODUCT_ID}/policy`, cookie, {
    expectedRevision: '1',
    selectionPolicy: 'fifo',
  }),
  send('PATCH', `/v1/admin/lots/${LOT_A}/status`, cookie, {
    expectedRevision: '1',
    status: 'blocked',
  }),
  send('POST', '/v1/admin/lots/reclassifications', cookie, {
    operationId: 'lot-route-proof',
    productId: PRODUCT_ID,
    branchId: A.branch,
    expectedBalanceRevision: '1',
    reason: 'physical correction',
    lines: [
      { lotId: LOT_A, quantityScaled: '-1000' },
      { lotId: LOT_B, quantityScaled: '1000' },
    ],
  }),
];

afterEach(async () => {
  await app.close();
});

describe('lot administration authorization', () => {
  it('requires authentication before every lot-management action', async () => {
    await build('owner');
    for (const response of await Promise.all(attempts())) {
      expect(response.statusCode).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a cashier before lot authority is reached', async () => {
    await build('cashier');
    const cookie = await cookieFor(app);
    expect(ROLE_PERMISSIONS.cashier).not.toContain('lot.manage');

    for (const response of await Promise.all(attempts(cookie))) {
      expect(response.statusCode).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('allows a manager and derives tenant and actor solely from the session', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    expect(ROLE_PERMISSIONS.manager).toContain('lot.manage');

    const responses = await Promise.all(attempts(cookie));
    expect(responses.map((response) => response.statusCode)).toEqual([200, 201, 200, 200, 201]);
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.principal.tenantId).toBe(A.tenant);
      expect(call.principal.userId).toBe(A.user);
    }
  });

  it('refuses client-asserted tenant or actor fields rather than sanitizing them through', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const response = await send('POST', `/v1/admin/lots/products/${PRODUCT_ID}/enable`, cookie, {
      selectionPolicy: 'fefo',
      dateRequirement: 'required',
      tenantId: '018fd420-0000-7000-8000-00000000000b',
      actorUserId: '018fd420-0000-7000-8000-0000000000b4',
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_body' });
    expect(calls).toHaveLength(0);
  });
});
