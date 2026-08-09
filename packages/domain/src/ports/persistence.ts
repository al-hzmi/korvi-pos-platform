import { DomainError } from '../errors.js';
import type { BasisPoints } from '../tax/basis-points.js';
// Reused, not redeclared. A second `PriceMode` that happened to agree today
// would be free to disagree tomorrow, and the two would sit on either side of
// the persistence boundary.
import type { PriceMode } from '../pricing/line.js';
import type { TenderKind, TenderScheme } from '../tender/tender.js';

/**
 * Repository ports.
 *
 * The domain declares what it needs; packages/database supplies it. Prisma
 * types never cross this line, which is what keeps the core liftable into
 * Korvi ERP later (ADR-0001) and stops ORM shapes reaching the UI (ADR-0004).
 *
 * Two conventions hold throughout this file:
 *
 *   Money and quantity cross as decimal *strings* of the underlying integer —
 *   `"1500"` halalas, `"1250"` thousandths of a kilo. A bigint cannot be
 *   JSON-serialised and a number silently loses halalas above 2^53. See
 *   ADR-0002.
 *
 *   Timestamps cross as ISO 8601 strings. A Date is mutable and carries a
 *   local-timezone rendering that survives no boundary intact.
 */

/** Branded so a bare string cannot be passed where a tenant is expected. */
export type TenantId = string & { readonly __brand: 'TenantId' };

export function tenantId(value: string): TenantId {
  return value as TenantId;
}

/**
 * Every tenant-owned read and write carries this.
 *
 * A `TenantScope` is a *claim that has already been verified*. Nothing in this
 * package can verify it — that is the authentication layer's job, and it does
 * not exist yet. What this type does is make the absence visible: a repository
 * method cannot be called without one, so no future caller can reach the
 * database having merely read a tenant id off a request body.
 *
 * The repositories go further and establish PostgreSQL RLS context from the
 * scope, so a forged or mistaken id yields an empty result set rather than
 * another merchant's rows. That is the actual boundary; this type is the
 * reminder of where it sits.
 *
 * GlobalCatalog is deliberately outside it: the national barcode catalogue is
 * shared infrastructure, not tenant data, and giving it a tenantId would mean
 * storing hundreds of thousands of duplicate rows per merchant (ADR-0004).
 */
export interface TenantScope {
  readonly tenantId: TenantId;
}

/**
 * A row surfaced under one tenant's scope carried another tenant's id.
 *
 * If this is ever thrown, RLS has been bypassed or a query was written without
 * a tenant filter. It is deliberately fatal: returning the row would be a
 * cross-tenant data leak, and returning null would hide a broken boundary.
 */
export class CrossTenantAccessError extends DomainError {
  public override readonly name = 'CrossTenantAccessError';
}

/** Belt and braces over RLS. Every adapter mapper calls this. */
export function assertSameTenant(scope: TenantScope, rowTenantId: string): void {
  if (rowTenantId !== (scope.tenantId as string)) {
    throw new CrossTenantAccessError(
      'A row from another tenant reached a tenant-scoped read. Refusing to return it.',
    );
  }
}

// ---------------------------------------------------------------------------
// Tenancy and configuration
// ---------------------------------------------------------------------------

export type TenantStatus = 'active' | 'suspended' | 'closed';

/** The minimum needed to identify a tenant before any scope exists. */
export interface TenantIdentity {
  readonly id: TenantId;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
}

export interface Tenant extends TenantIdentity {
  readonly vatNumber: string | null;
}

export type Vertical = 'retail' | 'grocery' | 'restaurant' | 'pharmacy';

export interface TenantSettings {
  readonly tenantId: TenantId;
  readonly vertical: Vertical;
  readonly priceMode: PriceMode;
  readonly defaultVatBasisPoints: BasisPoints;
  readonly currency: string;
  readonly requireBarcode: boolean;
  readonly allowWeightedItems: boolean;
  readonly trackInventory: boolean;
  readonly allowNegativeStock: boolean;
  readonly receiptHeaderAr: string | null;
  readonly receiptFooterAr: string | null;
}

export interface Branch {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
}

