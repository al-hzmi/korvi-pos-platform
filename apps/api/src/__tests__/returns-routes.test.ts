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
import type { Fixture } from './support/memory-business.js';
import type { RoleName } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

/**
 * The return surface, over a real Fastify instance.
 *
 * What is being defended here is not arithmetic — the domain suite does that —
 * but authority. Every one of these asks the same question from a different
 * angle: can the browser decide something it has no standing to decide? The
 * branch, the drawer, the operator, the price, the VAT and the refund total
 * are all server facts, and a request that names one is refused rather than
 * quietly ignored.
 */

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-real-password-9!';

const A: Fixture = {
  tenant: '018f3000-0000-7000-8000-00000000000a',
  branch: '018f3000-0000-7000-8000-0000000000a1',
  terminal: '018f3000-0000-7000-8000-0000000000a2',
  shift: '018f3000-0000-7000-8000-0000000000a3',
  user: '018f3000-0000-7000-8000-0000000000a4',
  milk: '018f3000-0000-7000-8000-0000000000a5',
  rice: '018f3000-0000-7000-8000-0000000000a6',
};

/** A till in the same tenant but another branch. Never this session's. */
const FOREIGN_TERMINAL = '018f3000-0000-7000-8000-0000000000b2';
const FOREIGN_BRANCH = '018f3000-0000-7000-8000-0000000000b1';

let app: FastifyInstance;
let business: MemoryBusinessStore;
let auth: MemoryAuthStore;
let ids = 0;

function nextId(): string {
  ids += 1;
  return `018f3000-0000-7000-8000-${String(ids).padStart(12, '0')}`;
}

async function build(
  role: RoleName,
  options: { openShift?: boolean; branch?: string | null } = {},
) {
  const { openShift = true, branch = A.branch } = options;
  ids = 0;
  business = new MemoryBusinessStore();
  seedStore(business, A, openShift);

  // A second till, in a branch this session is not pinned to.
  business.terminals.push({
    id: FOREIGN_TERMINAL,
    tenantId: business.terminals[0]?.tenantId ?? business.tenants[0]!.id,
    branchId: FOREIGN_BRANCH,
    code: '09',
    label: 'صندوق فرع آخر',
    isActive: true,
    lastSeenAt: null,
  });

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
    defaultBranchId: branch,
  });
  auth.grants.push({
    tenantId: A.tenant,
    userId: A.user,
    roles: [role],
    permissions: [...ROLE_PERMISSIONS[role]],
  });

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
      terminals: memoryTerminalRepository(business),
      checkout: createCheckoutService({
        tenants: memoryTenantRepository(business),
        products: memoryProductRepository(business),
        inventory: memoryInventoryRepository(business),
        shifts: memoryShiftRepository(business),
        sales: memorySaleRepository(business),
        idempotency: memoryIdempotencyRepository(business),
        audit: memoryAuditRepository(business),
        newId: nextId,
      }),
      returns: createReturnService({
        returns: memoryReturnRepository(business),
        terminals: memoryTerminalRepository(business),
        shifts: memoryShiftRepository(business),
        idempotency: memoryIdempotencyRepository(business),
        audit: memoryAuditRepository(business),
        newId: nextId,
      }),
      drawer: createDrawerService({
        shifts: memoryShiftRepository(business),
        terminals: memoryTerminalRepository(business),
        idempotency: memoryIdempotencyRepository(business),
        audit: memoryAuditRepository(business),
        newId: nextId,
      }),
    },
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

interface SoldSale {
  readonly saleId: string;
  readonly lineId: string;
  readonly totalMinor: string;
}

/** Ring up three cartons of milk, so there is something to send back. */
async function sell(cookie: string, quantityScaled = '3000'): Promise<SoldSale> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sales',
    headers: { cookie, origin: ORIGIN },
    payload: {
      operationId: nextId(),
      terminalId: A.terminal,
      cashReceivedMinor: '10000',
      lines: [{ productId: A.milk, quantityScaled }],
    },
  });
  expect(response.statusCode).toBe(201);
  const body = JSON.parse(response.payload) as {
    sale: { saleId: string; totalMinor: string };
  };
  const stored = business.sales.find((sale) => sale.id === body.sale.saleId);
  expect(stored).toBeDefined();
  return {
    saleId: body.sale.saleId,
    lineId: stored!.lines[0]!.id,
    totalMinor: body.sale.totalMinor,
  };
}

function returnPayload(sale: SoldSale, overrides: Record<string, unknown> = {}) {
  return {
    operationId: nextId(),
    terminalId: A.terminal,
    saleId: sale.saleId,
    refund: { kind: 'cash' },
    lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
    ...overrides,
  };
}

