import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { createCheckoutService } from '../checkout/service.js';
import {
  MemoryAuthStore,
  memoryAuditRepository as memoryAuthAudit,
  memoryAuthRepository,
} from './support/memory-auth.js';
import {
  MemoryBusinessStore,
  memoryAuditRepository,
  memoryIdempotencyRepository,
  memoryInventoryRepository,
  memoryProductRepository,
  memorySaleRepository,
  memoryShiftRepository,
  memoryTenantRepository,
  memoryTerminalRepository,
  seedStore,
} from './support/memory-business.js';
import type { Fixture } from './support/memory-business.js';
import type { RoleName } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-real-password-9!';

const A: Fixture = {
  tenant: '018f2000-0000-7000-8000-00000000000a',
  branch: '018f2000-0000-7000-8000-0000000000a1',
  terminal: '018f2000-0000-7000-8000-0000000000a2',
  shift: '018f2000-0000-7000-8000-0000000000a3',
  user: '018f2000-0000-7000-8000-0000000000a4',
  milk: '018f2000-0000-7000-8000-0000000000a5',
  rice: '018f2000-0000-7000-8000-0000000000a6',
};

let app: FastifyInstance;
let business: MemoryBusinessStore;
let auth: MemoryAuthStore;

async function build(role: RoleName, openShift = true): Promise<FastifyInstance> {
  business = new MemoryBusinessStore();
  seedStore(business, A, openShift);

  auth = new MemoryAuthStore();
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

  let counter = 0;
  const server = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: createAuthService({
      repository: memoryAuthRepository(auth),
      audit: memoryAuthAudit(auth),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    }),
    business: {
      products: memoryProductRepository(business),
      shifts: memoryShiftRepository(business),
      terminals: memoryTerminalRepository(business),
      checkout: createCheckoutService({
        tenants: memoryTenantRepository(business),
        products: memoryProductRepository(business),
        inventory: memoryInventoryRepository(business),
        shifts: memoryShiftRepository(business),
        sales: memorySaleRepository(business),
        idempotency: memoryIdempotencyRepository(business),
        audit: memoryAuditRepository(business),
        newId: () => {
          counter += 1;
          return `018f2000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
        },
      }),
    },
  });
  await server.ready();
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

afterEach(async () => {
  await app.close();
});

describe('GET /v1/products', () => {
  beforeEach(async () => {
    app = await build('cashier');
  });

  it('refuses without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/products' });
    expect(response.statusCode).toBe(401);
  });

  it('lists the tenant’s products for a cashier', async () => {
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/products', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ products: { sku: string }[] }>();
    expect(body.products.map((p) => p.sku).sort()).toEqual(['MILK-1L', 'RICE-5K']);
  });

  it('finds a product by the start of its Arabic name', async () => {
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/products?q=' + encodeURIComponent('حليب'),
      headers: { cookie },
    });
    const body = response.json<{ products: { sku: string }[] }>();
    expect(body.products).toHaveLength(1);
    expect(body.products[0]?.sku).toBe('MILK-1L');
  });

  it('resolves a scanned barcode to exactly one product', async () => {
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/products?q=6281000000002',
      headers: { cookie },
    });
    const body = response.json<{ products: { sku: string }[] }>();
    expect(body.products).toHaveLength(1);
    expect(body.products[0]?.sku).toBe('RICE-5K');
  });

  it('never offers a deactivated product to a till', async () => {
    business.products[0] = { ...business.products[0]!, isActive: false };
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/products', headers: { cookie } });
    const body = response.json<{ products: { sku: string }[] }>();
    expect(body.products.map((p) => p.sku)).toEqual(['RICE-5K']);
  });

  it('bounds the page size rather than serialising the catalogue', async () => {
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/products?limit=5000',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /v1/products, without the permission', () => {
  it('answers 403 for a role that may not read the catalogue', async () => {
    app = await build('cashier');
    // Strip the permission the way a real tenant would: by not granting it.
    auth.grants[0] = { tenantId: A.tenant, userId: A.user, roles: ['cashier'], permissions: [] };
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/products', headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });
});

describe('shifts', () => {
  it('reports no open shift, then opens one', async () => {
    app = await build('cashier', false);
    const cookie = await cookieFor(app);

    const before = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${A.terminal}`,
      headers: { cookie },
    });
    expect(before.json()).toEqual({ shift: null });

    const opened = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: A.terminal, openingFloatMinor: '20000' },
    });
    expect(opened.statusCode).toBe(201);
    const body = opened.json<{ shift: { branchId: string; userId: string } }>();
    // The branch came from the terminal and the cashier from the session.
    expect(body.shift.branchId).toBe(A.branch);
    expect(body.shift.userId).toBe(A.user);
  });

  it('refuses a second shift on the same till', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: A.terminal, openingFloatMinor: '20000' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects a body that names a branch', async () => {
    app = await build('cashier', false);
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: A.terminal, openingFloatMinor: '20000', branchId: A.branch },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'forbidden_field', field: 'branchId' });
  });
});

