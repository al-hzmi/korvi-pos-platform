import { withTenant } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';
import type { TenantScope } from '@korvi/domain';

export const MAX_REPORT_PERIOD_DAYS = 366;

export type MerchantReportRefusal =
  | 'invalid-period'
  | 'period-too-large'
  | 'unknown-branch'
  | 'tenant-settings-missing';

export class MerchantReportRefusedError extends Error {
  public override readonly name = 'MerchantReportRefusedError';

  public constructor(public readonly detail: MerchantReportRefusal) {
    super(detail);
  }
}

export interface MerchantReportQuery {
  /** Inclusive ISO-8601 instant. The caller chooses the civil-time boundary explicitly. */
  readonly fromInclusive: string;
  /** Exclusive ISO-8601 instant. */
  readonly toExclusive: string;
  readonly branchId?: string;
}

export interface MerchantReportTotals {
  /** Decimal integer string: counts never cross JSON as an unsafe number. */
  readonly documentCount: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface MerchantReportBranch {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
}

export interface MerchantReportBranchBreakdown extends MerchantReportBranch {
  readonly sales: MerchantReportTotals;
  readonly returns: MerchantReportTotals;
  readonly netAfterReturns: Omit<MerchantReportTotals, 'documentCount'>;
}

export interface MerchantReportVatBucket {
  readonly vatBasisPoints: number;
  readonly salesNetMinor: string;
  readonly salesVatMinor: string;
  readonly returnsNetMinor: string;
  readonly returnsVatMinor: string;
  readonly netTaxableMinor: string;
  readonly netVatMinor: string;
}

export interface MerchantPeriodReport {
  readonly fromInclusive: string;
  readonly toExclusive: string;
  readonly branchId: string | null;
  readonly currency: string;
  readonly sales: MerchantReportTotals;
  readonly returns: MerchantReportTotals;
  /** Sales less finalized returns issued inside the same requested period. */
  readonly netAfterReturns: Omit<MerchantReportTotals, 'documentCount'>;
  readonly vatBreakdown: readonly MerchantReportVatBucket[];
  /** Includes inactive branches so historical periods remain filterable. */
  readonly availableBranches: readonly MerchantReportBranch[];
  readonly branchBreakdown: readonly MerchantReportBranchBreakdown[];
}

interface AggregateRow {
  documentCount: bigint | string;
  netMinor: bigint | string;
  vatMinor: bigint | string;
  totalMinor: bigint | string;
}

interface TaxRow {
  vatBasisPoints: number;
  netMinor: bigint | string;
  vatMinor: bigint | string;
}

interface BranchAggregateRow extends AggregateRow {
  branchId: string;
}

const ZERO: MerchantReportTotals = {
  documentCount: '0',
  netMinor: '0',
  vatMinor: '0',
  totalMinor: '0',
};

function big(value: bigint | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function totals(row: AggregateRow | undefined): MerchantReportTotals {
  if (row === undefined) return ZERO;
  return {
    documentCount: big(row.documentCount).toString(),
    netMinor: big(row.netMinor).toString(),
    vatMinor: big(row.vatMinor).toString(),
    totalMinor: big(row.totalMinor).toString(),
  };
}

function subtract(
  sales: Pick<MerchantReportTotals, 'netMinor' | 'vatMinor' | 'totalMinor'>,
  returns: Pick<MerchantReportTotals, 'netMinor' | 'vatMinor' | 'totalMinor'>,
): Omit<MerchantReportTotals, 'documentCount'> {
  return {
    netMinor: (BigInt(sales.netMinor) - BigInt(returns.netMinor)).toString(),
    vatMinor: (BigInt(sales.vatMinor) - BigInt(returns.vatMinor)).toString(),
    totalMinor: (BigInt(sales.totalMinor) - BigInt(returns.totalMinor)).toString(),
  };
}

function validatedPeriod(query: MerchantReportQuery): { from: Date; to: Date } {
  const from = new Date(query.fromInclusive);
  const to = new Date(query.toExclusive);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
    throw new MerchantReportRefusedError('invalid-period');
  }
  if (to.getTime() - from.getTime() > MAX_REPORT_PERIOD_DAYS * 24 * 60 * 60 * 1000) {
    throw new MerchantReportRefusedError('period-too-large');
  }
  return { from, to };
}

/**
 * Read the merchant's financial snapshots exactly as they were committed.
 *
 * No catalogue price or current VAT rate participates in this report. Sales
 * and returns both snapshot net/VAT/total and the line VAT basis points when
 * the document is issued; a later product edit therefore cannot rewrite a
 * historical period. Finalized returns are reported as positive magnitudes
 * and subtracted only in the derived `netAfterReturns` fields here, using
 * bigint arithmetic exclusively.
 */
export async function readMerchantPeriodReport(
  prisma: PrismaClient,
  scope: TenantScope,
  query: MerchantReportQuery,
): Promise<MerchantPeriodReport> {
  const { from, to } = validatedPeriod(query);
  const tenant = scope.tenantId as string;
  const branchId = query.branchId ?? null;

  return withTenant(prisma, scope.tenantId, async (tx) => {
    if (branchId !== null) {
      const branch = await tx.branch.findFirst({
        where: { tenantId: tenant, id: branchId },
        select: { id: true },
      });
      if (branch === null) throw new MerchantReportRefusedError('unknown-branch');
    }

    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId: tenant },
      select: { currency: true },
    });
    if (settings === null) throw new MerchantReportRefusedError('tenant-settings-missing');

