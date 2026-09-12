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
import { createQueuePushSyncEngine } from './sync-engine';

export interface OfflineSaleReviewCase {
  readonly operationId: string;
  readonly enqueuedAt: string;
  readonly attempts: number;
  readonly reason: string;
  readonly intent: CheckoutRequest;
  readonly disposition: 'needs-review';
}

export interface OfflineCheckoutSyncSnapshot {
  readonly report: SyncPushReport;
  readonly pendingCount: number;
  readonly needsReview: readonly OfflineSaleReviewCase[];
}

type OpenStore = () => Promise<KorviOfflineStore>;

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
    cashReceivedMinor: intent.cashReceivedMinor,
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
): Promise<void> {
  const store = await openStore();
  try {
    await store.enqueue(partition, checkoutQueueOperation(intent));
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
): Promise<OfflineCheckoutSyncSnapshot> {
  const store = await openStore();
  try {
    const engine = createQueuePushSyncEngine(
      store,
      partition,
      createCheckoutSyncExecutor(api, { onUnauthenticated }),
    );
    const report = await engine.push();
    const pending = await store.pending(partition, 500);
    const rejected = await store.rejected(partition, 500);
    const needsReview: OfflineSaleReviewCase[] = [];
    for (const operation of rejected) {
      if (operation.kind !== 'sale.checkout') continue;
      if (!isCheckoutQueuePayload(operation.payload) || operation.rejectionReason === null) {
        throw new OfflineStoreError(
          'corrupt',
          'Rejected checkout reconciliation evidence is corrupt.',
        );
      }
      needsReview.push({
        operationId: operation.id,
        enqueuedAt: operation.enqueuedAt,
        attempts: operation.attempts,
        reason: operation.rejectionReason,
        intent: operation.payload,
        disposition: 'needs-review',
      });
    }
    return { report, pendingCount: pending.length, needsReview };
  } finally {
    store.close();
  }
}
