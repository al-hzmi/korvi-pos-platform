import {
  isUuidV7,
  type PriceMode,
  type QueueClaimRequest,
  type QueueClaimResult,
  type QueueOperationInput,
  type QueuedOperation,
  type QueuePartition,
  type TransactionQueuePort,
} from '@korvi/domain';
import type { ProductSummary } from './api-types';
import type { CartLine } from './cart';

export const OFFLINE_DB_NAME = 'korvi-pos-offline';
export const OFFLINE_DB_VERSION = 3;
export const OFFLINE_CATALOGUE_STORE = 'catalogue-v1';
export const OFFLINE_SALE_DRAFT_STORE = 'sale-drafts-v1';
export const OFFLINE_TRANSACTION_QUEUE_STORE = 'transaction-queue-v1';

const TENANT_INDEX = 'tenantId';
const QUEUE_PARTITION_INDEX = 'queuePartition';
const QUEUE_ORDER_INDEX = 'queueOrder';
const QUEUE_ID_INDEX = 'operationId';
const MAX_LOCAL_SEARCH_RESULTS = 50;
const MAX_QUEUE_READ = 500;
const MAX_QUEUE_PAYLOAD_BYTES = 256 * 1024;
const MAX_REJECTION_REASON_LENGTH = 2_048;
const MAX_QUEUE_LEASE_MS = 5 * 60 * 1000;
const QUEUE_KIND_PATTERN = /^[a-z][a-z0-9.-]{0,99}$/;

export type OfflineStoreErrorCode =
  'unavailable' | 'blocked' | 'quota' | 'version' | 'corrupt' | 'conflict' | 'transaction';

export class OfflineStoreError extends Error {
  public override readonly name = 'OfflineStoreError';

