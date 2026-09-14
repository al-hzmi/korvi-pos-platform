import { afterEach, describe, expect, it } from 'vitest';
import { MerchantReportRefusedError } from '@korvi/database/reports';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { MerchantSalesReadService } from '../sales/read-service.js';
import type { AuthService } from '../auth/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const TENANT_ID = '018fb000-0000-7000-8000-00000000000a';
const BRANCH_ID = '018fb000-0000-7000-8000-0000000000a1';
const TERMINAL_ID = '018fb000-0000-7000-8000-0000000000a2';
const USER_ID = '018fb000-0000-7000-8000-0000000000a4';
const SALE_ID = '018fb000-0000-7000-8000-0000000000a7';
const FROM = '2026-09-01T00:00:00+03:00';
const TO = '2026-10-01T00:00:00+03:00';

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
      if (rawToken !== 'sales-test-token' || subject === null) {
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

function reportFixture() {
  return {
    fromInclusive: new Date(FROM).toISOString(),
    toExclusive: new Date(TO).toISOString(),
    branchId: BRANCH_ID,
    currency: 'SAR',
    sales: { documentCount: '2', netMinor: '20000', vatMinor: '3000', totalMinor: '23000' },
    returns: { documentCount: '1', netMinor: '4000', vatMinor: '600', totalMinor: '4600' },
    netAfterReturns: { netMinor: '16000', vatMinor: '2400', totalMinor: '18400' },
    vatBreakdown: [
      {
        vatBasisPoints: 1500,
        salesNetMinor: '20000',
        salesVatMinor: '3000',
        returnsNetMinor: '4000',
        returnsVatMinor: '600',
        netTaxableMinor: '16000',
        netVatMinor: '2400',
      },
    ],
    availableBranches: [
      { id: BRANCH_ID, code: 'JED', nameAr: 'جدة', nameEn: 'Jeddah', isActive: true },
    ],
    branchBreakdown: [
      {
        id: BRANCH_ID,
        code: 'JED',
        nameAr: 'جدة',
        nameEn: 'Jeddah',
        isActive: true,
        sales: {
          documentCount: '2',
          netMinor: '20000',
          vatMinor: '3000',
          totalMinor: '23000',
        },
        returns: {
          documentCount: '1',
          netMinor: '4000',
          vatMinor: '600',
          totalMinor: '4600',
        },
        netAfterReturns: { netMinor: '16000', vatMinor: '2400', totalMinor: '18400' },
      },
    ],
  } as const;
}

function recordingSalesRead() {
  const calls: string[] = [];
  const service: MerchantSalesReadService = {
    async list(subject, query) {
      calls.push(`list:${subject.tenantId}:${query.search ?? ''}`);
      return {
        items: [
          {
            id: SALE_ID,
            invoiceNumber: 'INV-1001',
            status: 'finalized',
            sequence: 1001,
            branch: { id: BRANCH_ID, code: 'JED', nameAr: 'جدة' },
            terminal: { id: TERMINAL_ID, code: 'POS-1', label: 'الصندوق 1' },
            cashier: { id: USER_ID, displayName: 'مالك المتجر' },
            customer: null,
            currency: 'SAR',
            netMinor: '10000',
            vatMinor: '1500',
            totalMinor: '11500',
            tenderKinds: ['cash'],
            issuedAt: '2026-09-14T10:00:00.000Z',
          },
        ],
        nextCursor: null,
      };
    },
    async detail(subject, saleId) {
      calls.push(`detail:${subject.tenantId}:${saleId}`);
      return null;
    },
    async report(subject, query) {
      calls.push(
        `report:${subject.tenantId}:${query.fromInclusive}:${query.toExclusive}:${query.branchId ?? ''}`,
      );
      if (query.branchId === '018fb000-0000-7000-8000-0000000000ff') {
        throw new MerchantReportRefusedError('unknown-branch');
      }
      return reportFixture();
    },
  };
  return { service, calls };
}

function build(subject: AuthenticatedPrincipal | null) {
  const sales = recordingSalesRead();
  app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: authFor(subject),
    salesRead: sales.service,
  });
  return sales;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('merchant sales read routes', () => {
  it('requires an authenticated merchant session before reading sales', async () => {
    const sales = build(principal(['report.read']));
    const response = await app!.inject({ method: 'GET', url: '/v1/admin/sales' });

    expect(response.statusCode).toBe(401);
    expect(sales.calls).toEqual([]);
  });

  it('requires report.read and never calls the service when the permission is absent', async () => {
    const sales = build(principal([]));
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/sales',
      headers: { cookie: 'korvi_session=sales-test-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(sales.calls).toEqual([]);
  });

  it('rejects client-supplied tenant authority before the read service runs', async () => {
    const sales = build(principal(['report.read']));
    const response = await app!.inject({
      method: 'GET',
      url: `/v1/admin/sales?tenantId=${TENANT_ID}`,
      headers: { cookie: 'korvi_session=sales-test-token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_query' });
    expect(sales.calls).toEqual([]);
  });

  it('passes only the server-derived principal to the stored-truth list service', async () => {
    const sales = build(principal(['report.read']));
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/sales?search=INV-1001&limit=25',
      headers: { cookie: 'korvi_session=sales-test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ id: SALE_ID, totalMinor: '11500', vatMinor: '1500' }],
      nextCursor: null,
    });
    expect(sales.calls).toEqual([`list:${TENANT_ID}:INV-1001`]);
  });

  it('returns 404 when a sale is not part of the authenticated tenant read model', async () => {
    const sales = build(principal(['report.read']));
    const response = await app!.inject({
      method: 'GET',
      url: `/v1/admin/sales/${SALE_ID}`,
      headers: { cookie: 'korvi_session=sales-test-token' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'sale_not_found' });
    expect(sales.calls).toEqual([`detail:${TENANT_ID}:${SALE_ID}`]);
  });
});

describe('merchant period report route', () => {
  const path = `/v1/admin/reports/period?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&branchId=${BRANCH_ID}`;

  it('requires a session and report.read before reading financial aggregates', async () => {
    const anonymous = build(principal(['report.read']));
    const noSession = await app!.inject({ method: 'GET', url: path });
    expect(noSession.statusCode).toBe(401);
    expect(anonymous.calls).toEqual([]);
    await app!.close();
    app = null;

    const forbidden = build(principal([]));
    const denied = await app!.inject({
      method: 'GET',
      url: path,
      headers: { cookie: 'korvi_session=sales-test-token' },
    });
    expect(denied.statusCode).toBe(403);
    expect(forbidden.calls).toEqual([]);
  });

  it('rejects unknown query authority before the report service runs', async () => {
    const sales = build(principal(['report.read']));
    const response = await app!.inject({
      method: 'GET',
      url: `${path}&tenantId=${TENANT_ID}`,
      headers: { cookie: 'korvi_session=sales-test-token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_query' });
    expect(sales.calls).toEqual([]);
  });

  it('passes the authenticated tenant and exact period to the report authority', async () => {
    const sales = build(principal(['report.read']));
    const response = await app!.inject({
      method: 'GET',
      url: path,
      headers: { cookie: 'korvi_session=sales-test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      currency: 'SAR',
      sales: { documentCount: '2', totalMinor: '23000' },
      returns: { documentCount: '1', totalMinor: '4600' },
      netAfterReturns: { vatMinor: '2400', totalMinor: '18400' },
      vatBreakdown: [{ vatBasisPoints: 1500, netVatMinor: '2400' }],
    });
    expect(sales.calls).toEqual([`report:${TENANT_ID}:${FROM}:${TO}:${BRANCH_ID}`]);
  });

  it('maps a branch outside the tenant report authority to a safe 404', async () => {
    const sales = build(principal(['report.read']));
    const unknown = '018fb000-0000-7000-8000-0000000000ff';
    const response = await app!.inject({
      method: 'GET',
      url: `/v1/admin/reports/period?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&branchId=${unknown}`,
      headers: { cookie: 'korvi_session=sales-test-token' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'report_branch_not_found' });
    expect(sales.calls).toEqual([`report:${TENANT_ID}:${FROM}:${TO}:${unknown}`]);
  });
});
