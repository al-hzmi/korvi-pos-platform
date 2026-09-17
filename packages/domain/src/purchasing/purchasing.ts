import { CostingRequestError, parseNonNegativeMinor } from '../costing/costing.js';
import { DomainError } from '../errors.js';
import {
  MAX_STOCK_LINES,
  StockRequestError,
  canonicalUuid as canonicalStockUuid,
  isWholeUnitScaled,
  parseSignedScaled,
} from '../inventory/stock.js';
import type { StockProductType } from '../inventory/stock.js';

/**
 * The vocabulary of purchasing and receiving.
 *
 * One sentence governs this entire module, and every rule below is a
 * consequence of it:
 *
 *   **a purchase order is not a stock movement.**
 *
 * A PO is a merchant's intent to buy. It says what was asked for and from
 * whom; it says nothing about what is on the shelf, because nothing has
 * arrived. Only a *receipt* — evidence that goods were physically accepted —
 * may move stock, and only for the quantity actually accepted (ADR-0024 §7).
 *
 * Nothing here touches a database or decides authority. What is here is what a
 * request may say, what shape it must be in to be worth locking rows for, the
 * pure lifecycle arithmetic, and the canonical form that decides whether two
 * submissions are the same intent.
 *
 * ## Everything is a scaled integer string
 *
 * Ordered, received and accepted quantities are all signed `BIGINT` scaled by
 * 1000 in the database and decimal *strings* across every boundary — the same
 * rule Strike 5A established, reused rather than restated. There is no
 * `parseFloat`, no `toFixed`, no `Number` arithmetic and no cost of any kind in
 * this file: costing is Strike 5C and deliberately absent here.
 */

export class PurchasingRequestError extends DomainError {
  public override readonly name = 'PurchasingRequestError';
  public readonly detail: PurchasingRequestRefusal;

  public constructor(detail: PurchasingRequestRefusal, message: string) {
    super(message);
    this.detail = detail;
  }
}

export type PurchasingRequestRefusal =
  | 'invalid-uuid'
  | 'invalid-quantity'
  | 'non-positive-quantity'
  | 'fractional-unit-quantity'
  | 'duplicate-product'
  | 'duplicate-order-line'
  | 'no-lines'
  | 'too-many-lines'
  | 'invalid-name'
  | 'invalid-reference'
  | 'invalid-money';

/** The same ceiling stock operations use: one request, one bounded row set. */
export const MAX_PURCHASING_LINES = MAX_STOCK_LINES;

/** Bounded because it is stored, listed, and printed on a purchase order. */
export const MAX_SUPPLIER_NAME = 160;

/** A merchant's own document number for the supplier's delivery note. */
export const MAX_PURCHASING_REFERENCE = 120;

// ---------------------------------------------------------------------------
// Shared shape rules
// ---------------------------------------------------------------------------

/**
 * Strike 5A's identity and quantity rules, in purchasing's own vocabulary.
 *
 * The *rule* is reused rather than restated: `canonicalUuid` and
 * `parseSignedScaled` remain the single implementations of "what a UUID
 * identity is" and "what canonical scaled integer text is", so purchasing and
 * stock can never drift into disagreeing about whether `018F…A8` and `018f…a8`
 * are the same product.
 *
 * Only the *refusal type* is translated. A caller of the purchasing surface
 * handles `PurchasingRequestError` and gets a closed vocabulary it can switch
 * on exhaustively; leaking a `StockRequestError` out of a supplier update would
 * make that vocabulary open, and every consumer would have to catch two error
 * classes to be correct. The detail strings are deliberately identical, because
 * they name the same fact.
 */
function inPurchasingVocabulary<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof StockRequestError) {
      const detail: PurchasingRequestRefusal =
        error.detail === 'invalid-uuid' ? 'invalid-uuid' : 'invalid-quantity';
      throw new PurchasingRequestError(detail, error.message);
    }
    if (error instanceof CostingRequestError) {
      throw new PurchasingRequestError('invalid-money', error.message);
    }
    throw error;
  }
}

/**
 * Deliberately not exported. `canonicalUuid` already has one public home in
 * `@korvi/domain`, and a second export of the same name from the same barrel
 * would be ambiguous. Callers outside the domain use that one; everything
 * inside this module uses this wrapper so the refusal stays in vocabulary.
 */
