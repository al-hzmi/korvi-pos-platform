/**
 * Offline boundary — declared in Phase 0 and implemented gate by gate (ADR-0005).
 *
 * Gates 41–43 establish the application shell, durable IndexedDB substrate and
 * persistent ordered queue. Gate 44 adds an atomic leased claim boundary plus
 * retry scheduling so multiple tabs/processes cannot duplicate or overtake a
 * financial command. Concrete conflict resolution and the complete cashier
 * reconnect workflow remain Gate 45 and are not inferred from this contract.
 */

export interface QueuePartition {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
}

export type QueueItemState = 'pending' | 'in-flight' | 'settled' | 'rejected';

export interface QueueOperationInput<TPayload = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly enqueuedAt: string;
}

export interface QueuedOperation<TPayload = unknown> extends QueueOperationInput<TPayload> {
  readonly state: QueueItemState;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly leaseUntil: string | null;
  readonly rejectionReason: string | null;
}

export interface QueueClaimRequest {
  readonly token: string;
  readonly now: string;
  readonly leaseUntil: string;
}

export interface QueueClaim<TPayload = unknown> {
  readonly token: string;
  readonly operation: QueuedOperation<TPayload>;
}

export type QueueClaimResult<TPayload = unknown> =
  | { readonly status: 'claimed'; readonly claim: QueueClaim<TPayload> }
  | { readonly status: 'empty' }
  | {
      readonly status: 'blocked';
      readonly reason: 'retry-delay' | 'active-lease';
      readonly until: string;
    };

export interface TransactionQueuePort {
  enqueue<TPayload>(
    partition: QueuePartition,
    operation: QueueOperationInput<TPayload>,
  ): Promise<void>;
  pending(partition: QueuePartition, limit: number): Promise<readonly QueuedOperation[]>;
  get<TPayload = unknown>(
    partition: QueuePartition,
    id: string,
  ): Promise<QueuedOperation<TPayload> | null>;
  claimNext<TPayload = unknown>(
    partition: QueuePartition,
    request: QueueClaimRequest,
  ): Promise<QueueClaimResult<TPayload>>;
  settleClaim(partition: QueuePartition, id: string, token: string): Promise<void>;
  retryClaim(
    partition: QueuePartition,
    id: string,
    token: string,
    nextAttemptAt: string,
  ): Promise<void>;
  rejectClaim(
    partition: QueuePartition,
    id: string,
    token: string,
    reason: string,
  ): Promise<void>;
  markSettled(partition: QueuePartition, id: string): Promise<void>;
  markRejected(partition: QueuePartition, id: string, reason: string): Promise<void>;
}

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

export type SyncAttemptResult =
  | { readonly outcome: 'settled' }
  | { readonly outcome: 'retry'; readonly reason: string }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface SyncOperationExecutor {
  execute(operation: QueuedOperation): Promise<SyncAttemptResult>;
}

export type SyncPushStopReason =
  | 'empty'
  | 'retry-delay'
  | 'active-lease'
  | 'rejected'
  | 'retry-exhausted'
  | 'batch-limit'
  | 'already-running';

export interface SyncPushReport {
  readonly claimed: number;
  readonly settled: number;
  readonly retried: number;
  readonly rejected: number;
  readonly stopReason: SyncPushStopReason;
  readonly blockedUntil: string | null;
}

export interface PushSyncEnginePort {
  push(): Promise<SyncPushReport>;
}

export type ConflictResolution = 'keep-local' | 'keep-remote' | 'needs-review';

export interface SyncEnginePort extends PushSyncEnginePort {
  pull(): Promise<void>;
  resolve(id: string, resolution: ConflictResolution): Promise<void>;
}
