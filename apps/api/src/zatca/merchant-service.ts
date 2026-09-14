import { readMerchantZatcaStatus } from '@korvi/database/zatca-merchant';
import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import type { PrismaClient } from '@korvi/database';
import type {
  MerchantZatcaStatus,
  MerchantZatcaStatusQuery,
} from '@korvi/database/zatca-merchant';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';

export interface MerchantZatcaService {
  status(
    principal: AuthenticatedPrincipal,
    query?: MerchantZatcaStatusQuery,
  ): Promise<MerchantZatcaStatus>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

/** Merchant ZATCA visibility is administration authority, never POS authority. */
export function createMerchantZatcaService(prisma: PrismaClient): MerchantZatcaService {
  return {
    status(principal, query = {}) {
      requirePrincipalPermission(principal, 'zatca.manage');
      return readMerchantZatcaStatus(prisma, scopeOf(principal), query);
    },
  };
}
