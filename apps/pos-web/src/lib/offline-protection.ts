import type { QueueOperationInput, QueuePartition, QueuedOperation } from '@korvi/domain';
import type { CheckoutRequest } from './api-types';
import { isCheckoutQueuePayload } from './checkout-sync-executor';
import {
  OFFLINE_DB_VERSION,
  OfflineStoreError,
  isOfflineSaleDraft,
  type OfflineSaleDraft,
  type OfflineSaleScope,
  type ProtectedSaleDraftPayload,
} from './offline-store';

export const LOCAL_STORE_PROTECTION_VERSION = 1 as const;
const INSTALLATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OfflineStoreProtector {
  readonly installationId: string;
  readonly deviceEnrollmentId: string;
  protect(plaintextUtf8: string, aadUtf8: string): Promise<string>;
  unprotect(ciphertextBase64: string, aadUtf8: string): Promise<string>;
}

export interface ProtectedCheckoutPayload {
  readonly protection: 'korvi-native-v1';
  readonly protectionVersion: 1;
  readonly databaseVersion: number;
  readonly ciphertext: string;
}

function fail(message: string): never {
  throw new OfflineStoreError('corrupt', message);
}

function assertProtectorBinding(
  deviceEnrollmentId: string | undefined,
  protector: OfflineStoreProtector,
): void {
  if (
    deviceEnrollmentId === undefined ||
    deviceEnrollmentId !== protector.deviceEnrollmentId ||
    !INSTALLATION_ID.test(protector.installationId)
  ) {
    fail('Installed local-store protection identity does not match the active device binding.');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

export function isProtectedCheckoutPayload(value: unknown): value is ProtectedCheckoutPayload {
  return (
    isRecord(value) &&
    value.protection === 'korvi-native-v1' &&
    value.protectionVersion === LOCAL_STORE_PROTECTION_VERSION &&
    value.databaseVersion === OFFLINE_DB_VERSION &&
    typeof value.ciphertext === 'string' &&
    value.ciphertext.length > 0
  );
}

function queueAad(
  partition: QueuePartition,
  operation: Pick<QueueOperationInput, 'id' | 'kind' | 'enqueuedAt'>,
  protector: OfflineStoreProtector,
  databaseVersion: number,
): string {
  assertProtectorBinding(partition.deviceEnrollmentId, protector);
  return JSON.stringify([
    'korvi-local-store',
    LOCAL_STORE_PROTECTION_VERSION,
    databaseVersion,
    'sale.checkout',
    partition.tenantId,
    partition.branchId,
    partition.terminalId,
    partition.deviceEnrollmentId,
    protector.installationId,
    operation.id,
    operation.kind,
    operation.enqueuedAt,
  ]);
}

function draftAad(
  scope: OfflineSaleScope,
  updatedAt: string,
  protector: OfflineStoreProtector,
  databaseVersion: number,
): string {
  assertProtectorBinding(scope.deviceEnrollmentId, protector);
  return JSON.stringify([
    'korvi-local-store',
    LOCAL_STORE_PROTECTION_VERSION,
    databaseVersion,
    'sale-draft',
    scope.tenantId,
    scope.branchId,
    scope.terminalId,
    scope.deviceEnrollmentId,
    protector.installationId,
    scope.userId,
    scope.shiftId,
    updatedAt,
  ]);
}

export async function protectCheckoutQueueOperation(
  partition: QueuePartition,
  operation: QueueOperationInput<CheckoutRequest>,
  protector: OfflineStoreProtector,
): Promise<QueueOperationInput<ProtectedCheckoutPayload>> {
  if (
    !isCheckoutQueuePayload(operation.payload) ||
    operation.payload.operationId !== operation.id
  ) {
    fail('Refusing to protect an invalid checkout queue payload.');
  }
  const ciphertext = await protector.protect(
    JSON.stringify(operation.payload),
    queueAad(partition, operation, protector, OFFLINE_DB_VERSION),
  );
  if (ciphertext.length === 0) fail('Native local-store protection returned an empty ciphertext.');
  return {
    ...operation,
    payload: {
      protection: 'korvi-native-v1',
      protectionVersion: LOCAL_STORE_PROTECTION_VERSION,
      databaseVersion: OFFLINE_DB_VERSION,
      ciphertext,
    },
  };
}

export async function decodeProtectedCheckoutOperation(
  partition: QueuePartition,
  operation: QueuedOperation,
  protector: OfflineStoreProtector,
): Promise<QueuedOperation<CheckoutRequest>> {
  if (!isProtectedCheckoutPayload(operation.payload)) {
    fail('Queued checkout is not protected with the supported installed-store envelope.');
  }
  const plaintext = await protector.unprotect(
    operation.payload.ciphertext,
    queueAad(partition, operation, protector, operation.payload.databaseVersion),
  );
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext) as unknown;
  } catch {
    fail('Protected checkout plaintext is not valid JSON.');
  }
  if (!isCheckoutQueuePayload(payload) || payload.operationId !== operation.id) {
    fail('Protected checkout plaintext failed immutable command validation.');
  }
  return { ...operation, payload } as QueuedOperation<CheckoutRequest>;
}

export async function protectSaleDraft(
  scope: OfflineSaleScope,
  draft: OfflineSaleDraft,
  protector: OfflineStoreProtector,
): Promise<ProtectedSaleDraftPayload> {
  if (!isOfflineSaleDraft(draft)) fail('Refusing to protect an invalid sale draft.');
  const ciphertext = await protector.protect(
    JSON.stringify(draft),
    draftAad(scope, draft.updatedAt, protector, OFFLINE_DB_VERSION),
  );
  if (ciphertext.length === 0)
    fail('Native local-store protection returned an empty draft ciphertext.');
  return {
    protectionVersion: LOCAL_STORE_PROTECTION_VERSION,
    databaseVersion: OFFLINE_DB_VERSION,
    ciphertext,
    updatedAt: draft.updatedAt,
  };
}

export async function decodeProtectedSaleDraft(
  scope: OfflineSaleScope,
  protectedDraft: ProtectedSaleDraftPayload,
  protector: OfflineStoreProtector,
): Promise<OfflineSaleDraft> {
  if (
    protectedDraft.protectionVersion !== LOCAL_STORE_PROTECTION_VERSION ||
    protectedDraft.databaseVersion !== OFFLINE_DB_VERSION ||
    protectedDraft.ciphertext.length === 0
  ) {
    fail('Protected sale draft uses an unsupported local-store envelope.');
  }
  const plaintext = await protector.unprotect(
    protectedDraft.ciphertext,
    draftAad(scope, protectedDraft.updatedAt, protector, protectedDraft.databaseVersion),
  );
  let draft: unknown;
  try {
    draft = JSON.parse(plaintext) as unknown;
  } catch {
    fail('Protected sale draft plaintext is not valid JSON.');
  }
  if (!isOfflineSaleDraft(draft) || draft.updatedAt !== protectedDraft.updatedAt) {
    fail('Protected sale draft failed structural or binding validation.');
  }
  return draft;
}
