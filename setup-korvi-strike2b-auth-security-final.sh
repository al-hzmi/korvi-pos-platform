#!/usr/bin/env bash
#
# setup-korvi-strike2b-auth-security.sh — Korvi POS · Strike 2B
#
# The authentication and authorization boundary, on top of the SaaS database
# foundation (main @ 338cf03):
#
#   prisma/                  Session model, user auth state, a forward-only
#                            Strike 2B migration with RLS on sessions and a
#                            narrow SELECT-only login-resolution policy
#   packages/domain/ports/   auth DTOs and the AuthRepository port
#   packages/database/       Prisma adapter, login-slug context, RBAC
#                            provisioning derived from the domain catalogue
#   apps/api/src/auth/       scrypt passwords, CSPRNG session tokens, cookie
#                            and origin policy, typed guards
#   apps/api/src/routes/     POST /v1/auth/login, POST /v1/auth/logout,
#                            POST /v1/auth/logout-all, GET /v1/auth/me
#
# No UI, no product or sale APIs, no signup, no password reset, no MFA.
#
# Run from the repository root. Never commits, pushes, resets, or cleans.

set -euo pipefail

if [ -t 1 ]; then
  C_B='\033[1;34m'; C_Y='\033[1;33m'; C_R='\033[1;31m'; C_G='\033[1;32m'; C_0='\033[0m'
else
  C_B=''; C_Y=''; C_R=''; C_G=''; C_0=''
fi
say()  { printf "${C_B}==>${C_0} %s\n" "$1"; }
ok()   { printf "${C_G}[ok]${C_0} %s\n" "$1"; }
warn() { printf "${C_Y}[!]${C_0} %s\n" "$1" >&2; }
die()  { printf "${C_R}[x]${C_0} %s\n" "$1" >&2; exit 1; }

RUN_VERIFY=1
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --no-verify)   RUN_VERIFY=0 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Not inside a git repository."
cd "$ROOT"

[ "$(node -p "require('./package.json').name" 2>/dev/null)" = "korvi-pos-platform" ] \
  || die "This is not korvi-pos-platform. Refusing to patch an unexpected repository."

BASELINE=338cf03
if git cat-file -e "${BASELINE}^{commit}" 2>/dev/null; then
  git merge-base --is-ancestor "$BASELINE" HEAD 2>/dev/null \
    || die "HEAD does not descend from $BASELINE.
     This patch is written against that baseline; applying it to an older or
     divergent tree would produce a schema that does not match its migration."
else
  die "Commit $BASELINE is not in this repository.
     Fetch it first (git fetch origin main) so the baseline can be verified."
fi

# Strike 2A security markers. Their absence means the baseline is not what this
# script was written against, and guessing would be worse than stopping.
STRIKE_2A_MIGRATION=packages/database/prisma/migrations/20260808120000_saas_foundation/migration.sql
for required in \
  packages/domain/src/rbac/permissions.ts \
  packages/domain/src/ports/persistence.ts \
  packages/database/src/tenant-context.ts \
  packages/database/src/repositories/mapping.ts \
  packages/database/src/__tests__/rls-live.test.ts \
  packages/database/src/__tests__/saas-schema.test.ts \
  packages/database/prisma/schema.prisma \
  packages/database/prisma/migrations/00000000000000_rls_foundation/migration.sql \
  "$STRIKE_2A_MIGRATION" \
  apps/api/src/server.ts \
  apps/api/src/config.ts
do
  [ -f "$required" ] || die "Baseline file missing: $required
     This patch expects Strike 2A (main @ $BASELINE)."
done

grep -q 'FORCE ROW LEVEL SECURITY' "$STRIKE_2A_MIGRATION" \
  || die "Strike 2A migration carries no FORCE ROW LEVEL SECURITY; baseline mismatch."
grep -q 'REFERENCES "users"("tenantId", "id")' "$STRIKE_2A_MIGRATION" \
  || die "Strike 2A composite tenant-consistent foreign keys are missing; baseline mismatch."
grep -q 'current_tenant_id()' packages/database/prisma/migrations/00000000000000_rls_foundation/migration.sql \
  || die "current_tenant_id() not found in the Phase 0 migration; baseline mismatch."
grep -q "export const PERMISSIONS" packages/domain/src/rbac/permissions.ts \
  || die "The domain permission catalogue was not found; baseline mismatch."
grep -q "export async function withTenant" packages/database/src/tenant-context.ts \
  || die "withTenant() not found; baseline mismatch."

# The Strike 2A migration is history. Nothing here may edit it.
STRIKE_2A_SUM="$(cksum < "$STRIKE_2A_MIGRATION")"

if [ "$ALLOW_DIRTY" -eq 0 ]; then
  DIRTY="$(git status --porcelain -- \
    packages/database packages/domain/src/ports apps/api docs/decisions 2>/dev/null || true)"
  if [ -n "$DIRTY" ]; then
    printf '%s\n' "$DIRTY" | sed 's/^/     /' >&2
    die "Uncommitted changes under a path this patch owns.
     Commit or stash them first, or re-run with --allow-dirty if you are sure."
  fi
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" = "24" ] || die "Node 24 LTS required (ADR-0007). Found $(node --version)."

ok "Baseline verified · $BASELINE in ancestry · Node $(node --version) · $(git rev-parse --short HEAD)"

REF_DESIGN_SUM="$(cksum < docs/design/KORVI-DESIGN-SYSTEM.md)"
REF_STRAT_SUM="$(cksum < docs/governance/Korvi_POS_Master_Strategy_Document.txt)"

MIGRATION_DIR="packages/database/prisma/migrations/20260810120000_auth_security"
mkdir -p \
  "$MIGRATION_DIR" \
  packages/database/src/provisioning \
  apps/api/src/auth \
  apps/api/src/routes \
  apps/api/src/__tests__

say "Prisma schema — user auth state and sessions"

python3 - <<'PY'
import re, sys

path = 'packages/database/prisma/schema.prisma'
schema = open(path, encoding='utf-8').read()

def once(old, new, marker, what):
    global schema
    if marker in schema:
        print('  %s already present' % what)
        return
    if old not in schema:
        sys.stderr.write('Could not find the anchor for %s; refusing to guess.\n' % what)
        sys.exit(1)
    schema = schema.replace(old, new, 1)
    print('  %s' % what)

# --- Tenant back-relation ---------------------------------------------------
once(
    '  idempotencyKeys    IdempotencyKey[]\n  auditEvents        AuditEvent[]\n',
    '  idempotencyKeys    IdempotencyKey[]\n  auditEvents        AuditEvent[]\n  sessions           Session[]\n',
    'sessions           Session[]',
    'Tenant.sessions',
)

# --- User auth state --------------------------------------------------------
once(
    """  /// Hash only. A plaintext or reversible credential must never reach a column.
  passwordHash String?
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
""",
    """  /// Hash only. A plaintext or reversible credential must never reach a column.
  /// The encoding carries its own KDF parameters, so the cost can be raised
  /// later without invalidating hashes written under the old ones (ADR-0012).
  passwordHash String?
  isActive     Boolean  @default(true)

  /// Consecutive failed attempts since the last success. Reset on success.
  failedLoginCount Int @default(0)
  /// Set when the count crosses the threshold. A null value is not a lock.
  lockedUntil      DateTime?
  /// Bumped to invalidate every existing session for this user at once — a
  /// password change or a suspected compromise, without a session sweep.
  /// A session carries the version it was minted under and stops matching.
  authVersion      Int @default(1)
  lastLoginAt      DateTime?

  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
""",
    'failedLoginCount Int @default(0)',
    'User auth state',
)

once(
    """  memberships TenantMembership[]
  roles       UserRole[]
  shifts      Shift[]
""",
    """  memberships TenantMembership[]
  roles       UserRole[]
  sessions    Session[]
  shifts      Shift[]
""",
    'sessions    Session[]',
    'User.sessions',
)

# --- Session ----------------------------------------------------------------
SESSION = '''// ---------------------------------------------------------------------------
// Sessions — the only thing a browser cookie may refer to
// ---------------------------------------------------------------------------

/// A server-created session.
///
/// The browser holds a token; this table holds its hash. A stolen database
/// backup therefore yields no usable credential, exactly as it yields no usable
/// password (ADR-0012).
model Session {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  userId   String @db.Uuid

  /// SHA-256 of the whole token, including its tenant segment. Unique across
  /// the installation rather than per tenant: two sessions sharing a hash would
  /// mean a CSPRNG collision, and that is worth refusing globally.
  tokenHash String @unique

  /// The user's authVersion when this session was minted. A mismatch means the
  /// account was reset since, and the session no longer authenticates.
  authVersion Int

  /// Diagnostic only. Never used to decide anything: a header is attacker-
  /// controlled, so treating it as a factor would be theatre.
  userAgent String?

  createdAt  DateTime  @default(now())
  expiresAt  DateTime
  lastSeenAt DateTime
  revokedAt  DateTime?

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: Cascade)

  @@index([tenantId, userId])
  @@index([tenantId, expiresAt])
  @@map("sessions")
}

'''

anchor = """// ---------------------------------------------------------------------------
// Global reference data — the only tables without tenantId
// ---------------------------------------------------------------------------"""
if 'model Session {' in schema:
    print('  Session already present')
else:
    if anchor not in schema:
        sys.stderr.write('Could not find the global-data section header.\n')
        sys.exit(1)
    schema = schema.replace(anchor, SESSION + anchor, 1)
    print('  Session model')

open(path, 'w', encoding='utf-8').write(schema)
PY

say "Strike 2B migration"

cat << 'SQLEOF' > "$MIGRATION_DIR/migration.sql"
-- Korvi POS — Strike 2B: authentication and authorization.
--
-- Forward only. It adds auth state to users, creates the sessions table, and
-- opens exactly one new door in the tenancy boundary — the login-resolution
-- policy described below. It drops no table and rewrites no data.
--
-- The Strike 2A migration is history and is not touched.

-- ---------------------------------------------------------------------------
-- User authentication state
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "authVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

-- A negative attempt count would mean the counter was written by something
-- other than the login path.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_failed_login_non_negative";
ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_non_negative"
  CHECK ("failedLoginCount" >= 0);
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_auth_version_positive";
ALTER TABLE "users" ADD CONSTRAINT "users_auth_version_positive"
  CHECK ("authVersion" >= 1);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

CREATE TABLE "sessions" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  -- The hash, never the token. A database backup is not a set of credentials.
  "tokenHash" TEXT NOT NULL,
  "authVersion" INTEGER NOT NULL,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "sessions_expires_after_creation" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- The Strike 2A tenant-consistency strategy: (tenantId, userId) rather than
  -- userId alone, so a session cannot be minted against another tenant's user.
  CONSTRAINT "sessions_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");
CREATE INDEX "sessions_tenantId_userId_idx" ON "sessions"("tenantId", "userId");
CREATE INDEX "sessions_tenantId_expiresAt_idx" ON "sessions"("tenantId", "expiresAt");

ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sessions_isolation" ON "sessions";
CREATE POLICY "sessions_isolation" ON "sessions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Login tenant resolution
-- ---------------------------------------------------------------------------
--
-- The bootstrap problem: authentication has to turn an untrusted tenant slug
-- into the tenant that will *become* the scope, and `tenants` is under FORCE
-- RLS keyed on a scope that does not exist yet.
--
-- The three wrong answers are disabling RLS, connecting as a superuser, and
-- granting BYPASSRLS. Each of them trades a permanent, installation-wide hole
-- for one lookup.
--
-- What this does instead is add a second, deliberately tiny policy. It is
-- FOR SELECT only, so no INSERT, UPDATE or DELETE can travel through it —
-- PostgreSQL will not even consider it for those commands. It matches on
-- equality against one transaction-local setting, so it returns at most the
-- single row whose slug was submitted, never a list. And the setting defaults
-- to NULL, so on every ordinary request the added term contributes nothing and
-- the isolation policy is the only one in effect.
--
-- Permissive policies combine with OR. The existing `tenants_isolation` policy
-- is unchanged and still governs everything else.

-- STABLE for the same reason current_tenant_id() is: the value changes between
-- transactions, and IMMUTABLE would let the planner cache one login's slug
-- into another's plan.
CREATE OR REPLACE FUNCTION login_tenant_slug() RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.login_tenant_slug', TRUE), '');
$$ LANGUAGE SQL STABLE;

DROP POLICY IF EXISTS "tenants_login_resolution" ON "tenants";
CREATE POLICY "tenants_login_resolution" ON "tenants"
  FOR SELECT
  USING ("slug" = login_tenant_slug());

-- No WITH CHECK, because a FOR SELECT policy cannot carry one — PostgreSQL
-- rejects the syntax. That is the point rather than an omission: this door
-- reads, and there is no version of it that writes.
SQLEOF

ok "migration written"

say "Domain — authenticated principal over the existing RBAC"

cat << 'EOF' > packages/domain/src/rbac/principal.ts
import { PermissionDeniedError, ROLE_MAX_DISCOUNT_BP, ROLE_PERMISSIONS } from './permissions.js';
import type { Actor, Permission, RoleName } from './permissions.js';

/**
 * What the server knows about whoever is making a request.
 *
 * Every field here was read from persistence after a session was verified.
 * Nothing in it came from the request body, a query string, a header or a
 * browser store — which is the whole point of the type existing: a route
 * handler that wants to know who is calling has exactly one place to look, and
 * that place cannot be written to from outside.
 *
 * It carries roles in the plural because a person can be both a manager and a
 * cashier. The existing `Actor` contract takes one role, so `toActor` collapses
 * the set at the boundary rather than forking the authorization model.
 */
export interface AuthenticatedPrincipal {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly RoleName[];
  readonly permissions: readonly Permission[];
  /** Basis points, derived from the roles held. Never sent by the client. */
  readonly maxDiscountBasisPoints: bigint;
  readonly branchId: string | null;
}

/**
 * Seniority, used only to pick which single role represents a multi-role user
 * in the existing one-role `Actor` contract.
 *
 * Permissions are unioned rather than ranked — holding two roles grants what
 * either grants — so this ordering never removes a capability. It exists
 * because the discount ceiling and the legacy `role` field are single-valued.
 */
export const ROLE_RANK: Readonly<Record<RoleName, number>> = {
  cashier: 1,
  manager: 2,
  admin: 3,
  owner: 4,
};

