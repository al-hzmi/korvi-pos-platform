import { withTenant } from '../tenant-context.js';
import { DatabaseError } from '../errors.js';
import { applyMovementWithin } from './inventory-repository.js';
import { iso, minor, oneOf, rate, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
import type {
  InvoiceRecord,
  InvoiceType,
  PriceMode,
  RecordSaleInput,
  SaleDiscountRecord,
  SaleLineRecord,
  SaleRecord,
  SaleRepository,
  SaleStatus,
  TenantScope,
  TenderKind,
  TenderRecord,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const STATUSES: readonly SaleStatus[] = ['finalized', 'voided'];
const PRICE_MODES: readonly PriceMode[] = ['tax-inclusive', 'tax-exclusive'];
const TENDER_KINDS: readonly TenderKind[] = ['cash', 'card', 'mada', 'transfer'];
const INVOICE_TYPES: readonly InvoiceType[] = ['simplified', 'standard'];
const DISCOUNT_SCOPES = ['line', 'basket'] as const;
const DISCOUNT_KINDS = ['fixed', 'percentage'] as const;

interface LineRow {
  id: string;
  lineNumber: number;
  productId: string | null;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  unitPriceMinor: bigint;
  vatBasisPoints: number;
  quantityScaled: bigint;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
}

interface DiscountRow {
  id: string;
  scope: string;
  lineNumber: number | null;
  kind: string;
  inputValue: bigint;
  amountMinor: bigint;
  reason: string | null;
  grantedByUserId: string | null;
}

interface TenderRow {
  id: string;
  kind: string;
  amountMinor: bigint;
  changeMinor: bigint;
  reference: string | null;
}

interface SaleRow {
  id: string;
  tenantId: string;
  branchId: string;
  terminalId: string;
  shiftId: string;
  userId: string;
  customerId: string | null;
  operationId: string;
  status: string;
  sequence: number;
  priceMode: string;
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
  lines: LineRow[];
  discounts: DiscountRow[];
  tenders: TenderRow[];
}

interface BucketRow {
  vatBasisPoints: number;
  netMinor: bigint;
  vatMinor: bigint;
}

interface InvoiceRow {
  id: string;
  tenantId: string;
  saleId: string;
  invoiceNumber: string;
  invoiceType: string;
  sellerName: string;
  sellerVatNumber: string;
  buyerName: string | null;
  buyerVatNumber: string | null;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
  currency: string;
  issuedAt: Date;
  taxBreakdown: BucketRow[];
}

function lineToDomain(row: LineRow): SaleLineRecord {
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    productId: row.productId,
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    unitPriceMinor: minor(row.unitPriceMinor),
    vatBasisPoints: rate(row.vatBasisPoints),
    quantityScaled: minor(row.quantityScaled),
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
  };
}

function discountToDomain(row: DiscountRow): SaleDiscountRecord {
  return {
    id: row.id,
    scope: oneOf(DISCOUNT_SCOPES, row.scope, 'sale_discounts.scope'),
    lineNumber: row.lineNumber,
    kind: oneOf(DISCOUNT_KINDS, row.kind, 'sale_discounts.kind'),
    inputValue: minor(row.inputValue),
    amountMinor: minor(row.amountMinor),
    reason: row.reason,
    grantedByUserId: row.grantedByUserId,
  };
}

function tenderToDomain(row: TenderRow): TenderRecord {
  return {
    id: row.id,
    kind: oneOf(TENDER_KINDS, row.kind, 'tenders.kind'),
    amountMinor: minor(row.amountMinor),
    changeMinor: minor(row.changeMinor),
    reference: row.reference,
  };
}

function saleToDomain(scope: TenantScope, row: SaleRow): SaleRecord {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    terminalId: row.terminalId,
    shiftId: row.shiftId,
    userId: row.userId,
    customerId: row.customerId,
    operationId: row.operationId,
    status: oneOf(STATUSES, row.status, 'sales.status'),
    sequence: row.sequence,
    priceMode: oneOf(PRICE_MODES, row.priceMode, 'sales.priceMode'),
    currency: row.currency,
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
    tenderedMinor: minor(row.tenderedMinor),
    changeMinor: minor(row.changeMinor),
    issuedAt: iso(row.issuedAt),
    lines: row.lines.map(lineToDomain),
    discounts: row.discounts.map(discountToDomain),
    tenders: row.tenders.map(tenderToDomain),
  };
}

