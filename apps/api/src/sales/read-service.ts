import { createSaleRepository, listMerchantSales, readMerchantSale } from '@korvi/database';
import { readMerchantPeriodReport } from '@korvi/database/reports';
import { createZatcaFiscalizationRepository } from '@korvi/database/zatca-fiscalization';
import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import { createFiscalReceiptReadService } from '../checkout/receipt-read.js';
import type { FiscalReceiptReadResult } from '../checkout/receipt-read.js';
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
  /**
   * Cashier-safe historical receipt retrieval. Optional only so focused route
   * tests may inject the older reporting-only surface; production always wires
   * it in createMerchantSalesReadService below.
   */
  readonly fiscalReceipt?: (
    principal: AuthenticatedPrincipal,
    saleId: string,
    terminalId: string,
  ) => Promise<FiscalReceiptReadResult>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

export function createMerchantSalesReadService(prisma: PrismaClient): MerchantSalesReadService {
  const fiscalReceiptRead = createFiscalReceiptReadService({
    sales: createSaleRepository(prisma),
    fiscalizations: createZatcaFiscalizationRepository(prisma),
  });

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
    fiscalReceipt(principal, saleId, terminalId) {
      requirePrincipalPermission(principal, 'sale.create');
      return fiscalReceiptRead.read(principal, saleId, terminalId);
    },
  };
}