function purchasingUuid(value: string, field: string): string {
  return inPurchasingVocabulary(() => canonicalStockUuid(value, field));
}

/**
 * A strictly positive scaled quantity.
 *
 * Nothing in purchasing is signed. An order for a negative amount is not an
 * order, and a receipt that accepted a negative amount is a return to the
 * supplier — a different business event with different evidence, deliberately
 * out of scope for this strike. Zero is refused for the same reason a zero
 * adjustment is: a line that moves nothing is noise in a causal history that
 * somebody later has to reconcile.
 */
export function parsePositiveScaled(value: string, field: string): bigint {
  const parsed = inPurchasingVocabulary(() => parseSignedScaled(value, field));
  if (parsed <= 0n) {
    throw new PurchasingRequestError(
      'non-positive-quantity',
      `${field} must be greater than zero.`,
    );
  }
  return parsed;
}

/**
 * Unit products are whole things — restated here against purchasing's own
 * refusal vocabulary rather than borrowed, so a caller catching a
 * `PurchasingRequestError` never has to also catch a stock one.
 *
 * Half a tin cannot be ordered and cannot be received. Accepting one would put
 * a PO-line accumulator and a balance into the ledger that no delivery could
 * ever reproduce.
 */
export function assertPurchasingQuantityShape(
  scaled: bigint,
  productType: StockProductType,
  field: string,
): void {
  if (productType === 'unit' && !isWholeUnitScaled(scaled)) {
    throw new PurchasingRequestError(
      'fractional-unit-quantity',
      `${field} must be a whole number of units for a unit product.`,
    );
  }
}

function assertBoundedText(
  value: string,
  max: number,
  detail: PurchasingRequestRefusal,
  label: string,
): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) {
    throw new PurchasingRequestError(
      detail,
      `${label} must be between 1 and ${String(max)} characters.`,
    );
  }
  return trimmed;
}

export function assertSupplierName(name: string): string {
  return assertBoundedText(name, MAX_SUPPLIER_NAME, 'invalid-name', 'A supplier name');
}

function normalizedReference(reference: string | null): string | null {
  if (reference === null) return null;
  const trimmed = reference.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_PURCHASING_REFERENCE) {
    throw new PurchasingRequestError(
      'invalid-reference',
      `A reference must be at most ${String(MAX_PURCHASING_REFERENCE)} characters.`,
    );
  }
  return trimmed;
}

function assertLineCount(count: number): void {
  if (count === 0) {
    throw new PurchasingRequestError('no-lines', 'At least one line is required.');
  }
  if (count > MAX_PURCHASING_LINES) {
    throw new PurchasingRequestError(
      'too-many-lines',
      `At most ${String(MAX_PURCHASING_LINES)} lines are allowed in one operation.`,
    );
  }
}

/**
 * Validated lines come out sorted by their identity, always.
 *
 * The canonical fingerprint deliberately ignores line order, so two clients
 * listing the same lines in a different order are one intent and the second is
 * a replay of the first. That is only coherent if the *result* is
 * order-independent too — otherwise the first caller is answered in submitted
 * order, the retry is answered from the stored document, and one committed
 * operation has told two callers two different things.
 *
 * Sorting here also fixes the order in which PO lines are locked and balance
 * rows are touched, which is the deterministic order the lock discipline wants
 * (Strike 5A §E).
 */
