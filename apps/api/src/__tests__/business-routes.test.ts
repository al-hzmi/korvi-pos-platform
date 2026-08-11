import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { ShiftReconciliationRefusedError } from '@korvi/database';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { createCheckoutService } from '../checkout/service.js';
import { createReturnService } from '../returns/service.js';
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
  const movements = new Map<string, { fingerprint: string; result: object }>();
  const closes = new Map<string, { fingerprint: string; result: object }>();
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
      shifts: memoryShiftRepository(business),
      shiftReconciliation: {
        recordManualMovement: (_scope, input) => {
          const fingerprint = JSON.stringify([
            input.shiftId,
            input.terminalId,
            input.kind,
            input.amountMinor,
            input.reason,
          ]);
          const prior = movements.get(input.operationId);
          if (prior !== undefined) {
            if (prior.fingerprint !== fingerprint)
              return Promise.reject(new ShiftReconciliationRefusedError('idempotency-conflict'));
            return Promise.resolve(prior.result as never);
          }
          const shift = business.shifts.find((candidate) => candidate.id === input.shiftId);
          if (
            shift === undefined ||
            shift.status !== 'open' ||
            shift.terminalId !== input.terminalId
          )
            return Promise.reject(new ShiftReconciliationRefusedError('shift-invalid'));
          const result = {
            id: input.movementId,
            shiftId: input.shiftId,
            kind: input.kind,
            amountMinor: input.kind === 'pay-in' ? input.amountMinor : `-${input.amountMinor}`,
            reason: input.reason,
            actorUserId: input.actorUserId,
            occurredAt: input.occurredAt,
          };
          movements.set(input.operationId, { fingerprint, result });
          return Promise.resolve(result);
        },
        reconcile: (_scope, input) => {
          const fingerprint = JSON.stringify([
            input.shiftId,
            input.terminalId,
            input.declaredCashMinor,
          ]);
          const prior = closes.get(input.operationId);
          if (prior !== undefined) {
            if (prior.fingerprint !== fingerprint)
              return Promise.reject(new ShiftReconciliationRefusedError('idempotency-conflict'));
            return Promise.resolve(prior.result as never);
          }
          const shift = business.shifts.find((candidate) => candidate.id === input.shiftId);
          if (
            shift === undefined ||
            shift.status !== 'open' ||
            shift.terminalId !== input.terminalId
          )
            return Promise.reject(new ShiftReconciliationRefusedError('shift-invalid'));
          const expected = BigInt(shift.openingFloatMinor);
          const result = {
            shiftId: input.shiftId,
            openingFloatMinor: shift.openingFloatMinor,
            cashSalesMinor: '0',
            cashRefundsMinor: '0',
            paidInMinor: '0',
            paidOutMinor: '0',
            expectedCashMinor: expected.toString(),
            declaredCashMinor: input.declaredCashMinor,
            varianceMinor: (BigInt(input.declaredCashMinor) - expected).toString(),
            closedAt: input.closedAt,
            closedByUserId: input.actorUserId,
          };
          closes.set(input.operationId, { fingerprint, result });
          return Promise.resolve(result);
        },
      },
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
      returns: createReturnService({
        returns: memoryReturnRepository(business),
        terminals: memoryTerminalRepository(business),
        shifts: memoryShiftRepository(business),
        idempotency: memoryIdempotencyRepository(business),
        audit: memoryAuditRepository(business),
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

describe('GET /v1/dashboard/summary', () => {
  it('refuses without a session', async () => {
    app = await build('cashier');
    const response = await app.inject({ method: 'GET', url: '/v1/dashboard/summary' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a cashier, who does not hold report.read', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    // Nothing about the tenant leaks through a refusal.
    expect(response.payload).not.toContain('grossSales');
  });

  it('answers a manager with real, tenant-scoped figures', async () => {
    app = await build('manager');
    const cookie = await cookieFor(app);

    const sale = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000c1',
        terminalId: A.terminal,
        cashReceivedMinor: '5000',
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
      },
    });
    expect(sale.statusCode).toBe(201);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<Record<string, unknown>>();
    // 2 x 11.50 tax-inclusive: 23.00 with 3.00 of VAT. Counted, not guessed.
    expect(body['salesLast24HoursCount']).toBe(1);
    expect(body['grossSalesLast24HoursMinor']).toBe('2300');
    expect(body['vatLast24HoursMinor']).toBe('300');
    expect(body['openShiftCount']).toBe(1);
    expect(body['terminalCount']).toBe(1);
    expect(body['activeProductCount']).toBe(2);
    expect(body['currency']).toBe('SAR');
  });

  it('keeps money as a string, never a JSON number', async () => {
    // A JSON number loses halalas past 2^53 and rounds on the way in. The
    // aggregate crosses as a decimal string exactly like every other amount.
    app = await build('manager');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary',
      headers: { cookie },
    });
    const body = response.json<Record<string, unknown>>();
    expect(typeof body['grossSalesLast24HoursMinor']).toBe('string');
    expect(typeof body['vatLast24HoursMinor']).toBe('string');
  });

  it('counts nothing belonging to another tenant', async () => {
    // The repository takes a scope and has no parameter that could widen it;
    // this proves the route does not widen it either.
    app = await build('manager');
    business.sales.push({
      ...(business.sales[0] ?? ({} as (typeof business.sales)[number])),
      id: '018f2000-0000-7000-8000-0000000000c9',
      tenantId:
        '018f2000-0000-7000-8000-00000000000b' as (typeof business.sales)[number]['tenantId'],
      status: 'finalized',
      totalMinor: '999999',
      vatMinor: '99999',
      issuedAt: new Date().toISOString(),
    });

    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary',
      headers: { cookie },
    });
    const body = response.json<Record<string, unknown>>();
    expect(body['grossSalesLast24HoursMinor']).toBe('0');
    expect(body['salesLast24HoursCount']).toBe(0);
  });
});

