import type { QueueOperationInput, QueuePartition } from '@korvi/domain';
import { describe, expect, it } from 'vitest';
import {
  OfflineStoreError,
  classifyIndexedDbError,
  isOfflineSaleDraft,
  isProductSummary,
  isQueueOperationInput,
  offlineSaleScopeKey,
  queuePartitionKey,
  queueRecordKey,
  recordMatchesDeviceEnrollment,
  serializeQueuePayload,
} from '../offline-store';

const PRODUCT = {
  id: '018f2000-0000-7000-8000-0000000000a1',
  sku: 'MILK-1L',
  nameAr: 'حليب',
  nameEn: 'Milk',
  productType: 'unit',
  unitLabel: 'حبة',
  priceMinor: '1150',
  vatBasisPoints: 1500,
  primaryBarcode: '6281000000012',
  trackInventory: true,
} as const;

const SCOPE = {
  tenantId: '018f2000-0000-7000-8000-000000000001',
  branchId: '018f2000-0000-7000-8000-000000000002',
  terminalId: '018f2000-0000-7000-8000-000000000003',
  userId: '018f2000-0000-7000-8000-000000000004',
  shiftId: '018f2000-0000-7000-8000-000000000005',
} as const;

const DEVICE_A = '018f2000-0000-7000-8000-000000000006';
const DEVICE_B = '018f2000-0000-7000-8000-000000000007';

const QUEUE_PARTITION: QueuePartition = {
  tenantId: SCOPE.tenantId,
  branchId: SCOPE.branchId,
  terminalId: SCOPE.terminalId,
};
const DEVICE_A_PARTITION: QueuePartition = { ...QUEUE_PARTITION, deviceEnrollmentId: DEVICE_A };
const DEVICE_B_PARTITION: QueuePartition = { ...QUEUE_PARTITION, deviceEnrollmentId: DEVICE_B };

const QUEUE_OPERATION: QueueOperationInput = {
  id: '018f2000-0001-7000-8000-000000000101',
  kind: 'sale.checkout',
  payload: {
    saleId: '018f2000-0001-7000-8000-000000000101',
    totalMinor: '1150',
    lines: [{ productId: PRODUCT.id, quantityScaled: '1000' }],
  },
  enqueuedAt: '2026-09-12T00:00:00.000Z',
};

