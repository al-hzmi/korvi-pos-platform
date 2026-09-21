import {
  RestaurantRecipeRefusedError,
  readRestaurantRecipe,
  setRestaurantRecipe,
} from '@korvi/database';
import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import type {
  PrismaClient,
  RestaurantRecipeMutationResult,
  RestaurantRecipeRecord,
  RestaurantRecipeRefusal,
  SetRestaurantRecipeRequest,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';

export type RestaurantRecipeServiceResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: RestaurantRecipeRefusal };

export interface MerchantRestaurantRecipeService {
  detail(
    principal: AuthenticatedPrincipal,
    productId: string,
  ): Promise<RestaurantRecipeServiceResult<RestaurantRecipeRecord | null>>;
  set(
    principal: AuthenticatedPrincipal,
    productId: string,
    request: SetRestaurantRecipeRequest,
  ): Promise<RestaurantRecipeServiceResult<RestaurantRecipeMutationResult>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

async function attempt<T>(work: () => Promise<T>): Promise<RestaurantRecipeServiceResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof RestaurantRecipeRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantRestaurantRecipeService(
  prisma: PrismaClient,
): MerchantRestaurantRecipeService {
  return {
    async detail(principal, productId) {
      requirePrincipalPermission(principal, 'product.read');
      return attempt(() => readRestaurantRecipe(prisma, scopeOf(principal), productId));
    },
    async set(principal, productId, request) {
      requirePrincipalPermission(principal, 'product.write');
      requirePrincipalPermission(principal, 'inventory.adjust');
      return attempt(() =>
        setRestaurantRecipe(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          productId,
          request,
        ),
      );
    },
  };
}
