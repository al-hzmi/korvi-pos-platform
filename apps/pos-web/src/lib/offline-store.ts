import type { PriceMode } from '@korvi/domain';
import type { ProductSummary } from './api-types';
import type { CartLine } from './cart';

export const OFFLINE_DB_NAME = 'korvi-pos-offline';
export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_CATALOGUE_STORE = 'catalogue-v1';
export const OFFLINE_SALE_DRAFT_STORE = 'sale-drafts-v1';

const TENANT_INDEX = 'tenantId';
const MAX_LOCAL_SEARCH_RESULTS = 50;

export type OfflineStoreErrorCode =
  'unavailable' | 'blocked' | 'quota' | 'version' | 'corrupt' | 'transaction';

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

export interface OfflineStoreDescription {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly string[];
}

export interface KorviOfflineStore {
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

function createSchema(database: IDBDatabase): void {
  const catalogue = database.createObjectStore(OFFLINE_CATALOGUE_STORE, { keyPath: 'cacheKey' });
  catalogue.createIndex(TENANT_INDEX, TENANT_INDEX, { unique: false });
  const drafts = database.createObjectStore(OFFLINE_SALE_DRAFT_STORE, { keyPath: 'scopeKey' });
  drafts.createIndex(TENANT_INDEX, TENANT_INDEX, { unique: false });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    let settled = false;

    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) createSchema(request.result);
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
