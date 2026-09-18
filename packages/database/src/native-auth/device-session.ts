import { Buffer } from 'node:buffer';
import { withTenant } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

export type NativeDeviceKeyAlgorithm = 'ed25519' | 'p256';

export interface NativeDeviceBinding {
  readonly tenantId: string;
  readonly deviceEnrollmentId: string;
  readonly terminalId: string;
  readonly branchId: string;
  readonly publicKeySpki: Buffer;
  readonly publicKeySha256: string;
  readonly keyAlgorithm: NativeDeviceKeyAlgorithm;
}

export interface NativeChallengeRecord extends NativeDeviceBinding {
  readonly challengeId: string;
  readonly nonce: Buffer;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface CreateNativeChallengeInput {
  readonly tenantId: string;
  readonly deviceEnrollmentId: string;
  readonly challengeId: string;
  readonly nonce: Uint8Array;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type NativeChallengeClaim =
  | { readonly outcome: 'claimed'; readonly challenge: NativeChallengeRecord }
  | {
      readonly outcome: 'refused';
      readonly reason: 'unknown' | 'consumed' | 'expired' | 'device-inactive';
    };

export interface CreateNativeSessionInput {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly expectedAuthVersion: number;
  readonly tokenHash: string;
  readonly binding: NativeDeviceBinding;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type CreateNativeSessionResult =
  | { readonly outcome: 'created' }
  | {
      readonly outcome: 'refused';
      readonly reason:
        'user-inactive' | 'membership-inactive' | 'branch-mismatch' | 'device-inactive';
    };

export interface NativeSessionContext {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionAuthVersion: number;
  readonly deviceEnrollmentId: string;
  readonly terminalId: string;
  readonly branchId: string;
  readonly devicePublicKeySha256: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly tenantStatus: string;
  readonly userEmail: string;
  readonly userDisplayName: string;
  readonly userIsActive: boolean;
  readonly userAuthVersion: number;
  readonly membershipStatus: string | null;
  readonly membershipDefaultBranchId: string | null;
  readonly deviceState: string;
  readonly enrolledPublicKeySha256: string;
  readonly terminalIsActive: boolean;
  readonly branchIsActive: boolean;
}

interface DeviceBindingRow {
  tenantId: string;
  deviceEnrollmentId: string;
  terminalId: string;
  branchId: string;
  publicKeySpki: Uint8Array;
  publicKeySha256: string;
  keyAlgorithm: string;
}

function mapBinding(row: DeviceBindingRow): NativeDeviceBinding {
  if (row.keyAlgorithm !== 'ed25519' && row.keyAlgorithm !== 'p256') {
    throw new Error(`Unsupported native device key algorithm: ${row.keyAlgorithm}`);
  }
  return {
    tenantId: row.tenantId,
    deviceEnrollmentId: row.deviceEnrollmentId,
    terminalId: row.terminalId,
    branchId: row.branchId,
    publicKeySpki: Buffer.from(row.publicKeySpki),
    publicKeySha256: row.publicKeySha256,
    keyAlgorithm: row.keyAlgorithm,
  };
}

async function activeBindingWithin(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
  deviceEnrollmentId: string,
): Promise<NativeDeviceBinding | null> {
  const rows = await tx.$queryRaw<DeviceBindingRow[]>`
    SELECT
      de."tenantId" AS "tenantId",
      de."id" AS "deviceEnrollmentId",
      de."terminalId" AS "terminalId",
      t."branchId" AS "branchId",
      de."publicKeySpki" AS "publicKeySpki",
      de."publicKeySha256" AS "publicKeySha256",
      de."keyAlgorithm" AS "keyAlgorithm"
    FROM "device_enrollments" de
    JOIN "terminals" t
      ON t."tenantId" = de."tenantId" AND t."id" = de."terminalId"
    JOIN "branches" b
      ON b."tenantId" = t."tenantId" AND b."id" = t."branchId"
    JOIN "tenants" tn
      ON tn."id" = de."tenantId"
    WHERE de."tenantId" = ${tenantId}::uuid
      AND de."id" = ${deviceEnrollmentId}::uuid
      AND de."state" = 'active'
      AND t."isActive" = TRUE
      AND b."isActive" = TRUE
      AND tn."status" = 'active'
    LIMIT 1`;
  const row = rows.at(0);
  return row === undefined ? null : mapBinding(row);
}

export async function readActiveNativeDeviceBinding(
  prisma: PrismaClient,
  tenantId: string,
  deviceEnrollmentId: string,
): Promise<NativeDeviceBinding | null> {
  return withTenant(prisma, tenantId, (tx) =>
    activeBindingWithin(tx, tenantId, deviceEnrollmentId),
  );
}

export async function createNativeAuthChallenge(
  prisma: PrismaClient,
  input: CreateNativeChallengeInput,
): Promise<NativeChallengeRecord | null> {
  return withTenant(prisma, input.tenantId, async (tx) => {
    const binding = await activeBindingWithin(tx, input.tenantId, input.deviceEnrollmentId);
    if (binding === null) return null;

    // Challenges are ephemeral authentication material, not business evidence.
    // Remove only this device's already-consumed or expired rows before issuing
    // another one so an unauthenticated caller cannot grow the table forever.
    // Active, unconsumed challenges remain untouched and can still complete.
    await tx.$executeRaw`
      DELETE FROM "native_auth_challenges"
      WHERE "tenantId" = ${input.tenantId}::uuid
        AND "deviceEnrollmentId" = ${input.deviceEnrollmentId}::uuid
        AND ("consumedAt" IS NOT NULL OR "expiresAt" <= ${input.issuedAt})`;

    await tx.$executeRaw`
      INSERT INTO "native_auth_challenges" (
        "id", "tenantId", "deviceEnrollmentId", "terminalId", "branchId",
        "nonce", "issuedAt", "expiresAt", "consumedAt"
      ) VALUES (
        ${input.challengeId}::uuid,
        ${input.tenantId}::uuid,
        ${input.deviceEnrollmentId}::uuid,
        ${binding.terminalId}::uuid,
        ${binding.branchId}::uuid,
        ${Buffer.from(input.nonce)},
        ${input.issuedAt},
        ${input.expiresAt},
        NULL
      )`;

    return {
      ...binding,
      challengeId: input.challengeId,
      nonce: Buffer.from(input.nonce),
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    };
  });
}

interface ChallengeRow {
  id: string;
  tenantId: string;
  deviceEnrollmentId: string;
  terminalId: string;
  branchId: string;
  nonce: Uint8Array;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export async function claimNativeAuthChallenge(
  prisma: PrismaClient,
  input: {
    readonly tenantId: string;
    readonly deviceEnrollmentId: string;
    readonly challengeId: string;
    readonly now: Date;
  },
): Promise<NativeChallengeClaim> {
  return withTenant(prisma, input.tenantId, async (tx) => {
    const rows = await tx.$queryRaw<ChallengeRow[]>`
      SELECT
        "id", "tenantId", "deviceEnrollmentId", "terminalId", "branchId",
        "nonce", "issuedAt", "expiresAt", "consumedAt"
      FROM "native_auth_challenges"
      WHERE "tenantId" = ${input.tenantId}::uuid
        AND "deviceEnrollmentId" = ${input.deviceEnrollmentId}::uuid
        AND "id" = ${input.challengeId}::uuid
      FOR UPDATE`;
    const row = rows.at(0);
    if (row === undefined) return { outcome: 'refused', reason: 'unknown' };
    if (row.consumedAt !== null) return { outcome: 'refused', reason: 'consumed' };
    if (row.expiresAt <= input.now) return { outcome: 'refused', reason: 'expired' };

    const binding = await activeBindingWithin(tx, input.tenantId, input.deviceEnrollmentId);
    if (
      binding === null ||
      binding.terminalId !== row.terminalId ||
      binding.branchId !== row.branchId
    ) {
      return { outcome: 'refused', reason: 'device-inactive' };
    }

    await tx.$executeRaw`
      UPDATE "native_auth_challenges"
      SET "consumedAt" = ${input.now}
      WHERE "tenantId" = ${input.tenantId}::uuid
        AND "id" = ${input.challengeId}::uuid
        AND "consumedAt" IS NULL`;

    return {
      outcome: 'claimed',
      challenge: {
        ...binding,
        challengeId: row.id,
        nonce: Buffer.from(row.nonce),
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
      },
    };
  });
}

export async function createNativeSession(
  prisma: PrismaClient,
  input: CreateNativeSessionInput,
): Promise<CreateNativeSessionResult> {
  return withTenant(prisma, input.tenantId, async (tx) => {
    const binding = await activeBindingWithin(tx, input.tenantId, input.binding.deviceEnrollmentId);
    if (
      binding === null ||
      binding.terminalId !== input.binding.terminalId ||
      binding.branchId !== input.binding.branchId ||
      binding.publicKeySha256 !== input.binding.publicKeySha256
    ) {
      return { outcome: 'refused', reason: 'device-inactive' };
    }

    const users = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "users"
      WHERE "tenantId" = ${input.tenantId}::uuid
        AND "id" = ${input.userId}::uuid
        AND "isActive" = TRUE
        AND "authVersion" = ${input.expectedAuthVersion}
      FOR UPDATE`;
    if (users.length !== 1) return { outcome: 'refused', reason: 'user-inactive' };

    const memberships = await tx.$queryRaw<{ status: string; defaultBranchId: string | null }[]>`
      SELECT "status", "defaultBranchId"
      FROM "tenant_memberships"
      WHERE "tenantId" = ${input.tenantId}::uuid
        AND "userId" = ${input.userId}::uuid
      FOR UPDATE`;
    const membership = memberships.at(0);
    if (membership === undefined || membership.status !== 'active') {
      return { outcome: 'refused', reason: 'membership-inactive' };
    }
    if (membership.defaultBranchId !== null && membership.defaultBranchId !== binding.branchId) {
      return { outcome: 'refused', reason: 'branch-mismatch' };
    }

    await tx.$executeRaw`
      UPDATE "users"
      SET "failedLoginCount" = 0,
          "lockedUntil" = NULL,
          "lastLoginAt" = ${input.createdAt}
      WHERE "tenantId" = ${input.tenantId}::uuid
        AND "id" = ${input.userId}::uuid`;

    await tx.$executeRaw`
      INSERT INTO "native_sessions" (
        "id", "tenantId", "userId", "tokenHash", "authVersion",
        "deviceEnrollmentId", "terminalId", "branchId", "devicePublicKeySha256",
        "createdAt", "expiresAt", "lastSeenAt", "revokedAt"
      ) VALUES (
        ${input.id}::uuid,
        ${input.tenantId}::uuid,
        ${input.userId}::uuid,
        ${input.tokenHash},
        ${input.expectedAuthVersion},
        ${binding.deviceEnrollmentId}::uuid,
        ${binding.terminalId}::uuid,
        ${binding.branchId}::uuid,
        ${binding.publicKeySha256},
        ${input.createdAt},
        ${input.expiresAt},
        ${input.createdAt},
        NULL
      )`;
    return { outcome: 'created' };
  });
}

interface NativeSessionRow {
  sessionId: string;
  tenantId: string;
  userId: string;
  sessionAuthVersion: number;
  deviceEnrollmentId: string;
  terminalId: string;
  branchId: string;
  devicePublicKeySha256: string;
  expiresAt: Date;
  revokedAt: Date | null;
  tenantStatus: string;
  userEmail: string;
  userDisplayName: string;
  userIsActive: boolean;
  userAuthVersion: number;
  membershipStatus: string | null;
  membershipDefaultBranchId: string | null;
  deviceState: string;
  enrolledPublicKeySha256: string;
  terminalIsActive: boolean;
  branchIsActive: boolean;
}

export async function findNativeSessionByTokenHash(
  prisma: PrismaClient,
  tenantId: string,
  tokenHash: string,
): Promise<NativeSessionContext | null> {
  return withTenant(prisma, tenantId, async (tx) => {
    const rows = await tx.$queryRaw<NativeSessionRow[]>`
      SELECT
        ns."id" AS "sessionId",
        ns."tenantId" AS "tenantId",
        ns."userId" AS "userId",
        ns."authVersion" AS "sessionAuthVersion",
        ns."deviceEnrollmentId" AS "deviceEnrollmentId",
        ns."terminalId" AS "terminalId",
        ns."branchId" AS "branchId",
        ns."devicePublicKeySha256" AS "devicePublicKeySha256",
        ns."expiresAt" AS "expiresAt",
        ns."revokedAt" AS "revokedAt",
        tn."status" AS "tenantStatus",
        u."email" AS "userEmail",
        u."displayName" AS "userDisplayName",
        u."isActive" AS "userIsActive",
        u."authVersion" AS "userAuthVersion",
        tm."status" AS "membershipStatus",
        tm."defaultBranchId" AS "membershipDefaultBranchId",
        de."state" AS "deviceState",
        de."publicKeySha256" AS "enrolledPublicKeySha256",
        t."isActive" AS "terminalIsActive",
        b."isActive" AS "branchIsActive"
      FROM "native_sessions" ns
      JOIN "tenants" tn ON tn."id" = ns."tenantId"
      JOIN "users" u ON u."tenantId" = ns."tenantId" AND u."id" = ns."userId"
      LEFT JOIN "tenant_memberships" tm
        ON tm."tenantId" = ns."tenantId" AND tm."userId" = ns."userId"
      JOIN "device_enrollments" de
        ON de."tenantId" = ns."tenantId" AND de."id" = ns."deviceEnrollmentId"
      JOIN "terminals" t
        ON t."tenantId" = ns."tenantId" AND t."id" = ns."terminalId"
      JOIN "branches" b
        ON b."tenantId" = ns."tenantId" AND b."id" = ns."branchId"
      WHERE ns."tenantId" = ${tenantId}::uuid
        AND ns."tokenHash" = ${tokenHash}
      LIMIT 1`;
    return rows.at(0) ?? null;
  });
}

export async function touchNativeSession(
  prisma: PrismaClient,
  tenantId: string,
  sessionId: string,
  at: Date,
): Promise<void> {
  await withTenant(prisma, tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE "native_sessions"
      SET "lastSeenAt" = ${at}
      WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${sessionId}::uuid`;
  });
}

export async function revokeNativeSession(
  prisma: PrismaClient,
  tenantId: string,
  sessionId: string,
  at: Date,
): Promise<boolean> {
  return withTenant(prisma, tenantId, async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE "native_sessions"
      SET "revokedAt" = ${at}
      WHERE "tenantId" = ${tenantId}::uuid
        AND "id" = ${sessionId}::uuid
        AND "revokedAt" IS NULL`;
    return changed === 1;
  });
}