function invoiceToDomain(scope: TenantScope, row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    saleId: row.saleId,
    invoiceNumber: row.invoiceNumber,
    invoiceType: oneOf(INVOICE_TYPES, row.invoiceType, 'invoices.invoiceType'),
    sellerName: row.sellerName,
    sellerVatNumber: row.sellerVatNumber,
    buyerName: row.buyerName,
    buyerVatNumber: row.buyerVatNumber,
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
    currency: row.currency,
    issuedAt: iso(row.issuedAt),
    taxBreakdown: row.taxBreakdown.map((bucket) => ({
      vatBasisPoints: rate(bucket.vatBasisPoints),
      netMinor: minor(bucket.netMinor),
      vatMinor: minor(bucket.vatMinor),
    })),
  };
}

const WITH_CHILDREN = {
  lines: { orderBy: { lineNumber: 'asc' } },
  discounts: true,
  tenders: true,
} as const;

async function loadSale(
  tx: TransactionClient,
  tenant: string,
  where: { id: string } | { operationId: string },
): Promise<SaleRow | null> {
  return tx.sale.findFirst({ where: { ...where, tenantId: tenant }, include: WITH_CHILDREN });
}

/**
 * The sale write path.
 *
 * `record` takes the whole checkout as one value and commits it in one
 * transaction: the sale, its lines and tenders, the tax document, the stock it
 * consumed, the cash it put in the drawer, and the idempotency reservation.
 * Splitting those across calls would let a crash leave an invoice with no
 * sale, or stock decremented for a sale that never existed.
 *
 * Replay safety comes from the database, not from a check-then-write. The
 * unique index on (tenantId, scope, operationId) means a second attempt at the
 * same checkout fails at insert rather than ringing up a second sale, and the
 * caller answers the retry from `findByOperationId`. A pre-flight "does it
 * exist?" query would still race between the read and the write.
 */
