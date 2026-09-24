import { DomainError, InvalidAmountError } from '../errors.js';
import { allocate } from '../money/allocate.js';
import { mulDivRound } from '../money/rounding.js';
import { BASIS_POINT_SCALE } from '../tax/basis-points.js';

export type PromotionStatus = 'draft' | 'active' | 'paused' | 'archived';
export type PromotionStackingMode = 'stackable' | 'exclusive';

export type PromotionEffect =
  | { readonly kind: 'fixed'; readonly amountMinor: bigint }
  | { readonly kind: 'percentage'; readonly basisPoints: bigint };

export type PromotionTarget =
  | { readonly kind: 'basket' }
  | { readonly kind: 'products'; readonly productIds: readonly string[] };

export interface CouponActivationSnapshot {
  readonly couponId: string;
  readonly normalizedCode: string;
}

export interface PromotionCandidate {
  readonly promotionId: string;
  readonly revision: bigint;
  readonly merchantCode: string;
  readonly name: string;
  readonly status: PromotionStatus;
  readonly priority: number;
  readonly stackingMode: PromotionStackingMode;
  readonly startsAtMs: number | null;
  readonly endsAtMs: number | null;
  readonly effect: PromotionEffect;
  readonly minimumEligibleSubtotalMinor: bigint;
  readonly target: PromotionTarget;
  /**
   * Present only when this candidate was activated by a server-resolved coupon.
   * The evaluator never parses a coupon code or decides redemption availability.
   */
  readonly coupon: CouponActivationSnapshot | null;
}

export interface PromotionCartLine {
  readonly lineId: string;
  readonly productId: string;
  /** Gross price before any promotion, in integer minor units. */
  readonly grossMinor: bigint;
}

export interface PromotionAllocation {
  readonly lineId: string;
  readonly amountMinor: bigint;
}

export interface AppliedPromotion {
  readonly promotionId: string;
  readonly revision: bigint;
  readonly merchantCode: string;
  readonly name: string;
  readonly priority: number;
  readonly stackingMode: PromotionStackingMode;
  readonly effect: PromotionEffect;
  readonly eligibleBaseMinor: bigint;
  readonly amountMinor: bigint;
  readonly coupon: CouponActivationSnapshot | null;
  readonly allocations: readonly PromotionAllocation[];
}

export interface PromotionEvaluation {
  readonly applications: readonly AppliedPromotion[];
  readonly totalDiscountMinor: bigint;
  readonly lineDiscounts: readonly PromotionAllocation[];
}

export class InvalidPromotionDefinitionError extends DomainError {
  public override readonly name = 'InvalidPromotionDefinitionError';
}

export const MAX_APPLIED_PROMOTIONS = 8;

function validateLines(lines: readonly PromotionCartLine[]): void {
  if (lines.length === 0) {
    throw new InvalidAmountError('Promotion evaluation requires at least one cart line.');
  }
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.lineId)) {
      throw new InvalidPromotionDefinitionError('Promotion cart line ids must be unique.');
    }
    seen.add(line.lineId);
    if (line.grossMinor < 0n) {
      throw new InvalidAmountError('Promotion cart line gross must not be negative.');
    }
  }
}

