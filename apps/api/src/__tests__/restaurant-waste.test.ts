import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { MerchantRestaurantWasteService } from '../restaurant/waste-service.js';
import type { AuthService } from '../auth/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const TENANT = '01995100-0000-7000-8000-00000000000a';
const USER = '01995100-0000-7000-8000-0000000000a1';
const BRANCH = '01995100-0000-7000-8000-0000000000b0';
const PRODUCT = '01995100-0000-7000-8000-0000000000b1';
const WASTE = '01995100-0000-7000-8000-0000000000c0';
const LINE = '01995100-0000-7000-8000-0000000000c1';
const OP = '01995100-0000-7000-8000-0000000000d1';
const COOKIE = 'korvi_session=waste-test-token';
const ORIGIN = 'http://localhost:3000';

let app: FastifyInstance | null = null;
let calls: string[] = [];

function principal(permissions: AuthenticatedPrincipal['permissions']): AuthenticatedPrincipal {
  return {
    tenantId: TENANT,
    tenantSlug: 'restaurant-waste',
    userId: USER,
    sessionId: '01995100-0000-7000-8000-0000000000aa',
    email: 'manager@restaurant.test',
    displayName: 'المدير',
    roles: ['manager'],
    permissions,
    maxDiscountBasisPoints: 0n,
    branchId: null,
  };
}

function auth(subject: AuthenticatedPrincipal): AuthService {
  return {
    async login() {
      return { outcome: 'failure', reason: 'bad-password' };
    },
    async authenticate(token) {
      return token === 'waste-test-token'
        ? { outcome: 'success', principal: subject }
        : { outcome: 'failure', reason: 'malformed-token' };
    },
    async logout() {
      return true;
    },
    async logoutAll() {
      return 1;
    },
  };
}

function service(): MerchantRestaurantWasteService {
  return {
    async record(_principal, request) {
      calls.push('record');
      return {
        outcome: 'success',
        value: {
          id: WASTE,
          branchId: request.branchId,
          reasonType: request.reasonType,
          note: request.note,
          occurredAt: '2026-09-22T12:00:00.000Z',
          replayed: false,
          lines: [
            {
              id: LINE,
              productId: PRODUCT,
              quantityScaled: '1000',
              beforeQuantityScaled: '5000',
              afterQuantityScaled: '4000',
              resultRevision: '2',
              costKnownQuantityScaled: '1000',
              costUnknownQuantityScaled: '0',
              costValueMinor: '100',
              costProvenance: 'recorded',
            },
          ],
        },
      };
    },
  };
}

function build(subject: AuthenticatedPrincipal): FastifyInstance {
  calls = [];
  app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: auth(subject),
    restaurantWaste: service(),
  });
  return app;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('restaurant waste route authority', () => {
  it('requires product.read and inventory.adjust', async () => {
    const server = build(principal(['product.read']));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/restaurant/waste',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        branchId: BRANCH,
        reasonType: 'waste',
        note: null,
        lines: [{ productId: PRODUCT, quantityScaled: '1000' }],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('accepts only explicit waste intent and exposes no fiscal authority', async () => {
    const server = build(principal(['product.read', 'inventory.adjust']));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/restaurant/waste',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        branchId: BRANCH,
        reasonType: 'spoilage',
        note: 'انتهاء صلاحية',
        lines: [{ productId: PRODUCT, quantityScaled: '1000' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: WASTE,
      branchId: BRANCH,
      reasonType: 'spoilage',
      note: 'انتهاء صلاحية',
      replayed: false,
      lines: [{ productId: PRODUCT, quantityScaled: '1000' }],
    });
    expect(calls).toEqual(['record']);
    for (const forbidden of [
      'priceMinor',
      'vatBasisPoints',
      'invoiceNumber',
      'qrCodeBase64',
      'ICV',
      'PIH',
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it('rejects client-supplied cost, tenant, delta and result authority before service execution', async () => {
    const server = build(principal(['product.read', 'inventory.adjust']));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/restaurant/waste',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        branchId: BRANCH,
        reasonType: 'waste',
        note: null,
        tenantId: TENANT,
        deltaQuantityScaled: '-1000',
        costValueMinor: '1',
        resultRevision: '99',
        lines: [{ productId: PRODUCT, quantityScaled: '1000' }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});