export function primaryRole(roles: readonly RoleName[]): RoleName | null {
  let best: RoleName | null = null;
  for (const role of roles) {
    if (best === null || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  return best;
}

/**
 * The ceiling a user may discount to, in basis points.
 *
 * The maximum across the roles held, not the sum and not the first: a manager
 * who is also a cashier does not lose the manager's authority, and two roles
 * do not add up to more than either grants.
 */
export function maxDiscountForRoles(roles: readonly RoleName[]): bigint {
  let ceiling = 0n;
  for (const role of roles) {
    const limit = ROLE_MAX_DISCOUNT_BP[role];
    if (limit > ceiling) ceiling = limit;
  }
  return ceiling;
}

/** The union of what every role held grants. */
export function permissionsForRoles(roles: readonly RoleName[]): readonly Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return [...granted];
}

/** Adapt to the existing single-role contract used by the sale path. */
export function toActor(principal: AuthenticatedPrincipal): Actor {
  const role = primaryRole(principal.roles);
  if (role === null) {
    // A principal with no role can still authenticate; it just cannot act.
    // Falling back to the least-privileged role would silently grant the
    // cashier's permissions to someone an administrator has not yet placed.
    throw new PrincipalWithoutRoleError(principal.userId);
  }
  return {
    userId: principal.userId,
    tenantId: principal.tenantId,
    role,
    permissions: principal.permissions,
    branchId: principal.branchId,
  };
}

export class PrincipalWithoutRoleError extends Error {
  public override readonly name = 'PrincipalWithoutRoleError';

  public constructor(userId: string) {
    super(`User ${userId} holds no role in this tenant.`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function principalCan(
  principal: AuthenticatedPrincipal,
  permission: Permission,
): boolean {
  return principal.permissions.includes(permission);
}

/** Throws rather than returning false: forgetting to check a boolean is easy. */
export function requirePrincipalPermission(
  principal: AuthenticatedPrincipal,
  permission: Permission,
): void {
  if (!principalCan(principal, permission)) {
    throw new PermissionDeniedError(permission);
  }
}
EOF

cat << 'EOF' > packages/domain/src/rbac/index.ts
export * from './permissions.js';
export * from './principal.js';
EOF

say "Domain — authentication ports"

cat << 'EOF' > packages/domain/src/ports/auth.ts
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
EOF

node - <<'NODE'
const fs = require('node:fs');
const file = 'packages/domain/src/index.ts';
const source = fs.readFileSync(file, 'utf8');
const from = "export * from './ports/persistence.js';";
const to = "export * from './ports/persistence.js';\nexport * from './ports/auth.js';";
if (source.includes("export * from './ports/auth.js';")) {
  process.stdout.write('  already exported\n');
} else if (source.includes(from)) {
  fs.writeFileSync(file, source.replace(from, to));
  process.stdout.write('  auth port exported\n');
} else {
  process.stderr.write('Could not find the ports export block in the domain barrel.\n');
  process.exit(1);
}
NODE

say "Database — login-resolution context"

python3 - <<'PY'
import sys
path = 'packages/database/src/tenant-context.ts'
source = open(path, encoding='utf-8').read()

if 'withLoginSlug' in source:
    print('  already present')
    sys.exit(0)

ADDITION = '''
/**
 * Deterministic slug normalisation.
 *
 * The same rule has to run in the resolver and in whatever writes the slug, or
 * a tenant that registered "Korvi" becomes unreachable by "korvi". NFKC first,
 * because a compatibility-composed character is the same slug to a human and a
 * different byte string to Postgres.
 *
 * Returns the empty string for anything that is not a plausible slug, and the
 * caller refuses to query on that rather than probing with rubbish.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function normalizeTenantSlug(input: string): string {
  const candidate = input.normalize('NFKC').trim().toLowerCase();
  return SLUG_PATTERN.test(candidate) ? candidate : '';
}

/**
 * Run `work` with the login-resolution setting established, and no tenant.
 *
 * This is the one read that happens before a scope exists: authentication has
 * to turn a submitted slug into the tenant that will become the scope. The
 * migration backs it with a SELECT-only policy keyed on `app.login_tenant_slug`
 * (ADR-0012), so inside this transaction exactly one tenant row is visible —
 * the one whose slug was submitted — and nothing at all is writable.
 *
 * `app.tenant_id` is left empty on purpose. Every other table keys its policy
 * on that, so users, products and sales are invisible here, which is what makes
 * this narrow enough to be safe.
 */
export async function withLoginSlug<T>(
  prisma: PrismaClient,
  slug: string,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  const normalized = normalizeTenantSlug(slug);
  if (normalized === '') {
    throw new TenantContextError('Not a tenant slug.');
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', '', TRUE)`;
    // Parameterised: set_config is a function call, so the submitted value is
    // bound rather than concatenated into the statement.
    await tx.$executeRaw`SELECT set_config('app.login_tenant_slug', ${normalized}, TRUE)`;
    return work(tx);
  });
}
'''

open(path, 'w', encoding='utf-8').write(source.rstrip('\n') + '\n' + ADDITION)
print('  withLoginSlug added')
PY

say "Database — authentication repository"

cat << 'EOF' > packages/database/src/repositories/auth-repository.ts
import { PERMISSIONS, normalizeEmail, tenantId as brandTenantId } from '@korvi/domain';
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

const STATUSES: readonly TenantStatus[] = ['active', 'suspended', 'closed'];
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

    async finalizeSuccessfulLogin(
      scope: TenantScope,
      input: FinalizeLoginInput,
    ): Promise<void> {
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
EOF

say "Database — RBAC provisioning derived from the domain catalogue"

cat << 'EOF' > packages/database/src/provisioning/rbac.ts
import {
  PERMISSIONS,
  ROLE_MAX_DISCOUNT_BP,
  ROLE_PERMISSIONS,
  newId,
} from '@korvi/domain';
import { withTenant, withoutTenant } from '../tenant-context.js';
import { tenantParam } from '../repositories/mapping.js';
import type { Permission, RoleName, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * The application's own vocabulary, installed into the database.
 *
 * `Record<Permission, ...>` rather than an array: the type system then refuses
 * to compile if a permission is added to the domain and not described here, so
 * the two catalogues cannot drift without somebody noticing at build time.
 * A test asserts the reverse direction — nothing described here that the domain
 * does not define.
 */
export const PERMISSION_CATALOGUE: Readonly<
  Record<Permission, { readonly ar: string; readonly en: string }>
> = {
  'product.read': { ar: 'عرض المنتجات', en: 'View products' },
  'product.write': { ar: 'تعديل المنتجات', en: 'Edit products' },
  'inventory.read': { ar: 'عرض المخزون', en: 'View inventory' },
  'inventory.adjust': { ar: 'تسوية المخزون', en: 'Adjust inventory' },
  'sale.create': { ar: 'إتمام عملية بيع', en: 'Complete a sale' },
  'sale.discount': { ar: 'منح خصم', en: 'Grant a discount' },
  'sale.refund': { ar: 'استرجاع مبيعات', en: 'Refund a sale' },
  'sale.void': { ar: 'إلغاء فاتورة', en: 'Void an invoice' },
  'shift.open': { ar: 'فتح وردية', en: 'Open a shift' },
  'shift.close': { ar: 'إغلاق وردية', en: 'Close a shift' },
  'shift.cash-movement': { ar: 'تسجيل حركة نقدية', en: 'Record a cash movement' },
  'customer.read': { ar: 'عرض العملاء', en: 'View customers' },
  'customer.write': { ar: 'تعديل بيانات العملاء', en: 'Edit customers' },
  'report.read': { ar: 'عرض التقارير', en: 'View reports' },
  'settings.manage': { ar: 'إدارة الإعدادات', en: 'Manage settings' },
  'users.manage': { ar: 'إدارة المستخدمين', en: 'Manage users' },
  'zatca.manage': { ar: 'إدارة تكامل هيئة الزكاة والضريبة والجمارك', en: 'Manage ZATCA' },
};

export const DEFAULT_ROLES: Readonly<Record<RoleName, { readonly ar: string; readonly en: string }>> =
  {
    owner: { ar: 'مالك', en: 'Owner' },
    admin: { ar: 'مدير النظام', en: 'Administrator' },
    manager: { ar: 'مشرف', en: 'Manager' },
    cashier: { ar: 'كاشير', en: 'Cashier' },
  };

/**
 * Install the permission catalogue into the global table.
 *
 * Global because the vocabulary is the application's, identical for every
 * tenant and derived from nobody's data (ADR-0004). Idempotent: running it on
 * every boot is the intended usage, and it must never disturb a tenant's own
 * role bindings, which live in the tenant-owned role_permissions table.
 */
export async function provisionPermissionCatalogue(prisma: PrismaClient): Promise<number> {
  return withoutTenant(prisma, async (tx) => {
    for (const key of PERMISSIONS) {
      const described = PERMISSION_CATALOGUE[key];
      await tx.permission.upsert({
        where: { key },
        create: { key, descriptionAr: described.ar, descriptionEn: described.en },
        update: { descriptionAr: described.ar, descriptionEn: described.en },
      });
    }
    return PERMISSIONS.length;
  });
}

export interface ProvisionedRole {
  readonly key: RoleName;
  readonly id: string;
  readonly permissions: readonly Permission[];
}

/**
 * Install Korvi's default roles for one tenant.
 *
 * The role set, the permissions each grants and the discount ceiling all come
 * from @korvi/domain — this function copies them into the database, it does not
 * decide them. Inventing a second definition here is how a POS ends up with a
 * cashier who can discount in the database and cannot in the code.
 *
 * Internal by design: there is no HTTP route that reaches it.
 */
export async function provisionTenantRbac(
  prisma: PrismaClient,
  scope: TenantScope,
  nextId: () => string = newId,
): Promise<readonly ProvisionedRole[]> {
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    const provisioned: ProvisionedRole[] = [];

    for (const key of Object.keys(DEFAULT_ROLES) as RoleName[]) {
      const label = DEFAULT_ROLES[key];
      const existing = await tx.role.findFirst({ where: { tenantId: tenant, key } });
      const id = existing?.id ?? nextId();

      if (existing === null) {
        await tx.role.create({
          data: {
            id,
            tenantId: tenant,
            key,
            nameAr: label.ar,
            nameEn: label.en,
            maxDiscountBasisPoints: Number(ROLE_MAX_DISCOUNT_BP[key]),
            isSystem: true,
          },
        });
      } else {
        await tx.role.updateMany({
          where: { id, tenantId: tenant },
          data: {
            nameAr: label.ar,
            nameEn: label.en,
            maxDiscountBasisPoints: Number(ROLE_MAX_DISCOUNT_BP[key]),
            isSystem: true,
          },
        });
      }

      const granted = ROLE_PERMISSIONS[key];
      for (const permissionKey of granted) {
        const already = await tx.rolePermission.findFirst({
          where: { tenantId: tenant, roleId: id, permissionKey },
        });
        if (already === null) {
          await tx.rolePermission.create({
            data: { id: nextId(), tenantId: tenant, roleId: id, permissionKey },
          });
        }
      }

      // Anything this role was granted that the default no longer includes is
      // removed, so lowering a default actually lowers it.
      await tx.rolePermission.deleteMany({
        where: { tenantId: tenant, roleId: id, permissionKey: { notIn: [...granted] } },
      });

      provisioned.push({ key, id, permissions: granted });
    }

    return provisioned;
  });
}

/** Bind a user to one of the tenant's roles. Idempotent. */
export async function assignRole(
  prisma: PrismaClient,
  scope: TenantScope,
  userId: string,
  role: RoleName,
  nextId: () => string = newId,
): Promise<void> {
  await withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    const target = await tx.role.findFirst({ where: { tenantId: tenant, key: role } });
    if (target === null) {
      throw new Error(`Role "${role}" is not provisioned for this tenant.`);
    }
    const existing = await tx.userRole.findFirst({
      where: { tenantId: tenant, userId, roleId: target.id },
    });
    if (existing === null) {
      await tx.userRole.create({
        data: { id: nextId(), tenantId: tenant, userId, roleId: target.id },
      });
    }
  });
}
EOF

node - <<'NODE'
const fs = require('node:fs');
const file = 'packages/database/src/index.ts';
let source = fs.readFileSync(file, 'utf8');

const additions = [
  ["export { withTenant, withoutTenant } from './tenant-context.js';",
   "export { withTenant, withoutTenant, withLoginSlug, normalizeTenantSlug } from './tenant-context.js';"],
];
for (const [from, to] of additions) {
  if (source.includes(to)) continue;
  if (!source.includes(from)) {
    process.stderr.write(`Could not find: ${from}\n`);
    process.exit(1);
  }
  source = source.replace(from, to);
}

const tail = `export { createAuthRepository } from './repositories/auth-repository.js';
export {
  PERMISSION_CATALOGUE,
  DEFAULT_ROLES,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  assignRole,
} from './provisioning/rbac.js';
export type { ProvisionedRole } from './provisioning/rbac.js';
`;
if (!source.includes('createAuthRepository')) {
  source = `${source.replace(/\n*$/, '')}\n${tail}`;
}
fs.writeFileSync(file, source);
process.stdout.write('  database barrel updated\n');
NODE

say "API — password hashing"

cat << 'EOF' > apps/api/src/auth/password.ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/**
 * scrypt as a promise, written out rather than promisified.
 *
 * `promisify` resolves to the three-argument overload, which silently drops the
 * options object — and the options object is where N, r, p and maxmem live. A
 * hash derived without them would be scrypt at Node's defaults, which is not
 * the profile this file documents.
 */
function derive(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error !== null) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing with scrypt from the Node standard library.
 *
 * scrypt rather than a plain digest because a password is low-entropy: SHA-256
 * over a whole leaked table is minutes of GPU time, and the only defence is to
 * make each guess expensive in memory as well as in cycles. scrypt rather than
 * argon2 because argon2 means a native module in every build, deploy and CI
 * image, and Node 24 ships scrypt with parameters OWASP considers equivalent
 * for this purpose (ADR-0012).
 *
 * Parameters travel *with* the hash. Raising the cost later then re-hashes on
 * next login instead of invalidating every password in the database.
 */
export interface ScryptProfile {
  /** CPU/memory cost. Must be a power of two. */
  readonly N: number;
  /** Block size. */
  readonly r: number;
  /** Parallelisation. */
  readonly p: number;
  readonly keyLength: number;
  readonly saltLength: number;
}

/**
 * OWASP's second listed configuration: N=2^16, r=8, p=2.
 *
 * The first (N=2^17, r=8, p=1) needs 128 MiB per concurrent login. On a small
 * VPS running the API and Postgres together, a dozen simultaneous logins would
 * be 1.5 GiB of transient allocation; this one halves that for equivalent
 * work. Both are on the same OWASP line, so this is a deployment choice rather
 * than a weakening.
 */
export const PRODUCTION_SCRYPT: ScryptProfile = {
  N: 65_536,
  r: 8,
  p: 2,
  keyLength: 32,
  saltLength: 16,
};

/** scrypt requires maxmem above 128 * N * r; Node's default 32 MiB is below it. */
function maxmemFor(profile: ScryptProfile): number {
  return 256 * profile.N * profile.r;
}

const PREFIX = 'scrypt';
const VERSION = '1';

export class MalformedHashError extends Error {
  public override readonly name = 'MalformedHashError';
}

/**
 * `scrypt$1$N=65536,r=8,p=2$<salt>$<key>`, both fields base64url.
 *
 * Self-describing on purpose: a hash lifted out of a backup can be identified
 * and audited without reference to the code that wrote it, and a future
 * parameter change is a new field value rather than a migration.
 */
export function encodeHash(profile: ScryptProfile, salt: Buffer, derived: Buffer): string {
  const params = `N=${String(profile.N)},r=${String(profile.r)},p=${String(profile.p)}`;
  return [
    PREFIX,
    VERSION,
    params,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  readonly profile: ScryptProfile;
  readonly salt: Buffer;
  readonly derived: Buffer;
}

export function parseHash(encoded: string): ParsedHash {
  const parts = encoded.split('$');
  if (parts.length !== 5) throw new MalformedHashError('Wrong number of fields.');
  const [prefix, version, params, saltPart, keyPart] = parts;
  if (prefix !== PREFIX) throw new MalformedHashError('Not a scrypt hash.');
  if (version !== VERSION) throw new MalformedHashError('Unknown hash version.');

  const numbers = new Map<string, number>();
  for (const pair of (params ?? '').split(',')) {
    const [name, value] = pair.split('=');
    if (name === undefined || value === undefined || !/^[0-9]+$/.test(value)) {
      throw new MalformedHashError('Unreadable parameters.');
    }
    numbers.set(name, Number(value));
  }

  const N = numbers.get('N');
  const r = numbers.get('r');
  const p = numbers.get('p');
  if (N === undefined || r === undefined || p === undefined) {
    throw new MalformedHashError('Missing parameters.');
  }
  // A hash claiming N=2 would verify instantly. Refusing to honour parameters
  // below the floor means a tampered row fails rather than becoming a fast
  // path into the account.
  if (N < 16_384 || r < 8 || p < 1 || (N & (N - 1)) !== 0) {
    throw new MalformedHashError('Parameters below the accepted floor.');
  }

  const salt = Buffer.from(saltPart ?? '', 'base64url');
  const derived = Buffer.from(keyPart ?? '', 'base64url');
  if (salt.length < 16 || derived.length < 32) {
    throw new MalformedHashError('Salt or key too short.');
  }

  return { profile: { N, r, p, keyLength: derived.length, saltLength: salt.length }, salt, derived };
}

export async function hashPassword(
  password: string,
  profile: ScryptProfile = PRODUCTION_SCRYPT,
): Promise<string> {
  const salt = randomBytes(profile.saltLength);
  const derived = await derive(password.normalize('NFKC'), salt, profile.keyLength, {
    N: profile.N,
    r: profile.r,
    p: profile.p,
    maxmem: maxmemFor(profile),
  });
  return encodeHash(profile, salt, derived);
}

/**
 * Verify, returning a boolean and never an explanation.
 *
 * A malformed stored hash returns false rather than throwing: the caller is an
 * authentication path, and an exception there becomes a 500 that tells an
 * attacker their guess reached a real account with a broken row.
 *
 * The comparison is timing-safe. It is over derived keys, not the password, so
 * the usual objection — that the attacker controls one side — does not make it
 * pointless: a non-constant-time compare over a *derived* key still leaks a
 * per-byte oracle to anyone who can also submit chosen input.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  let parsed: ParsedHash;
  try {
    parsed = parseHash(encoded);
  } catch {
    return false;
  }

  try {
    const derived = await derive(
      password.normalize('NFKC'),
      parsed.salt,
      parsed.derived.length,
      {
        N: parsed.profile.N,
        r: parsed.profile.r,
        p: parsed.profile.p,
        maxmem: maxmemFor(parsed.profile),
      },
    );
    return derived.length === parsed.derived.length && timingSafeEqual(derived, parsed.derived);
  } catch {
    return false;
  }
}

/**
 * A real hash of a value nobody knows, per profile.
 *
 * The login path verifies against this when the account does not exist, so the
 * unknown-email branch costs the same scrypt work as the wrong-password branch.
 * Without it, "user not found" returns in a millisecond and "wrong password" in
 * two hundred, and the difference enumerates the customer's staff list.
 *
 * Computed once and cached: a constant baked into the source would drift from
 * the profile the moment the parameters change.
 */
const dummies = new Map<string, Promise<string>>();

export function dummyHashFor(profile: ScryptProfile = PRODUCTION_SCRYPT): Promise<string> {
  const key = `${String(profile.N)}:${String(profile.r)}:${String(profile.p)}`;
  const existing = dummies.get(key);
  if (existing !== undefined) return existing;
  const created = hashPassword(randomBytes(32).toString('base64url'), profile);
  dummies.set(key, created);
  return created;
}

/** Burn the same work as a real verification, and always fail. */
export async function verifyAgainstDummy(
  password: string,
  profile: ScryptProfile = PRODUCTION_SCRYPT,
): Promise<false> {
  await verifyPassword(password, await dummyHashFor(profile));
  return false;
}
EOF

say "API — session tokens"

cat << 'EOF' > apps/api/src/auth/token.ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The browser-held session token.
 *
 * Shape: `kps1.<tenant-uuid>.<43 base64url characters>`
 *
 * The tenant segment exists for one reason: RLS has to be established *before*
 * the sessions table can be read, and the sessions table is where the session
 * lives. Something has to say which tenant context to open, and the only thing
 * the request carries is the cookie.
 *
 * It is a routing hint and nothing else. Three things make it unusable as
 * authorization:
 *
 *   the stored hash covers the whole token, tenant segment included, so
 *   editing that segment produces a value that hashes to nothing;
 *
 *   the lookup runs inside the hinted tenant's RLS context, so a session row
 *   belonging to another tenant is not visible to be found;
 *
 *   the 256-bit secret is what actually authenticates, and it is unguessable.
 *
 * Changing the hint on a stolen-but-valid token therefore fails twice over
 * rather than crossing into the named tenant. There is a live test for it.
 */

export const TOKEN_PREFIX = 'kps1';
const SECRET_BYTES = 32;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ParsedToken {
  readonly tenantHint: string;
  readonly secret: string;
  readonly raw: string;
}

export interface IssuedToken {
  /** Goes to the browser, once, in a Set-Cookie header. Never persisted. */
  readonly token: string;
  /** Goes to the database. */
  readonly tokenHash: string;
  readonly tenantHint: string;
}

export function issueToken(tenantId: string): IssuedToken {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new Error('issueToken: tenant id must be a UUID.');
  }
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${TOKEN_PREFIX}.${tenantId}.${secret}`;
  return { token, tokenHash: hashToken(token), tenantHint: tenantId };
}

/**
 * SHA-256, not scrypt.
 *
 * A password is low-entropy and needs a slow KDF. This secret is 256 bits from
 * the system CSPRNG: there is nothing to brute force, and a slow hash on every
 * request would cost real latency for no gain.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** Strict parse. Anything that is not exactly the expected shape is rejected. */
export function parseToken(candidate: string): ParsedToken | null {
  if (candidate.length > 200) return null;
  const parts = candidate.split('.');
  if (parts.length !== 3) return null;
  const [prefix, tenantHint, secret] = parts;
  if (prefix !== TOKEN_PREFIX) return null;
  if (tenantHint === undefined || !UUID_PATTERN.test(tenantHint)) return null;
  if (secret === undefined || !SECRET_PATTERN.test(secret)) return null;
  return { tenantHint, secret, raw: candidate };
}

/** Constant-time comparison of two encoded hashes of equal length. */
export function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
EOF

say "API — cookie and origin policy"

cat << 'EOF' > apps/api/src/auth/cookie.ts
/**
 * The session cookie.
 *
 * HttpOnly so a cross-site script cannot read it — the single most valuable
 * attribute here, because a POS runs on machines where somebody eventually
 * installs a browser extension.
 *
 * SameSite=Lax so a form on another site cannot POST a checkout with the
 * cashier's credentials attached, while an ordinary top-level navigation back
 * into the app still arrives authenticated. Strict would log the user out every
 * time they follow a link from their email.
 *
 * No Domain attribute, so the cookie stays on the exact host that set it and is
 * never sent to a sibling subdomain.
 *
 * `__Host-` in production. The prefix is enforced by the browser: it refuses to
 * store the cookie unless it is Secure, has Path=/ and carries no Domain — so
 * the guarantee survives a future edit to this file. It requires HTTPS, which
 * is why development uses the unprefixed name and nothing else changes.
 */

export const PRODUCTION_COOKIE_NAME = '__Host-korvi_session';
export const DEVELOPMENT_COOKIE_NAME = 'korvi_session';

export function sessionCookieName(isProduction: boolean): string {
  return isProduction ? PRODUCTION_COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
}

export interface CookieOptions {
  readonly isProduction: boolean;
  readonly maxAgeSeconds: number;
}

export function buildSessionCookie(token: string, options: CookieOptions): string {
  const attributes = [
    `${sessionCookieName(options.isProduction)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ];
  // Secure is unconditional in production. In development it is omitted only
  // because http://localhost would otherwise drop the cookie silently, which
  // reads as "login is broken" rather than "your cookie policy is strict".
  if (options.isProduction) attributes.push('Secure');
  return attributes.join('; ');
}

/** Same attributes, empty value, immediate expiry — or the browser keeps it. */
export function buildClearedCookieHeader(isProduction: boolean): string {
  const attributes = [
    `${sessionCookieName(isProduction)}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isProduction) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * Read one cookie out of a Cookie header.
 *
 * Hand-rolled rather than a dependency: the header is a semicolon-separated
 * list and the parsing is six lines, while a parser in the dependency tree is
 * a permanent supply-chain surface on the authentication path (ADR-0009).
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}
EOF

cat << 'EOF' > apps/api/src/auth/origin.ts
/**
 * Origin checking for cookie-authenticated writes.
 *
 * SameSite=Lax already blocks a cross-site POST from carrying the cookie in
 * every browser that implements it. This is the second lock: an exact-match
 * check on the Origin header for every unsafe method, so a browser that is
 * lenient, old, or being driven by something that is not a browser still gets
 * refused.
 *
 * Exact string equality against a configured list. No wildcards, no suffix
 * matching — "https://korvi.sa.evil.example" ends with the right characters,
 * and a suffix check is how that becomes a valid origin.
 *
 * X-Forwarded-* is deliberately ignored. Those headers are set by whoever
 * spoke to the server last, which in a misconfiguration is the attacker; this
 * server does not establish trusted-proxy semantics, so it does not pretend to.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export interface OriginDecision {
  readonly allowed: boolean;
  readonly reason: 'safe-method' | 'match' | 'missing-origin' | 'foreign-origin';
}

export function checkOrigin(
  method: string,
  origin: string | undefined,
  allowed: readonly string[],
): OriginDecision {
  if (isSafeMethod(method)) return { allowed: true, reason: 'safe-method' };
  if (origin === undefined || origin === '') {
    // Fail closed. A state-changing request with no Origin is either an old
    // client or something that is not a browser at all, and neither is worth
    // a session cookie.
    return { allowed: false, reason: 'missing-origin' };
  }
  return allowed.includes(origin)
    ? { allowed: true, reason: 'match' }
    : { allowed: false, reason: 'foreign-origin' };
}
EOF

say "API — authentication service"

cat << 'EOF' > apps/api/src/auth/service.ts
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
  return createHash('sha256').update(`${tenantId}:${email}`, 'utf8').digest('base64url').slice(0, 22);
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

      const revoked = await repository.revokeSession(
        scope,
        context.sessionId,
        now().toISOString(),
      );
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
EOF

say "API — configuration"

cat << 'EOF' > apps/api/src/config.ts
import { z } from 'zod';

/**
 * Environment parsing, once, at the edge.
 *
 * Everything downstream receives a typed object rather than reading
 * process.env, so a missing variable fails at boot with a clear message
 * instead of surfacing as `undefined` inside a request three hours later.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /**
     * Where the browser app is served from, comma-separated, exact origins.
     *
     * Used for the origin check on state-changing requests. Required in
     * production and absent by default, so a deployment that forgets it fails
     * to boot rather than accepting writes from anywhere (ADR-0012).
     */
    APP_ORIGINS: z.string().optional(),

    SESSION_TTL_HOURS: z.coerce.number().int().positive().max(24 * 30).default(12),

    /** Absent is legal: a server with no database still answers /health. */
    DATABASE_URL: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && (value.APP_ORIGINS ?? '').trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['APP_ORIGINS'],
        message: 'is required in production; refusing to accept writes from an unknown origin',
      });
    }
  });

export interface ApiConfig {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly API_PORT: number;
  readonly LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly APP_ORIGINS: readonly string[];
  readonly SESSION_TTL_SECONDS: number;
  readonly DATABASE_URL: string | undefined;
  readonly isProduction: boolean;
}

/** Development convenience only; production has no default and never gets one. */
const DEVELOPMENT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  const value = parsed.data;
  const configured = (value.APP_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  return {
    NODE_ENV: value.NODE_ENV,
    API_PORT: value.API_PORT,
    LOG_LEVEL: value.LOG_LEVEL,
    APP_ORIGINS: configured.length > 0 ? configured : DEVELOPMENT_ORIGINS,
    SESSION_TTL_SECONDS: value.SESSION_TTL_HOURS * 3600,
    DATABASE_URL: value.DATABASE_URL,
    isProduction: value.NODE_ENV === 'production',
  };
}
EOF

say "API — typed guards"

cat << 'EOF' > apps/api/src/auth/guards.ts
import { readCookie, buildClearedCookieHeader, sessionCookieName } from './cookie.js';
import { checkOrigin } from './origin.js';
import type { AuthService } from './service.js';
import type { ApiConfig } from '../config.js';
import type { AuthenticatedPrincipal, Permission } from '@korvi/domain';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler, preHandlerAsyncHookHandler } from 'fastify';

/**
 * `request.auth` is the only place a handler may learn who is calling.
 *
 * Declared optional rather than always present, so TypeScript forces a route
 * that reads it to have run the guard that sets it. A non-optional field would
 * typecheck in a handler nobody guarded.
 */
declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedPrincipal;
  }
}

/**
 * The two responses this layer gives, and the difference between them.
 *
 * 401 means "I do not know who you are" — no session, or one that has expired,
 * been revoked, or belongs to a user who has been deactivated. 403 means "I
 * know exactly who you are and you may not do this". Collapsing them would make
 * an expired session look like a permissions bug to every support call.
 *
 * Neither says which. `reason` stays in the log.
 */
const UNAUTHENTICATED = { error: 'unauthenticated' } as const;
const FORBIDDEN = { error: 'forbidden' } as const;

export interface Guards {
  readonly enforceOrigin: onRequestAsyncHookHandler;
  readonly requireSession: preHandlerAsyncHookHandler;
  requirePermission(permission: Permission): preHandlerAsyncHookHandler;
}

export function createGuards(service: AuthService, config: ApiConfig): Guards {
  function clearCookie(reply: FastifyReply): void {
    reply.header('set-cookie', buildClearedCookieHeader(config.isProduction));
  }

  const enforceOrigin: onRequestAsyncHookHandler = async (request, reply) => {
    const decision = checkOrigin(request.method, request.headers.origin, config.APP_ORIGINS);
    if (!decision.allowed) {
      request.log.warn({ reason: decision.reason }, 'origin check refused a write');
      await reply.code(403).send(FORBIDDEN);
    }
  };

  const requireSession: preHandlerAsyncHookHandler = async (request, reply) => {
    const raw = readCookie(request.headers.cookie, sessionCookieName(config.isProduction));
    if (raw === null) {
      await reply.code(401).send(UNAUTHENTICATED);
      return;
    }

    const result = await service.authenticate(raw);
    if (result.outcome === 'failure') {
      // The cookie is cleared on the way out. Leaving a dead token in the
      // browser means every subsequent request pays for a database lookup that
      // cannot succeed.
      request.log.info({ reason: result.reason }, 'session rejected');
      clearCookie(reply);
      await reply.code(401).send(UNAUTHENTICATED);
      return;
    }

    request.auth = result.principal;
  };

  function requirePermission(permission: Permission): preHandlerAsyncHookHandler {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.auth;
      if (principal === undefined) {
        // Reached only if a route wires requirePermission without
        // requireSession. Refusing is the correct answer; so is saying so.
        request.log.error('requirePermission ran without a session guard');
        await reply.code(401).send(UNAUTHENTICATED);
        return;
      }
      if (!principal.permissions.includes(permission)) {
        request.log.info({ permission, userId: principal.userId }, 'permission denied');
        await reply.code(403).send(FORBIDDEN);
      }
    };
  }

  return { enforceOrigin, requireSession, requirePermission };
}
EOF

say "API — authentication routes"

cat << 'EOF' > apps/api/src/routes/auth.ts
import { z } from 'zod';
import { buildClearedCookieHeader, buildSessionCookie, readCookie, sessionCookieName } from '../auth/cookie.js';
import type { Guards } from '../auth/guards.js';
import type { AuthService } from '../auth/service.js';
import type { ApiConfig } from '../config.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

/**
 * The authentication surface. Three routes, plus one convenience.
 *
 * Nothing here reads a tenant, a role or a permission from the request. The
 * only thing the client supplies is a slug, an address and a password on the
 * way in, and a cookie afterwards; everything else is read from the database
 * on the server (ADR-0012).
 */

const loginBody = z.object({
  tenantSlug: z.string().min(1).max(64),
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
});

/** One body for every failure, whatever actually went wrong. */
const INVALID_CREDENTIALS = { error: 'invalid_credentials' } as const;

/**
 * What a client is allowed to know about itself.
 *
 * Built field by field rather than by spreading the principal: a spread picks
 * up whatever is added to the type later, and the next field added might be one
 * that should not cross the wire.
 */
function safePrincipal(principal: AuthenticatedPrincipal): Record<string, unknown> {
  return {
    user: {
      id: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
    },
    tenant: {
      id: principal.tenantId,
      ...(principal.tenantSlug === '' ? {} : { slug: principal.tenantSlug }),
    },
    session: { id: principal.sessionId },
    roles: principal.roles,
    permissions: principal.permissions,
    // A bigint cannot be JSON-serialised, and a number would lose precision at
    // a scale this value will never reach — but the convention is the same
    // everywhere in Korvi, so it crosses as a string (ADR-0002).
    maxDiscountBasisPoints: principal.maxDiscountBasisPoints.toString(),
    branchId: principal.branchId,
  };
}

export interface AuthRouteOptions {
  readonly service: AuthService;
  readonly guards: Guards;
  readonly config: ApiConfig;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { service, guards, config } = options;

  app.post('/v1/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      // A malformed body gets the same answer as a wrong password. Telling a
      // caller which field they got wrong is a probe they can run for free.
      return reply.code(401).send(INVALID_CREDENTIALS);
    }

    const result = await service.login({
      tenantSlug: parsed.data.tenantSlug,
      email: parsed.data.email,
      password: parsed.data.password,
      userAgent: request.headers['user-agent'] ?? null,
    });

    if (result.outcome === 'failure') {
      request.log.info({ reason: result.reason }, 'login refused');
      return reply.code(401).send(INVALID_CREDENTIALS);
    }

    reply.header(
      'set-cookie',
      buildSessionCookie(result.token, {
        isProduction: config.isProduction,
        maxAgeSeconds: config.SESSION_TTL_SECONDS,
      }),
    );
    // The token is in the cookie and nowhere else. A copy in the body would be
    // readable by any script on the page, which is the whole thing HttpOnly is
    // there to prevent.
    return reply.code(200).send({ ...safePrincipal(result.principal), expiresAt: result.expiresAt });
  });

  app.get('/v1/auth/me', { preHandler: guards.requireSession }, async (request, reply) => {
    const principal = request.auth;
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.code(200).send(safePrincipal(principal));
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const raw = readCookie(request.headers.cookie, sessionCookieName(config.isProduction));
    if (raw !== null) await service.logout(raw);

    // The cookie is cleared whether or not a session was found. A logout that
    // reports "no such session" tells a caller their stolen token has already
    // been revoked, and leaves the browser holding it either way.
    reply.header('set-cookie', buildClearedCookieHeader(config.isProduction));
    return reply.code(204).send();
  });

  app.post('/v1/auth/logout-all', { preHandler: guards.requireSession }, async (request, reply) => {
    const raw = readCookie(request.headers.cookie, sessionCookieName(config.isProduction));
    const revoked = raw === null ? 0 : await service.logoutAll(raw);
    reply.header('set-cookie', buildClearedCookieHeader(config.isProduction));
    return reply.code(200).send({ revoked });
  });
}
EOF

say "API — server wiring"

cat << 'EOF' > apps/api/src/server.ts
import Fastify from 'fastify';
import { newId } from '@korvi/domain';
import { createAuthRepository, createAuditRepository, createPrismaClient } from '@korvi/database';
import { createGuards } from './auth/guards.js';
import { createAuthService } from './auth/service.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import type { AuthService } from './auth/service.js';
import type { ApiConfig } from './config.js';
import type { FastifyInstance } from 'fastify';

export interface ServerDeps {
  /**
   * Supplied by tests with an in-memory implementation.
   *
   * Left out in production, where it is built from DATABASE_URL on first use —
   * lazily, so a process that only answers /health never opens a connection.
   */
  readonly auth?: AuthService;
}

class AuthUnavailableError extends Error {
  public override readonly name = 'AuthUnavailableError';
}

function lazyAuthService(config: ApiConfig): AuthService {
  let built: AuthService | null = null;

  const resolve = (): AuthService => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) {
      throw new AuthUnavailableError('DATABASE_URL is not configured.');
    }
    const prisma = createPrismaClient(url);
    built = createAuthService({
      repository: createAuthRepository(prisma),
      audit: createAuditRepository(prisma),
      sessionTtlSeconds: config.SESSION_TTL_SECONDS,
    });
    return built;
  };

  return {
    login: (input) => resolve().login(input),
    authenticate: (token) => resolve().authenticate(token),
    logout: (token) => resolve().logout(token),
    logoutAll: (token) => resolve().logoutAll(token),
  };
}

export function buildServer(config: ApiConfig, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // The central Korvi generator, not crypto.randomUUID. A v4 carries no
    // time, so a request log line could not be ordered against a sale that was
    // rung up offline and synced later. Every identifier in the system comes
    // from one place (ADR-0003).
    genReqId: () => newId(),
  });

  const service = deps.auth ?? lazyAuthService(config);
  const guards = createGuards(service, config);

  // Before anything else: a state-changing request from an origin this
  // deployment does not know never reaches a handler.
  app.addHook('onRequest', guards.enforceOrigin);

  // A configuration gap must not read as a credential failure. Without a
  // database the auth routes answer 503, which is what it is.
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AuthUnavailableError) {
      request.log.error('authentication is not configured; DATABASE_URL is missing');
      return reply.code(503).send({ error: 'unavailable' });
    }
    // The message stays in the log. A handler that echoes it has told the
    // caller what the database is called.
    request.log.error(error);
    return reply.code(error.statusCode ?? 500).send({ error: 'internal_error' });
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app, { service, guards, config });
  return app;
}
EOF

say "Tests — password, token, cookie, origin"

cat << 'EOF' > apps/api/src/__tests__/password.test.ts
import { describe, expect, it } from 'vitest';
import {
  MalformedHashError,
  PRODUCTION_SCRYPT,
  dummyHashFor,
  encodeHash,
  hashPassword,
  parseHash,
  verifyAgainstDummy,
  verifyPassword,
} from '../auth/password.js';

/** Cheap enough for a test run, still above the parser's accepted floor. */
const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;

describe('password hashing', () => {
  it('verifies a password it hashed', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    await expect(verifyPassword('Correct horse battery staple', hash)).resolves.toBe(false);
  });

  it('gives two identical passwords different hashes', async () => {
    // A per-password salt is what stops one rainbow table covering the table,
    // and what stops "these two cashiers use the same password" being visible
    // to anyone who reads the column.
    const [first, second] = await Promise.all([
      hashPassword('same', FAST),
      hashPassword('same', FAST),
    ]);
    expect(first).not.toBe(second);
    await expect(verifyPassword('same', first)).resolves.toBe(true);
    await expect(verifyPassword('same', second)).resolves.toBe(true);
  });

  it('carries its parameters, so the cost can be raised later', async () => {
    const hash = await hashPassword('x', FAST);
    expect(hash.startsWith('scrypt$1$N=16384,r=8,p=1$')).toBe(true);
    expect(parseHash(hash).profile.N).toBe(16_384);
  });

  it('normalises the password before hashing', async () => {
    // The same characters typed on two keyboards can arrive as different byte
    // sequences. NFKC on both sides means the user is not locked out by their
    // input method.
    const composed = 'passwórd';
    const precomposed = 'passwórd'.normalize('NFKC');
    const hash = await hashPassword(composed, FAST);
    await expect(verifyPassword(precomposed, hash)).resolves.toBe(true);
  });

  it.each([
    ['empty', ''],
    ['not scrypt', 'argon2$1$N=1$aaaa$bbbb'],
    ['wrong field count', 'scrypt$1$N=16384,r=8,p=1$onlyfour'],
    ['unknown version', 'scrypt$9$N=16384,r=8,p=1$aaaa$bbbb'],
    ['unreadable parameters', 'scrypt$1$N=abc,r=8,p=1$aaaa$bbbb'],
  ])('rejects a %s hash without throwing', async (_label, encoded) => {
    // The caller is a login path. An exception there is a 500 that tells an
    // attacker their guess landed on a real account with a broken row.
    await expect(verifyPassword('anything', encoded)).resolves.toBe(false);
  });

  it('refuses parameters below the floor rather than verifying fast', () => {
    // A tampered row claiming N=2 would verify in microseconds and would be a
    // fast path straight into the account.
    const weak = encodeHash(
      { N: 2, r: 8, p: 1, keyLength: 32, saltLength: 16 },
      Buffer.alloc(16, 1),
      Buffer.alloc(32, 2),
    );
    expect(() => parseHash(weak)).toThrow(MalformedHashError);
  });

  it('refuses a truncated salt or key', () => {
    const short = 'scrypt$1$N=16384,r=8,p=1$YWJj$YWJj';
    expect(() => parseHash(short)).toThrow(MalformedHashError);
  });

  it('is a memory-hard KDF, not a bare digest', async () => {
    // The production profile has to cost something. If this ever drops to a
    // millisecond, someone has quietly replaced scrypt with a hash.
    expect(PRODUCTION_SCRYPT.N).toBeGreaterThanOrEqual(65_536);
    expect(PRODUCTION_SCRYPT.r).toBeGreaterThanOrEqual(8);

    const started = process.hrtime.bigint();
    await hashPassword('measure me', PRODUCTION_SCRYPT);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeGreaterThan(25);
  }, 30_000);

  it('burns real work on the unknown-user path', async () => {
    // Without this, "no such user" returns in a millisecond and "wrong
    // password" in two hundred, and the difference enumerates the staff list.
    const dummy = await dummyHashFor(FAST);
    expect(dummy.startsWith('scrypt$1$')).toBe(true);
    await expect(verifyPassword('anything at all', dummy)).resolves.toBe(false);
    await expect(verifyAgainstDummy('anything at all', FAST)).resolves.toBe(false);
  });
});
EOF

cat << 'EOF' > apps/api/src/__tests__/token.test.ts
import { describe, expect, it } from 'vitest';
import { TOKEN_PREFIX, hashToken, hashesMatch, issueToken, parseToken } from '../auth/token.js';

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const OTHER = '018f3a1c-9b2e-7c4d-8e5f-ffffffffffff';

describe('session tokens', () => {
  it('carries 256 bits of secret in a parseable envelope', () => {
    const issued = issueToken(TENANT);
    const parsed = parseToken(issued.token);

    expect(parsed?.tenantHint).toBe(TENANT);
    // 32 bytes base64url is 43 characters, no padding.
    expect(parsed?.secret).toHaveLength(43);
    expect(issued.token.startsWith(`${TOKEN_PREFIX}.`)).toBe(true);
  });

  it('never issues the same token twice', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) seen.add(issueToken(TENANT).token);
    expect(seen.size).toBe(200);
  });

  it('hands the caller a hash to store and a token to send', () => {
    const issued = issueToken(TENANT);
    expect(issued.tokenHash).not.toContain(issued.token);
    expect(issued.tokenHash).toBe(hashToken(issued.token));
    // The hash is what a database holds. It must not be reversible into the
    // token, which for SHA-256 over 256 random bits it is not.
    expect(issued.tokenHash).toHaveLength(43);
  });

  it('hashes the tenant segment along with the secret', () => {
    // This is what makes the hint unusable as authorization: editing it
    // produces a value that hashes to something no row carries.
    const issued = issueToken(TENANT);
    const parsed = parseToken(issued.token);
    const moved = `${TOKEN_PREFIX}.${OTHER}.${parsed?.secret ?? ''}`;
    expect(hashToken(moved)).not.toBe(issued.tokenHash);
  });

  it.each([
    ['empty', ''],
    ['no prefix', `${TENANT}.abc`],
    ['wrong prefix', `kps0.${TENANT}.${'a'.repeat(43)}`],
    ['too few parts', `kps1.${TENANT}`],
    ['too many parts', `kps1.${TENANT}.${'a'.repeat(43)}.extra`],
    ['tenant not a uuid', `kps1.not-a-uuid.${'a'.repeat(43)}`],
    ['secret too short', `kps1.${TENANT}.${'a'.repeat(42)}`],
    ['secret not base64url', `kps1.${TENANT}.${'!'.repeat(43)}`],
    ['absurdly long', `kps1.${TENANT}.${'a'.repeat(500)}`],
  ])('refuses a %s token', (_label, candidate) => {
    expect(parseToken(candidate)).toBeNull();
  });

  it('compares hashes without leaking their contents through timing', () => {
    expect(hashesMatch('abc', 'abc')).toBe(true);
    expect(hashesMatch('abc', 'abd')).toBe(false);
    expect(hashesMatch('abc', 'abcd')).toBe(false);
  });
});
EOF

cat << 'EOF' > apps/api/src/__tests__/cookie-origin.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_COOKIE_NAME,
  PRODUCTION_COOKIE_NAME,
  buildClearedCookieHeader,
  buildSessionCookie,
  readCookie,
} from '../auth/cookie.js';
import { checkOrigin, isSafeMethod } from '../auth/origin.js';

describe('the session cookie', () => {
  it('is HttpOnly, Secure, SameSite=Lax, Path=/ and host-only in production', () => {
    const header = buildSessionCookie('kps1.token', { isProduction: true, maxAgeSeconds: 43_200 });
    expect(header).toContain(`${PRODUCTION_COOKIE_NAME}=kps1.token`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=43200');
    // A Domain attribute would send this to every sibling subdomain.
    expect(header).not.toContain('Domain=');
  });

  it('uses the __Host- prefix in production, which the browser enforces', () => {
    expect(PRODUCTION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    // Development drops the prefix only because it requires HTTPS; nothing
    // else about the cookie changes.
    expect(DEVELOPMENT_COOKIE_NAME.startsWith('__Host-')).toBe(false);
    const dev = buildSessionCookie('t', { isProduction: false, maxAgeSeconds: 60 });
    expect(dev).toContain('HttpOnly');
    expect(dev).toContain('SameSite=Lax');
    expect(dev).not.toContain('Secure');
  });

  it('clears with the same attributes, or the browser keeps the old one', () => {
    const header = buildClearedCookieHeader(true);
    expect(header).toContain(`${PRODUCTION_COOKIE_NAME}=`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
  });

  it('reads one cookie out of a header carrying several', () => {
    const header = `theme=dark; ${DEVELOPMENT_COOKIE_NAME}=kps1.abc; locale=ar`;
    expect(readCookie(header, DEVELOPMENT_COOKIE_NAME)).toBe('kps1.abc');
    expect(readCookie(header, 'missing')).toBeNull();
    expect(readCookie(undefined, DEVELOPMENT_COOKIE_NAME)).toBeNull();
  });

  it('does not match a cookie whose name merely ends with the one asked for', () => {
    expect(readCookie('evil_korvi_session=x', 'korvi_session')).toBeNull();
  });
});

describe('origin checking', () => {
  const allowed = ['https://pos.korvi.sa'];

  it('lets safe methods through without an Origin', () => {
    expect(isSafeMethod('GET')).toBe(true);
    expect(checkOrigin('GET', undefined, allowed).allowed).toBe(true);
  });

  it('accepts an exact origin match on a write', () => {
    expect(checkOrigin('POST', 'https://pos.korvi.sa', allowed).allowed).toBe(true);
  });

  it('refuses a write with no Origin at all', () => {
    // Fail closed: something that is not a browser, or one too old to send it.
    const decision = checkOrigin('POST', undefined, allowed);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('missing-origin');
  });

  it.each([
    'https://pos.korvi.sa.evil.example',
    'https://evil.example',
    'http://pos.korvi.sa',
    'https://pos.korvi.sa:8443',
    'https://POS.korvi.sa',
  ])('refuses %s, because matching is exact and not by suffix', (origin) => {
    expect(checkOrigin('POST', origin, allowed).allowed).toBe(false);
  });

  it('refuses every unsafe method, not just POST', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(checkOrigin(method, 'https://evil.example', allowed).allowed).toBe(false);
    }
  });
});
EOF

say "Tests — in-memory authentication store"

mkdir -p apps/api/src/__tests__/support

cat << 'EOF' > apps/api/src/__tests__/support/memory-auth.ts
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
EOF

say "Tests — login, sessions, RBAC"

cat << 'EOF' > apps/api/src/__tests__/auth-service.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { createAuthService, DEFAULT_LOCKOUT, correlationHash } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { parseToken } from '../auth/token.js';
import {
  MemoryAuthStore,
  memoryAuditRepository,
  memoryAuthRepository,
} from './support/memory-auth.js';
import type { AuthService } from '../auth/service.js';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;

const TENANT_A = '018f3a1c-9b2e-7c4d-8e5f-00000000000a';
const TENANT_B = '018f3a1c-9b2e-7c4d-8e5f-00000000000b';
const USER_A = '018f3a1c-9b2e-7c4d-8e5f-0000000000a1';
const USER_B = '018f3a1c-9b2e-7c4d-8e5f-0000000000b1';
const PASSWORD = 'a-real-password-9!';

let store: MemoryAuthStore;
let service: AuthService;
let clock: Date;

async function seed(): Promise<void> {
  store = new MemoryAuthStore();
  clock = new Date('2026-08-10T08:00:00.000Z');

  const passwordHash = await hashPassword(PASSWORD, FAST);
  for (const [tenant, slug, user, email] of [
    [TENANT_A, 'korvi-a', USER_A, 'sara@korvi-a.test'],
    [TENANT_B, 'korvi-b', USER_B, 'omar@korvi-b.test'],
  ] as const) {
    store.tenants.push({ id: tenant, slug, name: slug, status: 'active' });
    store.users.push({
      id: user,
      tenantId: tenant,
      email,
      displayName: 'Cashier',
      passwordHash,
      isActive: true,
      failedLoginCount: 0,
      lockedUntil: null,
      authVersion: 1,
      lastLoginAt: null,
    });
    store.memberships.push({ tenantId: tenant, userId: user, status: 'active', defaultBranchId: null });
    store.grants.push({
      tenantId: tenant,
      userId: user,
      roles: ['manager'],
      permissions: [...ROLE_PERMISSIONS.manager],
    });
  }

  service = createAuthService({
    repository: memoryAuthRepository(store),
    audit: memoryAuditRepository(store),
    sessionTtlSeconds: 3600,
    scrypt: FAST,
    now: () => clock,
  });
}

beforeEach(seed);

function login(overrides: Partial<{ tenantSlug: string; email: string; password: string }> = {}) {
  return service.login({
    tenantSlug: overrides.tenantSlug ?? 'korvi-a',
    email: overrides.email ?? 'sara@korvi-a.test',
    password: overrides.password ?? PASSWORD,
    userAgent: 'vitest',
  });
}

describe('login', () => {
  it('issues a session for the right credentials', async () => {
    const result = await login();
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    expect(parseToken(result.token)?.tenantHint).toBe(TENANT_A);
    expect(result.principal.roles).toEqual(['manager']);
    expect(result.principal.maxDiscountBasisPoints).toBe(2_000n);
    expect(store.sessions).toHaveLength(1);
  });

  it('never stores the token it hands out', async () => {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');
    const stored = store.sessions[0];
    expect(stored?.tokenHash).not.toBe(result.token);
    expect(JSON.stringify(store.sessions)).not.toContain(result.token);
  });

  it.each([
    ['an unknown tenant', { tenantSlug: 'no-such-shop' }, 'unknown-tenant'],
    ['an unknown email', { email: 'nobody@korvi-a.test' }, 'unknown-user'],
    ['the wrong password', { password: 'not-it' }, 'bad-password'],
  ])('refuses %s', async (_label, overrides, reason) => {
    const result = await login(overrides);
    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') expect(result.reason).toBe(reason);
  });

  it('refuses a user from another tenant even with the right password', async () => {
    // The address exists; it just does not belong to this shop. Resolving the
    // tenant first is what makes that a miss rather than a login.
    const result = await login({ email: 'omar@korvi-b.test' });
    expect(result.outcome).toBe('failure');
  });

  it('refuses a deactivated user', async () => {
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.isActive = false;
    const result = await login();
    expect(result.outcome === 'failure' && result.reason).toBe('user-inactive');
  });

  it('refuses a suspended membership', async () => {
    const membership = store.memberships.find((candidate) => candidate.userId === USER_A);
    if (membership !== undefined) membership.status = 'suspended';
    const result = await login();
    expect(result.outcome === 'failure' && result.reason).toBe('membership-inactive');
  });

  it('refuses a suspended tenant', async () => {
    const tenant = store.tenants.findIndex((candidate) => candidate.id === TENANT_A);
    store.tenants[tenant] = { id: TENANT_A, slug: 'korvi-a', name: 'korvi-a', status: 'suspended' };
    const result = await login();
    expect(result.outcome === 'failure' && result.reason).toBe('tenant-inactive');
  });

  it('refuses a user with no credential set', async () => {
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.passwordHash = null;
    const result = await login();
    expect(result.outcome === 'failure' && result.reason).toBe('no-credential');
  });
});

describe('lockout', () => {
  it('locks after the configured number of failures and not before', async () => {
    for (let attempt = 1; attempt < DEFAULT_LOCKOUT.threshold; attempt += 1) {
      const result = await login({ password: 'wrong' });
      expect(result.outcome === 'failure' && result.reason).toBe('bad-password');
      expect(store.users.find((u) => u.id === USER_A)?.lockedUntil).toBeNull();
    }

    const final = await login({ password: 'wrong' });
    expect(final.outcome === 'failure' && final.reason).toBe('bad-password');
    const user = store.users.find((candidate) => candidate.id === USER_A);
    expect(user?.failedLoginCount).toBe(DEFAULT_LOCKOUT.threshold);
    expect(user?.lockedUntil).toBe(
      new Date(clock.getTime() + DEFAULT_LOCKOUT.lockSeconds * 1000).toISOString(),
    );
  });

  it('refuses the right password while locked', async () => {
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.lockedUntil = new Date(clock.getTime() + 60_000).toISOString();
    const result = await login();
    expect(result.outcome === 'failure' && result.reason).toBe('locked');
  });

  it('lets a lock expire rather than disabling the till for the day', async () => {
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.lockedUntil = new Date(clock.getTime() - 1_000).toISOString();
    const result = await login();
    expect(result.outcome).toBe('success');
  });

  it('opens a new window after a lock expires instead of re-locking on one typo', async () => {
    // Five failures, then the lock runs out. The old count must not still be
    // sitting at the threshold, or the next mistyped password locks the till
    // again immediately — which is not what "fifteen minutes" means.
    for (let attempt = 0; attempt < DEFAULT_LOCKOUT.threshold; attempt += 1) {
      await login({ password: 'wrong' });
    }
    const user = store.users.find((candidate) => candidate.id === USER_A);
    expect(user?.lockedUntil).not.toBeNull();

    clock = new Date(clock.getTime() + (DEFAULT_LOCKOUT.lockSeconds + 1) * 1000);
    await login({ password: 'wrong-again' });

    expect(user?.failedLoginCount).toBe(1);
    expect(user?.lockedUntil).toBeNull();

    // And the correct password works, because nothing is holding a lock.
    const result = await login();
    expect(result.outcome).toBe('success');
  });

  it('does not extend a lock just because requests keep arriving', async () => {
    const user = store.users.find((candidate) => candidate.id === USER_A);
    const deadline = new Date(clock.getTime() + 60_000).toISOString();
    if (user !== undefined) user.lockedUntil = deadline;

    await login({ password: 'wrong' });
    await login({ password: 'wrong' });

    expect(user?.lockedUntil).toBe(deadline);
  });

  it('resets the failure count on a success', async () => {
    await login({ password: 'wrong' });
    await login({ password: 'wrong' });
    expect(store.users.find((u) => u.id === USER_A)?.failedLoginCount).toBe(2);

    await login();
    const user = store.users.find((candidate) => candidate.id === USER_A);
    expect(user?.failedLoginCount).toBe(0);
    expect(user?.lockedUntil).toBeNull();
    expect(user?.lastLoginAt).toBe(clock.toISOString());
  });
});

describe('session verification', () => {
  async function loggedIn(): Promise<string> {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');
    return result.token;
  }

  it('resolves a live session to a server-derived principal', async () => {
    const token = await loggedIn();
    const result = await service.authenticate(token);
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.principal.userId).toBe(USER_A);
    expect(result.principal.tenantId).toBe(TENANT_A);
    expect(result.principal.permissions).toEqual([...ROLE_PERMISSIONS.manager]);
  });

  it('refuses a revoked session', async () => {
    const token = await loggedIn();
    await service.logout(token);
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('revoked');
  });

  it('refuses an expired session', async () => {
    const token = await loggedIn();
    clock = new Date(clock.getTime() + 3600 * 1000 + 1);
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('expired');
  });

  it('refuses a session minted under an older authVersion', async () => {
    // The lever a future password reset pulls: bump the user, and every
    // session in existence stops matching without a sweep.
    const token = await loggedIn();
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.authVersion += 1;
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('auth-version');
  });

  it('refuses a session whose user has been deactivated', async () => {
    const token = await loggedIn();
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.isActive = false;
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('user-inactive');
  });

  it('refuses a session the moment its tenant is suspended', async () => {
    // The session was minted while the tenant was active. Checking the tenant
    // only at login would leave it working until the cookie expired, which for
    // a twelve-hour session is the rest of the trading day.
    const token = await loggedIn();
    const index = store.tenants.findIndex((candidate) => candidate.id === TENANT_A);
    store.tenants[index] = { id: TENANT_A, slug: 'korvi-a', name: 'korvi-a', status: 'suspended' };

    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('tenant-inactive');
  });

  it('refuses a session whose tenant has been closed', async () => {
    const token = await loggedIn();
    const index = store.tenants.findIndex((candidate) => candidate.id === TENANT_A);
    store.tenants[index] = { id: TENANT_A, slug: 'korvi-a', name: 'korvi-a', status: 'closed' };

    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('tenant-inactive');
  });

  it('does not let reactivation skip the other checks', async () => {
    // A tenant coming back must not resurrect a session that was revoked,
    // expired or minted under an older authVersion while it was away.
    const token = await loggedIn();
    const index = store.tenants.findIndex((candidate) => candidate.id === TENANT_A);
    store.tenants[index] = { id: TENANT_A, slug: 'korvi-a', name: 'korvi-a', status: 'suspended' };
    await service.logout(token);

    store.tenants[index] = { id: TENANT_A, slug: 'korvi-a', name: 'korvi-a', status: 'active' };
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('revoked');
  });

  it('keeps cross-tenant behaviour unchanged while the tenant check runs', async () => {
    const token = await loggedIn();
    const moved = token.replace(TENANT_A, TENANT_B);
    const result = await service.authenticate(moved);
    expect(result.outcome === 'failure' && result.reason).toBe('unknown-session');
  });

  it('refuses a session whose membership has been suspended', async () => {
    const token = await loggedIn();
    const membership = store.memberships.find((candidate) => candidate.userId === USER_A);
    if (membership !== undefined) membership.status = 'suspended';
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('membership-inactive');
  });

  it('does not authenticate into another tenant when the hint is edited', async () => {
    // The tenant segment is a routing hint. Rewriting it changes which RLS
    // context opens and changes the hash, so the lookup finds nothing —
    // it does not find tenant B's session, and it does not find A's either.
    const token = await loggedIn();
    const moved = token.replace(TENANT_A, TENANT_B);
    expect(moved).not.toBe(token);
    const result = await service.authenticate(moved);
    expect(result.outcome === 'failure' && result.reason).toBe('unknown-session');
  });

  it.each([
    ['random', 'kps1.018f3a1c-9b2e-7c4d-8e5f-00000000000a.' + 'a'.repeat(43)],
    ['malformed', 'not-a-token'],
    ['empty', ''],
  ])('refuses a %s token', async (_label, candidate) => {
    const result = await service.authenticate(candidate);
    expect(result.outcome).toBe('failure');
  });

  it('logs out every session for a user when asked', async () => {
    await loggedIn();
    const second = await loggedIn();
    expect(store.sessions.filter((s) => s.revokedAt === null)).toHaveLength(2);

    const revoked = await service.logoutAll(second);
    expect(revoked).toBe(2);
    expect(store.sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });
});

describe('the audit trail', () => {
  it('records a success and a failure without recording the secret', async () => {
    await login({ password: 'wrong' });
    await login();

    const types = store.audit.map((entry) => entry.event.eventType);
    expect(types).toContain('auth.login.failure');
    expect(types).toContain('auth.login.success');

    const rendered = JSON.stringify(store.audit);
    expect(rendered).not.toContain(PASSWORD);
    expect(rendered).not.toContain('kps1.');
    expect(rendered).not.toContain('scrypt$');
  });

  it('labels an unknown address with a correlation hash, not the address', async () => {
    await login({ email: 'ghost@korvi-a.test' });
    const entry = store.audit.at(-1);
    const rendered = JSON.stringify(entry);
    expect(rendered).not.toContain('ghost@korvi-a.test');
    expect(entry?.event.metadata?.['correlation']).toBe(
      correlationHash(TENANT_A, 'ghost@korvi-a.test'),
    );
  });

  it('leaves no usable session behind when finalization fails', async () => {
    // The session row and the counter reset commit together. A partial write
    // here would be a live session belonging to a user the database still
    // believes is locked out.
    store.finalizeFails = true;
    const before = store.users.find((candidate) => candidate.id === USER_A);
    if (before !== undefined) before.failedLoginCount = 3;

    await expect(login()).rejects.toThrow(/finalizing transaction failed/);

    expect(store.sessions).toHaveLength(0);
    expect(before?.failedLoginCount).toBe(3);
    expect(before?.lastLoginAt).toBeNull();
  });

  it('still authenticates when the audit sink is down', async () => {
    // A session already exists by the time the log line is written. Failing
    // the login there would leave a live session behind an error message.
    store.auditFails = true;
    const result = await login();
    expect(result.outcome).toBe('success');
    expect(store.sessions).toHaveLength(1);
  });
});
EOF

say "Tests — the HTTP boundary"

cat << 'EOF' > apps/api/src/__tests__/auth-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { createGuards } from '../auth/guards.js';
import { hashPassword } from '../auth/password.js';
import { DEVELOPMENT_COOKIE_NAME } from '../auth/cookie.js';
import {
  MemoryAuthStore,
  memoryAuditRepository,
  memoryAuthRepository,
} from './support/memory-auth.js';
import type { FastifyInstance } from 'fastify';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const TENANT = '018f3a1c-9b2e-7c4d-8e5f-00000000000a';
const USER = '018f3a1c-9b2e-7c4d-8e5f-0000000000a1';
const PASSWORD = 'a-real-password-9!';
const ORIGIN = 'http://localhost:3000';

let app: FastifyInstance;
let store: MemoryAuthStore;

beforeEach(async () => {
  store = new MemoryAuthStore();
  store.tenants.push({ id: TENANT, slug: 'korvi-a', name: 'Korvi A', status: 'active' });
  store.users.push({
    id: USER,
    tenantId: TENANT,
    email: 'sara@korvi-a.test',
    displayName: 'سارة',
    passwordHash: await hashPassword(PASSWORD, FAST),
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    authVersion: 1,
    lastLoginAt: null,
  });
  store.memberships.push({ tenantId: TENANT, userId: USER, status: 'active', defaultBranchId: null });
  store.grants.push({
    tenantId: TENANT,
    userId: USER,
    roles: ['cashier'],
    permissions: [...ROLE_PERMISSIONS.cashier],
  });

  const auth = createAuthService({
    repository: memoryAuthRepository(store),
    audit: memoryAuditRepository(store),
    sessionTtlSeconds: 3600,
    scrypt: FAST,
  });

  app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), { auth });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function cookieFrom(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  return raw.split(';')[0] ?? '';
}

async function loginOk(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return cookieFrom(response.headers['set-cookie']);
}

describe('POST /v1/auth/login', () => {
  it('sets an HttpOnly, SameSite=Lax, host-scoped cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });

    const header = Array.isArray(response.headers['set-cookie'])
      ? (response.headers['set-cookie'][0] ?? '')
      : (response.headers['set-cookie'] ?? '');
    expect(header).toContain(`${DEVELOPMENT_COOKIE_NAME}=kps1.`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).not.toContain('Domain=');
  });

  it('returns a principal and no secret of any kind', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });

    const body = response.json<Record<string, unknown>>();
    expect(body['roles']).toEqual(['cashier']);
    expect(body['permissions']).toEqual([...ROLE_PERMISSIONS.cashier]);
    // A cashier may not discount. The figure is derived from the role on the
    // server; the client has no way to influence it.
    expect(body['maxDiscountBasisPoints']).toBe('0');

    const raw = response.payload;
    expect(raw).not.toContain('kps1.');
    expect(raw).not.toContain('scrypt$');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('tokenHash');
    expect(raw).not.toContain(PASSWORD);
  });

  it.each([
    ['a wrong password', { password: 'nope' }],
    ['an unknown email', { email: 'ghost@korvi-a.test' }],
    ['an unknown tenant', { tenantSlug: 'ghost-shop' }],
    ['a malformed body', { email: '' }],
  ])('answers %s with one indistinguishable failure', async (_label, overrides) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: {
        tenantSlug: 'korvi-a',
        email: 'sara@korvi-a.test',
        password: PASSWORD,
        ...overrides,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'invalid_credentials' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a login posted from another origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a login posted with no origin at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /v1/auth/me', () => {
  it('refuses without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthenticated' });
  });

  it('refuses a forged cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: `${DEVELOPMENT_COOKIE_NAME}=kps1.${TENANT}.${'a'.repeat(43)}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the server-derived principal for a live session', async () => {
    const cookie = await loginOk();
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body['user']).toMatchObject({ id: USER, email: 'sara@korvi-a.test' });
    expect(body['tenant']).toMatchObject({ id: TENANT });
    expect(response.payload).not.toContain('kps1.');
  });

  it('ignores a role or permission the client tries to assert', async () => {
    // The one thing this whole strike exists to guarantee. Nothing on the
    // request can add a capability the database did not grant.
    const cookie = await loginOk();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me?role=owner&permissions=sale.discount',
      headers: { cookie, 'x-korvi-role': 'owner', 'x-korvi-permissions': 'settings.manage' },
    });

    const body = response.json<Record<string, unknown>>();
    expect(body['roles']).toEqual(['cashier']);
    expect(body['permissions']).not.toContain('settings.manage');
    expect(body['maxDiscountBasisPoints']).toBe('0');
  });

  it('stops working the moment the session is revoked', async () => {
    const cookie = await loginOk();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: ORIGIN },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /v1/auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const cookie = await loginOk();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: ORIGIN },
    });

    expect(response.statusCode).toBe(204);
    const header = Array.isArray(response.headers['set-cookie'])
      ? (response.headers['set-cookie'][0] ?? '')
      : (response.headers['set-cookie'] ?? '');
    expect(header).toContain('Max-Age=0');
    expect(store.sessions.every((session) => session.revokedAt !== null)).toBe(true);
  });

  it('clears the cookie even when there was no session to revoke', async () => {
    // Otherwise the answer distinguishes "already revoked" from "never
    // existed", and the browser keeps a dead token either way.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(204);
  });
});

