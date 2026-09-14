import { withTenant } from '../tenant-context.js';
import { tenantParam } from '../repositories/mapping.js';
import type { PrismaClient } from '../client.js';
import type { TenantScope } from '@korvi/domain';

export const MAX_MERCHANT_SALES_PAGE = 100;

export type MerchantSaleStatus = 'finalized' | 'voided';

export interface MerchantSalesQuery {
  readonly branchId?: string;
  readonly terminalId?: string;
  readonly userId?: string;
  readonly status?: MerchantSaleStatus;
  readonly from?: Date;
  readonly to?: Date;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface MerchantSaleSummary {
  readonly id: string;
  readonly invoiceNumber: string | null;
  readonly status: MerchantSaleStatus;
  readonly sequence: number;
  readonly branch: { readonly id: string; readonly code: string; readonly nameAr: string };
  readonly terminal: { readonly id: string; readonly code: string; readonly label: string };
  readonly cashier: { readonly id: string; readonly displayName: string };
  readonly customer: { readonly id: string; readonly nameAr: string } | null;
  readonly currency: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly tenderKinds: readonly string[];
  readonly issuedAt: string;
}

export interface MerchantSalesPage {
  readonly items: readonly MerchantSaleSummary[];
  readonly nextCursor: string | null;
}

export interface MerchantSaleDetail {
  readonly id: string;
  readonly operationId: string;
  readonly invoiceNumber: string | null;
  readonly invoiceType: string | null;
  readonly status: MerchantSaleStatus;
  readonly sequence: number;
  readonly priceMode: string;
  readonly branch: { readonly id: string; readonly code: string; readonly nameAr: string };
  readonly terminal: { readonly id: string; readonly code: string; readonly label: string };
  readonly cashier: { readonly id: string; readonly displayName: string; readonly email: string };
  readonly customer:
    | {
        readonly id: string;
        readonly nameAr: string;
        readonly phone: string | null;
        readonly vatNumber: string | null;
      }
    | null;
  readonly currency: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly tenderedMinor: string;
  readonly changeMinor: string;
  readonly issuedAt: string;
  readonly lines: readonly {
    readonly id: string;
    readonly lineNumber: number;
    readonly productId: string | null;
    readonly sku: string;
    readonly nameAr: string;
    readonly nameEn: string | null;
    readonly productType: string | null;
    readonly unitPriceMinor: string;
    readonly vatBasisPoints: number;
    readonly quantityScaled: string;
    readonly grossMinor: string;
    readonly lineDiscountMinor: string;
    readonly basketDiscountMinor: string;
    readonly netMinor: string;
    readonly vatMinor: string;
    readonly totalMinor: string;
  }[];
  readonly tenders: readonly {
    readonly id: string;
    readonly kind: string;
    readonly scheme: string | null;
    readonly amountMinor: string;
    readonly changeMinor: string;
    readonly reference: string | null;
  }[];
  readonly invoice:
    | {
        readonly id: string;
        readonly invoiceNumber: string;
        readonly invoiceType: string;
        readonly sellerName: string;
        readonly sellerVatNumber: string;
        readonly buyerName: string | null;
        readonly buyerVatNumber: string | null;
        readonly netMinor: string;
        readonly vatMinor: string;
        readonly totalMinor: string;
        readonly currency: string;
        readonly issuedAt: string;
        readonly taxBreakdown: readonly {
          readonly vatBasisPoints: number;
          readonly netMinor: string;
          readonly vatMinor: string;
        }[];
      }
    | null;
  readonly returns: readonly {
    readonly id: string;
    readonly returnNumber: string | null;
    readonly status: string;
    readonly reason: string | null;
    readonly totalMinor: string;
    readonly vatMinor: string;
    readonly issuedAt: string;
  }[];
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > MAX_MERCHANT_SALES_PAGE) {
    throw new RangeError(`limit must be an integer from 1 to ${String(MAX_MERCHANT_SALES_PAGE)}`);
  }
  return value;
}

function normalizedSearch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize('NFKC').trim();
  if (normalized === '') return undefined;
  if (normalized.length > 120) throw new RangeError('search must be at most 120 characters');
  return normalized;
}

