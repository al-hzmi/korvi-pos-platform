import type { QueuedOperation } from '@korvi/domain';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api';
import { createCheckoutSyncExecutor, isCheckoutQueuePayload } from '../checkout-sync-executor';

const OPERATION_ID = '018f5000-0001-7000-8000-000000000001';
const TERMINAL_ID = '018f5000-0000-7000-8000-000000000002';
const PRODUCT_ID = '018f5000-0000-7000-8000-000000000003';

const PAYLOAD = {
  operationId: OPERATION_ID,
  terminalId: TERMINAL_ID,
  cashReceivedMinor: '1150',
  lines: [{ productId: PRODUCT_ID, quantityScaled: '1000' }],
} as const;

const OPERATION: QueuedOperation = {
  id: OPERATION_ID,
  kind: 'sale.checkout',
  payload: PAYLOAD,
  enqueuedAt: '2026-09-12T01:00:00.000Z',
  state: 'in-flight',
  attempts: 1,
  nextAttemptAt: '2026-09-12T01:00:00.000Z',
  leaseUntil: '2026-09-12T01:01:00.000Z',
  rejectionReason: null,
};

function apiWithCheckout(checkout: ApiClient['checkout']): ApiClient {
  return { checkout } as unknown as ApiClient;
}

describe('checkout queue executor', () => {
  it('accepts only exact replayable checkout payloads', () => {
    expect(isCheckoutQueuePayload(PAYLOAD)).toBe(true);
    expect(isCheckoutQueuePayload({ ...PAYLOAD, operationId: 'not-a-uuid' })).toBe(false);
    expect(isCheckoutQueuePayload({ ...PAYLOAD, cashReceivedMinor: '11.50' })).toBe(false);
    expect(isCheckoutQueuePayload({ ...PAYLOAD, lines: [] })).toBe(false);
    expect(
      isCheckoutQueuePayload({
        ...PAYLOAD,
        lines: [{ ...PAYLOAD.lines[0], quantityScaled: '1.5' }],
      }),
    ).toBe(false);
  });

  it('settles only after the exact immutable checkout request succeeds', async () => {
    const checkout = vi.fn<ApiClient['checkout']>().mockResolvedValue({
      sale: {} as never,
      replayed: true,
    });
    const executor = createCheckoutSyncExecutor(apiWithCheckout(checkout));

    await expect(executor.execute(OPERATION)).resolves.toEqual({ outcome: 'settled' });
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(checkout).toHaveBeenCalledWith(PAYLOAD);
  });

  it('retries ambiguous transport and authentication outcomes without changing operation identity', async () => {
    const network = vi
      .fn<ApiClient['checkout']>()
      .mockRejectedValue(new ApiError(0, 'network', null));
    const auth = vi
      .fn<ApiClient['checkout']>()
      .mockRejectedValue(new ApiError(401, 'unauthenticated', null));

    await expect(
      createCheckoutSyncExecutor(apiWithCheckout(network)).execute(OPERATION),
    ).resolves.toEqual({
      outcome: 'retry',
      reason: 'network',
    });
    await expect(
      createCheckoutSyncExecutor(apiWithCheckout(auth)).execute(OPERATION),
    ).resolves.toEqual({
      outcome: 'retry',
      reason: 'unauthenticated',
    });
  });

  it('retains permanent business refusals for explicit reconciliation instead of retrying blindly', async () => {
    const checkout = vi
      .fn<ApiClient['checkout']>()
      .mockRejectedValue(new ApiError(409, 'insufficient-stock', 'غير متوفر'));
    const executor = createCheckoutSyncExecutor(apiWithCheckout(checkout));

    await expect(executor.execute(OPERATION)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'insufficient-stock',
    });
  });

  it('refuses mismatched operation ids and unsupported queue kinds before any HTTP call', async () => {
    const checkout = vi.fn<ApiClient['checkout']>();
    const executor = createCheckoutSyncExecutor(apiWithCheckout(checkout));

    await expect(
      executor.execute({ ...OPERATION, id: '018f5000-0002-7000-8000-000000000099' }),
    ).resolves.toEqual({ outcome: 'rejected', reason: 'operation-id-mismatch' });
    await expect(executor.execute({ ...OPERATION, kind: 'inventory.adjust' })).resolves.toEqual({
      outcome: 'rejected',
      reason: 'unsupported-operation-kind',
    });
    expect(checkout).not.toHaveBeenCalled();
  });
});
