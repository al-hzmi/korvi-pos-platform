import { listMerchantSales, readMerchantSale } from '@korvi/database';
import { tenantId as brandTenantId } from '@korvi/domain';
import type {
  MerchantSaleDetail,
  MerchantSalesPage,
  MerchantSalesQuery,
  PrismaClient,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';

export interface MerchantSalesReadService {
  list(principal: AuthenticatedPrincipal, query: MerchantSalesQuery): Promise<MerchantSalesPage>;
  detail(principal: AuthenticatedPrincipal, saleId: string): Promise<MerchantSaleDetail | null>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

export function createMerchantSalesReadService(prisma: PrismaClient): MerchantSalesReadService {
  return {
    list(principal, query) {
      return listMerchantSales(prisma, scopeOf(principal), query);
    },
    detail(principal, saleId) {
      return readMerchantSale(prisma, scopeOf(principal), saleId);
    },
  };
}
