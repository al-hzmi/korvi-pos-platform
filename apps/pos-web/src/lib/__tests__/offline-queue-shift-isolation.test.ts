import type {
  QueueClaimRequest,
  QueueClaimResult,
  QueuedOperation,
  QueuePartition,
} from '@korvi/domain';
import { describe, expect, it, vi } from 'vitest';
import { syncOfflineCheckouts } from '../offline-checkout';
import { queuePartitionKey } from '../offline-store';
import type { ApiClient } from '../api';
import type { CheckoutRequest } from '../api-types';
import type { KorviOfflineStore } from '../offline-store';

const TENANT_ID = '018f5100-0000-7000-8000-000000000001';
const BRANCH_ID = '018f5100-0000-7000-8000-000000000002';
const TERMINAL_ID = '018f5100-0000-7000-8000-000000000003';
const SHIFT_A = '018f5100-0000-7000-8000-000000000004';
const SHIFT_B = '018f5100-0000-7000-8000-000000000005';
const OPERATION_ID = '018f5100-0001-7000-8000-000000000006';
const PRODUCT_ID = '018f5100-0000-7000-8000-000000000007';

const LEGACY: QueuePartition = {
  tenantId: TENANT_ID,
  branchId: BRANCH_ID,
  terminalId: TERMINAL_ID,
};
const PARTITION_A: QueuePartition = { ...LEGACY, shiftId: SHIFT_A };
const PARTITION_B: QueuePartition = { ...LEGACY, shiftId: SHIFT_B };

const REQUEST: CheckoutRequest = {
  operationId: OPERATION_ID,
  terminalId: TERMINAL_ID,
  expectedShiftId: SHIFT_A,
  cashReceivedMinor: '1150',
  lines: [{ productId: PRODUCT_ID, quantityScaled: '1000' }],
};

function queued(): QueuedOperation<CheckoutRequest> {
  return {
    id: OPERATION_ID,
    kind: 'sale.checkout',
    payload: REQUEST,
    enqueuedAt: '2026-09-12T01:00:00.000Z',
    state: 'pending',
    attempts: 0,
    nextAttemptAt: '2026-09-12T01:00:00.000Z',
    leaseUntil: null,
    rejectionReason: null,
  };
}

class ShiftBoundQueueDouble {
  public operation: QueuedOperation<CheckoutRequest> = queued();
  public owner = queuePartitionKey(LEGACY);
  private claimToken: string | null = null;

  private owns(partition: QueuePartition): boolean {
    return this.owner === queuePartitionKey(partition);
  }

  async all(partition: QueuePartition): Promise<readonly QueuedOperation[]> {
    return this.owns(partition) ? [this.operation] : [];
  }

  async repartition(
    source: QueuePartition,
    target: QueuePartition,
    id: string,
  ): Promise<void> {
    if (!this.owns(source) || id !== this.operation.id) throw new Error('wrong source');
    this.owner = queuePartitionKey(target);
  }

  async pending(partition: QueuePartition): Promise<readonly QueuedOperation[]> {
    return this.owns(partition) && this.operation.state === 'pending' ? [this.operation] : [];
  }

  async rejected(partition: QueuePartition): Promise<readonly QueuedOperation[]> {
    return this.owns(partition) && this.operation.state === 'rejected' ? [this.operation] : [];
  }

  async claimNext<TPayload>(
    partition: QueuePartition,
    request: QueueClaimRequest,
  ): Promise<QueueClaimResult<TPayload>> {
    if (!this.owns(partition) || this.operation.state !== 'pending') return { status: 'empty' };
    this.claimToken = request.token;
    this.operation = {
      ...this.operation,
      state: 'in-flight',
      attempts: this.operation.attempts + 1,
      leaseUntil: request.leaseUntil,
    };
    return {
      status: 'claimed',
      claim: {
        token: request.token,
        operation: this.operation as unknown as QueuedOperation<TPayload>,
      },
    };
  }

  async settleClaim(_partition: QueuePartition, id: string, token: string): Promise<void> {
    if (id !== this.operation.id || token !== this.claimToken) throw new Error('wrong claim');
    this.operation = {
      ...this.operation,
      state: 'settled',
      leaseUntil: null,
      rejectionReason: null,
    };
    this.claimToken = null;
  }

  async retryClaim(): Promise<void> {
    throw new Error('unexpected retry');
  }

  async rejectClaim(): Promise<void> {
    throw new Error('unexpected rejection');
  }

  async migrateQueuePayload(): Promise<void> {
    throw new Error('unexpected payload migration');
  }

  close(): void {}
}

describe('offline checkout shift isolation', () => {
  it('does not let a different cashier shift claim or reject a legacy queued sale', async () => {
    const store = new ShiftBoundQueueDouble();
    const checkout = vi.fn(async (_request: CheckoutRequest) => undefined);
    const api = { checkout } as unknown as ApiClient;
    const openStore = async () => store as unknown as KorviOfflineStore;

    const wrongShift = await syncOfflineCheckouts(
      api,
      PARTITION_B,
      undefined,
      openStore,
    );

    expect(checkout).not.toHaveBeenCalled();
    expect(store.owner).toBe(queuePartitionKey(LEGACY));
    expect(store.operation.state).toBe('pending');
    expect(wrongShift.report.rejected).toBe(0);

    const originalShift = await syncOfflineCheckouts(
      api,
      PARTITION_A,
      undefined,
      openStore,
    );

    expect(checkout).toHaveBeenCalledTimes(1);
    expect(checkout).toHaveBeenCalledWith(REQUEST);
    expect(store.owner).toBe(queuePartitionKey(PARTITION_A));
    expect(store.operation.state).toBe('settled');
    expect(originalShift.report.settled).toBe(1);
    expect(originalShift.report.rejected).toBe(0);
  });
});
