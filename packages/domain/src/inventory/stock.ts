import { DomainError } from '../errors.js';
import { QUANTITY_SCALE } from '../quantity/quantity.js';

/**
 * The vocabulary of a merchant-facing stock mutation.
 *
 * Korvi already had one stock truth — `inventory_movements` as the causal
 * ledger and `inventory_balances` as its materialized quantity — reachable only
 * from checkout and returns. This module is the vocabulary of the three ways a
 * merchant may move stock deliberately: an adjustment, a count and a transfer
 * (ADR-0024, Strike 5A).
 *
 * Nothing here touches a database or decides authority. What is here is what a
 * request may say, what shape it must be in to be worth locking rows for, and
 * the fingerprint that decides whether two submissions are the same intent.
 *
 * ## Everything is a scaled integer string
 *
 * Quantity is signed `BIGINT` scaled by 1000 in the database, and it crosses
 * every boundary — JSON, domain, SQL — as a decimal *string*. Not a `number`:
 * 2^53 is reachable by a warehouse in grams, and `JSON.parse` would silently
 * round past it. There is no `parseFloat`, no `toFixed` and no arithmetic on
 * anything but `bigint` in this file, and the same rule holds for revision.
 */

export class StockRequestError extends DomainError {
  public override readonly name = 'StockRequestError';
  public readonly detail: StockRequestRefusal;

  public constructor(detail: StockRequestRefusal, message: string) {
    super(message);
    this.detail = detail;
  }
}

export type StockRequestRefusal =
  | 'invalid-uuid'
  | 'invalid-quantity'
  | 'invalid-revision'
  | 'zero-delta'
  | 'negative-count'
  | 'non-positive-quantity'
  | 'fractional-unit-quantity'
  | 'duplicate-product'
  | 'no-lines'
  | 'too-many-lines'
  | 'same-branch'
  | 'invalid-reason';

/** A line count ceiling, so one request cannot lock an unbounded row set. */
export const MAX_STOCK_LINES = 200;

/** Bounded because it is stored, displayed, and written into audit metadata. */
export const MAX_STOCK_REASON = 200;

/**
 * One canonical textual form for a UUID identity: lowercase, trimmed.
 *
 * PostgreSQL's `uuid` type is an identity, not a string. It accepts either
 * casing on input and renders one casing on output, so `018F…A8` and `018f…a8`
 * are the *same row* — and every comparison Korvi makes about identity has to
 * agree with that or it is comparing spellings instead of things.
 *
 * Without this, three contracts break in ways the database then has to catch:
 * two lines naming one product in different cases slip past duplicate
 * detection and die on a unique index; a transfer whose two branches are one
 * branch differently spelled slips past the same-branch rule and dies on a
 * CHECK; and a retry that re-spells an id fingerprints differently and is told
 * it conflicts when it is a replay. All three turn a typed refusal into a
 * database error, which is the wrong answer to give a merchant.
 *
 * Lowercase because that is what PostgreSQL emits, so a value that has been
 * through a column and a value that has not compare equal. The same
 * trim-and-lowercase rule the rest of Korvi already applies to identifiers.
 *
 * The shape is checked here too. A caller that reached the authority without
 * passing the HTTP schema — an internal path, a test, a future route — must not
 * be able to smuggle a non-UUID into a lock key.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function canonicalUuid(value: string, field: string): string {
  const candidate = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(candidate)) {
    throw new StockRequestError('invalid-uuid', `${field} must be a UUID, got "${value}".`);
  }
  return candidate;
}

/**
 * A signed scaled quantity, as text.
 *
 * `Quantity` in `../quantity` is deliberately non-negative — it models a weight
 * on a scale. An adjustment delta is signed by nature ("three fewer"), so it
 * gets its own parser rather than a widened brand that would let a negative
 * value leak into pricing, where it has no meaning.
 */
export function parseSignedScaled(value: string, field: string): bigint {
  // Zero has exactly one spelling. `-0` parses to the same bigint as `0`, so
  // accepting both would mean two request bodies that are byte-different and
  // intent-identical, and the fingerprint would have to paper over it.
  if (!/^(0|-?[1-9][0-9]{0,17})$/.test(value)) {
    throw new StockRequestError(
      'invalid-quantity',
      `${field} must be a scaled integer string, got "${value}".`,
    );
  }
  return BigInt(value);
}

