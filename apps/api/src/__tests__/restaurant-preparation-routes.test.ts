import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { MerchantPreparationService } from '../restaurant/preparation-service.js';
import type { AuthService } from '../auth/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const TENANT = '018fb600-0000-7000-8000-00000000000a';
const BRANCH = '018fb600-0000-7000-8000-0000000000a1';
const USER = '018fb600-0000-7000-8000-0000000000a2';
const STATION = '018fb600-0000-7000-8000-0000000000b1';
const PRODUCT = '018fb600-0000-7000-8000-0000000000c1';
const ORDER = '018fb600-0000-7000-8000-0000000000d1';
const LINE = '018fb600-0000-7000-8000-0000000000e1';
const OP = '018fb600-0000-7000-8000-0000000000f1';
const COOKIE = 'korvi_session=prep-test-token';
const ORIGIN = 'http://localhost:3000';

let app: FastifyInstance | null = null;
let calls: string[] = [];

function principal(permissions: AuthenticatedPrincipal['permissions']): AuthenticatedPrincipal {
  return {
    tenantId: TENANT,
    tenantSlug: 'restaurant-a',
    userId: USER,
    sessionId: '018fb600-0000-7000-8000-0000000000aa',
    email: 'operator@restaurant.test',
    displayName: 'المشغل',
    roles: ['manager'],
    permissions,
    maxDiscountBasisPoints: 0n,
    branchId: BRANCH,
  };
}

function auth(subject: AuthenticatedPrincipal): AuthService {
  return {
    async login() { return { outcome: 'failure', reason: 'bad-password' }; },
    async authenticate(token) {
      return token === 'prep-test-token'
        ? { outcome: 'success', principal: subject }
        : { outcome: 'failure', reason: 'malformed-token' };
    },
    async logout() { return true; },
    async logoutAll() { return 1; },
  };
}

function service(): MerchantPreparationService {
  const station = { id: STATION, branchId: BRANCH, code: 'BAR', nameAr: 'البار', sortOrder: 1, isActive: true };
  return {
    async listStations() { calls.push('listStations'); return { outcome: 'success', value: [station] }; },
    async createStation(_principal, request) {
      calls.push('createStation');
      return { outcome: 'success', value: { value: { ...station, code: request.code }, replayed: false } };
    },
    async listRoutes() {
      calls.push('listRoutes');
      return { outcome: 'success', value: [{ id: OP, branchId: BRANCH, productId: PRODUCT, stationId: STATION }] };
    },
    async setProductRoutes() {
      calls.push('setProductRoutes');
      return { outcome: 'success', value: { value: [{ id: OP, branchId: BRANCH, productId: PRODUCT, stationId: STATION }], replayed: false } };
    },
    async routing() {
      calls.push('routing');
      return {
        outcome: 'success',
        value: {
          orderId: ORDER,
          revision: '3',
          orderType: 'dine-in',
          tableId: null,
          groups: [{
            station,
            lines: [{
              lineId: LINE,
              lineNumber: 1,
              productId: PRODUCT,
              sku: 'COF-1',
              nameAr: 'قهوة',
              quantityScaled: '1000',
              preparationNote: 'بدون سكر',
              preparationOptions: null,
            }],
          }],
          unroutedLines: [],
        },
      };
    },
  };
}

function build(subject: AuthenticatedPrincipal): FastifyInstance {
  calls = [];
  app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: auth(subject),
    restaurantPreparation: service(),
  });
  return app;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('restaurant preparation route authority', () => {
  it('keeps station configuration behind settings.manage', async () => {
    const server = build(principal(['sale.create']));
    const response = await server.inject({
      method: 'GET',
      url: `/v1/admin/restaurant/preparation-stations?branchId=${BRANCH}`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('creates a branch-scoped station only through settings.manage', async () => {
    const server = build(principal(['settings.manage']));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/restaurant/preparation-stations',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: OP, branchId: BRANCH, code: 'BAR', nameAr: 'البار', sortOrder: 1 },
    });
    expect(response.statusCode).toBe(201);
    expect(calls).toEqual(['createStation']);
  });

  it('exposes routing under sale.create and the response is structurally non-fiscal', async () => {
    const server = build(principal(['sale.create']));
    const response = await server.inject({
      method: 'GET',
      url: `/v1/restaurant/orders/${ORDER}/preparation-routing`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual(['routing']);
    const body = response.json();
    expect(body.groups[0].lines[0]).toMatchObject({
      lineId: LINE,
      productId: PRODUCT,
      nameAr: 'قهوة',
      quantityScaled: '1000',
    });
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'priceMinor',
      'vatBasisPoints',
      'invoiceNumber',
      'qrCodeBase64',
      'ICV',
      'PIH',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
