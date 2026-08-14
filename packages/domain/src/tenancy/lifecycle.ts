import { DomainError } from '../errors.js';

/**
 * What state a merchant's account is in, and which way it may move.
 *
 * Three states, because three is what Korvi can currently enforce:
 *
 *   provisioning — the row exists and its foundation is being laid. Nothing
 *                  authenticates against it. This is the safe default, and it
 *                  is deliberately not `active`: a tenant that becomes usable
 *                  because somebody inserted a row is a tenant nobody decided
 *                  to admit.
 *   active       — the merchant may sign in and sell.
 *   suspended    — the account is stopped. Sessions are revoked at the moment
 *                  of suspension and authentication is refused from then on.
 *
 * `active` is not "onboarding complete". A tenant can be active with no
 * branches, no tills and no products; whether it is *ready to trade* is a
 * different question, and Strike 4D owns it (ADR-0018).
 *
 * Everything not named below fails closed. The transition table is exhaustive
 * on purpose: a lifecycle whose illegal moves are "whatever the code forgot to
 * check" is a lifecycle that will be moved illegally.
 */

export class TenantLifecycleError extends DomainError {
  public override readonly name = 'TenantLifecycleError';
}

export const TENANT_LIFECYCLE_STATES = ['provisioning', 'active', 'suspended'] as const;

export type TenantLifecycleState = (typeof TENANT_LIFECYCLE_STATES)[number];

/** The three privileged moves, named so an audit row can say which happened. */
export const TENANT_TRANSITIONS = ['activate', 'suspend', 'reactivate'] as const;

export type TenantTransition = (typeof TENANT_TRANSITIONS)[number];

interface TransitionRule {
  readonly from: TenantLifecycleState;
  readonly to: TenantLifecycleState;
}

const RULES: Readonly<Record<TenantTransition, TransitionRule>> = {
  activate: { from: 'provisioning', to: 'active' },
  suspend: { from: 'active', to: 'suspended' },
  reactivate: { from: 'suspended', to: 'active' },
};

export function isTenantLifecycleState(value: string): value is TenantLifecycleState {
  return (TENANT_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** The state a transition lands in, or a refusal. Pure and total. */
export function nextTenantState(
  current: TenantLifecycleState,
  transition: TenantTransition,
): TenantLifecycleState {
  const rule = RULES[transition];
  if (rule.from !== current) {
    throw new TenantLifecycleError(
      `A tenant in "${current}" cannot be ${transition}d; that move starts from "${rule.from}".`,
    );
  }
  return rule.to;
}

/**
 * Whether a transition is a no-op replay rather than an illegal move.
 *
 * Re-running `activate` against an already-active tenant is not the same
 * mistake as trying to activate a suspended one: the first is a retry that has
 * already happened, the second is a move the state machine does not have. The
 * caller answers them differently, so it needs them told apart.
 */
export function isAlreadyInTargetState(
  current: TenantLifecycleState,
  transition: TenantTransition,
): boolean {
  return RULES[transition].to === current;
}

/**
 * Who asked, in a form that can be written to an audit row.
 *
 * Deliberately a bounded opaque string rather than a user id. A control-plane
 * operator is not a tenant user, and inventing a `User` row inside the
 * merchant's own data to satisfy a foreign key would put an operator into the
 * merchant's user list — visible, assignable, and wrong (ADR-0018).
 */
export const MAX_CONTROL_PLANE_ACTOR = 120;
export const MAX_CONTROL_PLANE_OPERATION = 120;
export const MAX_LIFECYCLE_REASON = 200;

export function normalizeControlPlaneActor(value: string): string {
  const actor = value.trim();
  if (actor === '') {
    throw new TenantLifecycleError('A privileged tenant operation needs a named actor.');
  }
  if (actor.length > MAX_CONTROL_PLANE_ACTOR) {
    throw new TenantLifecycleError('That control-plane actor reference is too long to record.');
  }
  return actor;
}

/**
 * The caller's own id for one attempt, bounded to what the column can hold.
 *
 * Trimmed for the same reason a reason is: an id that differs from another only
 * by trailing whitespace is the same retry to a human and a different key to a
 * unique index, and the index is the thing deciding whether a second merchant
 * gets created.
 */
export function normalizeControlPlaneOperation(value: string): string {
  const operation = value.trim();
  if (operation === '') {
    throw new TenantLifecycleError('A privileged tenant operation needs an operation id.');
  }
  if (operation.length > MAX_CONTROL_PLANE_OPERATION) {
    throw new TenantLifecycleError('That operation id is too long to record.');
  }
  return operation;
}

/**
 * Suspension needs a reason, and the reason is part of the record.
 *
 * Trimmed and bounded, never truncated: half an explanation on the row that
 * stopped a merchant trading is worse than none, because it reads like the
 * whole one.
 */
export function normalizeSuspensionReason(value: string): string {
  const reason = value.trim();
  if (reason === '') {
    throw new TenantLifecycleError('Suspending a merchant needs a reason.');
  }
  if (reason.length > MAX_LIFECYCLE_REASON) {
    throw new TenantLifecycleError('That suspension reason is too long to record.');
  }
  return reason;
}

/** The audit event a transition emits. One name per move, never a generic one. */
export function lifecycleEventType(transition: TenantTransition): string {
  return transition === 'activate'
    ? 'tenant.activated'
    : transition === 'suspend'
      ? 'tenant.suspended'
      : 'tenant.reactivated';
}
