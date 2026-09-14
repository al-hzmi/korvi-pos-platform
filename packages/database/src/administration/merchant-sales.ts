import { MerchantAdminRefusedError } from '../errors.js';
import { withTenant } from '../tenant-context.js';
import { iso, minor, tenantParam } from '../repositories/mapping.js';
import type { PrismaClient } from '../client.js';
import type { TenantScope } from '@korvi/domain';

export const MAX_MERCHANT_SALES_PAGE = 100;
const MAX_CURSOR_BYTES = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MerchantSalesQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly branchId?: string | undefined;
  readonly terminalId?: string | undefined;
  readonly cashierUserId?: string | undefined;
  readonly status?: 'finalized' | 'voided' | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface MerchantSaleTenderSummary {
  readonly kind: string;
  readonly scheme: string | null;
}

export interface MerchantSaleSummary {
  readonly id: string;
  readonly branchId: string;
  readonly branchNameAr: string;
  readonly terminalId: string;
  readonly terminalLabel: string;
  readonly cashierUserId: string;
  readonly cashierName: string;
  readonly customerId: string | null;
  readonly customerNameAr: string | null;
  readonly status: string;
  readonly sequence: number;
  readonly invoiceNumber: string | null;
  readonly currency: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly tenderedMinor: string;
  readonly changeMinor: string;
  readonly tenders: readonly MerchantSaleTenderSummary[];
  readonly issuedAt: string;
}

export interface MerchantSaleLine {
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
}

export interface MerchantSaleTender {
  readonly id: string;
  readonly kind: string;
  readonly scheme: string | null;
  readonly amountMinor: string;
  readonly changeMinor: string;
  readonly reference: string | null;
}

export interface MerchantSaleInvoice {
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

export interface MerchantSaleDetail extends MerchantSaleSummary {
  readonly shiftId: string;
  readonly operationId: string;
  readonly priceMode: string;
  readonly lines: readonly MerchantSaleLine[];
  readonly tenderDetails: readonly MerchantSaleTender[];
  readonly invoice: MerchantSaleInvoice | null;
  readonly returnCount: number;
}

export interface MerchantSalesPage {
  readonly items: readonly MerchantSaleSummary[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

interface CursorPayload {
  readonly issuedAt: string;
  readonly id: string;
}

function pageSize(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_MERCHANT_SALES_PAGE);
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): CursorPayload | null {
  if (cursor === undefined || cursor === '') return null;
  if (cursor.length > MAX_CURSOR_BYTES) throw new MerchantAdminRefusedError('invalid-cursor');

  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<CursorPayload>;
    if (
      typeof parsed.issuedAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.issuedAt)) ||
      typeof parsed.id !== 'string' ||
      !UUID_PATTERN.test(parsed.id) ||
      encodeCursor({ issuedAt: parsed.issuedAt, id: parsed.id }) !== cursor
    ) {
      throw new Error('invalid');
    }
    return { issuedAt: parsed.issuedAt, id: parsed.id };
  } catch {
    throw new MerchantAdminRefusedError('invalid-cursor');
  }
}

function parseDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

function mapSummary(row: {
  id: string;
  branchId: string;
  terminalId: string;
  userId: string;
  customerId: string | null;
  status: string;
  sequence: number;
  currency: string;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
  tenderedMinor: bigint;
  changeMinor: bigint;
  issuedAt: Date;
  branch: { nameAr: string };
  terminal: { label: string };
  user: { displayName: string };
  customer: { nameAr: string } | null;
  invoice: { invoiceNumber: string } | null;
  tenders: readonly { kind: string; scheme: string | null }[];
}): MerchantSaleSummary {
  return {
    id: row.id,
    branchId: row.branchId,
    branchNameAr: row.branch.nameAr,
    terminalId: row.terminalId,
    terminalLabel: row.terminal.label,
    cashierUserId: row.userId,
    cashierName: row.user.displayName,
    customerId: row.customerId,
    customerNameAr: row.customer?.nameAr ?? null,
    status: row.status,
    sequence: row.sequence,
    invoiceNumber: row.invoice?.invoiceNumber ?? null,
    currency: row.currency,
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
    tenderedMinor: minor(row.tenderedMinor),
    changeMinor: minor(row.changeMinor),
    tenders: row.tenders.map((tender) => ({ kind: tender.kind, scheme: tender.scheme })),
    issuedAt: iso(row.issuedAt),
  };
}

