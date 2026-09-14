import { listMerchantSales, readMerchantSale } from '@korvi/database';
import { readMerchantPeriodReport } from '@korvi/database/reports';
import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import type {
  MerchantSaleDetail,
  MerchantSalesPage,
  MerchantSalesQuery,
  PrismaClient,
} from '@korvi/database';
import type { MerchantPeriodReport, MerchantReportQuery } from '@korvi/database/reports';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';

export interface MerchantSalesReadService {
  list(principal: AuthenticatedPrincipal, query: MerchantSalesQuery): Promise<MerchantSalesPage>;
  detail(principal: AuthenticatedPrincipal, saleId: string): Promise<MerchantSaleDetail | null>;
  report(
    principal: AuthenticatedPrincipal,
    query: MerchantReportQuery,
  ): Promise<MerchantPeriodReport>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

export function createMerchantSalesReadService(prisma: PrismaClient): MerchantSalesReadService {
  return {
    list(principal, query) {
      requirePrincipalPermission(principal, 'report.read');
      return listMerchantSales(prisma, scopeOf(principal), query);
    },
    detail(principal, saleId) {
      requirePrincipalPermission(principal, 'report.read');
      return readMerchantSale(prisma, scopeOf(principal), saleId);
    },
    report(principal, query) {
      requirePrincipalPermission(principal, 'report.read');
      return readMerchantPeriodReport(prisma, scopeOf(principal), query);
    },
  };
}
