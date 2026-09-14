import { afterEach, describe, expect, it } from 'vitest';
import { CustomerAdminRefusedError } from '@korvi/database';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { MerchantCustomerService } from '../customers/service.js';
import type { AuthService } from '../auth/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const TENANT_ID = '018fb000-0000-7000-8000-00000000000a';
const BRANCH_ID = '018fb000-0000-7000-8000-0000000000a1';
const USER_ID = '018fb000-0000-7000-8000-0000000000a4';
const CUSTOMER_ID = '018fb000-0000-7000-8000-0000000000e1';
const OTHER_CUSTOMER_ID = '018fb000-0000-7000-8000-0000000000e2';

const customer = {
  id: CUSTOMER_ID,
  nameAr: 'شركة النخبة',
  nameEn: 'Elite Co',
  phone: '0500000000',
  email: 'buyer@example.test',
  vatNumber: '310111111100003',
  isActive: true,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
} as const;

let app: FastifyInstance | null = null;

function principal(permissions: AuthenticatedPrincipal['permissions']): AuthenticatedPrincipal {
  return {
    tenantId: TENANT_ID,
    tenantSlug: 'korvi-a',
    userId: USER_ID,
    sessionId: '018fb000-0000-7000-8000-0000000000a8',
    email: 'owner@korvi.test',
    displayName: 'مالك المتجر',
    roles: ['owner'],
    permissions,
    maxDiscountBasisPoints: 10_000n,
    branchId: BRANCH_ID,
  };
}

