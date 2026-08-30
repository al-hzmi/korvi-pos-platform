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
  MerchantPurchasingService,
  PurchasingFailureReason,
  PurchasingResult,
} from '../purchasing/service.js';
import type { Fixture } from './support/memory-business.js';
import type { PurchaseOrderRequest, PurchaseReceiptRequest } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

/**
 * The purchasing authority as a door, over a real Fastify instance.
 *
 * What is proved here is the shape of the surface: which permission each route
 * demands, that no authority field can be threaded through it, that identity
 * is canonicalized before the service sees it, and that a refusal decided
 * under a row lock arrives as a stable status. Whether receiving is actually
 * atomic — and whether two clerks can over-receive — is a claim about
 * PostgreSQL and is proved in `purchasing-receiving-live.test.ts`.
 */

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-real-password-9!';

const A: Fixture = {
  tenant: '018fb100-0000-7000-8000-00000000000a',
  branch: '018fb100-0000-7000-8000-0000000000a1',
  terminal: '018fb100-0000-7000-8000-0000000000a2',
  shift: '018fb100-0000-7000-8000-0000000000a3',
  user: '018fb100-0000-7000-8000-0000000000a4',
  milk: '018fb100-0000-7000-8000-0000000000a5',
  rice: '018fb100-0000-7000-8000-0000000000a6',
};

const SUPPLIER = '018fb100-0000-7000-8000-0000000000c1';
const ORDER = '018fb100-0000-7000-8000-0000000000c2';
const ORDER_LINE = '018fb100-0000-7000-8000-0000000000c3';
const RECEIPT = '018fb100-0000-7000-8000-0000000000c4';
const RECEIPT_LINE = '018fb100-0000-7000-8000-0000000000c5';

const SUPPLIER_BODY = { operationId: 'op-supplier-1', name: 'مؤسسة الرياض' };

const ORDER_BODY = {
  operationId: 'op-order-1',
  supplierId: SUPPLIER,
  branchId: A.branch,
  lines: [{ productId: A.milk, orderedQuantityScaled: '100000' }],
};

const RECEIPT_BODY = {
  operationId: 'op-receipt-1',
  purchaseOrderId: ORDER,
  lines: [{ purchaseOrderLineId: ORDER_LINE, acceptedQuantityScaled: '30000' }],
};

let app: FastifyInstance;
let seen: { method: string; request: unknown }[];
let nextFailure: { reason: PurchasingFailureReason; subjectId: string | null } | null;
let supplierExists: boolean;
let orderExists: boolean;

