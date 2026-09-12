import type {
  QueueClaimRequest,
  QueueClaimResult,
  QueueOperationInput,
  QueuedOperation,
  QueuePartition,
  SyncAttemptResult,
  TransactionQueuePort,
} from '@korvi/domain';
import { describe, expect, it } from 'vitest';
import { createQueuePushSyncEngine } from '../sync-engine';

const PARTITION: QueuePartition = {
  tenantId: '018f4000-0000-7000-8000-000000000001',
  branchId: '018f4000-0000-7000-8000-000000000002',
  terminalId: '018f4000-0000-7000-8000-000000000003',
};

const OPERATION: QueuedOperation = {
  id: '018f4000-0001-7000-8000-000000000001',
  kind: 'sale.checkout',
  payload: { operationId: '018f4000-0001-7000-8000-000000000001' },
  enqueuedAt: '2026-09-12T01:00:00.000Z',
  state: 'in-flight',
  attempts: 1,
  nextAttemptAt: '2026-09-12T01:00:00.000Z',
  leaseUntil: '2026-09-12T01:01:00.000Z',
  rejectionReason: null,
};

class QueueDouble implements TransactionQueuePort {
  public claimResult: QueueClaimResult = {
    status: 'claimed',
    claim: {
      token: '018f4000-0002-7000-8000-000000000001',
      operation: OPERATION,
    },
  };
  public readonly events: string[] = [];

  enqueue<TPayload>(_partition: QueuePartition, _operation: QueueOperationInput<TPayload>) {
    return Promise.resolve();
  }

  pending(_partition: QueuePartition, _limit: number) {
    return Promise.resolve([]);
  }

  get<TPayload = unknown>(_partition: QueuePartition, _id: string) {
    return Promise.resolve(null as QueuedOperation<TPayload> | null);
  }

  claimNext<TPayload = unknown>(_partition: QueuePartition, _request: QueueClaimRequest) {
    this.events.push('claim');
    return Promise.resolve(this.claimResult as QueueClaimResult<TPayload>);
  }

  settleClaim(_partition: QueuePartition, _id: string, _token: string) {
    this.events.push('settle');
    this.claimResult = { status: 'empty' };
    return Promise.resolve();
  }

  retryClaim(_partition: QueuePartition, _id: string, _token: string, nextAttemptAt: string) {
    this.events.push(`retry:${nextAttemptAt}`);
    this.claimResult = { status: 'blocked', reason: 'retry-delay', until: nextAttemptAt };
    return Promise.resolve();
  }

  rejectClaim(_partition: QueuePartition, _id: string, _token: string, reason: string) {
    this.events.push(`reject:${reason}`);
    this.claimResult = { status: 'empty' };
    return Promise.resolve();
  }

  markSettled(_partition: QueuePartition, _id: string) {
    return Promise.resolve();
  }

  markRejected(_partition: QueuePartition, _id: string, _reason: string) {
    return Promise.resolve();
  }
}

describe('queue push sync engine', () => {
  it('settles a claimed operation before asking for the next one', async () => {
    const queue = new QueueDouble();
    const executor = {
      execute: async (): Promise<SyncAttemptResult> => ({ outcome: 'settled' }),
    };
    const engine = createQueuePushSyncEngine(queue, PARTITION, executor, {
      now: () => new Date('2026-09-12T01:00:00.000Z'),
      mintClaimId: () => '018f4000-0002-7000-8000-000000000001',
    });

    await expect(engine.push()).resolves.toMatchObject({
      claimed: 1,
      settled: 1,
      stopReason: 'empty',
    });
    expect(queue.events).toEqual(['claim', 'settle', 'claim']);
  });

  it('persists a retry schedule and does not overtake the blocked operation', async () => {
    const queue = new QueueDouble();
    const engine = createQueuePushSyncEngine(
      queue,
      PARTITION,
      { execute: async () => ({ outcome: 'retry', reason: 'network' }) },
      {
        retryPolicy: {
          maxAttempts: 3,
          initialDelayMs: 1_000,
          backoffFactor: 2,
          maxDelayMs: 10_000,
        },
        now: () => new Date('2026-09-12T01:00:00.000Z'),
        mintClaimId: () => '018f4000-0002-7000-8000-000000000001',
      },
    );

    const report = await engine.push();
    expect(report.stopReason).toBe('retry-delay');
    expect(report.blockedUntil).toBe('2026-09-12T01:00:01.000Z');
    expect(queue.events).toEqual(['claim', 'retry:2026-09-12T01:00:01.000Z']);
  });

  it('turns exhausted retryable ambiguity into an explicit retained rejection', async () => {
    const queue = new QueueDouble();
    queue.claimResult = {
      status: 'claimed',
      claim: {
        token: '018f4000-0002-7000-8000-000000000001',
        operation: { ...OPERATION, attempts: 3 },
      },
    };
    const engine = createQueuePushSyncEngine(
      queue,
      PARTITION,
      { execute: async () => ({ outcome: 'retry', reason: 'server unavailable' }) },
      {
        retryPolicy: {
          maxAttempts: 3,
          initialDelayMs: 1,
          backoffFactor: 2,
          maxDelayMs: 10,
        },
        now: () => new Date('2026-09-12T01:00:00.000Z'),
        mintClaimId: () => '018f4000-0002-7000-8000-000000000001',
      },
    );

    const report = await engine.push();
    expect(report.stopReason).toBe('retry-exhausted');
    expect(queue.events).toEqual(['claim', 'reject:retry-exhausted:server-unavailable']);
  });

  it('does not start two drains from the same engine instance', async () => {
    const queue = new QueueDouble();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = {
      execute: async (): Promise<SyncAttemptResult> => {
        await gate;
        return { outcome: 'settled' };
      },
    };
    const engine = createQueuePushSyncEngine(queue, PARTITION, executor, {
      now: () => new Date('2026-09-12T01:00:00.000Z'),
      mintClaimId: () => '018f4000-0002-7000-8000-000000000001',
    });

    const first = engine.push();
    await Promise.resolve();
    await expect(engine.push()).resolves.toMatchObject({
      stopReason: 'already-running',
      claimed: 0,
    });
    release?.();
    await first;
  });
});