function validateCandidates(candidates: readonly PromotionCandidate[]): void {
  const promotionIds = new Set<string>();
  const couponIds = new Set<string>();

  for (const candidate of candidates) {
    if (promotionIds.has(candidate.promotionId)) {
      throw new InvalidPromotionDefinitionError('Promotion candidates must have unique ids.');
    }
    promotionIds.add(candidate.promotionId);

    if (!Number.isSafeInteger(candidate.priority)) {
      throw new InvalidPromotionDefinitionError('Promotion priority must be a safe integer.');
    }
    if (candidate.revision <= 0n) {
      throw new InvalidPromotionDefinitionError('Promotion revision must be positive.');
    }
    if (candidate.minimumEligibleSubtotalMinor < 0n) {
      throw new InvalidPromotionDefinitionError('Promotion minimum subtotal must not be negative.');
    }
    if (
      candidate.startsAtMs !== null &&
      (!Number.isSafeInteger(candidate.startsAtMs) || candidate.startsAtMs < 0)
    ) {
      throw new InvalidPromotionDefinitionError('Promotion start time is invalid.');
    }
    if (
      candidate.endsAtMs !== null &&
      (!Number.isSafeInteger(candidate.endsAtMs) || candidate.endsAtMs < 0)
    ) {
      throw new InvalidPromotionDefinitionError('Promotion end time is invalid.');
    }
    if (
      candidate.startsAtMs !== null &&
      candidate.endsAtMs !== null &&
      candidate.endsAtMs <= candidate.startsAtMs
    ) {
      throw new InvalidPromotionDefinitionError('Promotion end must be after its start.');
    }

    if (candidate.effect.kind === 'fixed') {
      if (candidate.effect.amountMinor <= 0n) {
        throw new InvalidPromotionDefinitionError('Fixed promotion amount must be positive.');
      }
    } else if (
      candidate.effect.basisPoints <= 0n ||
      candidate.effect.basisPoints > BASIS_POINT_SCALE
    ) {
      throw new InvalidPromotionDefinitionError(
        'Percentage promotion must be between 1 and 10000 basis points.',
      );
    }

    if (candidate.target.kind === 'products') {
      if (candidate.target.productIds.length === 0) {
        throw new InvalidPromotionDefinitionError(
          'Product-targeted promotion requires at least one product.',
        );
      }
      if (new Set(candidate.target.productIds).size !== candidate.target.productIds.length) {
        throw new InvalidPromotionDefinitionError(
          'Product-targeted promotion must not repeat a product.',
        );
      }
    }

    if (candidate.coupon !== null) {
      if (candidate.coupon.normalizedCode.trim() !== candidate.coupon.normalizedCode) {
        throw new InvalidPromotionDefinitionError('Coupon snapshot code must already be normalized.');
      }
      if (couponIds.has(candidate.coupon.couponId)) {
        throw new InvalidPromotionDefinitionError(
          'One coupon instrument cannot activate multiple candidates in one evaluation.',
        );
      }
      couponIds.add(candidate.coupon.couponId);
    }
  }
}

function activeAt(candidate: PromotionCandidate, evaluatedAtMs: number): boolean {
  if (candidate.status !== 'active') return false;
  if (candidate.startsAtMs !== null && evaluatedAtMs < candidate.startsAtMs) return false;
  if (candidate.endsAtMs !== null && evaluatedAtMs >= candidate.endsAtMs) return false;
  return true;
}

function ordered(candidates: readonly PromotionCandidate[]): PromotionCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.promotionId.localeCompare(b.promotionId);
  });
}

function eligibleIndexes(
  candidate: PromotionCandidate,
  lines: readonly PromotionCartLine[],
  remaining: readonly bigint[],
): number[] {
  if (candidate.target.kind === 'basket') {
    return lines.map((_line, index) => index).filter((index) => (remaining[index] ?? 0n) > 0n);
  }

  const allowed = new Set(candidate.target.productIds);
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => allowed.has(line.productId) && (remaining[index] ?? 0n) > 0n)
    .map(({ index }) => index);
}

function calculateAmount(effect: PromotionEffect, eligibleBaseMinor: bigint): bigint {
  if (effect.kind === 'fixed') {
    return effect.amountMinor > eligibleBaseMinor ? eligibleBaseMinor : effect.amountMinor;
  }
  const amount = mulDivRound(eligibleBaseMinor, effect.basisPoints, BASIS_POINT_SCALE);
  return amount > eligibleBaseMinor ? eligibleBaseMinor : amount;
}

function applicationFor(
  candidate: PromotionCandidate,
  lines: readonly PromotionCartLine[],
  remaining: readonly bigint[],
): AppliedPromotion | null {
  const indexes = eligibleIndexes(candidate, lines, remaining);
  if (indexes.length === 0) return null;

  const weights = indexes.map((index) => remaining[index] ?? 0n);
  const eligibleBaseMinor = weights.reduce((sum, value) => sum + value, 0n);
  if (
    eligibleBaseMinor <= 0n ||
    eligibleBaseMinor < candidate.minimumEligibleSubtotalMinor
  ) {
    return null;
  }

  const amountMinor = calculateAmount(candidate.effect, eligibleBaseMinor);
  if (amountMinor <= 0n) return null;

  const shares = allocate(amountMinor, weights);
  const allocations = indexes
    .map((index, localIndex): PromotionAllocation => ({
      lineId: lines[index]?.lineId ?? '',
      amountMinor: shares[localIndex] ?? 0n,
    }))
    .filter((allocation) => allocation.amountMinor > 0n);

  if (
    allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0n) !==
    amountMinor
  ) {
    throw new Error('Promotion allocation invariant failed.');
  }

  return {
    promotionId: candidate.promotionId,
    revision: candidate.revision,
    merchantCode: candidate.merchantCode,
    name: candidate.name,
    priority: candidate.priority,
    stackingMode: candidate.stackingMode,
    effect: candidate.effect,
    eligibleBaseMinor,
    amountMinor,
    coupon: candidate.coupon,
    allocations,
  };
}

