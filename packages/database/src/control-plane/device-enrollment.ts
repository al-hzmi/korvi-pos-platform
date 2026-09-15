import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { newId } from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import { withTenant } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type InstalledCashierPlatform = 'windows' | 'android';
export type DeviceKeyAlgorithm = 'ed25519' | 'p256';
export type DeviceEnrollmentState = 'active' | 'suspended' | 'revoked' | 'replaced';

export type PlatformDeviceEnrollmentRefusal =
  | 'unknown-tenant'
  | 'tenant-not-active'
  | 'tenant-suspended'
  | 'unknown-terminal'
  | 'terminal-inactive'
  | 'invalid-input'
  | 'idempotency-conflict'
  | 'terminal-already-enrolled'
  | 'installation-already-enrolled'
  | 'fingerprint-already-enrolled'
  | 'public-key-already-enrolled'
  | 'unknown-enrollment'
  | 'enrollment-already-revoked';

export class PlatformDeviceEnrollmentRefusedError extends DatabaseError {
  public override readonly name = 'PlatformDeviceEnrollmentRefusedError';
  public readonly detail: PlatformDeviceEnrollmentRefusal;

  public constructor(detail: PlatformDeviceEnrollmentRefusal) {
    super(`Platform device enrollment refused: ${detail}`);
    this.detail = detail;
  }
}

export interface PlatformDeviceEnrollmentRequest {
  readonly tenantId: string;
  readonly terminalId: string;
  readonly operationId: string;
  readonly controlPlaneActorRef: string;
  readonly installationId: string;
  readonly platform: InstalledCashierPlatform;
  readonly normalizedFingerprintDigest: string;
  readonly publicKeySpki: Uint8Array;
  readonly publicKeySha256: string;
  readonly keyAlgorithm: DeviceKeyAlgorithm;
  readonly appVersion: string;
}

export interface PlatformDeviceRevocationRequest {
  readonly tenantId: string;
  readonly enrollmentId: string;
  readonly operationId: string;
  readonly controlPlaneActorRef: string;
  readonly reason: string;
}

export interface DeviceEnrollmentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly terminalId: string;
  readonly installationId: string;
  readonly platform: InstalledCashierPlatform;
  readonly normalizedFingerprintDigest: string;
  readonly publicKeySha256: string;
  readonly keyAlgorithm: DeviceKeyAlgorithm;
  readonly appVersion: string;
  readonly state: DeviceEnrollmentState;
  readonly enrolledAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | null;
}

export interface DeviceEnrollmentMutationResult {
  readonly enrollment: DeviceEnrollmentRecord;
  readonly replayed: boolean;
}

interface NormalizedEnrollmentRequest {
  readonly tenantId: string;
  readonly terminalId: string;
  readonly operationId: string;
  readonly actorRef: string;
  readonly installationId: string;
  readonly platform: InstalledCashierPlatform;
  readonly fingerprintDigest: string;
  readonly publicKeySpki: Buffer;
  readonly publicKeySha256: string;
  readonly keyAlgorithm: DeviceKeyAlgorithm;
  readonly appVersion: string;
}

interface NormalizedRevocationRequest {
  readonly tenantId: string;
  readonly enrollmentId: string;
  readonly operationId: string;
  readonly actorRef: string;
  readonly reason: string;
}

interface TenantRow {
  id: string;
  status: string;
}

interface TerminalRow {
  id: string;
  isActive: boolean;
}

interface EnrollmentRow {
  id: string;
  tenantId: string;
  terminalId: string;
  operationId: string;
  requestHash: string;
  installationId: string;
  platform: string;
  normalizedFingerprintDigest: string;
  publicKeySha256: string;
  keyAlgorithm: string;
  appVersion: string;
  state: string;
  enrolledAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  revocationOperationId: string | null;
  revocationRequestHash: string | null;
}

function normalizeToken(value: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max) {
    throw new PlatformDeviceEnrollmentRefusedError('invalid-input');
  }
  return normalized;
}

function normalizeUuid(value: string, refusal: 'unknown-tenant' | 'unknown-terminal' | 'unknown-enrollment'): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new PlatformDeviceEnrollmentRefusedError(refusal);
  return normalized;
}