export async function listMerchantSales(
  prisma: PrismaClient,
  scope: TenantScope,
  query: MerchantSalesQuery = {},
): Promise<MerchantSalesPage> {
  const tenantId = tenantParam(scope);
  const limit = boundedLimit(query.limit);
  const search = normalizedSearch(query.search);

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const rows = await tx.sale.findMany({
      where: {
        tenantId,
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.terminalId === undefined ? {} : { terminalId: query.terminalId }),
        ...(query.userId === undefined ? {} : { userId: query.userId }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              issuedAt: {
                ...(query.from === undefined ? {} : { gte: query.from }),
                ...(query.to === undefined ? {} : { lte: query.to }),
              },
            }),
        ...(search === undefined
          ? {}
          : {
              OR: [
                { invoice: { is: { invoiceNumber: { contains: search, mode: 'insensitive' } } } },
                { branch: { nameAr: { contains: search, mode: 'insensitive' } } },
                { terminal: { label: { contains: search, mode: 'insensitive' } } },
                { user: { displayName: { contains: search, mode: 'insensitive' } } },
                { customer: { is: { nameAr: { contains: search, mode: 'insensitive' } } } },
                { customer: { is: { phone: { contains: search } } } },
              ],
            }),
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      select: {
        id: true,
        status: true,
        sequence: true,
        currency: true,
        netMinor: true,
        vatMinor: true,
        totalMinor: true,
        issuedAt: true,
        branch: { select: { id: true, code: true, nameAr: true } },
        terminal: { select: { id: true, code: true, label: true } },
        user: { select: { id: true, displayName: true } },
        customer: { select: { id: true, nameAr: true } },
        invoice: { select: { invoiceNumber: true } },
        tenders: { select: { kind: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => ({
        id: row.id,
        invoiceNumber: row.invoice?.invoiceNumber ?? null,
        status: row.status as MerchantSaleStatus,
        sequence: row.sequence,
        branch: row.branch,
        terminal: row.terminal,
        cashier: row.user,
        customer: row.customer,
        currency: row.currency,
        netMinor: row.netMinor.toString(),
        vatMinor: row.vatMinor.toString(),
        totalMinor: row.totalMinor.toString(),
        tenderKinds: [...new Set(row.tenders.map((tender) => tender.kind))],
        issuedAt: row.issuedAt.toISOString(),
      })),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  });
}

export async function readMerchantSale(
  prisma: PrismaClient,
  scope: TenantScope,
  saleId: string,
): Promise<MerchantSaleDetail | null> {
  const tenantId = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const row = await tx.sale.findFirst({
      where: { tenantId, id: saleId },
      include: {
        branch: { select: { id: true, code: true, nameAr: true } },
        terminal: { select: { id: true, code: true, label: true } },
        user: { select: { id: true, displayName: true, email: true } },
        customer: { select: { id: true, nameAr: true, phone: true, vatNumber: true } },
        lines: { orderBy: { lineNumber: 'asc' } },
        tenders: true,
        invoice: { include: { taxBreakdown: { orderBy: { vatBasisPoints: 'asc' } } } },
        returns: { orderBy: { issuedAt: 'desc' } },
      },
    });
    if (row === null) return null;

    return {
      id: row.id,
      operationId: row.operationId,
      invoiceNumber: row.invoice?.invoiceNumber ?? null,
      invoiceType: row.invoice?.invoiceType ?? null,
      status: row.status as MerchantSaleStatus,
      sequence: row.sequence,
      priceMode: row.priceMode,
      branch: row.branch,
      terminal: row.terminal,
      cashier: row.user,
      customer: row.customer,
      currency: row.currency,
      grossMinor: row.grossMinor.toString(),
      lineDiscountMinor: row.lineDiscountMinor.toString(),
      basketDiscountMinor: row.basketDiscountMinor.toString(),
      netMinor: row.netMinor.toString(),
      vatMinor: row.vatMinor.toString(),
      totalMinor: row.totalMinor.toString(),
      tenderedMinor: row.tenderedMinor.toString(),
      changeMinor: row.changeMinor.toString(),
      issuedAt: row.issuedAt.toISOString(),
      lines: row.lines.map((line) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        productId: line.productId,
        sku: line.sku,
        nameAr: line.nameAr,
        nameEn: line.nameEn,
        productType: line.productType,
        unitPriceMinor: line.unitPriceMinor.toString(),
        vatBasisPoints: line.vatBasisPoints,
        quantityScaled: line.quantityScaled.toString(),
        grossMinor: line.grossMinor.toString(),
        lineDiscountMinor: line.lineDiscountMinor.toString(),
        basketDiscountMinor: line.basketDiscountMinor.toString(),
        netMinor: line.netMinor.toString(),
        vatMinor: line.vatMinor.toString(),
        totalMinor: line.totalMinor.toString(),
      })),
      tenders: row.tenders.map((tender) => ({
        id: tender.id,
        kind: tender.kind,
        scheme: tender.scheme,
        amountMinor: tender.amountMinor.toString(),
        changeMinor: tender.changeMinor.toString(),
        reference: tender.reference,
      })),
      invoice:
        row.invoice === null
          ? null
          : {
              id: row.invoice.id,
              invoiceNumber: row.invoice.invoiceNumber,
              invoiceType: row.invoice.invoiceType,
              sellerName: row.invoice.sellerName,
              sellerVatNumber: row.invoice.sellerVatNumber,
              buyerName: row.invoice.buyerName,
              buyerVatNumber: row.invoice.buyerVatNumber,
              netMinor: row.invoice.netMinor.toString(),
              vatMinor: row.invoice.vatMinor.toString(),
              totalMinor: row.invoice.totalMinor.toString(),
              currency: row.invoice.currency,
              issuedAt: row.invoice.issuedAt.toISOString(),
              taxBreakdown: row.invoice.taxBreakdown.map((bucket) => ({
                vatBasisPoints: bucket.vatBasisPoints,
                netMinor: bucket.netMinor.toString(),
                vatMinor: bucket.vatMinor.toString(),
              })),
            },
      returns: row.returns.map((item) => ({
        id: item.id,
        returnNumber: item.returnNumber,
        status: item.status,
        reason: item.reason,
        totalMinor: item.totalMinor.toString(),
        vatMinor: item.vatMinor.toString(),
        issuedAt: item.issuedAt.toISOString(),
      })),
    };
  });
}