export function createSaleRepository(prisma: PrismaClient): SaleRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<SaleRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadSale(tx, tenantParam(scope), { id });
        return row === null ? null : saleToDomain(scope, row);
      });
    },

    async findByOperationId(scope: TenantScope, operationId: string): Promise<SaleRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadSale(tx, tenantParam(scope), { operationId });
        return row === null ? null : saleToDomain(scope, row);
      });
    },

    async invoiceForSale(scope: TenantScope, saleId: string): Promise<InvoiceRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.invoice.findFirst({
          where: { saleId, tenantId: tenantParam(scope) },
          include: { taxBreakdown: { orderBy: { vatBasisPoints: 'asc' } } },
        });
        return row === null ? null : invoiceToDomain(scope, row);
      });
    },

    async record(scope: TenantScope, input: RecordSaleInput): Promise<SaleRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const { sale, invoice, inventory, cashMovement, idempotency } = input;

        await tx.idempotencyKey.create({
          data: {
            id: idempotency.id,
            tenantId: tenant,
            scope: idempotency.scope,
            operationId: idempotency.operationId,
            status: 'completed',
            resultType: 'sale',
            resultId: sale.id,
            requestHash: idempotency.requestHash,
            completedAt: new Date(sale.issuedAt),
          },
        });

        await tx.sale.create({
          data: {
            id: sale.id,
            tenantId: tenant,
            branchId: sale.branchId,
            terminalId: sale.terminalId,
            shiftId: sale.shiftId,
            userId: sale.userId,
            customerId: sale.customerId,
            operationId: sale.operationId,
            status: sale.status,
            sequence: sale.sequence,
            priceMode: sale.priceMode,
            currency: sale.currency,
            grossMinor: BigInt(sale.grossMinor),
            lineDiscountMinor: BigInt(sale.lineDiscountMinor),
            basketDiscountMinor: BigInt(sale.basketDiscountMinor),
            netMinor: BigInt(sale.netMinor),
            vatMinor: BigInt(sale.vatMinor),
            totalMinor: BigInt(sale.totalMinor),
            tenderedMinor: BigInt(sale.tenderedMinor),
            changeMinor: BigInt(sale.changeMinor),
            issuedAt: new Date(sale.issuedAt),
          },
        });

        await tx.saleLine.createMany({
          data: sale.lines.map((line) => ({
            id: line.id,
            tenantId: tenant,
            saleId: sale.id,
            productId: line.productId,
            lineNumber: line.lineNumber,
            sku: line.sku,
            nameAr: line.nameAr,
            nameEn: line.nameEn,
            unitPriceMinor: BigInt(line.unitPriceMinor),
            vatBasisPoints: Number(line.vatBasisPoints),
            quantityScaled: BigInt(line.quantityScaled),
            grossMinor: BigInt(line.grossMinor),
            lineDiscountMinor: BigInt(line.lineDiscountMinor),
            basketDiscountMinor: BigInt(line.basketDiscountMinor),
            netMinor: BigInt(line.netMinor),
            vatMinor: BigInt(line.vatMinor),
            totalMinor: BigInt(line.totalMinor),
          })),
        });

        if (sale.discounts.length > 0) {
          await tx.saleDiscount.createMany({
            data: sale.discounts.map((discount) => ({
              id: discount.id,
              tenantId: tenant,
              saleId: sale.id,
              scope: discount.scope,
              lineNumber: discount.lineNumber,
              kind: discount.kind,
              inputValue: BigInt(discount.inputValue),
              amountMinor: BigInt(discount.amountMinor),
              reason: discount.reason,
              grantedByUserId: discount.grantedByUserId,
            })),
          });
        }

        await tx.tender.createMany({
          data: sale.tenders.map((tender) => ({
            id: tender.id,
            tenantId: tenant,
            saleId: sale.id,
            kind: tender.kind,
            amountMinor: BigInt(tender.amountMinor),
            changeMinor: BigInt(tender.changeMinor),
            reference: tender.reference,
          })),
        });

        await tx.invoice.create({
          data: {
            id: invoice.id,
            tenantId: tenant,
            saleId: sale.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceType: invoice.invoiceType,
            sellerName: invoice.sellerName,
            sellerVatNumber: invoice.sellerVatNumber,
            buyerName: invoice.buyerName,
            buyerVatNumber: invoice.buyerVatNumber,
            netMinor: BigInt(invoice.netMinor),
            vatMinor: BigInt(invoice.vatMinor),
            totalMinor: BigInt(invoice.totalMinor),
            currency: invoice.currency,
            issuedAt: new Date(invoice.issuedAt),
          },
        });

        if (invoice.taxBreakdown.length > 0) {
          await tx.invoiceTaxBreakdown.createMany({
            data: invoice.taxBreakdown.map((bucket, index) => ({
              // The bucket has no identity of its own; it is a projection of
              // the invoice, so its id is derived from the invoice's and its
              // position rather than minted separately.
              id: bucketId(invoice.id, index),
              tenantId: tenant,
              invoiceId: invoice.id,
              vatBasisPoints: Number(bucket.vatBasisPoints),
              netMinor: BigInt(bucket.netMinor),
              vatMinor: BigInt(bucket.vatMinor),
            })),
          });
        }

        for (const movement of inventory) {
          await applyMovementWithin(tx, tenant, movement);
        }

        if (cashMovement !== null) {
          await tx.cashMovement.create({
            data: {
              id: cashMovement.id,
              tenantId: tenant,
              shiftId: cashMovement.shiftId,
              kind: cashMovement.kind,
              amountMinor: BigInt(cashMovement.amountMinor),
              reason: cashMovement.reason,
              actorUserId: cashMovement.actorUserId,
              occurredAt: new Date(cashMovement.occurredAt),
            },
          });
        }

        const row = await loadSale(tx, tenant, { id: sale.id });
        if (row === null) {
          throw new DatabaseError('The sale just written could not be read back.');
        }
        return saleToDomain(scope, row);
      });
    },
  };
}

/**
 * A deterministic UUID for a tax bucket, derived from its invoice.
 *
 * Deterministic so that replaying the same invoice cannot produce a second set
 * of buckets under new ids. The last two hex digits of the invoice's id are
 * replaced by the bucket index, which keeps the value a syntactically valid
 * UUID and unique within the invoice.
 */
export function bucketId(invoiceId: string, index: number): string {
  if (index > 0xff) {
    throw new DatabaseError('An invoice with more than 256 tax buckets is not a real invoice.');
  }
  const suffix = index.toString(16).padStart(2, '0');
  return `${invoiceId.slice(0, invoiceId.length - 2)}${suffix}`;
}
