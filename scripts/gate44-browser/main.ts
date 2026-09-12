import type { QueueOperationInput, QueuePartition, SyncOperationExecutor } from '@korvi/domain';
import {
  OFFLINE_CATALOGUE_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_SALE_DRAFT_STORE,
  OFFLINE_TRANSACTION_QUEUE_STORE,
  OfflineStoreError,
  openKorviOfflineStore,
  queuePartitionKey,
  serializeQueuePayload,
} from '../../apps/pos-web/src/lib/offline-store';
import { createQueuePushSyncEngine } from '../../apps/pos-web/src/lib/sync-engine';

const PARTITION: QueuePartition = {
  tenantId: '018f4400-0000-7000-8000-000000000001',
  branchId: '018f4400-0000-7000-8000-000000000002',
  terminalId: '018f4400-0000-7000-8000-000000000003',
};

const FIRST_ID = '018f4400-0001-7000-8000-000000000001';
const SECOND_ID = '018f4400-0002-7000-8000-000000000002';
const TOKEN_A = '018f4400-0010-7000-8000-000000000001';
const TOKEN_B = '018f4400-0011-7000-8000-000000000002';
const TOKEN_RECOVERY = '018f4400-0012-7000-8000-000000000003';
const ENGINE_TOKEN_1 = '018f4400-0013-7000-8000-000000000004';
const ENGINE_TOKEN_2 = '018f4400-0014-7000-8000-000000000005';

const CLAIM_NOW = '2026-09-12T01:00:00.000Z';
const LEASE_UNTIL = '2026-09-12T01:05:00.000Z';
const AFTER_LEASE = '2026-09-12T01:06:00.000Z';
const RETRY_AT = '2026-09-12T01:20:00.000Z';
const AFTER_RETRY = '2026-09-12T01:21:00.000Z';

const OPERATIONS: readonly QueueOperationInput[] = [
  {
    id: FIRST_ID,
    kind: 'sale.checkout',
    payload: { operationId: FIRST_ID, amountMinor: '1100' },
    enqueuedAt: '2026-09-12T00:00:01.000Z',
  },
  {
    id: SECOND_ID,
    kind: 'sale.checkout',
    payload: { operationId: SECOND_ID, amountMinor: '2200' },
    enqueuedAt: '2026-09-12T00:00:02.000Z',
  },
];

interface SeedResult {
  readonly version: number;
  readonly migratedV2Rows: boolean;
  readonly initialOrder: readonly string[];
  readonly concurrentSingleWinner: boolean;
  readonly concurrentBlockedActiveLease: boolean;
  readonly claimedId: string;
  readonly claimedAttempts: number;
}

interface VerifyResult {
  readonly version: number;
  readonly activeLeaseBlockedAfterRestart: boolean;
  readonly reclaimedSameOperation: boolean;
  readonly reclaimAttemptsIncremented: boolean;
  readonly staleTokenRejected: boolean;
  readonly retryDelayPersisted: boolean;
  readonly noOvertakingBeforeRetry: boolean;
  readonly executionOrder: readonly string[];
  readonly exactOncePerSuccessfulDrain: boolean;
  readonly firstSettledRetained: boolean;
  readonly secondSettledRetained: boolean;
  readonly firstAttempts: number;
  readonly secondAttempts: number;
}

interface Gate44ProofApi {
  readonly ready: true;
  seed(): Promise<SeedResult>;
  verify(): Promise<VerifyResult>;
}

const host = globalThis as typeof globalThis & { gate44Proof?: Gate44ProofApi };

