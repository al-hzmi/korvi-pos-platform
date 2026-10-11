import type { QueuePartition, QueuedOperation } from '@korvi/domain';
import { describe, expect, it } from 'vitest';
import {
  decodeProtectedCheckoutOperation,
  decodeProtectedSaleDraft,
  isProtectedCheckoutPayload,
  protectCheckoutQueueOperation,
  protectSaleDraft,
  type OfflineStoreProtector,
} from '../offline-protection';
import type { OfflineSaleDraft, OfflineSaleScope } from '../offline-store';

const DEVICE_A = '018f6000-0000-7000-8000-000000000006';
const DEVICE_B = '018f6000-0000-7000-8000-000000000007';
const INSTALL_A = '018f6000-0000-5000-8000-000000000008';
const INSTALL_B = '018f6000-0000-5000-8000-000000000009';
const PARTITION: QueuePartition = {
  tenantId: '018f6000-0000-7000-8000-000000000001',
  branchId: '018f6000-0000-7000-8000-000000000002',
  terminalId: '018f6000-0000-7000-8000-000000000003',
  deviceEnrollmentId: DEVICE_A,
};
const SCOPE: OfflineSaleScope = {
  ...PARTITION,
  userId: '018f6000-0000-7000-8000-000000000004',
  shiftId: '018f6000-0000-7000-8000-000000000005',
};

function fakeProtector(
  installationId = INSTALL_A,
  deviceEnrollmentId = DEVICE_A,
): OfflineStoreProtector {
  const sealed = new Map<string, { plaintext: string; aad: string }>();
  let sequence = 0;
  return {
    installationId,
    deviceEnrollmentId,
    async protect(plaintext, aad) {
      const ciphertext = `sealed-${installationId}-${String(++sequence)}`;
      sealed.set(ciphertext, { plaintext, aad });
      return ciphertext;
    },
    async unprotect(ciphertext, aad) {
      const entry = sealed.get(ciphertext);
      if (entry === undefined || entry.aad !== aad) throw new Error('binding mismatch');
      return entry.plaintext;
    },
  };
}

const CHECKOUT = {
  id: '018f6000-0001-7000-8000-000000000101',
  kind: 'sale.checkout',
  payload: {
    operationId: '018f6000-0001-7000-8000-000000000101',
    terminalId: PARTITION.terminalId,
    expectedShiftId: SCOPE.shiftId,
    cashReceivedMinor: '1150',
    lines: [{ productId: '018f6000-0000-7000-8000-0000000000a1', quantityScaled: '1000' }],
  },
  enqueuedAt: '2026-09-16T06:00:00.000Z',
} as const;

const DRAFT: OfflineSaleDraft = {
  lines: [
    {
      productId: '018f6000-0000-7000-8000-0000000000a1',
      sku: 'A',
      nameAr: 'أ',
      nameEn: null,
      productType: 'unit',
      unitLabel: 'حبة',
      unitPriceMinor: '1150',
      vatBasisPoints: 1500,
      quantityScaled: '1000',
    },
  ],
  cash: '20.00',
  priceMode: 'tax-inclusive',
  updatedAt: '2026-09-16T06:01:00.000Z',
};

describe('installed local-store protection', () => {
  it('stores checkout intent as an opaque native-protected envelope and restores it only in the same binding', async () => {
    const protector = fakeProtector();
    const protectedOperation = await protectCheckoutQueueOperation(PARTITION, CHECKOUT, protector);
    expect(isProtectedCheckoutPayload(protectedOperation.payload)).toBe(true);
    expect(protectedOperation.payload).not.toEqual(CHECKOUT.payload);
    const queued = {
      ...protectedOperation,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: CHECKOUT.enqueuedAt,
      leaseUntil: null,
      rejectionReason: null,
    } as QueuedOperation;
    const decoded = await decodeProtectedCheckoutOperation(PARTITION, queued, protector);
    expect(decoded.payload).toEqual(CHECKOUT.payload);
  });

  it('fails closed when enrollment or installation identity changes', async () => {
    const protector = fakeProtector();
    const protectedOperation = await protectCheckoutQueueOperation(PARTITION, CHECKOUT, protector);
    const queued = {
      ...protectedOperation,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: CHECKOUT.enqueuedAt,
      leaseUntil: null,
      rejectionReason: null,
    } as QueuedOperation;
    await expect(
      decodeProtectedCheckoutOperation(
        { ...PARTITION, deviceEnrollmentId: DEVICE_B },
        queued,
        protector,
      ),
    ).rejects.toThrow();
    await expect(
      decodeProtectedCheckoutOperation(PARTITION, queued, fakeProtector(INSTALL_B)),
    ).rejects.toThrow();
  });

  it('protects durable drafts with scope, enrollment, installation and schema-bound AAD', async () => {
    const protector = fakeProtector();
    const protectedDraft = await protectSaleDraft(SCOPE, DRAFT, protector);
    expect(protectedDraft.ciphertext).not.toContain(DRAFT.cash);
    expect(await decodeProtectedSaleDraft(SCOPE, protectedDraft, protector)).toEqual(DRAFT);
    await expect(
      decodeProtectedSaleDraft(
        { ...SCOPE, deviceEnrollmentId: DEVICE_B },
        protectedDraft,
        protector,
      ),
    ).rejects.toThrow();
  });
});