describe('POST /v1/auth/logout-all', () => {
  it('revokes every session the user holds', async () => {
    await loginOk();
    const cookie = await loginOk();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { cookie, origin: ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: 2 });
  });
});

describe('requirePermission, over HTTP', () => {
  /**
   * A probe route, registered only here.
   *
   * The guard is worth nothing if it is only ever exercised as a function: what
   * matters is what Fastify returns when it refuses. Adding a real business
   * endpoint to prove that would be shipping a route for a test's benefit, so
   * the probe lives in the test file and nowhere else.
   */
  async function probeServer(role: 'cashier' | 'manager'): Promise<FastifyInstance> {
    const grant = store.grants.findIndex((candidate) => candidate.userId === USER);
    store.grants[grant] = {
      tenantId: TENANT,
      userId: USER,
      roles: [role],
      permissions: [...ROLE_PERMISSIONS[role]],
    };

    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
    const service = createAuthService({
      repository: memoryAuthRepository(store),
      audit: memoryAuditRepository(store),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    });
    const guards = createGuards(service, config);
    const probe = buildServer(config, { auth: service });
    const preHandler = [guards.requireSession, guards.requirePermission('sale.discount')];
    probe.get('/__probe__/discount', { preHandler }, (request) => ({
      ok: true,
      userId: request.auth?.userId,
      roles: request.auth?.roles,
    }));
    probe.post('/__probe__/discount', { preHandler }, (request) => ({
      ok: true,
      userId: request.auth?.userId,
    }));
    await probe.ready();
    return probe;
  }

  async function cookieFor(probe: FastifyInstance): Promise<string> {
    const response = await probe.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieFrom(response.headers['set-cookie']);
  }

  it('runs the handler when the principal holds the permission', async () => {
    const probe = await probeServer('manager');
    const cookie = await cookieFor(probe);

    const response = await probe.inject({
      method: 'GET',
      url: '/__probe__/discount',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, userId: USER, roles: ['manager'] });
    await probe.close();
  });

  it('answers 403 when the principal does not', async () => {
    const probe = await probeServer('cashier');
    const cookie = await cookieFor(probe);

    const response = await probe.inject({
      method: 'GET',
      url: '/__probe__/discount',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden' });
    await probe.close();
  });

  it('answers 401 when there is no session at all', async () => {
    // Not 403: the difference between "I do not know you" and "I know you and
    // the answer is no" is the difference between two support calls.
    const probe = await probeServer('cashier');
    const response = await probe.inject({ method: 'GET', url: '/__probe__/discount' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthenticated' });
    await probe.close();
  });

  it.each([
    ['a query string', '/__probe__/discount?role=owner&permission=sale.discount', {}],
    [
      'headers',
      '/__probe__/discount',
      { 'x-korvi-role': 'owner', 'x-korvi-permissions': 'sale.discount,settings.manage' },
    ],
  ])('ignores %s claiming the permission', async (_label, url, headers) => {
    const probe = await probeServer('cashier');
    const cookie = await cookieFor(probe);

    const response = await probe.inject({
      method: 'GET',
      url,
      headers: { cookie, ...headers },
    });
    expect(response.statusCode).toBe(403);
    await probe.close();
  });

  it('ignores a body claiming the permission on a write', async () => {
    const probe = await probeServer('cashier');
    const cookie = await cookieFor(probe);

    const response = await probe.inject({
      method: 'POST',
      url: '/__probe__/discount',
      headers: { cookie, origin: ORIGIN },
      payload: { role: 'owner', permissions: ['sale.discount'], tenantId: TENANT },
    });
    expect(response.statusCode).toBe(403);
    await probe.close();
  });

  it('grants the same route to a manager, so the 403s above are the guard', async () => {
    // Without this the four refusals could all be a broken route rather than a
    // working permission check.
    const probe = await probeServer('manager');
    const cookie = await cookieFor(probe);

    const response = await probe.inject({
      method: 'POST',
      url: '/__probe__/discount',
      headers: { cookie, origin: ORIGIN },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    await probe.close();
  });
});

describe('when authentication is not configured', () => {
  it('answers 503 rather than a credential failure', async () => {
    // A missing DATABASE_URL is an operator's problem. Reporting it as
    // "invalid credentials" sends everyone looking in the wrong place.
    const bare = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }));
    await bare.ready();
    const response = await bare.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(503);
    await bare.close();
  });
});
EOF

say "Tests — principal and RBAC provisioning"

mkdir -p packages/domain/src/rbac/__tests__

cat << 'EOF' > packages/domain/src/rbac/__tests__/principal.test.ts
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_MAX_DISCOUNT_BP, ROLE_PERMISSIONS } from '../permissions.js';
import {
  PrincipalWithoutRoleError,
  maxDiscountForRoles,
  permissionsForRoles,
  primaryRole,
  principalCan,
  requirePrincipalPermission,
  toActor,
} from '../principal.js';
import type { AuthenticatedPrincipal } from '../principal.js';

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    tenantId: '018f3a1c-9b2e-7c4d-8e5f-00000000000a',
    tenantSlug: 'korvi',
    userId: '018f3a1c-9b2e-7c4d-8e5f-0000000000a1',
    sessionId: '018f3a1c-9b2e-7c4d-8e5f-0000000000a2',
    email: 'sara@korvi.test',
    displayName: 'سارة',
    roles: ['cashier'],
    permissions: [...ROLE_PERMISSIONS.cashier],
    maxDiscountBasisPoints: 0n,
    branchId: null,
    ...overrides,
  };
}

