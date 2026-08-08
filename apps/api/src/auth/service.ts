import { createHash } from 'node:crypto';
import {
  maxDiscountForRoles,
  newId as defaultNewId,
  normalizeEmail,
  tenantId as brandTenantId,
} from '@korvi/domain';
import { PRODUCTION_SCRYPT, verifyAgainstDummy, verifyPassword } from './password.js';
import { hashToken, issueToken, parseToken } from './token.js';
import type { ScryptProfile } from './password.js';
import type {
  AuditRepository,
  AuthRepository,
  AuthenticatedPrincipal,
  TenantScope,
} from '@korvi/domain';

/**
 * The authentication boundary.
 *
 * Everything a route needs to turn credentials into a session, and a cookie
 * into a principal. It holds no Fastify types on purpose: the rules here are
 * about identity, not about HTTP, and keeping them separable is what makes them
 * testable without a server.
 */

export type LoginFailureReason =
  | 'unknown-tenant'
  | 'tenant-inactive'
  | 'unknown-user'
  | 'bad-password'
  | 'locked'
  | 'user-inactive'
  | 'membership-inactive'
  | 'no-credential';

export interface LoginSuccess {
  readonly outcome: 'success';
  /** Handed to the browser once, in Set-Cookie. Never logged, never in JSON. */
  readonly token: string;
  readonly expiresAt: string;
  readonly principal: AuthenticatedPrincipal;
}

/**
 * One shape for every failure.
 *
 * `reason` exists for the audit trail and for tests. It never leaves the
 * server: the HTTP layer maps every one of these to the same body and the same
 * status, because "no such tenant", "no such user" and "wrong password" are
 * three different sentences that together enumerate a customer's staff list.
 */
export interface LoginFailure {
  readonly outcome: 'failure';
  readonly reason: LoginFailureReason;
}

export type LoginResult = LoginSuccess | LoginFailure;

export type SessionFailureReason =
  | 'malformed-token'
  | 'unknown-session'
  | 'tenant-inactive'
  | 'revoked'
  | 'expired'
  | 'auth-version'
  | 'user-inactive'
  | 'membership-inactive';

export interface SessionSuccess {
  readonly outcome: 'success';
  readonly principal: AuthenticatedPrincipal;
}

export interface SessionFailure {
  readonly outcome: 'failure';
  readonly reason: SessionFailureReason;
}

export type SessionResult = SessionSuccess | SessionFailure;

/**
 * Lockout, stated as numbers rather than as a feeling.
 *
 * Five attempts is enough for a cashier who is bad at typing on a touchscreen
 * and far too few for anyone working through a password list. Fifteen minutes
 * costs an attacker three attempts an hour and costs the shop one coffee.
 *
 * The lock is a delay, not a disablement: an account that locks permanently
 * turns a nuisance into a denial-of-service against the till on a busy Friday.
 */
export interface LockoutPolicy {
  readonly threshold: number;
  readonly lockSeconds: number;
}

export const DEFAULT_LOCKOUT: LockoutPolicy = { threshold: 5, lockSeconds: 15 * 60 };

export interface AuthServiceOptions {
  readonly repository: AuthRepository;
  readonly audit: AuditRepository;
  readonly sessionTtlSeconds: number;
  readonly lockout?: LockoutPolicy;
  readonly scrypt?: ScryptProfile;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Audit failures are reported here rather than swallowed. */
  readonly onAuditError?: (error: unknown) => void;
}

export interface LoginInput {
  readonly tenantSlug: string;
  readonly email: string;
  readonly password: string;
  readonly userAgent: string | null;
}

export interface AuthService {
  login(input: LoginInput): Promise<LoginResult>;
  authenticate(rawToken: string): Promise<SessionResult>;
  logout(rawToken: string): Promise<boolean>;
  logoutAll(rawToken: string): Promise<number>;
}

/**
 * A stable, non-reversing label for an address that failed to log in.
 *
 * Enough to see "the same address failed forty times" without writing the
 * address into a table that support staff read all day. It is pseudonymisation,
 * not secrecy: the space of email addresses is enumerable, so anyone holding a
 * candidate can confirm it. That is an acceptable trade for correlation; what
 * it prevents is the audit log itself becoming a directory of who banks here.
 */
