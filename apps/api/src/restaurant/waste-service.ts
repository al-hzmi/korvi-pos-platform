import { RestaurantWasteRefusedError, recordRestaurantWaste } from '@korvi/database';
import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import type {
  PrismaClient,
  RestaurantWasteRefusal,
  RestaurantWasteRequest,
  RestaurantWasteResult,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';

export type RestaurantWasteServiceResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: RestaurantWasteRefusal };

export interface MerchantRestaurantWasteService {
  record(
    principal: AuthenticatedPrincipal,
    request: RestaurantWasteRequest,
  ): Promise<RestaurantWasteServiceResult<RestaurantWasteResult>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

async function attempt<T>(work: () => Promise<T>): Promise<RestaurantWasteServiceResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof RestaurantWasteRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantRestaurantWasteService(
  prisma: PrismaClient,
): MerchantRestaurantWasteService {
  return {
    async record(principal, request) {
      requirePrincipalPermission(principal, 'product.read');
      requirePrincipalPermission(principal, 'inventory.adjust');
      return attempt(() =>
        recordRestaurantWaste(prisma, scopeOf(principal), { userId: principal.userId }, request),
      );
    },
  };
}