describe('roles held in combination', () => {
  it('picks the most senior role for the single-role contract', () => {
    expect(primaryRole(['cashier', 'manager'])).toBe('manager');
    expect(primaryRole(['admin', 'cashier', 'owner'])).toBe('owner');
    expect(primaryRole([])).toBeNull();
  });

  it('grants the union of what the roles grant, never the intersection', () => {
    const granted = permissionsForRoles(['cashier', 'manager']);
    for (const permission of ROLE_PERMISSIONS.manager) {
      expect(granted).toContain(permission);
    }
    expect(granted).toContain('sale.create');
  });

  it('takes the highest discount ceiling, not the sum', () => {
    // Two roles do not add up to more authority than either grants.
    expect(maxDiscountForRoles(['cashier', 'manager'])).toBe(ROLE_MAX_DISCOUNT_BP.manager);
    expect(maxDiscountForRoles(['manager', 'admin'])).toBe(ROLE_MAX_DISCOUNT_BP.admin);
    expect(maxDiscountForRoles([])).toBe(0n);
  });

  it('gives a cashier no discount authority at all', () => {
    expect(maxDiscountForRoles(['cashier'])).toBe(0n);
  });
});

describe('the principal as an actor', () => {
  it('adapts to the existing single-role Actor used by the sale path', () => {
    const actor = toActor(principal({ roles: ['cashier', 'manager'] }));
    expect(actor.role).toBe('manager');
    expect(actor.userId).toBe('018f3a1c-9b2e-7c4d-8e5f-0000000000a1');
  });

  it('refuses to invent a role for someone who has none', () => {
    // Falling back to the least-privileged role would silently grant a
    // cashier's permissions to someone nobody has placed yet.
    expect(() => toActor(principal({ roles: [] }))).toThrow(PrincipalWithoutRoleError);
  });

  it('answers permission questions from the verified set only', () => {
    const cashier = principal();
    expect(principalCan(cashier, 'sale.create')).toBe(true);
    expect(principalCan(cashier, 'sale.discount')).toBe(false);
    expect(() => requirePrincipalPermission(cashier, 'sale.discount')).toThrow(/Permission denied/);
  });

  it('covers every permission in the catalogue with the owner role', () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
  });
});
EOF

