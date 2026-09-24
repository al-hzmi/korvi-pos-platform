import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, basisPoints, tenantId } from '@korvi/domain';
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
  NoReceiptExchangeInput,
  NoReceiptExchangeResult,
} from '../no-receipt-exchange/service.js';
import type { Fixture } from './support/memory-business.js';
import type { RoleName } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-real-password-9!';

const A: Fixture = {
  tenant: '018f7200-0000-7000-8000-00000000000a',
  branch: '018f7200-0000-7000-8000-0000000000a1',
  terminal: '018f7200-0000-7000-8000-0000000000a2',
  shift: '018f7200-0000-7000-8000-0000000000a3',
  user: '018f7200-0000-7000-8000-0000000000a4',
  milk: '018f7200-0000-7000-8000-0000000000a5',
  rice: '018f7200-0000-7000-8000-0000000000a6',
};

let app: FastifyInstance;
let calls: NoReceiptExchangeInput[] = [];
let ids = 0;

function nextId(): string {
  ids += 1;
  return '018f7200-0000-7000-8000-' + String(ids).padStart(12, '0');
}

async function build(
  role: RoleName,
  exchangeResult: NoReceiptExchangeResult = { outcome: 'failure', reason: 'idempotency-conflict' },
): Promise<FastifyInstance> {
  ids = 0;
  calls = [];
  const business = new MemoryBusinessStore();
  seedStore(business, A, true);

  const auth = new MemoryAuthStore();
  auth.tenants.push({ id: A.tenant, slug: 'korvi-a', name: 'Korvi A', status: 'active' });
  auth.users.push({
    id: A.user,
    tenantId: A.tenant,
    email: 'manager@korvi-a.test',
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
      noReceiptExchanges: {
        async create(input) {
          calls.push(input);
          return exchangeResult;
        },
      },
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
    payload: {
      tenantSlug: 'korvi-a',
      email: 'manager@korvi-a.test',
      password: PASSWORD,
    },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return header.split(';')[0] ?? '';
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    operationId: '018f7200-0000-7000-8000-0000000000f1',
    terminalId: A.terminal,
    expectedShiftId: A.shift,
    reason: 'customer-no-receipt',
    approvedAllowanceMinor: '1000',
    acceptedLines: [{ productId: A.milk, quantityScaled: '1000' }],
    replacementLines: [{ productId: A.rice, quantityScaled: '1000' }],
    tenders: [{ kind: 'cash', amountMinor: '2000' }],
    ...overrides,
  };
}

afterEach(async () => {
  await app?.close();
});

describe('V2-1 no-receipt exchange route authority', () => {
  it('requires authentication', async () => {
    await build('manager');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/no-receipt-exchanges',
      headers: { origin: ORIGIN },
      payload: validPayload(),
    });
    expect(response.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('refuses a cashier before the service can see the request', async () => {
    const server = await build('cashier');
    const cookie = await cookieFor(server);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/no-receipt-exchanges',
      headers: { cookie, origin: ORIGIN },
      payload: validPayload(),
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses client-authored financial authority fields', async () => {
    const server = await build('manager');
    const cookie = await cookieFor(server);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/no-receipt-exchanges',
      headers: { cookie, origin: ORIGIN },
      payload: validPayload({ referenceCeilingMinor: '999999' }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'forbidden_field',
      field: 'referenceCeilingMinor',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses a client-supplied exchange_allowance tender', async () => {
    const server = await build('manager');
    const cookie = await cookieFor(server);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/no-receipt-exchanges',
      headers: { cookie, origin: ORIGIN },
      payload: validPayload({
        tenders: [{ kind: 'exchange_allowance', amountMinor: '1000' }],
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_body' });
    expect(calls).toHaveLength(0);
  });

  it('refuses nested price or VAT assertions through strict line schemas', async () => {
    const server = await build('manager');
    const cookie = await cookieFor(server);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/no-receipt-exchanges',
      headers: { cookie, origin: ORIGIN },
      payload: validPayload({
        acceptedLines: [
          {
            productId: A.milk,
            quantityScaled: '1000',
            unitPriceMinor: '1',
            vatBasisPoints: 0,
          },
        ],
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_body' });
    expect(calls).toHaveLength(0);
  });

  it('passes only validated intent to the manager-authorized service', async () => {
    const server = await build('manager');
    const cookie = await cookieFor(server);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/no-receipt-exchanges',
      headers: { cookie, origin: ORIGIN },
      payload: validPayload(),
    });
    expect(response.statusCode).toBe(409);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operationId: '018f7200-0000-7000-8000-0000000000f1',
      terminalId: A.terminal,
      expectedShiftId: A.shift,
      reason: 'customer-no-receipt',
      approvedAllowanceMinor: '1000',
    });
    expect(calls[0]).not.toHaveProperty('branchId');
    expect(calls[0]).not.toHaveProperty('referenceCeilingMinor');
  });

  it('serializes the successful domain case as a JSON-safe cashier DTO', async () => {
    const server = await build('manager', {
      outcome: 'success',
      replayed: false,
      case: {
        id: '018f7200-0000-7000-8000-0000000000d1',
        tenantId: tenantId(A.tenant),
        branchId: A.branch,
        terminalId: A.terminal,
        shiftId: A.shift,
        actorUserId: A.user,
        operationId: '018f7200-0000-7000-8000-0000000000f1',
        requestHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        status: 'finalized',
        sequence: 1,
        caseNumber: 'NR-01-000001',
        reason: 'customer-no-receipt',
        evidenceNote: null,
        currency: 'SAR',
        referenceCeilingMinor: '1000',
        approvedAllowanceMinor: '1000',
        linkedSaleId: '018f7200-0000-7000-8000-0000000000d2',
        issuedAt: '2026-09-24T22:00:00.000Z',
        lines: [
          {
            id: '018f7200-0000-7000-8000-0000000000d3',
            lineNumber: 1,
            productId: A.milk,
            sku: 'MILK',
            nameAr: 'حليب',
            nameEn: null,
            productType: 'unit',
            quantityScaled: '1000',
            currentUnitReferencePriceMinor: '1000',
            currentVatBasisPoints: basisPoints(1500),
            currentReferenceTotalMinor: '1000',
            trackInventory: true,
            stockDisposition: 'sellable',
            costProvenance: 'unknown',
          },
        ],
      },
      sale: {
        saleId: '018f7200-0000-7000-8000-0000000000d2',
        operationId: '018f7200-0000-7000-8000-0000000000f1:replacement',
        orderType: null,
        tableId: null,
        restaurantOrderId: null,
        sequence: 1,
        invoiceNumber: 'INV-01-000001',
        issuedAt: '2026-09-24T22:00:00.000Z',
        currency: 'SAR',
        branchId: A.branch,
        terminalId: A.terminal,
        shiftId: A.shift,
        cashierName: 'مدير',
        lines: [],
        netMinor: '870',
        vatMinor: '130',
        totalMinor: '1000',
        tenderedMinor: '1000',
        cashReceivedMinor: '0',
        changeMinor: '0',
        tenders: [
          {
            kind: 'exchange_allowance',
            scheme: null,
            amountMinor: '1000',
            changeMinor: '0',
            reference: null,
          },
        ],
      },
      receipt: null,
    });
    const cookie = await cookieFor(server);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/no-receipt-exchanges',
      headers: { cookie, origin: ORIGIN },
      payload: validPayload(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.exchange.lines[0].currentVatBasisPoints).toBe(1500);
    expect(body.exchange).not.toHaveProperty('tenantId');
    expect(body.exchange).not.toHaveProperty('requestHash');
  });
});