    const branches = await tx.branch.findMany({
      where: { tenantId: tenant },
      select: { id: true, code: true, nameAr: true, nameEn: true, isActive: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    });

    const [salesRows, returnRows, salesTaxRows, returnTaxRows, salesBranchRows, returnBranchRows] =
      await Promise.all([
        tx.$queryRaw<AggregateRow[]>`
          SELECT COUNT(*)::bigint AS "documentCount",
                 COALESCE(SUM(s."netMinor"), 0)::bigint AS "netMinor",
                 COALESCE(SUM(s."vatMinor"), 0)::bigint AS "vatMinor",
                 COALESCE(SUM(s."totalMinor"), 0)::bigint AS "totalMinor"
            FROM "sales" s
           WHERE s."tenantId" = ${tenant}::uuid
             AND s."status" = 'finalized'
             AND s."issuedAt" >= ${from}
             AND s."issuedAt" < ${to}
             AND (${branchId}::uuid IS NULL OR s."branchId" = ${branchId}::uuid)`,
        tx.$queryRaw<AggregateRow[]>`
          SELECT COUNT(*)::bigint AS "documentCount",
                 COALESCE(SUM(r."netMinor"), 0)::bigint AS "netMinor",
                 COALESCE(SUM(r."vatMinor"), 0)::bigint AS "vatMinor",
                 COALESCE(SUM(r."totalMinor"), 0)::bigint AS "totalMinor"
            FROM "returns" r
           WHERE r."tenantId" = ${tenant}::uuid
             AND r."status" = 'finalized'
             AND r."issuedAt" >= ${from}
             AND r."issuedAt" < ${to}
             AND (${branchId}::uuid IS NULL OR r."branchId" = ${branchId}::uuid)`,
        tx.$queryRaw<TaxRow[]>`
          SELECT sl."vatBasisPoints" AS "vatBasisPoints",
                 COALESCE(SUM(sl."netMinor"), 0)::bigint AS "netMinor",
                 COALESCE(SUM(sl."vatMinor"), 0)::bigint AS "vatMinor"
            FROM "sale_lines" sl
            JOIN "sales" s
              ON s."tenantId" = sl."tenantId" AND s."id" = sl."saleId"
           WHERE sl."tenantId" = ${tenant}::uuid
             AND s."status" = 'finalized'
             AND s."issuedAt" >= ${from}
             AND s."issuedAt" < ${to}
             AND (${branchId}::uuid IS NULL OR s."branchId" = ${branchId}::uuid)
           GROUP BY sl."vatBasisPoints"
           ORDER BY sl."vatBasisPoints" ASC`,
        tx.$queryRaw<TaxRow[]>`
          SELECT COALESCE(rl."vatBasisPoints", 0) AS "vatBasisPoints",
                 COALESCE(SUM(rl."netMinor"), 0)::bigint AS "netMinor",
                 COALESCE(SUM(rl."vatMinor"), 0)::bigint AS "vatMinor"
            FROM "return_lines" rl
            JOIN "returns" r
              ON r."tenantId" = rl."tenantId" AND r."id" = rl."returnId"
           WHERE rl."tenantId" = ${tenant}::uuid
             AND r."status" = 'finalized'
             AND r."issuedAt" >= ${from}
             AND r."issuedAt" < ${to}
             AND (${branchId}::uuid IS NULL OR r."branchId" = ${branchId}::uuid)
           GROUP BY COALESCE(rl."vatBasisPoints", 0)
           ORDER BY COALESCE(rl."vatBasisPoints", 0) ASC`,
        tx.$queryRaw<BranchAggregateRow[]>`
          SELECT s."branchId" AS "branchId",
                 COUNT(*)::bigint AS "documentCount",
                 COALESCE(SUM(s."netMinor"), 0)::bigint AS "netMinor",
                 COALESCE(SUM(s."vatMinor"), 0)::bigint AS "vatMinor",
                 COALESCE(SUM(s."totalMinor"), 0)::bigint AS "totalMinor"
            FROM "sales" s
           WHERE s."tenantId" = ${tenant}::uuid
             AND s."status" = 'finalized'
             AND s."issuedAt" >= ${from}
             AND s."issuedAt" < ${to}
             AND (${branchId}::uuid IS NULL OR s."branchId" = ${branchId}::uuid)
           GROUP BY s."branchId"`,
        tx.$queryRaw<BranchAggregateRow[]>`
          SELECT r."branchId" AS "branchId",
                 COUNT(*)::bigint AS "documentCount",
                 COALESCE(SUM(r."netMinor"), 0)::bigint AS "netMinor",
                 COALESCE(SUM(r."vatMinor"), 0)::bigint AS "vatMinor",
                 COALESCE(SUM(r."totalMinor"), 0)::bigint AS "totalMinor"
            FROM "returns" r
           WHERE r."tenantId" = ${tenant}::uuid
             AND r."status" = 'finalized'
             AND r."issuedAt" >= ${from}
             AND r."issuedAt" < ${to}
             AND (${branchId}::uuid IS NULL OR r."branchId" = ${branchId}::uuid)
           GROUP BY r."branchId"`,
      ]);

    const sales = totals(salesRows[0]);
    const returns = totals(returnRows[0]);

    const salesTax = new Map(
      salesTaxRows.map((row) => [
        row.vatBasisPoints,
        { net: big(row.netMinor), vat: big(row.vatMinor) },
      ]),
    );
    const returnsTax = new Map(
      returnTaxRows.map((row) => [
        row.vatBasisPoints,
        { net: big(row.netMinor), vat: big(row.vatMinor) },
      ]),
    );
    const rates = [...new Set([...salesTax.keys(), ...returnsTax.keys()])].sort((a, b) => a - b);

    const salesByBranch = new Map(salesBranchRows.map((row) => [row.branchId, totals(row)]));
    const returnsByBranch = new Map(returnBranchRows.map((row) => [row.branchId, totals(row)]));

    return {
      fromInclusive: from.toISOString(),
      toExclusive: to.toISOString(),
      branchId,
      currency: settings.currency,
      sales,
      returns,
      netAfterReturns: subtract(sales, returns),
      vatBreakdown: rates.map((vatBasisPoints) => {
        const sale = salesTax.get(vatBasisPoints) ?? { net: 0n, vat: 0n };
        const returned = returnsTax.get(vatBasisPoints) ?? { net: 0n, vat: 0n };
        return {
          vatBasisPoints,
          salesNetMinor: sale.net.toString(),
          salesVatMinor: sale.vat.toString(),
          returnsNetMinor: returned.net.toString(),
          returnsVatMinor: returned.vat.toString(),
          netTaxableMinor: (sale.net - returned.net).toString(),
          netVatMinor: (sale.vat - returned.vat).toString(),
        };
      }),
      availableBranches: branches,
      branchBreakdown: branches
        .filter((branch) => branchId === null || branch.id === branchId)
        .map((branch) => {
          const branchSales = salesByBranch.get(branch.id) ?? ZERO;
          const branchReturns = returnsByBranch.get(branch.id) ?? ZERO;
          return {
            ...branch,
            sales: branchSales,
            returns: branchReturns,
            netAfterReturns: subtract(branchSales, branchReturns),
          };
        }),
    };
  });
}