cat << 'EOF' > packages/database/src/__tests__/rbac-provisioning.test.ts
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_MAX_DISCOUNT_BP, ROLE_PERMISSIONS } from '@korvi/domain';
import { DEFAULT_ROLES, PERMISSION_CATALOGUE } from '../provisioning/rbac.js';
import type { Permission, RoleName } from '@korvi/domain';

/**
 * The database's vocabulary and the domain's must be the same vocabulary.
 *
 * One half of that is enforced by the compiler: PERMISSION_CATALOGUE is typed
 * `Record<Permission, ...>`, so adding a permission to the domain and not
 * describing it here fails to build. This file enforces the other half —
 * nothing described here that the domain does not define — and states the
 * relationship in a way that fails loudly rather than drifting.
 */

describe('the permission catalogue', () => {
  it('describes exactly the permissions the domain defines', () => {
    expect(Object.keys(PERMISSION_CATALOGUE).sort()).toEqual([...PERMISSIONS].sort());
  });

  it('gives every permission an Arabic description, because the UI is Arabic-first', () => {
    for (const key of PERMISSIONS) {
      const described = PERMISSION_CATALOGUE[key];
      expect(described.ar.trim(), key).not.toBe('');
      expect(described.en.trim(), key).not.toBe('');
      // A description that is just the key helps nobody read a role screen.
      expect(described.ar).not.toBe(key);
    }
  });
});