afterEach(async () => {
  await app.close();
});

describe('who may return anything', () => {
  it('refuses an anonymous request', async () => {
    await build('manager');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { origin: ORIGIN },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a cashier, who does not hold sale.refund', async () => {
    await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(ROLE_PERMISSIONS.cashier).not.toContain('sale.refund');
  });

  it('refuses a manager with no branch to act in', async () => {
    await build('manager', { branch: null });
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sales/lookup?q=1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error).toBe('branch_required');
  });
});

describe('a return the server accepts', () => {
  it('refunds one of three, from the sale and not the catalogue', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    // The price triples after the sale. Nothing about the refund may change.
    const index = business.products.findIndex((row) => row.id === A.milk);
    business.products[index] = { ...business.products[index]!, priceMinor: '3450' };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload) as {
      return: {
        returnNumber: string;
        totalMinor: string;
        netMinor: string;
        vatMinor: string;
        refund: { kind: string; amountMinor: string; reference: string | null };
        lines: { quantityScaled: string; totalMinor: string }[];
      };
      replayed: boolean;
    };

    expect(body.replayed).toBe(false);
    expect(body.return.returnNumber).toBe('R-01-000001');
    // One carton of 1150 including 15% VAT: a third of a 3450 line.
    expect(body.return.totalMinor).toBe('1150');
    expect(BigInt(body.return.netMinor) + BigInt(body.return.vatMinor)).toBe(1150n);
    expect(body.return.refund.kind).toBe('cash');
    expect(body.return.refund.amountMinor).toBe('1150');
    expect(body.return.refund.reference).toBeNull();
    expect(body.return.lines).toHaveLength(1);
  });

  it('takes the cash out of the open drawer, once', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    const refunds = business.cashMovements.filter((row) => row.kind === 'refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountMinor).toBe('-1150');
    expect(refunds[0]!.shiftId).toBe(A.shift);
  });

  it('puts the stock back, once, because the sale took it out', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    const reversals = business.movements.filter((row) => row.sourceType === 'return');
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.quantityScaled).toBe('1000');
    expect(reversals[0]!.kind).toBe('return');
  });

  it('records an electronic refund against its external approval, and moves no cash', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        refund: { kind: 'electronic', scheme: 'mada', reference: 'AUTH-77120' },
      }),
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload) as {
      return: { refund: { kind: string; scheme: string; reference: string } };
    };
    expect(body.return.refund.kind).toBe('electronic');
    expect(body.return.refund.scheme).toBe('mada');
    expect(body.return.refund.reference).toBe('AUTH-77120');
    expect(business.cashMovements.filter((row) => row.kind === 'refund')).toHaveLength(0);
  });

  it('answers a replay with the same document and creates nothing', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);
    const payload = returnPayload(sale);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.payload).replayed).toBe(true);
    expect(JSON.parse(second.payload).return.returnId).toBe(
      JSON.parse(first.payload).return.returnId,
    );
    expect(business.returns).toHaveLength(1);
  });

  it('refuses the same operation id carrying different intent', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);
    const payload = returnPayload(sale);

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload,
    });
    const conflicting = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: { ...payload, lines: [{ saleLineId: sale.lineId, quantityScaled: '2000' }] },
    });

    expect(conflicting.statusCode).toBe(409);
    expect(JSON.parse(conflicting.payload).error).toBe('idempotency-conflict');
    expect(business.returns).toHaveLength(1);
  });
});

describe('what the browser may not decide', () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ['a refund total', { refundTotalMinor: '9999' }],
    ['a price', { unitPriceMinor: '1' }],
    ['a VAT figure', { vatMinor: '0' }],
    ['a branch', { branchId: '018f3000-0000-7000-8000-0000000000b1' }],
    ['a shift', { shiftId: '018f3000-0000-7000-8000-0000000000a3' }],
    ['a cashier', { userId: '018f3000-0000-7000-8000-0000000000a4' }],
    ['a return number', { returnNumber: 'R-01-000009' }],
  ];

  for (const [what, extra] of cases) {
    it(`refuses ${what} by name`, async () => {
      await build('manager');
      const cookie = await cookieFor(app);
      const sale = await sell(cookie);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/returns',
        headers: { cookie, origin: ORIGIN },
        payload: returnPayload(sale, extra),
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).error).toBe('forbidden_field');
      expect(business.returns).toHaveLength(0);
    });
  }

  it('refuses a card number hiding in the refund reference', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        refund: { kind: 'electronic', scheme: 'visa', reference: '4111111111111111' },
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toBe('card_data_refused');
    // The refusal does not echo the number back into a log or a response body.
    expect(response.payload).not.toContain('4111');
  });
});