function normalizeEnrollment(request: PlatformDeviceEnrollmentRequest): NormalizedEnrollmentRequest {
  const tenantId = normalizeUuid(request.tenantId, 'unknown-tenant');
  const terminalId = normalizeUuid(request.terminalId, 'unknown-terminal');
  const installationId = normalizeUuid(request.installationId, 'invalid-input' as 'unknown-enrollment');
  const operationId = normalizeToken(request.operationId, 160);
  const actorRef = normalizeToken(request.controlPlaneActorRef, 120);
  const appVersion = normalizeToken(request.appVersion, 64);
  const fingerprintDigest = request.normalizedFingerprintDigest.trim().toLowerCase();
  const publicKeySha256 = request.publicKeySha256.trim().toLowerCase();
  const publicKeySpki = Buffer.from(request.publicKeySpki);

  if (!SHA256_HEX_PATTERN.test(fingerprintDigest) || !SHA256_HEX_PATTERN.test(publicKeySha256)) {
    throw new PlatformDeviceEnrollmentRefusedError('invalid-input');
  }
  if (request.platform !== 'windows' && request.platform !== 'android') {
    throw new PlatformDeviceEnrollmentRefusedError('invalid-input');
  }
  if (request.keyAlgorithm !== 'ed25519' && request.keyAlgorithm !== 'p256') {
    throw new PlatformDeviceEnrollmentRefusedError('invalid-input');
  }
  if (publicKeySpki.byteLength < 32 || publicKeySpki.byteLength > 512) {
    throw new PlatformDeviceEnrollmentRefusedError('invalid-input');
  }
  const computed = createHash('sha256').update(publicKeySpki).digest('hex');
  if (computed !== publicKeySha256) {
    throw new PlatformDeviceEnrollmentRefusedError('invalid-input');
  }

  return {
    tenantId,
    terminalId,
    operationId,
    actorRef,
    installationId,
    platform: request.platform,
    fingerprintDigest,
    publicKeySpki,
    publicKeySha256,
    keyAlgorithm: request.keyAlgorithm,
    appVersion,
  };
}

function normalizeRevocation(request: PlatformDeviceRevocationRequest): NormalizedRevocationRequest {
  return {
    tenantId: normalizeUuid(request.tenantId, 'unknown-tenant'),
    enrollmentId: normalizeUuid(request.enrollmentId, 'unknown-enrollment'),
    operationId: normalizeToken(request.operationId, 160),
    actorRef: normalizeToken(request.controlPlaneActorRef, 120),
    reason: normalizeToken(request.reason, 500),
  };
}

function enrollmentFingerprint(input: NormalizedEnrollmentRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'platform.device-enrollment.v1',
        input.tenantId,
        input.terminalId,
        input.actorRef,
        input.installationId,
        input.platform,
        input.fingerprintDigest,
        input.publicKeySha256,
        input.keyAlgorithm,
        input.appVersion,
      ]),
      'utf8',
    )
    .digest('hex');
}

function revocationFingerprint(input: NormalizedRevocationRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'platform.device-revocation.v1',
        input.tenantId,
        input.enrollmentId,
        input.actorRef,
        input.reason,
      ]),
      'utf8',
    )
    .digest('hex');
}

function record(row: EnrollmentRow): DeviceEnrollmentRecord {
  if (
    (row.platform !== 'windows' && row.platform !== 'android') ||
    (row.keyAlgorithm !== 'ed25519' && row.keyAlgorithm !== 'p256') ||
    !['active', 'suspended', 'revoked', 'replaced'].includes(row.state)
  ) {
    throw new DatabaseError('Stored device enrollment has an invalid constrained value.');
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    terminalId: row.terminalId,
    installationId: row.installationId,
    platform: row.platform,
    normalizedFingerprintDigest: row.normalizedFingerprintDigest,
    publicKeySha256: row.publicKeySha256,
    keyAlgorithm: row.keyAlgorithm,
    appVersion: row.appVersion,
    state: row.state as DeviceEnrollmentState,
    enrolledAt: row.enrolledAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  };
}

async function lockTenant(tx: TransactionClient, tenantId: string): Promise<TenantRow> {
  const rows = await tx.$queryRaw<TenantRow[]>`
    SELECT "id", "status"
      FROM "tenants"
     WHERE "id" = ${tenantId}::uuid
     FOR UPDATE
  `;
  const tenant = rows[0];
  if (tenant === undefined) throw new PlatformDeviceEnrollmentRefusedError('unknown-tenant');
  if (tenant.status === 'suspended') {
    throw new PlatformDeviceEnrollmentRefusedError('tenant-suspended');
  }
  if (tenant.status !== 'active') {
    throw new PlatformDeviceEnrollmentRefusedError('tenant-not-active');
  }
  return tenant;
}