describe('branch authorisation', () => {
  /*
   * A second branch of the SAME tenant, with its own till.
   *
   * RLS keeps one merchant out of another merchant's rows; it has nothing to
   * say about one branch of a merchant reaching into another, because both
   * are inside the same tenant scope. A cashier pinned to branch A who is
   * handed a terminal id from branch B is already past every check the scope
   * performs, so the routes have to make that check themselves.
   *
   * GET /v1/terminals listing only branch A's tills shapes the interface. It
   * is not an authorisation boundary and is not treated as one here.
   */
  const OTHER_BRANCH = '018f2000-0000-7000-8000-0000000000d1';
  const OTHER_TERMINAL = '018f2000-0000-7000-8000-0000000000d2';

  function addForeignTerminal(): void {
    business.terminals.push({
      id: OTHER_TERMINAL,
      tenantId: business.terminals[0]!.tenantId,
      branchId: OTHER_BRANCH,
      code: '90',
      // Open, staffed and real. It simply is not this cashier's branch.
      label: '\u0635\u0646\u062f\u0648\u0642 \u0641\u0631\u0639 \u0622\u062e\u0631',
      isActive: true,
      lastSeenAt: null,
    });
    business.shifts.push({
      id: '018f2000-0000-7000-8000-0000000000d3',
      tenantId: business.terminals[0]!.tenantId,
      branchId: OTHER_BRANCH,
      terminalId: OTHER_TERMINAL,
      userId: '018f2000-0000-7000-8000-0000000000d4',
      status: 'open',
      openingFloatMinor: '75000',
      declaredCashMinor: null,
      expectedCashMinor: null,
      varianceMinor: null,
      openedAt: '2026-08-12T05:00:00.000Z',
      closedAt: null,
      movements: [],
    });
  }

  it('answers for the cashier\u2019s own till', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${A.terminal}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ shift: { terminalId: string } }>().shift.terminalId).toBe(A.terminal);
  });

  it('will not read a shift on another branch\u2019s till, and leaks nothing about it', async () => {
    app = await build('cashier');
    addForeignTerminal();
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${OTHER_TERMINAL}`,
      headers: { cookie },
    });

    // Exactly what an id that does not exist would produce. A 403 would
    // confirm the till is real, which is the thing being withheld.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'unknown_terminal' });

    const body = response.payload;
    expect(body).not.toContain('75000');
    expect(body).not.toContain(OTHER_BRANCH);
    expect(body).not.toContain('018f2000-0000-7000-8000-0000000000d3');
    expect(body).not.toContain('018f2000-0000-7000-8000-0000000000d4');
    expect(body).not.toContain('2026-08-12T05:00:00.000Z');
    expect(body).not.toContain('shift');
  });

  it('gives the same answer for a till that never existed', async () => {
    app = await build('cashier');
    addForeignTerminal();
    const cookie = await cookieFor(app);
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/shifts/current?terminalId=018f2000-0000-7000-8000-00000000dead',
      headers: { cookie },
    });
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${OTHER_TERMINAL}`,
      headers: { cookie },
    });

    expect(missing.statusCode).toBe(foreign.statusCode);
    expect(missing.payload).toBe(foreign.payload);
  });

  it('will not open a shift on another branch\u2019s till', async () => {
    app = await build('cashier', false);
    addForeignTerminal();
    const before = business.shifts.length;
    const cookie = await cookieFor(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: OTHER_TERMINAL, openingFloatMinor: '20000' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'unknown_terminal' });
    // Nothing was written: not a shift, and not the opening-float movement
    // that would have gone with it.
    expect(business.shifts).toHaveLength(before);
    expect(
      business.shifts.some(
        (shift) => shift.terminalId === OTHER_TERMINAL && shift.branchId === A.branch,
      ),
    ).toBe(false);
    expect(business.openingMovements).toHaveLength(0);
  });

  it('still opens a shift on the cashier\u2019s own till', async () => {
    app = await build('cashier', false);
    addForeignTerminal();
    const cookie = await cookieFor(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: A.terminal, openingFloatMinor: '20000' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ shift: { branchId: string } }>().shift.branchId).toBe(A.branch);
    expect(business.openingMovements).toHaveLength(1);
  });

  it('refuses a deactivated till in the cashier\u2019s own branch', async () => {
    app = await build('cashier', false);
    business.terminals[0] = { ...business.terminals[0]!, isActive: false };
    const cookie = await cookieFor(app);

    const current = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${A.terminal}`,
      headers: { cookie },
    });
    expect(current.statusCode).toBe(404);
  });

  describe('a principal with no branch', () => {
    async function branchless(): Promise<string> {
      app = await build('cashier');
      auth.memberships[0] = { ...auth.memberships[0]!, defaultBranchId: null };
      return cookieFor(app);
    }

    it('cannot read a shift', async () => {
      const cookie = await branchless();
      const response = await app.inject({
        method: 'GET',
        url: `/v1/shifts/current?terminalId=${A.terminal}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'branch_required' });
    });

    it('cannot open a shift', async () => {
      const cookie = await branchless();
      const before = business.shifts.length;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/shifts/open',
        headers: { cookie, origin: ORIGIN },
        payload: { terminalId: A.terminal, openingFloatMinor: '20000' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'branch_required' });
      expect(business.shifts).toHaveLength(before);
    });

    it('cannot list tills', async () => {
      const cookie = await branchless();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/terminals',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'branch_required' });
    });
  });

  it('never lets a branch arrive from the client', async () => {
    app = await build('cashier', false);
    addForeignTerminal();
    const cookie = await cookieFor(app);

    // In the body: rejected outright by the forbidden-field guard.
    const named = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: A.terminal, openingFloatMinor: '20000', branchId: OTHER_BRANCH },
    });
    expect(named.statusCode).toBe(400);
    expect(named.json()).toMatchObject({ error: 'forbidden_field', field: 'branchId' });

    // In the query: ignored, and the foreign till stays invisible.
    const smuggled = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${OTHER_TERMINAL}&branchId=${OTHER_BRANCH}`,
      headers: { cookie },
    });
    expect(smuggled.statusCode).toBe(404);
  });
});

describe('GET /v1/terminals', () => {
  it('refuses without a session', async () => {
    app = await build('cashier');
    const response = await app.inject({ method: 'GET', url: '/v1/terminals' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the active tills of the session\u2019s own branch', async () => {
    app = await build('cashier');
    business.terminals.push({
      id: '018f2000-0000-7000-8000-0000000000b1',
      tenantId: business.terminals[0]!.tenantId,
      branchId: A.branch,
      code: '02',
      label: '\u0635\u0646\u062f\u0648\u0642 \u0662',
      isActive: true,
      lastSeenAt: null,
    });
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ branchId: string; terminals: { code: string }[] }>();
    expect(body.branchId).toBe(A.branch);
    expect(body.terminals.map((terminal) => terminal.code).sort()).toEqual(['01', '02']);
    // Only what a till needs to identify itself.
    expect(Object.keys(body.terminals[0] ?? {}).sort()).toEqual([
      'branchId',
      'code',
      'id',
      'label',
    ]);
  });

  it('never offers a deactivated till', async () => {
    app = await build('cashier');
    business.terminals[0] = { ...business.terminals[0]!, isActive: false };
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });
    expect(response.json<{ terminals: unknown[] }>().terminals).toHaveLength(0);
  });

  it('ignores a branch the client tries to name', async () => {
    // The one thing this endpoint must never do. A client that could choose a
    // branch could enumerate every till in the tenant.
    app = await build('cashier');
    business.terminals.push({
      id: '018f2000-0000-7000-8000-0000000000b2',
      tenantId: business.terminals[0]!.tenantId,
      branchId: '018f2000-0000-7000-8000-0000000000c9',
      code: '99',
      label: '\u0641\u0631\u0639 \u0622\u062e\u0631',
      isActive: true,
      lastSeenAt: null,
    });
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/terminals?branchId=018f2000-0000-7000-8000-0000000000c9',
      headers: { cookie },
    });
    const body = response.json<{ branchId: string; terminals: { code: string }[] }>();
    expect(body.branchId).toBe(A.branch);
    expect(body.terminals.map((terminal) => terminal.code)).toEqual(['01']);
  });

  it('says branch context is required when the principal has no branch', async () => {
    app = await build('cashier');
    auth.memberships[0] = { ...auth.memberships[0]!, defaultBranchId: null };
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'branch_required' });
  });

  it('carries the tenant’s price mode so the till never guesses it', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });

    const body = response.json<{ settings: { priceMode: string; currency: string } }>();
    expect(body.settings).toEqual({ priceMode: 'tax-inclusive', currency: 'SAR' });
  });

  it('reports a tenant with no settings rather than inventing a price mode', async () => {
    app = await build('cashier');
    business.settings.length = 0;
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'tenant-misconfigured' });
  });

  it('ignores a price mode the client tries to send', async () => {
    // The one thing that would let a browser decide how much VAT a sale
    // carries.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/terminals?priceMode=tax-exclusive&currency=USD',
      headers: { cookie },
    });
    expect(response.json<{ settings: { priceMode: string; currency: string } }>().settings).toEqual(
      {
        priceMode: 'tax-inclusive',
        currency: 'SAR',
      },
    );
  });

  it('refuses a caller without shift.open', async () => {
    app = await build('cashier');
    auth.grants[0] = {
      tenantId: A.tenant,
      userId: A.user,
      roles: ['cashier'],
      permissions: ['sale.create'],
    };
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });
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

describe('POST /v1/sales — the drawer', () => {
  function checkout(
    server: FastifyInstance,
    cookie: string,
    overrides: Record<string, unknown> = {},
  ) {
    return server.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000e5',
        terminalId: A.terminal,
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        ...overrides,
      },
    });
  }

  it('moves the drawer by the cash that stayed in it, not by the sale total', async () => {
    // 23.00 sale, 10.00 on a card, 20.00 cash, 7.00 back. The drawer gained
    // 13.00. Recording 23.00 would leave every shift short by the card
    // portion, every day, with nothing to point at.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    await checkout(app, cookie, {
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-3', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });

    expect(business.cashMovements).toHaveLength(1);
    expect(business.cashMovements[0]).toMatchObject({ kind: 'sale', amountMinor: '1300' });
  });

  it('records no drawer movement at all for an electronic-only sale', async () => {
    // Nothing was taken in cash. A zero row is a movement that did not happen.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [{ kind: 'electronic', scheme: 'visa', reference: 'AUTH-4', amountMinor: '2300' }],
    });

    expect(response.statusCode).toBe(201);
    expect(business.cashMovements).toHaveLength(0);
  });

  it('leaves the cash-only drawer effect exactly as it was', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    await checkout(app, cookie, { cashReceivedMinor: '5000' });

    // 50.00 given, 27.00 back, 23.00 retained — which for a cash-only sale is
    // the total, as it always was.
    expect(business.cashMovements[0]).toMatchObject({ kind: 'sale', amountMinor: '2300' });
  });
});

describe('POST /v1/sales — discount permission', () => {
  it('refuses a discount from a principal whose grants omit sale.discount', async () => {
    // The ceiling says how much; the permission says whether at all. A role
    // may confer a ceiling while the persisted grant does not confer the
    // capability, and permissions are what the server checks.
    app = await build('manager');
    auth.grants[0] = {
      tenantId: A.tenant,
      userId: A.user,
      roles: ['manager'],
      permissions: ['product.read', 'sale.create', 'shift.open'],
    };
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000e6',
        terminalId: A.terminal,
        cashReceivedMinor: '5000',
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        basketDiscount: { mode: 'basis-points', value: 500 },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'discount-not-authorized' });
    expect(business.sales).toHaveLength(0);
  });

  it('still lets that principal sell without a discount', async () => {
    app = await build('manager');
    auth.grants[0] = {
      tenantId: A.tenant,
      userId: A.user,
      roles: ['manager'],
      permissions: ['product.read', 'sale.create', 'shift.open'],
    };
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000e7',
        terminalId: A.terminal,
        cashReceivedMinor: '5000',
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
      },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('POST /v1/sales — a card number by any name', () => {
  it('refuses an approval reference that is really a card number', async () => {
    // A synthetic test PAN. Rejecting fields called `pan` does not stop an
    // integration putting one in `reference`.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000e8',
        terminalId: A.terminal,
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        tenders: [
          {
            kind: 'electronic',
            scheme: 'visa',
            reference: '4111 1111 1111 1111',
            amountMinor: '2300',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'card_data_refused' });
    // The refusal must not become the place the number gets written down.
    expect(response.payload).not.toContain('4111');
    expect(business.sales).toHaveLength(0);
  });

  it('leaves ordinary approval codes alone', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000e9',
        terminalId: A.terminal,
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        tenders: [{ kind: 'electronic', scheme: 'mada', reference: '004512', amountMinor: '2300' }],
      },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('POST /v1/sales — settlement', () => {
  const operation = '018f2000-0000-7000-8000-0000000000e1';

  /** Milk is 11.50 tax-inclusive; two of them is 23.00 exactly. */
  function checkout(
    server: FastifyInstance,
    cookie: string,
    overrides: Record<string, unknown> = {},
  ) {
    return server.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: operation,
        terminalId: A.terminal,
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        ...overrides,
      },
    });
  }

  it('still accepts the cash-only shape the till sends today', async () => {
    // The production browser is not being changed by this strike. If this
    // test ever needs editing, something has gone wrong.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, { cashReceivedMinor: '5000' });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ sale: Record<string, string> }>();
    expect(body.sale['totalMinor']).toBe('2300');
    expect(body.sale['changeMinor']).toBe('2700');
  });

  it('settles a card and cash together, with the change out of the cash', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-77', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      sale: Record<string, string> & {
        tenders: { kind: string; scheme: string | null; amountMinor: string }[];
      };
    }>();
    expect(body.sale['totalMinor']).toBe('2300');
    // Three concepts, three numbers. Calling the tendered total "cash
    // received" was a statement about the drawer that was simply false.
    expect(body.sale['tenderedMinor']).toBe('3000');
    expect(body.sale['cashReceivedMinor']).toBe('2000');
    expect(body.sale['changeMinor']).toBe('700');
    expect(
      body.sale.tenders.map((tender) => [tender.kind, tender.scheme, tender.amountMinor]),
    ).toEqual([
      ['electronic', 'mada', '1000'],
      ['cash', null, '2000'],
    ]);

    // 13.00 of the 20.00 cash stays in the drawer; the card settled 10.00.
    const recorded = business.sales[0];
    const tenders = recorded?.tenders ?? [];
    expect(tenders).toHaveLength(2);
    const cash = tenders.find((tender) => tender.kind === 'cash');
    const card = tenders.find((tender) => tender.kind === 'electronic');
    expect(cash?.changeMinor).toBe('700');
    expect(cash?.scheme).toBeNull();
    expect(card?.scheme).toBe('mada');
    expect(card?.reference).toBe('AUTH-77');
    expect(card?.changeMinor).toBe('0');
  });

  it('refuses a card charged more than the sale', async () => {
    // No mechanism exists to hand the difference back.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [{ kind: 'electronic', scheme: 'visa', reference: 'AUTH-1', amountMinor: '2400' }],
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'electronic-overpay' });
    expect(business.sales).toHaveLength(0);
  });

  it.each([
    ['both', { cashReceivedMinor: '5000', tenders: [{ kind: 'cash', amountMinor: '5000' }] }],
    ['neither', {}],
  ])('refuses a request naming %s payment shape', async (_label, overrides) => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, overrides);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_body' });
    expect(business.sales).toHaveLength(0);
  });

  it.each([
    ['pan', { pan: '4111111111111111' }],
    ['cvv', { cvv: '123' }],
    ['track2', { track2: ';4111111111111111=2512?' }],
  ])('refuses cardholder data sent as %s', async (field, extra) => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      cashReceivedMinor: '5000',
      ...extra,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'card_data_refused', field });
  });

  it('finds cardholder data nested inside a tender', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [
        {
          kind: 'electronic',
          scheme: 'mada',
          reference: 'AUTH-1',
          amountMinor: '2300',
          cardNumber: '4111111111111111',
        },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'card_data_refused', field: 'cardNumber' });
  });

  it.each([
    ['zero', [{ kind: 'cash', amountMinor: '0' }]],
    [
      'two cash lines',
      [
        { kind: 'cash', amountMinor: '1200' },
        { kind: 'cash', amountMinor: '1200' },
      ],
    ],
    [
      'a repeated approval',
      [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-1', amountMinor: '1150' },
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-1', amountMinor: '1150' },
      ],
    ],
  ])('refuses %s as a tender list', async (_label, tenders) => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, { tenders });
    // Either the schema catches it or the domain does; both refuse, and
    // neither creates a sale.
    expect([400, 422]).toContain(response.statusCode);
    expect(business.sales).toHaveLength(0);
  });

  it('refuses an unknown scheme', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [
        { kind: 'electronic', scheme: 'bitcoin', reference: 'AUTH-1', amountMinor: '2300' },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an oversized approval reference', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [
        {
          kind: 'electronic',
          scheme: 'mada',
          reference: 'A'.repeat(65),
          amountMinor: '2300',
        },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 409 when the same key is reused with a different payment mix', async () => {
    // The same basket paid a different way is a different commercial event.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const first = await checkout(app, cookie, { cashReceivedMinor: '5000' });
    expect(first.statusCode).toBe(201);

    const second = await checkout(app, cookie, {
      tenders: [{ kind: 'electronic', scheme: 'mada', reference: 'AUTH-2', amountMinor: '2300' }],
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'idempotency-conflict' });
    expect(business.sales).toHaveLength(1);
  });

  it('replays a legacy cash request sent again as its tender equivalent', async () => {
    // The two shapes normalise to the same intent, so this is a retry and not
    // a conflict.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    await checkout(app, cookie, { cashReceivedMinor: '5000' });
    const again = await checkout(app, cookie, {
      tenders: [{ kind: 'cash', amountMinor: '5000' }],
    });

    expect(again.statusCode).toBe(200);
    expect(again.json<{ replayed: boolean }>().replayed).toBe(true);
    expect(business.sales).toHaveLength(1);
  });
});

describe('POST /v1/sales — discounts', () => {
  const operation = '018f2000-0000-7000-8000-0000000000e2';

  function discounted(server: FastifyInstance, cookie: string, overrides: Record<string, unknown>) {
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

  it('refuses any discount from a cashier, who is authorised for none', async () => {
    // ROLE_MAX_DISCOUNT_BP.cashier is 0 bp. One halala off is still a discount.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await discounted(app, cookie, {
      basketDiscount: { mode: 'fixed', amountMinor: '1' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'discount-not-authorized' });
    expect(business.sales).toHaveLength(0);
  });

  it('lets a manager grant a discount inside their ceiling, and records it', async () => {
    app = await build('manager');
    const cookie = await cookieFor(app);
    const response = await discounted(app, cookie, {
      basketDiscount: { mode: 'basis-points', value: 1_000, reason: 'عرض الافتتاح' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ sale: Record<string, string> }>();
    // 23.00 less 10% is 20.70.
    expect(body.sale['totalMinor']).toBe('2070');

    const recorded = business.sales[0];
    expect(recorded?.discounts).toHaveLength(1);
    expect(recorded?.discounts[0]).toMatchObject({
      scope: 'basket',
      kind: 'percentage',
      inputValue: '1000',
      amountMinor: '230',
      reason: 'عرض الافتتاح',
      grantedByUserId: A.user,
    });
  });

  it('refuses a manager a discount beyond their ceiling', async () => {
    // ROLE_MAX_DISCOUNT_BP.manager is 2000 bp.
    app = await build('manager');
    const cookie = await cookieFor(app);
    const response = await discounted(app, cookie, {
      basketDiscount: { mode: 'basis-points', value: 2_001 },
    });
    expect(response.statusCode).toBe(403);
    expect(business.sales).toHaveLength(0);
  });

  it('refuses a fixed discount that is over the ceiling by less than a basis point', async () => {
    /*
     * The rounding case, end to end. 23.00 at 2000 bp permits 4.60 exactly;
     * 4.61 is 2004 bp once the rate is computed honestly, and truncation used
     * to report it as 2004 too — but on a base that does not divide evenly the
     * old arithmetic let a discount just over the line through.
     */
    app = await build('manager');
    const cookie = await cookieFor(app);

    const allowed = await discounted(app, cookie, {
      basketDiscount: { mode: 'fixed', amountMinor: '460' },
    });
    expect(allowed.statusCode).toBe(201);

    app = await build('manager');
    const cookie2 = await cookieFor(app);
    const refused = await discounted(app, cookie2, {
      basketDiscount: { mode: 'fixed', amountMinor: '461' },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('records a line discount against the line that got it', async () => {
    app = await build('manager');
    const cookie = await cookieFor(app);
    const response = await discounted(app, cookie, {
      lines: [
        {
          productId: A.milk,
          quantityScaled: '2000',
          discount: { mode: 'fixed', amountMinor: '150' },
        },
      ],
    });

    expect(response.statusCode).toBe(201);
    const recorded = business.sales[0];
    expect(recorded?.discounts[0]).toMatchObject({
      scope: 'line',
      lineNumber: 1,
      kind: 'fixed',
      inputValue: '150',
      amountMinor: '150',
    });
    expect(recorded?.totalMinor).toBe('2150');
  });

  it('never lets a client name the discount it was granted', async () => {
    app = await build('manager');
    const cookie = await cookieFor(app);
    const response = await discounted(app, cookie, {
      basketDiscount: { mode: 'basis-points', value: 1_000 },
      discount: { mode: 'fixed', amountMinor: '2300' },
    });
    // `discount` is on the forbidden-field list and is refused by name.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'forbidden_field', field: 'discount' });
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

describe('shift reconciliation routes', () => {
  const operationId = '018f2000-0000-7000-8000-0000000000b1';
  const closePayload = (over: Record<string, unknown> = {}) => ({
    operationId,
    terminalId: A.terminal,
    shiftId: A.shift,
    declaredCashMinor: '10000',
    ...over,
  });
  const movementPayload = (over: Record<string, unknown> = {}) => ({
    operationId,
    terminalId: A.terminal,
    shiftId: A.shift,
    kind: 'pay-in',
    amountMinor: '100',
    reason: '  float top-up  ',
    ...over,
  });
  const post = (server: FastifyInstance, url: string, payload: object, cookie?: string) =>
    server.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
      payload,
    });

  it.each([
    ['/v1/shifts/close', closePayload()],
    ['/v1/shifts/cash-movements', movementPayload()],
  ])('refuses unauthenticated %s', async (url, payload) => {
    app = await build('manager');
    expect((await post(app, url, payload)).statusCode).toBe(401);
  });

  it.each([
    ['/v1/shifts/close', closePayload()],
    ['/v1/shifts/cash-movements', movementPayload()],
  ])('enforces the route permission for %s', async (url, payload) => {
    app = await build('manager');
    auth.grants[0] = {
      tenantId: A.tenant,
      userId: A.user,
      roles: ['manager'],
      permissions: ['product.read'],
    };
    expect((await post(app, url, payload, await cookieFor(app))).statusCode).toBe(403);
  });

  it('lets a valid close reach the reconciliation repository', async () => {
    app = await build('cashier');
    const response = await post(app, '/v1/shifts/close', closePayload(), await cookieFor(app));
    expect(response.statusCode).toBe(200);
    expect(response.json().reconciliation.shiftId).toBe(A.shift);
  });

  it('lets a valid movement reach the repository and canonicalizes its reason', async () => {
    app = await build('manager');
    const response = await post(
      app,
      '/v1/shifts/cash-movements',
      movementPayload(),
      await cookieFor(app),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json().movement.reason).toBe('float top-up');
  });

  it.each(['/v1/shifts/close', '/v1/shifts/cash-movements'])(
    'hides unknown and cross-branch terminals for %s',
    async (url) => {
      app = await build('manager');
      const cookie = await cookieFor(app);
      const payload = url.endsWith('close')
        ? closePayload({ terminalId: '018f2000-0000-7000-8000-000000000099' })
        : movementPayload({ terminalId: '018f2000-0000-7000-8000-000000000099' });
      expect((await post(app, url, payload, cookie)).statusCode).toBe(404);
      business.terminals[0] = {
        ...business.terminals[0]!,
        branchId: '018f2000-0000-7000-8000-000000000088',
      };
      const ownPayload = url.endsWith('close') ? closePayload() : movementPayload();
      expect((await post(app, url, ownPayload, cookie)).statusCode).toBe(404);
    },
  );

  it.each(['/v1/shifts/close', '/v1/shifts/cash-movements'])(
    'refuses wrong or stale shift for %s',
    async (url) => {
      app = await build('manager');
      const cookie = await cookieFor(app);
      const wrong = url.endsWith('close')
        ? closePayload({ shiftId: '018f2000-0000-7000-8000-000000000077' })
        : movementPayload({ shiftId: '018f2000-0000-7000-8000-000000000077' });
      expect((await post(app, url, wrong, cookie)).statusCode).toBe(409);
      business.shifts[0] = { ...business.shifts[0]!, status: 'closed' };
      expect(
        (await post(app, url, url.endsWith('close') ? closePayload() : movementPayload(), cookie))
          .statusCode,
      ).toBe(409);
    },
  );

  it.each(['/v1/shifts/close', '/v1/shifts/cash-movements'])(
    'rejects client authority on %s',
    async (url) => {
      app = await build('manager');
      const payload = url.endsWith('close')
        ? closePayload({ expectedCashMinor: '1' })
        : movementPayload({ expectedCashMinor: '1' });
      const response = await post(app, url, payload, await cookieFor(app));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'forbidden_field', field: 'expectedCashMinor' });
    },
  );

  it.each(['/v1/shifts/close', '/v1/shifts/cash-movements'])(
    'replays identical intent and conflicts on changed intent for %s',
    async (url) => {
      app = await build('manager');
      const cookie = await cookieFor(app);
      const payload = url.endsWith('close') ? closePayload() : movementPayload();
      expect((await post(app, url, payload, cookie)).statusCode).toBeLessThan(300);
      expect((await post(app, url, payload, cookie)).statusCode).toBeLessThan(300);
      const changed = url.endsWith('close')
        ? closePayload({ declaredCashMinor: '10001' })
        : movementPayload({ amountMinor: '101' });
      expect((await post(app, url, changed, cookie)).json().error).toBe('idempotency-conflict');
    },
  );
});