function recordingPurchasing(): MerchantPurchasingService {
  function answer<T>(value: T): PurchasingResult<T> {
    if (nextFailure !== null) {
      return {
        outcome: 'failure',
        reason: nextFailure.reason,
        subjectId: nextFailure.subjectId,
      };
    }
    return { outcome: 'success', value };
  }

  const supplier = {
    id: SUPPLIER,
    name: 'مؤسسة الرياض',
    isActive: true,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  };

  const order = {
    id: ORDER,
    supplierId: SUPPLIER,
    branchId: A.branch,
    reference: null,
    status: 'open' as const,
    orderedAt: '2026-08-28T00:00:00.000Z',
    lines: [
      {
        id: ORDER_LINE,
        productId: A.milk,
        // Beyond 2^53 on purpose: a Number would round it on the way out.
        orderedQuantityScaled: '9007199254740993000',
        receivedQuantityScaled: '0',
        remainingQuantityScaled: '9007199254740993000',
      },
    ],
  };

  return {
    async listSuppliers(_principal, query) {
      seen.push({ method: 'listSuppliers', request: query });
      return { rows: [supplier], nextCursor: null };
    },
    async getSupplier(_principal, supplierId) {
      seen.push({ method: 'getSupplier', request: supplierId });
      return supplierExists ? supplier : null;
    },
    async createSupplier(_principal, request) {
      seen.push({ method: 'createSupplier', request });
      return answer({ supplier, replayed: false });
    },
    async updateSupplier(_principal, request) {
      seen.push({ method: 'updateSupplier', request });
      return answer({ supplier, replayed: false });
    },
    async listPurchaseOrders(_principal, query) {
      seen.push({ method: 'listPurchaseOrders', request: query });
      return {
        rows: [
          {
            id: ORDER,
            supplierId: SUPPLIER,
            branchId: A.branch,
            reference: null,
            status: 'open',
            orderedAt: order.orderedAt,
            lineCount: 1,
          },
        ],
        nextCursor: null,
      };
    },
    async getPurchaseOrder(_principal, purchaseOrderId) {
      seen.push({ method: 'getPurchaseOrder', request: purchaseOrderId });
      return orderExists ? order : null;
    },
    async createPurchaseOrder(_principal, request: PurchaseOrderRequest) {
      seen.push({ method: 'createPurchaseOrder', request });
      return answer({ order, replayed: false });
    },
    async listReceipts(_principal, purchaseOrderId, limit) {
      seen.push({ method: 'listReceipts', request: { purchaseOrderId, limit } });
      return [];
    },
    async receive(_principal, request: PurchaseReceiptRequest) {
      seen.push({ method: 'receive', request });
      return answer({
        id: RECEIPT,
        purchaseOrderId: request.purchaseOrderId,
        branchId: A.branch,
        supplierId: SUPPLIER,
        reference: request.reference,
        purchaseOrderStatus: 'partially_received' as const,
        receivedAt: '2026-08-28T00:00:00.000Z',
        replayed: false,
        lines: [
          {
            id: RECEIPT_LINE,
            purchaseOrderLineId: ORDER_LINE,
            productId: A.milk,
            acceptedQuantityScaled: '30000',
            orderedQuantityScaled: '9007199254740993000',
            beforeReceivedQuantityScaled: '0',
            afterReceivedQuantityScaled: '30000',
            beforeQuantityScaled: '0',
            afterQuantityScaled: '30000',
            resultRevision: '1',
          },
        ],
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
    email: 'nora@korvi-a.test',
    displayName: 'نورة',
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
  supplierExists = true;
  orderExists = true;

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
    purchasing: recordingPurchasing(),
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
    payload: { tenantSlug: 'korvi-a', email: 'nora@korvi-a.test', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return header.split(';')[0] ?? '';
}

const send = (
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string | null,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...(cookie === null ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

const get = (url: string, cookie: string | null) =>
  app.inject({
    method: 'GET',
    url,
    headers: { origin: ORIGIN, ...(cookie === null ? {} : { cookie }) },
  });

const READS = [
  '/v1/admin/purchasing/suppliers',
  `/v1/admin/purchasing/suppliers/${SUPPLIER}`,
  '/v1/admin/purchasing/orders',
  `/v1/admin/purchasing/orders/${ORDER}`,
  `/v1/admin/purchasing/orders/${ORDER}/receipts`,
];

afterEach(async () => {
  await app.close();
});

describe('the purchasing authority requires a session and the exact permission', () => {
  it('refuses every route without a session', async () => {
    await build(ROLE_PERMISSIONS.owner);
    for (const url of READS) {
      expect((await get(url, null)).statusCode, url).toBe(401);
    }
    expect(
      (await send('POST', '/v1/admin/purchasing/suppliers', null, SUPPLIER_BODY)).statusCode,
    ).toBe(401);
    expect(
      (
        await send('PATCH', `/v1/admin/purchasing/suppliers/${SUPPLIER}`, null, {
          operationId: 'op',
          name: 'x',
        })
      ).statusCode,
    ).toBe(401);
    expect((await send('POST', '/v1/admin/purchasing/orders', null, ORDER_BODY)).statusCode).toBe(
      401,
    );
    expect(
      (await send('POST', '/v1/admin/purchasing/receipts', null, RECEIPT_BODY)).statusCode,
    ).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('demands purchasing.read for every read', async () => {
    const server = await build(['sale.create']);
    const cookie = await cookieFor(server);
    for (const url of READS) {
      expect((await get(url, cookie)).statusCode, url).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it('demands purchasing.manage to create or update a supplier or an order', async () => {
    const server = await build(['purchasing.read']);
    const cookie = await cookieFor(server);
    expect(
      (await send('POST', '/v1/admin/purchasing/suppliers', cookie, SUPPLIER_BODY)).statusCode,
    ).toBe(403);
    expect(
      (
        await send('PATCH', `/v1/admin/purchasing/suppliers/${SUPPLIER}`, cookie, {
          operationId: 'op',
          isActive: false,
        })
      ).statusCode,
    ).toBe(403);
    expect((await send('POST', '/v1/admin/purchasing/orders', cookie, ORDER_BODY)).statusCode).toBe(
      403,
    );
    expect(seen).toHaveLength(0);
  });

  it('demands purchasing.receive to book a receipt, and manage is not enough', async () => {
    // The separation is the point: committing the shop to a purchase and
    // asserting that goods physically arrived are different acts, and only the
    // second moves stock.
    const server = await build(['purchasing.read', 'purchasing.manage']);
    const cookie = await cookieFor(server);
    expect(
      (await send('POST', '/v1/admin/purchasing/receipts', cookie, RECEIPT_BODY)).statusCode,
    ).toBe(403);
    expect(seen).toHaveLength(0);

    // And an order is still allowed with the same session, so the 403 above is
    // about the permission rather than about the session being broken.
    expect((await send('POST', '/v1/admin/purchasing/orders', cookie, ORDER_BODY)).statusCode).toBe(
      201,
    );
  });

  it('lets a holder of all three do all of it', async () => {
    const server = await build(['purchasing.read', 'purchasing.manage', 'purchasing.receive']);
    const cookie = await cookieFor(server);
    for (const url of READS) {
      expect((await get(url, cookie)).statusCode, url).toBe(200);
    }
    expect(
      (await send('POST', '/v1/admin/purchasing/suppliers', cookie, SUPPLIER_BODY)).statusCode,
    ).toBe(201);
    expect((await send('POST', '/v1/admin/purchasing/orders', cookie, ORDER_BODY)).statusCode).toBe(
      201,
    );
    expect(
      (await send('POST', '/v1/admin/purchasing/receipts', cookie, RECEIPT_BODY)).statusCode,
    ).toBe(201);
  });

  it('has no DELETE route on any purchasing resource', async () => {
    // Purchase orders and receipts are historical evidence. A mistake is
    // corrected by a compensating operation, never by removing the record.
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    for (const url of [
      `/v1/admin/purchasing/suppliers/${SUPPLIER}`,
      `/v1/admin/purchasing/orders/${ORDER}`,
      '/v1/admin/purchasing/receipts',
      `/v1/admin/purchasing/receipts/${RECEIPT}`,
    ]) {
      expect((await send('DELETE', url, cookie)).statusCode, url).toBe(404);
    }
  });
});

describe('authority the client does not get to assert', () => {
  const cases: readonly (readonly [string, string, Record<string, unknown>])[] = [
    ['/v1/admin/purchasing/suppliers', 'tenantId', { ...SUPPLIER_BODY, tenantId: A.tenant }],
    ['/v1/admin/purchasing/orders', 'actorUserId', { ...ORDER_BODY, actorUserId: A.user }],
    ['/v1/admin/purchasing/orders', 'status', { ...ORDER_BODY, status: 'received' }],
    [
      '/v1/admin/purchasing/orders',
      'receivedQuantityScaled',
      {
        ...ORDER_BODY,
        lines: [
          { productId: A.milk, orderedQuantityScaled: '1000', receivedQuantityScaled: '1000' },
        ],
      },
    ],
    [
      '/v1/admin/purchasing/receipts',
      'purchaseOrderStatus',
      { ...RECEIPT_BODY, purchaseOrderStatus: 'received' },
    ],
    ['/v1/admin/purchasing/receipts', 'branchId', { ...RECEIPT_BODY, branchId: A.branch }],
    ['/v1/admin/purchasing/receipts', 'supplierId', { ...RECEIPT_BODY, supplierId: SUPPLIER }],
    [
      '/v1/admin/purchasing/receipts',
      'productId',
      {
        ...RECEIPT_BODY,
        lines: [
          {
            purchaseOrderLineId: ORDER_LINE,
            acceptedQuantityScaled: '1000',
            productId: A.milk,
          },
        ],
      },
    ],
    ['/v1/admin/purchasing/receipts', 'resultRevision', { ...RECEIPT_BODY, resultRevision: '99' }],
    ['/v1/admin/purchasing/receipts', 'unitCostMinor', { ...RECEIPT_BODY, unitCostMinor: '500' }],
  ];

  it.each(cases)('refuses %s carrying %s by name', async (url, field, body) => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    const response = await send('POST', url, cookie, body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'forbidden_field', field });
    // Named rather than swallowed as a generic invalid body, and the authority
    // was never reached.
    expect(seen).toHaveLength(0);
  });

  it('lets a purchase order name its own supplier, branch and product', async () => {
    // The mirror of the receipt case above: on an order these three are
    // legitimate input, and refusing them there would be refusing the request.
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    expect((await send('POST', '/v1/admin/purchasing/orders', cookie, ORDER_BODY)).statusCode).toBe(
      201,
    );
    expect(seen).toHaveLength(1);
  });
});

describe('identity, quantities and refusals across the wire', () => {
  it('canonicalizes UUID casing before the authority sees it', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    await send('POST', '/v1/admin/purchasing/receipts', cookie, {
      ...RECEIPT_BODY,
      purchaseOrderId: ORDER.toUpperCase(),
      lines: [{ purchaseOrderLineId: ORDER_LINE.toUpperCase(), acceptedQuantityScaled: '1000' }],
    });
    const request = seen.at(0)?.request as PurchaseReceiptRequest;
    expect(request.purchaseOrderId).toBe(ORDER);
    expect(request.lines[0]?.purchaseOrderLineId).toBe(ORDER_LINE);
  });

  it('keeps quantities as strings past 2^53 in both directions', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    const response = await get(`/v1/admin/purchasing/orders/${ORDER}`, cookie);
    expect(response.statusCode).toBe(200);
    // Read out of the raw payload, because parsing it as JSON is exactly the
    // step that would round a number and hide the bug.
    expect(response.body).toContain('"orderedQuantityScaled":"9007199254740993000"');

    // Eighteen digits, which is the ceiling the scaled-integer schema allows
    // and still an order of magnitude past 2^53 — the point where a JSON
    // `number` starts losing whole units.
    const huge = '900719925474099300';
    expect(BigInt(huge)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    // The digit a `number` would silently lose, demonstrated rather than
    // asserted by assumption.
    expect(Number(huge)).toBe(Number(`${huge.slice(0, -1)}1`));
    const accepted = await send('POST', '/v1/admin/purchasing/orders', cookie, {
      ...ORDER_BODY,
      lines: [{ productId: A.milk, orderedQuantityScaled: huge }],
    });
    expect(accepted.statusCode).toBe(201);
    // The last call, because the read above is also recorded.
    const request = seen.at(-1)?.request as PurchaseOrderRequest;
    expect(request.lines[0]?.orderedQuantityScaled).toBe(huge);
  });

  it('refuses a numeric quantity, a float, and an unknown key', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    for (const lines of [
      [{ productId: A.milk, orderedQuantityScaled: 1000 }],
      [{ productId: A.milk, orderedQuantityScaled: '10.5' }],
      [{ productId: A.milk, orderedQuantityScaled: '1000', note: 'x' }],
    ]) {
      const response = await send('POST', '/v1/admin/purchasing/orders', cookie, {
        ...ORDER_BODY,
        lines,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_body' });
    }
    expect(seen).toHaveLength(0);
  });

  it('maps every typed refusal to a stable status and an Arabic message', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    const expected: readonly (readonly [PurchasingFailureReason, number])[] = [
      ['over-receipt', 409],
      ['purchase-order-closed', 409],
      ['unknown-purchase-order', 404],
      ['unknown-purchase-order-line', 404],
      ['inactive-branch', 409],
      ['untracked-product', 409],
      ['idempotency-conflict', 409],
      ['fractional-unit-quantity', 422],
    ];

    for (const [reason, status] of expected) {
      nextFailure = { reason, subjectId: ORDER_LINE };
      const response = await send('POST', '/v1/admin/purchasing/receipts', cookie, {
        ...RECEIPT_BODY,
        operationId: `op-${reason}`,
      });
      expect(response.statusCode, reason).toBe(status);
      const body = response.json<{ error: string; message: string; subjectId: string }>();
      expect(body.error, reason).toBe(reason.replace(/-/g, '_'));
      expect(body.subjectId, reason).toBe(ORDER_LINE);
      // Arabic, so a merchant reads a correction rather than an error code.
      expect(body.message, reason).toMatch(/[؀-ۿ]/);
    }
  });

  it('answers 404 for a supplier or order that is not in this tenant', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    supplierExists = false;
    orderExists = false;

    // Absent and another merchant's are the same answer, so the endpoint
    // cannot be used to probe for which ids exist.
    const supplier = await get(`/v1/admin/purchasing/suppliers/${SUPPLIER}`, cookie);
    expect(supplier.statusCode).toBe(404);
    expect(supplier.json<{ error: string }>().error).toBe('unknown_supplier');

    const order = await get(`/v1/admin/purchasing/orders/${ORDER}`, cookie);
    expect(order.statusCode).toBe(404);
    expect(order.json<{ error: string }>().error).toBe('unknown_purchase_order');

    // The receipt list answers 404 too, rather than an empty list that would
    // read as "this order exists and has had no deliveries".
    const receipts = await get(`/v1/admin/purchasing/orders/${ORDER}/receipts`, cookie);
    expect(receipts.statusCode).toBe(404);
  });

  it('bounds pagination and refuses a tenant id in the query', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    expect((await get('/v1/admin/purchasing/suppliers?limit=5000', cookie)).statusCode).toBe(400);
    expect((await get('/v1/admin/purchasing/orders?limit=0', cookie)).statusCode).toBe(400);

    const probe = await get(`/v1/admin/purchasing/suppliers?tenantId=${A.tenant}`, cookie);
    expect(probe.statusCode).toBe(400);
    expect(probe.json()).toEqual({ error: 'forbidden_field', field: 'tenantId' });
    expect(seen).toHaveLength(0);
  });

  it.each(['open', 'partially_received', 'received'] as const)(
    'accepts ?status=%s as a read filter and passes it through unchanged',
    async (status) => {
      // A status in a *mutation body* is an attempt to declare an order
      // finished. A status in a *query string* is a filter over rows the caller
      // may already read and asserts nothing — two different concepts that must
      // not share one forbidden list.
      const server = await build(ROLE_PERMISSIONS.owner);
      const cookie = await cookieFor(server);

      const response = await get(`/v1/admin/purchasing/orders?status=${status}`, cookie);
      expect(response.statusCode).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen.at(0)?.request).toEqual({
        limit: 50,
        cursor: null,
        status,
        supplierId: null,
        branchId: null,
      });
    },
  );

  it('still refuses a status outside the lifecycle, and for the right reason', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    const response = await get('/v1/admin/purchasing/orders?status=cancelled', cookie);
    expect(response.statusCode).toBe(400);
    // `invalid_query`, not `forbidden_field`: the value is outside the three
    // states the lifecycle defines, which is a schema failure rather than an
    // attempt to assert authority. Asserting the reason is what stops this
    // passing again if the filter is ever re-forbidden wholesale.
    expect(response.json()).toEqual({ error: 'invalid_query' });
    expect(seen).toHaveLength(0);
  });

  it('still refuses a tenant probe on the order list', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    const probe = await get(`/v1/admin/purchasing/orders?status=open&tenantId=${A.tenant}`, cookie);
    expect(probe.statusCode).toBe(400);
    expect(probe.json()).toEqual({ error: 'forbidden_field', field: 'tenantId' });
    expect(seen).toHaveLength(0);

    for (const field of ['actorUserId', 'userId', 'sessionId'] as const) {
      const attempt = await get(`/v1/admin/purchasing/orders?${field}=${A.user}`, cookie);
      expect(attempt.statusCode, field).toBe(400);
      expect(attempt.json(), field).toEqual({ error: 'forbidden_field', field });
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses a second supplier identity in a PATCH body by name', async () => {
    // The path owns the identity. Two sources of truth for which supplier is
    // being changed would leave the handler picking one.
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);

    const response = await send('PATCH', `/v1/admin/purchasing/suppliers/${SUPPLIER}`, cookie, {
      operationId: 'op-patch-2',
      name: 'اسم',
      supplierId: '018fb100-0000-7000-8000-0000000000ff',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'forbidden_field', field: 'supplierId' });
    expect(seen).toHaveLength(0);

    // And an order body may still name its supplier, so the refusal above is
    // scoped to the update rather than a blanket ban.
    expect((await send('POST', '/v1/admin/purchasing/orders', cookie, ORDER_BODY)).statusCode).toBe(
      201,
    );
  });

  it('takes the supplier identity from the path, not the body', async () => {
    const server = await build(ROLE_PERMISSIONS.owner);
    const cookie = await cookieFor(server);
    await send('PATCH', `/v1/admin/purchasing/suppliers/${SUPPLIER.toUpperCase()}`, cookie, {
      operationId: 'op-patch',
      name: 'اسم جديد',
    });
    const request = seen.at(0)?.request as { supplierId: string };
    expect(request.supplierId).toBe(SUPPLIER);
  });
});
