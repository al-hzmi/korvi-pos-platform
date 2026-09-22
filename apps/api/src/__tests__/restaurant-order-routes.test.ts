import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { MerchantRestaurantOrderService } from '../restaurant/order-service.js';
import type { AuthService } from '../auth/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { RestaurantOrderDetail, RestaurantOrderRefusal } from '@korvi/database';
import type { FastifyInstance } from 'fastify';

const TENANT = '018fb500-0000-7000-8000-00000000000a';
const BRANCH = '018fb500-0000-7000-8000-0000000000a1';
const TERMINAL = '018fb500-0000-7000-8000-0000000000a2';
const USER = '018fb500-0000-7000-8000-0000000000a3';
const ORDER = '018fb500-0000-7000-8000-0000000000b1';
const OTHER_ORDER = '018fb500-0000-7000-8000-0000000000b2';
const TABLE = '018fb500-0000-7000-8000-0000000000c1';
const PRODUCT = '018fb500-0000-7000-8000-0000000000d1';
const CREATE_OP = '018fb500-0000-7000-8000-0000000000e1';
const REPLAY_OP = '018fb500-0000-7000-8000-0000000000e2';
const CANCEL_OP = '018fb500-0000-7000-8000-0000000000e3';
const TRANSFER_OP = '018fb500-0000-7000-8000-0000000000e4';
const TABLE_TWO = '018fb500-0000-7000-8000-0000000000c2';
const REPLACE_LINES_OP = '018fb500-0000-7000-8000-0000000000e5';
const ORDER_LINE = '018fb500-0000-7000-8000-0000000000f1';
const ORIGIN = 'http://localhost:3000';
const COOKIE = 'korvi_session=restaurant-test-token';

let app: FastifyInstance | null = null;
let calls: { method: string; value: unknown }[] = [];
let nextFailure: RestaurantOrderRefusal | null = null;

const order: RestaurantOrderDetail = {
  id: ORDER,
  branchId: BRANCH,
  terminalId: TERMINAL,
  userId: USER,
  tableId: TABLE,
  tableCode: 'T01',
  tableNameAr: 'طاولة 1',
  orderType: 'dine-in',
  status: 'open',
  revision: '1',
  priceMode: 'tax-inclusive',
  currency: 'SAR',
  openedAt: '2026-09-19T05:00:00.000Z',
  closedAt: null,
  closedReason: null,
  lineCount: 1,
  lines: [
    {
      id: ORDER_LINE,
      lineNumber: 1,
      productId: PRODUCT,
      sku: 'COF-1',
      nameAr: 'قهوة',
      nameEn: 'Coffee',
      productType: 'unit',
      unitPriceMinor: '1150',
      vatBasisPoints: 1500,
      quantityScaled: '1000',
      preparationNote: null,
      preparationOptions: null,
      trackInventory: true,
    },
  ],
};

function principal(permissions: AuthenticatedPrincipal['permissions']): AuthenticatedPrincipal {
  return {
    tenantId: TENANT,
    tenantSlug: 'restaurant-a',
    userId: USER,
    sessionId: '018fb500-0000-7000-8000-0000000000aa',
    email: 'cashier@restaurant.test',
    displayName: 'الكاشير',
    roles: ['cashier'],
    permissions,
    maxDiscountBasisPoints: 0n,
    branchId: BRANCH,
  };
}

function authFor(subject: AuthenticatedPrincipal | null): AuthService {
  return {
    async login() {
      return { outcome: 'failure', reason: 'bad-password' };
    },
    async authenticate(rawToken) {
      if (rawToken !== 'restaurant-test-token' || subject === null) {
        return { outcome: 'failure', reason: 'malformed-token' };
      }
      return { outcome: 'success', principal: subject };
    },
    async logout() {
      return true;
    },
    async logoutAll() {
      return 1;
    },
  };
}

