import { DomainError } from '../errors.js';
import { canonicalUuid } from '../inventory/stock.js';

/**
 * Pure integer valuation rules for Strike 5C (ADR-0024 §8).
 *
 * Quantity is BIGINT scaled by 1000 and money is BIGINT minor units.  This
 * module intentionally accepts bigint internally and canonical decimal strings
 * only at request boundaries.  There is no floating-point or Decimal path.
 */

export class CostingRequestError extends DomainError {
  public override readonly name = 'CostingRequestError';
  public readonly detail: CostingRequestRefusal;

  public constructor(detail: CostingRequestRefusal, message: string) {
    super(message);
    this.detail = detail;
  }
}

export type CostingRequestRefusal =
  | 'invalid-money'
  | 'invalid-quantity'
  | 'non-positive-quantity'
  | 'invalid-operation-id'
  | 'nothing-to-value';

const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9]\d{0,18})$/;
const POSTGRES_BIGINT_MAX = (1n << 63n) - 1n;

export function parseNonNegativeMinor(value: string, field: string): bigint {
  if (!CANONICAL_UNSIGNED_INTEGER.test(value)) {
    throw new CostingRequestError(
      'invalid-money',
      `${field} must be canonical non-negative integer text.`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > POSTGRES_BIGINT_MAX) {
    throw new CostingRequestError('invalid-money', `${field} exceeds PostgreSQL BIGINT storage.`);
  }
  return parsed;
}

function requireNonNegative(value: bigint, label: string): void {
  if (value < 0n) throw new Error(`Costing invariant failed: ${label} must be non-negative.`);
}

function requirePositive(value: bigint, label: string): void {
  if (value <= 0n) throw new Error(`Costing invariant failed: ${label} must be positive.`);
}

export interface KnownCostPool {
  readonly knownQuantityScaled: bigint;
  readonly knownValueMinor: bigint;
}

/**
 * A cost pool is valid only when zero quantity has zero residual value.  The
 * reverse implication is deliberately not required: zero-value inventory is a
 * legitimate known cost basis (free samples, rebates allocated elsewhere,
 * etc.).
 */
export function assertKnownCostPool(pool: KnownCostPool): void {
  requireNonNegative(pool.knownQuantityScaled, 'knownQuantityScaled');
  requireNonNegative(pool.knownValueMinor, 'knownValueMinor');
  if (pool.knownQuantityScaled === 0n && pool.knownValueMinor !== 0n) {
    throw new Error('Costing invariant failed: zero known quantity cannot retain value.');
  }
}

/**
 * Costing never owns total stock.  It may describe only a subset of current
 * positive on-hand stock.  Negative stock therefore cannot carry a positive
 * inventory asset pool.
 */
export function assertPoolFitsStock(stockQuantityScaled: bigint, pool: KnownCostPool): void {
  assertKnownCostPool(pool);
  const positiveOnHand = stockQuantityScaled > 0n ? stockQuantityScaled : 0n;
  if (pool.knownQuantityScaled > positiveOnHand) {
    throw new Error('Costing invariant failed: known cost quantity exceeds positive stock.');
  }
}

/**
 * Prefix allocation is the sole remainder doctrine.  Every partial allocation
 * is the difference between two prefixes, so the final quantity always owns
 * the exact residual minor units and total value is conserved.
 */
export function prefixAllocatedValue(
  totalValueMinor: bigint,
  totalQuantityScaled: bigint,
  cumulativeQuantityScaled: bigint,
): bigint {
  requireNonNegative(totalValueMinor, 'totalValueMinor');
  requirePositive(totalQuantityScaled, 'totalQuantityScaled');
  requireNonNegative(cumulativeQuantityScaled, 'cumulativeQuantityScaled');
  if (cumulativeQuantityScaled > totalQuantityScaled) {
    throw new Error('Costing invariant failed: cumulative quantity exceeds total quantity.');
  }
  if (cumulativeQuantityScaled === totalQuantityScaled) return totalValueMinor;
  return (totalValueMinor * cumulativeQuantityScaled) / totalQuantityScaled;
}

export function incrementalAllocatedValue(
  totalValueMinor: bigint,
  totalQuantityScaled: bigint,
  beforeCumulativeQuantityScaled: bigint,
  afterCumulativeQuantityScaled: bigint,
): bigint {
  if (afterCumulativeQuantityScaled < beforeCumulativeQuantityScaled) {
    throw new Error('Costing invariant failed: cumulative allocation moved backwards.');
  }
  return (
    prefixAllocatedValue(totalValueMinor, totalQuantityScaled, afterCumulativeQuantityScaled) -
    prefixAllocatedValue(totalValueMinor, totalQuantityScaled, beforeCumulativeQuantityScaled)
  );
}

export interface KnownConsumption extends KnownCostPool {
  readonly consumedKnownQuantityScaled: bigint;
  readonly consumedKnownValueMinor: bigint;
}

/** Consume an exact quantity from the current known-value pool. */
export function consumeKnownCost(pool: KnownCostPool, quantityScaled: bigint): KnownConsumption {
  assertKnownCostPool(pool);
  requireNonNegative(quantityScaled, 'quantityScaled');
  if (quantityScaled > pool.knownQuantityScaled) {
    throw new Error('Costing invariant failed: cannot consume more known quantity than exists.');
  }
  if (quantityScaled === 0n) {
    return {
      ...pool,
      consumedKnownQuantityScaled: 0n,
      consumedKnownValueMinor: 0n,
    };
  }

  const consumedValue =
    quantityScaled === pool.knownQuantityScaled
      ? pool.knownValueMinor
      : (pool.knownValueMinor * quantityScaled) / pool.knownQuantityScaled;
  const remainingQuantity = pool.knownQuantityScaled - quantityScaled;
  const remainingValue = pool.knownValueMinor - consumedValue;

  if (remainingQuantity === 0n && remainingValue !== 0n) {
    throw new Error('Costing invariant failed: final known consumption left residual value.');
  }

  return {
    knownQuantityScaled: remainingQuantity,
    knownValueMinor: remainingValue,
    consumedKnownQuantityScaled: quantityScaled,
    consumedKnownValueMinor: consumedValue,
  };
}

export interface OutflowCostResult extends KnownCostPool {
  readonly knownQuantityConsumedScaled: bigint;
  readonly unknownQuantityConsumedScaled: bigint;
  readonly knownValueConsumedMinor: bigint;
}

/**
 * Outflow consumes unknown positive stock first, then recorded-cost stock.  Any
 * quantity beyond positive on-hand (when the business operation itself permits
 * oversell) is also unknown: Korvi never fabricates value for negative stock.
 */
export function consumeOutflowUnknownFirst(
  stockQuantityScaled: bigint,
  pool: KnownCostPool,
  outgoingQuantityScaled: bigint,
): OutflowCostResult {
  assertPoolFitsStock(stockQuantityScaled, pool);
  requirePositive(outgoingQuantityScaled, 'outgoingQuantityScaled');

  const positiveOnHand = stockQuantityScaled > 0n ? stockQuantityScaled : 0n;
  const positiveUnknown = positiveOnHand - pool.knownQuantityScaled;
  const unknownFromOnHand =
    outgoingQuantityScaled < positiveUnknown ? outgoingQuantityScaled : positiveUnknown;
  const afterUnknown = outgoingQuantityScaled - unknownFromOnHand;
  const knownToConsume =
    afterUnknown < pool.knownQuantityScaled ? afterUnknown : pool.knownQuantityScaled;
  const beyondPositiveStock = afterUnknown - knownToConsume;

  const known = consumeKnownCost(pool, knownToConsume);
  return {
    knownQuantityScaled: known.knownQuantityScaled,
    knownValueMinor: known.knownValueMinor,
    knownQuantityConsumedScaled: knownToConsume,
    unknownQuantityConsumedScaled: unknownFromOnHand + beyondPositiveStock,
    knownValueConsumedMinor: known.consumedKnownValueMinor,
  };
}

export interface KnownInflowResult extends KnownCostPool {
  readonly deficitFilledQuantityScaled: bigint;
  readonly deficitConsumedValueMinor: bigint;
  readonly assetAddedQuantityScaled: bigint;
  readonly assetAddedValueMinor: bigint;
}

/**
 * A known-cost inflow first closes any negative-stock deficit.  The deficit's
 * share of value is immutable catch-up/consumption evidence; only the remainder
 * becomes current inventory asset value.
 */
export function applyKnownInflowAgainstDeficit(
  stockBeforeQuantityScaled: bigint,
  pool: KnownCostPool,
  incomingQuantityScaled: bigint,
  incomingValueMinor: bigint,
): KnownInflowResult {
  assertPoolFitsStock(stockBeforeQuantityScaled, pool);
  requirePositive(incomingQuantityScaled, 'incomingQuantityScaled');
  requireNonNegative(incomingValueMinor, 'incomingValueMinor');

  const deficit = stockBeforeQuantityScaled < 0n ? -stockBeforeQuantityScaled : 0n;
  const deficitFilled = deficit < incomingQuantityScaled ? deficit : incomingQuantityScaled;
  const deficitValue = prefixAllocatedValue(
    incomingValueMinor,
    incomingQuantityScaled,
    deficitFilled,
  );
  const assetQuantity = incomingQuantityScaled - deficitFilled;
  const assetValue = incomingValueMinor - deficitValue;

  const next: KnownCostPool = {
    knownQuantityScaled: pool.knownQuantityScaled + assetQuantity,
    knownValueMinor: pool.knownValueMinor + assetValue,
  };
  assertKnownCostPool(next);

  return {
    ...next,
    deficitFilledQuantityScaled: deficitFilled,
    deficitConsumedValueMinor: deficitValue,
    assetAddedQuantityScaled: assetQuantity,
    assetAddedValueMinor: assetValue,
  };
}

export interface CostBootstrapResult extends KnownCostPool {
  readonly valuedQuantityScaled: bigint;
  readonly addedValueMinor: bigint;
}

/**
 * Prospectively values every currently-unknown positive unit.  The quantity is
 * derived from locked stock/cost state, never stated by the caller.
 */
export function bootstrapUnknownCost(
  stockQuantityScaled: bigint,
  pool: KnownCostPool,
  totalValueMinor: bigint,
): CostBootstrapResult {
  assertPoolFitsStock(stockQuantityScaled, pool);
  requireNonNegative(totalValueMinor, 'totalValueMinor');
  const positiveOnHand = stockQuantityScaled > 0n ? stockQuantityScaled : 0n;
  const unknownQuantity = positiveOnHand - pool.knownQuantityScaled;
  if (unknownQuantity <= 0n) {
    throw new CostingRequestError(
      'nothing-to-value',
      'There is no unknown positive stock to value.',
    );
  }

  return {
    knownQuantityScaled: pool.knownQuantityScaled + unknownQuantity,
    knownValueMinor: pool.knownValueMinor + totalValueMinor,
    valuedQuantityScaled: unknownQuantity,
    addedValueMinor: totalValueMinor,
  };
}

export interface OriginalSaleBasis {
  readonly knownQuantityScaled: bigint;
  readonly unknownQuantityScaled: bigint;
  readonly knownValueMinor: bigint;
}

export interface ReturnBasisAllocation {
  readonly knownQuantityScaled: bigint;
  readonly unknownQuantityScaled: bigint;
  readonly knownValueMinor: bigint;
  readonly cumulativeReturnedQuantityScaled: bigint;
  readonly cumulativeKnownReturnedQuantityScaled: bigint;
}

/**
 * Reversing a sale restores its recorded-cost segment first because the sale
 * consumed unknown stock first.  Value within that known segment uses prefix
 * allocation, so repeated partial returns conserve the original value exactly.
 */
export function allocateOriginalSaleReturnBasis(
  basis: OriginalSaleBasis,
  previouslyReturnedQuantityScaled: bigint,
  returnQuantityScaled: bigint,
): ReturnBasisAllocation {
  requireNonNegative(basis.knownQuantityScaled, 'basis.knownQuantityScaled');
  requireNonNegative(basis.unknownQuantityScaled, 'basis.unknownQuantityScaled');
  requireNonNegative(basis.knownValueMinor, 'basis.knownValueMinor');
  if (basis.knownQuantityScaled === 0n && basis.knownValueMinor !== 0n) {
    throw new Error('Costing invariant failed: unknown-only sale basis cannot carry known value.');
  }
  requireNonNegative(previouslyReturnedQuantityScaled, 'previouslyReturnedQuantityScaled');
  requirePositive(returnQuantityScaled, 'returnQuantityScaled');

  const totalQuantity = basis.knownQuantityScaled + basis.unknownQuantityScaled;
  const afterReturned = previouslyReturnedQuantityScaled + returnQuantityScaled;
  if (afterReturned > totalQuantity) {
    throw new Error('Costing invariant failed: return quantity exceeds original sale basis.');
  }

  const knownBefore =
    previouslyReturnedQuantityScaled < basis.knownQuantityScaled
      ? previouslyReturnedQuantityScaled
      : basis.knownQuantityScaled;
  const knownAfter =
    afterReturned < basis.knownQuantityScaled ? afterReturned : basis.knownQuantityScaled;
  const knownThisReturn = knownAfter - knownBefore;
  const unknownThisReturn = returnQuantityScaled - knownThisReturn;
  const valueThisReturn =
    basis.knownQuantityScaled === 0n
      ? 0n
      : incrementalAllocatedValue(
          basis.knownValueMinor,
          basis.knownQuantityScaled,
          knownBefore,
          knownAfter,
        );

  return {
    knownQuantityScaled: knownThisReturn,
    unknownQuantityScaled: unknownThisReturn,
    knownValueMinor: valueThisReturn,
    cumulativeReturnedQuantityScaled: afterReturned,
    cumulativeKnownReturnedQuantityScaled: knownAfter,
  };
}
export const COST_IDEMPOTENCY_SCOPES = { bootstrap: 'inventory-cost-bootstrap' } as const;

export interface CostBootstrapRequest {
  readonly operationId: string;
  readonly branchId: string;
  readonly productId: string;
  readonly totalValueMinor: string;
}

export interface ValidatedCostBootstrap {
  readonly operationId: string;
  readonly branchId: string;
  readonly productId: string;
  readonly totalValueMinor: bigint;
}

export function validateCostBootstrapRequest(
  request: CostBootstrapRequest,
): ValidatedCostBootstrap {
  const operationId = request.operationId.trim();
  if (operationId.length === 0 || operationId.length > 120) {
    throw new CostingRequestError(
      'invalid-operation-id',
      'operationId must contain between 1 and 120 characters.',
    );
  }
  return {
    operationId,
    branchId: canonicalUuid(request.branchId, 'branchId'),
    productId: canonicalUuid(request.productId, 'productId'),
    totalValueMinor: parseNonNegativeMinor(request.totalValueMinor, 'totalValueMinor'),
  };
}

/** Stable intent form: all UUIDs and integer text are canonical before hashing. */
export function canonicalCostBootstrapForm(request: CostBootstrapRequest): readonly unknown[] {
  const plan = validateCostBootstrapRequest(request);
  return [
    COST_IDEMPOTENCY_SCOPES.bootstrap,
    plan.operationId,
    plan.branchId,
    plan.productId,
    plan.totalValueMinor.toString(),
  ];
}
