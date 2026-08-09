import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { createCheckoutFlight, outcomeFor } from '../checkout-flight';
import { runCheckout } from '../checkout-submit';
import {
  checkoutReducer,
  initialCheckoutState,
  intentLocked,
  signOutBlocked,
  submitDisabled,
} from '../checkout';
import { describeFailure } from '../failures';
import type { CheckoutResponse, SaleSummary } from '../api-types';
import type { CartLine } from '../cart';
import type { CheckoutEvent, CheckoutState } from '../checkout';
import type { CheckoutIntent } from '../checkout-flight';

const SALE: SaleSummary = {
  saleId: 'sale-1',
  operationId: 'op-1',
  sequence: 12,
  invoiceNumber: '01-000012',
  issuedAt: '2026-08-12T07:00:00.000Z',
  currency: 'SAR',
  branchId: 'b1',
  terminalId: 'tm1',
  shiftId: 'sh1',
  cashierName: 'سارة',
  lines: [],
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  cashReceivedMinor: '5000',
  changeMinor: '2700',
};

const MILK: CartLine = {
  productId: 'p-milk',
  sku: 'MILK-1L',
  nameAr: 'حليب طازج',
  nameEn: null,
  productType: 'unit',
  unitLabel: null,
  unitPriceMinor: '1150',
  vatBasisPoints: 1500,
  quantityScaled: '2000',
};

const NETWORK = describeFailure(new ApiError(0, 'network', null));
const TIMEOUT = describeFailure(new ApiError(0, 'timeout', null));
const CONFLICT = describeFailure(new ApiError(409, 'idempotency-conflict', null));
const SHORT_CASH = describeFailure(new ApiError(422, 'insufficient-cash', null));

interface Deferred {
  readonly promise: Promise<CheckoutResponse>;
  resolve(response: CheckoutResponse): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (response: CheckoutResponse) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<CheckoutResponse>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The submit path, driven exactly as the hook drives it. */
function harness(behaviour: (intent: CheckoutIntent) => Promise<CheckoutResponse>) {
  const sent: CheckoutIntent[] = [];
  const events: CheckoutEvent[] = [];
  const expired = vi.fn();
  const flight = createCheckoutFlight();
  let minted = 0;

  const submit = (input: {
    terminalId: string;
    lines: readonly CartLine[];
    cashReceivedMinor: string;
  }): Promise<void> =>
    runCheckout(
      {
        checkout: (intent) => {
          sent.push(intent);
          return behaviour(intent);
        },
      },
      flight,
      input,
      (event) => events.push(event),
      expired,
      () => {
        minted += 1;
        return `op-${String(minted)}`;
      },
    );

  const state = (): CheckoutState => events.reduce(checkoutReducer, initialCheckoutState);

  return { sent, events, expired, flight, submit, state, minted: () => minted };
}

const BASKET = { terminalId: 'tm1', lines: [MILK], cashReceivedMinor: '5000' };

describe('two submits in one tick', () => {
  it('issues exactly one request and mints exactly one operation id', async () => {
    /*
     * The failure this closes. `dispatch` schedules a render; it does not
     * change anything synchronously. A guard that reads React state therefore
     * lets a double click through: both calls see idle, both mint their own
     * operation id, and the server sees two different intents — so its
     * idempotency contract, the thing that exists to prevent a double charge,
     * never engages.
     */
    const pending = deferred();
    const run = harness(() => pending.promise);

    const first = run.submit(BASKET);
    const second = run.submit(BASKET);

    expect(run.sent).toHaveLength(1);
    expect(run.minted()).toBe(1);

    pending.resolve({ sale: SALE, replayed: false });
    await Promise.all([first, second]);

    expect(run.sent).toHaveLength(1);
    expect(run.sent[0]?.operationId).toBe('op-1');
    expect(run.events.filter((event) => event.type === 'submit')).toHaveLength(1);
  });

  it('sends one body, not two that differ', async () => {
    const pending = deferred();
    const run = harness(() => pending.promise);

    void run.submit(BASKET);
    // A second click after the cashier nudged the cash field must not become a
    // second request under a second id.
    void run.submit({ ...BASKET, cashReceivedMinor: '6000' });

    expect(run.sent).toHaveLength(1);
    expect(run.sent[0]?.cashReceivedMinor).toBe('5000');
    pending.resolve({ sale: SALE, replayed: false });
  });
});

describe('an answer that never arrived', () => {
  it('replays the identical intent, id, cash and lines', async () => {
    const run = harness(() => Promise.reject(new ApiError(0, 'network', null)));
    await run.submit(BASKET);

    expect(run.flight.outstanding()).toBe(true);
    const frozen = run.flight.pending();
    expect(frozen?.operationId).toBe('op-1');

    // The cashier's screen has moved on — a different basket, a different
    // cash amount. The retry must not care.
    await run.submit({
      terminalId: 'tm2',
      lines: [{ ...MILK, quantityScaled: '9000' }],
      cashReceivedMinor: '9999',
    });

    expect(run.sent).toHaveLength(2);
    expect(run.sent[1]).toEqual(run.sent[0]);
    expect(run.sent[1]?.operationId).toBe('op-1');
    expect(run.sent[1]?.cashReceivedMinor).toBe('5000');
    expect(run.sent[1]?.lines).toEqual([{ productId: 'p-milk', quantityScaled: '2000' }]);
    expect(run.minted()).toBe(1);
  });

  it('treats a checkout timeout exactly as it treats a lost connection', async () => {
    const run = harness(() => Promise.reject(new ApiError(0, 'timeout', null)));
    await run.submit(BASKET);

    expect(run.flight.outstanding()).toBe(true);
    expect(run.flight.pending()?.operationId).toBe('op-1');
    expect(TIMEOUT.action).toBe('retry-same');
    expect(outcomeFor(TIMEOUT.action)).toBe('ambiguous');
  });

  it('cannot have its request edited from outside', () => {
    const flight = createCheckoutFlight();
    const intent = flight.begin(() => ({
      operationId: 'op-1',
      terminalId: 'tm1',
      cashReceivedMinor: '5000',
      lines: [{ productId: 'p-milk', quantityScaled: '2000' }],
    }));
    flight.settle('ambiguous');

    const held = intent as { cashReceivedMinor: string };
    expect(() => {
      held.cashReceivedMinor = '9999';
    }).toThrow(TypeError);
    expect(flight.pending()?.cashReceivedMinor).toBe('5000');
  });

  it('resolves to the sale the first attempt created', async () => {
    let attempts = 0;
    const run = harness(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new ApiError(0, 'network', null))
        : Promise.resolve({ sale: SALE, replayed: true });
    });

    await run.submit(BASKET);
    await run.submit(BASKET);

    const state = run.state();
    expect(state.phase).toBe('succeeded');
    expect(state.replayed).toBe(true);
    expect(state.attemptOutstanding).toBe(false);
  });
});

