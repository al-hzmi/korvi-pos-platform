import {
  PERMISSIONS,
  TENANT_LIFECYCLE_STATES,
  normalizeEmail,
  tenantId as brandTenantId,
} from '@korvi/domain';
import { withLoginSlug, withTenant } from '../tenant-context.js';
import { iso, isoOrNull, oneOf, scoped, tenantParam } from './mapping.js';
import type {
  AuthRepository,
  AuthUserRecord,
  AuthorizationRecord,
  FailureWindow,
  FinalizeLoginInput,
  LockoutRule,
  MembershipRecord,
  Permission,
  RoleName,
  SessionContext,
  TenantIdentity,
  TenantScope,
  TenantStatus,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const STATUSES: readonly TenantStatus[] = [...TENANT_LIFECYCLE_STATES];
const ROLE_NAMES: readonly RoleName[] = ['owner', 'admin', 'manager', 'cashier'];

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string | null;
  isActive: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
  authVersion: number;
}

interface MembershipRow {
  status: string;
  defaultBranchId: string | null;
}

function userToDomain(row: UserRow): AuthUserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    passwordHash: row.passwordHash,
    isActive: row.isActive,
    failedLoginCount: row.failedLoginCount,
    lockedUntil: isoOrNull(row.lockedUntil),
    authVersion: row.authVersion,
  };
}

function membershipToDomain(row: MembershipRow | undefined): MembershipRecord | null {
  return row === undefined ? null : { status: row.status, defaultBranchId: row.defaultBranchId };
}

/**
 * Prisma-backed adapter for the authentication port.
 *
 * Every method except `resolveTenantForLogin` runs inside `withTenant`, so RLS
 * is established on the transaction before any statement and the tenant filter
 * in the query is the second of two independent guards.
 *
 * `resolveTenantForLogin` is the exception, and it is the only one: it runs
 * under the SELECT-only login policy with no tenant context at all, which is
 * why it can read a tenant and nothing else (ADR-0012).
 */
