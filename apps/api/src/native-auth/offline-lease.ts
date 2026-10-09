import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { withTenant } from '@korvi/database';
import { newId as defaultNewId, tenantId as brandTenantId } from '@korvi/domain';
import type { NativeAuthService } from './service.js';
import type { PrismaClient } from '@korvi/database';
import type { AuditRepository, Permission, TenantScope } from '@korvi/domain';

const PKCS8_ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const POS_ENTITLEMENT = 'pos.enabled';
const LEASE_VERSION = 1 as const;
const TOKEN_PREFIX = 'kol1';

export interface OfflineLeaseEntitlement {
  readonly key: string;
  readonly kind: string;
  readonly flagValue: boolean | null;
  readonly limitValue: string | null;
}

export interface OfflineLeaseClaims {
  readonly version: 1;
  readonly issuer: 'korvi-platform';
  readonly leaseId: string;
  readonly keyId: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly deviceEnrollmentId: string;
  readonly devicePublicKeySha256: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly userDisplayName: string;
  readonly sessionId: string;
  readonly roles: readonly string[];
  readonly maxDiscountBasisPoints: string;
  readonly assignmentId: string;
  readonly planKey: string;
  readonly planRevision: number;
  readonly entitlementRevision: string;
  readonly entitlements: readonly OfflineLeaseEntitlement[];
  readonly capabilities: readonly Permission[];
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly issuedAtUnixMs: number;
  readonly notBeforeUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly leaseRevision: 1;
}

export type OfflineLeaseIssueResult =
  | {
      readonly outcome: 'success';
      readonly lease: string;
      readonly claims: OfflineLeaseClaims;
      /** Public verification material only. The Ed25519 seed/private key never leaves the API. */
      readonly verificationKeySpki: string;
    }
  | {
      readonly outcome: 'failure';
      readonly reason: 'unauthenticated' | 'commercial-inactive' | 'signing-unavailable';
    };

export interface OfflineLeaseService {
  issue(nativeToken: string): Promise<OfflineLeaseIssueResult>;
}

export interface OfflineLeaseServiceOptions {
  readonly prisma: PrismaClient;
  readonly native: NativeAuthService;
  readonly audit: AuditRepository;
  readonly signingSeedBase64Url: string;
  readonly keyId: string;
  readonly ttlSeconds: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function signerFromSeed(encoded: string) {
  const seed = Buffer.from(encoded, 'base64url');
  if (seed.length !== 32) throw new Error('Offline lease signing seed must decode to 32 bytes.');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function encodeLease(
  claims: OfflineLeaseClaims,
  privateKey: ReturnType<typeof createPrivateKey>,
): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = sign(
    null,
    Buffer.from(`${TOKEN_PREFIX}.${payload}`, 'utf8'),
    privateKey,
  ).toString('base64url');
  return `${TOKEN_PREFIX}.${payload}.${signature}`;
}

export function createOfflineLeaseService(
  options: OfflineLeaseServiceOptions,
): OfflineLeaseService {
  const privateKey = signerFromSeed(options.signingSeedBase64Url);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Offline lease signing authority must be Ed25519.');
  }
  const verificationKeySpki = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? defaultNewId;

  return {
    async issue(nativeToken): Promise<OfflineLeaseIssueResult> {
      const authenticated = await options.native.authenticate(nativeToken);
      if (authenticated.outcome === 'failure') {
        return { outcome: 'failure', reason: 'unauthenticated' };
      }
      const { principal, binding } = authenticated;
      const scope: TenantScope = { tenantId: brandTenantId(principal.tenantId) };
      const commercial = await withTenant(options.prisma, principal.tenantId, async (tx) =>
        tx.tenantCommercialAccount.findUnique({
          where: { tenantId: principal.tenantId },
          include: { currentAssignment: { include: { entitlements: true } } },
        }),
      );
      const assignment = commercial?.currentAssignment;
      const posEnabled = assignment?.entitlements.some(
        (entry) =>
          entry.entitlementKey === POS_ENTITLEMENT &&
          entry.kind === 'flag' &&
          entry.flagValue === true,
      );
      if (assignment === undefined || assignment.accountState !== 'active' || !posEnabled) {
        return { outcome: 'failure', reason: 'commercial-inactive' };
      }

      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + options.ttlSeconds * 1000);
      const entitlements: OfflineLeaseEntitlement[] = assignment.entitlements
        .map((entry) => ({
          key: entry.entitlementKey,
          kind: entry.kind,
          flagValue: entry.flagValue,
          limitValue: entry.limitValue === null ? null : entry.limitValue.toString(),
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
      const capabilities = [...principal.permissions].sort();
      const roles = [...principal.roles].sort();
      const leaseId = newId();
      const issuedAtUnixMs = issuedAt.getTime();
      const expiresAtUnixMs = expiresAt.getTime();
      const claims: OfflineLeaseClaims = {
        version: LEASE_VERSION,
        issuer: 'korvi-platform',
        leaseId,
        keyId: options.keyId,
        tenantId: principal.tenantId,
        tenantSlug: principal.tenantSlug,
        branchId: binding.branchId,
        terminalId: binding.terminalId,
        deviceEnrollmentId: binding.deviceEnrollmentId,
        devicePublicKeySha256: binding.devicePublicKeySha256,
        userId: principal.userId,
        userEmail: principal.email,
        userDisplayName: principal.displayName,
        sessionId: principal.sessionId,
        roles,
        maxDiscountBasisPoints: principal.maxDiscountBasisPoints.toString(),
        assignmentId: assignment.id,
        planKey: assignment.planKey,
        planRevision: assignment.planRevision,
        entitlementRevision: `${assignment.id}:${assignment.planRevision}`,
        entitlements,
        capabilities,
        issuedAt: issuedAt.toISOString(),
        notBefore: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        issuedAtUnixMs,
        notBeforeUnixMs: issuedAtUnixMs,
        expiresAtUnixMs,
        leaseRevision: LEASE_VERSION,
      };
      const lease = encodeLease(claims, privateKey);
      await options.audit.append(scope, {
        id: newId(),
        actorUserId: principal.userId,
        branchId: binding.branchId,
        terminalId: binding.terminalId,
        eventType: 'auth.native.offline-lease.issued',
        entityType: 'offline-lease',
        entityId: leaseId,
        metadata: {
          deviceEnrollmentId: binding.deviceEnrollmentId,
          assignmentId: assignment.id,
          planRevision: assignment.planRevision,
          keyId: options.keyId,
          expiresAt: expiresAt.toISOString(),
        },
        occurredAt: issuedAt.toISOString(),
      });
      return { outcome: 'success', lease, claims, verificationKeySpki };
    },
  };
}
