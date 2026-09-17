import { afterEach, describe, expect, it } from 'vitest';
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

let app: FastifyInstance | null = null;

function principal(permissions: AuthenticatedPrincipal['permissions']): AuthenticatedPrincipal {
  return {
    tenantId: TENANT_ID,
    tenantSlug: 'korvi-a',
    userId: USER_ID,
    sessionId: '018fb000-0000-7000-8000-0000000000a8',
    email: 'cashier@korvi.test',
    displayName: 'الكاشير',
    roles: ['cashier'],
    permissions,
    maxDiscountBasisPoints: 0n,
    branchId: BRANCH_ID,
    terminalId: TERMINAL_ID,
  };
}

function authFor(subject: AuthenticatedPrincipal): AuthService {
  return {
    async login() {
      return { outcome: 'failure', reason: 'bad-password' };
    },
    async authenticate(rawToken) {
      return rawToken === 'receipt-test-token'
        ? { outcome: 'success' as const, principal: subject }
        : { outcome: 'failure' as const, reason: 'malformed-token' as const };
    },
    async logout() {
      return true;
    },
    async logoutAll() {
      return 1;
    },
  };
}

function build(
  subject: AuthenticatedPrincipal,
  outcome: 'success' | 'not-found' | 'not-sealed' = 'success',
) {
  const calls: string[] = [];
  const service: MerchantSalesReadService = {
    async list() {
      return { items: [], nextCursor: null };
    },
    async detail() {
      return null;
    },
    async report() {
      throw new Error('not used');
    },
    async fiscalReceipt(actor, saleId, terminalId) {
      calls.push(`${actor.tenantId}:${actor.userId}:${saleId}:${terminalId}`);
      if (outcome !== 'success') return { outcome };
      return {
        outcome: 'success',
        sale: {
          saleId,
          operationId: '018fb000-0000-7000-8000-0000000000b1',
          sequence: 42,
          invoiceNumber: 'INV-42',
          issuedAt: '2026-09-17T12:00:00Z',
          currency: 'SAR',
          branchId: BRANCH_ID,
          terminalId,
          shiftId: '018fb000-0000-7000-8000-0000000000b2',
          cashierName: actor.displayName,
          lines: [],
          netMinor: '2000',
          vatMinor: '300',
          totalMinor: '2300',
          cashReceivedMinor: '2500',
          changeMinor: '200',
        },
        receipt: {
          invoiceId: '018fb000-0000-7000-8000-0000000000b3',
          invoiceNumber: 'INV-42',
          issuedAt: '2026-09-17T12:00:00Z',
          currency: 'SAR',
          sellerName: 'Merchant Snapshot',
          vatRegistrationNumber: '300000000000003',
          lines: [],
          netMinor: '2000',
          vatMinor: '300',
          totalMinor: '2300',
          invoiceHashBase64: 'AQID',
          qrCodeBase64: 'PERSISTED_PHASE_2_QR',
        },
      };
    },
  };

  app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: authFor(subject),
    salesRead: service,
  });
  return calls;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('cashier historical fiscal receipt route', () => {
  const url = `/v1/sales/${SALE_ID}/fiscal-receipt?terminalId=${TERMINAL_ID}`;

  it('requires sale.create rather than merchant-wide report authority', async () => {
    const calls = build(principal([]));
    const response = await app!.inject({
      method: 'GET',
      url,
      headers: { cookie: 'korvi_session=receipt-test-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('returns only finalized print facts from the read service', async () => {
    const calls = build(principal(['sale.create']));
    const response = await app!.inject({
      method: 'GET',
      url,
      headers: { cookie: 'korvi_session=receipt-test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sale: { saleId: SALE_ID, invoiceNumber: 'INV-42', totalMinor: '2300' },
      receipt: {
        invoiceHashBase64: 'AQID',
        qrCodeBase64: 'PERSISTED_PHASE_2_QR',
      },
    });
    expect(calls).toEqual([`${TENANT_ID}:${USER_ID}:${SALE_ID}:${TERMINAL_ID}`]);
  });

  it('maps ownership refusal to a non-enumerating 404', async () => {
    const calls = build(principal(['sale.create']), 'not-found');
    const response = await app!.inject({
      method: 'GET',
      url,
      headers: { cookie: 'korvi_session=receipt-test-token' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'sale_not_found' });
    expect(calls).toHaveLength(1);
  });

  it('makes missing sealed evidence visible without creating replacement fiscal truth', async () => {
    build(principal(['sale.create']), 'not-sealed');
    const response = await app!.inject({
      method: 'GET',
      url,
      headers: { cookie: 'korvi_session=receipt-test-token' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'fiscal_receipt_not_sealed' });
  });

  it('rejects malformed or extra terminal authority before the service runs', async () => {
    const calls = build(principal(['sale.create']));
    const response = await app!.inject({
      method: 'GET',
      url: `${url}&tenantId=${TENANT_ID}`,
      headers: { cookie: 'korvi_session=receipt-test-token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_query' });
    expect(calls).toEqual([]);
  });
});
