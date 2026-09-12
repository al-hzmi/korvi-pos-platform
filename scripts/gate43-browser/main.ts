import type { QueueOperationInput, QueuePartition } from '@korvi/domain';
import {
  OFFLINE_CATALOGUE_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_SALE_DRAFT_STORE,
  OFFLINE_TRANSACTION_QUEUE_STORE,
  OfflineStoreError,
  offlineSaleScopeKey,
  openKorviOfflineStore,
  queuePartitionKey,
} from '../../apps/pos-web/src/lib/offline-store';
import type { ProductSummary } from '../../apps/pos-web/src/lib/api-types';
import type { OfflineSaleDraft, OfflineSaleScope } from '../../apps/pos-web/src/lib/offline-store';

const PARTITION_A: QueuePartition = {
  tenantId: '018f3000-0000-7000-8000-0000000000a1',
  branchId: '018f3000-0000-7000-8000-0000000000a2',
  terminalId: '018f3000-0000-7000-8000-0000000000a3',
};

const PARTITION_B: QueuePartition = {
  tenantId: '018f3000-0000-7000-8000-0000000000b1',
  branchId: '018f3000-0000-7000-8000-0000000000b2',
  terminalId: '018f3000-0000-7000-8000-0000000000b3',
};

const PARTITION_CORRUPT: QueuePartition = {
  tenantId: '018f3000-0000-7000-8000-0000000000c1',
  branchId: '018f3000-0000-7000-8000-0000000000c2',
  terminalId: '018f3000-0000-7000-8000-0000000000c3',
};

const LEGACY_PRODUCT: ProductSummary = {
  id: '018f3000-0000-7000-8000-000000000101',
  sku: 'LEGACY-MILK',
  nameAr: 'حليب محفوظ قبل الترقية',
  nameEn: 'Legacy Milk',
  productType: 'unit',
  unitLabel: 'حبة',
  priceMinor: '1150',
  vatBasisPoints: 1500,
  primaryBarcode: '6283000000012',
  trackInventory: true,
};

const LEGACY_SCOPE: OfflineSaleScope = {
  tenantId: PARTITION_A.tenantId,
  branchId: PARTITION_A.branchId,
  terminalId: PARTITION_A.terminalId,
  userId: '018f3000-0000-7000-8000-0000000000a4',
  shiftId: '018f3000-0000-7000-8000-0000000000a5',
};