/** Revision is a monotonic counter, so it is unsigned and never a Number. */
export function parseRevision(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,17})$/.test(value)) {
    throw new StockRequestError(
      'invalid-revision',
      `Revision must be a non-negative integer string, got "${value}".`,
    );
  }
  return BigInt(value);
}

/**
 * Unit products are whole things.
 *
 * Half a tin is not a quantity a shop can hold, and accepting one would put a
 * balance into the ledger that no physical count could ever reproduce. The
 * check is a modulo on the scale, never a rounding.
 */
export function isWholeUnitScaled(scaled: bigint): boolean {
  return scaled % QUANTITY_SCALE === 0n;
}

export type StockProductType = 'unit' | 'weighted';

export function assertQuantityShape(
  scaled: bigint,
  productType: StockProductType,
  field: string,
): void {
  if (productType === 'unit' && !isWholeUnitScaled(scaled)) {
    throw new StockRequestError(
      'fractional-unit-quantity',
      `${field} must be a whole number of units for a unit product.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface AdjustmentLineRequest {
  readonly productId: string;
  /** Signed. This is the one delta a client is allowed to state. */
  readonly deltaQuantityScaled: string;
}

export interface AdjustmentRequest {
  readonly operationId: string;
  readonly branchId: string;
  /** Required: an adjustment without a stated cause is an unexplained loss. */
  readonly reason: string;
  readonly lines: readonly AdjustmentLineRequest[];
}

export interface CountLineRequest {
  readonly productId: string;
  /** Absolute observed quantity. Evidence, not an instruction. */
  readonly countedQuantityScaled: string;
  /** The revision of the balance snapshot that was physically counted. */
  readonly expectedRevision: string;
}

export interface CountRequest {
  readonly operationId: string;
  readonly branchId: string;
  readonly reason: string | null;
  readonly lines: readonly CountLineRequest[];
}

export interface TransferLineRequest {
  readonly productId: string;
  /** Positive: direction is carried by the branches, not by a sign. */
  readonly quantityScaled: string;
}

export interface TransferRequest {
  readonly operationId: string;
  readonly fromBranchId: string;
  readonly toBranchId: string;
  readonly reason: string | null;
  readonly lines: readonly TransferLineRequest[];
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

function assertReason(reason: string | null, required: boolean): void {
  if (reason === null) {
    if (required) throw new StockRequestError('invalid-reason', 'A reason is required.');
    return;
  }
  const trimmed = reason.trim();
  if (trimmed === '' || trimmed.length > MAX_STOCK_REASON) {
    throw new StockRequestError(
      'invalid-reason',
      `A reason must be between 1 and ${String(MAX_STOCK_REASON)} characters.`,
    );
  }
}

/**
 * One product, one line.
 *
 * Two lines for the same product would be two deltas racing to describe one
 * balance, and whichever the server applied second would silently become the
 * whole answer for a count. Refusing is the only reading that cannot be wrong.
 */
function assertDistinctProducts(products: readonly string[]): void {
  if (products.length === 0) {
    throw new StockRequestError('no-lines', 'At least one line is required.');
  }
  if (products.length > MAX_STOCK_LINES) {
    throw new StockRequestError(
      'too-many-lines',
      `At most ${String(MAX_STOCK_LINES)} lines are allowed in one operation.`,
    );
  }
  if (new Set(products).size !== products.length) {
    throw new StockRequestError('duplicate-product', 'A product may appear at most once.');
  }
}

/**
 * Validated lines come out sorted by product id, always.
 *
 * The canonical fingerprint deliberately ignores line order, so `[P2, P1]` and
 * `[P1, P2]` are one intent and the second is a replay of the first. That is
 * only coherent if the *result* is order-independent too: otherwise the first
 * caller is answered in submitted order, the retry is answered from the stored
 * document in product order, and one committed operation has told two callers
 * two different things.
 *
 * Sorting here — before anything is written — makes the write order, the stored
 * order and every replay order the same sequence. It also fixes the order in
 * which balance rows within a branch are touched, which is the canonical order
 * the lock discipline already wants.
 */
function byProductId<T extends { readonly productId: string }>(lines: readonly T[]): readonly T[] {
  return [...lines].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  );
}

/**
 * A validated *plan*, not merely validated lines.
 *
 * The branch ids travel with the lines because the authority needs canonical
 * identity for every id it locks, writes and returns — not just the ones that
 * happen to be inside a line. Returning a plan is what makes canonicalization
 * structural: the authority consumes this and has no reason to reach back for
 * the raw request, so it cannot accidentally lock `018F…` and write `018f…`.
 */
export interface ValidatedAdjustmentLine {
  readonly productId: string;
  readonly deltaQuantityScaled: bigint;
}

export interface ValidatedAdjustment {
  readonly branchId: string;
  readonly reason: string;
  readonly lines: readonly ValidatedAdjustmentLine[];
}

export function validateAdjustmentRequest(request: AdjustmentRequest): ValidatedAdjustment {
  assertReason(request.reason, true);
  const branchId = canonicalUuid(request.branchId, 'branchId');
  // Canonical *before* the duplicate check, so one product spelled two ways is
  // one product here rather than a unique-index violation later.
  const products = request.lines.map((line) => canonicalUuid(line.productId, 'productId'));
  assertDistinctProducts(products);

  const lines = byProductId(
    request.lines.map((line, index) => ({ ...line, productId: products[index] ?? '' })),
  ).map((line) => {
    const delta = parseSignedScaled(line.deltaQuantityScaled, 'deltaQuantityScaled');
    // A zero delta is not an adjustment. Writing a document and a ledger row
    // that move nothing would put noise into the causal history that a later
    // reconciliation has to explain away.
    if (delta === 0n) {
      throw new StockRequestError('zero-delta', 'An adjustment line must move a non-zero amount.');
    }
    return { productId: line.productId, deltaQuantityScaled: delta };
  });

  return { branchId, reason: request.reason.trim(), lines };
}

export interface ValidatedCountLine {
  readonly productId: string;
  readonly countedQuantityScaled: bigint;
  readonly expectedRevision: bigint;
}

export interface ValidatedCount {
  readonly branchId: string;
  readonly reason: string | null;
  readonly lines: readonly ValidatedCountLine[];
}

export function validateCountRequest(request: CountRequest): ValidatedCount {
  assertReason(request.reason, false);
  const branchId = canonicalUuid(request.branchId, 'branchId');
  const products = request.lines.map((line) => canonicalUuid(line.productId, 'productId'));
  assertDistinctProducts(products);

  const lines = byProductId(
    request.lines.map((line, index) => ({ ...line, productId: products[index] ?? '' })),
  ).map((line) => {
    const counted = parseSignedScaled(line.countedQuantityScaled, 'countedQuantityScaled');
    // You cannot observe less than nothing on a shelf. A negative count is a
    // typo or an attempt to post an adjustment through the count path, which
    // is the one path where the client does not get to state the delta.
    if (counted < 0n) {
      throw new StockRequestError('negative-count', 'A counted quantity cannot be negative.');
    }
    return {
      productId: line.productId,
      countedQuantityScaled: counted,
      expectedRevision: parseRevision(line.expectedRevision),
    };
  });

  return {
    branchId,
    reason: request.reason === null ? null : request.reason.trim(),
    lines,
  };
}

export interface ValidatedTransferLine {
  readonly productId: string;
  readonly quantityScaled: bigint;
}

export interface ValidatedTransfer {
  readonly fromBranchId: string;
  readonly toBranchId: string;
  readonly reason: string | null;
  readonly lines: readonly ValidatedTransferLine[];
}

export function validateTransferRequest(request: TransferRequest): ValidatedTransfer {
  assertReason(request.reason, false);
  const fromBranchId = canonicalUuid(request.fromBranchId, 'fromBranchId');
  const toBranchId = canonicalUuid(request.toBranchId, 'toBranchId');
  // Compared canonically, so one branch spelled two ways is caught here as the
  // typed refusal rather than by the table's CHECK constraint.
  if (fromBranchId === toBranchId) {
    throw new StockRequestError('same-branch', 'A transfer must have two different branches.');
  }
  const products = request.lines.map((line) => canonicalUuid(line.productId, 'productId'));
  assertDistinctProducts(products);

  const lines = byProductId(
    request.lines.map((line, index) => ({ ...line, productId: products[index] ?? '' })),
  ).map((line) => {
    const amount = parseSignedScaled(line.quantityScaled, 'quantityScaled');
    // Direction is the pair of branches. A signed quantity here would let one
    // request mean two different transfers depending on how it was read.
    if (amount <= 0n) {
      throw new StockRequestError(
        'non-positive-quantity',
        'A transfer line must move a positive quantity.',
      );
    }
    return { productId: line.productId, quantityScaled: amount };
  });

  return {
    fromBranchId,
    toBranchId,
    reason: request.reason === null ? null : request.reason.trim(),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Canonical fingerprint
// ---------------------------------------------------------------------------

/**
 * What "the same request" means, before it becomes bytes.
 *
 * Idempotency turns on this: the same operation id with the same canonical form
 * is a replay, and with a different one it is a conflict. So the form has to be
 * stable against everything that changes the JSON without changing the intent —
 * property order, line order, whitespace around a reason — and sensitive to
 * everything that does change it.
 *
 * These functions return the canonical *form*; the digest is taken in the
 * infrastructure layer, because `node:crypto` in the domain would break the
 * purity rule ADR-0001 enforces. The part worth testing is here: what counts as
 * the same intent is a domain decision, and hashing it is not.
 *
 * Arrays, not objects, so field order is this module's and not
 * `JSON.stringify`'s view of an object literal. Lines are sorted by product id,
 * because two clients listing the same products in a different order are asking
 * for the same thing and must not be told they conflict. Quantities are
 * re-parsed to their canonical integer text, so "007" and "7" are one intent.
 *
 * The actor is bound in by the caller for the reason ADR-0017 gives for drawer
 * movements: without it, one cashier replaying a colleague's operation id would
 * be handed that colleague's committed document.
 */
function normalizedReason(reason: string | null): string | null {
  const trimmed = reason === null ? null : reason.trim();
  return trimmed === '' ? null : trimmed;
}

function sortedByProduct(lines: readonly (readonly string[])[]): readonly (readonly string[])[] {
  return [...lines].sort((a, b) => {
    const left = a[0] ?? '';
    const right = b[0] ?? '';
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function canonicalAdjustmentForm(request: AdjustmentRequest): readonly unknown[] {
  return [
    'inventory-adjustment.v1',
    canonicalUuid(request.branchId, 'branchId'),
    normalizedReason(request.reason),
    sortedByProduct(
      request.lines.map((line) => [
        canonicalUuid(line.productId, 'productId'),
        parseSignedScaled(line.deltaQuantityScaled, 'deltaQuantityScaled').toString(),
      ]),
    ),
  ];
}

export function canonicalCountForm(request: CountRequest): readonly unknown[] {
  return [
    'inventory-count.v1',
    canonicalUuid(request.branchId, 'branchId'),
    normalizedReason(request.reason),
    sortedByProduct(
      request.lines.map((line) => [
        canonicalUuid(line.productId, 'productId'),
        parseSignedScaled(line.countedQuantityScaled, 'countedQuantityScaled').toString(),
        parseRevision(line.expectedRevision).toString(),
      ]),
    ),
  ];
}

export function canonicalTransferForm(request: TransferRequest): readonly unknown[] {
  return [
    'inventory-transfer.v1',
    canonicalUuid(request.fromBranchId, 'fromBranchId'),
    canonicalUuid(request.toBranchId, 'toBranchId'),
    normalizedReason(request.reason),
    sortedByProduct(
      request.lines.map((line) => [
        canonicalUuid(line.productId, 'productId'),
        parseSignedScaled(line.quantityScaled, 'quantityScaled').toString(),
      ]),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Scopes, causality and audit vocabulary
// ---------------------------------------------------------------------------

export const STOCK_IDEMPOTENCY_SCOPES = {
  adjustment: 'inventory-adjustment',
  count: 'inventory-count',
  transfer: 'inventory-transfer',
} as const;

/**
 * What a Stage-5 movement points back at.
 *
 * `sourceType` names the document kind and `sourceId` the document, exactly as
 * a sale movement points at its sale. A count posts `kind='adjustment'` because
 * the ledger's vocabulary describes the *stock effect*, and a count that finds a
 * discrepancy adjusts stock — the source type is what says it came from a
 * count rather than from somebody typing a delta (ADR-0024 §5).
 */
export const STOCK_SOURCE_TYPES = {
  adjustment: 'inventory-adjustment',
  count: 'inventory-count',
  transfer: 'inventory-transfer',
} as const;

export const STOCK_AUDIT_EVENTS = {
  adjustment: 'inventory.adjustment.finalized',
  count: 'inventory.count.finalized',
  transfer: 'inventory.transfer.finalized',
} as const;

/** The refusals the stock authority can give, as a closed vocabulary. */
export const STOCK_AUTHORITY_REFUSALS = [
  'unknown-branch',
  'inactive-branch',
  'unknown-product',
  'inactive-product',
  'untracked-product',
  'insufficient-stock',
  'stock-changed',
  'idempotency-conflict',
] as const;

export type StockAuthorityRefusal = (typeof STOCK_AUTHORITY_REFUSALS)[number];