describe('POST /v1/sales', () => {
  const operation = '018f2000-0000-7000-8000-0000000000f1';

  function sale(server: FastifyInstance, cookie: string, overrides: Record<string, unknown> = {}) {
    return server.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: operation,
        terminalId: A.terminal,
        cashReceivedMinor: '5000',
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        ...overrides,
      },
    });
  }

  it('completes a cash sale and returns a safe summary', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie);

    expect(response.statusCode).toBe(201);
    const body = response.json<{ sale: Record<string, string>; replayed: boolean }>();
    expect(body.sale['totalMinor']).toBe('2300');
    expect(body.sale['changeMinor']).toBe('2700');
    expect(body.sale['invoiceNumber']).toBe('01-000001');
    expect(body.replayed).toBe(false);
    // Nothing internal crosses the wire.
    expect(response.payload).not.toContain('tokenHash');
    expect(response.payload).not.toContain('passwordHash');
    expect(response.payload).not.toContain('requestHash');
  });

  it.each([
    ['unitPriceMinor', { unitPriceMinor: '1' }],
    ['totalMinor', { totalMinor: '1' }],
    ['tenantId', { tenantId: '018f2000-0000-7000-8000-00000000000b' }],
    ['userId', { userId: '018f2000-0000-7000-8000-0000000000ff' }],
    ['roles', { roles: ['owner'] }],
    ['sequence', { sequence: 99 }],
  ])('rejects a body that tries to set %s', async (field, overrides) => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie, overrides);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'forbidden_field', field });
  });

  it('answers 409 with an Arabic message when there is no open shift', async () => {
    app = await build('cashier', false);
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toContain('وردية');
  });

  it('answers 422 when the cash does not cover the total', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie, { cashReceivedMinor: '100' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'insufficient-cash' });
  });

  it('replays the same sale for a repeated request, creating nothing', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const first = await sale(app, cookie);
    const second = await sale(app, cookie);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ replayed: boolean }>().replayed).toBe(true);
    expect(business.sales).toHaveLength(1);
  });

  it('answers 409 when the same key carries a different basket', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    await sale(app, cookie);
    const conflicting = await sale(app, cookie, {
      lines: [{ productId: A.milk, quantityScaled: '4000' }],
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ error: 'idempotency-conflict' });
    expect(business.sales).toHaveLength(1);
  });

  it('refuses a caller without sale.create', async () => {
    app = await build('cashier');
    auth.grants[0] = {
      tenantId: A.tenant,
      userId: A.user,
      roles: ['cashier'],
      permissions: ['product.read'],
    };
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie);
    expect(response.statusCode).toBe(403);
  });

  it('refuses an unauthenticated checkout', async () => {
    app = await build('cashier');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { origin: ORIGIN },
      payload: {
        operationId: operation,
        terminalId: A.terminal,
        cashReceivedMinor: '5000',
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('bounds the number of cart lines', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie, {
      lines: Array.from({ length: 500 }, () => ({ productId: A.milk, quantityScaled: '1000' })),
    });
    expect(response.statusCode).toBe(400);
  });
});
