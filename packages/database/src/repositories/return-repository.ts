import { ELECTRONIC_SCHEMES, allocateOriginalSaleReturnBasis } from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import {
  DatabaseError,
  OperationAlreadyRecordedError,
  ReturnNotAllowedError,
  ShiftUnusableError,
} from '../errors.js';
import { applyMovementWithin } from './inventory-repository.js';
import { iso, minor, oneOf, rate, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
import type {
  ProductType,
  RecordReturnInput,
  RefundKindRecord,
  RefundRecord,
  ReturnLineRecord,
  ReturnRecord,
  ReturnRepository,
  ReturnStatus,
  ReturnableSale,
  ReturnableSaleLine,
  SaleLookupQuery,
  SaleLookupRow,
  SaleStatus,
  TenantScope,
  TenderScheme,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * The return write path.
 *
 * One method does the whole commercial fact: the document, its lines, the
 * refund record, the stock that came back onto the shelf, the cash that left
 * the drawer, the number, and the idempotency reservation. Splitting them
 * across calls would let a crash leave a refund with no return, or stock
 * credited for goods nobody accepted.
 *
 * Two things make it safe under concurrency, and neither is an application
 * lock:
 *
 *   The sale row is taken FOR UPDATE first. Every return against a sale
 *   queues on that one row, so "how much is left on this line" is read by one
 *   transaction at a time. Two cashiers returning the last unit do not both
 *   see it available — the second reads the state the first committed.
 *
 *   The branch row is taken FOR UPDATE before a number is issued, exactly as
 *   the sale repository does for receipts, so a number is allocated once and
 *   only to a document that commits.
 *
 * Pricing is not done here. The caller passes a pure `plan` function; this
 * adapter reads the authoritative state under lock and hands it over. That is
 * what keeps arithmetic in the domain without moving authority out of the
 * transaction (ADR-0016).
 */

const RETURN_STATUSES: readonly ReturnStatus[] = ['finalized', 'voided'];
const SALE_STATUSES: readonly SaleStatus[] = ['finalized', 'voided'];
const PRODUCT_TYPES: readonly ProductType[] = ['unit', 'weighted'];
const REFUND_KINDS: readonly RefundKindRecord[] = [
  'cash',
  'electronic',
  'card',
  'mada',
  'transfer',
];
const REFUND_SCHEMES: readonly TenderScheme[] = [...ELECTRONIC_SCHEMES];

/** Bounded, because a lookup is a query a cashier runs while a queue waits. */
const MAX_LOOKUP_LIMIT = 25;

function productType(value: string | null): ProductType | null {
  return value === null ? null : oneOf(PRODUCT_TYPES, value, 'productType');
}

interface ReturnLineRow {
  id: string;
  lineNumber: number | null;
  saleLineId: string;
  productId: string | null;
  sku: string | null;
  nameAr: string | null;
  nameEn: string | null;
  productType: string | null;
  vatBasisPoints: number | null;
  quantityScaled: bigint;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
}

interface RefundRow {
  id: string;
  kind: string;
  scheme: string | null;
  amountMinor: bigint;
  reference: string | null;
  issuedAt: Date;
}

interface ReturnRow {
  id: string;
  tenantId: string;
  saleId: string;
  branchId: string;
  terminalId: string | null;
  shiftId: string | null;
  actorUserId: string;
  operationId: string;
  status: string;
  sequence: number | null;
  returnNumber: string | null;
  reason: string | null;
  currency: string;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
  issuedAt: Date;
  lines: ReturnLineRow[];
  refunds: RefundRow[];
}

function lineToDomain(row: ReturnLineRow): ReturnLineRecord {
  return {
    id: row.id,
    lineNumber: row.lineNumber ?? 0,
    saleLineId: row.saleLineId,
    productId: row.productId,
    sku: row.sku ?? '',
    nameAr: row.nameAr ?? '',
    nameEn: row.nameEn,
    productType: productType(row.productType),
    vatBasisPoints: rate(row.vatBasisPoints ?? 0),
    quantityScaled: minor(row.quantityScaled),
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
  };
}

function refundToDomain(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    kind: oneOf(REFUND_KINDS, row.kind, 'refunds.kind'),
    scheme: row.scheme === null ? null : oneOf(REFUND_SCHEMES, row.scheme, 'refunds.scheme'),
    amountMinor: minor(row.amountMinor),
    reference: row.reference,
    issuedAt: iso(row.issuedAt),
  };
}

function returnToDomain(scope: TenantScope, row: ReturnRow): ReturnRecord {
  if (row.terminalId === null || row.shiftId === null) {
    throw new DatabaseError('A return without a terminal or a shift cannot be attributed.');
  }
  if (row.sequence === null || row.returnNumber === null) {
    throw new DatabaseError('A return without a number is not a document.');
  }
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    saleId: row.saleId,
    branchId: row.branchId,
    terminalId: row.terminalId,
    shiftId: row.shiftId,
    actorUserId: row.actorUserId,
    operationId: row.operationId,
    status: oneOf(RETURN_STATUSES, row.status, 'returns.status'),
    sequence: row.sequence,
    returnNumber: row.returnNumber,
    reason: row.reason,
    currency: row.currency,
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
    issuedAt: iso(row.issuedAt),
    lines: row.lines.map(lineToDomain),
    refund: row.refunds.length === 0 ? null : refundToDomain(row.refunds[0] as RefundRow),
  };
}

