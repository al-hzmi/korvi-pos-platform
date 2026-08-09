'use client';

import { useCallback, useReducer, useRef } from 'react';
import { checkoutReducer, initialCheckoutState } from '../lib/checkout';
import { createCheckoutFlight } from '../lib/checkout-flight';
import { runCheckout } from '../lib/checkout-submit';
import type { ApiClient } from '../lib/api';
import type { CartLine } from '../lib/cart';
import type { CheckoutFlight } from '../lib/checkout-flight';
import type { CheckoutState } from '../lib/checkout';

export interface CheckoutHandle {
  readonly state: CheckoutState;
  readonly submit: (input: {
    readonly terminalId: string;
    readonly lines: readonly CartLine[];
    readonly cashReceivedMinor: string;
  }) => void;
  readonly dismiss: () => void;
  readonly newSale: () => void;
}

/**
 * A binding, and nothing more.
 *
 * The flight lives in a ref so it survives renders and can be claimed
 * synchronously; the attempt itself is `runCheckout`, which is where the
 * single-flight guard, the immutable intent and the outcome classification
 * are. Keeping them out of the hook is what makes them testable without a
 * renderer, and testable is how they stay correct.
 */
export function useCheckout(api: ApiClient, onUnauthenticated: () => void): CheckoutHandle {
  const [state, dispatch] = useReducer(checkoutReducer, initialCheckoutState);
  const flight = useRef<CheckoutFlight | null>(null);
  flight.current ??= createCheckoutFlight();

  const submit = useCallback(
    (input: {
      readonly terminalId: string;
      readonly lines: readonly CartLine[];
      readonly cashReceivedMinor: string;
    }) => {
      const owned = flight.current;
      if (owned === null) return;
      void runCheckout(api, owned, input, dispatch, onUnauthenticated);
    },
    [api, onUnauthenticated],
  );

  const dismiss = useCallback(() => {
    dispatch({ type: 'dismiss' });
  }, []);

  const newSale = useCallback(() => {
    flight.current?.reset();
    dispatch({ type: 'new-sale' });
  }, []);

  return { state, submit, dismiss, newSale };
}