  public constructor(
    public readonly code: OfflineStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface OfflineSaleScope {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly shiftId: string;
}

export interface OfflineSaleDraft {
  readonly lines: readonly CartLine[];
  readonly cash: string;
  readonly priceMode: PriceMode;
  readonly updatedAt: string;
}

interface StoredProduct extends ProductSummary {
  readonly cacheKey: string;
  readonly tenantId: string;
  readonly searchText: string;
  readonly cachedAt: string;
}

interface StoredSaleDraft extends OfflineSaleDraft, OfflineSaleScope {
  readonly scopeKey: string;
}

interface StoredQueuedOperation {
  readonly queueKey: string;
  readonly partitionKey: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly id: string;
  readonly kind: string;
  readonly payloadJson: string;
  readonly state: QueuedOperation['state'];
  readonly attempts: number;
  readonly enqueuedAt: string;
  readonly nextAttemptAt: string;
  readonly leaseUntil: string | null;
  readonly claimToken: string | null;
  readonly rejectionReason: string | null;
}

export interface OfflineStoreDescription {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly string[];
}

export interface KorviOfflineStore extends TransactionQueuePort {
  upsertCatalogue(
    tenantId: string,
    products: readonly ProductSummary[],
    cachedAt?: string,
  ): Promise<void>;
  replaceCatalogue(
    tenantId: string,
    products: readonly ProductSummary[],
    cachedAt?: string,
  ): Promise<void>;
  searchCatalogue(
    tenantId: string,
    term: string,
    limit?: number,
  ): Promise<readonly ProductSummary[]>;
  catalogueCount(tenantId: string): Promise<number>;
  saveSaleDraft(scope: OfflineSaleScope, draft: OfflineSaleDraft): Promise<void>;
  loadSaleDraft(scope: OfflineSaleScope): Promise<OfflineSaleDraft | null>;
  deleteSaleDraft(scope: OfflineSaleScope): Promise<void>;
  queueCount(partition: QueuePartition): Promise<number>;
  describe(): OfflineStoreDescription;
  close(): void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isIntegerString(value: unknown, allowZero: boolean): value is string {
  if (typeof value !== 'string') return false;
  return (allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isProductSummary(value: unknown): value is ProductSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.sku === 'string' &&
    typeof value.nameAr === 'string' &&
    isNullableString(value.nameEn) &&
    (value.productType === 'unit' || value.productType === 'weighted') &&
    isNullableString(value.unitLabel) &&
    isIntegerString(value.priceMinor, true) &&
    typeof value.vatBasisPoints === 'number' &&
    Number.isInteger(value.vatBasisPoints) &&
    value.vatBasisPoints >= 0 &&
    value.vatBasisPoints <= 10_000 &&
    isNullableString(value.primaryBarcode) &&
    typeof value.trackInventory === 'boolean'
  );
}

function isCartLine(value: unknown): value is CartLine {
  if (!isRecord(value)) return false;
  return (
    typeof value.productId === 'string' &&
    typeof value.sku === 'string' &&
    typeof value.nameAr === 'string' &&
    isNullableString(value.nameEn) &&
    (value.productType === 'unit' || value.productType === 'weighted') &&
    isNullableString(value.unitLabel) &&
    isIntegerString(value.unitPriceMinor, true) &&
    typeof value.vatBasisPoints === 'number' &&
    Number.isInteger(value.vatBasisPoints) &&
    value.vatBasisPoints >= 0 &&
    value.vatBasisPoints <= 10_000 &&
    isIntegerString(value.quantityScaled, false)
  );
}

function isPriceMode(value: unknown): value is PriceMode {
  return value === 'inclusive' || value === 'exclusive';
}

export function isOfflineSaleDraft(value: unknown): value is OfflineSaleDraft {
  if (!isRecord(value) || !Array.isArray(value.lines)) return false;
  return (
    value.lines.every(isCartLine) &&
    typeof value.cash === 'string' &&
    isPriceMode(value.priceMode) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

export function offlineSaleScopeKey(scope: OfflineSaleScope): string {
  return JSON.stringify([
    scope.tenantId,
    scope.branchId,
    scope.terminalId,
    scope.userId,
    scope.shiftId,
  ]);
}

function assertQueuePartition(partition: QueuePartition): void {
  if (
    !isUuidV7(partition.tenantId) ||
    !isUuidV7(partition.branchId) ||
    !isUuidV7(partition.terminalId)
  ) {
    throw new OfflineStoreError(
      'corrupt',
      'Queue partition identities must be canonical UUIDv7 values.',
    );
  }
}

export function queuePartitionKey(partition: QueuePartition): string {
  assertQueuePartition(partition);
  return JSON.stringify([partition.tenantId, partition.branchId, partition.terminalId]);
}

function queueRecordKey(partition: QueuePartition, id: string): string {
  if (!isUuidV7(id)) {
    throw new OfflineStoreError('corrupt', 'Queue operation id must be a canonical UUIDv7.');
  }
  return JSON.stringify([partition.tenantId, partition.branchId, partition.terminalId, id]);
}

function canonicalJson(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OfflineStoreError('corrupt', 'Queue payload cannot contain non-finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new OfflineStoreError('corrupt', 'Queue payload must contain JSON values only.');
  }

  if (seen.has(value)) {
    throw new OfflineStoreError('corrupt', 'Queue payload cannot contain cycles.');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new OfflineStoreError('corrupt', 'Queue payload arrays cannot contain holes.');
        }
        entries.push(canonicalJson(value[index], seen));
      }
      return `[${entries.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OfflineStoreError(
        'corrupt',
        'Queue payload objects must have a plain JSON prototype.',
      );
    }

    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function serializeQueuePayload(value: unknown): string {
  const serialized = canonicalJson(value, new Set<object>());
  if (new TextEncoder().encode(serialized).byteLength > MAX_QUEUE_PAYLOAD_BYTES) {
    throw new OfflineStoreError(
      'quota',
      `Queue payload exceeds the ${String(MAX_QUEUE_PAYLOAD_BYTES)} byte safety limit.`,
    );
  }
  return serialized;
}

function parseQueuePayload(payloadJson: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new OfflineStoreError('corrupt', 'Queued payload is not valid JSON.');
  }
  if (serializeQueuePayload(parsed) !== payloadJson) {
    throw new OfflineStoreError('corrupt', 'Queued payload is not in canonical JSON form.');
  }
  return parsed;
}

export function isQueueOperationInput(value: unknown): value is QueueOperationInput {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isUuidV7(value.id) ||
    typeof value.kind !== 'string' ||
    !QUEUE_KIND_PATTERN.test(value.kind) ||
    typeof value.enqueuedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.enqueuedAt)) ||
    !Object.prototype.hasOwnProperty.call(value, 'payload')
  ) {
    return false;
  }
  try {
    serializeQueuePayload(value.payload);
    return true;
  } catch {
    return false;
  }
}

function isQueueState(value: unknown): value is QueuedOperation['state'] {
  return (
    value === 'pending' || value === 'in-flight' || value === 'settled' || value === 'rejected'
  );
}

export function classifyIndexedDbError(error: unknown): OfflineStoreError {
  if (error instanceof OfflineStoreError) return error;
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError') {
      return new OfflineStoreError('quota', 'IndexedDB quota is exhausted.');
    }
    if (error.name === 'VersionError') {
      return new OfflineStoreError('version', 'IndexedDB schema version is incompatible.');
    }
    if (error.name === 'InvalidStateError' || error.name === 'NotAllowedError') {
      return new OfflineStoreError(
        'unavailable',
        'IndexedDB is unavailable in this browser context.',
      );
    }
    if (error.name === 'ConstraintError') {
      return new OfflineStoreError('conflict', 'IndexedDB uniqueness constraint was violated.');
    }
    return new OfflineStoreError('transaction', `IndexedDB ${error.name} failure.`);
  }
  return new OfflineStoreError('transaction', 'IndexedDB transaction failed.');
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(classifyIndexedDbError(request.error));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(classifyIndexedDbError(transaction.error));
    transaction.onerror = () => reject(classifyIndexedDbError(transaction.error));
  });
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('ar-SA');
}

function productSearchText(product: ProductSummary): string {
  return normalized(
    [product.sku, product.nameAr, product.nameEn ?? '', product.primaryBarcode ?? ''].join('\n'),
  );
}

function productCacheKey(tenantId: string, productId: string): string {
  return `${tenantId}:${productId}`;
}

function toStoredProduct(
  tenantId: string,
  product: ProductSummary,
  cachedAt: string,
): StoredProduct {
  if (!isProductSummary(product)) {
    throw new OfflineStoreError('corrupt', 'Refusing to persist an invalid catalogue product.');
  }
  return {
    ...product,
    cacheKey: productCacheKey(tenantId, product.id),
    tenantId,
    searchText: productSearchText(product),
    cachedAt,
  };
}

function fromStoredProduct(value: unknown, tenantId: string): ProductSummary {
  if (
    !isRecord(value) ||
    value.tenantId !== tenantId ||
    typeof value.searchText !== 'string' ||
    typeof value.cachedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.cachedAt)) ||
    !isProductSummary(value)
  ) {
    throw new OfflineStoreError('corrupt', 'Cached catalogue data failed validation.');
  }
  return {
    id: value.id,
    sku: value.sku,
    nameAr: value.nameAr,
    nameEn: value.nameEn,
    productType: value.productType,
    unitLabel: value.unitLabel,
    priceMinor: value.priceMinor,
    vatBasisPoints: value.vatBasisPoints,
    primaryBarcode: value.primaryBarcode,
    trackInventory: value.trackInventory,
  };
}

function fromStoredSaleDraft(value: unknown, scope: OfflineSaleScope): OfflineSaleDraft {
  if (
    !isRecord(value) ||
    value.scopeKey !== offlineSaleScopeKey(scope) ||
    value.tenantId !== scope.tenantId ||
    value.branchId !== scope.branchId ||
    value.terminalId !== scope.terminalId ||
    value.userId !== scope.userId ||
    value.shiftId !== scope.shiftId ||
    !isOfflineSaleDraft(value)
  ) {
    throw new OfflineStoreError('corrupt', 'Cached sale draft failed validation.');
  }
  return {
    lines: value.lines,
    cash: value.cash,
    priceMode: value.priceMode,
    updatedAt: value.updatedAt,
  };
}

function toStoredQueueRow(
  partition: QueuePartition,
  operation: QueueOperationInput,
): StoredQueuedOperation {
  assertQueuePartition(partition);
  if (!isQueueOperationInput(operation)) {
    throw new OfflineStoreError('corrupt', 'Refusing to persist an invalid queue operation.');
  }
  return {
    queueKey: queueRecordKey(partition, operation.id),
    partitionKey: queuePartitionKey(partition),
    tenantId: partition.tenantId,
    branchId: partition.branchId,
    terminalId: partition.terminalId,
    id: operation.id,
    kind: operation.kind,
    payloadJson: serializeQueuePayload(operation.payload),
    state: 'pending',
    attempts: 0,
    enqueuedAt: operation.enqueuedAt,
    nextAttemptAt: operation.enqueuedAt,
    leaseUntil: null,
    claimToken: null,
    rejectionReason: null,
  };
}

function decodeStoredQueueRow(
  value: unknown,
  partition: QueuePartition,
): { readonly stored: StoredQueuedOperation; readonly operation: QueuedOperation } {
  assertQueuePartition(partition);
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isUuidV7(value.id) ||
    value.queueKey !== queueRecordKey(partition, value.id) ||
    value.partitionKey !== queuePartitionKey(partition) ||
    value.tenantId !== partition.tenantId ||
    value.branchId !== partition.branchId ||
    value.terminalId !== partition.terminalId ||
    typeof value.kind !== 'string' ||
    !QUEUE_KIND_PATTERN.test(value.kind) ||
    typeof value.payloadJson !== 'string' ||
    !isQueueState(value.state) ||
    typeof value.attempts !== 'number' ||
    !Number.isInteger(value.attempts) ||
    value.attempts < 0 ||
    typeof value.enqueuedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.enqueuedAt)) ||
    typeof value.nextAttemptAt !== 'string' ||
    !Number.isFinite(Date.parse(value.nextAttemptAt)) ||
    !(
      value.leaseUntil === null ||
      (typeof value.leaseUntil === 'string' && Number.isFinite(Date.parse(value.leaseUntil)))
    ) ||
    !(
      value.claimToken === null ||
      (typeof value.claimToken === 'string' && isUuidV7(value.claimToken))
    ) ||
    !(value.rejectionReason === null || typeof value.rejectionReason === 'string')
  ) {
    throw new OfflineStoreError('corrupt', 'Queued operation failed structural validation.');
  }

  if (
    (value.state === 'rejected' &&
      (value.rejectionReason === null ||
        value.rejectionReason.trim() === '' ||
        value.rejectionReason.length > MAX_REJECTION_REASON_LENGTH)) ||
    (value.state !== 'rejected' && value.rejectionReason !== null) ||
    (value.state === 'in-flight' && (value.claimToken === null || value.leaseUntil === null)) ||
    (value.state !== 'in-flight' && (value.claimToken !== null || value.leaseUntil !== null))
  ) {
    throw new OfflineStoreError('corrupt', 'Queued operation lifecycle metadata is inconsistent.');
  }

  const payload = parseQueuePayload(value.payloadJson);
  const input: QueueOperationInput = {
    id: value.id,
    kind: value.kind,
    payload,
    enqueuedAt: value.enqueuedAt,
  };
  if (!isQueueOperationInput(input)) {
    throw new OfflineStoreError('corrupt', 'Queued operation envelope failed validation.');
  }

  return {
    stored: value as unknown as StoredQueuedOperation,
    operation: {
      ...input,
      state: value.state,
      attempts: value.attempts,
      nextAttemptAt: value.nextAttemptAt,
      leaseUntil: value.leaseUntil,
      rejectionReason: value.rejectionReason,
    },
  };
}

function createBaseSchema(database: IDBDatabase): void {
  const catalogue = database.createObjectStore(OFFLINE_CATALOGUE_STORE, { keyPath: 'cacheKey' });
  catalogue.createIndex(TENANT_INDEX, TENANT_INDEX, { unique: false });
  const drafts = database.createObjectStore(OFFLINE_SALE_DRAFT_STORE, { keyPath: 'scopeKey' });
  drafts.createIndex(TENANT_INDEX, TENANT_INDEX, { unique: false });
}

function createQueueSchema(database: IDBDatabase): void {
  const queue = database.createObjectStore(OFFLINE_TRANSACTION_QUEUE_STORE, {
    keyPath: 'queueKey',
  });
  queue.createIndex(QUEUE_PARTITION_INDEX, 'partitionKey', { unique: false });
  queue.createIndex(QUEUE_ORDER_INDEX, ['partitionKey', 'id'], { unique: true });
  queue.createIndex(QUEUE_ID_INDEX, 'id', { unique: true });
}

function migrateQueueLifecycleV3(transaction: IDBTransaction): void {
  const store = transaction.objectStore(OFFLINE_TRANSACTION_QUEUE_STORE);
  const request = store.openCursor();
  request.onerror = () => transaction.abort();
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor === null) return;
    const row = cursor.value as Record<string, unknown>;
    if (typeof row['enqueuedAt'] !== 'string') {
      transaction.abort();
      return;
    }
    cursor.update({
      ...row,
      state: row['state'] === 'in-flight' ? 'pending' : row['state'],
      nextAttemptAt: row['enqueuedAt'],
      leaseUntil: null,
      claimToken: null,
    });
    cursor.continue();
  };
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    let settled = false;

    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) createBaseSchema(request.result);
      if (event.oldVersion < 2) createQueueSchema(request.result);
      if (event.oldVersion < 3 && event.oldVersion >= 2 && request.transaction !== null)
        migrateQueueLifecycleV3(request.transaction);
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(
        new OfflineStoreError(
          'blocked',
          'Another Korvi tab is blocking the IndexedDB schema transition.',
        ),
      );
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(classifyIndexedDbError(request.error));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function replaceTenantCatalogue(
  database: IDBDatabase,
  tenantId: string,
  products: readonly StoredProduct[],
): Promise<void> {
  const transaction = database.transaction(OFFLINE_CATALOGUE_STORE, 'readwrite');
  const store = transaction.objectStore(OFFLINE_CATALOGUE_STORE);
  const cursorRequest = store.index(TENANT_INDEX).openCursor(IDBKeyRange.only(tenantId));

  cursorRequest.onerror = () => transaction.abort();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor !== null) {
      cursor.delete();
      cursor.continue();
      return;
    }
    for (const product of products) store.put(product);
  };

  return transactionDone(transaction);
}

async function enqueueQueuedOperation(
  database: IDBDatabase,
  partition: QueuePartition,
  operation: QueueOperationInput,
): Promise<void> {
  const row = toStoredQueueRow(partition, operation);
  const transaction = database.transaction(OFFLINE_TRANSACTION_QUEUE_STORE, 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(OFFLINE_TRANSACTION_QUEUE_STORE);
  const lookup = store.index(QUEUE_ID_INDEX).get(operation.id);
  let failure: OfflineStoreError | null = null;

  lookup.onerror = () => {
    failure = classifyIndexedDbError(lookup.error);
    transaction.abort();
  };
  lookup.onsuccess = () => {
    try {
      if (lookup.result === undefined) {
        store.add(row);
        return;
      }
      if (!isRecord(lookup.result) || lookup.result.partitionKey !== row.partitionKey) {
        failure = new OfflineStoreError(
          'conflict',
          'Queue operation id is already owned by another partition.',
        );
        transaction.abort();
        return;
      }
      const existing = decodeStoredQueueRow(lookup.result, partition).stored;
      if (
        existing.kind !== row.kind ||
        existing.payloadJson !== row.payloadJson ||
        existing.enqueuedAt !== row.enqueuedAt
      ) {
        failure = new OfflineStoreError(
          'conflict',
          'Queue operation id cannot be reused for a different immutable command.',
        );
        transaction.abort();
      }
    } catch (error) {
      failure = classifyIndexedDbError(error);
      transaction.abort();
    }
  };

  try {
    await done;
  } catch (error) {
    if (failure !== null) throw failure;
    throw classifyIndexedDbError(error);
  }
}

async function listPendingQueuedOperations(
  database: IDBDatabase,
  partition: QueuePartition,
  limit: number,
): Promise<readonly QueuedOperation[]> {
  const partitionKey = queuePartitionKey(partition);
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), MAX_QUEUE_READ);
  const transaction = database.transaction(OFFLINE_TRANSACTION_QUEUE_STORE, 'readonly');
  const done = transactionDone(transaction);
  const index = transaction.objectStore(OFFLINE_TRANSACTION_QUEUE_STORE).index(QUEUE_ORDER_INDEX);
  const range = IDBKeyRange.bound([partitionKey, ''], [partitionKey, '\uffff']);
  const request = index.openCursor(range, 'next');
  const operations: QueuedOperation[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(classifyIndexedDbError(request.error));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null || operations.length >= bounded) {
          resolve();
          return;
        }
        try {
          const operation = decodeStoredQueueRow(cursor.value, partition).operation;
          if (operation.state === 'pending') operations.push(operation);
          if (operations.length >= bounded) {
            resolve();
            return;
          }
          cursor.continue();
        } catch (error) {
          transaction.abort();
          reject(classifyIndexedDbError(error));
        }
      };
    });
    await done;
    return operations;
  } catch (error) {
    await done.catch(() => undefined);
    throw classifyIndexedDbError(error);
  }
}

function validateClaimRequest(request: QueueClaimRequest): number {
  const nowMs = Date.parse(request.now);
  const leaseMs = Date.parse(request.leaseUntil);
  if (
    !isUuidV7(request.token) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(leaseMs) ||
    leaseMs <= nowMs ||
    leaseMs - nowMs > MAX_QUEUE_LEASE_MS
  )
    throw new OfflineStoreError('corrupt', 'Invalid queue claim lease.');
  return nowMs;
}
async function claimNextQueuedOperation<TPayload>(
  database: IDBDatabase,
  partition: QueuePartition,
  input: QueueClaimRequest,
): Promise<QueueClaimResult<TPayload>> {
  const nowMs = validateClaimRequest(input);
  const key = queuePartitionKey(partition);
  const tx = database.transaction(OFFLINE_TRANSACTION_QUEUE_STORE, 'readwrite');
  const done = transactionDone(tx);
  const req = tx
    .objectStore(OFFLINE_TRANSACTION_QUEUE_STORE)
    .index(QUEUE_ORDER_INDEX)
    .openCursor(IDBKeyRange.bound([key, ''], [key, '\uffff']), 'next');
  let result: QueueClaimResult<TPayload> = { status: 'empty' };
  await new Promise<void>((resolve, reject) => {
    req.onerror = () => reject(classifyIndexedDbError(req.error));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor === null) {
        resolve();
        return;
      }
      try {
        const decoded = decodeStoredQueueRow(cursor.value, partition);
        if (decoded.operation.state === 'settled' || decoded.operation.state === 'rejected') {
          cursor.continue();
          return;
        }
        if (
          decoded.operation.state === 'pending' &&
          Date.parse(decoded.operation.nextAttemptAt) > nowMs
        ) {
          result = {
            status: 'blocked',
            reason: 'retry-delay',
            until: decoded.operation.nextAttemptAt,
          };
          resolve();
          return;
        }
        if (decoded.operation.state === 'in-flight') {
          const until = decoded.operation.leaseUntil;
          if (until === null) throw new OfflineStoreError('corrupt', 'Missing queue lease.');
          if (Date.parse(until) > nowMs) {
            result = { status: 'blocked', reason: 'active-lease', until };
            resolve();
            return;
          }
        }
        const attempts = decoded.operation.attempts + 1;
        cursor.update({
          ...decoded.stored,
          state: 'in-flight',
          attempts,
          leaseUntil: input.leaseUntil,
          claimToken: input.token,
          rejectionReason: null,
        } satisfies StoredQueuedOperation);
        result = {
          status: 'claimed',
          claim: {
            token: input.token,
            operation: {
              ...decoded.operation,
              state: 'in-flight',
              attempts,
              leaseUntil: input.leaseUntil,
            } as QueuedOperation<TPayload>,
          },
        };
        resolve();
      } catch (error) {
        tx.abort();
        reject(classifyIndexedDbError(error));
      }
    };
  });
  await done;
  return result;
}
async function transitionClaim(
  database: IDBDatabase,
  partition: QueuePartition,
  id: string,
  token: string,
  target: 'settled' | 'rejected' | 'pending',
  value: string | null,
): Promise<void> {
  if (!isUuidV7(token)) throw new OfflineStoreError('corrupt', 'Invalid claim token.');
  const reason = target === 'rejected' ? (value?.trim() ?? null) : null;
  if (
    target === 'rejected' &&
    (reason === null || reason === '' || reason.length > MAX_REJECTION_REASON_LENGTH)
  )
    throw new OfflineStoreError('corrupt', 'Invalid rejection reason.');
  if (target === 'pending' && (value === null || !Number.isFinite(Date.parse(value))))
    throw new OfflineStoreError('corrupt', 'Invalid retry timestamp.');
  const tx = database.transaction(OFFLINE_TRANSACTION_QUEUE_STORE, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(OFFLINE_TRANSACTION_QUEUE_STORE);
  const req = store.get(queueRecordKey(partition, id));
  let failure: OfflineStoreError | null = null;
  req.onerror = () => {
    failure = classifyIndexedDbError(req.error);
    tx.abort();
  };
  req.onsuccess = () => {
    try {
      if (req.result === undefined) {
        failure = new OfflineStoreError('conflict', 'Queue operation missing.');
        tx.abort();
        return;
      }
      const decoded = decodeStoredQueueRow(req.result, partition);
      if (decoded.operation.state !== 'in-flight' || decoded.stored.claimToken !== token) {
        failure = new OfflineStoreError('conflict', 'Stale queue claim.');
        tx.abort();
        return;
      }
      store.put({
        ...decoded.stored,
        state: target,
        nextAttemptAt: target === 'pending' ? value! : decoded.stored.nextAttemptAt,
        leaseUntil: null,
        claimToken: null,
        rejectionReason: target === 'rejected' ? reason : null,
      } satisfies StoredQueuedOperation);
    } catch (error) {
      failure = classifyIndexedDbError(error);
      tx.abort();
    }
  };
  try {
    await done;
  } catch (error) {
    if (failure !== null) throw failure;
    throw classifyIndexedDbError(error);
  }
}
async function loadQueuedOperation<TPayload>(
  database: IDBDatabase,
  partition: QueuePartition,
  id: string,
): Promise<QueuedOperation<TPayload> | null> {
  const key = queueRecordKey(partition, id);
  const transaction = database.transaction(OFFLINE_TRANSACTION_QUEUE_STORE, 'readonly');
  const done = transactionDone(transaction);
  const value = await requestValue(
    transaction.objectStore(OFFLINE_TRANSACTION_QUEUE_STORE).get(key),
  );
  await done;
  if (value === undefined) return null;
  return decodeStoredQueueRow(value, partition).operation as QueuedOperation<TPayload>;
}

async function transitionQueuedOperation(
  database: IDBDatabase,
  partition: QueuePartition,
  id: string,
  target: 'settled' | 'rejected',
  rejectionReason: string | null,
): Promise<void> {
  const key = queueRecordKey(partition, id);
  const normalizedReason = rejectionReason?.trim() ?? null;
  if (
    target === 'rejected' &&
    (normalizedReason === null ||
      normalizedReason === '' ||
      normalizedReason.length > MAX_REJECTION_REASON_LENGTH)
  ) {
    throw new OfflineStoreError(
      'corrupt',
      `Queue rejection reason must be 1-${String(MAX_REJECTION_REASON_LENGTH)} characters.`,
    );
  }

  const transaction = database.transaction(OFFLINE_TRANSACTION_QUEUE_STORE, 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(OFFLINE_TRANSACTION_QUEUE_STORE);
  const request = store.get(key);
  let failure: OfflineStoreError | null = null;

  request.onerror = () => {
    failure = classifyIndexedDbError(request.error);
    transaction.abort();
  };
  request.onsuccess = () => {
    try {
      if (request.result === undefined) {
        failure = new OfflineStoreError(
          'conflict',
          'Queue operation does not exist in this partition.',
        );
        transaction.abort();
        return;
      }
      const decoded = decodeStoredQueueRow(request.result, partition);
      if (decoded.operation.state === target) {
        if (target === 'rejected' && decoded.operation.rejectionReason !== normalizedReason) {
          failure = new OfflineStoreError(
            'conflict',
            'Rejected queue operation cannot be rewritten with a different reason.',
          );
          transaction.abort();
        }
        return;
      }
      if (decoded.operation.state === 'in-flight') {
        failure = new OfflineStoreError('conflict', 'Claim token required.');
        transaction.abort();
        return;
      }
      if (decoded.operation.state === 'settled' || decoded.operation.state === 'rejected') {
        failure = new OfflineStoreError(
          'conflict',
          'A terminal queue operation cannot transition to a different terminal outcome.',
        );
        transaction.abort();
        return;
      }
      store.put({
        ...decoded.stored,
        state: target,
        rejectionReason: target === 'rejected' ? normalizedReason : null,
      } satisfies StoredQueuedOperation);
    } catch (error) {
      failure = classifyIndexedDbError(error);
      transaction.abort();
    }
  };

  try {
    await done;
  } catch (error) {
    if (failure !== null) throw failure;
    throw classifyIndexedDbError(error);
  }
}

export async function openKorviOfflineStore(factory?: IDBFactory): Promise<KorviOfflineStore> {
  const resolvedFactory = factory ?? globalThis.indexedDB;
  if (resolvedFactory === undefined) {
    throw new OfflineStoreError('unavailable', 'IndexedDB is not available in this browser.');
  }

  const database = await openDatabase(resolvedFactory);

  return {
    async upsertCatalogue(tenantId, products, cachedAt = new Date().toISOString()) {
      const rows = products.map((product) => toStoredProduct(tenantId, product, cachedAt));
      const transaction = database.transaction(OFFLINE_CATALOGUE_STORE, 'readwrite');
      const store = transaction.objectStore(OFFLINE_CATALOGUE_STORE);
      for (const row of rows) store.put(row);
      await transactionDone(transaction);
    },

    async replaceCatalogue(tenantId, products, cachedAt = new Date().toISOString()) {
      const rows = products.map((product) => toStoredProduct(tenantId, product, cachedAt));
      await replaceTenantCatalogue(database, tenantId, rows);
    },

    async searchCatalogue(tenantId, term, limit = 20) {
      const bounded = Math.min(Math.max(Math.trunc(limit), 1), MAX_LOCAL_SEARCH_RESULTS);
      const transaction = database.transaction(OFFLINE_CATALOGUE_STORE, 'readonly');
      const request = transaction
        .objectStore(OFFLINE_CATALOGUE_STORE)
        .index(TENANT_INDEX)
        .getAll(IDBKeyRange.only(tenantId));
      const values = await requestValue(request);
      await transactionDone(transaction);
      const needle = normalized(term);
      const products: ProductSummary[] = [];
      for (const value of values) {
        const product = fromStoredProduct(value, tenantId);
        if (!isRecord(value) || typeof value.searchText !== 'string') {
          throw new OfflineStoreError('corrupt', 'Cached catalogue search index is invalid.');
        }
        if (needle !== '' && !value.searchText.includes(needle)) continue;
        products.push(product);
        if (products.length === bounded) break;
      }
      return products;
    },

    async catalogueCount(tenantId) {
      const transaction = database.transaction(OFFLINE_CATALOGUE_STORE, 'readonly');
      const request = transaction
        .objectStore(OFFLINE_CATALOGUE_STORE)
        .index(TENANT_INDEX)
        .count(IDBKeyRange.only(tenantId));
      const count = await requestValue(request);
      await transactionDone(transaction);
      return count;
    },

    async saveSaleDraft(scope, draft) {
      if (!isOfflineSaleDraft(draft)) {
        throw new OfflineStoreError('corrupt', 'Refusing to persist an invalid sale draft.');
      }
      const row: StoredSaleDraft = {
        ...scope,
        ...draft,
        scopeKey: offlineSaleScopeKey(scope),
      };
      const transaction = database.transaction(OFFLINE_SALE_DRAFT_STORE, 'readwrite');
      transaction.objectStore(OFFLINE_SALE_DRAFT_STORE).put(row);
      await transactionDone(transaction);
    },

    async loadSaleDraft(scope) {
      const transaction = database.transaction(OFFLINE_SALE_DRAFT_STORE, 'readonly');
      const request = transaction
        .objectStore(OFFLINE_SALE_DRAFT_STORE)
        .get(offlineSaleScopeKey(scope));
      const value = await requestValue(request);
      await transactionDone(transaction);
      return value === undefined ? null : fromStoredSaleDraft(value, scope);
    },

    async deleteSaleDraft(scope) {
      const transaction = database.transaction(OFFLINE_SALE_DRAFT_STORE, 'readwrite');
      transaction.objectStore(OFFLINE_SALE_DRAFT_STORE).delete(offlineSaleScopeKey(scope));
      await transactionDone(transaction);
    },

    async enqueue(partition, operation) {
      await enqueueQueuedOperation(database, partition, operation);
    },

    async pending(partition, limit) {
      return listPendingQueuedOperations(database, partition, limit);
    },

    async get<TPayload = unknown>(partition: QueuePartition, id: string) {
      return loadQueuedOperation<TPayload>(database, partition, id);
    },

    async claimNext<TPayload = unknown>(partition: QueuePartition, request: QueueClaimRequest) {
      return claimNextQueuedOperation<TPayload>(database, partition, request);
    },
    async settleClaim(partition, id, token) {
      await transitionClaim(database, partition, id, token, 'settled', null);
    },
    async retryClaim(partition, id, token, nextAttemptAt) {
      await transitionClaim(database, partition, id, token, 'pending', nextAttemptAt);
    },
    async rejectClaim(partition, id, token, reason) {
      await transitionClaim(database, partition, id, token, 'rejected', reason);
    },

    async markSettled(partition, id) {
      await transitionQueuedOperation(database, partition, id, 'settled', null);
    },

    async markRejected(partition, id, reason) {
      await transitionQueuedOperation(database, partition, id, 'rejected', reason);
    },

    async queueCount(partition) {
      const key = queuePartitionKey(partition);
      const transaction = database.transaction(OFFLINE_TRANSACTION_QUEUE_STORE, 'readonly');
      const request = transaction
        .objectStore(OFFLINE_TRANSACTION_QUEUE_STORE)
        .index(QUEUE_PARTITION_INDEX)
        .count(IDBKeyRange.only(key));
      const count = await requestValue(request);
      await transactionDone(transaction);
      return count;
    },

    describe() {
      return {
        name: database.name,
        version: database.version,
        stores: Array.from(database.objectStoreNames),
      };
    },

    close() {
      database.close();
    },
  };
}