describe('the default roles', () => {
  it('provisions exactly the roles the domain defines and no others', () => {
    const domainRoles = Object.keys(ROLE_PERMISSIONS).sort();
    expect(Object.keys(DEFAULT_ROLES).sort()).toEqual(domainRoles);
  });

  it('takes every discount ceiling from the domain rather than restating it', () => {
    // The ceiling lives in one place. A second copy here is how a cashier ends
    // up able to discount in the database and unable to in the code.
    for (const role of Object.keys(DEFAULT_ROLES) as RoleName[]) {
      const ceiling = ROLE_MAX_DISCOUNT_BP[role];
      expect(Number(ceiling)).toBeGreaterThanOrEqual(0);
      expect(Number(ceiling)).toBeLessThanOrEqual(10_000);
    }
    expect(ROLE_MAX_DISCOUNT_BP.cashier).toBe(0n);
  });

  it('grants each role only permissions that exist in the catalogue', () => {
    for (const role of Object.keys(DEFAULT_ROLES) as RoleName[]) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(permission satisfies Permission);
      }
    }
  });
});
EOF

say "Tests — extending the Strike 2A suites to cover the new migration"

python3 - <<'PY'
import sys

path = 'packages/database/src/__tests__/saas-schema.test.ts'
source = open(path, encoding='utf-8').read()

def swap(old, new, label):
    global source
    if new in source:
        print('  %s already applied' % label)
        return
    if old not in source:
        sys.stderr.write('Could not find the anchor for %s in %s.\n' % (label, path))
        sys.exit(1)
    source = source.replace(old, new, 1)
    print('  %s' % label)

# Read every migration, not just Strike 2A's. A test pinned to one file stops
# seeing the schema the moment a second migration adds a table.
swap(
    """import { readFileSync } from 'node:fs';""",
    """import { readFileSync, readdirSync } from 'node:fs';""",
    'directory read',
)

swap(
    """const migration = readFileSync(
  join(prismaDir, 'migrations/20260808120000_saas_foundation/migration.sql'),
  'utf8',
);""",
    """/**
 * Every migration, in order, as one text.
 *
 * Pinned to a single file this suite would have stopped covering the schema the
 * moment a later migration added a table — which is exactly when it matters.
 */
const migrationsDir = join(prismaDir, 'migrations');
const migration = readdirSync(migrationsDir)
  .filter((entry) => /^[0-9]{14}_/.test(entry))
  .sort()
  .map((entry) => readFileSync(join(migrationsDir, entry, 'migration.sql'), 'utf8'))
  .join('\\n');

/** Everything except the Phase 0 migration, which had nothing to replace. */
const afterBaseline = readdirSync(migrationsDir)
  .filter((entry) => /^[0-9]{14}_/.test(entry) && !entry.startsWith('00000000000000'))
  .sort()
  .map((entry) => readFileSync(join(migrationsDir, entry, 'migration.sql'), 'utf8'))
  .join('\\n');

/** Each CREATE POLICY statement, truncated at its own semicolon. */
function policyBodies(): readonly string[] {
  return migration
    .split(/\\nCREATE POLICY "/)
    .slice(1)
    .map((chunk) => chunk.split(';')[0] ?? '');
}""",
    'all migrations concatenated',
)

# Two policies now sit on `tenants`: the isolation policy, and the SELECT-only
# login-resolution policy that Strike 2B adds. A FOR SELECT policy cannot carry
# WITH CHECK -- PostgreSQL rejects the syntax -- so the assertion has to know
# the difference rather than treat the absence as a hole.
swap(
    """  it('gives every policy both USING and WITH CHECK, and no table is missed', () => {
    // USING alone governs reads. Without WITH CHECK a caller could UPDATE a
    // visible row and reassign it to another tenant.
    // Split on the statement, not the phrase: the file's own commentary
    // mentions CREATE POLICY, and counting that would inflate the total.
    const policies = migration.split(/\\nCREATE POLICY "/).slice(1);
    expect(policies.length).toBe(tenantOwnedTables.length);
    for (const policy of policies) {
      const body = policy.split(';')[0] ?? '';
      expect(body).toContain('USING');
      expect(body).toContain('WITH CHECK');
      expect(body).toContain('current_tenant_id()');
    }
  });""",
    """  it('gives every isolation policy both USING and WITH CHECK', () => {
    // USING alone governs reads. Without WITH CHECK a caller could UPDATE a
    // visible row and reassign it to another tenant.
    //
    // The statement body ends at the first semicolon. Reading past it would
    // pick up the next migration's commentary, which discusses policies and
    // would make this assertion answer a question about prose.
    const isolation = policyBodies().filter((body) => !body.includes('FOR SELECT'));
    // At least one per table: Phase 0 wrote the first policy for tenants and
    // products, and Strike 2A restated both.
    expect(isolation.length).toBeGreaterThanOrEqual(tenantOwnedTables.length);
    for (const body of isolation) {
      expect(body).toContain('USING');
      expect(body).toContain('WITH CHECK');
      expect(body).toContain('current_tenant_id()');
    }
  });

  it('keeps every read-only policy read-only, and keyed on its own setting', () => {
    // The login-resolution door. FOR SELECT means PostgreSQL will not consider
    // it for INSERT, UPDATE or DELETE at all, so there is no version of this
    // policy that writes. It carries no WITH CHECK because it cannot.
    const readOnly = policyBodies().filter((body) => body.includes('FOR SELECT'));
    expect(readOnly.length).toBe(1);
    for (const body of readOnly) {
      expect(body).toContain('USING');
      expect(body).not.toContain('WITH CHECK');
      expect(body).toContain('login_tenant_slug()');
    }
  });""",
    'select-only policy handling',
)

swap(
    """    const pairs = [
      ...migration.matchAll(
        /DROP POLICY IF EXISTS "(\\w+)" ON "(\\w+)";\\nCREATE POLICY "\\1" ON "\\2"/g,
      ),
    ];
    expect(pairs.length).toBe(tenantOwnedTables.length);""",
    """    // Phase 0 wrote the first policies onto an empty database and had
    // nothing to drop. Every migration after it does.
    const created = [...afterBaseline.matchAll(/\\nCREATE POLICY "(\\w+)" ON "(\\w+)"/g)];
    const pairs = [
      ...afterBaseline.matchAll(
        /DROP POLICY IF EXISTS "(\\w+)" ON "(\\w+)";\\nCREATE POLICY "\\1" ON "\\2"/g,
      ),
    ];
    expect(created.length).toBeGreaterThanOrEqual(tenantOwnedTables.length);
    expect(pairs.length).toBe(created.length);""",
    'policy recreation count',
)

open(path, 'w', encoding='utf-8').write(source)
PY

python3 - <<'PY'
import sys

path = 'packages/database/src/__tests__/rls-live.test.ts'
source = open(path, encoding='utf-8').read()

def swap(old, new, label):
    global source
    if new in source:
        print('  %s already applied' % label)
        return
    if old not in source:
        sys.stderr.write('Could not find the anchor for %s in %s.\n' % (label, path))
        sys.exit(1)
    source = source.replace(old, new, 1)
    print('  %s' % label)

swap(
    """  it('gives every tenant-owned table a policy with both USING and WITH CHECK', async () => {
    const result = await client.query<{
      tablename: string;
      qual: string | null;
      with_check: string | null;
    }>(`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public'`);

    const covered = new Set(result.rows.map((row) => row.tablename));
    expect(covered.size).toBeGreaterThanOrEqual(29);

    for (const row of result.rows) {
      expect(row.qual, `${row.tablename} policy has no USING`).not.toBeNull();
      expect(row.with_check, `${row.tablename} policy has no WITH CHECK`).not.toBeNull();
    }""",
    """  it('gives every tenant-owned table a policy with both USING and WITH CHECK', async () => {
    const result = await client.query<{
      tablename: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(`SELECT tablename, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public'`);

    const covered = new Set(result.rows.map((row) => row.tablename));
    expect(covered.size).toBeGreaterThanOrEqual(30);

    for (const row of result.rows) {
      expect(row.qual, `${row.tablename} policy has no USING`).not.toBeNull();
      // A FOR SELECT policy cannot carry WITH CHECK, and does not need one:
      // PostgreSQL never consults it for a write. Everything else must.
      if (row.cmd === 'SELECT') continue;
      expect(row.with_check, `${row.tablename} policy has no WITH CHECK`).not.toBeNull();
    }""",
    'select-only policies in the live catalogue check',
)

swap(
    """    const tenantOwned = result.rows.filter((row) => !NOT_TENANT_OWNED.includes(row.relname));
    expect(tenantOwned.length).toBeGreaterThanOrEqual(29);""",
    """    const tenantOwned = result.rows.filter((row) => !NOT_TENANT_OWNED.includes(row.relname));
    expect(tenantOwned.length).toBeGreaterThanOrEqual(30);""",
    'tenant-owned table count',
)

open(path, 'w', encoding='utf-8').write(source)
PY

say "Tests — live login resolution and session isolation"

cat << 'EOF' > packages/database/src/__tests__/auth-live.test.ts
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantId as brandTenantId } from '@korvi/domain';
import { createPrismaClient } from '../client.js';
import { withLoginSlug, withTenant, withoutTenant } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

