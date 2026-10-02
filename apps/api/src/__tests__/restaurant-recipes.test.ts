import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { MerchantRestaurantRecipeService } from '../restaurant/recipe-service.js';
import type { AuthService } from '../auth/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const TENANT = '018fb700-0000-7000-8000-00000000000a';
const USER = '018fb700-0000-7000-8000-0000000000a1';
const BRANCH = '018fb700-0000-7000-8000-0000000000b0';
const PRODUCT = '018fb700-0000-7000-8000-0000000000b1';
const INGREDIENT = '018fb700-0000-7000-8000-0000000000c1';
const RECIPE = '018fb700-0000-7000-8000-0000000000d1';
const OP = '018fb700-0000-7000-8000-0000000000e1';
const COOKIE = 'korvi_session=recipe-test-token';
const ORIGIN = 'http://localhost:3000';

let app: FastifyInstance | null = null;
let calls: string[] = [];

function principal(permissions: AuthenticatedPrincipal['permissions']): AuthenticatedPrincipal {
  return {
    tenantId: TENANT,
    tenantSlug: 'restaurant-a',
    userId: USER,
    sessionId: '018fb700-0000-7000-8000-0000000000aa',
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
      return token === 'recipe-test-token'
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

const recipe = {
  id: RECIPE,
  productId: PRODUCT,
  productSku: 'LATTE',
  productNameAr: 'لاتيه',
  productType: 'unit' as const,
  yieldQuantityScaled: '1000',
  revision: '1',
  ingredients: [
    {
      id: '018fb700-0000-7000-8000-0000000000f1',
      productId: INGREDIENT,
      sku: 'MILK',
      nameAr: 'حليب',
      productType: 'weighted' as const,
      unitLabel: 'ml',
      quantityScaled: '250',
    },
  ],
};

function service(): MerchantRestaurantRecipeService {
  return {
    async detail() {
      calls.push('detail');
      return { outcome: 'success', value: recipe };
    },
    async set(_principal, _productId, request) {
      calls.push('set');
      return {
        outcome: 'success',
        value: {
          recipe: { ...recipe, revision: request.expectedRevision === null ? '1' : '2' },
          replayed: false,
        },
      };
    },
    async cost() {
      calls.push('cost');
      return {
        outcome: 'success',
        value: {
          branchId: BRANCH,
          productId: PRODUCT,
          recipeRevision: '1',
          yieldQuantityScaled: '1000',
          status: 'unknown',
          yieldCostMinor: null,
          ingredients: [
            {
              productId: INGREDIENT,
              sku: 'MILK',
              nameAr: 'حليب',
              requiredQuantityScaled: '250',
              stockQuantityScaled: '1000',
              knownQuantityScaled: '0',
              unknownQuantityScaled: '250',
              knownValueMinor: '0',
              status: 'unknown',
            },
          ],
        },
      };
    },
    async produce(_principal, productId, request) {
      calls.push('produce');
      return {
        outcome: 'success',
        value: {
          id: '018fb700-0000-7000-8000-0000000000f2',
          branchId: request.branchId,
          recipeId: RECIPE,
          productId,
          recipeRevision: request.recipeRevision,
          batchCount: request.batchCount,
          producedAt: '2026-09-22T12:00:00.000Z',
          replayed: false,
          outputCostStatus: 'known',
          lines: [
            {
              id: '018fb700-0000-7000-8000-0000000000f3',
              role: 'ingredient',
              productId: INGREDIENT,
              deltaQuantityScaled: '-250',
              beforeQuantityScaled: '1000',
              afterQuantityScaled: '750',
              resultRevision: '2',
              costKnownQuantityScaled: '250',
              costUnknownQuantityScaled: '0',
              costValueMinor: '100',
              costProvenance: 'recorded',
            },
            {
              id: '018fb700-0000-7000-8000-0000000000f4',
              role: 'output',
              productId,
              deltaQuantityScaled: '1000',
              beforeQuantityScaled: '0',
              afterQuantityScaled: '1000',
              resultRevision: '1',
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
    restaurantRecipes: service(),
  });
  return app;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('restaurant recipe route authority', () => {
  it('requires product.read for recipe reads', async () => {
    const server = build(principal([]));
    const response = await server.inject({
      method: 'GET',
      url: `/v1/admin/restaurant/recipes/${PRODUCT}`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('requires both product.write and inventory.adjust for recipe mutation', async () => {
    const server = build(principal(['product.write']));
    const response = await server.inject({
      method: 'PUT',
      url: `/v1/admin/restaurant/recipes/${PRODUCT}`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        expectedRevision: null,
        yieldQuantityScaled: '1000',
        ingredients: [{ productId: INGREDIENT, quantityScaled: '250' }],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('requires inventory.cost.read and preserves unknown cost instead of inventing a yield cost', async () => {
    const denied = build(principal(['product.read']));
    const deniedResponse = await denied.inject({
      method: 'GET',
      url: `/v1/admin/restaurant/recipes/${PRODUCT}/cost?branchId=${BRANCH}`,
      headers: { cookie: COOKIE },
    });
    expect(deniedResponse.statusCode).toBe(403);
    expect(calls).toEqual([]);
    await denied.close();
    app = null;

    const server = build(principal(['product.read', 'inventory.cost.read']));
    const response = await server.inject({
      method: 'GET',
      url: `/v1/admin/restaurant/recipes/${PRODUCT}/cost?branchId=${BRANCH}`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'unknown',
      yieldCostMinor: null,
      ingredients: [{ productId: INGREDIENT, status: 'unknown', unknownQuantityScaled: '250' }],
    });
    expect(calls).toEqual(['cost']);
  });

  it('writes only through strict server-authorized recipe input', async () => {
    const server = build(principal(['product.write', 'inventory.adjust']));
    const response = await server.inject({
      method: 'PUT',
      url: `/v1/admin/restaurant/recipes/${PRODUCT}`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        expectedRevision: null,
        yieldQuantityScaled: '1000',
        ingredients: [{ productId: INGREDIENT, quantityScaled: '250' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      recipe: { id: RECIPE, productId: PRODUCT, revision: '1' },
      replayed: false,
    });
    expect(calls).toEqual(['set']);

    for (const forbidden of [
      'priceMinor',
      'costValueMinor',
      'vatBasisPoints',
      'invoiceNumber',
      'qrCodeBase64',
      'ICV',
      'PIH',
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it('rejects client-supplied authority fields before service execution', async () => {
    const server = build(principal(['product.write', 'inventory.adjust']));
    const response = await server.inject({
      method: 'PUT',
      url: `/v1/admin/restaurant/recipes/${PRODUCT}`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        expectedRevision: null,
        yieldQuantityScaled: '1000',
        tenantId: TENANT,
        revision: '99',
        costValueMinor: '1',
        ingredients: [{ productId: INGREDIENT, quantityScaled: '250' }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('restaurant production route authority', () => {
  it('requires inventory.adjust and product.read for production', async () => {
    const server = build(principal(['product.read']));
    const response = await server.inject({
      method: 'POST',
      url: `/v1/admin/restaurant/recipes/${PRODUCT}/production`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        branchId: BRANCH,
        recipeRevision: '1',
        batchCount: '1',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('accepts only bounded production intent and returns non-fiscal stock evidence', async () => {
    const server = build(principal(['product.read', 'inventory.adjust']));
    const response = await server.inject({
      method: 'POST',
      url: `/v1/admin/restaurant/recipes/${PRODUCT}/production`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        branchId: BRANCH,
        recipeRevision: '1',
        batchCount: '1',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      productId: PRODUCT,
      recipeId: RECIPE,
      outputCostStatus: 'known',
      lines: [
        { role: 'ingredient', productId: INGREDIENT, deltaQuantityScaled: '-250' },
        { role: 'output', productId: PRODUCT, deltaQuantityScaled: '1000' },
      ],
    });
    expect(calls).toEqual(['produce']);
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

  it('rejects client-supplied production authority and cost fields before service execution', async () => {
    const server = build(principal(['product.read', 'inventory.adjust']));
    const response = await server.inject({
      method: 'POST',
      url: `/v1/admin/restaurant/recipes/${PRODUCT}/production`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        branchId: BRANCH,
        recipeRevision: '1',
        batchCount: '1',
        tenantId: TENANT,
        ingredientProductId: INGREDIENT,
        outputQuantityScaled: '999000',
        costValueMinor: '1',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});