function applyToRemaining(
  application: AppliedPromotion,
  lines: readonly PromotionCartLine[],
  remaining: bigint[],
): void {
  const indexByLine = new Map(lines.map((line, index) => [line.lineId, index] as const));
  for (const allocation of application.allocations) {
    const index = indexByLine.get(allocation.lineId);
    if (index === undefined) throw new Error('Promotion allocation references an unknown line.');
    const before = remaining[index] ?? 0n;
    if (allocation.amountMinor < 0n || allocation.amountMinor > before) {
      throw new Error('Promotion allocation exceeded the remaining line base.');
    }
    remaining[index] = before - allocation.amountMinor;
  }
}

/**
 * Deterministically evaluate already-resolved merchant promotion policy.
 *
 * Coupon lookup/usage authority is intentionally outside this pure function.
 * The repository supplies a coupon-backed candidate only after resolving the
 * instrument to a tenant promotion; the atomic sale transaction revalidates
 * that instrument and its revision before commit (ADR-0037).
 */
export function evaluatePromotions(input: {
  readonly evaluatedAtMs: number;
  readonly lines: readonly PromotionCartLine[];
  readonly candidates: readonly PromotionCandidate[];
  readonly maxAppliedPromotions?: number;
}): PromotionEvaluation {
  if (!Number.isSafeInteger(input.evaluatedAtMs) || input.evaluatedAtMs < 0) {
    throw new InvalidPromotionDefinitionError('Promotion evaluation time is invalid.');
  }
  validateLines(input.lines);
  validateCandidates(input.candidates);

  const maxApplied = input.maxAppliedPromotions ?? MAX_APPLIED_PROMOTIONS;
  if (!Number.isSafeInteger(maxApplied) || maxApplied <= 0 || maxApplied > MAX_APPLIED_PROMOTIONS) {
    throw new InvalidPromotionDefinitionError(
      `Applied promotion bound must be between 1 and ${String(MAX_APPLIED_PROMOTIONS)}.`,
    );
  }

  const active = ordered(input.candidates.filter((candidate) => activeAt(candidate, input.evaluatedAtMs)));
  const original = input.lines.map((line) => line.grossMinor);
  const exclusive = active.filter((candidate) => candidate.stackingMode === 'exclusive');

  let applications: AppliedPromotion[] = [];

  if (exclusive.length > 0) {
    // Eligibility/effect is checked against the same original cart for every
    // exclusive candidate. The first policy by priority/id wins; discount size
    // never becomes an implicit priority rule the merchant did not configure.
    for (const candidate of exclusive) {
      const application = applicationFor(candidate, input.lines, original);
      if (application !== null) {
        applications = [application];
        break;
      }
    }
  } else {
    const remaining = [...original];
    for (const candidate of active) {
      if (applications.length >= maxApplied) break;
      const application = applicationFor(candidate, input.lines, remaining);
      if (application === null) continue;
      applications.push(application);
      applyToRemaining(application, input.lines, remaining);
    }
  }

  const lineTotals = new Map(input.lines.map((line) => [line.lineId, 0n] as const));
  for (const application of applications) {
    for (const allocation of application.allocations) {
      lineTotals.set(allocation.lineId, (lineTotals.get(allocation.lineId) ?? 0n) + allocation.amountMinor);
    }
  }

  const lineDiscounts = input.lines.map((line) => ({
    lineId: line.lineId,
    amountMinor: lineTotals.get(line.lineId) ?? 0n,
  }));
  const totalDiscountMinor = applications.reduce(
    (sum, application) => sum + application.amountMinor,
    0n,
  );

  if (
    lineDiscounts.reduce((sum, allocation) => sum + allocation.amountMinor, 0n) !==
    totalDiscountMinor
  ) {
    throw new Error('Promotion plan does not reconcile to its line allocations.');
  }

  return { applications, totalDiscountMinor, lineDiscounts };
}
