import {
  OFFLINE_CATALOGUE_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_SALE_DRAFT_STORE,
  OfflineStoreError,
  openKorviOfflineStore,
} from '../../apps/pos-web/src/lib/offline-store';
import type { ProductSummary } from '../../apps/pos-web/src/lib/api-types';
import type {
  OfflineSaleDraft,
  OfflineSaleScope,
} from '../../apps/pos-web/src/lib/offline-store';

const TENANT_A = '018f2000-0000-7000-8000-0000000000a1';
const TENANT_B = '018f2000-0000-7000-8000-0000000000b1';
const TENANT_CORRUPT = '018f2000-0000-7000-8000-0000000000c1';

const PRODUCT_A1: ProductSummary = {
  id: '018f2000-0000-7000-8000-000000000101',
  sku: 'MILK-1L',
  nameAr: 'حليب طازج',
  nameEn: 'Fresh Milk',
  productType: 'unit',
  unitLabel: 'حبة',
  priceMinor: '1150',
  vatBasisPoints: 1500,
  primaryBarcode: '6281000000012',
  trackInventory: true,
};

const PRODUCT_A2: ProductSummary = {
  id: '018f2000-0000-7000-8000-000000000102',
  sku: 'RICE-5KG',
  nameAr: 'أرز ٥ كجم',
  nameEn: 'Rice 5kg',
  productType: 'unit',
  unitLabel: 'كيس',
  priceMinor: '2750',
  vatBasisPoints: 1500,
  primaryBarcode: '6281000000029',
  trackInventory: true,
};

const PRODUCT_B: ProductSummary = {
  id: '018f2000-0000-7000-8000-000000000201',
  sku: 'OTHER-TENANT',
  nameAr: 'صنف منشأة أخرى',
  nameEn: null,
  productType: 'unit',
  unitLabel: 'حبة',
  priceMinor: '999',
  vatBasisPoints: 1500,
  primaryBarcode: '6281000000098',
  trackInventory: true,
};

const SCOPE_A: OfflineSaleScope = {
  tenantId: TENANT_A,
  branchId: '018f2000-0000-7000-8000-0000000000a2',
  terminalId: '018f2000-0000-7000-8000-0000000000a3',
  userId: '018f2000-0000-7000-8000-0000000000a4',
  shiftId: '018f2000-0000-7000-8000-0000000000a5',
};

const SCOPE_B: OfflineSaleScope = {
  tenantId: TENANT_B,
  branchId: '018f2000-0000-7000-8000-0000000000b2',
  terminalId: '018f2000-0000-7000-8000-0000000000b3',
  userId: '018f2000-0000-7000-8000-0000000000b4',
  shiftId: '018f2000-0000-7000-8000-0000000000b5',
};

const DRAFT_A: OfflineSaleDraft = {
  lines: [
    {
      productId: PRODUCT_A1.id,
      sku: PRODUCT_A1.sku,
      nameAr: PRODUCT_A1.nameAr,
      nameEn: PRODUCT_A1.nameEn,
      productType: PRODUCT_A1.productType,
      unitLabel: PRODUCT_A1.unitLabel,
      unitPriceMinor: PRODUCT_A1.priceMinor,
      vatBasisPoints: PRODUCT_A1.vatBasisPoints,
      quantityScaled: '2000',
    },
  ],
  cash: '50.00',
  priceMode: 'inclusive',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

interface SeedResult {
  readonly version: number;
  readonly stores: readonly string[];
  readonly tenantACount: number;
  readonly tenantBCount: number;
  readonly draftQuantity: string | null;
}

interface VerifyResult extends SeedResult {
  readonly arabicSearchSku: string | null;
  readonly barcodeSearchSku: string | null;
  readonly tenantIsolation: boolean;
  readonly draftIsolation: boolean;
  readonly corruptionRejected: boolean;
}

interface Gate42ProofApi {
  readonly ready: true;
  seed(): Promise<SeedResult>;
  verify(): Promise<VerifyResult>;
}

const host = globalThis as typeof globalThis & { gate42Proof?: Gate42ProofApi };

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
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

async function injectCorruptCatalogueRow(): Promise<void> {
  const request = globalThis.indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
  const database = await idbRequest(request);
  try {
    const transaction = database.transaction(OFFLINE_CATALOGUE_STORE, 'readwrite');
    transaction.objectStore(OFFLINE_CATALOGUE_STORE).put({
      cacheKey: `${TENANT_CORRUPT}:broken`,
      tenantId: TENANT_CORRUPT,
      id: 'broken',
      sku: 'BROKEN',
      nameAr: 'تالف',
      searchText: 'broken',
      cachedAt: 'not-a-date',
    });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function seed(): Promise<SeedResult> {
  const store = await openKorviOfflineStore();
  try {
    await store.replaceCatalogue(TENANT_A, [PRODUCT_A1, PRODUCT_A2], '2026-09-12T00:00:00.000Z');
    await store.replaceCatalogue(TENANT_B, [PRODUCT_B], '2026-09-12T00:00:00.000Z');
    await store.saveSaleDraft(SCOPE_A, DRAFT_A);
    const description = store.describe();
    const draft = await store.loadSaleDraft(SCOPE_A);
    const result: SeedResult = {
      version: description.version,
      stores: description.stores,
      tenantACount: await store.catalogueCount(TENANT_A),
      tenantBCount: await store.catalogueCount(TENANT_B),
      draftQuantity: draft?.lines[0]?.quantityScaled ?? null,
    };
    setStatus({ phase: 'seeded', ...result });
    return result;
  } finally {
    store.close();
  }
}

async function verify(): Promise<VerifyResult> {
  const store = await openKorviOfflineStore();
  let base: Omit<VerifyResult, 'corruptionRejected'>;
  try {
    const description = store.describe();
    const tenantA = await store.searchCatalogue(TENANT_A, '', 50);
    const tenantB = await store.searchCatalogue(TENANT_B, '', 50);
    const arabic = await store.searchCatalogue(TENANT_A, 'حليب', 50);
    const barcode = await store.searchCatalogue(TENANT_A, PRODUCT_A2.primaryBarcode ?? '', 50);
    const draftA = await store.loadSaleDraft(SCOPE_A);
    const draftB = await store.loadSaleDraft(SCOPE_B);
    base = {
      version: description.version,
      stores: description.stores,
      tenantACount: tenantA.length,
      tenantBCount: tenantB.length,
      draftQuantity: draftA?.lines[0]?.quantityScaled ?? null,
      arabicSearchSku: arabic[0]?.sku ?? null,
      barcodeSearchSku: barcode[0]?.sku ?? null,
      tenantIsolation: tenantA.every((product) => product.id !== PRODUCT_B.id),
      draftIsolation: draftB === null,
    };
  } finally {
    store.close();
  }

  await injectCorruptCatalogueRow();
  const corruptionStore = await openKorviOfflineStore();
  let corruptionRejected = false;
  try {
    await corruptionStore.searchCatalogue(TENANT_CORRUPT, '', 20);
  } catch (error) {
    corruptionRejected = error instanceof OfflineStoreError && error.code === 'corrupt';
  } finally {
    corruptionStore.close();
  }

  const result: VerifyResult = { ...base, corruptionRejected };
  setStatus({ phase: 'verified-after-browser-restart', ...result });
  return result;
}

host.gate42Proof = { ready: true, seed, verify };
setStatus({ ready: true, database: OFFLINE_DB_NAME, saleStore: OFFLINE_SALE_DRAFT_STORE });
