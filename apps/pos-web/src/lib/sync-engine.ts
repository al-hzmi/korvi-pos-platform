import {
  DEFAULT_RETRY_POLICY,
  newId,
  nextRetryDelayMs,
  type PushSyncEnginePort,
  type QueuePartition,
  type RetryPolicy,
  type SyncOperationExecutor,
  type SyncPushReport,
  type TransactionQueuePort,
} from '@korvi/domain';

export const DEFAULT_SYNC_LEASE_MS = 60_000;
export const DEFAULT_SYNC_BATCH_LIMIT = 100;

export interface QueuePushSyncOptions {
  readonly retryPolicy?: RetryPolicy;
  readonly leaseMs?: number;
  readonly batchLimit?: number;
  readonly now?: () => Date;
  readonly mintClaimId?: () => string;
}

function emptyReport(stopReason: SyncPushReport['stopReason']): SyncPushReport {
  return {
    claimed: 0,
    settled: 0,
    retried: 0,
    rejected: 0,
    stopReason,
    blockedUntil: null,
  };
}

function safeReason(reason: string): string {
  const normalized = reason.trim().replace(/[^a-z0-9._:-]/gi, '-').slice(0, 200);
  return normalized === '' ? 'unspecified' : normalized;
}

function validateOptions(policy: RetryPolicy, leaseMs: number, batchLimit: number): void {
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    !Number.isFinite(policy.initialDelayMs) ||
    policy.initialDelayMs < 0 ||
    !Number.isFinite(policy.backoffFactor) ||
    policy.backoffFactor < 1 ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.initialDelayMs ||
    !Number.isInteger(leaseMs) ||
    leaseMs < 1 ||
    leaseMs > 5 * 60 * 1000 ||
    !Number.isInteger(batchLimit) ||
    batchLimit < 1 ||
    batchLimit > 500
  ) {
    throw new Error('Invalid queue sync configuration.');
  }
}

export function createQueuePushSyncEngine(
  queue: TransactionQueuePort,
  partition: QueuePartition,
  executor: SyncOperationExecutor,
  options: QueuePushSyncOptions = {},
): PushSyncEnginePort {
  const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const leaseMs = options.leaseMs ?? DEFAULT_SYNC_LEASE_MS;
  const batchLimit = options.batchLimit ?? DEFAULT_SYNC_BATCH_LIMIT;
  const now = options.now ?? (() => new Date());
  const mintClaimId = options.mintClaimId ?? newId;
  validateOptions(policy, leaseMs, batchLimit);
  let running = false;

  return {
    async push(): Promise<SyncPushReport> {
      if (running) return emptyReport('already-running');
      running = true;
      const report = { claimed: 0, settled: 0, retried: 0, rejected: 0 };

      try {
        for (let index = 0; index < batchLimit; index += 1) {
          const claimNow = now();
          if (!Number.isFinite(claimNow.getTime())) {
            throw new Error('Sync clock returned an invalid instant.');
          }

          const claimResult = await queue.claimNext(partition, {
            token: mintClaimId(),
            now: claimNow.toISOString(),
            leaseUntil: new Date(claimNow.getTime() + leaseMs).toISOString(),
          });

          if (claimResult.status === 'empty') {
            return { ...report, stopReason: 'empty', blockedUntil: null };
          }
          if (claimResult.status === 'blocked') {
            return {
              ...report,
              stopReason: claimResult.reason,
              blockedUntil: claimResult.until,
            };
          }

          const { token, operation } = claimResult.claim;
          report.claimed += 1;
          let outcome;
          try {
            outcome = await executor.execute(operation);
          } catch {
            outcome = { outcome: 'retry', reason: 'executor-error' } as const;
          }

          if (outcome.outcome === 'settled') {
            await queue.settleClaim(partition, operation.id, token);
            report.settled += 1;
            continue;
          }

          if (outcome.outcome === 'rejected') {
            await queue.rejectClaim(partition, operation.id, token, safeReason(outcome.reason));
            report.rejected += 1;
            return { ...report, stopReason: 'rejected', blockedUntil: null };
          }

          if (operation.attempts >= policy.maxAttempts) {
            await queue.rejectClaim(
              partition,
              operation.id,
              token,
              `retry-exhausted:${safeReason(outcome.reason)}`,
            );
            report.rejected += 1;
            return { ...report, stopReason: 'retry-exhausted', blockedUntil: null };
          }

          const retryBase = now();
          if (!Number.isFinite(retryBase.getTime())) {
            throw new Error('Sync clock returned an invalid instant.');
          }
          const retryAt = new Date(
            retryBase.getTime() + nextRetryDelayMs(policy, operation.attempts),
          ).toISOString();
          await queue.retryClaim(partition, operation.id, token, retryAt);
          report.retried += 1;
          return { ...report, stopReason: 'retry-delay', blockedUntil: retryAt };
        }

        return { ...report, stopReason: 'batch-limit', blockedUntil: null };
      } finally {
        running = false;
      }
    },
  };
}