describe('which sale, and whose till', () => {
  it('says nothing about a till in another branch', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, { terminalId: FOREIGN_TERMINAL }),
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload).error).toBe('unknown-terminal');
    expect(response.payload).not.toContain(FOREIGN_BRANCH);
  });

  it('says nothing about a sale that is not this branch’s', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);
    // Move the sale to another branch behind the service's back.
    business.sales[0] = { ...business.sales[0]!, branchId: FOREIGN_BRANCH };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload).error).toBe('sale-not-found');
    expect(response.payload).not.toContain(FOREIGN_BRANCH);
  });

  it('refuses a drawer that belongs to another cashier', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);
    business.shifts[0] = {
      ...business.shifts[0]!,
      userId: '018f3000-0000-7000-8000-0000000000c9',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error).toBe('shift-invalid');
  });

  it('refuses when no shift is open on the till', async () => {
    await build('manager', { openShift: true });
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);
    business.shifts[0] = { ...business.shifts[0]!, status: 'closed' };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error).toBe('no-open-shift');
  });
});

describe('finding the sale and seeing what is left', () => {
  it('finds a sale by its invoice number, bounded', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    await sell(cookie);
    const invoiceNumber = business.invoices[0]!.invoiceNumber;

    const response = await app.inject({
      method: 'GET',
      url: `/v1/sales/lookup?q=${encodeURIComponent(invoiceNumber)}&limit=5`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as {
      sales: { saleId: string; totalMinor: string; fullyReturned: boolean }[];
      limit: number;
    };
    expect(body.limit).toBe(5);
    expect(body.sales).toHaveLength(1);
    expect(body.sales[0]!.fullyReturned).toBe(false);
  });

  it('refuses an unbounded lookup', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sales/lookup?q=1&limit=5000',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('reports what is left after a partial return, per line', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/sales/${sale.saleId}/returnable`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as {
      sale: {
        refundedTotalMinor: string;
        lines: {
          soldQuantityScaled: string;
          returnedQuantityScaled: string;
          remainingQuantityScaled: string;
        }[];
      };
    };
    expect(body.sale.refundedTotalMinor).toBe('1150');
    expect(body.sale.lines[0]!.soldQuantityScaled).toBe('3000');
    expect(body.sale.lines[0]!.returnedQuantityScaled).toBe('1000');
    expect(body.sale.lines[0]!.remainingQuantityScaled).toBe('2000');
  });

  it('tells the truth about a sale with nothing left rather than hiding it', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie, '1000');

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/sales/${sale.saleId}/returnable`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as {
      sale: { lines: { remainingQuantityScaled: string }[] };
    };
    expect(body.sale.lines[0]!.remainingQuantityScaled).toBe('0');
  });

  it('refuses a second return of goods that already came back', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie, '1000');

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.payload).error).toBe('nothing-returnable');
    expect(business.returns).toHaveLength(1);
  });

  it('refuses more than the sale has left', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie, '1000');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        lines: [{ saleLineId: sale.lineId, quantityScaled: '2000' }],
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error).toBe('over-return');
    expect(business.returns).toHaveLength(0);
  });

  it('refuses a line that belongs to another sale', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        lines: [{ saleLineId: '018f3000-0000-7000-8000-0000000000f9', quantityScaled: '1000' }],
      }),
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.payload).error).toBe('unknown-sale-line');
  });

  it('refuses a third of a carton of milk', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        lines: [{ saleLineId: sale.lineId, quantityScaled: '333' }],
      }),
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.payload).error).toBe('invalid-return-quantity');
  });

  it('refuses the same line twice in one request, before anything is written', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        lines: [
          { saleLineId: sale.lineId, quantityScaled: '1000' },
          { saleLineId: sale.lineId, quantityScaled: '1000' },
        ],
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(business.returns).toHaveLength(0);
  });
});

describe('the audit trail', () => {
  it('records the return with safe facts and no reference', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        refund: { kind: 'electronic', scheme: 'mada', reference: 'AUTH-55501' },
      }),
    });

    const event = business.audit.find((row) => row.eventType === 'sale.returned');
    expect(event).toBeDefined();
    expect(event!.entityType).toBe('return');
    expect(event!.metadata?.refundKind).toBe('electronic');
    expect(event!.metadata?.refundScheme).toBe('mada');
    expect(JSON.stringify(event!.metadata)).not.toContain('AUTH-55501');
  });
});