function restaurantService(): MerchantRestaurantOrderService {
  return {
    async listOpen(subject) {
      calls.push({ method: 'listOpen', value: subject.tenantId });
      return [order];
    },
    async detail(subject, orderId) {
      calls.push({ method: 'detail', value: { tenantId: subject.tenantId, orderId } });
      return orderId === OTHER_ORDER ? null : order;
    },
    async create(subject, request) {
      calls.push({
        method: 'create',
        value: { tenantId: subject.tenantId, userId: subject.userId, request },
      });
      if (nextFailure !== null) return { outcome: 'failure', reason: nextFailure };
      return {
        outcome: 'success',
        value: { order, replayed: request.operationId === REPLAY_OP },
      };
    },
    async cancel(subject, orderId, request) {
      calls.push({
        method: 'cancel',
        value: { tenantId: subject.tenantId, userId: subject.userId, orderId, request },
      });
      if (nextFailure !== null) return { outcome: 'failure', reason: nextFailure };
      return {
        outcome: 'success',
        value: {
          order: {
            ...order,
            status: 'cancelled',
            revision: '2',
            closedAt: '2026-09-19T05:10:00.000Z',
            closedReason: request.reason,
          },
          replayed: false,
        },
      };
    },
    async transferTable(subject, orderId, request) {
      calls.push({
        method: 'transferTable',
        value: { tenantId: subject.tenantId, userId: subject.userId, orderId, request },
      });
      if (nextFailure !== null) return { outcome: 'failure', reason: nextFailure };
      return {
        outcome: 'success',
        value: {
          order: { ...order, tableId: request.tableId, revision: '2' },
          replayed: false,
        },
      };
    },
    async replaceLines(subject, orderId, request) {
      calls.push({
        method: 'replaceLines',
        value: { tenantId: subject.tenantId, userId: subject.userId, orderId, request },
      });
      if (nextFailure !== null) return { outcome: 'failure', reason: nextFailure };
      return {
        outcome: 'success',
        value: {
          order: {
            ...order,
            revision: '2',
            lineCount: request.lines.length,
          },
          replayed: false,
        },
      };
    },
  };
}