async function readEnrollment(
  tx: TransactionClient,
  tenantId: string,
  enrollmentId: string,
): Promise<EnrollmentRow | null> {
  const rows = await tx.$queryRaw<EnrollmentRow[]>`
    SELECT
      "id", "tenantId", "terminalId", "operationId", "requestHash", "installationId",
      "platform", "normalizedFingerprintDigest", "publicKeySha256", "keyAlgorithm", "appVersion",
      "state", "enrolledAt", "lastSeenAt", "revokedAt", "revocationOperationId",
      "revocationRequestHash"
      FROM "device_enrollments"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "id" = ${enrollmentId}::uuid
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function appendAudit(
  tx: TransactionClient,
  tenantId: string,
  eventType: string,
  enrollmentId: string,
  actorRef: string,
  operationId: string,
  metadata: Readonly<Record<string, string>>,
  at: Date,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId,
      actorUserId: null,
      branchId: null,
      terminalId: null,
      eventType,
      entityType: 'device-enrollment',
      entityId: enrollmentId,
      metadata: { controlPlaneActorRef: actorRef, operationId, ...metadata },
      occurredAt: at,
    },
  });
}

async function classifyEnrollmentConflict(
  tx: TransactionClient,
  input: NormalizedEnrollmentRequest,
): Promise<never> {
  const rows = await tx.$queryRaw<
    { operationId: string; requestHash: string; terminalId: string; installationId: string; normalizedFingerprintDigest: string; publicKeySha256: string; state: string }[]
  >`
    SELECT "operationId", "requestHash", "terminalId", "installationId",
           "normalizedFingerprintDigest", "publicKeySha256", "state"
      FROM "device_enrollments"
     WHERE "tenantId" = ${input.tenantId}::uuid
       AND (
         "operationId" = ${input.operationId}
         OR "installationId" = ${input.installationId}::uuid
         OR "publicKeySha256" = ${input.publicKeySha256}
         OR ("terminalId" = ${input.terminalId}::uuid AND "state" IN ('active', 'suspended'))
         OR ("normalizedFingerprintDigest" = ${input.fingerprintDigest} AND "state" IN ('active', 'suspended'))
       )
  `;
  for (const row of rows) {
    if (row.operationId === input.operationId) {
      throw new PlatformDeviceEnrollmentRefusedError('idempotency-conflict');
    }
    if (row.installationId === input.installationId) {
      throw new PlatformDeviceEnrollmentRefusedError('installation-already-enrolled');
    }
    if (row.publicKeySha256 === input.publicKeySha256) {
      throw new PlatformDeviceEnrollmentRefusedError('public-key-already-enrolled');
    }
    if (row.terminalId === input.terminalId && (row.state === 'active' || row.state === 'suspended')) {
      throw new PlatformDeviceEnrollmentRefusedError('terminal-already-enrolled');
    }
    if (
      row.normalizedFingerprintDigest === input.fingerprintDigest &&
      (row.state === 'active' || row.state === 'suspended')
    ) {
      throw new PlatformDeviceEnrollmentRefusedError('fingerprint-already-enrolled');
    }
  }
  throw new DatabaseError('Device enrollment insert was refused without a classifiable conflict.');
}

export async function enrollPlatformDevice(
  prisma: PrismaClient,
  request: PlatformDeviceEnrollmentRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<DeviceEnrollmentMutationResult> {
  const input = normalizeEnrollment(request);
  const requestHash = enrollmentFingerprint(input);

  return withTenant(prisma, input.tenantId, async (tx) => {
    await lockTenant(tx, input.tenantId);

    const replayRows = await tx.$queryRaw<EnrollmentRow[]>`
      SELECT
        "id", "tenantId", "terminalId", "operationId", "requestHash", "installationId",
        "platform", "normalizedFingerprintDigest", "publicKeySha256", "keyAlgorithm", "appVersion",
        "state", "enrolledAt", "lastSeenAt", "revokedAt", "revocationOperationId",
        "revocationRequestHash"
        FROM "device_enrollments"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "operationId" = ${input.operationId}
       LIMIT 1
    `;
    const replay = replayRows[0];
    if (replay !== undefined) {
      if (replay.requestHash !== requestHash) {
        throw new PlatformDeviceEnrollmentRefusedError('idempotency-conflict');
      }
      return { enrollment: record(replay), replayed: true };
    }

    const terminalRows = await tx.$queryRaw<TerminalRow[]>`
      SELECT "id", "isActive"
        FROM "terminals"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "id" = ${input.terminalId}::uuid
       LIMIT 1
       FOR UPDATE
    `;
    const terminal = terminalRows[0];
    if (terminal === undefined) {
      throw new PlatformDeviceEnrollmentRefusedError('unknown-terminal');
    }
    if (!terminal.isActive) {
      throw new PlatformDeviceEnrollmentRefusedError('terminal-inactive');
    }

    const at = clock();
    const enrollmentId = nextId();
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "device_enrollments"
        ("id", "tenantId", "terminalId", "operationId", "requestHash", "controlPlaneActorRef",
         "installationId", "platform", "normalizedFingerprintDigest", "publicKeySpki",
         "publicKeySha256", "keyAlgorithm", "appVersion", "state", "enrolledAt", "lastSeenAt",
         "createdAt", "updatedAt")
      VALUES
        (${enrollmentId}::uuid, ${input.tenantId}::uuid, ${input.terminalId}::uuid,
         ${input.operationId}, ${requestHash}, ${input.actorRef}, ${input.installationId}::uuid,
         ${input.platform}, ${input.fingerprintDigest}, ${input.publicKeySpki}, ${input.publicKeySha256},
         ${input.keyAlgorithm}, ${input.appVersion}, 'active', ${at}, ${at}, ${at}, ${at})
      ON CONFLICT DO NOTHING
      RETURNING "id"
    `;
    if (inserted.length !== 1) await classifyEnrollmentConflict(tx, input);

    await appendAudit(
      tx,
      input.tenantId,
      'platform.device-enrolled',
      enrollmentId,
      input.actorRef,
      input.operationId,
      { terminalId: input.terminalId, platform: input.platform, publicKeySha256: input.publicKeySha256 },
      at,
    );

    const stored = await readEnrollment(tx, input.tenantId, enrollmentId);
    if (stored === null) throw new DatabaseError('Inserted device enrollment is missing.');
    return { enrollment: record(stored), replayed: false };
  });
}

