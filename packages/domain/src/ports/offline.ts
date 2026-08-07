/**
 * Offline boundary — declared in Phase 0, implemented later (ADR-0005).
 *
 * The shape is fixed now so that the sale path is written against a queue from
 * the first line of Phase 1, rather than being retrofitted for offline once it
 * already assumes a live server. Retrofitting is where ordering guarantees get
 * lost.
 *
 * Nothing here is implemented yet: no IndexedDB, no Service Worker, no sync
 * loop. Those are Phase 1+.
 */

export type QueueItemState = 'pending' | 'in-flight' | 'settled' | 'rejected';

export interface QueuedOperation<TPayload = unknown> {
  /** UUIDv7 — the id *is* the ordering key (ADR-0003). */
  readonly id: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly state: QueueItemState;
  readonly attempts: number;
  readonly enqueuedAt: string;
}

export interface TransactionQueuePort {
  enqueue<TPayload>(operation: QueuedOperation<TPayload>): Promise<void>;
  /** Oldest-first by UUIDv7, so replay order matches what happened. */
  pending(limit: number): Promise<readonly QueuedOperation[]>;
  markSettled(id: string): Promise<void>;
  markRejected(id: string, reason: string): Promise<void>;
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