const WITH_CHILDREN = {
  lines: { orderBy: { lineNumber: 'asc' } },
  refunds: true,
} as const;

async function loadReturn(
  tx: TransactionClient,
  tenant: string,
  where: { id: string } | { operationId: string },
): Promise<ReturnRow | null> {
  return tx.return.findFirst({ where: { ...where, tenantId: tenant }, include: WITH_CHILDREN });
}

interface SaleHeadRow {
  id: string;
  branchId: string;
  status: string;
  currency: string;
  issuedAt: Date;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
}

interface SaleLineRow {
  id: string;
  lineNumber: number;
  productId: string | null;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  productType: string | null;
  vatBasisPoints: number;
  unitPriceMinor: bigint;
  quantityScaled: bigint;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
  costKnownQuantityScaled: bigint;
  costUnknownQuantityScaled: bigint;
  costValueMinor: bigint;
  costProvenance: string;
}

interface ReturnedAggregateRow {
  saleLineId: string;
  quantityScaled: bigint | null;
  grossMinor: bigint | null;
  netMinor: bigint | null;
  lineDiscountMinor: bigint | null;
  basketDiscountMinor: bigint | null;
  vatMinor: bigint | null;
  totalMinor: bigint | null;
}

/**
 * PostgreSQL widens SUM(bigint) to `numeric`, which the driver hands back as a
 * string. Casting in SQL keeps the value a bigint all the way through; this is
 * the belt to that braces, so no arithmetic here can silently become a float.
 */
