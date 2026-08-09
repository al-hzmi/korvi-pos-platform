import type { CheckoutRequest } from './api-types';

/**
 * The concurrency boundary for money leaving a till.
 *
 * A disabled button and a React state flag are user-interface controls. They
 * are not a mutex: `dispatch` schedules a render, it does not update anything
 * synchronously, so two calls to submit in the same tick — a double click, a
 * key repeat, an Enter racing a click — both read the same idle state, both
 * mint their own operation id, and both reach POST /v1/sales. Two different
 * operation ids are two different intents as far as the server is concerned,
 * and the idempotency contract that exists to prevent a double charge is
 * bypassed by construction.
 *
 * So ownership is claimed here, in a plain object held across renders, and it
 * is claimed *before the first await*. The second caller in the same tick gets
 * `null` and issues nothing.
 *
 * The second thing this owns is the intent itself. The server's fingerprint
 * covers branch, terminal, product ids, quantities and cash received; a retry
 * that rebuilt the request from whatever the interface currently holds could
 * therefore replay a *different* intent under the same id, which the server
 * correctly refuses as a conflict. The snapshot taken on the first attempt is
 * what every retry of that attempt resends, unchanged.
 */

export type CheckoutIntent = CheckoutRequest;

/**
 * What the server said, reduced to the only question that matters here: may
 * the cashier change the basket now?
 *
 *   succeeded  the sale exists; the intent stays claimed so a stray resubmit
 *              replays it rather than ringing up another
 *   ambiguous  nobody knows; the intent is frozen and may only be resent
 *   amendable  the server decided and rolled back, so nothing was recorded and
 *              the intent is retired — the next attempt is a new one
 *   blocked    a conflict a human has to resolve; no further attempts
 */
export type FlightOutcome = 'succeeded' | 'ambiguous' | 'amendable' | 'blocked';

export interface CheckoutFlight {
  /**
   * Claim the flight, synchronously.
   *
   * Returns the intent to send, or null when one is already in flight or the
   * flight is blocked. `build` is called only when there is no intent to
   * replay, so a retry can never be rebuilt from mutable state.
   */
  begin(build: () => CheckoutIntent): CheckoutIntent | null;
  settle(outcome: FlightOutcome): void;
  /** The intent a retry would send, if there is one. */
  pending(): CheckoutIntent | null;
  running(): boolean;
  /** True while an attempt may or may not have committed. */
  outstanding(): boolean;
  blocked(): boolean;
  /** A new basket. Everything is forgotten. */
  reset(): void;
}

/** Frozen deeply enough that a caller holding a reference cannot edit it. */
function freeze(intent: CheckoutIntent): CheckoutIntent {
  return Object.freeze({
    operationId: intent.operationId,
    terminalId: intent.terminalId,
    cashReceivedMinor: intent.cashReceivedMinor,
    lines: Object.freeze(
      intent.lines.map((line) =>
        Object.freeze({ productId: line.productId, quantityScaled: line.quantityScaled }),
      ),
    ),
  });
}

export function createCheckoutFlight(): CheckoutFlight {
  let inFlight = false;
  let intent: CheckoutIntent | null = null;
  let ambiguous = false;
  let stopped = false;

  return {
    begin(build) {
      if (inFlight || stopped) return null;
      // An existing intent is replayed verbatim. This is the line that makes a
      // retry a retry rather than a second sale.
      const next = intent ?? freeze(build());
      intent = next;
      inFlight = true;
      return next;
    },

    settle(outcome) {
      inFlight = false;
      switch (outcome) {
        case 'succeeded':
          ambiguous = false;
          return;
        case 'ambiguous':
          ambiguous = true;
          return;
        case 'amendable':
          // The server refused and rolled back, so the operation id was never
          // recorded. Retiring it means the amended basket goes out under a
          // fresh one, which can never collide with anything.
          ambiguous = false;
          intent = null;
          return;
        case 'blocked':
          ambiguous = false;
          stopped = true;
          return;
      }
    },

    pending: () => intent,
    running: () => inFlight,
    outstanding: () => ambiguous,
    blocked: () => stopped,

    reset() {
      inFlight = false;
      intent = null;
      ambiguous = false;
      stopped = false;
    },
  };
}

/** The server's answer, classified for the flight. */
export function outcomeFor(action: string): FlightOutcome {
  if (action === 'retry-same') return 'ambiguous';
  if (action === 'blocking') return 'blocked';
  return 'amendable';
}
