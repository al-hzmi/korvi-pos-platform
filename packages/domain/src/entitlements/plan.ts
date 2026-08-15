import { DomainError } from '../errors.js';

/**
 * Commercial access is deliberately separate from tenant lifecycle.
 *
 * Tenant lifecycle answers whether the merchant itself may operate.
 * This module answers which plan capabilities that merchant is entitled to.
 * A suspended tenant does not become active because an entitlement says yes,
 * and a restricted commercial account does not rewrite tenant lifecycle.
 */
export class CommercialEntitlementError extends DomainError {
  public override readonly name = 'CommercialEntitlementError';
}

export const COMMERCIAL_ACCOUNT_STATES = ['active', 'restricted'] as const;
export type CommercialAccountState = (typeof COMMERCIAL_ACCOUNT_STATES)[number];

export const ENTITLEMENT_KINDS = ['flag', 'limit'] as const;
export type EntitlementKind = (typeof ENTITLEMENT_KINDS)[number];

export const MAX_PLAN_KEY_LENGTH = 64;
export const MAX_ENTITLEMENT_KEY_LENGTH = 96;
export const MAX_PLAN_REVISION = 2_147_483_647;
export const MAX_ENTITLEMENT_LIMIT = 9_223_372_036_854_775_807n;

const KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function normalizeKey(value: string, label: string, maxLength: number): string {
  const key = value.normalize('NFKC').trim().toLowerCase();
  if (key === '' || key.length > maxLength || !KEY_PATTERN.test(key)) {
    throw new CommercialEntitlementError(`${label} is not a valid Korvi key.`);
  }
  return key;
}

export function normalizePlanKey(value: string): string {
  return normalizeKey(value, 'Plan key', MAX_PLAN_KEY_LENGTH);
}

export function normalizeEntitlementKey(value: string): string {
  return normalizeKey(value, 'Entitlement key', MAX_ENTITLEMENT_KEY_LENGTH);
}

export function normalizePlanRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PLAN_REVISION) {
    throw new CommercialEntitlementError('Plan revision must be a positive PostgreSQL integer.');
  }
  return value;
}

export function normalizeCommercialAccountState(value: string): CommercialAccountState {
  const match = COMMERCIAL_ACCOUNT_STATES.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new CommercialEntitlementError(`Unknown commercial account state: ${value}.`);
  }
  return match;
}

export interface FlagEntitlement {
  readonly key: string;
  readonly kind: 'flag';
  readonly enabled: boolean;
}

export interface LimitEntitlement {
  readonly key: string;
  readonly kind: 'limit';
  readonly limit: bigint;
}

export type EntitlementGrant = FlagEntitlement | LimitEntitlement;

export function normalizeEntitlements(
  input: readonly EntitlementGrant[],
): readonly EntitlementGrant[] {
  const seen = new Set<string>();
  const out: EntitlementGrant[] = [];

  for (const raw of input) {
    const key = normalizeEntitlementKey(raw.key);
    if (seen.has(key)) {
      throw new CommercialEntitlementError(`Entitlement "${key}" appears more than once.`);
    }
    seen.add(key);

    if (raw.kind === 'flag') {
      if (typeof raw.enabled !== 'boolean') {
        throw new CommercialEntitlementError(`Flag entitlement "${key}" needs a boolean value.`);
      }
      out.push({ key, kind: 'flag', enabled: raw.enabled });
      continue;
    }

    if (raw.kind === 'limit') {
      if (raw.limit < 0n || raw.limit > MAX_ENTITLEMENT_LIMIT) {
        throw new CommercialEntitlementError(
          `Limit entitlement "${key}" is outside PostgreSQL BIGINT range.`,
        );
      }
      out.push({ key, kind: 'limit', limit: raw.limit });
      continue;
    }

    throw new CommercialEntitlementError(`Entitlement "${key}" has an unknown kind.`);
  }

  return out.sort((left, right) => {
    if (left.key < right.key) return -1;
    if (left.key > right.key) return 1;
    return 0;
  });
}

export interface CommercialAccountSnapshot {
  readonly assignmentId: string;
  readonly planKey: string;
  readonly planRevision: number;
  readonly state: CommercialAccountState;
  readonly entitlements: readonly EntitlementGrant[];
  readonly assignedAt: string;
}

export type EntitlementDenyReason =
  'unconfigured' | 'account-restricted' | 'not-entitled' | 'disabled';

export type EntitlementDecision =
  | { readonly outcome: 'allow'; readonly grant: EntitlementGrant }
  | { readonly outcome: 'deny'; readonly reason: EntitlementDenyReason };

/**
 * Resolve one entitlement from an immutable commercial snapshot.
 *
 * Missing commercial configuration fails closed. `restricted` also fails
 * closed regardless of the grants retained in the snapshot.
 */
export function evaluateEntitlement(
  account: CommercialAccountSnapshot | null,
  requestedKey: string,
): EntitlementDecision {
  const key = normalizeEntitlementKey(requestedKey);

  if (account === null) return { outcome: 'deny', reason: 'unconfigured' };
  if (account.state !== 'active') {
    return { outcome: 'deny', reason: 'account-restricted' };
  }

  const grant = account.entitlements.find((candidate) => candidate.key === key);
  if (grant === undefined) return { outcome: 'deny', reason: 'not-entitled' };

  if (grant.kind === 'flag' && !grant.enabled) {
    return { outcome: 'deny', reason: 'disabled' };
  }

  return { outcome: 'allow', grant };
}

/**
 * `proposedUsage` is the absolute usage after the requested operation, not a
 * delta. A caller counting branches therefore asks about 6 when creating the
 * sixth branch under a limit of 5.
 */
export function permitsEntitlementUsage(
  decision: EntitlementDecision,
  proposedUsage: bigint,
): boolean {
  if (proposedUsage < 0n || proposedUsage > MAX_ENTITLEMENT_LIMIT) {
    throw new CommercialEntitlementError('Proposed entitlement usage is outside BIGINT range.');
  }
  if (decision.outcome === 'deny') return false;
  if (decision.grant.kind === 'flag') return true;
  return proposedUsage <= decision.grant.limit;
}
