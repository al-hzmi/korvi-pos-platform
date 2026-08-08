import { tenantId as brandTenantId } from '@korvi/domain';
import type {
  AuditEventInput,
  AuditRepository,
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

/**
 * An in-memory stand-in for the persistence the auth path uses.
 *
 * It exists so the login rules, the lockout arithmetic and the session
 * lifecycle can be tested without a database — and, more usefully, so the
 * cross-tenant cases can be written as ordinary unit tests. The live suite
 * proves PostgreSQL enforces the same thing; this proves the code asks it to.
 *
 * Every lookup filters on the scope's tenant, exactly as the Prisma adapter's
 * `where` clauses do. That is deliberate: a fake that ignored the scope would
 * make the tenant-confusion tests pass for the wrong reason.
 */

export interface MemoryTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
}

export interface MemoryUser {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly displayName: string;
  passwordHash: string | null;
  isActive: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  authVersion: number;
  lastLoginAt: string | null;
}

export interface MemorySession {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly authVersion: number;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface MemoryMembership {
  readonly tenantId: string;
  readonly userId: string;
  status: string;
  defaultBranchId: string | null;
}

export interface MemoryGrant {
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly RoleName[];
  readonly permissions: readonly Permission[];
}

export class MemoryAuthStore {
  public readonly tenants: MemoryTenant[] = [];
  public readonly users: MemoryUser[] = [];
  public readonly sessions: MemorySession[] = [];
  public readonly memberships: MemoryMembership[] = [];
  public readonly grants: MemoryGrant[] = [];
  public readonly audit: { scope: string; event: AuditEventInput }[] = [];
  /** Set to make the audit write fail, so its blast radius can be measured. */
  public auditFails = false;
  /**
   * Set to make the finalizing transaction fail.
   *
   * The fake commits the session and the counter reset together or not at all,
   * mirroring what the real adapter asks PostgreSQL for — otherwise a test of
   * that atomicity would be a test of the fake's sloppiness.
   */
  public finalizeFails = false;
}

function scopeId(scope: TenantScope): string {
  return scope.tenantId as string;
}

function toRecord(user: MemoryUser): AuthUserRecord {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    passwordHash: user.passwordHash,
    isActive: user.isActive,
    failedLoginCount: user.failedLoginCount,
    lockedUntil: user.lockedUntil,
    authVersion: user.authVersion,
  };
}