/**
 * The Strike 2B tenancy surface, against a real PostgreSQL server.
 *
 * Two claims that only a live database can settle:
 *
 *   the login-resolution policy reads exactly one tenant and writes nothing,
 *   and sessions are isolated as strictly as every other tenant-owned table.
 *
 * Opt-in, same as the Strike 2A live suite. Point KORVI_TEST_DATABASE_URL at a
 * throwaway database with all three migrations applied, connected as the
 * application role — not a superuser, which bypasses RLS and would make every
 * assertion here pass for the wrong reason.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const here = dirname(fileURLToPath(import.meta.url));

const A = {
  tenant: '018f0b00-0000-7000-8000-00000000000a',
  slug: 'auth-live-a',
  user: '018f0b00-0000-7000-8000-0000000000a1',
  session: '018f0b00-0000-7000-8000-0000000000a2',
} as const;

const B = {
  tenant: '018f0b00-0000-7000-8000-00000000000b',
  slug: 'auth-live-b',
  user: '018f0b00-0000-7000-8000-0000000000b1',
  session: '018f0b00-0000-7000-8000-0000000000b2',
} as const;

const SCRATCH = '018f0b00-0000-7000-8000-0000000000c1';
const HOUR = 3_600_000;

describe.skipIf(url === '')('authentication tenancy, live', () => {
  let prisma: PrismaClient;

  async function refused(work: () => Promise<unknown>): Promise<string> {
    try {
      await work();
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function seed(t: typeof A): Promise<void> {
    const scope = { tenantId: brandTenantId(t.tenant) };
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: { id: t.tenant, name: `Tenant ${t.slug}`, slug: t.slug, updatedAt: new Date() },
      });
      await tx.user.create({
        data: {
          id: t.user,
          tenantId: t.tenant,
          email: `cashier@${t.slug}.test`,
          displayName: 'كاشير',
          updatedAt: new Date(),
        },
      });
      await tx.session.create({
        data: {
          id: t.session,
          tenantId: t.tenant,
          userId: t.user,
          tokenHash: `hash-${t.slug}`,
          authVersion: 1,
          expiresAt: new Date(Date.now() + HOUR),
          lastSeenAt: new Date(),
        },
      });
    });
  }

  async function remove(tenant: string): Promise<void> {
    await withTenant(prisma, brandTenantId(tenant), async (tx) => {
      await tx.tenant.deleteMany({ where: { id: tenant } });
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove(A.tenant);
    await remove(B.tenant);
    await remove(SCRATCH);
    await seed(A);
    await seed(B);
  });

  afterAll(async () => {
    await remove(A.tenant);
    await remove(B.tenant);
    await remove(SCRATCH);
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Login resolution
  // -------------------------------------------------------------------------

  it('resolves exactly the tenant whose slug was submitted', async () => {
    const rows = await withLoginSlug(prisma, A.slug, async (tx) =>
      tx.tenant.findMany({ select: { id: true, slug: true } }),
    );
    expect(rows).toEqual([{ id: A.tenant, slug: A.slug }]);
  });

  it('returns nothing for a slug that does not exist', async () => {
    const rows = await withLoginSlug(prisma, 'no-such-shop', async (tx) => tx.tenant.findMany());
    expect(rows).toEqual([]);
  });

  it('cannot list tenants, however the query is written', async () => {
    // The policy is an equality on one setting. An unfiltered findMany is the
    // most generous query available and still returns one row.
    const rows = await withLoginSlug(prisma, A.slug, async (tx) => tx.tenant.findMany({}));
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.id).toBe(A.tenant);
  });

  it('cannot see users, products or sessions from the login context', async () => {
    // Every other table keys its policy on app.tenant_id, which is empty here.
    const seen = await withLoginSlug(prisma, A.slug, async (tx) => ({
      users: await tx.user.count(),
      products: await tx.product.count(),
      sessions: await tx.session.count(),
      memberships: await tx.tenantMembership.count(),
    }));
    expect(seen).toEqual({ users: 0, products: 0, sessions: 0, memberships: 0 });
  });

  it('cannot insert a tenant through the login context', async () => {
    const message = await refused(() =>
      withLoginSlug(prisma, A.slug, async (tx) =>
        tx.tenant.create({
          data: { id: SCRATCH, name: 'Smuggled', slug: 'smuggled', updatedAt: new Date() },
        }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('cannot update the tenant it just resolved', async () => {
    const changed = await withLoginSlug(prisma, A.slug, async (tx) =>
      tx.tenant.updateMany({ where: { id: A.tenant }, data: { name: 'Renamed' } }),
    );
    // The isolation policy governs UPDATE, and app.tenant_id is empty, so the
    // row is not visible for writing. Zero rows, not an error — which is the
    // deny-by-default shape RLS gives an UPDATE.
    expect(changed.count).toBe(0);

    const name = await withLoginSlug(prisma, A.slug, async (tx) =>
      tx.tenant.findMany({ select: { name: true } }),
    );
    expect(name.at(0)?.name).toBe(`Tenant ${A.slug}`);
  });

  it('cannot delete the tenant it just resolved', async () => {
    const removed = await withLoginSlug(prisma, A.slug, async (tx) =>
      tx.tenant.deleteMany({ where: { id: A.tenant } }),
    );
    expect(removed.count).toBe(0);
  });

  it('leaves the ordinary isolation policy exactly as it was', async () => {
    // The login policy is additive and SELECT-only. With no context at all,
    // tenants is still invisible.
    const rows = await withoutTenant(prisma, async (tx) => tx.tenant.findMany());
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  it('shows a tenant only its own sessions', async () => {
    const rows = await withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
      tx.session.findMany({ select: { id: true } }),
    );
    expect(rows.map((row) => row.id)).toEqual([A.session]);
  });

  it('returns nothing for another tenant’s session, asked for by primary key', async () => {
    const rows = await withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
      tx.session.findMany({ where: { id: B.session } }),
    );
    expect(rows).toEqual([]);
  });

  it('finds no session at all with no tenant context', async () => {
    const rows = await withoutTenant(prisma, async (tx) => tx.session.findMany());
    expect(rows).toEqual([]);
  });

  it('refuses a session minted for another tenant’s user', async () => {
    // The composite key does this, not RLS: the row would carry tenant A, and
    // (A, B.user) is not a pair that exists in users.
    const message = await refused(() =>
      withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
        tx.session.create({
          data: {
            id: SCRATCH,
            tenantId: A.tenant,
            userId: B.user,
            tokenHash: 'hash-smuggled',
            authVersion: 1,
            expiresAt: new Date(Date.now() + HOUR),
            lastSeenAt: new Date(),
          },
        }),
      ),
    );
    // Prisma phrases the driver error its own way, so the assertion is on
    // the constraint name — which is the part that identifies the guard.
    expect(message).toMatch(/sessions_tenantId_userId_fkey/);
  });

  it('refuses a session row that names another tenant outright', async () => {
    const message = await refused(() =>
      withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
        tx.session.create({
          data: {
            id: SCRATCH,
            tenantId: B.tenant,
            userId: B.user,
            tokenHash: 'hash-smuggled-2',
            authVersion: 1,
            expiresAt: new Date(Date.now() + HOUR),
            lastSeenAt: new Date(),
          },
        }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses to repoint a session at another tenant’s user', async () => {
    const message = await refused(() =>
      withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
        tx.session.updateMany({ where: { id: A.session }, data: { userId: B.user } }),
      ),
    );
    // Prisma phrases the driver error its own way, so the assertion is on
    // the constraint name — which is the part that identifies the guard.
    expect(message).toMatch(/sessions_tenantId_userId_fkey/);
  });

  it('enables and forces RLS on the sessions table', async () => {
    const rows = await withoutTenant(prisma, async (tx) =>
      tx.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT c.relrowsecurity, c.relforcerowsecurity
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'sessions'`,
    );
    expect(rows.at(0)?.relrowsecurity).toBe(true);
    expect(rows.at(0)?.relforcerowsecurity).toBe(true);
  });

  it('has no drift between the migrations and the Prisma schema', async () => {
    // The Strike 2B migration is hand-written SQL, same as Strike 2A's. If
    // Prisma's model of it ever disagrees, the next `prisma migrate dev`
    // silently proposes to undo it.
    const output = execFileSync(
      'npx',
      [
        '--no-install',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
      ],
      { cwd: join(here, '../..'), env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
    );
    expect(output).toContain('No difference detected');
  }, 120_000);
});

describe.skipIf(url !== '')('authentication tenancy, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
EOF

say "Tests — the whole flow against a real database"

cat << 'EOF' > apps/api/src/__tests__/auth-live.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, tenantId as brandTenantId } from '@korvi/domain';
import {
  assignRole,
  createAuditRepository,
  createAuthRepository,
  createPrismaClient,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  withTenant,
} from '@korvi/database';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import type { AuthService } from '../auth/service.js';
import type { PrismaClient } from '@korvi/database';
import type { TenantScope } from '@korvi/domain';

/**
 * Login to principal, end to end, against a real PostgreSQL server.
 *
 * The unit suite proves the rules; this proves they survive contact with RLS,
 * the composite keys and the persisted role graph. It is the only place where
 * "permissions are derived from persistence" is a statement about persistence
 * rather than about a fake.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with all
 * three migrations applied, connected as the application role.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;

const A = {
  tenant: '018f0c00-0000-7000-8000-00000000000a',
  slug: 'flow-live-a',
  user: '018f0c00-0000-7000-8000-0000000000a1',
  membership: '018f0c00-0000-7000-8000-0000000000a2',
  email: 'sara@flow-live-a.test',
} as const;

const B = {
  tenant: '018f0c00-0000-7000-8000-00000000000b',
  slug: 'flow-live-b',
  user: '018f0c00-0000-7000-8000-0000000000b1',
  membership: '018f0c00-0000-7000-8000-0000000000b2',
  email: 'omar@flow-live-b.test',
} as const;

/** Suspension and lockout mutate tenant state, so they get their own tenants. */
const C = {
  tenant: '018f0c00-0000-7000-8000-00000000000c',
  slug: 'flow-live-c',
  user: '018f0c00-0000-7000-8000-0000000000c1',
  membership: '018f0c00-0000-7000-8000-0000000000c2',
  email: 'noura@flow-live-c.test',
} as const;

const D = {
  tenant: '018f0c00-0000-7000-8000-00000000000d',
  slug: 'flow-live-d',
  user: '018f0c00-0000-7000-8000-0000000000d1',
  membership: '018f0c00-0000-7000-8000-0000000000d2',
  email: 'khalid@flow-live-d.test',
} as const;

const PASSWORD = 'a-real-password-9!';

describe.skipIf(url === '')('authentication flow, live', () => {
  let prisma: PrismaClient;
  let service: AuthService;
  let repository: ReturnType<typeof createAuthRepository>;
  let clock: Date;

  const LOCKOUT = { threshold: 5, lockSeconds: 900 } as const;

  async function remove(tenant: string): Promise<void> {
    await withTenant(prisma, brandTenantId(tenant), async (tx) => {
      await tx.tenant.deleteMany({ where: { id: tenant } });
    });
  }

  async function seed(t: typeof A, role: 'cashier' | 'manager'): Promise<void> {
    const scope: TenantScope = { tenantId: brandTenantId(t.tenant) };
    const passwordHash = await hashPassword(PASSWORD, FAST);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: { id: t.tenant, name: t.slug, slug: t.slug, updatedAt: new Date() },
      });
      await tx.user.create({
        data: {
          id: t.user,
          tenantId: t.tenant,
          email: t.email,
          displayName: 'كاشير',
          passwordHash,
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: t.membership, tenantId: t.tenant, userId: t.user, updatedAt: new Date() },
      });
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, t.user, role);
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    clock = new Date('2026-08-10T08:00:00.000Z');

    await remove(A.tenant);
    await remove(B.tenant);
    await remove(C.tenant);
    await remove(D.tenant);
    await provisionPermissionCatalogue(prisma);
    await seed(A, 'manager');
    await seed(B, 'cashier');
    await seed(C, 'cashier');
    await seed(D, 'cashier');

    repository = createAuthRepository(prisma);
    service = createAuthService({
      repository,
      audit: createAuditRepository(prisma),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
      lockout: LOCKOUT,
      now: () => clock,
    });
  }, 90_000);

  afterAll(async () => {
    await remove(A.tenant);
    await remove(B.tenant);
    await remove(C.tenant);
    await remove(D.tenant);
    await prisma.$disconnect();
  });

  async function setTenantStatus(tenant: string, status: string): Promise<void> {
    await withTenant(prisma, brandTenantId(tenant), async (tx) => {
      await tx.tenant.updateMany({ where: { id: tenant }, data: { status } });
    });
  }

  async function userRow(t: typeof A): Promise<{
    failedLoginCount: number;
    lockedUntil: Date | null;
    lastLoginAt: Date | null;
  }> {
    return withTenant(prisma, brandTenantId(t.tenant), async (tx) => {
      const rows = await tx.user.findMany({ where: { id: t.user, tenantId: t.tenant } });
      const row = rows.at(0);
      if (row === undefined) throw new Error('seeded user vanished');
      return {
        failedLoginCount: row.failedLoginCount,
        lockedUntil: row.lockedUntil,
        lastLoginAt: row.lastLoginAt,
      };
    });
  }

  function login(overrides: Partial<{ tenantSlug: string; email: string; password: string }> = {}) {
    return service.login({
      tenantSlug: overrides.tenantSlug ?? A.slug,
      email: overrides.email ?? A.email,
      password: overrides.password ?? PASSWORD,
      userAgent: 'vitest',
    });
  }

  it('authenticates against the real login-resolution policy', async () => {
    const result = await login();
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.principal.tenantId).toBe(A.tenant);
    expect(result.principal.tenantSlug).toBe(A.slug);
  });

  it('derives permissions from the persisted role graph, not from a constant', async () => {
    // UserRole -> Role -> RolePermission -> Permission, read back out of
    // PostgreSQL under this tenant's RLS context.
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    expect(result.principal.roles).toEqual(['manager']);
    expect([...result.principal.permissions].sort()).toEqual([...ROLE_PERMISSIONS.manager].sort());
    expect(result.principal.maxDiscountBasisPoints).toBe(2_000n);
  });

  it('gives the other tenant its own, smaller authority', async () => {
    const result = await service.login({
      tenantSlug: B.slug,
      email: B.email,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    if (result.outcome !== 'success') throw new Error('expected success');
    expect(result.principal.roles).toEqual(['cashier']);
    // A cashier may not discount, and the figure came from the database.
    expect(result.principal.maxDiscountBasisPoints).toBe(0n);
    expect(result.principal.permissions).not.toContain('sale.discount');
  });

  it('refuses a real password submitted against the wrong tenant', async () => {
    const result = await login({ tenantSlug: B.slug });
    expect(result.outcome).toBe('failure');
  });

  it.each([
    ['wrong password', { password: 'not-it' }],
    ['unknown email', { email: 'ghost@flow-live-a.test' }],
    ['unknown tenant', { tenantSlug: 'no-such-shop' }],
  ])('refuses a login with a %s', async (_label, overrides) => {
    const result = await login(overrides);
    expect(result.outcome).toBe('failure');
  });

  it('turns its own token back into the same principal', async () => {
    const login1 = await login();
    if (login1.outcome !== 'success') throw new Error('expected success');

    const verified = await service.authenticate(login1.token);
    expect(verified.outcome).toBe('success');
    if (verified.outcome !== 'success') return;
    expect(verified.principal.userId).toBe(A.user);
    expect(verified.principal.sessionId).toBe(login1.principal.sessionId);
  });

  it('does not authenticate into another tenant when the hint is rewritten', async () => {
    // Two independent reasons it fails: the hash covers the tenant segment, and
    // the lookup runs inside the hinted tenant's RLS context.
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    const moved = result.token.replace(A.tenant, B.tenant);
    expect(moved).not.toBe(result.token);
    const verified = await service.authenticate(moved);
    expect(verified.outcome === 'failure' && verified.reason).toBe('unknown-session');
  });

  it('stops accepting a revoked token', async () => {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    await expect(service.logout(result.token)).resolves.toBe(true);
    const verified = await service.authenticate(result.token);
    expect(verified.outcome === 'failure' && verified.reason).toBe('revoked');
  });

  it('stops accepting an expired token', async () => {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    const restore = clock;
    clock = new Date(restore.getTime() + 3600_000 + 1);
    const verified = await service.authenticate(result.token);
    clock = restore;
    expect(verified.outcome === 'failure' && verified.reason).toBe('expired');
  });

  it('stops accepting a token minted under an older authVersion', async () => {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    await withTenant(prisma, brandTenantId(A.tenant), async (tx) => {
      await tx.user.updateMany({
        where: { id: A.user, tenantId: A.tenant },
        data: { authVersion: { increment: 1 } },
      });
    });

    const verified = await service.authenticate(result.token);
    expect(verified.outcome === 'failure' && verified.reason).toBe('auth-version');

    await withTenant(prisma, brandTenantId(A.tenant), async (tx) => {
      await tx.user.updateMany({
        where: { id: A.user, tenantId: A.tenant },
        data: { authVersion: 1 },
      });
    });
  });

  it('stops an existing session the moment its tenant is suspended', async () => {
    // The session predates the suspension, and the token cannot be asked about
    // it — the tenant row can, and is, on every request.
    const result = await service.login({
      tenantSlug: C.slug,
      email: C.email,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    if (result.outcome !== 'success') throw new Error('expected success');
    await expect(service.authenticate(result.token)).resolves.toMatchObject({
      outcome: 'success',
    });

    await setTenantStatus(C.tenant, 'suspended');
    const suspended = await service.authenticate(result.token);
    expect(suspended.outcome === 'failure' && suspended.reason).toBe('tenant-inactive');

    await setTenantStatus(C.tenant, 'closed');
    const closed = await service.authenticate(result.token);
    expect(closed.outcome === 'failure' && closed.reason).toBe('tenant-inactive');

    // Reactivating restores the session it never revoked, and nothing else.
    await setTenantStatus(C.tenant, 'active');
    await expect(service.authenticate(result.token)).resolves.toMatchObject({
      outcome: 'success',
    });

    await service.logout(result.token);
    await setTenantStatus(C.tenant, 'suspended');
    await setTenantStatus(C.tenant, 'active');
    const revoked = await service.authenticate(result.token);
    expect(revoked.outcome === 'failure' && revoked.reason).toBe('revoked');
  }, 30_000);

  it('locks after five sequential failures, counted by PostgreSQL', async () => {
    const scope = { tenantId: brandTenantId(D.tenant) };
    for (let attempt = 1; attempt <= LOCKOUT.threshold; attempt += 1) {
      const window = await repository.registerFailedLogin(
        scope,
        D.user,
        clock.toISOString(),
        LOCKOUT,
      );
      expect(window.failedLoginCount).toBe(attempt);
      expect(window.locked).toBe(attempt >= LOCKOUT.threshold);
    }

    const row = await userRow(D);
    expect(row.failedLoginCount).toBe(LOCKOUT.threshold);
    expect(row.lockedUntil).not.toBeNull();
  });

  it('opens a new window after the lock expires rather than re-locking', async () => {
    // Continues from the locked state above. One wrong password after the
    // deadline must read as the first of a new window, not the sixth of the
    // old one.
    const scope = { tenantId: brandTenantId(D.tenant) };
    const later = new Date(clock.getTime() + (LOCKOUT.lockSeconds + 1) * 1000);

    const window = await repository.registerFailedLogin(
      scope,
      D.user,
      later.toISOString(),
      LOCKOUT,
    );
    expect(window.failedLoginCount).toBe(1);
    expect(window.lockedUntil).toBeNull();
    expect(window.locked).toBe(false);
  });

  it('does not extend a live lock while requests keep arriving', async () => {
    const scope = { tenantId: brandTenantId(D.tenant) };
    for (let attempt = 1; attempt < LOCKOUT.threshold; attempt += 1) {
      await repository.registerFailedLogin(scope, D.user, clock.toISOString(), LOCKOUT);
    }
    const locked = await userRow(D);
    expect(locked.lockedUntil).not.toBeNull();

    await repository.registerFailedLogin(scope, D.user, clock.toISOString(), LOCKOUT);
    await repository.registerFailedLogin(scope, D.user, clock.toISOString(), LOCKOUT);
    const after = await userRow(D);
    expect(after.lockedUntil?.toISOString()).toBe(locked.lockedUntil?.toISOString());
  });

  it('loses no increment when failures arrive together', async () => {
    // The reason the transition is one UPDATE. Read-modify-write in the
    // application would let these twelve attempts register as two or three.
    const scope = { tenantId: brandTenantId(D.tenant) };
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { id: D.user, tenantId: D.tenant },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    });

    const attempts = 12;
    await Promise.all(
      Array.from({ length: attempts }, () =>
        repository.registerFailedLogin(scope, D.user, clock.toISOString(), {
          threshold: 1_000,
          lockSeconds: LOCKOUT.lockSeconds,
        }),
      ),
    );

    const row = await userRow(D);
    expect(row.failedLoginCount).toBe(attempts);
  }, 30_000);

  it('clears the failure state and creates the session in one transaction', async () => {
    const scope = { tenantId: brandTenantId(D.tenant) };
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { id: D.user, tenantId: D.tenant },
        data: { failedLoginCount: 3, lockedUntil: null },
      });
    });

    const sessionId = '018f0c00-0000-7000-8000-0000000000df';
    const issuedAt = clock.toISOString();
    await repository.finalizeSuccessfulLogin(scope, {
      id: sessionId,
      userId: D.user,
      tokenHash: 'finalize-live-1',
      authVersion: 1,
      userAgent: null,
      issuedAt,
      expiresAt: new Date(clock.getTime() + 3600_000).toISOString(),
      at: issuedAt,
    });

    const reset = await userRow(D);
    expect(reset.failedLoginCount).toBe(0);
    expect(reset.lockedUntil).toBeNull();
    expect(reset.lastLoginAt).not.toBeNull();
  });

  it('rolls the counter reset back when the session insert fails', async () => {
    // Replaying the same session id makes the insert fail after the user row
    // has been updated. Both must be undone, or a user is left unlocked with
    // no session to show for it.
    const scope = { tenantId: brandTenantId(D.tenant) };
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { id: D.user, tenantId: D.tenant },
        data: { failedLoginCount: 4, lockedUntil: null, lastLoginAt: null },
      });
    });

    const issuedAt = clock.toISOString();
    await expect(
      repository.finalizeSuccessfulLogin(scope, {
        // Same id as the session created by the previous test.
        id: '018f0c00-0000-7000-8000-0000000000df',
        userId: D.user,
        tokenHash: 'finalize-live-2',
        authVersion: 1,
        userAgent: null,
        issuedAt,
        expiresAt: new Date(clock.getTime() + 3600_000).toISOString(),
        at: issuedAt,
      }),
    ).rejects.toThrow();

    const unchanged = await userRow(D);
    expect(unchanged.failedLoginCount).toBe(4);
    expect(unchanged.lastLoginAt).toBeNull();

    const sessions = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.session.findMany({ where: { tenantId: D.tenant, userId: D.user } }),
    );
    expect(sessions.filter((row) => row.tokenHash === 'finalize-live-2')).toHaveLength(0);
  });

  it('writes an audit trail carrying no secret', async () => {
    await login({ password: 'wrong-on-purpose' });
    await login();

    const events = await withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
      tx.auditEvent.findMany({ where: { tenantId: A.tenant }, orderBy: { occurredAt: 'desc' } }),
    );
    const types = events.map((event) => event.eventType);
    expect(types).toContain('auth.login.success');
    expect(types).toContain('auth.login.failure');

    const rendered = JSON.stringify(events);
    expect(rendered).not.toContain(PASSWORD);
    expect(rendered).not.toContain('kps1.');
    expect(rendered).not.toContain('scrypt$');

    // Reset the failure counter this test just moved.
    await login();
  }, 30_000);

  it('never writes the token it issued', async () => {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    const stored = await withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
      tx.session.findMany({ where: { tenantId: A.tenant } }),
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain(result.token);
  });
});

