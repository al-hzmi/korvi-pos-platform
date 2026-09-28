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
  | 'allocation-total-mismatch';

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
  readonly firstReceivedAtMs: number;
  readonly dateKind: LotDateKind | null;
  readonly dateValue: string | null;
  readonly status: LotLifecycleStatus;
}

export interface SelectedLotAllocation {
  readonly lotId: string;
  readonly quantityScaled: bigint;
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
  if (!Number.isSafeInteger(candidate.firstReceivedAtMs) || candidate.firstReceivedAtMs < 0) {
    throw new LotDomainError(
      'invalid-received-at',
      'firstReceivedAtMs must be a non-negative safe integer.',
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
    if (
      candidate.dateKind === 'expiry' &&
      parsed.day !== null &&
      parsed.day < businessDay
    ) {
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
    if (left.candidate.firstReceivedAtMs !== right.candidate.firstReceivedAtMs) {
      return left.candidate.firstReceivedAtMs - right.candidate.firstReceivedAtMs;
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
    if ((entry.quantityScaled > 0n) !== positive) {
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

function observationMap(
  rows: readonly LotCountObservation[],
  field: string,
): Map<string, bigint> {
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
