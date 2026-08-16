import { tenantId as brandTenantId } from '@korvi/domain';
import { ProductBootstrapRefusedError, createBootstrapProduct } from '@korvi/database';
import type { AdminProductBootstrap, PrismaClient, ProductBootstrapRefusal } from '@korvi/database';
import type { AuthenticatedPrincipal, ProductBootstrapDraft, TenantScope } from '@korvi/domain';

/**
 * Merchant catalogue bootstrap at the API boundary.
 *
 * The tenant and actor are structurally session-derived. A caller can describe
 * a product, but cannot choose the merchant, activate a row, set inventory, or
 * write a price-history record directly.
 */
export type ProductAdminFailureReason = ProductBootstrapRefusal;

export type ProductAdminResult =
  | { readonly outcome: 'success'; readonly value: AdminProductBootstrap }
  | { readonly outcome: 'failure'; readonly reason: ProductAdminFailureReason };

export interface MerchantProductService {
  create(
    principal: AuthenticatedPrincipal,
    input: ProductBootstrapDraft,
  ): Promise<ProductAdminResult>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

export function createMerchantProductService(prisma: PrismaClient): MerchantProductService {
  return {
    async create(principal, input) {
      try {
        const value = await createBootstrapProduct(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          input,
        );
        return { outcome: 'success', value };
      } catch (error) {
        if (error instanceof ProductBootstrapRefusedError) {
          return { outcome: 'failure', reason: error.detail };
        }
        throw error;
      }
    },
  };
}