export function correlationHash(tenantId: string, email: string): string {
  return createHash('sha256')
    .update(`${tenantId}:${email}`, 'utf8')
    .digest('base64url')
    .slice(0, 22);
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const {
    repository,
    audit,
    sessionTtlSeconds,
    lockout = DEFAULT_LOCKOUT,
    scrypt = PRODUCTION_SCRYPT,
    now = () => new Date(),
    newId = defaultNewId,
    onAuditError = () => undefined,
  } = options;

  /**
   * Audit is recorded outside the transaction that created the session.
   *
   * A failed audit write must not undo a successful authentication: the session
   * row already exists, so rolling the login back would hand the user a failure
   * while leaving a live session behind them — worse than an unwritten log line.
   * The failure is surfaced to the caller's logger instead of vanishing.
   */
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
        entityType: 'session',
        entityId,
        metadata,
        occurredAt: now().toISOString(),
      });
    } catch (error) {
      onAuditError(error);
    }
  }

  function fail(reason: LoginFailureReason): LoginFailure {
    return { outcome: 'failure', reason };
  }

  return {
    async login(input: LoginInput): Promise<LoginResult> {
      const email = normalizeEmail(input.email);
      const tenant = await repository.resolveTenantForLogin(input.tenantSlug);

      // Every early exit still pays for a scrypt derivation. Without it the
      // response time answers "does this shop exist?" and "does this person
      // work here?" for anybody willing to time it.
      if (tenant === null) {
        await verifyAgainstDummy(input.password, scrypt);
        return fail('unknown-tenant');
      }
      if (tenant.status !== 'active') {
        await verifyAgainstDummy(input.password, scrypt);
        return fail('tenant-inactive');
      }

      const scope: TenantScope = { tenantId: tenant.id };
      const user = email === '' ? null : await repository.findUserByEmail(scope, email);

      if (user === null) {
        await verifyAgainstDummy(input.password, scrypt);
        await record(scope, 'auth.login.failure', null, null, {
          reason: 'unknown-user',
          correlation: correlationHash(tenant.id, email),
        });
        return fail('unknown-user');
      }

      const at = now();
      const locked = user.lockedUntil !== null && new Date(user.lockedUntil) > at;

      // The lock is checked after the KDF, not before. Returning early on a
      // locked account would make the lock itself a fast path, and a fast path
      // is a signal: an attacker learns which addresses are real by which ones
      // answer quickly.
      const credentialOk =
        user.passwordHash === null
          ? await verifyAgainstDummy(input.password, scrypt)
          : await verifyPassword(input.password, user.passwordHash);

      if (locked) {
        await record(scope, 'auth.login.failure', null, user.id, { reason: 'locked' });
        return fail('locked');
      }

      if (user.passwordHash === null) {
        await record(scope, 'auth.login.failure', null, user.id, { reason: 'no-credential' });
        return fail('no-credential');
      }

      if (!credentialOk) {
        // The transition happens in the database, in one statement. Computing
        // `count + 1` here and writing the absolute value would lose
        // increments under concurrent guessing, which is precisely when the
        // counter matters.
        const window = await repository.registerFailedLogin(scope, user.id, at.toISOString(), {
          threshold: lockout.threshold,
          lockSeconds: lockout.lockSeconds,
        });
        await record(scope, 'auth.login.failure', null, user.id, {
          reason: 'bad-password',
          failedLoginCount: window.failedLoginCount,
          locked: window.locked,
        });
        return fail('bad-password');
      }

      if (!user.isActive) {
        await record(scope, 'auth.login.failure', null, user.id, { reason: 'user-inactive' });
        return fail('user-inactive');
      }

      const membership = await repository.membershipFor(scope, user.id);
      if (membership === null || membership.status !== 'active') {
        await record(scope, 'auth.login.failure', null, user.id, { reason: 'membership-inactive' });
        return fail('membership-inactive');
      }

      const authorization = await repository.loadAuthorization(scope, user.id);
      const issued = issueToken(tenant.id);
      const sessionId = newId();
      const expiresAt = new Date(at.getTime() + sessionTtlSeconds * 1000).toISOString();

      // Session creation and the reset of the failure state commit together.
      // Split, a crash between them leaves a live session belonging to a user
      // the database still believes is locked out.
      await repository.finalizeSuccessfulLogin(scope, {
        id: sessionId,
        userId: user.id,
        tokenHash: issued.tokenHash,
        authVersion: user.authVersion,
        userAgent: input.userAgent,
        issuedAt: at.toISOString(),
        expiresAt,
        at: at.toISOString(),
      });
      await record(scope, 'auth.login.success', sessionId, user.id, {
        roles: authorization.roles.join(','),
      });

      return {
        outcome: 'success',
        token: issued.token,
        expiresAt,
        principal: {
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          userId: user.id,
          sessionId,
          email: user.email,
          displayName: user.displayName,
          roles: authorization.roles,
          permissions: authorization.permissions,
          maxDiscountBasisPoints: maxDiscountForRoles(authorization.roles),
          branchId: authorization.branchId ?? membership.defaultBranchId,
        },
      };
    },

    async authenticate(rawToken: string): Promise<SessionResult> {
      const parsed = parseToken(rawToken);
      if (parsed === null) return { outcome: 'failure', reason: 'malformed-token' };

      // The tenant hint decides which RLS context opens, and nothing else. The
      // hash covers the whole token, so a hint that has been edited hashes to a
      // value no row carries — and even if it did, the row would belong to the
      // hinted tenant, which is the tenant whose context we are in.
      const scope: TenantScope = { tenantId: brandTenantId(parsed.tenantHint) };
      const context = await repository.findSessionByTokenHash(scope, hashToken(parsed.raw));
      if (context === null) return { outcome: 'failure', reason: 'unknown-session' };

      // Checked first, and read from the tenants row rather than from the
      // token: a tenant suspended after this session was issued must stop
      // working now, not when a twelve-hour cookie happens to expire.
      if (context.tenantStatus !== 'active') {
        return { outcome: 'failure', reason: 'tenant-inactive' };
      }
      if (context.revokedAt !== null) return { outcome: 'failure', reason: 'revoked' };
      if (new Date(context.expiresAt) <= now()) return { outcome: 'failure', reason: 'expired' };
      if (context.sessionAuthVersion !== context.user.authVersion) {
        return { outcome: 'failure', reason: 'auth-version' };
      }
      if (!context.user.isActive) return { outcome: 'failure', reason: 'user-inactive' };
      if (context.membership === null || context.membership.status !== 'active') {
        return { outcome: 'failure', reason: 'membership-inactive' };
      }

      const authorization = await repository.loadAuthorization(scope, context.userId);
      await repository.touchSession(scope, context.sessionId, now().toISOString());

      return {
        outcome: 'success',
        principal: {
          tenantId: parsed.tenantHint,
          tenantSlug: '',
          userId: context.userId,
          sessionId: context.sessionId,
          email: context.user.email,
          displayName: context.user.displayName,
          roles: authorization.roles,
          permissions: authorization.permissions,
          maxDiscountBasisPoints: maxDiscountForRoles(authorization.roles),
          branchId: authorization.branchId ?? context.membership.defaultBranchId,
        },
      };
    },

    async logout(rawToken: string): Promise<boolean> {
      const parsed = parseToken(rawToken);
      if (parsed === null) return false;
      const scope: TenantScope = { tenantId: brandTenantId(parsed.tenantHint) };
      const context = await repository.findSessionByTokenHash(scope, hashToken(parsed.raw));
      if (context === null) return false;

      const revoked = await repository.revokeSession(scope, context.sessionId, now().toISOString());
      if (revoked) {
        await record(scope, 'auth.logout', context.sessionId, context.userId, {});
      }
      return revoked;
    },

    async logoutAll(rawToken: string): Promise<number> {
      const parsed = parseToken(rawToken);
      if (parsed === null) return 0;
      const scope: TenantScope = { tenantId: brandTenantId(parsed.tenantHint) };
      const context = await repository.findSessionByTokenHash(scope, hashToken(parsed.raw));
      if (context === null) return 0;

      const count = await repository.revokeAllSessionsForUser(
        scope,
        context.userId,
        now().toISOString(),
      );
      await record(scope, 'auth.session.revoked', null, context.userId, { revoked: count });
      return count;
    },
  };
}
