import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { createCheckoutFlight } from '../checkout-flight';
import { checkoutQueueOperation } from '../offline-checkout';
import { runCheckout } from '../checkout-submit';
import { checkoutReducer, initialCheckoutState } from '../checkout';
import type { CheckoutEvent } from '../checkout';
import type { CheckoutIntent } from '../checkout-flight';

const OPERATION_ID = '018f5000-0001-7000-8000-000000000001';
const TERMINAL_ID = '018f5000-0000-7000-8000-000000000002';
const PRODUCT_ID = '018f5000-0000-7000-8000-000000000003';
const SHIFT_ID = '018f5000-0000-7000-8000-000000000004';

const INTENT = {
  operationId: OPERATION_ID,
  terminalId: TERMINAL_ID,
  expectedShiftId: SHIFT_ID,
  cashReceivedMinor: '1150',
  lines: [{ productId: PRODUCT_ID, quantityScaled: '1000' }],
} as const;

const CART_LINE = {
  productId: PRODUCT_ID,
  sku: 'A',
  nameAr: 'أ',
  nameEn: null,
  productType: 'unit' as const,
  unitLabel: 'حبة',
  unitPriceMinor: '1150',
  vatBasisPoints: 1500,
  quantityScaled: '1000',
};

describe('offline checkout ownership transfer', () => {
  it('derives one deterministic queue envelope from the immutable UUIDv7 intent', () => {
    const first = checkoutQueueOperation(INTENT);
    const second = checkoutQueueOperation(INTENT);
    expect(second).toEqual(first);
    expect(first.id).toBe(OPERATION_ID);
    expect(first.kind).toBe('sale.checkout');
    expect(first.payload).toEqual(INTENT);
    expect(first.enqueuedAt).toMatch(/^20\d\d-/);
  });

  it('queues an unanswered request before unlocking the till', async () => {
    const flight = createCheckoutFlight();
    const events: CheckoutEvent[] = [];
    const queued = vi.fn(async (_intent: CheckoutIntent) => undefined);
    await runCheckout(
      { checkout: async () => Promise.reject(new ApiError(0, 'network', null)) },
      flight,
      {
        terminalId: TERMINAL_ID,
        expectedShiftId: SHIFT_ID,
        lines: [CART_LINE],
        cashReceivedMinor: '1150',
      },
      (event) => events.push(event),
      () => undefined,
      () => OPERATION_ID,
      queued,
    );
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued.mock.calls[0]?.[0]).toEqual(INTENT);
    expect(flight.pending()).toBeNull();
    const state = events.reduce(checkoutReducer, initialCheckoutState);
    expect(state.phase).toBe('queued');
    expect(state.attemptOutstanding).toBe(false);
    expect(state.intent).toEqual(INTENT);
  });

  it('keeps the original intent locked when local durability also fails', async () => {
    const flight = createCheckoutFlight();
    const events: CheckoutEvent[] = [];
    await runCheckout(
      { checkout: async () => Promise.reject(new ApiError(0, 'network', null)) },
      flight,
      {
        terminalId: TERMINAL_ID,
        expectedShiftId: SHIFT_ID,
        lines: [CART_LINE],
        cashReceivedMinor: '1150',
      },
      (event) => events.push(event),
      () => undefined,
      () => OPERATION_ID,
      async () => Promise.reject(new Error('IndexedDB unavailable')),
    );
    expect(flight.outstanding()).toBe(true);
    expect(flight.pending()?.operationId).toBe(OPERATION_ID);
    const state = events.reduce(checkoutReducer, initialCheckoutState);
    expect(state.phase).toBe('failed');
    expect(state.attemptOutstanding).toBe(true);
    expect(state.failure?.code).toBe('offline-queue-unavailable');
  });
});