function setStatus(value: unknown): void {
  const element = globalThis.document.getElementById('status');
  if (element !== null) element.textContent = JSON.stringify(value, null, 2);
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function queueKey(id: string): string {
  return JSON.stringify([PARTITION.tenantId, PARTITION.branchId, PARTITION.terminalId, id]);
}

async function createLegacyV2Database(): Promise<void> {
  const request = globalThis.indexedDB.open(OFFLINE_DB_NAME, 2);
  request.onupgradeneeded = () => {
    const database = request.result;
    const catalogue = database.createObjectStore(OFFLINE_CATALOGUE_STORE, { keyPath: 'cacheKey' });
    catalogue.createIndex('tenantId', 'tenantId', { unique: false });
    const drafts = database.createObjectStore(OFFLINE_SALE_DRAFT_STORE, { keyPath: 'scopeKey' });
    drafts.createIndex('tenantId', 'tenantId', { unique: false });
    const queue = database.createObjectStore(OFFLINE_TRANSACTION_QUEUE_STORE, { keyPath: 'queueKey' });
    queue.createIndex('queuePartition', 'partitionKey', { unique: false });
    queue.createIndex('queueOrder', ['partitionKey', 'id'], { unique: true });
    queue.createIndex('operationId', 'id', { unique: true });
  };

  const database = await requestValue(request);
  try {
    const transaction = database.transaction(OFFLINE_TRANSACTION_QUEUE_STORE, 'readwrite');
    const store = transaction.objectStore(OFFLINE_TRANSACTION_QUEUE_STORE);
    for (const operation of [...OPERATIONS].reverse()) {
      store.add({
        queueKey: queueKey(operation.id),
        partitionKey: queuePartitionKey(PARTITION),
        tenantId: PARTITION.tenantId,
        branchId: PARTITION.branchId,
        terminalId: PARTITION.terminalId,
        id: operation.id,
        kind: operation.kind,
        payloadJson: serializeQueuePayload(operation.payload),
        state: 'pending',
        attempts: 0,
        enqueuedAt: operation.enqueuedAt,
        rejectionReason: null,
      });
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function seed(): Promise<SeedResult> {
  await createLegacyV2Database();
  const firstStore = await openKorviOfflineStore();
  const secondStore = await openKorviOfflineStore();
  try {
    const initial = await firstStore.pending(PARTITION, 10);
    const migratedV2Rows =
      initial.length === 2 &&
      initial.every(
        (operation) =>
          operation.nextAttemptAt === operation.enqueuedAt &&
          operation.leaseUntil === null &&
          operation.attempts === 0,
      );

    const [claimA, claimB] = await Promise.all([
      firstStore.claimNext(PARTITION, {
        token: TOKEN_A,
        now: CLAIM_NOW,
        leaseUntil: LEASE_UNTIL,
      }),
      secondStore.claimNext(PARTITION, {
        token: TOKEN_B,
        now: CLAIM_NOW,
        leaseUntil: LEASE_UNTIL,
      }),
    ]);

    const results = [claimA, claimB];
    const claimed = results.filter((result) => result.status === 'claimed');
    const blocked = results.filter(
      (result) => result.status === 'blocked' && result.reason === 'active-lease',
    );
    if (claimed.length !== 1 || claimed[0]?.status !== 'claimed') {
      throw new Error('Concurrent Gate 44 claim did not produce exactly one winner.');
    }

    const result: SeedResult = {
      version: firstStore.describe().version,
      migratedV2Rows,
      initialOrder: initial.map((operation) => operation.id),
      concurrentSingleWinner: claimed.length === 1,
      concurrentBlockedActiveLease: blocked.length === 1,
      claimedId: claimed[0].claim.operation.id,
      claimedAttempts: claimed[0].claim.operation.attempts,
    };
    setStatus({ phase: 'seed-before-process-crash', ...result });
    return result;
  } finally {
    firstStore.close();
    secondStore.close();
  }
}

async function verify(): Promise<VerifyResult> {
  const store = await openKorviOfflineStore();
  try {
    const beforeLease = await store.claimNext(PARTITION, {
      token: ENGINE_TOKEN_1,
      now: '2026-09-12T01:04:00.000Z',
      leaseUntil: '2026-09-12T01:04:30.000Z',
    });
    const activeLeaseBlockedAfterRestart =
      beforeLease.status === 'blocked' && beforeLease.reason === 'active-lease';

    const recovered = await store.claimNext(PARTITION, {
      token: TOKEN_RECOVERY,
      now: AFTER_LEASE,
      leaseUntil: '2026-09-12T01:07:00.000Z',
    });
    if (recovered.status !== 'claimed') {
      throw new Error('Expired Gate 44 lease was not reclaimable.');
    }
    const reclaimedSameOperation = recovered.claim.operation.id === FIRST_ID;
    const reclaimAttemptsIncremented = recovered.claim.operation.attempts === 2;

    let staleTokenRejected = false;
    try {
      await store.settleClaim(PARTITION, FIRST_ID, TOKEN_A);
    } catch (error) {
      staleTokenRejected = error instanceof OfflineStoreError && error.code === 'conflict';
    }
    if (!staleTokenRejected) {
      try {
        await store.settleClaim(PARTITION, FIRST_ID, TOKEN_B);
      } catch (error) {
        staleTokenRejected = error instanceof OfflineStoreError && error.code === 'conflict';
      }
    }

    await store.retryClaim(PARTITION, FIRST_ID, TOKEN_RECOVERY, RETRY_AT);

    const blockedExecutions: string[] = [];
    const blockedEngine = createQueuePushSyncEngine(
      store,
      PARTITION,
      {
        execute: async (operation) => {
          blockedExecutions.push(operation.id);
          return { outcome: 'settled' };
        },
      },
      {
        now: () => new Date('2026-09-12T01:10:00.000Z'),
        mintClaimId: () => ENGINE_TOKEN_1,
      },
    );
    const blockedReport = await blockedEngine.push();
    const retryDelayPersisted =
      blockedReport.stopReason === 'retry-delay' && blockedReport.blockedUntil === RETRY_AT;
    const noOvertakingBeforeRetry = blockedExecutions.length === 0;

    const executionOrder: string[] = [];
    const claimTokens = [ENGINE_TOKEN_1, ENGINE_TOKEN_2];
    let tokenIndex = 0;
    const executor: SyncOperationExecutor = {
      execute: async (operation) => {
        executionOrder.push(operation.id);
        return { outcome: 'settled' };
      },
    };
    const engine = createQueuePushSyncEngine(store, PARTITION, executor, {
      now: () => new Date(AFTER_RETRY),
      mintClaimId: () => claimTokens[tokenIndex++] ?? ENGINE_TOKEN_2,
    });
    const report = await engine.push();

    const first = await store.get(PARTITION, FIRST_ID);
    const second = await store.get(PARTITION, SECOND_ID);
    const result: VerifyResult = {
      version: store.describe().version,
      activeLeaseBlockedAfterRestart,
      reclaimedSameOperation,
      reclaimAttemptsIncremented,
      staleTokenRejected,
      retryDelayPersisted,
      noOvertakingBeforeRetry,
      executionOrder,
      exactOncePerSuccessfulDrain:
        report.settled === 2 &&
        executionOrder.length === 2 &&
        executionOrder[0] === FIRST_ID &&
        executionOrder[1] === SECOND_ID,
      firstSettledRetained: first?.state === 'settled',
      secondSettledRetained: second?.state === 'settled',
      firstAttempts: first?.attempts ?? -1,
      secondAttempts: second?.attempts ?? -1,
    };
    setStatus({ phase: 'verified-after-process-restart', ...result });
    return result;
  } finally {
    store.close();
  }
}

host.gate44Proof = { ready: true, seed, verify };
setStatus({ ready: true, schemaVersion: OFFLINE_DB_VERSION });
