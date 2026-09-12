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
import type {
  MerchantInventoryService,
  StockFailureReason,
  StockResult,
} from '../inventory/service.js';
import type { Fixture } from './support/memory-business.js';
import type { AdjustmentRequest, CountRequest, TransferRequest } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

/**
 * The stock authority as a door, over a real Fastify instance.
 *
 * What is proved here is the shape of the surface: which permission each route
 * demands, that no authority field can be threaded through it, and that a
 * refusal decided under a row lock arrives as a stable status. Whether the
 * ledger is actually atomic is a claim about PostgreSQL and is proved in
 * `inventory-stock-live.test.ts`.
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

const OTHER_BRANCH = '018fb000-0000-7000-8000-0000000000b1';

const ADJUSTMENT = {
  operationId: 'op-adjust-1',
  branchId: A.branch,
  reason: 'تلف',
  lines: [{ productId: A.milk, deltaQuantityScaled: '-2000' }],
};

const COUNT = {
  operationId: 'op-count-1',
  branchId: A.branch,
  lines: [{ productId: A.milk, countedQuantityScaled: '4000', expectedRevision: '3' }],
};

const TRANSFER = {
  operationId: 'op-transfer-1',
  fromBranchId: A.branch,
  toBranchId: OTHER_BRANCH,
  lines: [{ productId: A.milk, quantityScaled: '1000' }],
};

const COST_BOOTSTRAP = {
  operationId: 'op-cost-bootstrap-1',
  branchId: A.branch,
  productId: A.milk,
  totalValueMinor: '4500',
  expectedStockRevision: '12',
  expectedCostRevision: '8',
  expectedUnknownPositiveQuantityScaled: '1000',
};

let app: FastifyInstance;
let seen: { method: string; request: unknown }[];
let nextFailure: { reason: StockFailureReason; productId: string | null } | null;

function recordingInventory(): MerchantInventoryService {
  function answer<T>(value: T): StockResult<T> {
    if (nextFailure !== null) {
      return {
        outcome: 'failure',
        reason: nextFailure.reason,
        productId: nextFailure.productId,
      };
    }
    return { outcome: 'success', value };
  }

  return {
    async branches(_principal, query) {
      seen.push({ method: 'branches', request: query });
      return {
        rows: [
          {
            id: A.branch,
            code: 'MAIN',
            nameAr: 'الفرع الرئيسي',
            nameEn: 'Main',
            isActive: true,
          },
        ],
        nextCursor: null,
      };
    },
    async balances(_principal, query) {
      seen.push({ method: 'balances', request: query });
      return {
        rows: [
          {
            branchId: A.branch,
            productId: A.milk,
            sku: 'MILK-1L',
            nameAr: 'حليب',
            nameEn: 'Milk',
            productType: 'unit',
            unitLabel: 'each',
            isActive: true,
            trackInventory: true,
            quantityScaled: '9007199254740993000',
            revision: '12',
          },
        ],
        nextCursor: null,
      };
    },
    async costBalances(_principal, query) {
      seen.push({ method: 'costBalances', request: query });
      return {
        rows: [
          {
            branchId: A.branch,
            productId: A.milk,
            sku: 'MILK-1L',
            nameAr: 'حليب',
            nameEn: 'Milk',
            productType: 'unit',
            unitLabel: 'each',
            isActive: true,
            trackInventory: true,
            quantityScaled: '9007199254740993000',
            knownQuantityScaled: '7000000000000000000',
            unknownPositiveQuantityScaled: '2007199254740993000',
            knownValueMinor: '900719925474099300',
            stockRevision: '12',
            costRevision: '8',
          },
        ],
        nextCursor: null,
      };
    },
    async bootstrapCost(_principal, request) {
      seen.push({ method: 'bootstrapCost', request });
      return answer({
        id: '018fb000-0000-7000-8000-0000000000c1',
        branchId: request.branchId,
        productId: request.productId,
        valuedQuantityScaled: '1000',
        stockRevision: '12',
        costRevision: '1',
        occurredAt: '2026-08-27T00:00:00.000Z',
        replayed: false,
      });
    },
    async adjust(_principal, request: AdjustmentRequest) {
      seen.push({ method: 'adjust', request });
      return answer({
        id: '018fb000-0000-7000-8000-0000000000f1',
        branchId: request.branchId,
        occurredAt: '2026-08-27T00:00:00.000Z',
        replayed: false,
        lines: [],
      });
    },
    async count(_principal, request: CountRequest) {
      seen.push({ method: 'count', request });
      return answer({
        id: '018fb000-0000-7000-8000-0000000000f2',
        branchId: request.branchId,
        occurredAt: '2026-08-27T00:00:00.000Z',
        replayed: false,
        lines: [],
      });
    },
    async transfer(_principal, request: TransferRequest) {
      seen.push({ method: 'transfer', request });
      return answer({
        id: '018fb000-0000-7000-8000-0000000000f3',
        fromBranchId: request.fromBranchId,
        toBranchId: request.toBranchId,
        occurredAt: '2026-08-27T00:00:00.000Z',
        replayed: false,
        lines: [],
      });
    },
  };
}

async function build(permissions: readonly string[]): Promise<FastifyInstance> {
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
    roles: ['manager'],
    permissions: [...permissions] as never,
  });

  const shifts = memoryShiftRepository(business);
  const terminals = memoryTerminalRepository(business);
  const idempotency = memoryIdempotencyRepository(business);
  const audit = memoryAuditRepository(business);
  seen = [];
  nextFailure = null;

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
    inventory: recordingInventory(),
  });
  await server.ready();
  app = server;
  return server;
}

async function cookieFor(server: FastifyInstance): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { origin: ORIGIN, 'user-agent': 'vitest' },
    payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return header.split(';')[0] ?? '';
}

const post = (url: string, cookie: string | null, payload: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, ...(cookie === null ? {} : { cookie }) },
    payload: payload as never,
  });

const get = (url: string, cookie: string | null) =>
  app.inject({
    method: 'GET',
    url,
    headers: { origin: ORIGIN, ...(cookie === null ? {} : { cookie }) },
  });

const ROUTES = [
  ['/v1/admin/inventory/cost-bootstrap', COST_BOOTSTRAP] as const,
  ['/v1/admin/inventory/adjustments', ADJUSTMENT] as const,
  ['/v1/admin/inventory/counts', COUNT] as const,
  ['/v1/admin/inventory/transfers', TRANSFER] as const,
];

afterEach(async () => {
  await app.close();
});

describe('the stock authority requires a session and the exact permission', () => {
  it('refuses every route without a session', async () => {
    await build(ROLE_PERMISSIONS.owner);
    for (const [url, body] of ROUTES) {
      expect((await post(url, null, body)).statusCode, url).toBe(401);
    }
    expect((await get(`/v1/admin/inventory/balances?branchId=${A.branch}`, null)).statusCode).toBe(
      401,
    );
    expect((await get('/v1/admin/inventory/branches', null)).statusCode).toBe(401);
    expect(
      (await get(`/v1/admin/inventory/cost-balances?branchId=${A.branch}`, null)).statusCode,
    ).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('demands inventory.read to list balances', async () => {
    const server = await build(['sale.create']);
    const cookie = await cookieFor(server);
    expect(
      (await get(`/v1/admin/inventory/balances?branchId=${A.branch}`, cookie)).statusCode,
    ).toBe(403);
    expect((await get('/v1/admin/inventory/branches', cookie)).statusCode).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('demands inventory.cost.read for valuation facts, which stock or cost-write access does not imply', async () => {
    for (const permissions of [['inventory.read'], ['inventory.cost.manage']] as const) {
      const server = await build(permissions);
      const cookie = await cookieFor(server);
      expect(
        (await get(`/v1/admin/inventory/cost-balances?branchId=${A.branch}`, cookie)).statusCode,
        permissions[0],
      ).toBe(403);
      expect(seen).toHaveLength(0);
      await app.close();
    }

    const allowed = await build(['inventory.cost.read']);
    const second = await cookieFor(allowed);
    expect(
      (await get(`/v1/admin/inventory/cost-balances?branchId=${A.branch}`, second)).statusCode,
    ).toBe(200);
  });

  it('demands inventory.adjust for adjustments and counts', async () => {
    const server = await build(['inventory.read']);
    const cookie = await cookieFor(server);
    expect((await post('/v1/admin/inventory/adjustments', cookie, ADJUSTMENT)).statusCode).toBe(
      403,
    );
    expect((await post('/v1/admin/inventory/counts', cookie, COUNT)).statusCode).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('demands inventory.transfer for transfers, which adjust does not imply', async () => {
    // The point of a separate permission: a merchant may let somebody write
    // stock off without letting them move it between branches.
    const server = await build(['inventory.read', 'inventory.adjust']);
    const cookie = await cookieFor(server);
    expect((await post('/v1/admin/inventory/transfers', cookie, TRANSFER)).statusCode).toBe(403);
    expect(seen).toHaveLength(0);

    await app.close();
    const allowed = await build(['inventory.transfer']);
    const second = await cookieFor(allowed);
    expect((await post('/v1/admin/inventory/transfers', second, TRANSFER)).statusCode).toBe(201);
  });

  it('demands inventory.cost.manage for bootstrap, which adjust does not imply', async () => {
    const server = await build(['inventory.adjust']);
    const cookie = await cookieFor(server);
    expect(
      (await post('/v1/admin/inventory/cost-bootstrap', cookie, COST_BOOTSTRAP)).statusCode,
    ).toBe(403);
    expect(seen).toHaveLength(0);

    await app.close();
    const allowed = await build(['inventory.cost.manage']);
    const second = await cookieFor(allowed);
    expect(
      (await post('/v1/admin/inventory/cost-bootstrap', second, COST_BOOTSTRAP)).statusCode,
    ).toBe(201);
    expect(seen).toEqual([{ method: 'bootstrapCost', request: COST_BOOTSTRAP }]);
  });

  it('is decided by the permission and not by the role name', async () => {
    // The principal's role stays 'manager' in every build above; only the
    // permission set changes, and only the permission set decides.
    const server = await build(['inventory.transfer']);
    const cookie = await cookieFor(server);
    expect((await post('/v1/admin/inventory/transfers', cookie, TRANSFER)).statusCode).toBe(201);
    expect((await post('/v1/admin/inventory/adjustments', cookie, ADJUSTMENT)).statusCode).toBe(
      403,
    );
  });
});

describe('authority fields cannot be threaded through the body', () => {
  it('refuses tenant, actor and result fields by name', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    const attempts = [
      'tenantId',
      'actorUserId',
      'userId',
      'sessionId',
      'movementKind',
      'kind',
      'beforeQuantityScaled',
      'afterQuantityScaled',
      'resultRevision',
      'currentRevision',
      'revision',
      'isFinalized',
      'status',
      'occurredAt',
    ];

    for (const field of attempts) {
      const response = await post('/v1/admin/inventory/adjustments', cookie, {
        ...ADJUSTMENT,
        [field]: 'anything',
      });
      expect(response.statusCode, field).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden_field', field });
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses an authority field hidden inside a line', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    const response = await post('/v1/admin/inventory/adjustments', cookie, {
      ...ADJUSTMENT,
      lines: [{ productId: A.milk, deltaQuantityScaled: '-2000', afterQuantityScaled: '0' }],
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'forbidden_field',
      field: 'afterQuantityScaled',
    });
    expect(seen).toHaveLength(0);
  });

  it('refuses a client-supplied delta on a count, and accepts one on an adjustment', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    // The asymmetry that matters: a count delta is derived from the locked
    // balance, so a client that sends one is trying to overwrite a movement it
    // never saw.
    const refused = await post('/v1/admin/inventory/counts', cookie, {
      ...COUNT,
      lines: [
        {
          productId: A.milk,
          countedQuantityScaled: '4000',
          expectedRevision: '3',
          deltaQuantityScaled: '-1000',
        },
      ],
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({
      error: 'forbidden_field',
      field: 'deltaQuantityScaled',
    });

    // The same field name is the legitimate instruction on the other route.
    expect((await post('/v1/admin/inventory/adjustments', cookie, ADJUSTMENT)).statusCode).toBe(
      201,
    );
  });

  it('refuses a tenant id in the balances query', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    const response = await get(
      `/v1/admin/inventory/balances?branchId=${A.branch}&tenantId=${A.tenant}`,
      cookie,
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden_field', field: 'tenantId' });
    expect(seen).toHaveLength(0);
  });

  it('refuses tenant authority in the inventory branch query', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    const response = await get(`/v1/admin/inventory/branches?tenantId=${A.tenant}`, cookie);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden_field', field: 'tenantId' });
    expect(seen).toHaveLength(0);
  });

  it('refuses tenant and client-supplied valuation facts in the cost read query', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    for (const field of ['tenantId', 'knownValueMinor', 'unknownPositiveQuantityScaled']) {
      const response = await get(
        `/v1/admin/inventory/cost-balances?branchId=${A.branch}&${field}=1000`,
        cookie,
      );
      expect(response.statusCode, field).toBe(400);
      expect(response.json(), field).toEqual({ error: 'forbidden_field', field });
    }
    expect(seen).toHaveLength(0);
  });

  it('accepts only prefixed observation guards and refuses client-supplied result facts', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    const fields = [
      'quantityScaled',
      'valuedQuantityScaled',
      'knownQuantityScaled',
      'unknownQuantityScaled',
      'unknownPositiveQuantity',
      'unknownPositiveQuantityScaled',
      'knownValueMinor',
      'costValueMinor',
      'stockRevision',
      'costRevision',
    ];

    for (const field of fields) {
      const response = await post('/v1/admin/inventory/cost-bootstrap', cookie, {
        ...COST_BOOTSTRAP,
        [field]: '1000',
      });
      expect(response.statusCode, field).toBe(400);
      expect(JSON.parse(response.body), field).toEqual({ error: 'forbidden_field', field });
    }
    expect(seen).toHaveLength(0);
  });
});

describe('request shape', () => {
  it('refuses a quantity that is not scaled integer text', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    for (const bad of ['1.5', '2e3', '', '-0', ' 1', 1000]) {
      const response = await post('/v1/admin/inventory/adjustments', cookie, {
        ...ADJUSTMENT,
        lines: [{ productId: A.milk, deltaQuantityScaled: bad }],
      });
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses a negative counted quantity and a negative revision at the door', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    for (const line of [
      { productId: A.milk, countedQuantityScaled: '-1', expectedRevision: '3' },
      { productId: A.milk, countedQuantityScaled: '4000', expectedRevision: '-1' },
    ]) {
      expect(
        (await post('/v1/admin/inventory/counts', cookie, { ...COUNT, lines: [line] })).statusCode,
      ).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('bounds the line count and the page size', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    const many = Array.from({ length: 201 }, (_, index) => ({
      productId: `018fb000-0000-7000-8000-${index.toString().padStart(12, '0')}`,
      deltaQuantityScaled: '1000',
    }));
    expect(
      (await post('/v1/admin/inventory/adjustments', cookie, { ...ADJUSTMENT, lines: many }))
        .statusCode,
    ).toBe(400);

    expect(
      (await get(`/v1/admin/inventory/balances?branchId=${A.branch}&limit=201`, cookie)).statusCode,
    ).toBe(400);
    expect(
      (await get(`/v1/admin/inventory/balances?branchId=${A.branch}&limit=200`, cookie)).statusCode,
    ).toBe(200);
    expect(
      (await get(`/v1/admin/inventory/cost-balances?branchId=${A.branch}&limit=201`, cookie))
        .statusCode,
    ).toBe(400);
    expect(
      (await get(`/v1/admin/inventory/cost-balances?branchId=${A.branch}&limit=200`, cookie))
        .statusCode,
    ).toBe(200);
    expect((await get('/v1/admin/inventory/branches?limit=101', cookie)).statusCode).toBe(400);
    expect((await get('/v1/admin/inventory/branches?limit=100', cookie)).statusCode).toBe(200);
    expect((await get('/v1/admin/inventory/branches?cursor=not-a-uuid', cookie)).statusCode).toBe(
      400,
    );
  });

  it('returns quantity and revision as strings, not numbers', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    const response = await get(`/v1/admin/inventory/balances?branchId=${A.branch}`, cookie);
    expect(response.statusCode).toBe(200);

    // Asserted on the raw body: a value past 2^53 that survived as text is the
    // proof that nothing on this path went through a JSON number.
    expect(response.body).toContain('"quantityScaled":"9007199254740993000"');
    expect(response.body).toContain('"revision":"12"');
    expect(response.json()).toMatchObject({
      rows: [
        {
          productId: A.milk,
          sku: 'MILK-1L',
          nameAr: 'حليب',
          productType: 'unit',
          unitLabel: 'each',
          isActive: true,
          trackInventory: true,
        },
      ],
    });
  });

  it('returns a bounded inventory branch identity without tenant or settings authority', async () => {
    const server = await build(['inventory.read']);
    const cookie = await cookieFor(server);
    const response = await get('/v1/admin/inventory/branches?limit=25', cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      rows: [
        {
          id: A.branch,
          code: 'MAIN',
          nameAr: 'الفرع الرئيسي',
          nameEn: 'Main',
          isActive: true,
        },
      ],
      nextCursor: null,
    });
    expect(response.body).not.toMatch(/tenantId|settings|permissions|createdAt/);
    expect(seen).toEqual([{ method: 'branches', request: { limit: 25, cursor: null } }]);
  });

  it('returns exact valuation facts without tenant, retail-price or unit-cost authority', async () => {
    const server = await build(['inventory.cost.read']);
    const cookie = await cookieFor(server);
    const response = await get(
      `/v1/admin/inventory/cost-balances?branchId=${A.branch}&limit=25`,
      cookie,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"quantityScaled":"9007199254740993000"');
    expect(response.body).toContain('"knownQuantityScaled":"7000000000000000000"');
    expect(response.body).toContain('"unknownPositiveQuantityScaled":"2007199254740993000"');
    expect(response.body).toContain('"knownValueMinor":"900719925474099300"');
    expect(response.body).not.toMatch(/tenantId|priceMinor|unitCost|averageCost|vatBasisPoints/);
    expect(seen).toEqual([
      {
        method: 'costBalances',
        request: { branchId: A.branch, limit: 25, cursor: null },
      },
    ]);
  });

  it('accepts cost only as canonical non-negative integer text', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    for (const bad of ['-1', '01', '1.5', '2e3', '', ' 1', 4500]) {
      const response = await post('/v1/admin/inventory/cost-bootstrap', cookie, {
        ...COST_BOOTSTRAP,
        totalValueMinor: bad,
      });
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('requires canonical positive bootstrap observation guards', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    for (const body of [
      { ...COST_BOOTSTRAP, expectedStockRevision: '01' },
      { ...COST_BOOTSTRAP, expectedCostRevision: '-1' },
      { ...COST_BOOTSTRAP, expectedUnknownPositiveQuantityScaled: '0' },
      { ...COST_BOOTSTRAP, expectedUnknownPositiveQuantityScaled: '1.5' },
      {
        operationId: COST_BOOTSTRAP.operationId,
        branchId: COST_BOOTSTRAP.branchId,
        productId: COST_BOOTSTRAP.productId,
        totalValueMinor: COST_BOOTSTRAP.totalValueMinor,
      },
    ]) {
      const response = await post('/v1/admin/inventory/cost-bootstrap', cookie, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });
});

/**
 * UUID casing must not survive the door.
 *
 * `z.string().uuid()` accepts either casing and passes it through, so without
 * canonicalization here the service would receive two spellings of one row and
 * every identity comparison downstream would be comparing text.
 */
