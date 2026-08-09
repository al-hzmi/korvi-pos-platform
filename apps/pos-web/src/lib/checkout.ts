import type { SaleSummary } from './api-types';
import type { CheckoutIntent } from './checkout-flight';
import type { Failure } from './failures';

/**
 * The checkout, as the screen sees it.
 *
 * This is the mirror, not the mechanism. The concurrency boundary and the
 * immutable intent live in `checkout-flight.ts`, because React state cannot be
 * either of those things. What is here drives what the cashier is shown and
 * what they are allowed to touch.
 */

export type CheckoutPhase = 'idle' | 'submitting' | 'succeeded' | 'failed';

export interface CheckoutState {
  readonly phase: CheckoutPhase;
  /** The intent in flight or awaiting a retry. Null when there is nothing claimed. */
  readonly intent: CheckoutIntent | null;
  /** The last attempt may have committed. The basket must not change. */
  readonly attemptOutstanding: boolean;
  readonly sale: SaleSummary | null;
  /** True when the server answered with a sale an earlier attempt created. */
  readonly replayed: boolean;
  readonly failure: Failure | null;
}

export const initialCheckoutState: CheckoutState = {
  phase: 'idle',
  intent: null,
  attemptOutstanding: false,
  sale: null,
  replayed: false,
  failure: null,
};

export type CheckoutEvent =
  | { readonly type: 'submit'; readonly intent: CheckoutIntent }
  | { readonly type: 'succeeded'; readonly sale: SaleSummary; readonly replayed: boolean }
  | { readonly type: 'failed'; readonly failure: Failure }
  | { readonly type: 'dismiss' }
  | { readonly type: 'new-sale' };

export function checkoutReducer(state: CheckoutState, event: CheckoutEvent): CheckoutState {
  switch (event.type) {
    case 'submit':
      return { ...state, phase: 'submitting', intent: event.intent, failure: null };
    case 'succeeded':
      return {
        ...state,
        phase: 'succeeded',
        attemptOutstanding: false,
        sale: event.sale,
        replayed: event.replayed,
        failure: null,
      };
    case 'failed':
      return {
        ...state,
        phase: 'failed',
        // Only an unanswered request leaves the outcome unknown. A 409 or a
        // 422 is a decision the server made and rolled back.
        attemptOutstanding: event.failure.action === 'retry-same',
        // A refusal the cashier can amend retires the intent, exactly as the
        // flight does, so the next attempt is a new one.
        intent:
          event.failure.action === 'retry-same' || event.failure.action === 'blocking'
            ? state.intent
            : null,
        failure: event.failure,
      };
    case 'dismiss':
      return { ...state, phase: 'idle', failure: null };
    case 'new-sale':
      return initialCheckoutState;
  }
}

/** True while a duplicate submit would be a second charge or a lost retry. */
export function submitDisabled(state: CheckoutState): boolean {
  return (
    state.phase === 'submitting' ||
    state.phase === 'succeeded' ||
    state.failure?.action === 'blocking'
  );
}

/**
 * True while nothing about the intent may change.
 *
 * Covers the basket, the quantities, the cash field, the search box and the
 * clear and remove controls. An outstanding attempt is the important case: the
 * retry must be able to resend the same fingerprint, and a cashier who edited
 * the cash amount in between would turn a safe replay into a conflict.
 */
export function intentLocked(state: CheckoutState): boolean {
  return state.phase === 'submitting' || state.phase === 'succeeded' || state.attemptOutstanding;
}

/**
 * True while signing out would abandon a transaction of unknown outcome.
 *
 * A cashier walking away from a sale that may have committed leaves the next
 * person to reconcile it.
 */
export function signOutBlocked(state: CheckoutState): boolean {
  return state.phase === 'submitting' || state.attemptOutstanding;
}