function big(value: bigint | string | null): bigint {
  if (value === null) return 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

function returnCostProvenance(
  original: string,
  knownQuantityScaled: bigint,
  unknownQuantityScaled: bigint,
): 'historical-unknown' | 'unknown' | 'recorded' | 'mixed' {
  if (
    original !== 'historical-unknown' &&
    original !== 'unknown' &&
    original !== 'recorded' &&
    original !== 'mixed'
  ) {
    throw new DatabaseError('The original sale line carries an invalid cost provenance.');
  }
  if (knownQuantityScaled === 0n) {
    return original === 'historical-unknown' ? 'historical-unknown' : 'unknown';
  }
  if (unknownQuantityScaled === 0n) return 'recorded';
  return 'mixed';
}

/**
 * What has already come back, per line, from finalized returns only.
 *
 * One grouped query rather than one per line: a basket of forty items would
 * otherwise be forty round trips inside a transaction holding the sale's lock.
 */
async function returnedSoFar(
  tx: TransactionClient,
  tenant: string,
  saleId: string,
): Promise<Map<string, ReturnedAggregateRow>> {
  const rows = await tx.$queryRaw<ReturnedAggregateRow[]>`
    SELECT rl."saleLineId"                            AS "saleLineId",
           SUM(rl."quantityScaled")::bigint           AS "quantityScaled",
           SUM(rl."grossMinor")::bigint               AS "grossMinor",
           SUM(rl."netMinor")::bigint                 AS "netMinor",
           SUM(rl."lineDiscountMinor")::bigint        AS "lineDiscountMinor",
           SUM(rl."basketDiscountMinor")::bigint      AS "basketDiscountMinor",
           SUM(rl."vatMinor")::bigint                 AS "vatMinor",
           SUM(rl."totalMinor")::bigint               AS "totalMinor"
      FROM "return_lines" rl
      JOIN "returns" r
        ON r."tenantId" = rl."tenantId" AND r."id" = rl."returnId"
     WHERE rl."tenantId" = ${tenant}::uuid
       AND r."saleId" = ${saleId}::uuid
       AND r."status" = 'finalized'
     GROUP BY rl."saleLineId"`;
  return new Map(rows.map((row) => [row.saleLineId, row]));
}

function stateFrom(
  sale: SaleHeadRow,
  lines: readonly SaleLineRow[],
  returned: Map<string, ReturnedAggregateRow>,
  invoiceNumber: string | null,
): ReturnableSale {
  let refundedTotal = 0n;
  const mapped: ReturnableSaleLine[] = lines.map((line) => {
    const prior = returned.get(line.id);
    const returnedQuantity = big(prior?.quantityScaled ?? null);
    refundedTotal += big(prior?.totalMinor ?? null);
    const remaining = line.quantityScaled - returnedQuantity;
    return {
      saleLineId: line.id,
      lineNumber: line.lineNumber,
      productId: line.productId,
      sku: line.sku,
      nameAr: line.nameAr,
      nameEn: line.nameEn,
      productType: productType(line.productType),
      vatBasisPoints: rate(line.vatBasisPoints),
      unitPriceMinor: minor(line.unitPriceMinor),
      soldQuantityScaled: minor(line.quantityScaled),
      returnedQuantityScaled: minor(returnedQuantity),
      remainingQuantityScaled: minor(remaining > 0n ? remaining : 0n),
      grossMinor: minor(line.grossMinor),
      lineDiscountMinor: minor(line.lineDiscountMinor),
      basketDiscountMinor: minor(line.basketDiscountMinor),
      netMinor: minor(line.netMinor),
      vatMinor: minor(line.vatMinor),
      totalMinor: minor(line.totalMinor),
      refundedGrossMinor: minor(big(prior?.grossMinor ?? null)),
      refundedNetMinor: minor(big(prior?.netMinor ?? null)),
      refundedLineDiscountMinor: minor(big(prior?.lineDiscountMinor ?? null)),
      refundedBasketDiscountMinor: minor(big(prior?.basketDiscountMinor ?? null)),
      refundedVatMinor: minor(big(prior?.vatMinor ?? null)),
    };
  });

  return {
    saleId: sale.id,
    branchId: sale.branchId,
    status: oneOf(SALE_STATUSES, sale.status, 'sales.status'),
    invoiceNumber,
    currency: sale.currency,
    issuedAt: iso(sale.issuedAt),
    netMinor: minor(sale.netMinor),
    vatMinor: minor(sale.vatMinor),
    totalMinor: minor(sale.totalMinor),
    refundedTotalMinor: minor(refundedTotal),
    lines: mapped,
  };
}

/**
 * Prove the shift is open, on this till, in this branch, and the operator's
 * own — while holding its row.
 *
 * The same rule the sale path enforces, for the same reason: a refund posted
 * into somebody else's drawer makes their variance unanswerable at close, and
 * a preflight read can be overtaken by a close.
 */
async function assertShiftUsable(
  tx: TransactionClient,
  tenant: string,
  claim: { shiftId: string; terminalId: string; branchId: string; userId: string },
): Promise<void> {
  const rows = await tx.$queryRaw<
    { status: string; terminalId: string; branchId: string; userId: string }[]
  >`
    SELECT "status", "terminalId", "branchId", "userId" FROM "shifts"
     WHERE "id" = ${claim.shiftId}::uuid AND "tenantId" = ${tenant}::uuid
     FOR UPDATE`;

  const shift = rows.at(0);
  if (shift === undefined) throw new ShiftUnusableError('unknown-shift');
  if (shift.status !== 'open') throw new ShiftUnusableError('shift-closed');
  if (shift.terminalId !== claim.terminalId) throw new ShiftUnusableError('terminal-mismatch');
  if (shift.branchId !== claim.branchId) throw new ShiftUnusableError('branch-mismatch');
  if (shift.userId !== claim.userId) throw new ShiftUnusableError('cashier-mismatch');
}

/**
 * Allocate the branch's next return number, inside the caller's transaction.
 *
 * Its own series, separate from receipts: a return is not a sale and a
 * merchant counting invoices should not find returns interleaved. The
 * serialization is the branch row's lock, exactly as for a receipt — two tills
 * returning at once both want MAX(sequence) + 1, and under READ COMMITTED they
 * would read the same number.
 */
async function allocateReturnNumber(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
): Promise<{ sequence: number; returnNumber: string }> {
  const branches = await tx.$queryRaw<{ code: string }[]>`
    SELECT "code" FROM "branches"
     WHERE "id" = ${branchId}::uuid AND "tenantId" = ${tenant}::uuid
     FOR UPDATE`;
  const branch = branches.at(0);
  if (branch === undefined) {
    throw new DatabaseError('No such branch in this tenant; refusing to number a return for it.');
  }

  const next = await tx.$queryRaw<{ sequence: number }[]>`
    SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "returns"
     WHERE "tenantId" = ${tenant}::uuid AND "branchId" = ${branchId}::uuid`;
  const sequence = Number(next.at(0)?.sequence ?? 1);

  // `R-` first, so no reader ever mistakes a credit for an invoice.
  return { sequence, returnNumber: `R-${branch.code}-${String(sequence).padStart(6, '0')}` };
}

async function reserveOperation(
  tx: TransactionClient,
  tenant: string,
  reservation: { id: string; scope: string; operationId: string; requestHash: string | null },
  resultId: string,
  completedAt: Date,
): Promise<void> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "idempotency_keys"
      ("id","tenantId","scope","operationId","status","resultType","resultId","requestHash","completedAt")
    VALUES (${reservation.id}::uuid, ${tenant}::uuid, ${reservation.scope}, ${reservation.operationId},
            'completed', 'return', ${resultId}::uuid, ${reservation.requestHash}, ${completedAt})
    ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
    RETURNING "id"`;
  if (inserted.length === 0) throw new OperationAlreadyRecordedError(reservation.operationId);
}

export function createReturnRepository(prisma: PrismaClient): ReturnRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<ReturnRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadReturn(tx, tenantParam(scope), { id });
        return row === null ? null : returnToDomain(scope, row);
      });
    },

    async findByOperationId(scope: TenantScope, operationId: string): Promise<ReturnRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadReturn(tx, tenantParam(scope), { operationId });
        return row === null ? null : returnToDomain(scope, row);
      });
    },

    async returnableForSale(
      scope: TenantScope,
      branchId: string,
      saleId: string,
    ): Promise<ReturnableSale | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const sale = await tx.sale.findFirst({
          where: { id: saleId, tenantId: tenant, branchId },
          select: {
            id: true,
            branchId: true,
            status: true,
            currency: true,
            issuedAt: true,
            netMinor: true,
            vatMinor: true,
            totalMinor: true,
          },
        });
        // A sale in another branch is answered exactly as a sale that does not
        // exist. The caller learns nothing about the rest of the tenant.
        if (sale === null) return null;

        const lines = await tx.saleLine.findMany({
          where: { tenantId: tenant, saleId },
          orderBy: { lineNumber: 'asc' },
        });
        const invoice = await tx.invoice.findFirst({
          where: { tenantId: tenant, saleId },
          select: { invoiceNumber: true },
        });
        const returned = await returnedSoFar(tx, tenant, saleId);
        return stateFrom(sale, lines, returned, invoice?.invoiceNumber ?? null);
      });
    },

    async lookupSales(
      scope: TenantScope,
      query: SaleLookupQuery,
    ): Promise<readonly SaleLookupRow[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const term = query.term.trim();
        if (term === '') return [];
        const limit = Math.min(Math.max(query.limit, 1), MAX_LOOKUP_LIMIT);

        // Three ways a cashier can name a sale, all indexed and all bounded:
        // the invoice number printed on the receipt, the branch sequence, and
        // the sale's own id when a system quotes one. The branch comes from the
        // session, so no query can widen past it.
        const sequence = /^[0-9]{1,9}$/.test(term) ? Number(term) : -1;
        const isUuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(term);

        const rows = await tx.$queryRaw<
          {
            id: string;
            sequence: number;
            issuedAt: Date;
            currency: string;
            totalMinor: bigint;
            invoiceNumber: string | null;
            refundedTotalMinor: bigint | string | null;
          }[]
        >`
          SELECT s."id"            AS "id",
                 s."sequence"      AS "sequence",
                 s."issuedAt"      AS "issuedAt",
                 s."currency"      AS "currency",
                 s."totalMinor"    AS "totalMinor",
                 i."invoiceNumber" AS "invoiceNumber",
                 (SELECT COALESCE(SUM(r."totalMinor"), 0)::bigint FROM "returns" r
                   WHERE r."tenantId" = s."tenantId" AND r."saleId" = s."id"
                     AND r."status" = 'finalized') AS "refundedTotalMinor"
            FROM "sales" s
            LEFT JOIN "invoices" i
              ON i."tenantId" = s."tenantId" AND i."saleId" = s."id"
           WHERE s."tenantId" = ${tenant}::uuid
             AND s."branchId" = ${query.branchId}::uuid
             AND s."status" = 'finalized'
             AND (
                   i."invoiceNumber" = ${term}
                   OR s."sequence" = ${sequence}
                   OR (${isUuid} AND s."id"::text = ${term})
                 )
           ORDER BY s."issuedAt" DESC
           LIMIT ${limit}`;

        return rows.map((row) => ({
          saleId: row.id,
          invoiceNumber: row.invoiceNumber,
          sequence: row.sequence,
          issuedAt: iso(row.issuedAt),
          currency: row.currency,
          totalMinor: minor(row.totalMinor),
          refundedTotalMinor: minor(big(row.refundedTotalMinor)),
          fullyReturned: big(row.refundedTotalMinor) >= big(row.totalMinor),
        }));
      });
    },

    async record(scope: TenantScope, input: RecordReturnInput): Promise<ReturnRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);

        /*
         * The serialization boundary.
         *
         * Every return against this sale queues here, so "what is left on this
         * line" is read by one transaction at a time. Without it, two cashiers
         * returning the last unit both read one remaining and both write a
         * return — and no CHECK constraint can catch that, because each row is
         * individually lawful.
         */
        const heads = await tx.$queryRaw<SaleHeadRow[]>`
          SELECT "id", "branchId", "status", "currency", "issuedAt",
                 "netMinor", "vatMinor", "totalMinor"
            FROM "sales"
           WHERE "id" = ${input.saleId}::uuid AND "tenantId" = ${tenant}::uuid
           FOR UPDATE`;
        const sale = heads.at(0);
        if (sale === undefined) throw new ReturnNotAllowedError('unknown-sale');
        // Branch is the session's, never the request's. A sale in another
        // branch is refused with the answer a missing sale gets.
        if (sale.branchId !== input.branchId) throw new ReturnNotAllowedError('unknown-sale');
        if (sale.status !== 'finalized') throw new ReturnNotAllowedError('sale-not-finalized');

        /*
         * The lines, in id order.
         *
         * The sale row above is what makes over-return impossible; these locks
         * are for deadlock hygiene. A deterministic order means two
         * transactions touching overlapping line sets acquire them in the same
         * sequence and one waits, rather than each holding what the other
         * needs.
         */
        const wanted = [...new Set(input.requested.map((line) => line.saleLineId))].sort();
        if (wanted.length > 0) {
          await tx.$queryRaw`
            SELECT "id" FROM "sale_lines"
             WHERE "tenantId" = ${tenant}::uuid
               AND "saleId" = ${input.saleId}::uuid
               AND "id" = ANY(${wanted}::uuid[])
             ORDER BY "id"
             FOR UPDATE`;
        }

        const lines = await tx.saleLine.findMany({
          where: { tenantId: tenant, saleId: input.saleId },
          orderBy: { lineNumber: 'asc' },
        });
        const invoice = await tx.invoice.findFirst({
          where: { tenantId: tenant, saleId: input.saleId },
          select: { invoiceNumber: true },
        });
        const returned = await returnedSoFar(tx, tenant, input.saleId);

        // Pure, and inside the lock. Its refusals roll everything back.
        const plan = input.plan(stateFrom(sale, lines, returned, invoice?.invoiceNumber ?? null));

        // A return never consults today's moving average. The original sale
        // line froze the exact basis that left inventory, and the sale-row lock
        // above serializes every return so cumulative prefix allocation cannot
        // race another partial return of the same line.
        const originalById = new Map(lines.map((line) => [line.id, line] as const));
        const preparedReturnLines = plan.lines.map((line, index) => {
          const id = input.lineIds[index];
          if (id === undefined) {
            throw new DatabaseError('A return line was planned without an id to write it under.');
          }
          const original = originalById.get(line.saleLineId);
          if (original === undefined) {
            throw new DatabaseError('A return line has no original sale line under the sale lock.');
          }
          if (line.productId !== original.productId) {
            throw new DatabaseError('A return plan changed the product identity of its sale line.');
          }
          if (
            original.costKnownQuantityScaled < 0n ||
            original.costUnknownQuantityScaled < 0n ||
            original.costValueMinor < 0n ||
            original.costKnownQuantityScaled + original.costUnknownQuantityScaled !==
              original.quantityScaled ||
            (original.costKnownQuantityScaled === 0n && original.costValueMinor !== 0n)
          ) {
            throw new DatabaseError(
              'The original sale line carries an invalid immutable cost basis.',
            );
          }

          const previousQuantity = big(returned.get(line.saleLineId)?.quantityScaled ?? null);
          const allocation = allocateOriginalSaleReturnBasis(
            {
              knownQuantityScaled: original.costKnownQuantityScaled,
              unknownQuantityScaled: original.costUnknownQuantityScaled,
              knownValueMinor: original.costValueMinor,
            },
            previousQuantity,
            BigInt(line.quantityScaled),
          );
          const cost = {
            knownQuantityScaled: allocation.knownQuantityScaled,
            unknownQuantityScaled: allocation.unknownQuantityScaled,
            knownValueMinor: allocation.knownValueMinor,
            provenance: returnCostProvenance(
              original.costProvenance,
              allocation.knownQuantityScaled,
              allocation.unknownQuantityScaled,
            ),
          };
          return { id, line, cost };
        });

        const number = await allocateReturnNumber(tx, tenant, input.branchId);

        await assertShiftUsable(tx, tenant, {
          shiftId: input.shiftId,
          terminalId: input.terminalId,
          branchId: input.branchId,
          userId: input.actorUserId,
        });

        const issuedAt = new Date(input.issuedAt);
        await reserveOperation(tx, tenant, input.idempotency, input.returnId, issuedAt);

        await tx.return.create({
          data: {
            id: input.returnId,
            tenantId: tenant,
            saleId: input.saleId,
            branchId: input.branchId,
            terminalId: input.terminalId,
            shiftId: input.shiftId,
            actorUserId: input.actorUserId,
            operationId: input.operationId,
            status: 'finalized',
            sequence: number.sequence,
            returnNumber: number.returnNumber,
            reason: input.reason,
            currency: input.currency,
            grossMinor: BigInt(plan.grossMinor),
            lineDiscountMinor: BigInt(plan.lineDiscountMinor),
            basketDiscountMinor: BigInt(plan.basketDiscountMinor),
            netMinor: BigInt(plan.netMinor),
            vatMinor: BigInt(plan.vatMinor),
            totalMinor: BigInt(plan.totalMinor),
            issuedAt,
          },
        });

        await tx.returnLine.createMany({
          data: preparedReturnLines.map(({ id, line, cost }) => ({
            id,
            tenantId: tenant,
            returnId: input.returnId,
            saleLineId: line.saleLineId,
            lineNumber: line.lineNumber,
            productId: line.productId,
            sku: line.sku,
            nameAr: line.nameAr,
            nameEn: line.nameEn,
            productType: line.productType,
            vatBasisPoints: Number(line.vatBasisPoints),
            quantityScaled: BigInt(line.quantityScaled),
            grossMinor: BigInt(line.grossMinor),
            lineDiscountMinor: BigInt(line.lineDiscountMinor),
            basketDiscountMinor: BigInt(line.basketDiscountMinor),
            netMinor: BigInt(line.netMinor),
            vatMinor: BigInt(line.vatMinor),
            totalMinor: BigInt(line.totalMinor),
            costKnownQuantityScaled: cost.knownQuantityScaled,
            costUnknownQuantityScaled: cost.unknownQuantityScaled,
            costValueMinor: cost.knownValueMinor,
            costProvenance: cost.provenance,
          })),
        });

        /*
         * Stock comes back only where it went out.
         *
         * The authority is the original sale's own movements, not
         * `products.trackInventory` as it stands today. A merchant who turned
         * tracking on last week must not have last month's returns credit
         * stock that was never decremented — the balance would drift upward by
         * exactly the returns, with nothing to point at.
         */
        const sold = await tx.$queryRaw<{ productId: string }[]>`
          SELECT DISTINCT "productId" FROM "inventory_movements"
           WHERE "tenantId" = ${tenant}::uuid
             AND "sourceType" = 'sale'
             AND "sourceId" = ${input.saleId}::uuid`;
        const consumed = new Set(sold.map((row) => row.productId));

        let movement = 0;
        for (const preparedLine of preparedReturnLines) {
          const { id: returnLineId, line, cost } = preparedLine;
          if (line.productId === null || !consumed.has(line.productId)) continue;
          const id = input.inventoryIds[movement];
          movement += 1;
          if (id === undefined) {
            throw new DatabaseError(
              'A stock reversal was planned without an id to write it under.',
            );
          }
          await applyMovementWithin(
            tx,
            tenant,
            {
              id,
              branchId: input.branchId,
              productId: line.productId,
              kind: 'return',
              // Positive: the goods are back on the shelf.
              quantityScaled: line.quantityScaled,
              reason: null,
              sourceType: 'return',
              sourceId: input.returnId,
              actorUserId: input.actorUserId,
              occurredAt: input.issuedAt,
            },
            true,
            returnLineId,
            {
              knownQuantityScaled: cost.knownQuantityScaled,
              unknownQuantityScaled: cost.unknownQuantityScaled,
              knownValueMinor: cost.knownValueMinor,
            },
          );
        }

        await tx.refund.create({
          data: {
            id: input.refund.id,
            tenantId: tenant,
            returnId: input.returnId,
            invoiceId: null,
            kind: input.refund.kind,
            scheme: input.refund.scheme,
            // Server-derived, always. The client never says what a refund is
            // worth; the lines it asked for decide.
            amountMinor: BigInt(plan.totalMinor),
            reference: input.refund.reference,
            issuedAt,
          },
        });

        /*
         * Cash out of the drawer, and only cash.
         *
         * Negative, because the drawer holds less afterwards. An electronic
         * refund writes nothing here: the money goes back through somebody
         * else's system and the till never held it.
         *
         * No balance check. Expected cash is accounting state, not a count of
         * the notes in the drawer, and refusing a lawful refund because a
         * running total looks low would be Korvi inventing a policy the
         * merchant never asked for.
         */
        if (input.refund.kind === 'cash') {
          await tx.cashMovement.create({
            data: {
              id: input.cashMovementId,
              tenantId: tenant,
              shiftId: input.shiftId,
              kind: 'refund',
              amountMinor: -BigInt(plan.totalMinor),
              reason: null,
              actorUserId: input.actorUserId,
              occurredAt: issuedAt,
            },
          });
        }

        const row = await loadReturn(tx, tenant, { id: input.returnId });
        if (row === null) {
          throw new DatabaseError('The return just written could not be read back.');
        }
        return returnToDomain(scope, row);
      });
    },
  };
}
