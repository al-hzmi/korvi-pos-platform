import { isUuidV7, type QueuedOperation, type SyncOperationExecutor } from '@korvi/domain';
import { ApiError, type ApiClient } from './api';
import type { CheckoutRequest } from './api-types';
import { describeFailure } from './failures';

const INTEGER = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
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
    typeof value.cashReceivedMinor !== 'string' ||
    !INTEGER.test(value.cashReceivedMinor) ||
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

export interface CheckoutSyncExecutorOptions {
  readonly onUnauthenticated?: (() => void) | undefined;
}

export function createCheckoutSyncExecutor(
  api: ApiClient,
  options: CheckoutSyncExecutorOptions = {},
): SyncOperationExecutor {
  return {
    async execute(operation: QueuedOperation) {
      if (operation.kind !== 'sale.checkout') {
        return { outcome: 'rejected', reason: 'unsupported-operation-kind' } as const;
      }
      if (!isCheckoutQueuePayload(operation.payload)) {
        return { outcome: 'rejected', reason: 'corrupt-checkout-payload' } as const;
      }
      if (operation.payload.operationId !== operation.id) {
        return { outcome: 'rejected', reason: 'operation-id-mismatch' } as const;
      }

      try {
        await api.checkout(operation.payload);
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