describe('a refusal the server decided', () => {
  it('lets the cashier amend, and the amended basket goes out under a new id', async () => {
    const run = harness(() => Promise.reject(new ApiError(422, 'insufficient-cash', null)));
    await run.submit(BASKET);

    expect(run.flight.outstanding()).toBe(false);
    // Nothing was recorded, so the id is retired rather than reused: a fresh
    // one can never collide with anything.
    expect(run.flight.pending()).toBeNull();

    const run2 = harness((intent) =>
      intent.cashReceivedMinor === '5000'
        ? Promise.reject(new ApiError(422, 'insufficient-cash', null))
        : Promise.resolve({ sale: SALE, replayed: false }),
    );
    await run2.submit(BASKET);
    await run2.submit({ ...BASKET, cashReceivedMinor: '9000' });

    expect(run2.sent).toHaveLength(2);
    expect(run2.sent[0]?.operationId).toBe('op-1');
    expect(run2.sent[1]?.operationId).toBe('op-2');
    expect(run2.sent[1]?.cashReceivedMinor).toBe('9000');
  });

  it('never silently mints a replacement after an idempotency conflict', async () => {
    // The id is burnt: a sale with a different basket already owns it. A new
    // one here would quietly ring the basket up a second time.
    const run = harness(() => Promise.reject(new ApiError(409, 'idempotency-conflict', null)));
    await run.submit(BASKET);

    expect(run.flight.blocked()).toBe(true);
    expect(run.flight.pending()?.operationId).toBe('op-1');

    await run.submit({ ...BASKET, cashReceivedMinor: '9000' });
    expect(run.sent).toHaveLength(1);
    expect(run.minted()).toBe(1);
  });

  it('starts clean only when the cashier starts a new sale', async () => {
    const run = harness(() => Promise.resolve({ sale: SALE, replayed: false }));
    await run.submit(BASKET);
    expect(run.flight.pending()?.operationId).toBe('op-1');

    run.flight.reset();
    await run.submit(BASKET);
    expect(run.sent[1]?.operationId).toBe('op-2');
  });

  it('drops everything when the session turns out to be gone', async () => {
    const run = harness(() => Promise.reject(new ApiError(401, 'unauthenticated', null)));
    await run.submit(BASKET);

    expect(run.expired).toHaveBeenCalledTimes(1);
    expect(run.flight.pending()).toBeNull();
    expect(run.events.some((event) => event.type === 'failed')).toBe(false);
  });
});

describe('what the screen locks', () => {
  const after = (events: readonly CheckoutEvent[]): CheckoutState =>
    events.reduce(checkoutReducer, initialCheckoutState);

  const INTENT: CheckoutIntent = {
    operationId: 'op-1',
    terminalId: 'tm1',
    cashReceivedMinor: '5000',
    lines: [{ productId: 'p-milk', quantityScaled: '2000' }],
  };

  it('freezes basket, cash and search while an attempt is outstanding', () => {
    const state = after([
      { type: 'submit', intent: INTENT },
      { type: 'failed', failure: NETWORK },
    ]);
    expect(intentLocked(state)).toBe(true);
    expect(signOutBlocked(state)).toBe(true);
  });

  it('freezes them while a request is in flight', () => {
    const state = after([{ type: 'submit', intent: INTENT }]);
    expect(intentLocked(state)).toBe(true);
    expect(submitDisabled(state)).toBe(true);
    expect(signOutBlocked(state)).toBe(true);
  });

  it('unfreezes after a refusal the cashier can act on', () => {
    const state = after([
      { type: 'submit', intent: INTENT },
      { type: 'failed', failure: SHORT_CASH },
    ]);
    expect(intentLocked(state)).toBe(false);
    expect(signOutBlocked(state)).toBe(false);
    expect(state.intent).toBeNull();
  });

  it('stops accepting submits after a conflict', () => {
    const state = after([
      { type: 'submit', intent: INTENT },
      { type: 'failed', failure: CONFLICT },
    ]);
    expect(submitDisabled(state)).toBe(true);
    expect(state.intent).toEqual(INTENT);
  });

  it('keeps the till locked on a completed sale until a new one is started', () => {
    const done = after([
      { type: 'submit', intent: INTENT },
      { type: 'succeeded', sale: SALE, replayed: false },
    ]);
    expect(intentLocked(done)).toBe(true);
    expect(checkoutReducer(done, { type: 'new-sale' })).toEqual(initialCheckoutState);
  });
});
