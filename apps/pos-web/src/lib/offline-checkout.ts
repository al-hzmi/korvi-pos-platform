import {
  isUuidV7,
  type QueueOperationInput,
  type QueuePartition,
  type SyncPushReport,
} from '@korvi/domain';
import type { ApiClient } from './api';
import type { CheckoutRequest } from './api-types';
import type { CheckoutIntent } from './checkout-flight';
import { createCheckoutSyncExecutor, isCheckoutQueuePayload } from './checkout-sync-executor';
import { OfflineStoreError, openKorviOfflineStore, type KorviOfflineStore } from './offline-store';
import {
  decodeProtectedCheckoutOperation,
  isProtectedCheckoutPayload,
  protectCheckoutQueueOperation,
  type OfflineStoreProtector,
} from './offline-protection';
import { createQueuePushSyncEngine } from './sync-engine';

export interface OfflineSaleReviewCase {
  readonly operationId: string;
  readonly enqueuedAt: string;
  readonly attempts: number;
  readonly reason: string;
  readonly intent: CheckoutRequest | null;
  readonly localEvidence: 'decoded' | 'protected-unreadable';
  readonly disposition: 'needs-review';
}

export interface OfflineCheckoutSyncSnapshot {
  readonly report: SyncPushReport;
  readonly pendingCount: number;
  readonly needsReview: readonly OfflineSaleReviewCase[];
}

type CheckoutOfflineStore = Omit<KorviOfflineStore, 'enqueue'> & {
  enqueue(partition: QueuePartition, operation: QueueOperationInput<unknown>): Promise<void>;
};

type OpenStore = () => Promise<CheckoutOfflineStore>;

/** UUIDv7 embeds its Unix millisecond timestamp in the first 48 bits. */
export function uuidV7EnqueuedAt(id: string): string {
  if (!isUuidV7(id)) throw new OfflineStoreError('corrupt', 'Checkout operation id is not UUIDv7.');
  const milliseconds = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new OfflineStoreError('corrupt', 'Checkout UUIDv7 timestamp is invalid.');
  }
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) {
    throw new OfflineStoreError('corrupt', 'Checkout UUIDv7 timestamp is outside Date range.');
  }
  return date.toISOString();
}

export function checkoutQueueOperation(
  intent: CheckoutIntent,
): QueueOperationInput<CheckoutRequest> {
  if (intent.expectedShiftId === undefined || !isUuidV7(intent.expectedShiftId)) {
    throw new OfflineStoreError(
      'corrupt',
      'Offline checkout must be pinned to the server-authorized shift that captured the cash.',
    );
  }
  const payload: CheckoutRequest = {
    operationId: intent.operationId,
    terminalId: intent.terminalId,
    expectedShiftId: intent.expectedShiftId,
    offlineCaptured: true,
    ...(intent.orderType === undefined ? {} : { orderType: intent.orderType }),
    ...(intent.tableId === undefined ? {} : { tableId: intent.tableId }),
    ...(intent.restaurantOrderId === undefined
      ? {}
      : { restaurantOrderId: intent.restaurantOrderId }),
    ...(intent.expectedRestaurantOrderRevision === undefined
      ? {}
      : { expectedRestaurantOrderRevision: intent.expectedRestaurantOrderRevision }),
    ...(intent.cashReceivedMinor === undefined
      ? {}
      : { cashReceivedMinor: intent.cashReceivedMinor }),
    ...(intent.tenders === undefined
      ? {}
      : {
          tenders: intent.tenders.map((tender) =>
            tender.kind === 'cash' ? { ...tender } : { ...tender, reference: tender.reference },
          ),
        }),
    ...(intent.couponCodes === undefined ? {} : { couponCodes: [...intent.couponCodes] }),
    lines: intent.lines.map((line) => ({ ...line })),
  };
  if (!isCheckoutQueuePayload(payload)) {
    throw new OfflineStoreError('corrupt', 'Refusing to queue an invalid checkout intent.');
  }
  return {
    id: intent.operationId,
    kind: 'sale.checkout',
    payload,
    enqueuedAt: uuidV7EnqueuedAt(intent.operationId),
  };
}