export async function listMerchantSales(
  prisma: PrismaClient,
  scope: TenantScope,
  query: MerchantSalesQuery,
): Promise<MerchantSalesPage> {
  const tenant = tenantParam(scope);
  const limit = pageSize(query.limit);
  const cursor = decodeCursor(query.cursor);
  const from = parseDate(query.from);
  const to = parseDate(query.to);

  return withTenant(prisma, tenant, async (tx) => {
    const rows = await tx.sale.findMany({
      where: {
        tenantId: tenant,
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.terminalId === undefined ? {} : { terminalId: query.terminalId }),
        ...(query.cashierUserId === undefined ? {} : { userId: query.cashierUserId }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(from === undefined && to === undefined
          ? {}
          : {
              issuedAt: {
                ...(from === undefined ? {} : { gte: from }),
                ...(to === undefined ? {} : { lte: to }),
              },
            }),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { issuedAt: { lt: new Date(cursor.issuedAt) } },
                { issuedAt: new Date(cursor.issuedAt), id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        branch: { select: { nameAr: true } },
        terminal: { select: { label: true } },
        user: { select: { displayName: true } },
        customer: { select: { nameAr: true } },
        invoice: { select: { invoiceNumber: true } },
        tenders: { select: { kind: true, scheme: true } },
      },
    });

    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const items = visible.map(mapSummary);
    const last = visible.at(-1);

    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ issuedAt: last.issuedAt.toISOString(), id: last.id })
          : null,
    };
  });
}

export async function readMerchantSale(
  prisma: PrismaClient,
  scope: TenantScope,
  saleId: string,
): Promise<MerchantSaleDetail | null> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, tenant, async (tx) => {
    const row = await tx.sale.findFirst({
      where: { tenantId: tenant, id: saleId },
      include: {
        branch: { select: { nameAr: true } },
        terminal: { select: { label: true } },
        user: { select: { displayName: true } },
        customer: { select: { nameAr: true } },
        lines: { orderBy: { lineNumber: 'asc' } },
        tenders: true,
        invoice: { include: { taxBreakdown: { orderBy: { vatBasisPoints: 'asc' } } } },
        returns: { select: { id: true } },
      },
    });
    if (row === null) return null;

    return {
      ...mapSummary(row),
      shiftId: row.shiftId,
      operationId: row.operationId,
      priceMode: row.priceMode,
      lines: row.lines.map((line) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        productId: line.productId,
        sku: line.sku,
        nameAr: line.nameAr,
        nameEn: line.nameEn,
        productType: line.productType,
        unitPriceMinor: minor(line.unitPriceMinor),
        vatBasisPoints: line.vatBasisPoints,
        quantityScaled: line.quantityScaled.toString(),
        grossMinor: minor(line.grossMinor),
        lineDiscountMinor: minor(line.lineDiscountMinor),
        basketDiscountMinor: minor(line.basketDiscountMinor),
        netMinor: minor(line.netMinor),
        vatMinor: minor(line.vatMinor),
        totalMinor: minor(line.totalMinor),
      })),
      tenderDetails: row.tenders.map((tender) => ({
        id: tender.id,
        kind: tender.kind,
        scheme: tender.scheme,
        amountMinor: minor(tender.amountMinor),
        changeMinor: minor(tender.changeMinor),
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
              netMinor: minor(row.invoice.netMinor),
              vatMinor: minor(row.invoice.vatMinor),
              totalMinor: minor(row.invoice.totalMinor),
              currency: row.invoice.currency,
              issuedAt: iso(row.invoice.issuedAt),
              taxBreakdown: row.invoice.taxBreakdown.map((tax) => ({
                vatBasisPoints: tax.vatBasisPoints,
                netMinor: minor(tax.netMinor),
                vatMinor: minor(tax.vatMinor),
              })),
            },
      returnCount: row.returns.length,
    };
  });
}
