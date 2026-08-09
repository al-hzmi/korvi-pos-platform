import { newId } from '@korvi/domain';
import { outcomeFor } from './checkout-flight';
import { describeFailure } from './failures';
import { cartToRequestLines } from './cart';
import type { CheckoutResponse } from './api-types';
import type { CartLine } from './cart';
import type { CheckoutEvent } from './checkout';
import type { CheckoutFlight, CheckoutIntent } from './checkout-flight';

/**
 * One checkout attempt, start to finish.
 *
 * Deliberately outside React. The hook that calls this is a four-line wrapper
 * holding the flight in a ref and passing `dispatch`; everything that decides
 * whether a request goes out, what it contains, and what the outcome means to
 * the next attempt is here, where it can be driven directly and where its
 * concurrency does not depend on when a renderer happens to commit.
 */
export interface CheckoutSubmission {
  readonly terminalId: string;
  readonly lines: readonly CartLine[];
  readonly cashReceivedMinor: string;
}

export interface CheckoutRunner {
  checkout(intent: CheckoutIntent): Promise<CheckoutResponse>;
}

export function runCheckout(
  api: CheckoutRunner,
  flight: CheckoutFlight,
  input: CheckoutSubmission,
  dispatch: (event: CheckoutEvent) => void,
  onUnauthenticated: () => void,
  mint: () => string = newId,
): Promise<void> {
  // Claimed synchronously, before anything can await and before the renderer
  // is involved. A second call in this tick gets null and sends nothing.
  const intent = flight.begin(() => ({
    operationId: mint(),
    terminalId: input.terminalId,
    cashReceivedMinor: input.cashReceivedMinor,
    lines: cartToRequestLines(input.lines),
  }));
  if (intent === null) return Promise.resolve();
  if (intent.lines.length === 0) {
    flight.settle('amendable');
    return Promise.resolve();
  }

  dispatch({ type: 'submit', intent });

  return api
    .checkout(intent)
    .then((response) => {
      flight.settle('succeeded');
      dispatch({ type: 'succeeded', sale: response.sale, replayed: response.replayed });
    })
    .catch((error: unknown) => {
      const failure = describeFailure(error);
      if (failure.action === 'reauthenticate') {
        flight.reset();
        onUnauthenticated();
        return;
      }
      flight.settle(outcomeFor(failure.action));
      dispatch({ type: 'failed', failure });
    });
}