export async function enqueueOfflineCheckout(
  partition: QueuePartition,
  intent: CheckoutIntent,
  openStore: OpenStore = () => openKorviOfflineStore(),
  protector?: OfflineStoreProtector,
): Promise<void> {
  const store = await openStore();
  try {
    const operation = checkoutQueueOperation(intent);
    await store.enqueue(
      partition,
      protector === undefined
        ? operation
        : await protectCheckoutQueueOperation(partition, operation, protector),
    );
  } finally {
    store.close();
  }
}

/**
 * Reconcile queued checkout intents against the real server authority.
 * There is deliberately no keep-local financial path. Server acceptance
 * settles; definitive refusal stays immutable and becomes needs-review.
 */
export async function syncOfflineCheckouts(
  api: ApiClient,
  partition: QueuePartition,
  onUnauthenticated?: () => void,
  openStore: OpenStore = () => openKorviOfflineStore(),
  protector?: OfflineStoreProtector,
): Promise<OfflineCheckoutSyncSnapshot> {
  const store = await openStore();
  try {
    if (protector !== undefined) {
      const legacy = [
        ...(await store.pending(partition, 500)),
        ...(await store.rejected(partition, 500)),
      ];
      for (const operation of legacy) {
        if (!isCheckoutQueuePayload(operation.payload)) continue;
        const protectedOperation = await protectCheckoutQueueOperation(
          partition,
          {
            id: operation.id,
            kind: operation.kind,
            payload: operation.payload,
            enqueuedAt: operation.enqueuedAt,
          },
          protector,
        );
        await store.migrateQueuePayload(
          partition,
          operation.id,
          operation.payload,
          protectedOperation.payload,
        );
      }
    }

    const checkoutExecutor = createCheckoutSyncExecutor(api, { onUnauthenticated });
    const engine = createQueuePushSyncEngine(store, partition, {
      async execute(operation) {
        if (protector === undefined) return checkoutExecutor.execute(operation);
        try {
          if (isCheckoutQueuePayload(operation.payload)) {
            const protectedOperation = await protectCheckoutQueueOperation(
              partition,
              {
                id: operation.id,
                kind: operation.kind,
                payload: operation.payload,
                enqueuedAt: operation.enqueuedAt,
              },
              protector,
            );
            await store.migrateQueuePayload(
              partition,
              operation.id,
              operation.payload,
              protectedOperation.payload,
            );
            return checkoutExecutor.execute(operation);
          }
          const decoded = await decodeProtectedCheckoutOperation(partition, operation, protector);
          return checkoutExecutor.execute(decoded);
        } catch {
          return { outcome: 'rejected', reason: 'local-protection-invalid' } as const;
        }
      },
    });
    const report = await engine.push();
    const pending = await store.pending(partition, 500);
    const rejected = await store.rejected(partition, 500);
    const needsReview: OfflineSaleReviewCase[] = [];
    for (const operation of rejected) {
      if (operation.kind !== 'sale.checkout' || operation.rejectionReason === null) continue;
      let intent: CheckoutRequest | null = null;
      let localEvidence: OfflineSaleReviewCase['localEvidence'] = 'decoded';
      try {
        if (isCheckoutQueuePayload(operation.payload)) {
          intent = operation.payload;
          if (protector !== undefined) {
            const protectedOperation = await protectCheckoutQueueOperation(
              partition,
              {
                id: operation.id,
                kind: operation.kind,
                payload: operation.payload,
                enqueuedAt: operation.enqueuedAt,
              },
              protector,
            );
            await store.migrateQueuePayload(
              partition,
              operation.id,
              operation.payload,
              protectedOperation.payload,
            );
          }
        } else if (protector !== undefined && isProtectedCheckoutPayload(operation.payload)) {
          intent = (await decodeProtectedCheckoutOperation(partition, operation, protector))
            .payload;
        } else {
          throw new OfflineStoreError('corrupt', 'Rejected checkout payload is unreadable.');
        }
      } catch {
        localEvidence = 'protected-unreadable';
      }
      needsReview.push({
        operationId: operation.id,
        enqueuedAt: operation.enqueuedAt,
        attempts: operation.attempts,
        reason: operation.rejectionReason,
        intent,
        localEvidence,
        disposition: 'needs-review',
      });
    }
    return { report, pendingCount: pending.length, needsReview };
  } finally {
    store.close();
  }
}