function build(subject: AuthenticatedPrincipal | null): FastifyInstance {
  calls = [];
  nextFailure = null;
  app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: authFor(subject),
    restaurantOrders: restaurantService(),
  });
  return app;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('restaurant order route authority', () => {
  it('requires a session and sale.create for operational order reads and create', async () => {
    const unauthenticated = build(null);
    expect(
      (await unauthenticated.inject({ method: 'GET', url: '/v1/restaurant/orders' })).statusCode,
    ).toBe(401);
    expect(calls).toEqual([]);
    await unauthenticated.close();
    app = null;

    const readOnly = build(principal([]));
    const list = await readOnly.inject({
      method: 'GET',
      url: '/v1/restaurant/orders',
      headers: { cookie: COOKIE },
    });
    const create = await readOnly.inject({
      method: 'POST',
      url: '/v1/restaurant/orders',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: CREATE_OP,
        terminalId: TERMINAL,
        orderType: 'dine-in',
        tableId: TABLE,
        lines: [{ productId: PRODUCT, quantityScaled: '1000' }],
      },
    });
    expect(list.statusCode).toBe(403);
    expect(create.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('separates sale.create from sale.void when cancelling an open order', async () => {
    const server = build(principal(['sale.create']));
    const denied = await server.inject({
      method: 'POST',
      url: `/v1/restaurant/orders/${ORDER}/cancel`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: CANCEL_OP, expectedRevision: '1', reason: 'إلغاء العميل' },
    });
    expect(denied.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('rejects client-supplied authority fields before the service executes', async () => {
    const server = build(principal(['sale.create']));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/restaurant/orders',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: CREATE_OP,
        terminalId: TERMINAL,
        orderType: 'dine-in',
        tableId: TABLE,
        tenantId: TENANT,
        userId: USER,
        status: 'settled',
        revision: '99',
        lines: [{ productId: PRODUCT, quantityScaled: '1000' }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_body' });
    expect(calls).toEqual([]);
  });

  it('returns authoritative open orders and keeps quantities as strings', async () => {
    const server = build(principal(['sale.create']));
    const list = await server.inject({
      method: 'GET',
      url: '/v1/restaurant/orders',
      headers: { cookie: COOKIE },
    });
    const detail = await server.inject({
      method: 'GET',
      url: `/v1/restaurant/orders/${ORDER}`,
      headers: { cookie: COOKIE },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      orders: [{ id: ORDER, tableId: TABLE, revision: '1', lineCount: 1 }],
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('"quantityScaled":"1000"');
    expect(calls.map((call) => call.method)).toEqual(['listOpen', 'detail']);
  });

  it('distinguishes create from idempotent replay without changing the response contract', async () => {
    const server = build(principal(['sale.create']));
    const payload = {
      terminalId: TERMINAL,
      orderType: 'dine-in',
      tableId: TABLE,
      lines: [{ productId: PRODUCT, quantityScaled: '1000' }],
    };

    const created = await server.inject({
      method: 'POST',
      url: '/v1/restaurant/orders',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { ...payload, operationId: CREATE_OP },
    });
    const replayed = await server.inject({
      method: 'POST',
      url: '/v1/restaurant/orders',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { ...payload, operationId: REPLAY_OP },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ order: { id: ORDER }, replayed: false });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ order: { id: ORDER }, replayed: true });
  });

  it('replaces open-order lines under sale.create with an explicit revision precondition', async () => {
    const server = build(principal(['sale.create']));
    const response = await server.inject({
      method: 'PUT',
      url: `/v1/restaurant/orders/${ORDER}/lines`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: REPLACE_LINES_OP,
        expectedRevision: '1',
        lines: [
          { lineId: ORDER_LINE, quantityScaled: '2000', preparationNote: 'بدون سكر' },
          { productId: PRODUCT, quantityScaled: '1000' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      order: { id: ORDER, revision: '2', lineCount: 2 },
      replayed: false,
    });
    expect(calls).toEqual([
      {
        method: 'replaceLines',
        value: {
          tenantId: TENANT,
          userId: USER,
          orderId: ORDER,
          request: {
            operationId: REPLACE_LINES_OP,
            expectedRevision: '1',
            lines: [
              {
                lineId: ORDER_LINE,
                quantityScaled: '2000',
                preparationNote: 'بدون سكر',
                preparationOptions: null,
              },
              {
                productId: PRODUCT,
                quantityScaled: '1000',
                preparationNote: null,
                preparationOptions: null,
              },
            ],
          },
        },
      },
    ]);
  });

  it('transfers a dine-in table under sale.create with an explicit revision precondition', async () => {
    const server = build(principal(['sale.create']));
    const response = await server.inject({
      method: 'POST',
      url: `/v1/restaurant/orders/${ORDER}/transfer-table`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: TRANSFER_OP,
        expectedRevision: '1',
        tableId: TABLE_TWO,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      order: { id: ORDER, tableId: TABLE_TWO, revision: '2' },
      replayed: false,
    });
    expect(calls).toEqual([
      {
        method: 'transferTable',
        value: {
          tenantId: TENANT,
          userId: USER,
          orderId: ORDER,
          request: {
            operationId: TRANSFER_OP,
            expectedRevision: '1',
            tableId: TABLE_TWO,
          },
        },
      },
    ]);
  });

  it('passes cancel revision and normalized reason only under sale.void', async () => {
    const server = build(principal(['sale.void']));
    const response = await server.inject({
      method: 'POST',
      url: `/v1/restaurant/orders/${ORDER}/cancel`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: CANCEL_OP, expectedRevision: '1', reason: '  إلغاء العميل  ' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      order: { id: ORDER, status: 'cancelled', revision: '2', closedReason: 'إلغاء العميل' },
      replayed: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'cancel',
      value: {
        tenantId: TENANT,
        userId: USER,
        orderId: ORDER,
        request: { operationId: CANCEL_OP, expectedRevision: '1', reason: 'إلغاء العميل' },
      },
    });
  });

  it.each([
    ['table-occupied', 409, 'table_occupied'],
    ['table-not-applicable', 422, 'table_not_applicable'],
    ['unknown-line', 404, 'restaurant_order_line_not_found'],
    ['duplicate-line', 422, 'duplicate_restaurant_order_line'],
    ['preparation-started', 409, 'restaurant_order_preparation_started'],
    ['stale-revision', 409, 'restaurant_order_stale'],
    ['idempotency-conflict', 409, 'idempotency_conflict'],
    ['unknown-order', 404, 'restaurant_order_not_found'],
  ] as const)('maps %s to a stable HTTP refusal', async (reason, status, error) => {
    const server = build(principal(['sale.create']));
    nextFailure = reason;
    const response = await server.inject({
      method: 'POST',
      url: '/v1/restaurant/orders',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: CREATE_OP,
        terminalId: TERMINAL,
        orderType: 'dine-in',
        tableId: TABLE,
        lines: [{ productId: PRODUCT, quantityScaled: '1000' }],
      },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error });
  });

  it('does not reveal an order outside the authenticated branch set', async () => {
    const server = build(principal(['sale.create']));
    const response = await server.inject({
      method: 'GET',
      url: `/v1/restaurant/orders/${OTHER_ORDER}`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'restaurant_order_not_found' });
  });
});
