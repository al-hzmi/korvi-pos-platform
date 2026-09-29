import { DomainError } from '../errors.js';
import { canonicalUuid } from './stock.js';

export type LotDateKind = 'expiry' | 'best-before';
export type LotSelectionPolicy = 'fefo' | 'fifo';
export type LotLifecycleStatus = 'active' | 'blocked' | 'closed';

export type LotDomainRefusal =
  | 'invalid-date'
  | 'invalid-quantity'
  | 'invalid-received-at'
  | 'invalid-date-shape'
  | 'duplicate-lot'
  | 'insufficient-eligible-lot'
  | 'zero-allocation'
  | 'allocation-sign-mismatch'
  | 'allocation-total-mismatch'
  | 'unknown-original-lot'
  | 'return-exceeds-original';

export class LotDomainError extends DomainError {
  public override readonly name = 'LotDomainError';
  public constructor(
    public readonly detail: LotDomainRefusal,
    message: string,
  ) {
    super(message);
  }
}

export interface LotAvailabilityCandidate {
  readonly lotId: string;
  readonly availableQuantityScaled: bigint;
  readonly firstObservedAtMs: number;
  readonly dateKind: LotDateKind | null;
  readonly dateValue: string | null;
  readonly status: LotLifecycleStatus;
}

export interface SelectedLotAllocation {
  readonly lotId: string;
  readonly quantityScaled: bigint;
}

export interface HistoricalLotReturnInput {
  readonly original: readonly SelectedLotAllocation[];
  readonly previouslyReturned: readonly SelectedLotAllocation[];
  readonly returnQuantityScaled: bigint;
}

export interface LotCountObservation {
  readonly lotId: string;
  readonly quantityScaled: bigint;
}

export interface LotCountDelta {
  readonly lotId: string;
  readonly beforeQuantityScaled: bigint;
  readonly countedQuantityScaled: bigint;
  readonly deltaQuantityScaled: bigint;
}

export interface LotCountPlan {
  readonly lines: readonly LotCountDelta[];
  readonly totalBeforeQuantityScaled: bigint;
  readonly totalCountedQuantityScaled: bigint;
  readonly totalDeltaQuantityScaled: bigint;
  readonly isZeroNetReclassification: boolean;
}

