import { isUuidV7, type QueuedOperation, type SyncOperationExecutor } from '@korvi/domain';
import { ApiError } from './api';
import type { CheckoutRequest, CheckoutResponse } from './api-types';
import { describeFailure } from './failures';

const INTEGER = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const PRICING_HASH = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

const ELECTRONIC_SCHEMES = new Set(['mada', 'visa', 'mastercard', 'amex', 'apple-pay', 'other']);

function isQueuedTender(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.amountMinor !== 'string' ||
    !POSITIVE_INTEGER.test(value.amountMinor)
  ) {
    return false;
  }
  if (value.kind === 'cash') {
    return value.scheme === undefined && value.reference === undefined;
  }
  return (
    value.kind === 'electronic' &&
    typeof value.scheme === 'string' &&
    ELECTRONIC_SCHEMES.has(value.scheme) &&
    typeof value.reference === 'string' &&
    value.reference.trim() !== '' &&
    value.reference.length <= 64
  );
}

function hasValidPayment(value: Readonly<Record<string, unknown>>): boolean {
  const hasCash = value.cashReceivedMinor !== undefined;
  const hasTenders = value.tenders !== undefined;
  if (hasCash === hasTenders) return false;
  if (hasCash) {
    return typeof value.cashReceivedMinor === 'string' && INTEGER.test(value.cashReceivedMinor);
  }
  if (!Array.isArray(value.tenders) || value.tenders.length === 0 || value.tenders.length > 8) {
    return false;
  }
  let cashCount = 0;
  const approvals = new Set<string>();
  for (const tender of value.tenders) {
    if (!isQueuedTender(tender) || !isRecord(tender)) return false;
    if (tender.kind === 'cash') {
      cashCount += 1;
      if (cashCount > 1) return false;
      continue;
    }
    const key = `${String(tender.scheme)}:${String(tender.reference).trim()}`;
    if (approvals.has(key)) return false;
    approvals.add(key);
  }
  return true;
}

export function isCheckoutQueuePayload(value: unknown): value is CheckoutRequest {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    !isUuidV7(value.operationId) ||
    typeof value.terminalId !== 'string' ||
    !isUuidV7(value.terminalId) ||
    typeof value.expectedShiftId !== 'string' ||
    !isUuidV7(value.expectedShiftId) ||
    !(
      value.orderType === undefined ||
      value.orderType === 'dine-in' ||
      value.orderType === 'takeaway' ||
      value.orderType === 'delivery'
    ) ||
    !(
      value.tableId === undefined ||
      (typeof value.tableId === 'string' && isUuidV7(value.tableId))
    ) ||
    !(value.offlineCaptured === undefined || value.offlineCaptured === true) ||
    !(
      value.expectedPricingHash === undefined ||
      (typeof value.expectedPricingHash === 'string' &&
        PRICING_HASH.test(value.expectedPricingHash))
    ) ||
    !(
      value.couponCodes === undefined ||
      (Array.isArray(value.couponCodes) &&
        value.couponCodes.length <= 8 &&
        value.couponCodes.every(
          (code) => typeof code === 'string' && code.length > 0 && code.length <= 64,
        ))
    ) ||
    !(
      (value.restaurantOrderId === undefined &&
        value.expectedRestaurantOrderRevision === undefined) ||
      (typeof value.restaurantOrderId === 'string' &&
        isUuidV7(value.restaurantOrderId) &&
        typeof value.expectedRestaurantOrderRevision === 'string' &&
        POSITIVE_INTEGER.test(value.expectedRestaurantOrderRevision))
    ) ||
    !hasValidPayment(value) ||
    !Array.isArray(value.lines) ||
    value.lines.length === 0 ||
    value.lines.length > 200
  ) {
    return false;
  }

  return value.lines.every(
    (line) =>
      isRecord(line) &&
      typeof line.productId === 'string' &&
      isUuidV7(line.productId) &&
      typeof line.quantityScaled === 'string' &&
      POSITIVE_INTEGER.test(line.quantityScaled),
  );
}

export interface CheckoutSyncApi {
  checkout(request: CheckoutRequest): Promise<CheckoutResponse>;
}

export interface CheckoutSyncExecutorOptions {
  readonly onUnauthenticated?: (() => void) | undefined;
}

export function createCheckoutSyncExecutor(
  api: CheckoutSyncApi,
  options: CheckoutSyncExecutorOptions = {},
): SyncOperationExecutor {
  return {
    async execute(operation: QueuedOperation) {
      if (operation.kind !== 'sale.checkout' && operation.kind !== 'sale.checkout.replay') {
        return { outcome: 'rejected', reason: 'unsupported-operation-kind' } as const;
      }
      if (!isCheckoutQueuePayload(operation.payload)) {
        return { outcome: 'rejected', reason: 'corrupt-checkout-payload' } as const;
      }
      if (operation.payload.operationId !== operation.id) {
        return { outcome: 'rejected', reason: 'operation-id-mismatch' } as const;
      }

      const onlineReplay = operation.kind === 'sale.checkout.replay';
      if (onlineReplay && operation.payload.offlineCaptured === true) {
        return { outcome: 'rejected', reason: 'checkout-replay-mode-mismatch' } as const;
      }
      if (!onlineReplay && operation.payload.couponCodes !== undefined) {
        return { outcome: 'rejected', reason: 'offline-coupon-unsupported' } as const;
      }

      try {
        // sale.checkout includes legacy rows and is deliberately tightened to
        // offline semantics. sale.checkout.replay is an online request whose
        // response was lost, so its pricing/idempotency intent must be resent unchanged.
        await api.checkout(
          onlineReplay ? operation.payload : { ...operation.payload, offlineCaptured: true },
        );
        return { outcome: 'settled' } as const;
      } catch (error) {
        if (!(error instanceof ApiError)) {
          return { outcome: 'retry', reason: 'unexpected-client-failure' } as const;
        }
        const failure = describeFailure(error);
        if (failure.action === 'reauthenticate') {
          options.onUnauthenticated?.();
          return { outcome: 'retry', reason: failure.code } as const;
        }
        if (failure.action === 'retry-same') {
          return { outcome: 'retry', reason: failure.code } as const;
        }
        return { outcome: 'rejected', reason: failure.code } as const;
      }
    },
  };
}
