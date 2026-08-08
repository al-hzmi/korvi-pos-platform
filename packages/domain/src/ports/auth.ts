import type { Permission, RoleName } from '../rbac/permissions.js';
import type { TenantIdentity, TenantScope, TenantStatus } from './persistence.js';

/**
 * The persistence the authentication path needs.
 *
 * Same rule as every other port in this directory: the domain says what it
 * needs, packages/database supplies it, and no Prisma type crosses the line
 * (ADR-0001). Timestamps cross as ISO 8601 strings.
 *
 * One thing is deliberately absent. There is no method that returns a session
 * token, a token hash or a password hash to a caller. The hash columns exist so
 * the database can be compared against a presented secret; nothing else has a
 * reason to hold them, and a port that hands them out is a port that will
 * eventually hand them to a log line.
 */

/**
 * One spelling of an address, everywhere.
 *
 * The local part of an email address is case-sensitive per RFC 5321, and in
 * practice no provider treats it that way. Storing and comparing a single
 * lower-cased, NFKC-normalised form means "Sara@Korvi.sa" and "sara@korvi.sa"
 * are one account rather than two — and, more to the point, that a login cannot
 * be made to miss an existing user by changing the capitalisation.
 *
 * Returns the empty string for anything that is not plausibly an address, and
 * the caller declines to query on that.
 */
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(input: string): string {
  const candidate = input.normalize('NFKC').trim().toLowerCase();
  return candidate.length <= 254 && EMAIL_PATTERN.test(candidate) ? candidate : '';
}

export interface AuthUserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  /** The encoded KDF output. Verified in place; never returned to a client. */
  readonly passwordHash: string | null;
  readonly isActive: boolean;
  readonly failedLoginCount: number;
  readonly lockedUntil: string | null;
  readonly authVersion: number;
}

export interface MembershipRecord {
  readonly status: string;
  readonly defaultBranchId: string | null;
}

/** What a verified session resolves to, in one round trip. */
export interface SessionContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly sessionAuthVersion: number;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly user: AuthUserRecord;
  readonly membership: MembershipRecord | null;
  /**
   * The tenant's status as it stands now, read from the tenants row under this
   * tenant's own RLS scope — not taken from the token.
   *
   * A tenant can be suspended while people are logged in. Checking it only at
   * login would leave every existing session working until it expired, which
   * for a twelve-hour session is the rest of the trading day.
   */
  readonly tenantStatus: TenantStatus;
}

/** Roles and permissions as they stand in the database right now. */
export interface AuthorizationRecord {
  readonly roles: readonly RoleName[];
  /** Unknown role keys are dropped by the adapter rather than guessed at. */
  readonly unknownRoleKeys: readonly string[];
  readonly permissions: readonly Permission[];
  readonly branchId: string | null;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly authVersion: number;
  readonly userAgent: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** The lockout rule, passed to the database rather than applied in memory. */
export interface LockoutRule {
  readonly threshold: number;
  readonly lockSeconds: number;
}

/** What the counter looked like after the database applied the transition. */
export interface FailureWindow {
  readonly failedLoginCount: number;
  readonly lockedUntil: string | null;
  readonly locked: boolean;
}

/** Session and successful-login state, written together or not at all. */
export interface FinalizeLoginInput extends CreateSessionInput {
  /** When the login happened; also the session's issuedAt. */
  readonly at: string;
}

export interface AuthRepository {
  /**
   * Turn a submitted slug into a tenant, before any scope exists.
   *
   * The only unscoped read in the system. It runs under a SELECT-only RLS
   * policy keyed on the exact slug, so it can return one tenant or none — it
   * cannot list, and it cannot write (ADR-0012).
   */
  resolveTenantForLogin(slug: string): Promise<TenantIdentity | null>;

  findUserByEmail(scope: TenantScope, email: string): Promise<AuthUserRecord | null>;

  /**
   * Move the failure counter, atomically, in the database.
   *
   * The transition is not "read the count, add one, write it back": two wrong
   * passwords arriving together would both read the same number and the second
   * would overwrite the first, so five concurrent guesses could register as
   * one. The rule travels to PostgreSQL and the row is updated in a single
   * statement, which serialises them.
   *
   * The same statement also opens a fresh window after a lock has expired.
   * Leaving the old count in place would mean the first typo after a lock
   * expires re-locks the account immediately, which is not what a fifteen
   * minute lock means.
   */
  registerFailedLogin(
    scope: TenantScope,
    userId: string,
    at: string,
    rule: LockoutRule,
  ): Promise<FailureWindow>;

  /**
   * Create the session and clear the failure state in one transaction.
   *
   * Separately, a crash between the two leaves a live session belonging to a
   * user the database still believes is locked out.
   */
  finalizeSuccessfulLogin(scope: TenantScope, input: FinalizeLoginInput): Promise<void>;
  /** Session, user and membership together: three round trips is three races. */
  findSessionByTokenHash(scope: TenantScope, tokenHash: string): Promise<SessionContext | null>;
  touchSession(scope: TenantScope, sessionId: string, at: string): Promise<void>;
  revokeSession(scope: TenantScope, sessionId: string, at: string): Promise<boolean>;
  revokeAllSessionsForUser(scope: TenantScope, userId: string, at: string): Promise<number>;

  loadAuthorization(scope: TenantScope, userId: string): Promise<AuthorizationRecord>;

  membershipFor(scope: TenantScope, userId: string): Promise<MembershipRecord | null>;
}
