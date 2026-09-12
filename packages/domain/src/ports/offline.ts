/**
 * Offline boundary — declared in Phase 0 and implemented gate by gate (ADR-0005).
 *
 * The sale path is written against durable operation identity rather than a
 * live-server assumption. Ordering and terminal outcomes are explicit because
 * an offline financial command must survive browser/process/network failure
 * without being silently duplicated, reordered or discarded.
 *
 * Gates 41 and 42 have closed the application-shell and IndexedDB substrate.
 * Gate 43 implements the persistent ordered queue. The sync loop and concrete
 * reconciliation policy remain separate Gates 44 and 45 and must not be
 * inferred merely because the queue exists.
 */

export interface QueuePartition {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
}

export type QueueItemState = 'pending' | 'in-flight' | 'settled' | 'rejected';

/** Immutable command envelope accepted by the durable queue. */
export interface QueueOperationInput<TPayload = unknown> {
  /** UUIDv7 — the id *is* the ordering key (ADR-0003). */
  readonly id: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly enqueuedAt: string;
}

/** Durable queue projection. Payload and identity never change after enqueue. */
export interface QueuedOperation<TPayload = unknown> extends QueueOperationInput<TPayload> {
  readonly state: QueueItemState;
  readonly attempts: number;
  readonly rejectionReason: string | null;
}

export interface TransactionQueuePort {
  /**
   * Idempotent for the exact same immutable envelope. Reusing an id with a
   * different partition, kind, payload or enqueue timestamp must be refused.
   */
  enqueue<TPayload>(
    partition: QueuePartition,
    operation: QueueOperationInput<TPayload>,
  ): Promise<void>;
  /** Oldest-first by UUIDv7, so replay order matches what happened. */
  pending(partition: QueuePartition, limit: number): Promise<readonly QueuedOperation[]>;
  get<TPayload = unknown>(
    partition: QueuePartition,
    id: string,
  ): Promise<QueuedOperation<TPayload> | null>;
  markSettled(partition: QueuePartition, id: string): Promise<void>;
  markRejected(partition: QueuePartition, id: string, reason: string): Promise<void>;
}

/**
 * Retry policy for the reconciliation queue.
 *
 * Deliberately a value, not behaviour: a rejected invoice must not be retried
 * on a tight loop against the Authority, and the delay belongs in one auditable
 * place rather than in a caller's setTimeout.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly backoffFactor: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 8,
  initialDelayMs: 5 * 60 * 1000,
  backoffFactor: 2,
  maxDelayMs: 6 * 60 * 60 * 1000,
};

export function nextRetryDelayMs(policy: RetryPolicy, attempt: number): number {
  const raw = policy.initialDelayMs * policy.backoffFactor ** Math.max(0, attempt - 1);
  return Math.min(raw, policy.maxDelayMs);
}

export type ConflictResolution = 'keep-local' | 'keep-remote' | 'needs-review';

export interface SyncEnginePort {
  push(): Promise<void>;
  pull(): Promise<void>;
  resolve(id: string, resolution: ConflictResolution): Promise<void>;
}