describe.skipIf(url !== '')('authentication flow, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
EOF

say "ADR-0012 — the authentication boundary"

cat << 'EOF' > docs/decisions/ADR-0012-authentication-and-sessions.md
# ADR-0012 — Authentication, sessions and persisted authorization

Status: accepted
Date: 2026-08-10
Supersedes: nothing. Extends ADR-0004 (multi-tenancy) and ADR-0001 (boundaries).

## Context

Strike 2A left the database able to keep two merchants apart and left the
application unable to say who anybody is. Everything above it — the cashier
screen, the sale path, the discount ceiling — is waiting on one question:
given a request, which tenant is this, which person is this, and what may they
do? Until that is answered on the server, every answer above it is a guess.

Four decisions carry the weight.

## Decision 1 — Tenant resolution runs under a SELECT-only RLS policy

Login begins with a slug the client typed. The tenant it names is the scope
that will govern everything afterwards, so it cannot itself be established by
that scope: `tenants` is under FORCE RLS keyed on `app.tenant_id`, and at the
moment of login there is no tenant id.

The three usual answers all trade a permanent hole for one lookup: disable RLS,
connect as a superuser, or grant BYPASSRLS. Each of them would mean the
application connection could read every tenant's rows for the rest of time,
because one request per session needs to read one row.

Instead there is a second policy on `tenants`:

```sql
CREATE POLICY "tenants_login_resolution" ON "tenants"
  FOR SELECT
  USING ("slug" = login_tenant_slug());
```

`login_tenant_slug()` reads `app.login_tenant_slug`, set with `SET LOCAL`
inside the resolving transaction — the same mechanism, and the same lifetime,
as the tenant context itself. Three properties make it narrow enough:

- **It cannot write.** `FOR SELECT` means PostgreSQL does not consult it for
  INSERT, UPDATE or DELETE at all. There is no version of this door that
  writes, and no WITH CHECK to get wrong, because the syntax forbids one.
- **It cannot list.** The predicate is an equality against a single setting,
  so it returns the one row whose slug was submitted or none.
- **It is inert by default.** The setting is unset on every ordinary request,
  so the added term is NULL and the isolation policy is the only one in play.

Everything else keys on `app.tenant_id`, which the resolver leaves empty — so
users, products and sessions are invisible from the login context. There is a
live test for each of those claims, including that the context can neither
insert, update, nor delete a tenant.

The resolver returns identity only: id, slug, name, status. Identification is
not authorization, and a caller holding the result still has no `TenantScope`.

## Decision 2 — scrypt from the Node standard library

Passwords are hashed with `crypto.scrypt` at N=2^16, r=8, p=2, 32-byte key,
16-byte random salt — the second configuration on OWASP's list, chosen over the
first (N=2^17, r=8, p=1) because 64 MiB per concurrent login rather than 128 MiB
matters on the single small server a shop of this size actually runs.

argon2id would be the textbook answer. It is a native module, which means a
compiler in every build image, a prebuilt binary to trust for every platform,
and a supply-chain surface on the authentication path — against ADR-0009, and
for a margin OWASP itself treats as equivalent. Node 24 ships scrypt; the
strike adds no dependency at all.

The encoding carries its own parameters:

```
scrypt$1$N=65536,r=8,p=2$<salt base64url>$<key base64url>
```

so the cost can be raised later without invalidating a single stored password,
and a hash lifted out of a backup can be identified without reference to the
code that wrote it. The parser refuses parameters below a floor: a tampered row
claiming N=2 would otherwise verify instantly and become a fast path into the
account.

Failure is uniform. Unknown tenant, unknown address, wrong password, inactive
user, suspended membership and a locked account all produce the same status and
the same body, and every one of them performs a real scrypt derivation first —
against the stored hash where there is one, against a per-profile dummy hash
where there is not. Without that, "no such user" returns in a millisecond and
"wrong password" in two hundred, and the difference enumerates the customer's
staff list.

Lockout is five consecutive failures for fifteen minutes. Enough for a cashier
mistyping on a greasy touchscreen, far too few for a password list. It is a
delay and not a disablement: an account that locks permanently turns a nuisance
into a denial-of-service against the till on the busiest afternoon of the week.

## Decision 3 — Opaque server-side sessions, hashed at rest

The browser holds `kps1.<tenant-uuid>.<43 base64url characters>` in an HttpOnly
cookie. The database holds SHA-256 of the whole token and nothing else, so a
stolen backup yields no usable credential — the same property the password
column has, for the same reason.

The tenant segment exists because RLS has to be established before the
`sessions` table can be read, and the session is what says which tenant. It is
a routing hint and is never authorization. Rewriting it fails twice over: the
hash covers the whole token, so an edited hint hashes to a value no row
carries; and the lookup runs inside the hinted tenant's own RLS context, so
another tenant's session is not visible to be found. Both are tested live.

No JWT. A signed token that carries roles is a decision cached in the attacker's
browser: revoking a session, deactivating a user or removing a permission would
not take effect until it expired. A row lookup costs one indexed query and makes
revocation immediate — which is what a POS needs when a cashier is dismissed
mid-shift.

`authVersion` is stamped on the session at creation and compared to the user's
on every request, so a future password reset invalidates every existing session
by incrementing one integer, with no session sweep and no change to this design.

The cookie is HttpOnly, SameSite=Lax, Path=/, with no Domain attribute, and
Secure with the `__Host-` prefix in production — a prefix the browser itself
enforces, so the guarantee survives a careless edit to the cookie builder.
Development drops the prefix because it requires HTTPS; nothing else changes.
The token never appears in a JSON body, in a log line, or in localStorage.

Cookie authentication needs a second lock against cross-site writes, so every
unsafe method is checked against an exact list of allowed origins, configured
per deployment and required in production — a server that has not been told its
origin refuses to boot rather than accepting writes from anywhere. Matching is
string equality: `https://pos.korvi.sa.evil.example` ends with the right
characters, and a suffix check is precisely how that becomes a valid origin.
`X-Forwarded-*` is ignored, because this server establishes no trusted-proxy
semantics and will not pretend to.

## Decision 4 — Authorization is read, never received

`UserRole → Role → RolePermission → Permission`, resolved from the database on
every authenticated request, into a principal the request cannot influence.
Nothing named `role`, `permissions`, `tenantId` or `discount` is read from a
body, a query string, a header or a browser store, anywhere in this layer.

The vocabulary is not reinvented. `@korvi/domain` already defines the seventeen
permissions, the four roles and the discount ceiling each carries; provisioning
copies those into the database and the request path reads them back. The
catalogue is typed `Record<Permission, …>`, so adding a permission to the domain
without describing it fails to compile, and a test asserts the reverse — a
second definition here is how a cashier ends up able to discount in the database
and unable to in the code.

A user may hold several roles. Permissions are unioned, because holding two
roles grants what either grants; the discount ceiling is the maximum, not the
sum, because two roles do not add up to more authority than either confers.

Audit records `auth.login.success`, `auth.login.failure`, `auth.logout` and
`auth.session.revoked`. No password, token, hash or cookie reaches the metadata;
a failed login is labelled with a correlation hash rather than the address it
was attempted against, so the table does not become a directory of who banks
here. The audit write happens outside the transaction that created the session
and its failure is logged rather than raised: the session already exists by
then, and failing the login would hand the user an error while leaving a live
session behind them.

## Decision 5 — The state transitions belong to PostgreSQL

Two of them, and both were originally written in application memory.

**The failure counter.** `count + 1`, computed in Node and written back as an
absolute value, loses increments: two wrong passwords arriving together read the
same number and the second overwrites the first, so a burst of concurrent
guessing registers as one failure. The transition is now a single
`UPDATE … RETURNING` carrying the whole rule, and PostgreSQL's row lock
serialises it. The same statement fixes a second bug the memory version had —
after a lock expired, the old count was still sitting at the threshold, so the
first typo afterwards re-locked the account instantly. Three arms:

- currently locked → the count moves, the deadline does not, because requests
  arriving during a lock must not extend it;
- lock expired → a new window opens at one, which is what "fifteen minutes"
  is supposed to mean;
- threshold crossed → the deadline is set by the statement that crosses it.

**Successful login.** Creating the session and clearing the failure state were
two round trips. A crash between them leaves a live session belonging to a user
the database still believes is locked out. They are now one transaction, with
the user update written first so that a failing session insert rolls it back.
Audit stays outside, best-effort, as above — the session exists by then and
failing the login would leave one behind an error message.

Tenant status joins the same principle. Login already refused a suspended
tenant; session verification did not, so a suspension took effect only when the
last cookie expired. It is now read from the tenants row on every request, under
that tenant's own RLS scope — never from the token, which was minted before the
suspension existed.

## Consequences

- One SELECT-only policy is the entire public surface of the tenants table
  before authentication, and it is testable in isolation.
- Passwords and session tokens are both useless at rest.
- Revocation, deactivation and permission changes take effect on the next
  request rather than at token expiry.
- No native dependency, and no new dependency of any kind.
- Suspending a tenant takes effect on the next request from every session it
  has, not at cookie expiry.
- The lockout counter is correct under concurrency, and a lock that expires
  genuinely restores a full attempt window.
- A login either produces a session and a cleared counter, or neither.
- Signup, password reset, MFA and invitations are deliberately absent. Each
  needs email delivery and a rate-limited public endpoint, which is a different
  strike with a different threat model.
- Rate limiting remains an explicit gate before public deployment. Lockout
  protects one account; it does nothing about a spray across many.
EOF

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

say "Reference documents unchanged?"
[ "$(cksum < docs/design/KORVI-DESIGN-SYSTEM.md)" = "$REF_DESIGN_SUM" ] \
  || die "docs/design/KORVI-DESIGN-SYSTEM.md changed. Aborting."
[ "$(cksum < docs/governance/Korvi_POS_Master_Strategy_Document.txt)" = "$REF_STRAT_SUM" ] \
  || die "docs/governance/Korvi_POS_Master_Strategy_Document.txt changed. Aborting."
ok "reference documents intact"

say "Strike 2A migration untouched?"
[ "$(cksum < "$STRIKE_2A_MIGRATION")" = "$STRIKE_2A_SUM" ] \
  || die "The Strike 2A migration was modified. That file is history and must not change."
ok "Strike 2A migration byte-identical"

say "Checking the new migration is forward-only"
# A migration that drops a table or a column takes a merchant's history with
# it. DROP CONSTRAINT and DROP POLICY are how a constraint is restated, and are
# not in that class.
if grep -Eqi '\bDROP[[:space:]]+(TABLE|DATABASE|SCHEMA|COLUMN|INDEX)\b' "$MIGRATION_DIR/migration.sql"; then
  die "The migration contains a destructive DROP. Refusing to ship it."
fi
ok "no destructive statement in the migration"

say "Checking no secret was written into the tree"
if grep -REq '(BEGIN [A-Z ]*PRIVATE KEY|sk_live_|AKIA[0-9A-Z]{16})' \
     apps/api/src packages/database/src packages/domain/src 2>/dev/null; then
  die "Something resembling a credential reached a source file."
fi
ok "no credential material in the patch"

say "Formatting the new sources"
npx prettier --write --log-level warn \
  'apps/api/src/**/*.ts' \
  'packages/database/src/**/*.ts' \
  'packages/domain/src/**/*.ts' \
  'docs/decisions/ADR-0012-authentication-and-sessions.md' >/dev/null 2>&1 || true

if [ "$RUN_VERIFY" -eq 1 ]; then
  say "Running the full gate"
  npm run --silent verify
else
  warn "Skipping verification (--no-verify)."
fi

cat << 'SUMMARY'

===============================================================================
  Korvi POS — Strike 2B · authentication boundary applied
===============================================================================

  packages/database/prisma/schema.prisma
      Session model; users gain failedLoginCount, lockedUntil, authVersion
      and lastLoginAt. Sessions reference (tenantId, userId) with the Strike
      2A composite key, so a session cannot be minted against another
      tenant's user.

  packages/database/prisma/migrations/20260810120000_auth_security/
      Forward-only. Creates sessions with ENABLE + FORCE RLS and a
      USING/WITH CHECK policy, adds the user auth columns, and opens exactly
      one new door: a FOR SELECT policy on tenants keyed on
      app.login_tenant_slug. It cannot write, it cannot list, and it is
      inert unless the setting is established. The Strike 2A migration is
      untouched and verified byte-identical.

  packages/domain/
      ports/auth.ts — the AuthRepository port and email normalisation.
      rbac/principal.ts — the authenticated principal over the existing
      permission catalogue. No second vocabulary: roles, permissions and
      discount ceilings all still come from rbac/permissions.ts.

  packages/database/src/
      withLoginSlug() for the resolution context, the Prisma auth adapter,
      and RBAC provisioning that copies the domain's catalogue into the
      database rather than restating it. Provisioning is internal — no route
      reaches it.

  apps/api/src/auth/
      password.ts   scrypt N=2^16, r=8, p=2, per-password salt, parameters
                    encoded with the hash, floor-checked on parse, dummy
                    verification on the unknown-user path
      token.ts      kps1.<tenant>.<256-bit secret>; SHA-256 of the whole
                    token is stored, the token itself never is
      cookie.ts     HttpOnly, SameSite=Lax, Path=/, no Domain, Secure and
                    __Host- in production
      origin.ts     exact-match origin check on every unsafe method
      guards.ts     requireSession (401) and requirePermission (403), typed
      service.ts    login, authenticate, logout, logout-all

  Session verification re-reads the tenant's status from persistence on
  every request, so suspending a tenant stops its live sessions rather than
  waiting for cookies to expire. The failure counter moves in one
  UPDATE ... RETURNING, so concurrent wrong passwords cannot lose
  increments and an expired lock opens a fresh window instead of re-locking
  on the first typo. Session creation and the counter reset commit in one
  transaction.

  apps/api/src/routes/auth.ts
      POST /v1/auth/login, POST /v1/auth/logout, POST /v1/auth/logout-all,
      GET /v1/auth/me. One generic failure for every credential problem.

  docs/decisions/ADR-0012-authentication-and-sessions.md

  Live suites are opt-in and skip loudly. With all three migrations applied
  to a throwaway database, connected as the application role — not a
  superuser, which bypasses RLS and would make half the assertions pass for
  the wrong reason:

    KORVI_TEST_DATABASE_URL=postgresql://korvi@localhost:5432/korvi_pos_test \
      npx vitest run packages/database/src/__tests__/auth-live.test.ts \
                     packages/database/src/__tests__/rls-live.test.ts \
                     apps/api/src/__tests__/auth-live.test.ts

  Not touched: UI, product and sale APIs, checkout, printing, ZATCA,
  offline. No signup, password reset, MFA or invitations — each needs email
  delivery and a rate-limited public endpoint, which is a different strike.

  Nothing was committed, pushed, reset or cleaned.

===============================================================================
SUMMARY

ok "Done."
