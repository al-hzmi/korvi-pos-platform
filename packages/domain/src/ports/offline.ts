import type { UuidV7 } from '../identity.js';

/**
 * Durable client queue partition.
 *
 * Browser clients deliberately omit deviceEnrollmentId and retain the existing
 * tenant/branch/terminal partition. Installed Cashier must supply it so copied
 * state from another enrolled device is a foreign partition, not usable local
 * authority.
 */
export interface QueuePartition {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly deviceEnrollmentId?: string | undefined;
}

export type QueueOperationState = 'pending' | 'in-flight' | 'rejected';

export interface QueueOperation<TPayload = unknown> {
  readonly id: UuidV7;
  readonly kind: string;
  readonly payload: TPayload;
  readonly state: QueueOperationState;
  readonly attempts: number;
  readonly enqueuedAt: string;
  readonly nextAttemptAt: string;
  readonly leaseUntil: string | null;
  readonly claimToken: string | null;
  readonly rejectionReason: string | null;
}

export interface QueueOperationInput<TPayload = unknown> {
  readonly id: UuidV7;
  readonly kind: string;
  readonly payload: TPayload;
  readonly enqueuedAt: string;
}

export interface QueueClaim {
  readonly claimToken: string;
  readonly operations: readonly QueueOperation[];
}

export interface OperationQueue {
  enqueue(partition: QueuePartition, operation: QueueOperationInput): Promise<void>;
  claim(partition: QueuePartition, limit: number, now: string, leaseUntil: string): Promise<QueueClaim>;
  settle(partition: QueuePartition, id: UuidV7, claimToken: string): Promise<void>;
  retry(
    partition: QueuePartition,
    id: UuidV7,
    claimToken: string,
    nextAttemptAt: string,
  ): Promise<void>;
  reject(
    partition: QueuePartition,
    id: UuidV7,
    claimToken: string,
    reason: string,
  ): Promise<void>;
  pending(partition: QueuePartition, limit: number): Promise<readonly QueueOperation[]>;
  rejected(partition: QueuePartition, limit: number): Promise<readonly QueueOperation[]>;
}

export interface SyncPushReport {
  readonly accepted: number;
  readonly retried: number;
  readonly rejected: number;
  readonly deferred: number;
}

export interface SyncEngine {
  push(): Promise<SyncPushReport>;
}