export interface Terminal {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly lastSeenAt: string | null;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export type ProductType = 'unit' | 'weighted';

export interface Product {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly categoryId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType;
  readonly unitLabel: string;
  /** Minor units, as a string at this boundary. See ADR-0002. */
  readonly priceMinor: string;
  /**
   * Branded and validated, not a bare number. The adapter narrows the integer
   * column through `basisPointsFromColumn`, so a corrupt row fails at the
   * boundary instead of producing a wrong tax figure downstream.
   */
  readonly vatBasisPoints: BasisPoints;
  /**
   * A product may carry several barcodes — a case, a single, a re-label. The
   * primary one is what a receipt prints; the rest still scan.
   */
  readonly primaryBarcode: string | null;
  readonly barcodes: readonly string[];
  readonly trackInventory: boolean;
  readonly isActive: boolean;
}

export interface GlobalCatalogItem {
  readonly barcode: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly vatBasisPoints: BasisPoints;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type InventoryMovementKind = 'sale' | 'return' | 'adjustment' | 'receipt' | 'transfer';

export interface InventoryBalance {
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly productId: string;
  /** Scaled by 1000, signed. A negative balance is an oversell. */
  readonly quantityScaled: string;
}

export interface InventoryMovementInput {
  readonly id: string;
  readonly branchId: string;
  readonly productId: string;
  readonly kind: InventoryMovementKind;
  /** Signed and scaled by 1000: a sale is negative, a receipt positive. */
  readonly quantityScaled: string;
  readonly reason: string | null;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly actorUserId: string | null;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface Customer {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
  readonly isActive: boolean;
}

export interface CreateCustomerInput {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export type ShiftStatusRecord = 'open' | 'closed';

export type CashMovementKindRecord = 'sale' | 'refund' | 'pay-in' | 'pay-out' | 'opening-float';

export interface CashMovementRecord {
  readonly id: string;
  readonly shiftId: string;
  readonly kind: CashMovementKindRecord;
  /** Signed halalas: a pay-out and a refund are negative. */
  readonly amountMinor: string;
  readonly reason: string | null;
  readonly actorUserId: string | null;
  readonly occurredAt: string;
}

export interface ShiftRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly status: ShiftStatusRecord;
  readonly openingFloatMinor: string;
  readonly declaredCashMinor: string | null;
  readonly expectedCashMinor: string | null;
  readonly varianceMinor: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly movements: readonly CashMovementRecord[];
}

export interface OpenShiftInput {
  readonly id: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly openingFloatMinor: string;
  readonly openedAt: string;
  /** The opening-float movement, so the drawer's history starts at zero gaps. */
  readonly openingMovementId: string;
}

export interface CloseShiftInput {
  readonly shiftId: string;
  readonly declaredCashMinor: string;
  readonly expectedCashMinor: string;
  readonly varianceMinor: string;
  readonly closedAt: string;
}

// ---------------------------------------------------------------------------
// Sales and invoices
// ---------------------------------------------------------------------------

export type SaleStatus = 'finalized' | 'voided';

/**
 * A sale line as stored.
 *
 * Every descriptive and financial field is a snapshot. Nothing here is read
 * back from `products`: a price change tomorrow must not alter what yesterday's
 * invoice says, and a deleted product must not make an old receipt
 * unprintable.
 */
export interface SaleLineRecord {
  readonly id: string;
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly unitPriceMinor: string;
  readonly vatBasisPoints: BasisPoints;
  readonly quantityScaled: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface SaleDiscountRecord {
  readonly id: string;
  readonly scope: 'line' | 'basket';
  readonly lineNumber: number | null;
  readonly kind: 'fixed' | 'percentage';
  readonly inputValue: string;
  readonly amountMinor: string;
  readonly reason: string | null;
  readonly grantedByUserId: string | null;
}

export interface TenderRecord {
  readonly id: string;
  readonly kind: TenderKind;
  /** Present on an electronic tender and null on cash. */
  readonly scheme: TenderScheme | null;
  readonly amountMinor: string;
  readonly changeMinor: string;
  /**
   * The external approval reference.
   *
   * Korvi records that a payment was approved elsewhere; it does not perform
   * one. This is the pointer back to whatever did — never a card number.
   */
  readonly reference: string | null;
}

export interface SaleRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly userId: string;
  readonly customerId: string | null;
  readonly operationId: string;
  readonly status: SaleStatus;
  readonly sequence: number;
  readonly priceMode: PriceMode;
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
  readonly lines: readonly SaleLineRecord[];
  readonly discounts: readonly SaleDiscountRecord[];
  readonly tenders: readonly TenderRecord[];
}

export type InvoiceType = 'simplified' | 'standard';

export interface InvoiceTaxBucketRecord {
  readonly vatBasisPoints: BasisPoints;
  readonly netMinor: string;
  readonly vatMinor: string;
}

export interface InvoiceRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly saleId: string;
  readonly invoiceNumber: string;
  readonly invoiceType: InvoiceType;
  readonly sellerName: string;
  readonly sellerVatNumber: string;
  readonly buyerName: string | null;
  readonly buyerVatNumber: string | null;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly currency: string;
  readonly issuedAt: string;
  readonly taxBreakdown: readonly InvoiceTaxBucketRecord[];
}

/**
 * Everything one checkout writes, in one value.
 *
 * The sale, its invoice, the stock it consumed, the cash it put in the drawer
 * and the idempotency reservation are a single fact about the world. Writing
 * them in separate calls would allow a crash to leave an invoice with no sale,
 * or stock decremented for a sale that never existed — so the port takes them
 * together and the adapter commits them in one transaction.
 */
export interface RecordSaleInput {
  /**
   * `sequence` is absent on purpose, and so is the invoice number.
   *
   * A receipt number is not something a caller can know: two tills in one
   * branch would both compute the same "next" one and the second insert would
   * collide on (tenantId, branchId, sequence). The adapter allocates both
   * inside the transaction that writes the sale, serialised on the branch row,
   * so a number is issued exactly once and only to a sale that commits.
   */
  readonly sale: Omit<SaleRecord, 'tenantId' | 'sequence'>;
  readonly invoice: Omit<InvoiceRecord, 'tenantId' | 'invoiceNumber'>;
  readonly inventory: readonly InventoryMovementInput[];
  readonly cashMovement: CashMovementRecord | null;
  readonly idempotency: IdempotencyReservation;
}

// ---------------------------------------------------------------------------
// Idempotency and audit
// ---------------------------------------------------------------------------

export type IdempotencyStatus = 'reserved' | 'completed' | 'failed';

export interface IdempotencyReservation {
  readonly id: string;
  readonly scope: string;
  readonly operationId: string;
  /** Fingerprint of the request, so a replay with different content is seen. */
  readonly requestHash: string | null;
}

export interface IdempotencyRecord extends IdempotencyReservation {
  readonly tenantId: TenantId;
  readonly status: IdempotencyStatus;
  readonly resultType: string | null;
  readonly resultId: string | null;
  readonly completedAt: string | null;
}

export interface AuditEventInput {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly branchId: string | null;
  readonly terminalId: string | null;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string | null;
  /**
   * Structured context. Never a credential, token or password: audit rows are
   * the most widely read table in any support incident.
   */
  readonly metadata: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface TenantRepository {
  /** The tenant this scope names. Structurally incapable of returning another. */
  current(scope: TenantScope): Promise<Tenant | null>;
  settings(scope: TenantScope): Promise<TenantSettings | null>;
}

/*
 * There is deliberately no unscoped tenant lookup of any kind — no resolution
 * by hostname, by subdomain, or by any other public handle.
 *
 * Resolving a hostname to a tenant has to happen before a scope exists, which
 * makes it the one read that cannot be tenant-scoped — and `tenants` is under
 * RLS, so it cannot be served from this layer at all without a policy or a
 * role that weakens the boundary. That decision belongs with authentication,
 * which this strike does not build. Provisioning the first tenant is the same
 * shape of problem and has the same answer: it runs as the migration role, not
 * through a repository.
 *
 * Leaving the gap visible is the point. An unscoped `findBySlug` added here
 * "temporarily" would be the one method every later caller reaches for.
 */

/**
 * What an owner sees when they open Korvi.
 *
 * A read model, not a report engine: every figure is one a merchant can check
 * against the tills in front of them, and every one is derived from rows that
 * already exist. Nothing here is estimated, projected or smoothed.
 *
 * "Last 24 hours" rather than "today" on purpose. A calendar day needs a
 * tenant timezone, and Korvi does not persist one yet; inventing an answer
 * would put a wrong number on the first screen an owner ever sees. A rolling
 * window is exactly defined without one.
 *
 * Money crosses as decimal strings of halalas, like everywhere else (ADR-0002).
 */
export interface DashboardSummary {
  readonly activeProductCount: number;
  readonly terminalCount: number;
  readonly openShiftCount: number;
  readonly salesLast24HoursCount: number;
  readonly grossSalesLast24HoursMinor: string;
  readonly vatLast24HoursMinor: string;
  readonly currency: string;
  /** The start of the window, so the screen can say what it is showing. */
  readonly since: string;
}

export interface DashboardRepository {
  /** Tenant-scoped by construction; there is no parameter that could widen it. */
  summary(scope: TenantScope, since: string): Promise<DashboardSummary>;
}

export interface BranchRepository {
  findById(scope: TenantScope, id: string): Promise<Branch | null>;
  list(scope: TenantScope): Promise<readonly Branch[]>;
}

export interface TerminalRepository {
  findById(scope: TenantScope, id: string): Promise<Terminal | null>;
  findByCode(scope: TenantScope, code: string): Promise<Terminal | null>;
  listForBranch(scope: TenantScope, branchId: string): Promise<readonly Terminal[]>;
  markSeen(scope: TenantScope, id: string, at: string): Promise<void>;
}

/**
 * What a cashier typed into the search box.
 *
 * `limit` is required rather than optional: an unbounded product search is a
 * table scan across a merchant's whole catalogue, run on every keystroke.
 */
export interface ProductSearchQuery {
  readonly term: string;
  readonly limit: number;
}

export interface ProductRepository {
  findById(scope: TenantScope, id: string): Promise<Product | null>;
  /**
   * Prefix and code search for the till.
   *
   * Ordered so the common case is cheap: a barcode-shaped term is an exact
   * lookup before anything else runs, because a scanner produces one and the
   * cashier is already reaching for the next item.
   */
  search(scope: TenantScope, query: ProductSearchQuery): Promise<readonly Product[]>;
  findBySku(scope: TenantScope, sku: string): Promise<Product | null>;
  findByBarcode(scope: TenantScope, barcode: string): Promise<Product | null>;
  list(scope: TenantScope, limit: number): Promise<readonly Product[]>;
}

export interface InventoryRepository {
  balance(
    scope: TenantScope,
    branchId: string,
    productId: string,
  ): Promise<InventoryBalance | null>;
  listBalances(
    scope: TenantScope,
    branchId: string,
    limit: number,
  ): Promise<readonly InventoryBalance[]>;
  /** Records the movement and moves the balance in one transaction. */
  applyMovement(scope: TenantScope, movement: InventoryMovementInput): Promise<InventoryBalance>;
}

export interface CustomerRepository {
  findById(scope: TenantScope, id: string): Promise<Customer | null>;
  findByPhone(scope: TenantScope, phone: string): Promise<Customer | null>;
  list(scope: TenantScope, limit: number): Promise<readonly Customer[]>;
  create(scope: TenantScope, input: CreateCustomerInput): Promise<Customer>;
}

export interface ShiftRepository {
  findById(scope: TenantScope, id: string): Promise<ShiftRecord | null>;
  findOpenForTerminal(scope: TenantScope, terminalId: string): Promise<ShiftRecord | null>;
  open(scope: TenantScope, input: OpenShiftInput): Promise<ShiftRecord>;
  recordCashMovement(scope: TenantScope, movement: CashMovementRecord): Promise<void>;
  close(scope: TenantScope, input: CloseShiftInput): Promise<ShiftRecord>;
}

export interface SaleRepository {
  findById(scope: TenantScope, id: string): Promise<SaleRecord | null>;
  /** The idempotent read: a retry finds the sale its first attempt created. */
  findByOperationId(scope: TenantScope, operationId: string): Promise<SaleRecord | null>;
  invoiceForSale(scope: TenantScope, saleId: string): Promise<InvoiceRecord | null>;
  /** Sale, lines, tenders, invoice, stock and cash — one transaction. */
  record(scope: TenantScope, input: RecordSaleInput): Promise<SaleRecord>;
}

export interface IdempotencyRepository {
  find(
    scope: TenantScope,
    scopeKey: string,
    operationId: string,
  ): Promise<IdempotencyRecord | null>;
  reserve(scope: TenantScope, reservation: IdempotencyReservation): Promise<IdempotencyRecord>;
  complete(
    scope: TenantScope,
    scopeKey: string,
    operationId: string,
    result: { readonly resultType: string; readonly resultId: string; readonly at: string },
  ): Promise<void>;
}

export interface AuditRepository {
  append(scope: TenantScope, event: AuditEventInput): Promise<void>;
  list(scope: TenantScope, limit: number): Promise<readonly AuditEventInput[]>;
}

export interface GlobalCatalogRepository {
  findByBarcode(barcode: string): Promise<GlobalCatalogItem | null>;
}