export function createAuthRepository(prisma: PrismaClient): AuthRepository {
  return {
    async resolveTenantForLogin(slug: string): Promise<TenantIdentity | null> {
      return withLoginSlug(prisma, slug, async (tx) => {
        const rows = await tx.tenant.findMany({
          select: { id: true, slug: true, name: true, status: true },
          // Redundant with the policy, and kept anyway: the policy is the
          // boundary, this is the statement of intent.
          take: 2,
        });
        // More than one row would mean the policy matched something other than
        // an equality on the submitted slug. Refuse rather than pick.
        if (rows.length !== 1) return null;
        const row = rows[0];
        if (row === undefined) return null;
        return {
          id: brandTenantId(row.id),
          slug: row.slug,
          name: row.name,
          status: oneOf(STATUSES, row.status, 'tenants.status'),
        };
      });
    },

    async findUserByEmail(scope: TenantScope, email: string): Promise<AuthUserRecord | null> {
      const normalized = normalizeEmail(email);
      if (normalized === '') return null;
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: (UserRow & { tenantId: string }) | null = await tx.user.findFirst({
          where: { email: normalized, tenantId: tenantParam(scope) },
        });
        if (row === null) return null;
        scoped(scope, row.tenantId);
        return userToDomain(row);
      });
    },

    async registerFailedLogin(
      scope: TenantScope,
      userId: string,
      at: string,
      rule: LockoutRule,
    ): Promise<FailureWindow> {
      const now = new Date(at);
      const lockUntil = new Date(now.getTime() + rule.lockSeconds * 1000);

      return withTenant(prisma, scope.tenantId, async (tx) => {
        // One statement, so PostgreSQL's row lock is the concurrency boundary.
        // Read-modify-write in the application would let two simultaneous wrong
        // passwords both read the same count and the second overwrite the
        // first, turning five concurrent guesses into one recorded failure.
        //
        // The CASE arms are the whole policy:
        //   currently locked -> count moves, the deadline does not (arriving
        //     requests must not extend a lock)
        //   lock expired     -> a fresh window opens at one, not at the old
        //     count, so the first typo after a lock does not re-lock instantly
        //   threshold hit    -> the deadline is set in the same statement that
        //     crosses it
        const rows = await tx.$queryRaw<{ failedLoginCount: number; lockedUntil: Date | null }[]>`
          UPDATE "users" SET
            "failedLoginCount" = CASE
              WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now} THEN 1
              ELSE "failedLoginCount" + 1
            END,
            "lockedUntil" = CASE
              WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" > ${now} THEN "lockedUntil"
              WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now} THEN NULL
              WHEN "failedLoginCount" + 1 >= ${rule.threshold} THEN ${lockUntil}
              ELSE NULL
            END
          WHERE "id" = ${userId}::uuid AND "tenantId" = ${tenantParam(scope)}::uuid
          RETURNING "failedLoginCount", "lockedUntil"`;

        const row = rows.at(0);
        if (row === undefined) {
          // No row means RLS or the filter excluded it. Reporting a clean
          // window would be a lie; reporting a lock would be a denial of
          // service. Neither: the caller already knows the login failed.
          return { failedLoginCount: 0, lockedUntil: null, locked: false };
        }
        return {
          failedLoginCount: row.failedLoginCount,
          lockedUntil: isoOrNull(row.lockedUntil),
          locked: row.lockedUntil !== null && row.lockedUntil > now,
        };
      });
    },

    async finalizeSuccessfulLogin(scope: TenantScope, input: FinalizeLoginInput): Promise<void> {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        // The user update goes first deliberately. If the session insert fails
        // — a replayed id, a constraint, a dropped connection — the whole
        // transaction rolls back and the counters are as they were, rather
        // than a user left unlocked with no session to show for it.
        await tx.user.updateMany({
          where: { id: input.userId, tenantId: tenantParam(scope) },
          data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(input.at) },
        });
        await tx.session.create({
          data: {
            id: input.id,
            tenantId: tenantParam(scope),
            userId: input.userId,
            tokenHash: input.tokenHash,
            authVersion: input.authVersion,
            userAgent: input.userAgent,
            createdAt: new Date(input.issuedAt),
            expiresAt: new Date(input.expiresAt),
            lastSeenAt: new Date(input.issuedAt),
          },
        });
      });
    },

    async findSessionByTokenHash(
      scope: TenantScope,
      tokenHash: string,
    ): Promise<SessionContext | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        // The tenant row comes back with the session, read under this tenant's
        // own RLS scope. A suspension applied five minutes ago has to reach a
        // session issued this morning, and the token cannot be asked — it was
        // minted before the suspension existed.
        const row = await tx.session.findFirst({
          where: { tokenHash, tenantId: tenantParam(scope) },
          include: {
            user: { include: { memberships: true } },
            tenant: { select: { status: true } },
          },
        });
        if (row === null) return null;
        scoped(scope, row.tenantId);
        return {
          sessionId: row.id,
          userId: row.userId,
          sessionAuthVersion: row.authVersion,
          expiresAt: iso(row.expiresAt),
          revokedAt: isoOrNull(row.revokedAt),
          user: userToDomain(row.user),
          membership: membershipToDomain(row.user.memberships.at(0)),
          tenantStatus: oneOf(STATUSES, row.tenant.status, 'tenants.status'),
        };
      });
    },

    async touchSession(scope: TenantScope, sessionId: string, at: string): Promise<void> {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        await tx.session.updateMany({
          where: { id: sessionId, tenantId: tenantParam(scope) },
          data: { lastSeenAt: new Date(at) },
        });
      });
    },

    async revokeSession(scope: TenantScope, sessionId: string, at: string): Promise<boolean> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        // revokedAt: null in the filter, so revoking twice reports honestly
        // rather than overwriting the moment the session actually ended.
        const changed = await tx.session.updateMany({
          where: { id: sessionId, tenantId: tenantParam(scope), revokedAt: null },
          data: { revokedAt: new Date(at) },
        });
        return changed.count === 1;
      });
    },

    async revokeAllSessionsForUser(
      scope: TenantScope,
      userId: string,
      at: string,
    ): Promise<number> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const changed = await tx.session.updateMany({
          where: { userId, tenantId: tenantParam(scope), revokedAt: null },
          data: { revokedAt: new Date(at) },
        });
        return changed.count;
      });
    },

    async loadAuthorization(scope: TenantScope, userId: string): Promise<AuthorizationRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const assignments = await tx.userRole.findMany({
          where: { userId, tenantId: tenant },
          include: { role: { include: { permissions: true } } },
        });
        const membership = await tx.tenantMembership.findFirst({
          where: { userId, tenantId: tenant },
        });

        const roles: RoleName[] = [];
        const unknownRoleKeys: string[] = [];
        const permissions = new Set<Permission>();

        for (const assignment of assignments) {
          const key = assignment.role.key;
          const known = ROLE_NAMES.find((candidate) => candidate === key);
          // A role key the application has never heard of grants nothing. It
          // is reported rather than dropped silently, because it means the
          // database and the code disagree and somebody should know.
          if (known === undefined) unknownRoleKeys.push(key);
          else roles.push(known);

          for (const granted of assignment.role.permissions) {
            const permission = PERMISSIONS.find((candidate) => candidate === granted.permissionKey);
            if (permission !== undefined) permissions.add(permission);
          }
        }

        return {
          roles,
          unknownRoleKeys,
          permissions: [...permissions],
          branchId: membership?.defaultBranchId ?? null,
        };
      });
    },

    async membershipFor(scope: TenantScope, userId: string): Promise<MembershipRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: MembershipRow | null = await tx.tenantMembership.findFirst({
          where: { userId, tenantId: tenantParam(scope) },
        });
        return membershipToDomain(row ?? undefined);
      });
    },
  };
}
