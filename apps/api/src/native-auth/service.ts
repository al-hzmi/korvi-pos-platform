import { Buffer } from 'node:buffer';
import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import {
  claimNativeAuthChallenge,
  createNativeAuthChallenge,
  createNativeSession,
  findNativeSessionByTokenHash,
  revokeNativeSession,
  touchNativeSession,
} from '@korvi/database/native-auth';
import {
  maxDiscountForRoles,
  newId as defaultNewId,
  normalizeEmail,
  tenantId as brandTenantId,
} from '@korvi/domain';
import { DEFAULT_LOCKOUT } from '../auth/service.js';
import { PRODUCTION_SCRYPT, verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { hashNativeToken, issueNativeToken, parseNativeToken } from './token.js';
import type { NativeChallengeRecord, NativeDeviceBinding } from '@korvi/database/native-auth';
import type { PrismaClient } from '@korvi/database';
import type {
  AuditRepository,
  AuthRepository,
  AuthenticatedPrincipal,
  TenantScope,
} from '@korvi/domain';
import type { ScryptProfile } from '../auth/password.js';

const CHALLENGE_TTL_MS = 90_000;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export type NativeChallengeRefusal = 'device-inactive' | 'invalid-input';
export type NativeLoginRefusal =
  | 'invalid-challenge'
  | 'challenge-expired'
  | 'challenge-replayed'
  | 'device-inactive'
  | 'invalid-signature'
  | 'invalid-credentials'
  | 'branch-mismatch';
export type NativeSessionRefusal =
  | 'malformed-token'
  | 'unknown-session'
  | 'tenant-inactive'
  | 'revoked'
  | 'expired'
  | 'auth-version'
  | 'user-inactive'
  | 'membership-inactive'
  | 'device-inactive'
  | 'device-key-mismatch'
  | 'terminal-inactive'
  | 'branch-inactive'
  | 'branch-mismatch';

export interface NativeChallengeSuccess {
  readonly outcome: 'success';
  readonly challengeId: string;
  readonly tenantId: string;
  readonly deviceEnrollmentId: string;
  readonly terminalId: string;
  readonly branchId: string;
  readonly expiresAt: string;
  /** Exact UTF-8 bytes the OS-backed device key signs. */
  readonly signingPayload: string;
}

export type NativeChallengeResult =
  | NativeChallengeSuccess
  | { readonly outcome: 'failure'; readonly reason: NativeChallengeRefusal };

export interface NativeLoginInput {
  readonly tenantId: string;
  readonly deviceEnrollmentId: string;
  readonly challengeId: string;
  readonly tenantSlug: string;
  readonly email: string;
  readonly password: string;
  readonly signature: string;
}

export interface NativeSessionBinding {
  readonly deviceEnrollmentId: string;
  readonly terminalId: string;
  readonly branchId: string;
  readonly devicePublicKeySha256: string;
}

export interface NativeLoginSuccess {
  readonly outcome: 'success';
  /** Returned only to the native process. The Tauri WebView must never receive it. */
  readonly token: string;
  readonly expiresAt: string;
  readonly principal: AuthenticatedPrincipal;
  readonly binding: NativeSessionBinding;
}

export type NativeLoginResult =
  | NativeLoginSuccess
  | { readonly outcome: 'failure'; readonly reason: NativeLoginRefusal };

export type NativeSessionResult =
  | {
      readonly outcome: 'success';
      readonly principal: AuthenticatedPrincipal;
      readonly binding: NativeSessionBinding;
    }
  | { readonly outcome: 'failure'; readonly reason: NativeSessionRefusal };

export interface NativeAuthService {
  issueChallenge(input: {
    readonly tenantId: string;
    readonly deviceEnrollmentId: string;
  }): Promise<NativeChallengeResult>;
  login(input: NativeLoginInput): Promise<NativeLoginResult>;
  authenticate(token: string): Promise<NativeSessionResult>;
  logout(token: string): Promise<boolean>;
}

export interface NativeAuthServiceOptions {
  readonly prisma: PrismaClient;
  readonly repository: AuthRepository;
  readonly audit: AuditRepository;
  readonly sessionTtlSeconds: number;
  readonly scrypt?: ScryptProfile;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly onAuditError?: (error: unknown) => void;
}

function canonicalChallenge(challenge: NativeChallengeRecord): string {
  return [
    'korvi.native-auth.v1',
    `challenge=${challenge.challengeId}`,
    `tenant=${challenge.tenantId}`,
    `enrollment=${challenge.deviceEnrollmentId}`,
    `branch=${challenge.branchId}`,
    `terminal=${challenge.terminalId}`,
    `nonce=${challenge.nonce.toString('base64url')}`,
    `expires=${challenge.expiresAt.toISOString()}`,
  ].join('\n');
}

function signatureIsValid(
  challenge: NativeChallengeRecord,
  encodedSignature: string,
): boolean {
  if (!SIGNATURE_PATTERN.test(encodedSignature)) return false;
  try {
    const publicKey = createPublicKey({
      key: challenge.publicKeySpki,
      format: 'der',
      type: 'spki',
    });
    const algorithm = challenge.keyAlgorithm === 'ed25519' ? null : 'sha256';
    return verifySignature(
      algorithm,
      Buffer.from(canonicalChallenge(challenge), 'utf8'),
      publicKey,
      Buffer.from(encodedSignature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function createNativeAuthService(options: NativeAuthServiceOptions): NativeAuthService {
  const {
    prisma,
    repository,
    audit,
    sessionTtlSeconds,
    scrypt = PRODUCTION_SCRYPT,
    now = () => new Date(),
    newId = defaultNewId,
    onAuditError = () => undefined,
  } = options;

  async function record(
    scope: TenantScope,
    eventType: string,
    entityId: string | null,
    actorUserId: string | null,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    try {
      await audit.append(scope, {
        id: newId(),
        actorUserId,
        branchId: null,
        terminalId: null,
        eventType,
        entityType: 'native_session',
        entityId,
        metadata,
        occurredAt: now().toISOString(),
      });
    } catch (error) {
      onAuditError(error);
    }
  }

  async function failCredentialTiming(password: string): Promise<void> {
    await verifyAgainstDummy(password, scrypt);
  }

  return {
    async issueChallenge(input): Promise<NativeChallengeResult> {
      if (input.tenantId.length > 64 || input.deviceEnrollmentId.length > 64) {
        return { outcome: 'failure', reason: 'invalid-input' };
      }
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
      const challenge = await createNativeAuthChallenge(prisma, {
        tenantId: input.tenantId,
        deviceEnrollmentId: input.deviceEnrollmentId,
        challengeId: newId(),
        nonce: randomBytes(32),
        issuedAt,
        expiresAt,
      });
      if (challenge === null) return { outcome: 'failure', reason: 'device-inactive' };
      return {
        outcome: 'success',
        challengeId: challenge.challengeId,
        tenantId: challenge.tenantId,
        deviceEnrollmentId: challenge.deviceEnrollmentId,
        terminalId: challenge.terminalId,
        branchId: challenge.branchId,
        expiresAt: challenge.expiresAt.toISOString(),
        signingPayload: canonicalChallenge(challenge),
      };
    },

    async login(input): Promise<NativeLoginResult> {
      const claimed = await claimNativeAuthChallenge(prisma, {
        tenantId: input.tenantId,
        deviceEnrollmentId: input.deviceEnrollmentId,
        challengeId: input.challengeId,
        now: now(),
      });
      if (claimed.outcome === 'refused') {
        const reason: NativeLoginRefusal =
          claimed.reason === 'expired'
            ? 'challenge-expired'
            : claimed.reason === 'consumed'
              ? 'challenge-replayed'
              : claimed.reason === 'device-inactive'
                ? 'device-inactive'
                : 'invalid-challenge';
        await failCredentialTiming(input.password);
        return { outcome: 'failure', reason };
      }

      const challenge = claimed.challenge;
      if (!signatureIsValid(challenge, input.signature)) {
        await failCredentialTiming(input.password);
        return { outcome: 'failure', reason: 'invalid-signature' };
      }

      const email = normalizeEmail(input.email);
      const tenant = await repository.resolveTenantForLogin(input.tenantSlug);
      if (tenant === null || tenant.id !== input.tenantId || tenant.status !== 'active') {
        await failCredentialTiming(input.password);
        return { outcome: 'failure', reason: 'invalid-credentials' };
      }
      const scope: TenantScope = { tenantId: tenant.id };
      const user = email === '' ? null : await repository.findUserByEmail(scope, email);
      if (user === null) {
        await failCredentialTiming(input.password);
        await record(scope, 'auth.native.login.failure', null, null, { reason: 'unknown-user' });
        return { outcome: 'failure', reason: 'invalid-credentials' };
      }

      const attemptedAt = now();
      const locked = user.lockedUntil !== null && new Date(user.lockedUntil) > attemptedAt;
      const credentialOk =
        user.passwordHash === null
          ? await verifyAgainstDummy(input.password, scrypt)
          : await verifyPassword(input.password, user.passwordHash);

      if (locked) {
        await record(scope, 'auth.native.login.failure', null, user.id, { reason: 'locked' });
        return { outcome: 'failure', reason: 'invalid-credentials' };
      }
      if (user.passwordHash === null) {
        await record(scope, 'auth.native.login.failure', null, user.id, { reason: 'no-credential' });
        return { outcome: 'failure', reason: 'invalid-credentials' };
      }
      if (!credentialOk) {
        const window = await repository.registerFailedLogin(scope, user.id, attemptedAt.toISOString(), {
          threshold: DEFAULT_LOCKOUT.threshold,
          lockSeconds: DEFAULT_LOCKOUT.lockSeconds,
        });
        await record(scope, 'auth.native.login.failure', null, user.id, {
          reason: 'bad-password',
          failedLoginCount: window.failedLoginCount,
          locked: window.locked,
        });
        return { outcome: 'failure', reason: 'invalid-credentials' };
      }
      if (!user.isActive) {
        await record(scope, 'auth.native.login.failure', null, user.id, { reason: 'user-inactive' });
        return { outcome: 'failure', reason: 'invalid-credentials' };
      }

      const membership = await repository.membershipFor(scope, user.id);
      if (membership === null || membership.status !== 'active') {
        await record(scope, 'auth.native.login.failure', null, user.id, {
          reason: 'membership-inactive',
        });
        return { outcome: 'failure', reason: 'invalid-credentials' };
      }
      if (
        membership.defaultBranchId !== null &&
        membership.defaultBranchId !== challenge.branchId
      ) {
        await record(scope, 'auth.native.login.failure', null, user.id, {
          reason: 'branch-mismatch',
        });
        return { outcome: 'failure', reason: 'branch-mismatch' };
      }

      const authorization = await repository.loadAuthorization(scope, user.id);
      const issued = issueNativeToken(tenant.id);
      const sessionId = newId();
      const expiresAt = new Date(attemptedAt.getTime() + sessionTtlSeconds * 1000);
      const created = await createNativeSession(prisma, {
        id: sessionId,
        tenantId: tenant.id,
        userId: user.id,
        expectedAuthVersion: user.authVersion,
        tokenHash: issued.tokenHash,
        binding: challenge,
        createdAt: attemptedAt,
        expiresAt,
      });
      if (created.outcome === 'refused') {
        await record(scope, 'auth.native.login.failure', null, user.id, { reason: created.reason });
        return {
          outcome: 'failure',
          reason: created.reason === 'branch-mismatch' ? 'branch-mismatch' : 'device-inactive',
        };
      }

      const principal: AuthenticatedPrincipal = {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        userId: user.id,
        sessionId,
        email: user.email,
        displayName: user.displayName,
        roles: authorization.roles,
        permissions: authorization.permissions,
        maxDiscountBasisPoints: maxDiscountForRoles(authorization.roles),
        branchId: challenge.branchId,
      };
      const binding: NativeSessionBinding = {
        deviceEnrollmentId: challenge.deviceEnrollmentId,
        terminalId: challenge.terminalId,
        branchId: challenge.branchId,
        devicePublicKeySha256: challenge.publicKeySha256,
      };
      await record(scope, 'auth.native.login.success', sessionId, user.id, {
        deviceEnrollmentId: challenge.deviceEnrollmentId,
        terminalId: challenge.terminalId,
        branchId: challenge.branchId,
      });
      return {
        outcome: 'success',
        token: issued.token,
        expiresAt: expiresAt.toISOString(),
        principal,
        binding,
      };
    },

    async authenticate(token): Promise<NativeSessionResult> {
      const parsed = parseNativeToken(token);
      if (parsed === null) return { outcome: 'failure', reason: 'malformed-token' };
      const scope: TenantScope = { tenantId: brandTenantId(parsed.tenantHint) };
      const context = await findNativeSessionByTokenHash(prisma, parsed.tenantHint, hashNativeToken(token));
      if (context === null) return { outcome: 'failure', reason: 'unknown-session' };
      if (context.tenantStatus !== 'active') return { outcome: 'failure', reason: 'tenant-inactive' };
      if (context.revokedAt !== null) return { outcome: 'failure', reason: 'revoked' };
      if (context.expiresAt <= now()) return { outcome: 'failure', reason: 'expired' };
      if (context.sessionAuthVersion !== context.userAuthVersion) {
        return { outcome: 'failure', reason: 'auth-version' };
      }
      if (!context.userIsActive) return { outcome: 'failure', reason: 'user-inactive' };
      if (context.membershipStatus !== 'active') {
        return { outcome: 'failure', reason: 'membership-inactive' };
      }
      if (context.deviceState !== 'active') return { outcome: 'failure', reason: 'device-inactive' };
      if (context.devicePublicKeySha256 !== context.enrolledPublicKeySha256) {
        return { outcome: 'failure', reason: 'device-key-mismatch' };
      }
      if (!context.terminalIsActive) return { outcome: 'failure', reason: 'terminal-inactive' };
      if (!context.branchIsActive) return { outcome: 'failure', reason: 'branch-inactive' };
      if (
        context.membershipDefaultBranchId !== null &&
        context.membershipDefaultBranchId !== context.branchId
      ) {
        return { outcome: 'failure', reason: 'branch-mismatch' };
      }

      const authorization = await repository.loadAuthorization(scope, context.userId);
      await touchNativeSession(prisma, context.tenantId, context.sessionId, now());
      return {
        outcome: 'success',
        principal: {
          tenantId: context.tenantId,
          tenantSlug: '',
          userId: context.userId,
          sessionId: context.sessionId,
          email: context.userEmail,
          displayName: context.userDisplayName,
          roles: authorization.roles,
          permissions: authorization.permissions,
          maxDiscountBasisPoints: maxDiscountForRoles(authorization.roles),
          branchId: context.branchId,
        },
        binding: {
          deviceEnrollmentId: context.deviceEnrollmentId,
          terminalId: context.terminalId,
          branchId: context.branchId,
          devicePublicKeySha256: context.devicePublicKeySha256,
        },
      };
    },

    async logout(token): Promise<boolean> {
      const parsed = parseNativeToken(token);
      if (parsed === null) return false;
      const context = await findNativeSessionByTokenHash(prisma, parsed.tenantHint, hashNativeToken(token));
      if (context === null) return false;
      return revokeNativeSession(prisma, context.tenantId, context.sessionId, now());
    },
  };
}

export function nativeChallengePayloadForTest(challenge: NativeChallengeRecord): string {
  return canonicalChallenge(challenge);
}

export function nativeBindingFromChallenge(challenge: NativeChallengeRecord): NativeDeviceBinding {
  return challenge;
}