function byKey<T>(lines: readonly T[], key: (line: T) => string): readonly T[] {
  return [...lines].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Supplier
// ---------------------------------------------------------------------------

export interface SupplierCreateRequest {
  readonly operationId: string;
  readonly name: string;
}

export interface ValidatedSupplierCreate {
  readonly name: string;
}

export function validateSupplierCreate(request: SupplierCreateRequest): ValidatedSupplierCreate {
  return { name: assertSupplierName(request.name) };
}

/**
 * An update states only what it wants changed.
 *
 * `undefined` means "leave it alone", and it is distinct from every value the
 * field can actually take — which is why `exactOptionalPropertyTypes` is on
 * and why neither field is nullable. A supplier has no "no name" state, and
 * `isActive` is a boolean with no third reading.
 */
export interface SupplierUpdateRequest {
  readonly operationId: string;
  readonly supplierId: string;
  readonly name?: string | undefined;
  readonly isActive?: boolean | undefined;
}

export interface ValidatedSupplierUpdate {
  readonly supplierId: string;
  readonly name: string | undefined;
  readonly isActive: boolean | undefined;
}

export function validateSupplierUpdate(request: SupplierUpdateRequest): ValidatedSupplierUpdate {
  const supplierId = purchasingUuid(request.supplierId, 'supplierId');
  // An update that changes nothing is refused rather than silently committed:
  // it would consume an operation id, write an audit event and a document
  // revision for a decision nobody made.
  if (request.name === undefined && request.isActive === undefined) {
    throw new PurchasingRequestError(
      'invalid-name',
      'A supplier update must change the name, the active state, or both.',
    );
  }
  return {
    supplierId,
    name: request.name === undefined ? undefined : assertSupplierName(request.name),
    isActive: request.isActive,
  };
}

// ---------------------------------------------------------------------------
// Purchase order
// ---------------------------------------------------------------------------

export interface PurchaseOrderLineRequest {
  readonly productId: string;
  /** Positive, scaled by 1000. What was asked for, not what arrived. */
  readonly orderedQuantityScaled: string;
}

export interface PurchaseOrderRequest {
  readonly operationId: string;
  readonly supplierId: string;
  /** Where the goods are expected to physically arrive. */
  readonly branchId: string;
  /** The merchant's own document number, if they keep one. */
  readonly reference: string | null;
  readonly lines: readonly PurchaseOrderLineRequest[];
}

export interface ValidatedPurchaseOrderLine {
  readonly productId: string;
  readonly orderedQuantityScaled: bigint;
}

export interface ValidatedPurchaseOrder {
  readonly supplierId: string;
  readonly branchId: string;
  readonly reference: string | null;
  readonly lines: readonly ValidatedPurchaseOrderLine[];
}

/**
 * One product, one line.
 *
 * Two lines naming the same product would be two independent accumulators for
 * one physical thing, and a receipt would then have to choose which one it was
 * filling. Canonicalizing first is what makes this a typed refusal rather than
 * a unique-index violation later: `018F…A8` and `018f…a8` are one product to
 * PostgreSQL, and they must be one product here too (Strike 5A UUID doctrine).
 */
export function validatePurchaseOrderRequest(
  request: PurchaseOrderRequest,
): ValidatedPurchaseOrder {
  const supplierId = purchasingUuid(request.supplierId, 'supplierId');
  const branchId = purchasingUuid(request.branchId, 'branchId');
  const reference = normalizedReference(request.reference);

  const products = request.lines.map((line) => purchasingUuid(line.productId, 'productId'));
  assertLineCount(products.length);
  if (new Set(products).size !== products.length) {
    throw new PurchasingRequestError(
      'duplicate-product',
      'A product may appear at most once in a purchase order.',
    );
  }

  const lines = byKey(
    request.lines.map((line, index) => ({ ...line, productId: products[index] ?? '' })),
    (line) => line.productId,
  ).map((line) => ({
    productId: line.productId,
    orderedQuantityScaled: parsePositiveScaled(line.orderedQuantityScaled, 'orderedQuantityScaled'),
  }));

  return { supplierId, branchId, reference, lines };
}

// ---------------------------------------------------------------------------
// Purchase order status
// ---------------------------------------------------------------------------

export const PURCHASE_ORDER_STATUSES = ['open', 'partially_received', 'received'] as const;

export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export interface PurchaseOrderLineProgress {
  readonly orderedQuantityScaled: bigint;
  readonly receivedQuantityScaled: bigint;
}

/**
 * Status is a *function* of the accumulators, never a stored decision.
 *
 * The browser cannot submit it and the server never writes it independently:
 * it is recomputed from every line's received-versus-ordered pair inside the
 * transaction that changed those accumulators, so a status that disagrees with
 * the lines cannot exist even for the duration of one statement (§7).
 *
 * Pure, total, and tested on its own — which is the point of it living here
 * rather than being three `if`s inside a SQL-writing function.
 */
export function derivePurchaseOrderStatus(
  lines: readonly PurchaseOrderLineProgress[],
): PurchaseOrderStatus {
  if (lines.length === 0) {
    throw new PurchasingRequestError('no-lines', 'A purchase order has at least one line.');
  }
  let anyReceived = false;
  let allComplete = true;
  for (const line of lines) {
    if (line.receivedQuantityScaled > 0n) anyReceived = true;
    if (line.receivedQuantityScaled < line.orderedQuantityScaled) allComplete = false;
  }
  if (allComplete) return 'received';
  return anyReceived ? 'partially_received' : 'open';
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

export interface PurchaseReceiptLineRequest {
  /**
   * The PO line being filled, not the product.
   *
   * The product, the branch and the supplier are all derived from this row
   * under its lock. A client that named the product instead would be choosing
   * which accumulator to spend, and on a PO with one product per line that is
   * the same choice made less safely (§9).
   */
  readonly purchaseOrderLineId: string;
  /** Strictly positive. What physically arrived and was accepted. */
  readonly acceptedQuantityScaled: string;
  /**
   * Optional exact total inventory value for the accepted quantity, in minor
   * units. This is acquisition-value evidence, never a unit price, tax amount
   * or retail selling price. Omission means explicit unknown cost.
   */
  readonly inventoryValueMinor?: string | undefined;
}

export interface PurchaseReceiptRequest {
  readonly operationId: string;
  readonly purchaseOrderId: string;
  /** The supplier's delivery-note number, if the merchant records one. */
  readonly reference: string | null;
  readonly lines: readonly PurchaseReceiptLineRequest[];
}

export interface ValidatedPurchaseReceiptLine {
  readonly purchaseOrderLineId: string;
  readonly acceptedQuantityScaled: bigint;
  readonly inventoryValueMinor: bigint | null;
}

export interface ValidatedPurchaseReceipt {
  readonly purchaseOrderId: string;
  readonly reference: string | null;
  readonly lines: readonly ValidatedPurchaseReceiptLine[];
}

export function validatePurchaseReceiptRequest(
  request: PurchaseReceiptRequest,
): ValidatedPurchaseReceipt {
  const purchaseOrderId = purchasingUuid(request.purchaseOrderId, 'purchaseOrderId');
  const reference = normalizedReference(request.reference);

  const lineIds = request.lines.map((line) =>
    purchasingUuid(line.purchaseOrderLineId, 'purchaseOrderLineId'),
  );
  assertLineCount(lineIds.length);
  // Two lines against one PO line would be two claims on one remaining
  // quantity. Summing them silently is the reading that lets a client
  // over-receive by writing the same line twice, so it is refused instead.
  if (new Set(lineIds).size !== lineIds.length) {
    throw new PurchasingRequestError(
      'duplicate-order-line',
      'A purchase-order line may appear at most once in a receipt.',
    );
  }

  const lines = byKey(
    request.lines.map((line, index) => ({
      ...line,
      purchaseOrderLineId: lineIds[index] ?? '',
    })),
    (line) => line.purchaseOrderLineId,
  ).map((line) => ({
    purchaseOrderLineId: line.purchaseOrderLineId,
    acceptedQuantityScaled: parsePositiveScaled(
      line.acceptedQuantityScaled,
      'acceptedQuantityScaled',
    ),
    inventoryValueMinor:
      line.inventoryValueMinor === undefined
        ? null
        : inPurchasingVocabulary(() =>
            parseNonNegativeMinor(line.inventoryValueMinor ?? '', 'inventoryValueMinor'),
          ),
  }));

  return { purchaseOrderId, reference, lines };
}

/**
 * What a PO line still has room for.
 *
 * Exact integer subtraction, and the only place the remaining quantity is
 * defined. The authority calls this against the *locked* row; calling it
 * against a read would produce the same number and none of the safety, which
 * is why the function takes quantities rather than going and fetching them.
 */
export function remainingQuantityScaled(line: PurchaseOrderLineProgress): bigint {
  return line.orderedQuantityScaled - line.receivedQuantityScaled;
}

// ---------------------------------------------------------------------------
// Canonical fingerprint
// ---------------------------------------------------------------------------

/**
 * What "the same request" means, before it becomes bytes.
 *
 * Identical doctrine to Strike 5A's stock fingerprints, for identical reasons:
 * arrays rather than objects so field order is this module's decision and not
 * `JSON.stringify`'s view of an object literal; lines sorted by identity so a
 * reordered retry is a replay rather than a conflict; quantities re-parsed to
 * canonical integer text so "007" and "7" are one intent.
 *
 * These return the canonical *form*. The digest is taken in the infrastructure
 * layer because `node:crypto` in the domain would break the purity rule
 * ADR-0001 enforces — and because what counts as the same intent is a domain
 * decision, while hashing it is not.
 *
 * `operationId` is deliberately absent from every form: it is the key the form
 * is stored *under*, not part of what is being compared. It is also opaque
 * merchant text and is never UUID-normalized (§16).
 */
export function canonicalSupplierCreateForm(request: SupplierCreateRequest): readonly unknown[] {
  return ['purchasing-supplier-create.v1', assertSupplierName(request.name)];
}

export function canonicalSupplierUpdateForm(request: SupplierUpdateRequest): readonly unknown[] {
  const validated = validateSupplierUpdate(request);
  return [
    'purchasing-supplier-update.v1',
    validated.supplierId,
    // `null` for "not stated" rather than omitting the slot, so a form that
    // sets only the name and a form that sets only the active state can never
    // collapse into the same array shape.
    validated.name ?? null,
    validated.isActive ?? null,
  ];
}

export function canonicalPurchaseOrderForm(request: PurchaseOrderRequest): readonly unknown[] {
  const validated = validatePurchaseOrderRequest(request);
  return [
    'purchasing-order-create.v1',
    validated.supplierId,
    validated.branchId,
    validated.reference,
    validated.lines.map((line) => [line.productId, line.orderedQuantityScaled.toString()]),
  ];
}

export function canonicalPurchaseReceiptForm(request: PurchaseReceiptRequest): readonly unknown[] {
  const validated = validatePurchaseReceiptRequest(request);
  const carriesInventoryValue = validated.lines.some((line) => line.inventoryValueMinor !== null);

  // Compatibility is an idempotency invariant, not a convenience. A 5B
  // receipt with no cost evidence must fingerprint byte-for-byte as it did
  // before 5C, or a lawful retry after deployment would become a conflict.
  if (!carriesInventoryValue) {
    return [
      'purchasing-receipt-create.v1',
      validated.purchaseOrderId,
      validated.reference,
      validated.lines.map((line) => [
        line.purchaseOrderLineId,
        line.acceptedQuantityScaled.toString(),
      ]),
    ];
  }

  return [
    'purchasing-receipt-create.v2',
    validated.purchaseOrderId,
    validated.reference,
    validated.lines.map((line) => [
      line.purchaseOrderLineId,
      line.acceptedQuantityScaled.toString(),
      line.inventoryValueMinor === null ? null : line.inventoryValueMinor.toString(),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Scopes, causality and audit vocabulary
// ---------------------------------------------------------------------------

export const PURCHASING_IDEMPOTENCY_SCOPES = {
  supplierCreate: 'purchasing-supplier-create',
  supplierUpdate: 'purchasing-supplier-update',
  purchaseOrder: 'purchasing-order-create',
  purchaseReceipt: 'purchasing-receipt-create',
} as const;

/**
 * What a receiving movement points back at.
 *
 * `kind` stays `'receipt'` — the ledger's existing vocabulary already has that
 * value and it describes exactly this stock effect, so nothing is overloaded
 * and no historical CHECK constraint needs widening (§13). `sourceType` names
 * the document kind, `sourceId` the receipt, and `sourceLineId` the receipt
 * line, which is what makes a multi-line receipt's movements individually
 * attributable.
 */
export const PURCHASING_MOVEMENT_KIND = 'receipt' as const;

export const PURCHASING_SOURCE_TYPES = {
  purchaseReceipt: 'purchase-receipt',
} as const;

export const PURCHASING_AUDIT_EVENTS = {
  supplierCreated: 'purchasing.supplier.created',
  supplierUpdated: 'purchasing.supplier.updated',
  purchaseOrderCreated: 'purchasing.order.created',
  purchaseReceiptFinalized: 'purchasing.receipt.finalized',
} as const;

/** The refusals the purchasing authority can give, as a closed vocabulary. */
export const PURCHASING_AUTHORITY_REFUSALS = [
  'unknown-supplier',
  'inactive-supplier',
  'unknown-branch',
  'inactive-branch',
  'unknown-product',
  'inactive-product',
  'untracked-product',
  'unknown-purchase-order',
  'unknown-purchase-order-line',
  'purchase-order-closed',
  'over-receipt',
  'idempotency-conflict',
] as const;

export type PurchasingAuthorityRefusal = (typeof PURCHASING_AUTHORITY_REFUSALS)[number];