describe('offline store validation', () => {
  it('accepts exact string financial fields and refuses floating or corrupt catalogue values', () => {
    expect(isProductSummary(PRODUCT)).toBe(true);
    expect(isProductSummary({ ...PRODUCT, priceMinor: 11.5 })).toBe(false);
    expect(isProductSummary({ ...PRODUCT, vatBasisPoints: 1500.5 })).toBe(false);
    expect(isProductSummary({ ...PRODUCT, productType: 'other' })).toBe(false);
  });

  it('accepts a valid durable sale draft and rejects a floating quantity', () => {
    const draft = {
      lines: [
        {
          productId: PRODUCT.id,
          sku: PRODUCT.sku,
          nameAr: PRODUCT.nameAr,
          nameEn: PRODUCT.nameEn,
          productType: PRODUCT.productType,
          unitLabel: PRODUCT.unitLabel,
          unitPriceMinor: PRODUCT.priceMinor,
          vatBasisPoints: PRODUCT.vatBasisPoints,
          quantityScaled: '2000',
        },
      ],
      cash: '50.00',
      priceMode: 'tax-inclusive',
      updatedAt: '2026-09-12T00:00:00.000Z',
    } as const;

    expect(isOfflineSaleDraft(draft)).toBe(true);
    expect(
      isOfflineSaleDraft({
        ...draft,
        lines: [{ ...draft.lines[0], quantityScaled: '2.5' }],
      }),
    ).toBe(false);
  });

  it('partitions drafts by every identity that defines a physical cashier sale context', () => {
    const key = offlineSaleScopeKey(SCOPE);
    expect(key).not.toBe(offlineSaleScopeKey({ ...SCOPE, tenantId: `${SCOPE.tenantId}-other` }));
    expect(key).not.toBe(offlineSaleScopeKey({ ...SCOPE, branchId: `${SCOPE.branchId}-other` }));
    expect(key).not.toBe(
      offlineSaleScopeKey({ ...SCOPE, terminalId: `${SCOPE.terminalId}-other` }),
    );
    expect(key).not.toBe(offlineSaleScopeKey({ ...SCOPE, userId: `${SCOPE.userId}-other` }));
    expect(key).not.toBe(offlineSaleScopeKey({ ...SCOPE, shiftId: `${SCOPE.shiftId}-other` }));
  });

  it('requires canonical UUIDv7 tenant branch and terminal identities for queue partitions', () => {
    const key = queuePartitionKey(QUEUE_PARTITION);
    expect(key).not.toBe(
      queuePartitionKey({
        ...QUEUE_PARTITION,
        terminalId: '018f2000-0000-7000-8000-000000000099',
      }),
    );
    expect(() => queuePartitionKey({ ...QUEUE_PARTITION, tenantId: 'not-a-uuid' })).toThrow(
      OfflineStoreError,
    );
  });

  it('preserves legacy keys while new financial queues are isolated by shift and enrollment', () => {
    expect(queuePartitionKey(QUEUE_PARTITION)).toBe(
      JSON.stringify([SCOPE.tenantId, SCOPE.branchId, SCOPE.terminalId]),
    );
    const shiftA = { ...QUEUE_PARTITION, shiftId: SCOPE.shiftId };
    const shiftB = {
      ...QUEUE_PARTITION,
      shiftId: '018f2000-0000-7000-8000-000000000099',
    };
    expect(queuePartitionKey(shiftA)).not.toBe(queuePartitionKey(QUEUE_PARTITION));
    expect(queuePartitionKey(shiftA)).not.toBe(queuePartitionKey(shiftB));
    expect(queueRecordKey(shiftA, QUEUE_OPERATION.id)).not.toBe(
      queueRecordKey(shiftB, QUEUE_OPERATION.id),
    );
    expect(queuePartitionKey(DEVICE_A_PARTITION)).not.toBe(queuePartitionKey(QUEUE_PARTITION));
    expect(queuePartitionKey(DEVICE_A_PARTITION)).not.toBe(queuePartitionKey(DEVICE_B_PARTITION));
    expect(queueRecordKey(DEVICE_A_PARTITION, QUEUE_OPERATION.id)).not.toBe(
      queueRecordKey(DEVICE_B_PARTITION, QUEUE_OPERATION.id),
    );
    expect(() =>
      queuePartitionKey({ ...QUEUE_PARTITION, deviceEnrollmentId: 'not-a-uuid' }),
    ).toThrow(OfflineStoreError);
  });

  it('isolates installed drafts and refuses cloned or legacy-unbound device records', () => {
    const browserKey = offlineSaleScopeKey(SCOPE);
    const deviceAKey = offlineSaleScopeKey({ ...SCOPE, deviceEnrollmentId: DEVICE_A });
    const deviceBKey = offlineSaleScopeKey({ ...SCOPE, deviceEnrollmentId: DEVICE_B });
    expect(browserKey).toBe(
      JSON.stringify([
        SCOPE.tenantId,
        SCOPE.branchId,
        SCOPE.terminalId,
        SCOPE.userId,
        SCOPE.shiftId,
      ]),
    );
    expect(deviceAKey).not.toBe(browserKey);
    expect(deviceAKey).not.toBe(deviceBKey);
    expect(recordMatchesDeviceEnrollment({}, undefined)).toBe(true);
    expect(recordMatchesDeviceEnrollment({}, DEVICE_A)).toBe(false);
    expect(recordMatchesDeviceEnrollment({ deviceEnrollmentId: DEVICE_A }, DEVICE_A)).toBe(true);
    expect(recordMatchesDeviceEnrollment({ deviceEnrollmentId: DEVICE_A }, DEVICE_B)).toBe(false);
    expect(recordMatchesDeviceEnrollment({ deviceEnrollmentId: DEVICE_A }, undefined)).toBe(false);
  });

  it('keeps tenant branch and terminal partition isolation with device binding', () => {
    const key = queuePartitionKey(DEVICE_A_PARTITION);
    expect(key).not.toBe(
      queuePartitionKey({
        ...DEVICE_A_PARTITION,
        tenantId: '018f2000-0000-7000-8000-000000000011',
      }),
    );
    expect(key).not.toBe(
      queuePartitionKey({
        ...DEVICE_A_PARTITION,
        branchId: '018f2000-0000-7000-8000-000000000012',
      }),
    );
    expect(key).not.toBe(
      queuePartitionKey({
        ...DEVICE_A_PARTITION,
        terminalId: '018f2000-0000-7000-8000-000000000013',
      }),
    );
  });

  it('canonicalizes queue payload identity independent of object key insertion order', () => {
    expect(serializeQueuePayload({ totalMinor: '1150', quantityScaled: '1000' })).toBe(
      serializeQueuePayload({ quantityScaled: '1000', totalMinor: '1150' }),
    );
    expect(serializeQueuePayload(QUEUE_OPERATION.payload)).toContain('"totalMinor":"1150"');
  });

  it('refuses queue payload values that cannot be replayed as exact JSON', () => {
    expect(() => serializeQueuePayload({ totalMinor: Number.NaN })).toThrow(OfflineStoreError);
    expect(() => serializeQueuePayload({ value: BigInt(1) })).toThrow(OfflineStoreError);
    expect(() => serializeQueuePayload({ value: undefined })).toThrow(OfflineStoreError);
    const sparse = new Array<unknown>(2);
    sparse[1] = 'present';
    expect(() => serializeQueuePayload(sparse)).toThrow(OfflineStoreError);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => serializeQueuePayload(cyclic)).toThrow(OfflineStoreError);
  });

  it('accepts only immutable queue envelopes with canonical UUIDv7 operation identity', () => {
    expect(isQueueOperationInput(QUEUE_OPERATION)).toBe(true);
    expect(isQueueOperationInput({ ...QUEUE_OPERATION, id: crypto.randomUUID() })).toBe(false);
    expect(isQueueOperationInput({ ...QUEUE_OPERATION, kind: 'Sale Checkout' })).toBe(false);
    expect(isQueueOperationInput({ ...QUEUE_OPERATION, enqueuedAt: 'not-a-date' })).toBe(false);
    expect(isQueueOperationInput({ ...QUEUE_OPERATION, payload: { totalMinor: Infinity } })).toBe(
      false,
    );
  });

  it('classifies quota version and uniqueness failures without hiding unknown transaction failures', () => {
    expect(classifyIndexedDbError(new DOMException('full', 'QuotaExceededError')).code).toBe(
      'quota',
    );
    expect(classifyIndexedDbError(new DOMException('old', 'VersionError')).code).toBe('version');
    expect(classifyIndexedDbError(new DOMException('duplicate', 'ConstraintError')).code).toBe(
      'conflict',
    );
    expect(classifyIndexedDbError(new Error('boom')).code).toBe('transaction');
    expect(classifyIndexedDbError(new OfflineStoreError('corrupt', 'bad')).code).toBe('corrupt');
  });
});