export interface LotCountExecutionPlan {
  /** Signed zero-sum distribution correction; no InventoryMovement. */
  readonly reclassification: readonly SelectedLotAllocation[];
  /** Same-sign allocations that reconcile exactly to Product stock delta. */
  readonly movement: readonly SelectedLotAllocation[];
  readonly totalDeltaQuantityScaled: bigint;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseCalendarDate(value: string, field = 'date'): number {
  const match = DATE_PATTERN.exec(value);
  if (match === null) {
    throw new LotDomainError('invalid-date', `${field} must be YYYY-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const millis = Date.UTC(year, month - 1, day);
  const parsed = new Date(millis);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new LotDomainError('invalid-date', `${field} is not a real calendar date.`);
  }
  return Math.trunc(millis / 86_400_000);
}

export type LotDateState = 'unknown' | 'eligible' | 'expired' | 'past-best-before';

export function lotDateState(
  dateKind: LotDateKind | null,
  dateValue: string | null,
  businessDate: string,
): LotDateState {
  const today = parseCalendarDate(businessDate, 'businessDate');
  if ((dateKind === null) !== (dateValue === null)) {
    throw new LotDomainError(
      'invalid-date-shape',
      'dateKind and dateValue must either both be present or both be absent.',
    );
  }
  if (dateKind === null || dateValue === null) return 'unknown';
  const lotDay = parseCalendarDate(dateValue, 'dateValue');
  if (lotDay >= today) return 'eligible';
  return dateKind === 'expiry' ? 'expired' : 'past-best-before';
}

function assertCandidate(candidate: LotAvailabilityCandidate): {
  readonly id: string;
  readonly day: number | null;
} {
  const id = canonicalUuid(candidate.lotId, 'lotId');
  if (candidate.availableQuantityScaled < 0n) {
    throw new LotDomainError(
      'invalid-quantity',
      'Lot availability cannot be negative in an automatic-selection candidate.',
    );
  }
  if (!Number.isSafeInteger(candidate.firstObservedAtMs) || candidate.firstObservedAtMs < 0) {
    throw new LotDomainError(
      'invalid-received-at',
      'firstObservedAtMs must be a non-negative safe integer.',
    );
  }
  if ((candidate.dateKind === null) !== (candidate.dateValue === null)) {
    throw new LotDomainError(
      'invalid-date-shape',
      'dateKind and dateValue must either both be present or both be absent.',
    );
  }
  return {
    id,
    day: candidate.dateValue === null ? null : parseCalendarDate(candidate.dateValue, 'dateValue'),
  };
}

export function selectLotAllocations(input: {
  readonly requiredQuantityScaled: bigint;
  readonly policy: LotSelectionPolicy;
  readonly businessDate: string;
  readonly candidates: readonly LotAvailabilityCandidate[];
}): readonly SelectedLotAllocation[] {
  if (input.requiredQuantityScaled <= 0n) {
    throw new LotDomainError(
      'invalid-quantity',
      'Lot selection requires a positive base quantity.',
    );
  }
  const businessDay = parseCalendarDate(input.businessDate, 'businessDate');
  const seen = new Set<string>();
  const eligible = input.candidates.flatMap((candidate) => {
    const parsed = assertCandidate(candidate);
    if (seen.has(parsed.id)) {
      throw new LotDomainError('duplicate-lot', 'A lot may appear only once in selection input.');
    }
    seen.add(parsed.id);
    if (candidate.availableQuantityScaled === 0n || candidate.status !== 'active') return [];
    if (candidate.dateKind === 'expiry' && parsed.day !== null && parsed.day < businessDay) {
      return [];
    }
    return [{ candidate, id: parsed.id, day: parsed.day }];
  });

  eligible.sort((left, right) => {
    if (input.policy === 'fefo') {
      const leftUnknown = left.day === null;
      const rightUnknown = right.day === null;
      if (leftUnknown !== rightUnknown) return leftUnknown ? 1 : -1;
      if (left.day !== null && right.day !== null && left.day !== right.day) {
        return left.day - right.day;
      }
    }
    if (left.candidate.firstObservedAtMs !== right.candidate.firstObservedAtMs) {
      return left.candidate.firstObservedAtMs - right.candidate.firstObservedAtMs;
    }
    return left.id.localeCompare(right.id);
  });

  let remaining = input.requiredQuantityScaled;
  const allocations: SelectedLotAllocation[] = [];
  for (const row of eligible) {
    if (remaining === 0n) break;
    const take =
      row.candidate.availableQuantityScaled < remaining
        ? row.candidate.availableQuantityScaled
        : remaining;
    if (take > 0n) {
      allocations.push({ lotId: row.id, quantityScaled: take });
      remaining -= take;
    }
  }
  if (remaining !== 0n) {
    throw new LotDomainError(
      'insufficient-eligible-lot',
      'Eligible lot quantity is insufficient for the requested movement.',
    );
  }
  return allocations;
}

export function allocateOriginalSaleLotReturn(
  input: HistoricalLotReturnInput,
): readonly SelectedLotAllocation[] {
  if (input.returnQuantityScaled <= 0n) {
    throw new LotDomainError('invalid-quantity', 'Lot return quantity must be positive.');
  }

  const originals = new Map<string, bigint>();
  for (const row of input.original) {
    const lotId = canonicalUuid(row.lotId, 'lotId');
    if (originals.has(lotId)) {
      throw new LotDomainError('duplicate-lot', 'Duplicate original lot.');
    }
    if (row.quantityScaled <= 0n) {
      throw new LotDomainError('invalid-quantity', 'Original lot quantity must be positive.');
    }
    originals.set(lotId, row.quantityScaled);
  }
  if (originals.size === 0) {
    throw new LotDomainError(
      'allocation-total-mismatch',
      'Original sale lot allocation is required.',
    );
  }

  const previous = new Map<string, bigint>();
  for (const row of input.previouslyReturned) {
    const lotId = canonicalUuid(row.lotId, 'lotId');
    if (previous.has(lotId)) {
      throw new LotDomainError('duplicate-lot', 'Duplicate returned lot.');
    }
    const originalQuantity = originals.get(lotId);
    if (originalQuantity === undefined) {
      throw new LotDomainError(
        'unknown-original-lot',
        'Returned lot is absent from original sale.',
      );
    }
    if (row.quantityScaled < 0n || row.quantityScaled > originalQuantity) {
      throw new LotDomainError(
        'invalid-quantity',
        'Returned lot quantity is outside original allocation.',
      );
    }
    previous.set(lotId, row.quantityScaled);
  }

  const ordered = [...originals.entries()].sort(([a], [b]) => a.localeCompare(b));
  const originalTotal = ordered.reduce((sum, [, quantity]) => sum + quantity, 0n);
  const previousTotal = ordered.reduce((sum, [lotId]) => sum + (previous.get(lotId) ?? 0n), 0n);
  const cumulativeTarget = previousTotal + input.returnQuantityScaled;
  if (cumulativeTarget > originalTotal) {
    throw new LotDomainError(
      'return-exceeds-original',
      'Cumulative return exceeds original lot quantity.',
    );
  }

  const targets = ordered.map(([lotId, originalQuantity]) => {
    const previousQuantity = previous.get(lotId) ?? 0n;
    const numerator = originalQuantity * cumulativeTarget;
    const floor = numerator / originalTotal;
    return {
      lotId,
      originalQuantity,
      previousQuantity,
      target: previousQuantity > floor ? previousQuantity : floor,
      remainder: numerator % originalTotal,
    };
  });

  const assigned = targets.reduce((sum, row) => sum + row.target, 0n);
  if (assigned > cumulativeTarget) {
    throw new LotDomainError(
      'allocation-total-mismatch',
      'Prior lot returns exceed cumulative target.',
    );
  }
  let residual = cumulativeTarget - assigned;
  const ranked = [...targets].sort((a, b) =>
    a.remainder === b.remainder
      ? a.lotId.localeCompare(b.lotId)
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const row of ranked) {
    if (residual === 0n) break;
    if (row.target >= row.originalQuantity) continue;
    row.target += 1n;
    residual -= 1n;
  }
  if (residual !== 0n) {
    throw new LotDomainError(
      'allocation-total-mismatch',
      'Lot return allocation could not conserve quantity.',
    );
  }

  return targets.flatMap((row) => {
    if (row.target > row.originalQuantity) {
      throw new LotDomainError(
        'return-exceeds-original',
        'Lot return exceeds original allocation.',
      );
    }
    const quantityScaled = row.target - row.previousQuantity;
    return quantityScaled === 0n ? [] : [{ lotId: row.lotId, quantityScaled }];
  });
}

export function assertLotEntriesReconcile(
  movementQuantityScaled: bigint,
  entries: readonly SelectedLotAllocation[],
): void {
  if (movementQuantityScaled === 0n) {
    throw new LotDomainError('invalid-quantity', 'A canonical stock movement cannot be zero.');
  }
  if (entries.length === 0) {
    throw new LotDomainError(
      'allocation-total-mismatch',
      'A lot-controlled movement requires lot allocation entries.',
    );
  }

  const positive = movementQuantityScaled > 0n;
  const seen = new Set<string>();
  let sum = 0n;
  for (const entry of entries) {
    const lotId = canonicalUuid(entry.lotId, 'lotId');
    if (seen.has(lotId)) {
      throw new LotDomainError('duplicate-lot', 'A movement may allocate one lot only once.');
    }
    seen.add(lotId);
    if (entry.quantityScaled === 0n) {
      throw new LotDomainError('zero-allocation', 'A lot allocation cannot be zero.');
    }
    if (entry.quantityScaled > 0n !== positive) {
      throw new LotDomainError(
        'allocation-sign-mismatch',
        'Every lot allocation must use the canonical movement sign.',
      );
    }
    sum += entry.quantityScaled;
  }
  if (sum !== movementQuantityScaled) {
    throw new LotDomainError(
      'allocation-total-mismatch',
      'Lot allocations must sum exactly to the canonical inventory movement.',
    );
  }
}

function observationMap(rows: readonly LotCountObservation[], field: string): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const row of rows) {
    const id = canonicalUuid(row.lotId, 'lotId');
    if (row.quantityScaled < 0n) {
      throw new LotDomainError('invalid-quantity', `${field} quantity cannot be negative.`);
    }
    if (result.has(id)) {
      throw new LotDomainError('duplicate-lot', `${field} contains the same lot twice.`);
    }
    result.set(id, row.quantityScaled);
  }
  return result;
}

export function deriveLotCountPlan(input: {
  readonly current: readonly LotCountObservation[];
  readonly counted: readonly LotCountObservation[];
}): LotCountPlan {
  const current = observationMap(input.current, 'current');
  const counted = observationMap(input.counted, 'counted');
  const ids = [...new Set([...current.keys(), ...counted.keys()])].sort();

  const lines = ids
    .map((lotId): LotCountDelta => {
      const beforeQuantityScaled = current.get(lotId) ?? 0n;
      const countedQuantityScaled = counted.get(lotId) ?? 0n;
      return {
        lotId,
        beforeQuantityScaled,
        countedQuantityScaled,
        deltaQuantityScaled: countedQuantityScaled - beforeQuantityScaled,
      };
    })
    .filter((line) => line.deltaQuantityScaled !== 0n);

  const totalBeforeQuantityScaled = [...current.values()].reduce((sum, value) => sum + value, 0n);
  const totalCountedQuantityScaled = [...counted.values()].reduce((sum, value) => sum + value, 0n);
  const totalDeltaQuantityScaled = totalCountedQuantityScaled - totalBeforeQuantityScaled;

  return {
    lines,
    totalBeforeQuantityScaled,
    totalCountedQuantityScaled,
    totalDeltaQuantityScaled,
    isZeroNetReclassification: totalDeltaQuantityScaled === 0n && lines.length > 0,
  };
}

/**
 * Split physical lot observations into distribution-only correction and the
 * canonical Product movement. This preserves the V2-4 invariant that every lot
 * entry attached to an InventoryMovement has the movement's sign.
 */
export function splitLotCountPlan(plan: LotCountPlan): LotCountExecutionPlan {
  const deltas = [...plan.lines]
    .map((line) => ({ lotId: line.lotId, quantityScaled: line.deltaQuantityScaled }))
    .sort((a, b) => a.lotId.localeCompare(b.lotId));

  if (plan.totalDeltaQuantityScaled === 0n) {
    return {
      reclassification: deltas,
      movement: [],
      totalDeltaQuantityScaled: 0n,
    };
  }

  const positive = deltas.filter((line) => line.quantityScaled > 0n).map((line) => ({ ...line }));
  const negative = deltas.filter((line) => line.quantityScaled < 0n).map((line) => ({ ...line }));

  const reclassification: SelectedLotAllocation[] = [];
  const movement: SelectedLotAllocation[] = [];

  if (plan.totalDeltaQuantityScaled > 0n) {
    // Every observed decrease is distribution correction. Pair it
    // deterministically against observed increases; only the surplus positive
    // quantity is new Product stock.
    let correctionNeeded = negative.reduce((sum, line) => sum - line.quantityScaled, 0n);
    reclassification.push(...negative);

    for (const line of positive) {
      const used = line.quantityScaled < correctionNeeded ? line.quantityScaled : correctionNeeded;
      if (used > 0n) {
        reclassification.push({ lotId: line.lotId, quantityScaled: used });
        correctionNeeded -= used;
      }
      const remainder = line.quantityScaled - used;
      if (remainder > 0n) movement.push({ lotId: line.lotId, quantityScaled: remainder });
    }
  } else {
    // Every observed increase is distribution correction. Pair it against
    // decreases; only the remaining negative quantity leaves Product stock.
    let correctionNeeded = positive.reduce((sum, line) => sum + line.quantityScaled, 0n);
    reclassification.push(...positive);

    for (const line of negative) {
      const available = -line.quantityScaled;
      const used = available < correctionNeeded ? available : correctionNeeded;
      if (used > 0n) {
        reclassification.push({ lotId: line.lotId, quantityScaled: -used });
        correctionNeeded -= used;
      }
      const remainder = available - used;
      if (remainder > 0n) movement.push({ lotId: line.lotId, quantityScaled: -remainder });
    }
  }

  const reclassSum = reclassification.reduce((sum, line) => sum + line.quantityScaled, 0n);
  const movementSum = movement.reduce((sum, line) => sum + line.quantityScaled, 0n);
  if (reclassSum !== 0n || movementSum !== plan.totalDeltaQuantityScaled) {
    throw new LotDomainError(
      'allocation-total-mismatch',
      'Lot count decomposition failed to conserve quantity.',
    );
  }

  return {
    reclassification,
    movement,
    totalDeltaQuantityScaled: plan.totalDeltaQuantityScaled,
  };
}