function authFor(subject: AuthenticatedPrincipal | null): AuthService {
  return {
    async login() {
      return { outcome: 'failure', reason: 'bad-password' };
    },
    async authenticate(rawToken) {
      if (rawToken !== 'customer-test-token' || subject === null) {
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

function recordingCustomers() {
  const calls: string[] = [];
  const service: MerchantCustomerService = {
    async list(subject, query) {
      calls.push(`list:${subject.tenantId}:${query.search ?? ''}:${query.cursor ?? ''}`);
      if (query.cursor === 'bad-cursor') throw new CustomerAdminRefusedError('invalid-cursor');
      return { items: [customer], nextCursor: null };
    },
    async detail(subject, customerId) {
      calls.push(`detail:${subject.tenantId}:${customerId}`);
      if (customerId === OTHER_CUSTOMER_ID) return null;
      return {
        ...customer,
        salesCount: 1,
        recentSales: [
          {
            id: '018fb000-0000-7000-8000-0000000000a7',
            invoiceNumber: 'INV-1001',
            status: 'finalized',
            issuedAt: '2026-09-14T10:00:00.000Z',
            currency: 'SAR',
            totalMinor: '11500',
          },
        ],
      };
    },
    async create(subject, request) {
      calls.push(`create:${subject.tenantId}:${subject.userId}:${request.operationId}`);
      if (request.phone === '0509999999') {
        return { outcome: 'failure', reason: 'phone-taken' };
      }
      return {
        outcome: 'success',
        value: { customer, replayed: request.operationId === 'customer-create-replay' },
      };
    },
    async update(subject, customerId, request) {
      calls.push(`update:${subject.tenantId}:${subject.userId}:${customerId}:${request.operationId}`);
      if (customerId === OTHER_CUSTOMER_ID) {
        return { outcome: 'failure', reason: 'unknown-customer' };
      }
      return { outcome: 'success', value: { customer, replayed: false } };
    },
  };
  return { service, calls };
}

function build(subject: AuthenticatedPrincipal | null) {
  const customers = recordingCustomers();
  app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: authFor(subject),
    customers: customers.service,
  });
  return customers;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('merchant customer routes', () => {
  it('requires an authenticated merchant session before reading customers', async () => {
    const customers = build(principal(['customer.read']));
    const response = await app!.inject({ method: 'GET', url: '/v1/admin/customers' });

    expect(response.statusCode).toBe(401);
    expect(customers.calls).toEqual([]);
  });

  it('separates customer.read from customer.write', async () => {
    const customers = build(principal(['customer.read']));
    const read = await app!.inject({
      method: 'GET',
      url: '/v1/admin/customers?search=%D8%A7%D9%84%D9%86%D8%AE%D8%A8%D8%A9',
      headers: { cookie: 'korvi_session=customer-test-token' },
    });
    const write = await app!.inject({
      method: 'POST',
      url: '/v1/admin/customers',
      headers: { cookie: 'korvi_session=customer-test-token' },
      payload: {
        operationId: 'customer-create-1',
        nameAr: 'عميل',
        nameEn: null,
        phone: null,
        email: null,
        vatNumber: null,
      },
    });

    expect(read.statusCode).toBe(200);
    expect(write.statusCode).toBe(403);
    expect(customers.calls).toEqual([`list:${TENANT_ID}:النخبة:`]);
  });

  it('rejects client-supplied tenant and actor authority before the service runs', async () => {
    const customers = build(principal(['customer.read', 'customer.write']));
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/admin/customers',
      headers: { cookie: 'korvi_session=customer-test-token' },
      payload: {
        operationId: 'customer-create-2',
        nameAr: 'عميل',
        nameEn: null,
        phone: null,
        email: null,
        vatNumber: null,
        tenantId: '018fb000-0000-7000-8000-000000000099',
        userId: '018fb000-0000-7000-8000-000000000098',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_body' });
    expect(customers.calls).toEqual([]);
  });

  it('passes only the authenticated principal and returns the stored customer detail', async () => {
    const customers = build(principal(['customer.read']));
    const response = await app!.inject({
      method: 'GET',
      url: `/v1/admin/customers/${CUSTOMER_ID}`,
      headers: { cookie: 'korvi_session=customer-test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: CUSTOMER_ID,
      nameAr: 'شركة النخبة',
      salesCount: 1,
      recentSales: [{ invoiceNumber: 'INV-1001', totalMinor: '11500' }],
    });
    expect(customers.calls).toEqual([`detail:${TENANT_ID}:${CUSTOMER_ID}`]);
  });

  it('maps invalid opaque cursors without exposing persistence errors', async () => {
    const customers = build(principal(['customer.read']));
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/customers?cursor=bad-cursor',
      headers: { cookie: 'korvi_session=customer-test-token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_cursor' });
    expect(customers.calls).toEqual([`list:${TENANT_ID}::bad-cursor`]);
  });

  it('maps duplicate customer phone to a conflict', async () => {
    const customers = build(principal(['customer.write']));
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/admin/customers',
      headers: { cookie: 'korvi_session=customer-test-token' },
      payload: {
        operationId: 'customer-create-3',
        nameAr: 'عميل',
        nameEn: null,
        phone: '0509999999',
        email: null,
        vatNumber: null,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'customer_phone_taken' });
    expect(customers.calls).toEqual([`create:${TENANT_ID}:${USER_ID}:customer-create-3`]);
  });

  it('distinguishes a new create from an idempotent replay', async () => {
    const customers = build(principal(['customer.write']));
    const payload = {
      nameAr: 'عميل',
      nameEn: null,
      phone: null,
      email: null,
      vatNumber: null,
    };
    const created = await app!.inject({
      method: 'POST',
      url: '/v1/admin/customers',
      headers: { cookie: 'korvi_session=customer-test-token' },
      payload: { ...payload, operationId: 'customer-create-new' },
    });
    const replayed = await app!.inject({
      method: 'POST',
      url: '/v1/admin/customers',
      headers: { cookie: 'korvi_session=customer-test-token' },
      payload: { ...payload, operationId: 'customer-create-replay' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ customer: { id: CUSTOMER_ID }, replayed: false });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ customer: { id: CUSTOMER_ID }, replayed: true });
    expect(customers.calls).toEqual([
      `create:${TENANT_ID}:${USER_ID}:customer-create-new`,
      `create:${TENANT_ID}:${USER_ID}:customer-create-replay`,
    ]);
  });

  it('maps an update outside the authenticated tenant customer set to 404', async () => {
    const customers = build(principal(['customer.write']));
    const response = await app!.inject({
      method: 'PATCH',
      url: `/v1/admin/customers/${OTHER_CUSTOMER_ID}`,
      headers: { cookie: 'korvi_session=customer-test-token' },
      payload: { operationId: 'customer-update-1', isActive: false },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'customer_not_found' });
    expect(customers.calls).toEqual([
      `update:${TENANT_ID}:${USER_ID}:${OTHER_CUSTOMER_ID}:customer-update-1`,
    ]);
  });
});