export async function revokePlatformDevice(
  prisma: PrismaClient,
  request: PlatformDeviceRevocationRequest,
  clock: () => Date = () => new Date(),
): Promise<DeviceEnrollmentMutationResult> {
  const input = normalizeRevocation(request);
  const requestHash = revocationFingerprint(input);

  return withTenant(prisma, input.tenantId, async (tx) => {
    await lockTenant(tx, input.tenantId);

    const rows = await tx.$queryRaw<EnrollmentRow[]>`
      SELECT
        "id", "tenantId", "terminalId", "operationId", "requestHash", "installationId",
        "platform", "normalizedFingerprintDigest", "publicKeySha256", "keyAlgorithm", "appVersion",
        "state", "enrolledAt", "lastSeenAt", "revokedAt", "revocationOperationId",
        "revocationRequestHash"
        FROM "device_enrollments"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "id" = ${input.enrollmentId}::uuid
       LIMIT 1
       FOR UPDATE
    `;
    const current = rows[0];
    if (current === undefined) {
      throw new PlatformDeviceEnrollmentRefusedError('unknown-enrollment');
    }

    if (current.state === 'revoked' || current.state === 'replaced') {
      if (
        current.revocationOperationId === input.operationId &&
        current.revocationRequestHash === requestHash
      ) {
        return { enrollment: record(current), replayed: true };
      }
      throw new PlatformDeviceEnrollmentRefusedError('enrollment-already-revoked');
    }

    const at = clock();
    await tx.$executeRaw`
      UPDATE "device_enrollments"
         SET "state" = 'revoked',
             "revokedAt" = ${at},
             "revocationOperationId" = ${input.operationId},
             "revocationRequestHash" = ${requestHash},
             "revokedByActorRef" = ${input.actorRef},
             "revocationReason" = ${input.reason},
             "updatedAt" = ${at}
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "id" = ${input.enrollmentId}::uuid
    `;

    await appendAudit(
      tx,
      input.tenantId,
      'platform.device-revoked',
      input.enrollmentId,
      input.actorRef,
      input.operationId,
      { terminalId: current.terminalId, reason: input.reason },
      at,
    );

    const stored = await readEnrollment(tx, input.tenantId, input.enrollmentId);
    if (stored === null) throw new DatabaseError('Revoked device enrollment is missing.');
    return { enrollment: record(stored), replayed: false };
  });
}