export function memoryAuthRepository(store: MemoryAuthStore): AuthRepository {
  function membership(tenant: string, userId: string): MembershipRecord | null {
    const found = store.memberships.find(
      (candidate) => candidate.tenantId === tenant && candidate.userId === userId,
    );
    return found === undefined
      ? null
      : { status: found.status, defaultBranchId: found.defaultBranchId };
  }

  return {
    resolveTenantForLogin(slug: string): Promise<TenantIdentity | null> {
      const normalized = slug.normalize('NFKC').trim().toLowerCase();
      const found = store.tenants.find((candidate) => candidate.slug === normalized);
      return Promise.resolve(
        found === undefined
          ? null
          : {
              id: brandTenantId(found.id),
              slug: found.slug,
              name: found.name,
              status: found.status,
            },
      );
    },

    findUserByEmail(scope: TenantScope, email: string): Promise<AuthUserRecord | null> {
      const found = store.users.find(
        (candidate) => candidate.tenantId === scopeId(scope) && candidate.email === email,
      );
      return Promise.resolve(found === undefined ? null : toRecord(found));
    },

    registerFailedLogin(
      scope: TenantScope,
      userId: string,
      at: string,
      rule: LockoutRule,
    ): Promise<FailureWindow> {
      const user = store.users.find(
        (candidate) => candidate.tenantId === scopeId(scope) && candidate.id === userId,
      );
      if (user === undefined) {
        return Promise.resolve({ failedLoginCount: 0, lockedUntil: null, locked: false });
      }

      // The same three arms the SQL CASE expression uses. A fake that applied
      // a simpler rule would let the service pass here and fail in production.
      const now = new Date(at);
      const currentlyLocked = user.lockedUntil !== null && new Date(user.lockedUntil) > now;
      const lockExpired = user.lockedUntil !== null && new Date(user.lockedUntil) <= now;

      if (currentlyLocked) {
        user.failedLoginCount += 1;
      } else if (lockExpired) {
        user.failedLoginCount = 1;
        user.lockedUntil = null;
      } else {
        user.failedLoginCount += 1;
        user.lockedUntil =
          user.failedLoginCount >= rule.threshold
            ? new Date(now.getTime() + rule.lockSeconds * 1000).toISOString()
            : null;
      }

      return Promise.resolve({
        failedLoginCount: user.failedLoginCount,
        lockedUntil: user.lockedUntil,
        locked: user.lockedUntil !== null && new Date(user.lockedUntil) > now,
      });
    },

    finalizeSuccessfulLogin(scope: TenantScope, input: FinalizeLoginInput): Promise<void> {
      if (store.finalizeFails) return Promise.reject(new Error('finalizing transaction failed'));

      const user = store.users.find(
        (candidate) => candidate.tenantId === scopeId(scope) && candidate.id === input.userId,
      );
      if (user !== undefined) {
        user.failedLoginCount = 0;
        user.lockedUntil = null;
        user.lastLoginAt = input.at;
      }
      store.sessions.push({
        id: input.id,
        tenantId: scopeId(scope),
        userId: input.userId,
        tokenHash: input.tokenHash,
        authVersion: input.authVersion,
        expiresAt: input.expiresAt,
        lastSeenAt: input.issuedAt,
        revokedAt: null,
      });
      return Promise.resolve();
    },

    findSessionByTokenHash(scope: TenantScope, tokenHash: string): Promise<SessionContext | null> {
      // Both halves, exactly as the adapter does: the tenant filter and the
      // hash. RLS is the third, and only the live suite can see it.
      const session = store.sessions.find(
        (candidate) => candidate.tenantId === scopeId(scope) && candidate.tokenHash === tokenHash,
      );
      if (session === undefined) return Promise.resolve(null);
      const user = store.users.find(
        (candidate) => candidate.tenantId === scopeId(scope) && candidate.id === session.userId,
      );
      if (user === undefined) return Promise.resolve(null);
      const tenant = store.tenants.find((candidate) => candidate.id === scopeId(scope));
      if (tenant === undefined) return Promise.resolve(null);
      return Promise.resolve({
        sessionId: session.id,
        userId: session.userId,
        sessionAuthVersion: session.authVersion,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        user: toRecord(user),
        membership: membership(scopeId(scope), session.userId),
        // Read now, not remembered from login: a tenant suspended in between
        // has to reach a session that already exists.
        tenantStatus: tenant.status,
      });
    },

    touchSession(scope: TenantScope, sessionId: string, at: string): Promise<void> {
      const session = store.sessions.find(
        (candidate) => candidate.tenantId === scopeId(scope) && candidate.id === sessionId,
      );
      if (session !== undefined) session.lastSeenAt = at;
      return Promise.resolve();
    },

    revokeSession(scope: TenantScope, sessionId: string, at: string): Promise<boolean> {
      const session = store.sessions.find(
        (candidate) =>
          candidate.tenantId === scopeId(scope) &&
          candidate.id === sessionId &&
          candidate.revokedAt === null,
      );
      if (session === undefined) return Promise.resolve(false);
      session.revokedAt = at;
      return Promise.resolve(true);
    },

    revokeAllSessionsForUser(scope: TenantScope, userId: string, at: string): Promise<number> {
      let revoked = 0;
      for (const session of store.sessions) {
        if (
          session.tenantId === scopeId(scope) &&
          session.userId === userId &&
          session.revokedAt === null
        ) {
          session.revokedAt = at;
          revoked += 1;
        }
      }
      return Promise.resolve(revoked);
    },

    loadAuthorization(scope: TenantScope, userId: string): Promise<AuthorizationRecord> {
      const grant = store.grants.find(
        (candidate) => candidate.tenantId === scopeId(scope) && candidate.userId === userId,
      );
      return Promise.resolve({
        roles: grant?.roles ?? [],
        unknownRoleKeys: [],
        permissions: grant?.permissions ?? [],
        branchId: membership(scopeId(scope), userId)?.defaultBranchId ?? null,
      });
    },

    membershipFor(scope: TenantScope, userId: string): Promise<MembershipRecord | null> {
      return Promise.resolve(membership(scopeId(scope), userId));
    },
  };
}

export function memoryAuditRepository(store: MemoryAuthStore): AuditRepository {
  return {
    append(scope: TenantScope, event: AuditEventInput): Promise<void> {
      if (store.auditFails) return Promise.reject(new Error('audit sink is down'));
      store.audit.push({ scope: scopeId(scope), event });
      return Promise.resolve();
    },
    list(): Promise<readonly AuditEventInput[]> {
      return Promise.resolve(store.audit.map((entry) => entry.event));
    },
  };
}