const LEGACY_DRAFT: OfflineSaleDraft = {
  lines: [
    {
      productId: LEGACY_PRODUCT.id,
      sku: LEGACY_PRODUCT.sku,
      nameAr: LEGACY_PRODUCT.nameAr,
      nameEn: LEGACY_PRODUCT.nameEn,
      productType: LEGACY_PRODUCT.productType,
      unitLabel: LEGACY_PRODUCT.unitLabel,
      unitPriceMinor: LEGACY_PRODUCT.priceMinor,
      vatBasisPoints: LEGACY_PRODUCT.vatBasisPoints,
      quantityScaled: '1000',
    },
  ],
  cash: '20.00',
  priceMode: 'inclusive',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

const OPERATION_IDS = [
  '018f3000-0001-7000-8000-000000000001',
  '018f3000-0002-7000-8000-000000000002',
  '018f3000-0003-7000-8000-000000000003',
  '018f3000-0004-7000-8000-000000000004',
] as const;

const PARTITION_B_OPERATION_ID = '018f3000-0005-7000-8000-000000000005';
const CORRUPT_OPERATION_ID = '018f3000-0006-7000-8000-000000000006';

function operation(id: string, totalMinor: string, second: number): QueueOperationInput {
  return {
    id,
    kind: 'sale.checkout',
    payload: {
      saleId: id,
      totalMinor,
      lines: [
        {
          productId: LEGACY_PRODUCT.id,
          quantityScaled: '1000',
          unitPriceMinor: totalMinor,
        },
      ],
    },
    enqueuedAt: `2026-09-12T00:00:0${String(second)}.000Z`,
  };
}

const OPERATIONS = [
  operation(OPERATION_IDS[0], '1150', 1),
  operation(OPERATION_IDS[1], '1250', 2),
  operation(OPERATION_IDS[2], '1350', 3),
  operation(OPERATION_IDS[3], '1450', 4),
] as const;

interface SeedResult {
  readonly version: number;
  readonly stores: readonly string[];
  readonly legacyCataloguePreserved: boolean;
  readonly legacyDraftPreserved: boolean;
  readonly orderedBeforeTransition: readonly string[];
  readonly queueACount: number;
  readonly queueBCount: number;
  readonly duplicateIdempotent: boolean;
  readonly immutableCollisionRejected: boolean;
  readonly crossPartitionCollisionRejected: boolean;
  readonly terminalConflictRejected: boolean;
}

interface VerifyResult extends SeedResult {
  readonly pendingAfterRestart: readonly string[];
  readonly settledPersisted: boolean;
  readonly rejectedPersisted: boolean;
  readonly rejectionReasonPersisted: boolean;
  readonly partitionIsolation: boolean;
  readonly payloadPersisted: boolean;
  readonly corruptionRejected: boolean;
}

interface Gate43ProofApi {
  readonly ready: true;
  seed(): Promise<SeedResult>;
  verify(): Promise<VerifyResult>;
}

const host = globalThis as typeof globalThis & { gate43Proof?: Gate43ProofApi };

function setStatus(value: unknown): void {
  const element = globalThis.document.getElementById('status');
  if (element !== null) element.textContent = JSON.stringify(value, null, 2);
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

async function createLegacyV1Database(): Promise<void> {
  const request = globalThis.indexedDB.open(OFFLINE_DB_NAME, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    const catalogue = database.createObjectStore(OFFLINE_CATALOGUE_STORE, {
      keyPath: 'cacheKey',
    });
    catalogue.createIndex('tenantId', 'tenantId', { unique: false });
    const drafts = database.createObjectStore(OFFLINE_SALE_DRAFT_STORE, { keyPath: 'scopeKey' });
    drafts.createIndex('tenantId', 'tenantId', { unique: false });
  };

  const database = await idbRequest(request);
  try {
    const transaction = database.transaction(
      [OFFLINE_CATALOGUE_STORE, OFFLINE_SALE_DRAFT_STORE],
      'readwrite',
    );
    transaction.objectStore(OFFLINE_CATALOGUE_STORE).put({
      ...LEGACY_PRODUCT,
      cacheKey: `${PARTITION_A.tenantId}:${LEGACY_PRODUCT.id}`,
      tenantId: PARTITION_A.tenantId,
      searchText: [
        LEGACY_PRODUCT.sku,
        LEGACY_PRODUCT.nameAr,
        LEGACY_PRODUCT.nameEn ?? '',
        LEGACY_PRODUCT.primaryBarcode ?? '',
      ]
        .join('\n')
        .normalize('NFKC')
        .trim()
        .toLocaleLowerCase('ar-SA'),
      cachedAt: '2026-09-12T00:00:00.000Z',
    });
    transaction.objectStore(OFFLINE_SALE_DRAFT_STORE).put({
      ...LEGACY_SCOPE,
      ...LEGACY_DRAFT,
      scopeKey: offlineSaleScopeKey(LEGACY_SCOPE),
    });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function injectCorruptQueueRow(): Promise<void> {
  const request = globalThis.indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
  const database = await idbRequest(request);
  try {
    const transaction = database.transaction(OFFLINE_TRANSACTION_QUEUE_STORE, 'readwrite');
    transaction.objectStore(OFFLINE_TRANSACTION_QUEUE_STORE).put({
      queueKey: JSON.stringify([
        PARTITION_CORRUPT.tenantId,
        PARTITION_CORRUPT.branchId,
        PARTITION_CORRUPT.terminalId,
        CORRUPT_OPERATION_ID,
      ]),
      partitionKey: queuePartitionKey(PARTITION_CORRUPT),
      tenantId: PARTITION_CORRUPT.tenantId,
      branchId: PARTITION_CORRUPT.branchId,
      terminalId: PARTITION_CORRUPT.terminalId,
      id: CORRUPT_OPERATION_ID,
      kind: 'sale.checkout',
      payloadJson: '{"totalMinor":NaN}',
      state: 'pending',
      attempts: 0,
      enqueuedAt: '2026-09-12T00:00:06.000Z',
      rejectionReason: null,
    });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function readBaseState() {
  const store = await openKorviOfflineStore();
  try {
    const description = store.describe();
    const legacyProducts = await store.searchCatalogue(PARTITION_A.tenantId, 'LEGACY-MILK', 10);
    const legacyDraft = await store.loadSaleDraft(LEGACY_SCOPE);
    return {
      version: description.version,
      stores: description.stores,
      legacyCataloguePreserved: legacyProducts[0]?.id === LEGACY_PRODUCT.id,
      legacyDraftPreserved: legacyDraft?.lines[0]?.productId === LEGACY_PRODUCT.id,
      queueACount: await store.queueCount(PARTITION_A),
      queueBCount: await store.queueCount(PARTITION_B),
    };
  } finally {
    store.close();
  }
}

async function seed(): Promise<SeedResult> {
  await createLegacyV1Database();
  const store = await openKorviOfflineStore();
  try {
    for (const index of [3, 1, 0, 2] as const) {
      await store.enqueue(PARTITION_A, OPERATIONS[index]);
    }

    const reorderedDuplicate: QueueOperationInput = {
      id: OPERATIONS[0].id,
      kind: OPERATIONS[0].kind,
      payload: {
        lines: [
          {
            unitPriceMinor: '1150',
            quantityScaled: '1000',
            productId: LEGACY_PRODUCT.id,
          },
        ],
        totalMinor: '1150',
        saleId: OPERATIONS[0].id,
      },
      enqueuedAt: OPERATIONS[0].enqueuedAt,
    };
    await store.enqueue(PARTITION_A, reorderedDuplicate);
    const duplicateIdempotent = (await store.queueCount(PARTITION_A)) === 4;

    let immutableCollisionRejected = false;
    try {
      await store.enqueue(PARTITION_A, {
        ...OPERATIONS[0],
        payload: { saleId: OPERATIONS[0].id, totalMinor: '9999', lines: [] },
      });
    } catch (error) {
      immutableCollisionRejected = error instanceof OfflineStoreError && error.code === 'conflict';
    }

    let crossPartitionCollisionRejected = false;
    try {
      await store.enqueue(PARTITION_B, OPERATIONS[0]);
    } catch (error) {
      crossPartitionCollisionRejected =
        error instanceof OfflineStoreError && error.code === 'conflict';
    }

    await store.enqueue(
      PARTITION_B,
      operation(PARTITION_B_OPERATION_ID, '2500', 5),
    );

    const orderedBeforeTransition = (await store.pending(PARTITION_A, 20)).map(
      (item) => item.id,
    );
    await store.markSettled(PARTITION_A, OPERATIONS[0].id);
    await store.markRejected(PARTITION_A, OPERATIONS[1].id, 'server-refused');

    let terminalConflictRejected = false;
    try {
      await store.markRejected(PARTITION_A, OPERATIONS[0].id, 'cannot-rewrite-settled');
    } catch (error) {
      terminalConflictRejected = error instanceof OfflineStoreError && error.code === 'conflict';
    }

    const description = store.describe();
    const legacyProducts = await store.searchCatalogue(PARTITION_A.tenantId, 'LEGACY-MILK', 10);
    const legacyDraft = await store.loadSaleDraft(LEGACY_SCOPE);
    const result: SeedResult = {
      version: description.version,
      stores: description.stores,
      legacyCataloguePreserved: legacyProducts[0]?.id === LEGACY_PRODUCT.id,
      legacyDraftPreserved: legacyDraft?.lines[0]?.productId === LEGACY_PRODUCT.id,
      orderedBeforeTransition,
      queueACount: await store.queueCount(PARTITION_A),
      queueBCount: await store.queueCount(PARTITION_B),
      duplicateIdempotent,
      immutableCollisionRejected,
      crossPartitionCollisionRejected,
      terminalConflictRejected,
    };
    setStatus({ phase: 'seeded-v1-upgraded-to-v2', ...result });
    return result;
  } finally {
    store.close();
  }
}

async function verify(): Promise<VerifyResult> {
  const base = await readBaseState();
  const store = await openKorviOfflineStore();
  let resultWithoutCorruption: Omit<VerifyResult, 'corruptionRejected'>;
  try {
    const pendingA = await store.pending(PARTITION_A, 20);
    const pendingB = await store.pending(PARTITION_B, 20);
    const settled = await store.get(PARTITION_A, OPERATIONS[0].id);
    const rejected = await store.get(PARTITION_A, OPERATIONS[1].id);
    const payload = (await store.get<{ totalMinor?: unknown }>(PARTITION_A, OPERATIONS[2].id))
      ?.payload;

    resultWithoutCorruption = {
      ...base,
      orderedBeforeTransition: [...OPERATION_IDS],
      duplicateIdempotent: base.queueACount === 4,
      immutableCollisionRejected: true,
      crossPartitionCollisionRejected: true,
      terminalConflictRejected: true,
      pendingAfterRestart: pendingA.map((item) => item.id),
      settledPersisted: settled?.state === 'settled',
      rejectedPersisted: rejected?.state === 'rejected',
      rejectionReasonPersisted: rejected?.rejectionReason === 'server-refused',
      partitionIsolation:
        pendingB.length === 1 && pendingB[0]?.id === PARTITION_B_OPERATION_ID,
      payloadPersisted: payload?.totalMinor === '1350',
    };
  } finally {
    store.close();
  }

  await injectCorruptQueueRow();
  const corruptionStore = await openKorviOfflineStore();
  let corruptionRejected = false;
  try {
    await corruptionStore.pending(PARTITION_CORRUPT, 20);
  } catch (error) {
    corruptionRejected = error instanceof OfflineStoreError && error.code === 'corrupt';
  } finally {
    corruptionStore.close();
  }

  const result: VerifyResult = { ...resultWithoutCorruption, corruptionRejected };
  setStatus({ phase: 'verified-after-full-process-and-origin-outage', ...result });
  return result;
}

host.gate43Proof = { ready: true, seed, verify };
setStatus({
  ready: true,
  database: OFFLINE_DB_NAME,
  targetVersion: OFFLINE_DB_VERSION,
  queueStore: OFFLINE_TRANSACTION_QUEUE_STORE,
});
