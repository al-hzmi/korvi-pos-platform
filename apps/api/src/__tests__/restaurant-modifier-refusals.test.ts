import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { RestaurantModifierAdminRefusedError } from '@korvi/database';
import { registerRestaurantModifierRoutes } from '../routes/restaurant-modifiers.js';
import type { MerchantRestaurantModifierService } from '../restaurant/modifier-service.js';
import type { Guards } from '../auth/guards.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';

const PRODUCT = '018f6000-0000-7000-8000-000000000001';

function principal(allowed: boolean): AuthenticatedPrincipal {
  return {
    tenantId: '018f6000-0000-7000-8000-000000000002',
    tenantSlug: 'retail-proof',
    userId: '018f6000-0000-7000-8000-000000000003',
    sessionId: '018f6000-0000-7000-8000-000000000004',
    email: 'operator@korvi.test',
    displayName: 'مشغل',
    roles: ['cashier'],
    permissions: allowed ? ['sale.create', 'restaurant.menu.manage'] : [],
    maxDiscountBasisPoints: 0n,
    branchId: '018f6000-0000-7000-8000-000000000005',
  };
}

const refuses = async (): Promise<never> => {
  throw new RestaurantModifierAdminRefusedError('restaurant-mode-required');
};

const service: MerchantRestaurantModifierService = {
  menu: refuses,
  list: refuses,
  productGroups: refuses,
  createGroup: refuses,
  updateGroup: refuses,
  createOption: refuses,
  updateOption: refuses,
  setProductGroups: refuses,
};

async function build(allowed: boolean) {
  const app = Fastify({ logger: false });
  const grants = principal(allowed);
  const authenticate: Guards['requireSession'] = async (request) => {
    request.auth = grants;
  };
  const guards: Guards = {
    enforceOrigin: async () => undefined,
    requireSession: authenticate,
    requireBrowserSession: authenticate,
    requirePermission: (permission) => async (request, reply) => {
      if (!request.auth?.permissions.includes(permission)) {
        await reply.code(403).send({ error: 'forbidden' });
      }
    },
  };

  registerRestaurantModifierRoutes(app, { service, guards });
  await app.ready();
  return app;
}

describe('restaurant modifier read refusals', () => {
  it('maps a retail merchant to a stable 409, never an internal 500', async () => {
    const app = await build(true);
    try {
      const list = await app.inject({
        method: 'GET',
        url: '/v1/admin/restaurant/modifier-groups',
      });
      expect(list.statusCode).toBe(409);
      expect(list.json()).toEqual({ error: 'restaurant_mode_required' });

      const menu = await app.inject({
        method: 'GET',
        url: `/v1/restaurant/modifiers/products/${PRODUCT}`,
      });
      expect(menu.statusCode).toBe(409);
      expect(menu.json()).toEqual({ error: 'restaurant_mode_required' });
    } finally {
      await app.close();
    }
  });

  it('preserves least-privilege 403 before any modifier policy read', async () => {
    const app = await build(false);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/admin/restaurant/modifier-groups',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden' });
    } finally {
      await app.close();
    }
  });
});