describe('UUID identity is canonicalized at the boundary', () => {
  it('G. accepts uppercase input but hands the service canonical lowercase', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    const response = await post('/v1/admin/inventory/adjustments', cookie, {
      ...ADJUSTMENT,
      branchId: A.branch.toUpperCase(),
      lines: [{ productId: A.milk.toUpperCase(), deltaQuantityScaled: '-2000' }],
    });
    expect(response.statusCode).toBe(201);

    const seenRequest = seen[0]?.request as {
      branchId: string;
      lines: { productId: string }[];
    };
    // Uppercase went in; canonical lowercase reached the authority.
    expect(seenRequest.branchId).toBe(A.branch);
    expect(seenRequest.lines[0]?.productId).toBe(A.milk);
  });

  it('canonicalizes the balances query branch id and cursor', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    const response = await get(
      `/v1/admin/inventory/balances?branchId=${A.branch.toUpperCase()}&cursor=${A.milk.toUpperCase()}`,
      cookie,
    );
    expect(response.statusCode).toBe(200);

    // This path reads rows directly and never passes through a validator, so
    // the door is the only place its identity can be canonicalized.
    const query = seen[0]?.request as { branchId: string; cursor: string | null };
    expect(query.branchId).toBe(A.branch);
    expect(query.cursor).toBe(A.milk);
  });

  it('canonicalizes cost read branch and cursor identities', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    const response = await get(
      `/v1/admin/inventory/cost-balances?branchId=${A.branch.toUpperCase()}&cursor=${A.milk.toUpperCase()}`,
      cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(seen[0]?.request).toEqual({ branchId: A.branch, limit: 50, cursor: A.milk });
  });

  it('canonicalizes the inventory branch cursor', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    const response = await get(
      `/v1/admin/inventory/branches?cursor=${A.branch.toUpperCase()}`,
      cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(seen[0]?.request).toEqual({ limit: 50, cursor: A.branch });
  });

  it('H. refuses a mixed-case duplicate product with the typed refusal', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    // Both lines name one physical product. Without canonical identity this
    // would reach the database and surface as a unique-index failure.
    nextFailure = { reason: 'duplicate-product', productId: null };
    const response = await post('/v1/admin/inventory/adjustments', cookie, {
      ...ADJUSTMENT,
      lines: [
        { productId: A.milk, deltaQuantityScaled: '1000' },
        { productId: A.milk.toUpperCase(), deltaQuantityScaled: '-1000' },
      ],
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'duplicate_product' });
  });

  it('I. refuses a mixed-case same-branch transfer with the typed refusal', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    nextFailure = { reason: 'same-branch', productId: null };
    const response = await post('/v1/admin/inventory/transfers', cookie, {
      ...TRANSFER,
      fromBranchId: A.branch,
      toBranchId: A.branch.toUpperCase(),
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'same_branch' });
  });

  it('still refuses a value that is not a UUID at all', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    for (const bad of ['not-a-uuid', '', `${A.milk}x`]) {
      const response = await post('/v1/admin/inventory/adjustments', cookie, {
        ...ADJUSTMENT,
        lines: [{ productId: bad, deltaQuantityScaled: '-2000' }],
      });
      expect(response.statusCode, bad).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('canonicalizes bootstrap identities and preserves financial values as strings', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    const response = await post('/v1/admin/inventory/cost-bootstrap', cookie, {
      ...COST_BOOTSTRAP,
      branchId: A.branch.toUpperCase(),
      productId: A.milk.toUpperCase(),
    });

    expect(response.statusCode).toBe(201);
    expect(seen).toEqual([{ method: 'bootstrapCost', request: COST_BOOTSTRAP }]);
    expect(response.body).toContain('"valuedQuantityScaled":"1000"');
    expect(response.body).toContain('"stockRevision":"12"');
    expect(response.body).toContain('"costRevision":"1"');
  });
});

