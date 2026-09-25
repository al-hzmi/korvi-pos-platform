import type { QueuedOperation } from '@korvi/domain';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import {
  createCheckoutSyncExecutor,
  isCheckoutQueuePayload,
  type CheckoutSyncApi,
} from '../checkout-sync-executor';
import type { FiscalReceipt, SaleSummary } from '../api-types';

const OPERATION_ID = '018f5000-0001-7000-8000-000000000001';
const TERMINAL_ID = '018f5000-0000-7000-8000-000000000002';
const SHIFT_ID = '018f5000-0000-7000-8000-000000000004';
const PRODUCT_ID = '018f5000-0000-7000-8000-000000000003';

const PAYLOAD = {
  operationId: OPERATION_ID,
  terminalId: TERMINAL_ID,
  expectedShiftId: SHIFT_ID,
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

const SALE: SaleSummary = {
  saleId: 'sale-1',
  operationId: OPERATION_ID,
  sequence: 1,
  invoiceNumber: '01-000001',
  issuedAt: '2026-09-12T01:00:00.000Z',
  currency: 'SAR',
  branchId: 'branch-1',
  terminalId: TERMINAL_ID,
  shiftId: SHIFT_ID,
  cashierName: 'سارة',
  lines: [],
  netMinor: '1000',
  vatMinor: '150',
  totalMinor: '1150',
  cashReceivedMinor: '1150',
  changeMinor: '0',
};

const RECEIPT: FiscalReceipt = {
  invoiceId: 'invoice-1',
  invoiceNumber: SALE.invoiceNumber,
  issuedAt: SALE.issuedAt,
  currency: SALE.currency,
  sellerName: 'Merchant',
  vatRegistrationNumber: '300000000000003',
  lines: [],
  netMinor: SALE.netMinor,
  vatMinor: SALE.vatMinor,
  totalMinor: SALE.totalMinor,
  invoiceHashBase64: 'invoice-hash-base64',
  qrCodeBase64: 'phase2-qr-base64',
  fiscalizationMode: 'production',
  disclaimer: null,
};

function apiWithCheckout(checkout: CheckoutSyncApi['checkout']): CheckoutSyncApi {
  return { checkout };
}

describe('checkout queue executor', () => {
  it('accepts only exact replayable checkout payloads', () => {
    expect(isCheckoutQueuePayload(PAYLOAD)).toBe(true);
    expect(isCheckoutQueuePayload({ ...PAYLOAD, operationId: 'not-a-uuid' })).toBe(false);
    expect(isCheckoutQueuePayload({ ...PAYLOAD, expectedShiftId: undefined })).toBe(false);
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
    const checkout = vi.fn<CheckoutSyncApi['checkout']>().mockResolvedValue({
      sale: SALE,
      receipt: RECEIPT,
      replayed: true,
    });
    const executor = createCheckoutSyncExecutor(apiWithCheckout(checkout));

    await expect(executor.execute(OPERATION)).resolves.toEqual({ outcome: 'settled' });
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(checkout).toHaveBeenCalledWith({ ...PAYLOAD, offlineCaptured: true });
  });

  it('retries ambiguous transport and authentication outcomes without changing operation identity', async () => {
    const network = vi
      .fn<CheckoutSyncApi['checkout']>()
      .mockRejectedValue(new ApiError(0, 'network', null));
    const auth = vi
      .fn<CheckoutSyncApi['checkout']>()
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
      .fn<CheckoutSyncApi['checkout']>()
      .mockRejectedValue(new ApiError(409, 'insufficient-stock', 'غير متوفر'));
    const executor = createCheckoutSyncExecutor(apiWithCheckout(checkout));

    await expect(executor.execute(OPERATION)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'insufficient-stock',
    });
  });

  it('refuses mismatched operation ids and unsupported queue kinds before any HTTP call', async () => {
    const checkout = vi.fn<CheckoutSyncApi['checkout']>();
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

describe('mixed tender queue validation', () => {
  const MIXED_PAYLOAD = {
    operationId: OPERATION_ID,
    terminalId: TERMINAL_ID,
    expectedShiftId: SHIFT_ID,
    tenders: [
      { kind: 'electronic', amountMinor: '650', scheme: 'mada', reference: 'approval-a' },
      { kind: 'cash', amountMinor: '500' },
    ],
    lines: [{ productId: PRODUCT_ID, quantityScaled: '1000' }],
  } as const;

  it('accepts an exact replayable tender list and rejects ambiguous payment shapes', () => {
    expect(isCheckoutQueuePayload(MIXED_PAYLOAD)).toBe(true);
    expect(isCheckoutQueuePayload({ ...MIXED_PAYLOAD, cashReceivedMinor: '500' })).toBe(false);
    expect(
      isCheckoutQueuePayload({
        ...MIXED_PAYLOAD,
        tenders: [
          { kind: 'electronic', amountMinor: '650', scheme: 'mada', reference: 'same' },
          { kind: 'electronic', amountMinor: '500', scheme: 'mada', reference: 'same' },
        ],
      }),
    ).toBe(false);
  });

  it('replays mixed tender payload without translating it back to cash', async () => {
    const checkout = vi.fn<CheckoutSyncApi['checkout']>().mockResolvedValue({
      sale: SALE,
      receipt: RECEIPT,
      replayed: true,
    });
    const executor = createCheckoutSyncExecutor(apiWithCheckout(checkout));
    await expect(executor.execute({ ...OPERATION, payload: MIXED_PAYLOAD })).resolves.toEqual({
      outcome: 'settled',
    });
    expect(checkout).toHaveBeenCalledWith({ ...MIXED_PAYLOAD, offlineCaptured: true });
  });
});