describe('typed refusals map to stable statuses', () => {
  const cases: readonly [StockFailureReason, number][] = [
    ['invalid-money', 422],
    ['invalid-operation-id', 422],
    ['nothing-to-value', 409],
    ['stock-changed', 409],
    ['cost-state-changed', 409],
    ['insufficient-stock', 409],
    ['idempotency-conflict', 409],
    ['inactive-branch', 409],
    ['untracked-product', 409],
    ['unknown-branch', 404],
    ['unknown-product', 404],
    ['fractional-unit-quantity', 422],
    ['duplicate-product', 422],
    ['same-branch', 422],
  ];

  it('answers each refusal with its status and an Arabic message', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    for (const [reason, status] of cases) {
      nextFailure = { reason, productId: null };
      const response = await post('/v1/admin/inventory/adjustments', cookie, ADJUSTMENT);
      expect(response.statusCode, reason).toBe(status);
      const body = JSON.parse(response.body) as { error: string; message: string };
      expect(body.error, reason).toBe(reason.replace(/-/g, '_'));
      // Arabic, so the message is usable by the person holding the scanner.
      expect(body.message, reason).toMatch(/[؀-ۿ]/);
      // And it names no other tenant's data.
      expect(body.message, reason).not.toContain(A.tenant);
    }
  });

  it('names the product a line-level refusal is about', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    nextFailure = { reason: 'stock-changed', productId: A.milk };
    const response = await post('/v1/admin/inventory/counts', cookie, COUNT);
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'stock_changed',
      productId: A.milk,
    });
  });
});
