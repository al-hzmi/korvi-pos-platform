#!/usr/bin/env bash
#
# setup-korvi-strike3a2-cashier-ui-release.sh — Korvi POS · Strike 3A-2
#
# The cashier interface, on top of Strike 3A-1 (main @ 75a48af):
#
#   login -> terminal -> shift -> cashier -> checkout -> success
#
# The browser sends identifiers, quantities and the cash it was handed, and
# nothing else. Prices, VAT, totals, change, receipt numbers and every
# security decision stay on the server, exactly where Strike 3A-1 put them.
#
# One narrow server addition: GET /v1/terminals, so the till can discover its
# own identity instead of being told one by a human typing a UUID.
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

# No --no-verify and no --allow-dirty.
#
# Earlier strikes carried both, and they earned their keep while a patch was
# still being written. This is the production artifact for the screen that
# takes money, and a flag that skips its own gate is a flag somebody will use
# at the wrong moment. There is one way to run this script and it is the way
# that proves itself.
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg
     This artifact has no bypass modes. Commit or stash your work and re-run." ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Not inside a git repository."
cd "$ROOT"

[ "$(node -p "require('./package.json').name" 2>/dev/null)" = "korvi-pos-platform" ] \
  || die "This is not korvi-pos-platform. Refusing to patch an unexpected repository."

BASELINE=75a48af
if git cat-file -e "${BASELINE}^{commit}" 2>/dev/null; then
  git merge-base --is-ancestor "$BASELINE" HEAD 2>/dev/null \
    || die "HEAD does not descend from $BASELINE."
else
  die "Commit $BASELINE is not in this repository. Fetch origin/main first."
fi

STRIKE_2A_MIGRATION=packages/database/prisma/migrations/20260808120000_saas_foundation/migration.sql
STRIKE_2B_MIGRATION=packages/database/prisma/migrations/20260810120000_auth_security/migration.sql
for required in \
  "$STRIKE_2A_MIGRATION" \
  "$STRIKE_2B_MIGRATION" \
  docs/decisions/ADR-0013-checkout-transaction-and-idempotency.md \
  docs/design/KORVI-DESIGN-SYSTEM.md \
  tsconfig.tests.json \
  apps/api/src/routes/business.ts \
  apps/api/src/routes/validation.ts \
  apps/api/src/routes/auth.ts \
  apps/api/src/auth/guards.ts \
  apps/api/src/checkout/service.ts \
  apps/api/src/server.ts \
  apps/api/src/__tests__/business-routes.test.ts \
  apps/api/src/__tests__/support/memory-business.ts \
  apps/pos-web/src/app/layout.tsx \
  apps/pos-web/next.config.ts \
  packages/ui/src/index.ts \
  packages/domain/src/ports/persistence.ts
do
  [ -f "$required" ] || die "Baseline file missing: $required
     This patch expects Strike 3A-1 (main @ $BASELINE)."
done

grep -q 'requirePermission' apps/api/src/auth/guards.ts   || die "Auth guards missing; baseline mismatch."
grep -q "'/v1/sales'"      apps/api/src/routes/business.ts || die "Strike 3A-1 sale route missing."
grep -q 'listForBranch'    packages/domain/src/ports/persistence.ts || die "TerminalRepository.listForBranch missing."
grep -q 'typecheck:tests'  package.json                    || die "The test typecheck gate is missing; baseline mismatch."
grep -q 'FORCE ROW LEVEL SECURITY' "$STRIKE_2A_MIGRATION"  || die "RLS markers missing; baseline mismatch."
grep -q 'login_tenant_slug'        "$STRIKE_2B_MIGRATION"  || die "Strike 2B markers missing; baseline mismatch."

# Both migrations are history. Nothing here may edit either.
SUM_2A="$(cksum < "$STRIKE_2A_MIGRATION")"
SUM_2B="$(cksum < "$STRIKE_2B_MIGRATION")"
REF_DESIGN_SUM="$(cksum < docs/design/KORVI-DESIGN-SYSTEM.md)"
REF_ADR13_SUM="$(cksum < docs/decisions/ADR-0013-checkout-transaction-and-idempotency.md)"
SUM_CHECKOUT="$(cksum < apps/api/src/checkout/service.ts)"
SUM_SALEREPO="$(cksum < packages/database/src/repositories/sale-repository.ts)"

# Every path this script may write to, so nothing uncommitted is overwritten.
# The list is exhaustive on purpose: a file the patch edits but the guard does
# not name is a file somebody loses work in.
OWNED_PATHS="
apps/pos-web
apps/api/src
packages/ui/src
packages/database/package.json
docs/decisions
eslint.config.js
tsconfig.tests.json
vitest.config.ts
package.json
package-lock.json
"
# shellcheck disable=SC2086
DIRTY="$(git status --porcelain -- $OWNED_PATHS 2>/dev/null || true)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" | sed 's/^/     /' >&2
  die "Uncommitted changes under a path this patch owns.
     Commit or stash them first. There is no override."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" = "24" ] || die "Node 24 LTS required (ADR-0007). Found $(node --version)."

ok "Baseline verified · $BASELINE in ancestry · Node $(node --version) · $(git rev-parse --short HEAD)"

mkdir -p apps/pos-web/src/lib/__tests__ apps/pos-web/src/components apps/pos-web/src/hooks \
         apps/pos-web/src/__tests__ apps/api/src/__tests__

say "API — the till discovers its own identity"

python3 - <<'PY'
import sys
path = 'apps/api/src/routes/business.ts'
s = open(path, encoding='utf-8').read()
if "'/v1/terminals'" in s:
    print('  already present'); sys.exit(0)

ROUTE = """  /**
   * The tills of the branch this session belongs to.
   *
   * Strike 3A-1 requires a terminal id on every shift and sale route, and was
   * right to: a sale has to be attributable to a physical till. But that left
   * the browser with no lawful way to learn one, and the alternatives are all
   * worse than an endpoint — a hardcoded UUID, a constant in the frontend, or
   * a cashier typing one in.
   *
   * The branch is read from `request.auth`, never from the query. A client
   * that could name a branch could enumerate every till in the tenant, and the
   * whole point of pinning a principal to a branch is that it cannot.
   *
   * `shift.open` rather than a new permission: discovering the till is the
   * first half of opening a shift on it, and the vocabulary in
   * packages/domain/src/rbac is not something a UI strike gets to extend.
   */
  app.get(
    '/v1/terminals',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.open')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      // A principal with no branch has no till to be at. Deterministic and
      // named, so the browser can render an operational message rather than
      // guessing from an empty list.
      if (principal.branchId === null) {
        return reply.code(409).send({
          error: 'branch_required',
          message: 'لا يوجد فرع مرتبط بهذا المستخدم. راجع إعدادات المنشأة.',
        });
      }

      const scope = scopeOf(principal);

      // The price mode travels with the till, and only from here. A browser
      // that guessed it would show a total the server disagrees with on every
      // tax-exclusive tenant; a browser that could *send* it would be deciding
      // how much VAT a sale carries. Read under the scope, like everything
      // else, and never accepted from a request.
      const settings = await deps.tenants.settings(scope);
      if (settings === null) {
        return reply.code(409).send({
          error: 'tenant-misconfigured',
          message: '\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u0645\u0646\u0634\u0623\u0629 \u063a\u064a\u0631 \u0645\u0643\u062a\u0645\u0644\u0629.',
        });
      }

      const terminals = await deps.terminals.listForBranch(scope, principal.branchId);
      // A deactivated till is not offered. Selecting one would only produce a
      // 404 from the shift route a moment later.
      return reply.code(200).send({
        branchId: principal.branchId,
        settings: { priceMode: settings.priceMode, currency: settings.currency },
        terminals: terminals
          .filter((terminal) => terminal.isActive)
          .map((terminal) => ({
            id: terminal.id,
            code: terminal.code,
            label: terminal.label,
            branchId: terminal.branchId,
          })),
      });
    },
  );

  app.get(
    '/v1/shifts/current',"""

old = """  app.get(
    '/v1/shifts/current',"""
assert old in s
s = s.replace(old, ROUTE, 1)

s = s.replace(
    """ * The cashier's server surface. Four routes, and nothing a till does not need.""",
    """ * The cashier's server surface. Five routes, and nothing a till does not need.""",
    1,
)
open(path, 'w', encoding='utf-8').write(s)
print('  GET /v1/terminals added')
PY

say "API — tests for terminal discovery"

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/business-routes.test.ts'
s = open(path, encoding='utf-8').read()
if "describe('GET /v1/terminals'" in s:
    print('  already present'); sys.exit(0)

BLOCK = """describe('GET /v1/terminals', () => {
  it('refuses without a session', async () => {
    app = await build('cashier');
    const response = await app.inject({ method: 'GET', url: '/v1/terminals' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the active tills of the session\\u2019s own branch', async () => {
    app = await build('cashier');
    business.terminals.push({
      id: '018f2000-0000-7000-8000-0000000000b1',
      tenantId: business.terminals[0]!.tenantId,
      branchId: A.branch,
      code: '02',
      label: '\\u0635\\u0646\\u062f\\u0648\\u0642 \\u0662',
      isActive: true,
      lastSeenAt: null,
    });
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ branchId: string; terminals: { code: string }[] }>();
    expect(body.branchId).toBe(A.branch);
    expect(body.terminals.map((terminal) => terminal.code).sort()).toEqual(['01', '02']);
    // Only what a till needs to identify itself.
    expect(Object.keys(body.terminals[0] ?? {}).sort()).toEqual([
      'branchId',
      'code',
      'id',
      'label',
    ]);
  });

  it('never offers a deactivated till', async () => {
    app = await build('cashier');
    business.terminals[0] = { ...business.terminals[0]!, isActive: false };
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });
    expect(response.json<{ terminals: unknown[] }>().terminals).toHaveLength(0);
  });

  it('ignores a branch the client tries to name', async () => {
    // The one thing this endpoint must never do. A client that could choose a
    // branch could enumerate every till in the tenant.
    app = await build('cashier');
    business.terminals.push({
      id: '018f2000-0000-7000-8000-0000000000b2',
      tenantId: business.terminals[0]!.tenantId,
      branchId: '018f2000-0000-7000-8000-0000000000c9',
      code: '99',
      label: '\\u0641\\u0631\\u0639 \\u0622\\u062e\\u0631',
      isActive: true,
      lastSeenAt: null,
    });
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/terminals?branchId=018f2000-0000-7000-8000-0000000000c9',
      headers: { cookie },
    });
    const body = response.json<{ branchId: string; terminals: { code: string }[] }>();
    expect(body.branchId).toBe(A.branch);
    expect(body.terminals.map((terminal) => terminal.code)).toEqual(['01']);
  });

  it('says branch context is required when the principal has no branch', async () => {
    app = await build('cashier');
    auth.memberships[0] = { ...auth.memberships[0]!, defaultBranchId: null };
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'branch_required' });
  });

  it('carries the tenant\u2019s price mode so the till never guesses it', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });

    const body = response.json<{ settings: { priceMode: string; currency: string } }>();
    expect(body.settings).toEqual({ priceMode: 'tax-inclusive', currency: 'SAR' });
  });

  it('reports a tenant with no settings rather than inventing a price mode', async () => {
    app = await build('cashier');
    business.settings.length = 0;
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'tenant-misconfigured' });
  });

  it('ignores a price mode the client tries to send', async () => {
    // The one thing that would let a browser decide how much VAT a sale
    // carries.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/terminals?priceMode=tax-exclusive&currency=USD',
      headers: { cookie },
    });
    expect(response.json<{ settings: { priceMode: string; currency: string } }>().settings).toEqual({
      priceMode: 'tax-inclusive',
      currency: 'SAR',
    });
  });

  it('refuses a caller without shift.open', async () => {
    app = await build('cashier');
    auth.grants[0] = {
      tenantId: A.tenant,
      userId: A.user,
      roles: ['cashier'],
      permissions: ['sale.create'],
    };
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /v1/products', () => {"""

old = "describe('GET /v1/products', () => {"
assert old in s
s = s.replace(old, BLOCK, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  terminal route tests added')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/routes/business.ts'
s = open(path, encoding='utf-8').read()
if 'readonly tenants: TenantRepository;' in s:
    print('  already wired'); sys.exit(0)

s = s.replace(
    """export interface BusinessDeps {
  readonly products: ProductRepository;""",
    """export interface BusinessDeps {
  /** Read-only, and only for the settings the till has to render correctly. */
  readonly tenants: TenantRepository;
  readonly products: ProductRepository;""",
    1,
)
s = s.replace(
    """  ProductRepository,
  ShiftRepository,
  TenantScope,
  TerminalRepository,
} from '@korvi/domain';""",
    """  ProductRepository,
  ShiftRepository,
  TenantRepository,
  TenantScope,
  TerminalRepository,
} from '@korvi/domain';""",
    1,
)
open(path, 'w', encoding='utf-8').write(s)
print('  BusinessDeps carries the tenant repository')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/server.ts'
s = open(path, encoding='utf-8').read()
if 'tenants: createTenantRepository(prisma)' in s and 'tenants: {' in s:
    print('  already wired'); sys.exit(0)

old = """    const terminals = createTerminalRepository(prisma);
    built = {
      products,
      shifts,
      terminals,"""
new = """    const terminals = createTerminalRepository(prisma);
    const tenants = createTenantRepository(prisma);
    built = {
      tenants,
      products,
      shifts,
      terminals,"""
assert old in s
s = s.replace(old, new, 1)

s = s.replace(
    """      checkout: createCheckoutService({
        tenants: createTenantRepository(prisma),
        products,""",
    """      checkout: createCheckoutService({
        tenants,
        products,""",
    1,
)

old = """  return {
    products: {
      findById: (scope, id) => resolve().products.findById(scope, id),"""
new = """  return {
    tenants: {
      current: (scope) => resolve().tenants.current(scope),
      settings: (scope) => resolve().tenants.settings(scope),
    },
    products: {
      findById: (scope, id) => resolve().products.findById(scope, id),"""
assert old in s
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  server wiring updated')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/business-routes.test.ts'
s = open(path, encoding='utf-8').read()
old = """    business: {
      products: memoryProductRepository(business),"""
new = """    business: {
      tenants: memoryTenantRepository(business),
      products: memoryProductRepository(business),"""
# Matched on the whole anchor, not on a substring: `tenants:` already appears
# inside createCheckoutService below, and checking for that alone would report
# this patch as applied when it had not been.
if new in s:
    print('  already wired'); sys.exit(0)
assert old in s
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  route test wiring updated')
PY

say "API — a till in another branch is not a till this cashier may address"

python3 - <<'PY'
import sys
path = 'apps/api/src/routes/business.ts'
s = open(path, encoding='utf-8').read()
if 'ownBranchTerminal' in s:
    print('  already enforced'); sys.exit(0)

HELPERS = '''
/**
 * The two answers a till-addressed route may give before it does any work.
 *
 * `branch_required` is a configuration problem the merchant can fix.
 * `unknown_terminal` is deliberately the same answer for a till that does not
 * exist, a till that has been deactivated, and a till in another branch — a
 * principal pinned to branch A learns nothing about branch B from either the
 * status code or the body.
 */
const BRANCH_REQUIRED = {
  error: 'branch_required',
  message: 'لا يوجد فرع مرتبط بهذا المستخدم. راجع إعدادات المنشأة.',
} as const;

const UNKNOWN_TERMINAL = { error: 'unknown_terminal', message: 'الصندوق غير معروف.' } as const;

/**
 * Prove a terminal id is one this principal may name at all.
 *
 * The tenant scope is not enough. RLS keeps one merchant out of another
 * merchant's rows, but every branch of one merchant shares a tenant, so a
 * cashier pinned to branch A who guesses or is given a terminal id from
 * branch B is inside the scope already. Listing only their own branch's tills
 * in GET /v1/terminals shapes the interface; it does not authorise anything,
 * and an interface is not where authorisation lives.
 *
 * So every route that takes a `terminalId` proves three things here first:
 * the till exists in this tenant, it is active, and it belongs to the branch
 * the session is pinned to. A failure of any of them is indistinguishable
 * from the others.
 */
async function ownBranchTerminal(
  terminals: TerminalRepository,
  principal: AuthenticatedPrincipal,
  terminalId: string,
): Promise<Terminal | null> {
  const terminal = await terminals.findById(scopeOf(principal), terminalId);
  if (terminal === null || !terminal.isActive) return null;
  return terminal.branchId === principal.branchId ? terminal : null;
}
'''

anchor = """export function registerBusinessRoutes("""
assert anchor in s
s = s.replace(anchor, HELPERS.strip() + '\n\n' + anchor, 1)

s = s.replace(
    """import type {
  AuthenticatedPrincipal,
  ProductRepository,""",
    """import type {
  AuthenticatedPrincipal,
  ProductRepository,""",
    1,
)
s = s.replace(
    """  ShiftRepository,
  TenantRepository,
  TenantScope,
  TerminalRepository,
} from '@korvi/domain';""",
    """  ShiftRepository,
  TenantRepository,
  TenantScope,
  Terminal,
  TerminalRepository,
} from '@korvi/domain';""",
    1,
)

# --- GET /v1/terminals: one shared literal ---------------------------------
s = s.replace(
    """      if (principal.branchId === null) {
        return reply.code(409).send({
          error: 'branch_required',
          message: 'لا يوجد فرع مرتبط بهذا المستخدم. راجع إعدادات المنشأة.',
        });
      }""",
    """      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);""",
    1,
)

# --- GET /v1/shifts/current ------------------------------------------------
old = """      const parsed = currentShiftQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const shift = await deps.shifts.findOpenForTerminal(
        scopeOf(principal),
        parsed.data.terminalId,
      );
      if (shift === null) return reply.code(200).send({ shift: null });"""
new = """      // Branch context is mandatory for the cashier vertical. Without it there
      // is no set of tills this principal may ask about, and answering for an
      // arbitrary one is the defect this refuses.
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const parsed = currentShiftQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      // Before any shift is read. A shift row carries the branch, the cashier,
      // the opening float and the time it started — none of which a cashier in
      // another branch should be able to see.
      const terminal = await ownBranchTerminal(
        deps.terminals,
        principal,
        parsed.data.terminalId,
      );
      if (terminal === null) return reply.code(404).send(UNKNOWN_TERMINAL);

      const shift = await deps.shifts.findOpenForTerminal(scopeOf(principal), terminal.id);
      if (shift === null) return reply.code(200).send({ shift: null });"""
assert old in s, 'shifts/current anchor'
s = s.replace(old, new, 1)

# --- POST /v1/shifts/open --------------------------------------------------
old = """      const scope = scopeOf(principal);
      // The branch comes from the terminal, not from the request: a till is
      // physically in one branch and the client has no standing to say which.
      const terminal = await deps.terminals.findById(scope, parsed.data.terminalId);
      if (terminal === null || !terminal.isActive) {
        return reply.code(404).send({ error: 'unknown_terminal', message: 'الصندوق غير معروف.' });
      }"""
new = """      const scope = scopeOf(principal);
      // The branch comes from the terminal, not from the request: a till is
      // physically in one branch and the client has no standing to say which.
      // But which tills this principal may name is a separate question, and
      // opening a real shift on another branch's till is a write, not a peek.
      const terminal = await ownBranchTerminal(deps.terminals, principal, parsed.data.terminalId);
      if (terminal === null) return reply.code(404).send(UNKNOWN_TERMINAL);"""
assert old in s, 'shifts/open anchor'
s = s.replace(old, new, 1)

# The branch check has to come before the body is even parsed, so a branchless
# principal cannot probe the till space at all.
old = """      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      const parsed = openShiftBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });"""
new = """      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      const parsed = openShiftBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });"""
assert old in s, 'shifts/open branch guard anchor'
s = s.replace(old, new, 1)

open(path, 'w', encoding='utf-8').write(s)
print('  branch authorisation enforced on both shift routes')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/support/memory-business.ts'
s = open(path, encoding='utf-8').read()
if 'openingMovements' in s:
    print('  already recording'); sys.exit(0)

s = s.replace(
    """  public audit: AuditEventInput[] = [];""",
    """  public audit: AuditEventInput[] = [];
  /** Opening-float movement ids, so a test can prove none was written. */
  public openingMovements: string[] = [];""",
    1,
)
s = s.replace(
    """      store.shifts.push(shift);
      return Promise.resolve(shift);""",
    """      store.shifts.push(shift);
      store.openingMovements.push(input.openingMovementId);
      return Promise.resolve(shift);""",
    1,
)
open(path, 'w', encoding='utf-8').write(s)
print('  opening-float movements recorded')
PY

say "API — tests for branch authorisation on the shift routes"

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/business-routes.test.ts'
s = open(path, encoding='utf-8').read()
if "describe('branch authorisation'" in s:
    print('  already present'); sys.exit(0)

BLOCK = """describe('branch authorisation', () => {
  /*
   * A second branch of the SAME tenant, with its own till.
   *
   * RLS keeps one merchant out of another merchant's rows; it has nothing to
   * say about one branch of a merchant reaching into another, because both
   * are inside the same tenant scope. A cashier pinned to branch A who is
   * handed a terminal id from branch B is already past every check the scope
   * performs, so the routes have to make that check themselves.
   *
   * GET /v1/terminals listing only branch A's tills shapes the interface. It
   * is not an authorisation boundary and is not treated as one here.
   */
  const OTHER_BRANCH = '018f2000-0000-7000-8000-0000000000d1';
  const OTHER_TERMINAL = '018f2000-0000-7000-8000-0000000000d2';

  function addForeignTerminal(): void {
    business.terminals.push({
      id: OTHER_TERMINAL,
      tenantId: business.terminals[0]!.tenantId,
      branchId: OTHER_BRANCH,
      code: '90',
      // Open, staffed and real. It simply is not this cashier's branch.
      label: '\\u0635\\u0646\\u062f\\u0648\\u0642 \\u0641\\u0631\\u0639 \\u0622\\u062e\\u0631',
      isActive: true,
      lastSeenAt: null,
    });
    business.shifts.push({
      id: '018f2000-0000-7000-8000-0000000000d3',
      tenantId: business.terminals[0]!.tenantId,
      branchId: OTHER_BRANCH,
      terminalId: OTHER_TERMINAL,
      userId: '018f2000-0000-7000-8000-0000000000d4',
      status: 'open',
      openingFloatMinor: '75000',
      declaredCashMinor: null,
      expectedCashMinor: null,
      varianceMinor: null,
      openedAt: '2026-08-12T05:00:00.000Z',
      closedAt: null,
      movements: [],
    });
  }

  it('answers for the cashier\\u2019s own till', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${A.terminal}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ shift: { terminalId: string } }>().shift.terminalId).toBe(A.terminal);
  });

  it('will not read a shift on another branch\\u2019s till, and leaks nothing about it', async () => {
    app = await build('cashier');
    addForeignTerminal();
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${OTHER_TERMINAL}`,
      headers: { cookie },
    });

    // Exactly what an id that does not exist would produce. A 403 would
    // confirm the till is real, which is the thing being withheld.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'unknown_terminal' });

    const body = response.payload;
    expect(body).not.toContain('75000');
    expect(body).not.toContain(OTHER_BRANCH);
    expect(body).not.toContain('018f2000-0000-7000-8000-0000000000d3');
    expect(body).not.toContain('018f2000-0000-7000-8000-0000000000d4');
    expect(body).not.toContain('2026-08-12T05:00:00.000Z');
    expect(body).not.toContain('shift');
  });

  it('gives the same answer for a till that never existed', async () => {
    app = await build('cashier');
    addForeignTerminal();
    const cookie = await cookieFor(app);
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/shifts/current?terminalId=018f2000-0000-7000-8000-00000000dead',
      headers: { cookie },
    });
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${OTHER_TERMINAL}`,
      headers: { cookie },
    });

    expect(missing.statusCode).toBe(foreign.statusCode);
    expect(missing.payload).toBe(foreign.payload);
  });

  it('will not open a shift on another branch\\u2019s till', async () => {
    app = await build('cashier', false);
    addForeignTerminal();
    const before = business.shifts.length;
    const cookie = await cookieFor(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: OTHER_TERMINAL, openingFloatMinor: '20000' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'unknown_terminal' });
    // Nothing was written: not a shift, and not the opening-float movement
    // that would have gone with it.
    expect(business.shifts).toHaveLength(before);
    expect(business.shifts.some((shift) => shift.terminalId === OTHER_TERMINAL && shift.branchId === A.branch)).toBe(false);
    expect(business.openingMovements).toHaveLength(0);
  });

  it('still opens a shift on the cashier\\u2019s own till', async () => {
    app = await build('cashier', false);
    addForeignTerminal();
    const cookie = await cookieFor(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: A.terminal, openingFloatMinor: '20000' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ shift: { branchId: string } }>().shift.branchId).toBe(A.branch);
    expect(business.openingMovements).toHaveLength(1);
  });

  it('refuses a deactivated till in the cashier\\u2019s own branch', async () => {
    app = await build('cashier', false);
    business.terminals[0] = { ...business.terminals[0]!, isActive: false };
    const cookie = await cookieFor(app);

    const current = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${A.terminal}`,
      headers: { cookie },
    });
    expect(current.statusCode).toBe(404);
  });

  describe('a principal with no branch', () => {
    async function branchless(): Promise<string> {
      app = await build('cashier');
      auth.memberships[0] = { ...auth.memberships[0]!, defaultBranchId: null };
      return cookieFor(app);
    }

    it('cannot read a shift', async () => {
      const cookie = await branchless();
      const response = await app.inject({
        method: 'GET',
        url: `/v1/shifts/current?terminalId=${A.terminal}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'branch_required' });
    });

    it('cannot open a shift', async () => {
      const cookie = await branchless();
      const before = business.shifts.length;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/shifts/open',
        headers: { cookie, origin: ORIGIN },
        payload: { terminalId: A.terminal, openingFloatMinor: '20000' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'branch_required' });
      expect(business.shifts).toHaveLength(before);
    });

    it('cannot list tills', async () => {
      const cookie = await branchless();
      const response = await app.inject({ method: 'GET', url: '/v1/terminals', headers: { cookie } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'branch_required' });
    });
  });

  it('never lets a branch arrive from the client', async () => {
    app = await build('cashier', false);
    addForeignTerminal();
    const cookie = await cookieFor(app);

    // In the body: rejected outright by the forbidden-field guard.
    const named = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: A.terminal, openingFloatMinor: '20000', branchId: OTHER_BRANCH },
    });
    expect(named.statusCode).toBe(400);
    expect(named.json()).toMatchObject({ error: 'forbidden_field', field: 'branchId' });

    // In the query: ignored, and the foreign till stays invisible.
    const smuggled = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${OTHER_TERMINAL}&branchId=${OTHER_BRANCH}`,
      headers: { cookie },
    });
    expect(smuggled.statusCode).toBe(404);
  });
});

describe('GET /v1/terminals', () => {"""

old = "describe('GET /v1/terminals', () => {"
assert old in s
s = s.replace(old, BLOCK, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  branch authorisation tests added')
PY

say "Web — the same-origin topology"

cat << 'EOF' > apps/pos-web/src/lib/api-origin.ts
/**
 * Where the Next server forwards /v1/* to.
 *
 * The browser never speaks to Fastify directly. It calls its own origin, Next
 * rewrites the path to the API, and the session cookie stays a first-party
 * cookie on the host the user actually typed. That is what keeps `__Host-`
 * usable, keeps SameSite=Lax meaningful, and keeps the Origin header on an
 * unsafe request equal to the browser's real origin — which is the exact value
 * Strike 2B checks against APP_ORIGINS (ADR-0014).
 *
 * Pure and separate from next.config.ts so it can be tested. A rewrite
 * destination is baked into the build, and a wrong one is a proxy to somewhere
 * nobody chose.
 */

/** Loopback, so an unconfigured deployment fails to connect rather than reaching a stranger. */
export const DEVELOPMENT_API_ORIGIN = 'http://127.0.0.1:3001';

export class ApiOriginError extends Error {
  public override readonly name = 'ApiOriginError';
}

/**
 * Validate KORVI_API_ORIGIN, or fall back to loopback.
 *
 * An absolute http(s) origin and nothing else: a value carrying a path, a
 * query or credentials is a misconfiguration that would silently rewrite every
 * API call somewhere unintended, so it stops the build instead.
 */
export function resolveApiOrigin(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return DEVELOPMENT_API_ORIGIN;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiOriginError(`KORVI_API_ORIGIN is not a URL: "${value}".`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiOriginError(`KORVI_API_ORIGIN must be http or https, got "${url.protocol}".`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ApiOriginError('KORVI_API_ORIGIN must not carry credentials.');
  }
  if (url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ApiOriginError(
      `KORVI_API_ORIGIN must be a bare origin with no path, got "${value}".`,
    );
  }
  return url.origin;
}
EOF

cat << 'EOF' > apps/pos-web/next.config.ts
import { resolveApiOrigin } from './src/lib/api-origin';
import type { NextConfig } from 'next';

/**
 * Same-origin topology (ADR-0014).
 *
 * The browser calls /v1/* on its own origin; Next forwards it to Fastify. No
 * CORS is involved anywhere, because nothing ever crosses an origin: the
 * cookie is first-party, and the Origin header Fastify checks is the browser's
 * real one rather than something a proxy invented.
 *
 * Nothing here makes a security decision. Next carries bytes; Fastify decides.
 */
const apiOrigin = resolveApiOrigin(process.env['KORVI_API_ORIGIN']);

const config: NextConfig = {
  reactStrictMode: true,
  // @korvi/ui ships compiled JS, but transpiling it here keeps source maps
  // pointing at the real TSX during development.
  transpilePackages: ['@korvi/ui'],
  typedRoutes: true,
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${apiOrigin}/v1/:path*` }];
  },
};

export default config;
EOF

say "Web — money and quantity, without a float in sight"

cat << 'EOF' > apps/pos-web/src/lib/parse.ts
/**
 * The shape every parser in the till returns.
 *
 * A thrown exception is the wrong tool for "the cashier has typed 1.2 so far":
 * that is an ordinary keystroke on the way to a valid number, not an error.
 */
export type ParseFailure = 'empty' | 'format' | 'precision' | 'not-positive';

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: ParseFailure };

export function parsed<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

export function unparsed<T>(reason: ParseFailure): Parsed<T> {
  return { ok: false, reason };
}
EOF

cat << 'EOF' > apps/pos-web/src/lib/money.ts
import { moneyFromMajorString, moneyToMajorString } from '@korvi/domain';
import { parsed, unparsed } from './parse';
import type { Money } from '@korvi/domain';
import type { Parsed } from './parse';

/**
 * SAR at the keyboard.
 *
 * Everything crosses the wire as an integer string of halalas, and every
 * conversion between that and what a cashier types goes through here. There is
 * no Number() on this path and no toFixed: `19.99` is not representable in
 * binary floating point, and a till that loses a halala per sale loses a
 * reconciliation nobody can explain (ADR-0002).
 *
 * The parsing itself is delegated to @korvi/domain rather than reimplemented,
 * so the browser and the server agree by construction.
 */

/** What a person may type: digits, optionally a point, at most two more digits. */
const SAR_KEYSTROKES = /^\d{1,12}(?:\.\d{0,2})?$/;

/**
 * A partially-typed amount, accepted so the field does not fight the cashier.
 *
 * "12." is on the way to "12.50"; it is not an error yet, and it means twelve.
 */
function normalize(input: string): string {
  const trimmed = input.trim();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

export function parseSarToMinor(input: string): Parsed<string> {
  const trimmed = input.trim();
  if (trimmed === '') return unparsed('empty');
  if (!SAR_KEYSTROKES.test(trimmed)) {
    // Told apart on purpose: "1.234" is a precision problem the cashier can
    // fix by deleting a digit, and "1e3" is not a number they meant to type.
    return unparsed(/^\d+\.\d{3,}$/.test(trimmed) ? 'precision' : 'format');
  }
  try {
    return parsed(moneyFromMajorString(normalize(trimmed)).minor.toString());
  } catch {
    return unparsed('format');
  }
}

/** Halalas as they arrived from the server, rendered for a human. */
export function formatMinor(minor: string): string {
  return moneyToMajorString({ currency: 'SAR', minor: BigInt(minor) });
}

export function formatMoney(value: Money): string {
  return moneyToMajorString(value);
}

/** Change owed, as a string, or null when the cash does not cover the total. */
export function changeMinor(totalMinor: string, cashMinor: string): string | null {
  const difference = BigInt(cashMinor) - BigInt(totalMinor);
  return difference < 0n ? null : difference.toString();
}
EOF

cat << 'EOF' > apps/pos-web/src/lib/quantity.ts
import {
  QUANTITY_SCALE,
  quantity as brandQuantity,
  quantityFromDecimalString,
  quantityToDisplayString,
} from '@korvi/domain';
import { parsed, unparsed } from './parse';
import type { ProductType } from '@korvi/domain';
import type { Parsed } from './parse';

/**
 * Quantity at the keyboard, scaled by 1000 (ADR-0002 applied to weight).
 *
 * A unit product cannot be sold in thirds, so it is a whole number of units
 * here and a multiple of the scale on the wire. A weighted product carries up
 * to three decimals, which is what a retail scale reports and what the server
 * accepts — and, again, the conversion is string arithmetic, never a float.
 */

export const QUANTITY_STEP = QUANTITY_SCALE.toString();

const WHOLE = /^\d{1,9}$/;
const DECIMAL = /^\d{1,9}(?:\.\d{0,3})?$/;

function normalize(input: string): string {
  const trimmed = input.trim();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

export function parseQuantityToScaled(input: string, productType: ProductType): Parsed<string> {
  const trimmed = input.trim();
  if (trimmed === '') return unparsed('empty');

  if (productType === 'unit') {
    if (!WHOLE.test(trimmed)) {
      return unparsed(trimmed.includes('.') ? 'precision' : 'format');
    }
  } else if (!DECIMAL.test(trimmed)) {
    return unparsed(/^\d+\.\d{4,}$/.test(trimmed) ? 'precision' : 'format');
  }

  let scaled: bigint;
  try {
    scaled = quantityFromDecimalString(normalize(trimmed));
  } catch {
    return unparsed('format');
  }
  // Zero is a line nobody meant to add, and the server rejects it anyway.
  if (scaled <= 0n) return unparsed('not-positive');
  return parsed(scaled.toString());
}

/** "2000" -> "2", "1250" -> "1.25". Trailing zeros are noise on a receipt. */
export function formatScaled(scaled: string): string {
  return quantityToDisplayString(brandQuantity(BigInt(scaled)));
}

export function addScaled(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

/**
 * One whole unit up, or one down.
 *
 * The decrement is the interesting half. Clamping a step to "at least one
 * unit" is right for a unit product and wrong for anything below a unit: a
 * naive clamp turns 0.500 minus one into 1.000, so pressing minus makes the
 * quantity *larger*. On a weighed line that is a customer charged for twice
 * what they bought.
 *
 * So the rule is stated as the invariant rather than as a formula: a decrement
 * never returns more than it was given. Weighted lines do not offer these
 * controls at all (they are edited in the decimal field), and `cartReducer`
 * refuses a step on one; this is the third lock on the same door.
 */
export function stepScaled(scaled: string, direction: 1 | -1): string {
  const current = BigInt(scaled);
  if (direction === 1) return (current + QUANTITY_SCALE).toString();

  const next = current - QUANTITY_SCALE;
  if (next >= QUANTITY_SCALE) return next.toString();
  // Below one unit after the step: settle on one unit, or stay put if there
  // was never a whole unit to begin with.
  return (current > QUANTITY_SCALE ? QUANTITY_SCALE : current).toString();
}
EOF

say "Web — one typed API boundary"

cat << 'EOF' > apps/pos-web/src/lib/api-types.ts
/**
 * What the browser is allowed to know.
 *
 * Deliberately narrower than the server's own types. Every field here is one
 * the API actually sends today; nothing is optimistic, and nothing carries
 * authority. Money is a string of halalas and quantity a string scaled by
 * 1000, exactly as they cross the wire (ADR-0002).
 */

import type { PriceMode } from '@korvi/domain';

export interface Principal {
  readonly user: { readonly id: string; readonly email: string; readonly displayName: string };
  readonly tenant: { readonly id: string; readonly slug?: string };
  readonly session: { readonly id: string };
  readonly roles: readonly string[];
  /** Used only to hide affordances. The API is the authority, always. */
  readonly permissions: readonly string[];
  readonly branchId: string | null;
}

export interface TerminalSummary {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly branchId: string;
}

/**
 * The tenant settings a till must know to render a total the server agrees
 * with. Read on the server from `tenant_settings` under the session's scope;
 * the browser cannot send either field and cannot change either one.
 */
export interface TillSettings {
  readonly priceMode: PriceMode;
  readonly currency: string;
}

export interface TerminalsResponse {
  readonly branchId: string;
  readonly settings: TillSettings;
  readonly terminals: readonly TerminalSummary[];
}

export interface ProductSummary {
  readonly id: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly unitLabel: string | null;
  readonly priceMinor: string;
  readonly vatBasisPoints: number;
  readonly primaryBarcode: string | null;
  readonly trackInventory: boolean;
}

export interface ShiftSummary {
  readonly id: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly status: string;
  readonly openingFloatMinor: string;
  readonly openedAt: string;
}

export interface SaleSummaryLine {
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly quantityScaled: string;
  readonly unitPriceMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface SaleSummary {
  readonly saleId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly invoiceNumber: string;
  readonly issuedAt: string;
  readonly currency: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly cashierName: string;
  readonly lines: readonly SaleSummaryLine[];
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly cashReceivedMinor: string;
  readonly changeMinor: string;
}

export interface CheckoutResponse {
  readonly sale: SaleSummary;
  readonly replayed: boolean;
}

/** Exactly what a checkout may assert. Anything else is the server's business. */
export interface CheckoutRequest {
  readonly operationId: string;
  readonly terminalId: string;
  readonly cashReceivedMinor: string;
  readonly lines: readonly { readonly productId: string; readonly quantityScaled: string }[];
}
EOF

cat << 'EOF' > apps/pos-web/src/lib/api.ts
import type {
  CheckoutRequest,
  CheckoutResponse,
  Principal,
  ProductSummary,
  ShiftSummary,
  TerminalsResponse,
} from './api-types';

/**
 * The browser's only door to the server.
 *
 * One place that knows about JSON, cookies, aborts and what an HTTP failure
 * means, so no component ever writes fetch('/v1/...') and no component ever
 * has to remember `credentials`.
 *
 * Requests go to this app's own origin and Next forwards them (ADR-0014).
 * There is no base URL to configure and no token to attach: the session is an
 * HttpOnly cookie the browser manages and JavaScript cannot read. If you find
 * yourself wanting a token here, the design has gone wrong.
 */

/**
 * How long a checkout may go unanswered before the till stops waiting.
 *
 * The server holds a branch row lock for the length of the sale transaction,
 * so a checkout behind a queue of tills legitimately takes longer than a
 * search. Twenty seconds is well past any healthy checkout and well short of a
 * cashier deciding the machine is broken.
 *
 * What matters more than the number: a timeout here is NOT a cancellation. The
 * request may have committed. It is reported as ambiguous, keeps its operation
 * id, and is retried unchanged (ADR-0013).
 */
export const CHECKOUT_TIMEOUT_MS = 20_000;

export type ApiFailureKind = 'network' | 'http';

export class ApiError extends Error {
  public override readonly name = 'ApiError';
  /** 0 when the request never got an answer — a timeout, a dropped link, a stopped server. */
  public readonly status: number;
  /** The server's own `error` code where there is one; otherwise a local label. */
  public readonly code: string;
  public readonly serverMessage: string | null;

  public constructor(status: number, code: string, serverMessage: string | null) {
    super(`${code} (${String(status)})`);
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
  }

  /** True when the request may or may not have been carried out. */
  public get ambiguous(): boolean {
    return this.status === 0;
  }

  public get unauthenticated(): boolean {
    return this.status === 401;
  }

  public get forbidden(): boolean {
    return this.status === 403;
  }
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  me(options?: RequestOptions): Promise<Principal>;
  login(input: {
    readonly tenantSlug: string;
    readonly email: string;
    readonly password: string;
  }): Promise<Principal>;
  logout(): Promise<void>;
  terminals(options?: RequestOptions): Promise<TerminalsResponse>;
  products(
    query: { readonly q?: string; readonly limit?: number },
    options?: RequestOptions,
  ): Promise<readonly ProductSummary[]>;
  currentShift(terminalId: string, options?: RequestOptions): Promise<ShiftSummary | null>;
  openShift(input: {
    readonly terminalId: string;
    readonly openingFloatMinor: string;
  }): Promise<ShiftSummary>;
  checkout(request: CheckoutRequest): Promise<CheckoutResponse>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function readErrorCode(body: unknown, status: number): { code: string; message: string | null } {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = typeof record['error'] === 'string' ? record['error'] : `http_${String(status)}`;
    const message = typeof record['message'] === 'string' ? record['message'] : null;
    return { code, message };
  }
  return { code: `http_${String(status)}`, message: null };
}

export function createApiClient(fetchImpl?: Fetch): ApiClient {
  const call = async (
    path: string,
    init: RequestInit,
    options?: RequestOptions,
  ): Promise<unknown> => {
    const doFetch: Fetch =
      fetchImpl ?? ((input, requestInit) => globalThis.fetch(input, requestInit));

    let response: Response;
    try {
      response = await doFetch(path, {
        ...init,
        // Same-origin, so the session cookie rides along without any of the
        // cross-origin machinery that would otherwise be needed.
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      // An abort is the caller changing their mind, not a failure. It is
      // rethrown untouched so a stale search does not surface as an outage.
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'network', null);
    }

    if (response.status === 204) return null;

    // A body that is not JSON is not a reason to lose the status code: a proxy
    // error page still has to surface as the HTTP failure it is.
    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const { code, message } = readErrorCode(body, response.status);
      throw new ApiError(response.status, code, message);
    }
    return body;
  };

  const json = (payload: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return {
    async me(options) {
      return (await call('/v1/auth/me', { method: 'GET' }, options)) as Principal;
    },

    async login(input) {
      // Field by field. A spread would send whatever the form state happens to
      // hold, and form state grows fields.
      return (await call(
        '/v1/auth/login',
        json({ tenantSlug: input.tenantSlug, email: input.email, password: input.password }),
      )) as Principal;
    },

    async logout() {
      await call('/v1/auth/logout', { method: 'POST' });
    },

    async terminals(options) {
      return (await call('/v1/terminals', { method: 'GET' }, options)) as TerminalsResponse;
    },

    async products(query, options) {
      const search = new URLSearchParams();
      if (query.q !== undefined && query.q !== '') search.set('q', query.q);
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      const suffix = search.toString();
      const body = (await call(
        `/v1/products${suffix === '' ? '' : `?${suffix}`}`,
        { method: 'GET' },
        options,
      )) as { products: readonly ProductSummary[] };
      return body.products;
    },

    async currentShift(terminalId, options) {
      const body = (await call(
        `/v1/shifts/current?terminalId=${encodeURIComponent(terminalId)}`,
        { method: 'GET' },
        options,
      )) as { shift: ShiftSummary | null };
      return body.shift;
    },

    async openShift(input) {
      const body = (await call(
        '/v1/shifts/open',
        json({ terminalId: input.terminalId, openingFloatMinor: input.openingFloatMinor }),
      )) as { shift: ShiftSummary };
      return body.shift;
    },

    async checkout(request) {
      // A hung request must not leave the till in "submitting" forever, and
      // must not be mistaken for a cancellation: the sale may already exist.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, CHECKOUT_TIMEOUT_MS);

      try {
        // The whitelist is the security control, not a convenience. Building
        // the body from named fields is what makes it impossible for a price,
        // a tenant or a role to reach the server because something upstream
        // put it on an object.
        return (await call(
          '/v1/sales',
          json({
            operationId: request.operationId,
            terminalId: request.terminalId,
            cashReceivedMinor: request.cashReceivedMinor,
            lines: request.lines.map((line) => ({
              productId: line.productId,
              quantityScaled: line.quantityScaled,
            })),
          }),
          { signal: controller.signal },
        )) as CheckoutResponse;
      } catch (error) {
        // Our own abort, translated. Left as an AbortError it would look like
        // a cancelled search and the basket would be cleared.
        if (timedOut) throw new ApiError(0, 'timeout', null);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
EOF

say "Web — what a failure means to a cashier"

cat << 'EOF' > apps/pos-web/src/lib/failures.ts
import { ApiError } from './api';

/**
 * Server outcomes, translated into something a person at a till can act on.
 *
 * The server already sends Arabic for the checkout reasons, and where it does
 * that text is used verbatim — it is written for this screen. The map here
 * exists for the codes it does not phrase, and to attach the one thing a
 * message cannot carry: what the interface should do next.
 *
 * Nothing from the transport is ever shown. A cashier who sees a Prisma error
 * cannot act on it, and an attacker who sees one learns the schema.
 */

export type FailureAction =
  /** The session is gone; go back to login. */
  | 'reauthenticate'
  /** The role does not permit this. */
  | 'permission'
  /** Re-read the shift before trying again. */
  | 'refresh-shift'
  /** Open a shift first. */
  | 'open-shift'
  /** The basket is still valid; fix it and retry. */
  | 'amend-cart'
  /** Put the focus back in the cash field. */
  | 'amend-cash'
  /** Ambiguous: the same request may safely be sent again, unchanged. */
  | 'retry-same'
  /** Stop. A human has to decide. */
  | 'blocking'
  /** Nothing specific; show and carry on. */
  | 'notice';

export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly action: FailureAction;
}

const FALLBACK = 'تعذّر إتمام العملية. حاول مرة أخرى.';

const KNOWN: Readonly<Record<string, { message: string; action: FailureAction }>> = {
  network: {
    message: 'تعذّر الوصول إلى الخادم. السلة محفوظة، ويمكن إعادة المحاولة بأمان.',
    action: 'retry-same',
  },
  timeout: {
    // Not "it failed": nobody knows whether it failed. Retrying the same
    // operation id is the safe move and the only one offered.
    message: 'لم يصل ردّ الخادم في الوقت المتوقع. قد تكون العملية قد تمّت — أعد الإرسال بنفس العملية للتأكد.',
    action: 'retry-same',
  },
  unauthenticated: { message: 'انتهت الجلسة. سجّل الدخول من جديد.', action: 'reauthenticate' },
  forbidden: { message: 'لا تملك صلاحية تنفيذ هذه العملية.', action: 'permission' },
  invalid_credentials: { message: 'بيانات الدخول غير صحيحة.', action: 'notice' },
  unavailable: { message: 'الخدمة غير متاحة حالياً. حاول بعد قليل.', action: 'retry-same' },
  branch_required: {
    message: 'لا يوجد فرع مرتبط بهذا المستخدم. راجع إعدادات المنشأة.',
    action: 'blocking',
  },
  unknown_terminal: { message: 'الصندوق غير معروف أو غير مفعّل.', action: 'blocking' },
  shift_already_open: { message: 'توجد وردية مفتوحة على هذا الصندوق.', action: 'refresh-shift' },
  'no-open-shift': {
    message: 'لا توجد وردية مفتوحة على هذا الصندوق. افتح وردية أولاً.',
    action: 'open-shift',
  },
  'shift-invalid': {
    message: 'الوردية لم تعد صالحة لهذا الصندوق. سيتم تحديث حالة الوردية.',
    action: 'refresh-shift',
  },
  'insufficient-stock': {
    message: 'الكمية المطلوبة لم تعد متوفرة. السلة كما هي — عدّل الكمية وأعد المحاولة.',
    action: 'amend-cart',
  },
  'unknown-product': { message: 'أحد الأصناف لم يعد موجوداً. احذفه من السلة.', action: 'amend-cart' },
  'product-unavailable': {
    message: 'أحد الأصناف لم يعد متاحاً للبيع. احذفه من السلة.',
    action: 'amend-cart',
  },
  'invalid-quantity': { message: 'الكمية غير صالحة لهذا الصنف.', action: 'amend-cart' },
  'duplicate-line': { message: 'الصنف مكرر في السلة. ادمج الكمية في سطر واحد.', action: 'amend-cart' },
  'empty-cart': { message: 'لا توجد أصناف في السلة.', action: 'amend-cart' },
  'insufficient-cash': { message: 'المبلغ المستلم أقل من المطلوب.', action: 'amend-cash' },
  'idempotency-conflict': {
    message:
      'هناك عملية سابقة بنفس المعرّف ومحتوى مختلف. لا تُعاد المحاولة تلقائياً — راجع آخر فاتورة قبل المتابعة.',
    action: 'blocking',
  },
  'tenant-misconfigured': { message: 'إعدادات المنشأة غير مكتملة.', action: 'blocking' },
};

export function describeFailure(error: unknown): Failure {
  if (!(error instanceof ApiError)) {
    return { code: 'unexpected', message: FALLBACK, action: 'notice' };
  }

  const known = KNOWN[error.code];
  if (known !== undefined) {
    // The server's own wording wins where it sent one: it was written for a
    // cashier, and it is closer to what actually happened than a code map.
    return {
      code: error.code,
      message: error.serverMessage ?? known.message,
      action: known.action,
    };
  }

  if (error.unauthenticated) {
    return { code: error.code, message: KNOWN['unauthenticated']!.message, action: 'reauthenticate' };
  }
  if (error.forbidden) {
    return { code: error.code, message: KNOWN['forbidden']!.message, action: 'permission' };
  }
  if (error.status >= 500) {
    return { code: error.code, message: KNOWN['unavailable']!.message, action: 'retry-same' };
  }
  return { code: error.code, message: error.serverMessage ?? FALLBACK, action: 'notice' };
}
EOF

say "Web — the cart"

cat << 'EOF' > apps/pos-web/src/lib/cart.ts
import { QUANTITY_SCALE, basisPoints, money, priceCart, quantity } from '@korvi/domain';
import { addScaled, stepScaled } from './quantity';
import type { ProductSummary } from './api-types';
import type { CartLineInput, PriceMode, PricedCart, ProductType } from '@korvi/domain';

/**
 * The basket, as local intent.
 *
 * Nothing here is persisted and nothing here is authoritative. It is a record
 * of what the cashier has said they want to sell, kept only long enough to be
 * sent as product ids and quantities.
 *
 * One line per product, always. The server refuses a duplicate product line —
 * two lines each pass a stock check their sum fails — so a second scan of the
 * same item adds to the line that already exists rather than making a new one.
 * `productId` is the identity of a line for exactly that reason.
 */

export interface CartLine {
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType;
  readonly unitLabel: string | null;
  /** Snapshot of the price the catalogue showed. For display only. */
  readonly unitPriceMinor: string;
  readonly vatBasisPoints: number;
  readonly quantityScaled: string;
}

export type CartAction =
  | { readonly type: 'add'; readonly product: ProductSummary }
  | { readonly type: 'set-quantity'; readonly productId: string; readonly quantityScaled: string }
  | { readonly type: 'step'; readonly productId: string; readonly direction: 1 | -1 }
  | { readonly type: 'remove'; readonly productId: string }
  | { readonly type: 'clear' };

function lineFor(product: ProductSummary, quantityScaled: string): CartLine {
  return {
    productId: product.id,
    sku: product.sku,
    nameAr: product.nameAr,
    nameEn: product.nameEn,
    productType: product.productType,
    unitLabel: product.unitLabel,
    unitPriceMinor: product.priceMinor,
    vatBasisPoints: product.vatBasisPoints,
    quantityScaled,
  };
}

export function cartReducer(lines: readonly CartLine[], action: CartAction): readonly CartLine[] {
  switch (action.type) {
    case 'add': {
      const existing = lines.find((line) => line.productId === action.product.id);
      if (existing === undefined) {
        return [...lines, lineFor(action.product, QUANTITY_SCALE.toString())];
      }
      // Merged, not appended. A cashier scanning the same tin twice means two
      // tins, and the receipt should say so on one line.
      return lines.map((line) =>
        line.productId === action.product.id
          ? { ...line, quantityScaled: addScaled(line.quantityScaled, QUANTITY_SCALE.toString()) }
          : line,
      );
    }
    case 'set-quantity':
      return lines.map((line) =>
        line.productId === action.productId
          ? { ...line, quantityScaled: action.quantityScaled }
          : line,
      );
    case 'step':
      return lines.map((line) => {
        if (line.productId !== action.productId) return line;
        // Whole-unit steps belong to whole-unit products. A weighed line is
        // 0.750 kg, not "one of something", and stepping it by a unit is
        // meaningless in one direction and dangerous in the other. The screen
        // does not offer the controls; this makes the action itself inert, so
        // a future caller cannot reintroduce the bug.
        if (line.productType !== 'unit') return line;
        return { ...line, quantityScaled: stepScaled(line.quantityScaled, action.direction) };
      });
    case 'remove':
      return lines.filter((line) => line.productId !== action.productId);
    case 'clear':
      return [];
  }
}

/**
 * What the till expects the sale to come to, using the domain's own arithmetic.
 *
 * Not authoritative and never sent: the server re-prices everything from its
 * own catalogue, and the figures on the completed sale replace these entirely.
 * It exists so the total does not lag a scan behind the cashier's hands.
 *
 * `priceCart` rather than a local multiplication, so the preview and the sale
 * round identically — a preview that disagrees with the receipt by one halala
 * is worse than no preview.
 *
 * The price mode is a parameter and has no default. It comes from
 * `tenant_settings` by way of GET /v1/terminals, because a merchant selling
 * tax-exclusive would otherwise be shown a total short by the VAT, and a
 * hardcoded assumption is exactly the kind of thing nobody notices until an
 * auditor does.
 */
export function previewCart(lines: readonly CartLine[], priceMode: PriceMode): PricedCart {
  return priceCart({
    priceMode,
    currency: 'SAR',
    lines: lines.map(
      (line, index): CartLineInput => ({
        lineId: String(index + 1),
        productId: line.productId,
        sku: line.sku,
        nameAr: line.nameAr,
        nameEn: line.nameEn,
        unitPrice: money(BigInt(line.unitPriceMinor), 'SAR'),
        quantity: quantity(BigInt(line.quantityScaled)),
        vatRate: basisPoints(line.vatBasisPoints),
        isWeighted: line.productType === 'weighted',
      }),
    ),
  });
}

/** Ids and quantities. The whole of what a basket is allowed to assert. */
export function cartToRequestLines(
  lines: readonly CartLine[],
): readonly { readonly productId: string; readonly quantityScaled: string }[] {
  return lines.map((line) => ({
    productId: line.productId,
    quantityScaled: line.quantityScaled,
  }));
}
EOF

say "Web — one checkout in flight, and one intent behind it"

cat << 'EOF' > apps/pos-web/src/lib/checkout-flight.ts
import type { CheckoutRequest } from './api-types';

/**
 * The concurrency boundary for money leaving a till.
 *
 * A disabled button and a React state flag are user-interface controls. They
 * are not a mutex: `dispatch` schedules a render, it does not update anything
 * synchronously, so two calls to submit in the same tick — a double click, a
 * key repeat, an Enter racing a click — both read the same idle state, both
 * mint their own operation id, and both reach POST /v1/sales. Two different
 * operation ids are two different intents as far as the server is concerned,
 * and the idempotency contract that exists to prevent a double charge is
 * bypassed by construction.
 *
 * So ownership is claimed here, in a plain object held across renders, and it
 * is claimed *before the first await*. The second caller in the same tick gets
 * `null` and issues nothing.
 *
 * The second thing this owns is the intent itself. The server's fingerprint
 * covers branch, terminal, product ids, quantities and cash received; a retry
 * that rebuilt the request from whatever the interface currently holds could
 * therefore replay a *different* intent under the same id, which the server
 * correctly refuses as a conflict. The snapshot taken on the first attempt is
 * what every retry of that attempt resends, unchanged.
 */

export type CheckoutIntent = CheckoutRequest;

/**
 * What the server said, reduced to the only question that matters here: may
 * the cashier change the basket now?
 *
 *   succeeded  the sale exists; the intent stays claimed so a stray resubmit
 *              replays it rather than ringing up another
 *   ambiguous  nobody knows; the intent is frozen and may only be resent
 *   amendable  the server decided and rolled back, so nothing was recorded and
 *              the intent is retired — the next attempt is a new one
 *   blocked    a conflict a human has to resolve; no further attempts
 */
export type FlightOutcome = 'succeeded' | 'ambiguous' | 'amendable' | 'blocked';

export interface CheckoutFlight {
  /**
   * Claim the flight, synchronously.
   *
   * Returns the intent to send, or null when one is already in flight or the
   * flight is blocked. `build` is called only when there is no intent to
   * replay, so a retry can never be rebuilt from mutable state.
   */
  begin(build: () => CheckoutIntent): CheckoutIntent | null;
  settle(outcome: FlightOutcome): void;
  /** The intent a retry would send, if there is one. */
  pending(): CheckoutIntent | null;
  running(): boolean;
  /** True while an attempt may or may not have committed. */
  outstanding(): boolean;
  blocked(): boolean;
  /** A new basket. Everything is forgotten. */
  reset(): void;
}

/** Frozen deeply enough that a caller holding a reference cannot edit it. */
function freeze(intent: CheckoutIntent): CheckoutIntent {
  return Object.freeze({
    operationId: intent.operationId,
    terminalId: intent.terminalId,
    cashReceivedMinor: intent.cashReceivedMinor,
    lines: Object.freeze(
      intent.lines.map((line) =>
        Object.freeze({ productId: line.productId, quantityScaled: line.quantityScaled }),
      ),
    ),
  });
}

export function createCheckoutFlight(): CheckoutFlight {
  let inFlight = false;
  let intent: CheckoutIntent | null = null;
  let ambiguous = false;
  let stopped = false;

  return {
    begin(build) {
      if (inFlight || stopped) return null;
      // An existing intent is replayed verbatim. This is the line that makes a
      // retry a retry rather than a second sale.
      const next = intent ?? freeze(build());
      intent = next;
      inFlight = true;
      return next;
    },

    settle(outcome) {
      inFlight = false;
      switch (outcome) {
        case 'succeeded':
          ambiguous = false;
          return;
        case 'ambiguous':
          ambiguous = true;
          return;
        case 'amendable':
          // The server refused and rolled back, so the operation id was never
          // recorded. Retiring it means the amended basket goes out under a
          // fresh one, which can never collide with anything.
          ambiguous = false;
          intent = null;
          return;
        case 'blocked':
          ambiguous = false;
          stopped = true;
          return;
      }
    },

    pending: () => intent,
    running: () => inFlight,
    outstanding: () => ambiguous,
    blocked: () => stopped,

    reset() {
      inFlight = false;
      intent = null;
      ambiguous = false;
      stopped = false;
    },
  };
}

/** The server's answer, classified for the flight. */
export function outcomeFor(action: string): FlightOutcome {
  if (action === 'retry-same') return 'ambiguous';
  if (action === 'blocking') return 'blocked';
  return 'amendable';
}
EOF

cat << 'EOF' > apps/pos-web/src/lib/checkout.ts
import type { SaleSummary } from './api-types';
import type { CheckoutIntent } from './checkout-flight';
import type { Failure } from './failures';

/**
 * The checkout, as the screen sees it.
 *
 * This is the mirror, not the mechanism. The concurrency boundary and the
 * immutable intent live in `checkout-flight.ts`, because React state cannot be
 * either of those things. What is here drives what the cashier is shown and
 * what they are allowed to touch.
 */

export type CheckoutPhase = 'idle' | 'submitting' | 'succeeded' | 'failed';

export interface CheckoutState {
  readonly phase: CheckoutPhase;
  /** The intent in flight or awaiting a retry. Null when there is nothing claimed. */
  readonly intent: CheckoutIntent | null;
  /** The last attempt may have committed. The basket must not change. */
  readonly attemptOutstanding: boolean;
  readonly sale: SaleSummary | null;
  /** True when the server answered with a sale an earlier attempt created. */
  readonly replayed: boolean;
  readonly failure: Failure | null;
}

export const initialCheckoutState: CheckoutState = {
  phase: 'idle',
  intent: null,
  attemptOutstanding: false,
  sale: null,
  replayed: false,
  failure: null,
};

export type CheckoutEvent =
  | { readonly type: 'submit'; readonly intent: CheckoutIntent }
  | { readonly type: 'succeeded'; readonly sale: SaleSummary; readonly replayed: boolean }
  | { readonly type: 'failed'; readonly failure: Failure }
  | { readonly type: 'dismiss' }
  | { readonly type: 'new-sale' };

export function checkoutReducer(state: CheckoutState, event: CheckoutEvent): CheckoutState {
  switch (event.type) {
    case 'submit':
      return { ...state, phase: 'submitting', intent: event.intent, failure: null };
    case 'succeeded':
      return {
        ...state,
        phase: 'succeeded',
        attemptOutstanding: false,
        sale: event.sale,
        replayed: event.replayed,
        failure: null,
      };
    case 'failed':
      return {
        ...state,
        phase: 'failed',
        // Only an unanswered request leaves the outcome unknown. A 409 or a
        // 422 is a decision the server made and rolled back.
        attemptOutstanding: event.failure.action === 'retry-same',
        // A refusal the cashier can amend retires the intent, exactly as the
        // flight does, so the next attempt is a new one.
        intent: event.failure.action === 'retry-same' || event.failure.action === 'blocking'
          ? state.intent
          : null,
        failure: event.failure,
      };
    case 'dismiss':
      return { ...state, phase: 'idle', failure: null };
    case 'new-sale':
      return initialCheckoutState;
  }
}

/** True while a duplicate submit would be a second charge or a lost retry. */
export function submitDisabled(state: CheckoutState): boolean {
  return (
    state.phase === 'submitting' ||
    state.phase === 'succeeded' ||
    state.failure?.action === 'blocking'
  );
}

/**
 * True while nothing about the intent may change.
 *
 * Covers the basket, the quantities, the cash field, the search box and the
 * clear and remove controls. An outstanding attempt is the important case: the
 * retry must be able to resend the same fingerprint, and a cashier who edited
 * the cash amount in between would turn a safe replay into a conflict.
 */
export function intentLocked(state: CheckoutState): boolean {
  return state.phase === 'submitting' || state.phase === 'succeeded' || state.attemptOutstanding;
}

/**
 * True while signing out would abandon a transaction of unknown outcome.
 *
 * A cashier walking away from a sale that may have committed leaves the next
 * person to reconcile it.
 */
export function signOutBlocked(state: CheckoutState): boolean {
  return state.phase === 'submitting' || state.attemptOutstanding;
}
EOF

say "Web — search that cannot be overtaken by its own past"

cat << 'EOF' > apps/pos-web/src/lib/search.ts
import { describeFailure } from './failures';
import type { ProductSummary } from './api-types';
import type { Failure } from './failures';

/**
 * Product search for a till.
 *
 * Two failure modes matter, and neither is about speed. A slow response for
 * "ح" must not land after the response for "حليب" and replace it — the cashier
 * would be looking at results for something they finished typing two seconds
 * ago. And an abandoned request must actually be abandoned, or every keystroke
 * leaves a connection open.
 *
 * So: one AbortController per query, aborted when the next one starts, and a
 * sequence number checked before anything is published. The abort alone is not
 * enough — a response can already be in flight when abort is called.
 *
 * Note the deliberate asymmetry with checkout. An abort here is a
 * cancellation: nothing happened and nothing is owed. An abort of a checkout
 * is an ambiguous transaction, and the two must never share a code path.
 */

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface SearchState {
  readonly term: string;
  readonly status: SearchStatus;
  readonly results: readonly ProductSummary[];
  readonly failure: Failure | null;
}

export const initialSearchState: SearchState = {
  term: '',
  status: 'idle',
  results: [],
  failure: null,
};

export interface SearchSource {
  products(
    query: { readonly q?: string; readonly limit?: number },
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly ProductSummary[]>;
}

export interface ProductSearch {
  /** Run a query, cancelling whatever was in flight. */
  run(term: string): Promise<void>;
  /** Abandon the current query without publishing anything. */
  cancel(): void;
}

export interface SearchOptions {
  readonly limit?: number;
}

export function createProductSearch(
  source: SearchSource,
  emit: (state: SearchState) => void,
  options: SearchOptions = {},
): ProductSearch {
  const limit = options.limit ?? 20;
  let sequence = 0;
  let inFlight: AbortController | null = null;

  const abandon = (): void => {
    inFlight?.abort();
    inFlight = null;
  };

  return {
    cancel(): void {
      // Bumping the sequence retires any response already on the wire.
      sequence += 1;
      abandon();
    },

    async run(term: string): Promise<void> {
      abandon();
      sequence += 1;
      const mine = sequence;

      const trimmed = term.trim();
      if (trimmed === '') {
        emit({ term, status: 'idle', results: [], failure: null });
        return;
      }

      emit({ term, status: 'loading', results: [], failure: null });

      const controller = new AbortController();
      inFlight = controller;

      try {
        const results = await source.products({ q: trimmed, limit }, { signal: controller.signal });
        // The guard that actually prevents the stale overwrite.
        if (mine !== sequence) return;
        emit({ term, status: 'ready', results, failure: null });
      } catch (error) {
        if (mine !== sequence) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        emit({ term, status: 'failed', results: [], failure: describeFailure(error) });
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    },
  };
}

/**
 * The one result a bare Enter may add without the cashier looking.
 *
 * Only when there is exactly one, and only when the term was a code rather
 * than a word: a scanner produces a code and the cashier is already reaching
 * for the next item, while "حليب" matching one product today may match three
 * tomorrow, and silently adding one of them is not a habit worth training.
 */
export function autoAddCandidate(state: SearchState): ProductSummary | null {
  if (state.status !== 'ready' || state.results.length !== 1) return null;
  const term = state.term.trim();
  const looksScanned = /^[0-9]{6,14}$/.test(term);
  const exact =
    state.results[0]?.sku.toLowerCase() === term.toLowerCase() ||
    state.results[0]?.primaryBarcode === term;
  return looksScanned || exact ? (state.results[0] ?? null) : null;
}
EOF

cat << 'EOF' > apps/pos-web/src/lib/checkout-submit.ts
import { newId } from '@korvi/domain';
import { outcomeFor } from './checkout-flight';
import { describeFailure } from './failures';
import { cartToRequestLines } from './cart';
import type { CheckoutResponse } from './api-types';
import type { CartLine } from './cart';
import type { CheckoutEvent } from './checkout';
import type { CheckoutFlight, CheckoutIntent } from './checkout-flight';

/**
 * One checkout attempt, start to finish.
 *
 * Deliberately outside React. The hook that calls this is a four-line wrapper
 * holding the flight in a ref and passing `dispatch`; everything that decides
 * whether a request goes out, what it contains, and what the outcome means to
 * the next attempt is here, where it can be driven directly and where its
 * concurrency does not depend on when a renderer happens to commit.
 */
export interface CheckoutSubmission {
  readonly terminalId: string;
  readonly lines: readonly CartLine[];
  readonly cashReceivedMinor: string;
}

export interface CheckoutRunner {
  checkout(intent: CheckoutIntent): Promise<CheckoutResponse>;
}

export function runCheckout(
  api: CheckoutRunner,
  flight: CheckoutFlight,
  input: CheckoutSubmission,
  dispatch: (event: CheckoutEvent) => void,
  onUnauthenticated: () => void,
  mint: () => string = newId,
): Promise<void> {
  // Claimed synchronously, before anything can await and before the renderer
  // is involved. A second call in this tick gets null and sends nothing.
  const intent = flight.begin(() => ({
    operationId: mint(),
    terminalId: input.terminalId,
    cashReceivedMinor: input.cashReceivedMinor,
    lines: cartToRequestLines(input.lines),
  }));
  if (intent === null) return Promise.resolve();
  if (intent.lines.length === 0) {
    flight.settle('amendable');
    return Promise.resolve();
  }

  dispatch({ type: 'submit', intent });

  return api
    .checkout(intent)
    .then((response) => {
      flight.settle('succeeded');
      dispatch({ type: 'succeeded', sale: response.sale, replayed: response.replayed });
    })
    .catch((error: unknown) => {
      const failure = describeFailure(error);
      if (failure.action === 'reauthenticate') {
        flight.reset();
        onUnauthenticated();
        return;
      }
      flight.settle(outcomeFor(failure.action));
      dispatch({ type: 'failed', failure });
    });
}
EOF

say "Web — session, terminal and shift, as states rather than flags"

cat << 'EOF' > apps/pos-web/src/lib/session.ts
import { ApiError } from './api';
import { describeFailure } from './failures';
import type { ApiClient, RequestOptions } from './api';
import type { Principal } from './api-types';
import type { Failure } from './failures';

/**
 * Who is at the till, resolved from the cookie the browser already holds.
 *
 * There is no token to read and nothing in storage to restore. The only
 * question the app can ask is "does the server still know me", and the only
 * way to ask it is GET /v1/auth/me. A 401 is a clean answer, not a failure —
 * it means show the login screen. A network problem is a different answer, and
 * conflating the two would log a cashier out because a switch rebooted.
 *
 * `loading` exists so the cashier screen never flashes before the answer
 * arrives. The permissions that come back are used to hide affordances and for
 * nothing else; every route re-checks them server-side.
 */

export type SessionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous'; readonly notice: Failure | null }
  | { readonly kind: 'unavailable'; readonly failure: Failure }
  | { readonly kind: 'ready'; readonly principal: Principal }
  /** Selling is already blocked; the server has not answered yet. */
  | { readonly kind: 'signing-out'; readonly principal: Principal }
  /** The server never confirmed. The cookie may still be live. */
  | { readonly kind: 'logout-failed'; readonly principal: Principal; readonly failure: Failure };

export const initialSessionState: SessionState = { kind: 'loading' };

export async function loadSession(api: ApiClient, options?: RequestOptions): Promise<SessionState> {
  try {
    return { kind: 'ready', principal: await api.me(options) };
  } catch (error) {
    if (error instanceof ApiError && error.unauthenticated) {
      return { kind: 'anonymous', notice: null };
    }
    return { kind: 'unavailable', failure: describeFailure(error) };
  }
}

export type LogoutResult =
  | { readonly confirmed: true }
  | { readonly confirmed: false; readonly failure: Failure };

/**
 * Ask the server to revoke the session, and report whether it said so.
 *
 * The distinction this function exists to preserve: the session cookie is
 * HttpOnly, so the browser cannot clear it and JavaScript cannot read it. Only
 * the server can end a session. If the request never arrived, the session is
 * still live and the cookie is still in the browser — and a screen that
 * returned to the login form would be telling a cashier they had logged out of
 * a till that will happily restore them on reload. On a shared machine that is
 * the next person's sale under the previous person's name.
 */
export async function requestLogout(api: ApiClient): Promise<LogoutResult> {
  try {
    await api.logout();
    return { confirmed: true };
  } catch (error) {
    return { confirmed: false, failure: describeFailure(error) };
  }
}

export function hasPermission(principal: Principal, permission: string): boolean {
  return principal.permissions.includes(permission);
}
EOF

cat << 'EOF' > apps/pos-web/src/lib/terminal.ts
import { describeFailure } from './failures';
import type { ApiClient, RequestOptions } from './api';
import type { TerminalSummary, TerminalsResponse, TillSettings } from './api-types';
import type { Failure } from './failures';

/**
 * Which till this browser is.
 *
 * The list comes from the server, scoped to the branch the session belongs to;
 * the browser cannot ask about another branch and does not try. What is
 * decided here is only which of the offered tills the cashier is standing at —
 * device context, not authority. The server revalidates the id on every shift
 * and every sale regardless of what is remembered here.
 *
 * The same response carries the tenant's price mode, because the till has to
 * render a total the server will agree with and has no other lawful way to
 * learn it.
 */

export type TerminalState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'choosing';
      readonly terminals: readonly TerminalSummary[];
      readonly settings: TillSettings;
    }
  | { readonly kind: 'chosen'; readonly terminal: TerminalSummary; readonly settings: TillSettings }
  | { readonly kind: 'blocked'; readonly failure: Failure };

export const initialTerminalState: TerminalState = { kind: 'loading' };

const NONE_CONFIGURED: Failure = {
  code: 'no_terminals',
  message: 'لا يوجد صندوق مفعّل في هذا الفرع. أضف صندوقاً من إعدادات المنشأة قبل البيع.',
  action: 'blocking',
};

/**
 * Turn the server's answer into a state.
 *
 * One till is chosen for the cashier, because presenting a list of one is a
 * question with no information in it. A remembered id is honoured only if the
 * server still offers it — a till that was deactivated must not be selectable
 * because this browser saw it yesterday.
 */
export function chooseTerminal(
  response: TerminalsResponse,
  remembered: string | null,
): TerminalState {
  const terminals = response.terminals;
  const settings = response.settings;
  if (terminals.length === 0) return { kind: 'blocked', failure: NONE_CONFIGURED };

  const recalled = terminals.find((terminal) => terminal.id === remembered);
  if (recalled !== undefined) return { kind: 'chosen', terminal: recalled, settings };

  const only = terminals.length === 1 ? terminals[0] : undefined;
  if (only !== undefined) return { kind: 'chosen', terminal: only, settings };

  return { kind: 'choosing', terminals, settings };
}

export async function loadTerminals(
  api: ApiClient,
  remembered: string | null,
  options?: RequestOptions,
): Promise<TerminalState> {
  try {
    return chooseTerminal(await api.terminals(options), remembered);
  } catch (error) {
    return { kind: 'blocked', failure: describeFailure(error) };
  }
}
EOF

cat << 'EOF' > apps/pos-web/src/lib/shift.ts
import { describeFailure } from './failures';
import type { ApiClient, RequestOptions } from './api';
import type { ShiftSummary } from './api-types';
import type { Failure } from './failures';

/**
 * Whether this till has a drawer this cashier may sell through.
 *
 * A cash sale needs somewhere for the cash to go, and the server refuses one
 * without an open shift. Asking first turns that refusal into a screen the
 * cashier can act on instead of an error after a basket has been built.
 *
 * `foreign` is the case worth naming. One drawer belongs to one cashier: the
 * sale transaction re-reads the shift under its own row lock and refuses a
 * sale whose cashier is not the shift's, so a till left open by the previous
 * shift would let a basket be built and then reject it at payment. Discovering
 * it here costs one read and saves a queue.
 */

export type ShiftState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'open'; readonly shift: ShiftSummary }
  | { readonly kind: 'foreign'; readonly shift: ShiftSummary }
  | { readonly kind: 'blocked'; readonly failure: Failure };

export const initialShiftState: ShiftState = { kind: 'loading' };

export const FOREIGN_SHIFT: Failure = {
  code: 'foreign_shift',
  message:
    'هذا الصندوق لديه وردية مفتوحة لكاشير آخر. اختر صندوقاً آخر أو اطلب إغلاق الوردية الحالية.',
  action: 'blocking',
};

/**
 * Which refusals mean the shift on screen is out of date.
 *
 * `shift-invalid` is the obvious one — the sale transaction re-read the shift
 * and did not like what it found. `no-open-shift` is the one that was missed:
 * a drawer closed under the till while a basket was being built, and a cashier
 * left staring at a checkout button that will never work is worse than one
 * sent back to open a shift.
 */
export function shiftNeedsRefresh(action: string | undefined): boolean {
  return action === 'refresh-shift' || action === 'open-shift';
}

/**
 * `userId` is the signed-in cashier, from the session — never from the shift.
 * Comparing the shift to itself would always agree.
 */
export async function loadShift(
  api: ApiClient,
  terminalId: string,
  userId: string,
  options?: RequestOptions,
): Promise<ShiftState> {
  try {
    const shift = await api.currentShift(terminalId, options);
    if (shift === null) return { kind: 'closed' };
    // No takeover, and none is invented here: the server would refuse the sale
    // and there is no Korvi rule that permits a shared drawer.
    if (shift.userId !== userId) return { kind: 'foreign', shift };
    return { kind: 'open', shift };
  } catch (error) {
    return { kind: 'blocked', failure: describeFailure(error) };
  }
}
EOF

cat << 'EOF' > apps/pos-web/src/lib/device-memory.ts
/**
 * The till this browser was last used as.
 *
 * sessionStorage, and only ever a terminal id. It is not a secret and not a
 * credential: a terminal id proves nothing on its own, the server re-checks it
 * against the session's branch on every request, and remembering it saves a
 * cashier one tap per shift.
 *
 * No token, no session, no principal is ever written here. The session lives in
 * an HttpOnly cookie precisely so that JavaScript cannot reach it, and copying
 * anything from it into storage would undo that in one line.
 */

const TERMINAL_KEY = 'korvi.pos.terminalId';

/** Storage is absent during server rendering and can throw in private modes. */
function storage(): Storage | null {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberedTerminalId(): string | null {
  try {
    return storage()?.getItem(TERMINAL_KEY) ?? null;
  } catch {
    return null;
  }
}

export function rememberTerminalId(terminalId: string): void {
  try {
    storage()?.setItem(TERMINAL_KEY, terminalId);
  } catch {
    // A till that cannot remember its number still sells. Nothing to report.
  }
}

export function forgetTerminalId(): void {
  try {
    storage()?.removeItem(TERMINAL_KEY);
  } catch {
    // As above.
  }
}
EOF

cat << 'EOF' > apps/pos-web/src/lib/datetime.ts
/**
 * A timestamp a cashier can read.
 *
 * The server sends ISO 8601, which is the right thing to send and the wrong
 * thing to show: `2026-08-12T07:00:00.000Z` on a receipt is an implementation
 * detail printed at a customer.
 *
 * Fixed locale and fixed time zone, deliberately. A till in Riyadh shows
 * Riyadh time whatever the machine's clock is set to, and the same string is
 * produced on the server and in the browser — a value that formatted
 * differently in the two would be a hydration mismatch on every receipt.
 * Gregorian with Latin digits, matching the rest of the numeric typography.
 */
const FORMAT = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  timeZone: 'Asia/Riyadh',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatTimestamp(iso: string): string {
  const at = new Date(iso);
  // An unparseable date is not worth throwing over on a receipt; showing what
  // arrived is more useful than an empty line.
  return Number.isNaN(at.getTime()) ? iso : FORMAT.format(at);
}
EOF

cat << 'EOF' > apps/pos-web/src/lib/logout.ts
import { requestLogout } from './session';
import { forgetTerminalId } from './device-memory';
import type { ApiClient } from './api';
import type { Principal } from './api-types';
import type { SessionState } from './session';

/**
 * Signing out, treated as a transaction rather than a screen change.
 *
 * Two things make this more than `setState('anonymous')`. The session cookie is
 * HttpOnly, so only the server can end a session and this code cannot verify
 * one has ended except by being told; and a till is a shared machine, so a
 * cashier who is told they have logged out and has not is the next person's
 * problem.
 *
 * So the sequence is: stop selling, ask, and only change identity on a
 * confirmed answer. An unconfirmed logout is its own state, not a return to
 * the login form.
 */
export interface LogoutController {
  /** Ignored if one is already running: at most one request per logout. */
  signOut(principal: Principal, emit: (state: SessionState) => void): void;
  running(): boolean;
}

export function createLogoutController(
  api: Pick<ApiClient, 'logout'>,
  forget: () => void = forgetTerminalId,
): LogoutController {
  let inFlight = false;

  return {
    running: () => inFlight,

    signOut(principal, emit) {
      if (inFlight) return;
      inFlight = true;
      // Selling stops before the request goes out, not after it comes back.
      emit({ kind: 'signing-out', principal });

      void requestLogout(api as ApiClient).then((result) => {
        inFlight = false;
        if (result.confirmed) {
          // Only now. The server has revoked the session and cleared the
          // cookie, so forgetting the till is both safe and true.
          forget();
          emit({ kind: 'anonymous', notice: null });
          return;
        }
        // The terminal id is deliberately left alone: nothing was secured, and
        // clearing it would make the failure look like a clean exit.
        emit({ kind: 'logout-failed', principal, failure: result.failure });
      });
    },
  };
}
EOF

say "Web — hooks that hold state and nothing else"

cat << 'EOF' > apps/pos-web/src/hooks/use-session.ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSession } from '../lib/session';
import { createLogoutController } from '../lib/logout';
import type { ApiClient } from '../lib/api';
import type { Principal } from '../lib/api-types';
import type { LogoutController } from '../lib/logout';
import type { SessionState } from '../lib/session';

/**
 * The boot question, asked once and answerable again.
 *
 * `expire` is what every other hook calls when it meets a 401: the session is
 * gone, the screen goes back to login, and nothing pretends otherwise.
 *
 * `signOut` is the opposite case and is handled by a controller held across
 * renders, for the same reason the checkout flight is: two clicks in one tick
 * both read the old state, and only a synchronous guard stops the second from
 * issuing a request.
 */
export interface SessionHandle {
  readonly state: SessionState;
  readonly signedIn: (principal: Principal) => void;
  readonly expire: () => void;
  readonly signOut: () => void;
  readonly retry: () => void;
}

export function useSession(api: ApiClient): SessionHandle {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const logout = useRef<LogoutController | null>(null);
  logout.current ??= createLogoutController(api);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    void loadSession(api, { signal: controller.signal }).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, attempt]);

  const signedIn = useCallback((principal: Principal) => {
    setState({ kind: 'ready', principal });
  }, []);

  const expire = useCallback(() => {
    setState({
      kind: 'anonymous',
      notice: {
        code: 'unauthenticated',
        message: 'انتهت الجلسة. سجّل الدخول من جديد.',
        action: 'reauthenticate',
      },
    });
  }, []);

  const signOut = useCallback(() => {
    const principal =
      state.kind === 'ready' || state.kind === 'signing-out' || state.kind === 'logout-failed'
        ? state.principal
        : null;
    if (principal === null) return;
    logout.current?.signOut(principal, setState);
  }, [state]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  return { state, signedIn, expire, signOut, retry };
}
EOF

cat << 'EOF' > apps/pos-web/src/hooks/use-terminal.ts
'use client';

import { useCallback, useEffect, useState } from 'react';
import { loadTerminals } from '../lib/terminal';
import { forgetTerminalId, rememberTerminalId, rememberedTerminalId } from '../lib/device-memory';
import type { ApiClient } from '../lib/api';
import type { TerminalSummary } from '../lib/api-types';
import type { TerminalState } from '../lib/terminal';

export interface TerminalHandle {
  readonly state: TerminalState;
  readonly choose: (terminal: TerminalSummary) => void;
  /** Re-read the list, keeping whichever till this browser remembers. */
  readonly reload: () => void;
  /** Forget this till and ask again — the only way to reach the selector. */
  readonly change: () => void;
}

export function useTerminal(
  api: ApiClient,
  enabled: boolean,
  onUnauthenticated: () => void,
): TerminalHandle {
  const [state, setState] = useState<TerminalState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Set by `change`, cleared as soon as the reload has consumed it. Without
  // it, "change terminal" re-reads the remembered id and lands straight back
  // on the same till.
  const [ignoreRemembered, setIgnoreRemembered] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let live = true;

    void loadTerminals(api, ignoreRemembered ? null : rememberedTerminalId(), {
      signal: controller.signal,
    }).then((next) => {
      if (!live) return;
      if (next.kind === 'blocked' && next.failure.action === 'reauthenticate') {
        onUnauthenticated();
        return;
      }
      if (next.kind === 'chosen') rememberTerminalId(next.terminal.id);
      setIgnoreRemembered(false);
      setState(next);
    });

    return () => {
      live = false;
      controller.abort();
    };
  }, [api, enabled, attempt, ignoreRemembered, onUnauthenticated]);

  const choose = useCallback((terminal: TerminalSummary) => {
    rememberTerminalId(terminal.id);
    setState((current) =>
      current.kind === 'choosing' || current.kind === 'chosen'
        ? { kind: 'chosen', terminal, settings: current.settings }
        : current,
    );
  }, []);

  const reload = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  const change = useCallback(() => {
    // Device context only. Nothing about the session is touched.
    forgetTerminalId();
    setIgnoreRemembered(true);
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  return { state, choose, reload, change };
}
EOF

cat << 'EOF' > apps/pos-web/src/hooks/use-shift.ts
'use client';

import { useCallback, useEffect, useState } from 'react';
import { loadShift } from '../lib/shift';
import { describeFailure } from '../lib/failures';
import type { ApiClient } from '../lib/api';
import type { ShiftState } from '../lib/shift';
import type { Failure } from '../lib/failures';

export interface ShiftHandle {
  readonly state: ShiftState;
  readonly opening: boolean;
  readonly openFailure: Failure | null;
  readonly open: (openingFloatMinor: string) => void;
  readonly refresh: () => void;
}

export function useShift(
  api: ApiClient,
  terminalId: string | null,
  userId: string,
  onUnauthenticated: () => void,
): ShiftHandle {
  const [state, setState] = useState<ShiftState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState(false);
  const [openFailure, setOpenFailure] = useState<Failure | null>(null);

  useEffect(() => {
    if (terminalId === null) return;
    const controller = new AbortController();
    let live = true;

    void loadShift(api, terminalId, userId, { signal: controller.signal }).then((next) => {
      if (!live) return;
      if (next.kind === 'blocked' && next.failure.action === 'reauthenticate') {
        onUnauthenticated();
        return;
      }
      setState(next);
    });

    return () => {
      live = false;
      controller.abort();
    };
  }, [api, terminalId, userId, attempt, onUnauthenticated]);

  const refresh = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  const open = useCallback(
    (openingFloatMinor: string) => {
      if (terminalId === null || opening) return;
      setOpening(true);
      setOpenFailure(null);

      void api
        .openShift({ terminalId, openingFloatMinor })
        .then((shift) => {
          // Even a shift this cashier just opened is checked, because the
          // server is the one that decided whose it is.
          setState(shift.userId === userId ? { kind: 'open', shift } : { kind: 'foreign', shift });
        })
        .catch((error: unknown) => {
          const failure = describeFailure(error);
          if (failure.action === 'reauthenticate') {
            onUnauthenticated();
            return;
          }
          // Somebody else opened it on this till a moment ago: re-read rather
          // than argue with the server about it.
          if (failure.action === 'refresh-shift') setAttempt((value) => value + 1);
          setOpenFailure(failure);
        })
        .finally(() => {
          setOpening(false);
        });
    },
    [api, terminalId, userId, opening, onUnauthenticated],
  );

  return { state, opening, openFailure, open, refresh };
}
EOF

cat << 'EOF' > apps/pos-web/src/hooks/use-product-search.ts
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createProductSearch, initialSearchState } from '../lib/search';
import type { ApiClient } from '../lib/api';
import type { SearchState } from '../lib/search';

/**
 * A small debounce, and the reason it is small.
 *
 * A person typing a product name generates a request every few keystrokes; a
 * scanner delivers a whole barcode in one burst and then an Enter. 140ms is
 * long enough to collapse the first and short enough that the second is not
 * waiting on a timer while the cashier reaches for the next item.
 */
const DEBOUNCE_MS = 140;

export interface SearchHandle {
  readonly term: string;
  readonly state: SearchState;
  readonly setTerm: (term: string) => void;
  readonly runNow: (term: string) => void;
  readonly reset: () => void;
}

export function useProductSearch(api: ApiClient): SearchHandle {
  const [term, setTermState] = useState('');
  const [state, setState] = useState<SearchState>(initialSearchState);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useMemo(() => createProductSearch(api, setState), [api]);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimer();
      search.cancel();
    };
  }, [clearTimer, search]);

  const setTerm = useCallback(
    (next: string) => {
      setTermState(next);
      clearTimer();
      timer.current = setTimeout(() => {
        void search.run(next);
      }, DEBOUNCE_MS);
    },
    [clearTimer, search],
  );

  const runNow = useCallback(
    (next: string) => {
      setTermState(next);
      clearTimer();
      void search.run(next);
    },
    [clearTimer, search],
  );

  const reset = useCallback(() => {
    clearTimer();
    search.cancel();
    setTermState('');
    setState(initialSearchState);
  }, [clearTimer, search]);

  return { term, state, setTerm, runNow, reset };
}
EOF

cat << 'EOF' > apps/pos-web/src/hooks/use-cart.ts
'use client';

import { useReducer } from 'react';
import { cartReducer } from '../lib/cart';
import type { CartAction, CartLine } from '../lib/cart';

export interface CartHandle {
  readonly lines: readonly CartLine[];
  readonly dispatch: (action: CartAction) => void;
}

export function useCart(): CartHandle {
  const [lines, dispatch] = useReducer(cartReducer, [] as readonly CartLine[]);
  return { lines, dispatch };
}
EOF

cat << 'EOF' > apps/pos-web/src/hooks/use-checkout.ts
'use client';

import { useCallback, useReducer, useRef } from 'react';
import { checkoutReducer, initialCheckoutState } from '../lib/checkout';
import { createCheckoutFlight } from '../lib/checkout-flight';
import { runCheckout } from '../lib/checkout-submit';
import type { ApiClient } from '../lib/api';
import type { CartLine } from '../lib/cart';
import type { CheckoutFlight } from '../lib/checkout-flight';
import type { CheckoutState } from '../lib/checkout';

export interface CheckoutHandle {
  readonly state: CheckoutState;
  readonly submit: (input: {
    readonly terminalId: string;
    readonly lines: readonly CartLine[];
    readonly cashReceivedMinor: string;
  }) => void;
  readonly dismiss: () => void;
  readonly newSale: () => void;
}

/**
 * A binding, and nothing more.
 *
 * The flight lives in a ref so it survives renders and can be claimed
 * synchronously; the attempt itself is `runCheckout`, which is where the
 * single-flight guard, the immutable intent and the outcome classification
 * are. Keeping them out of the hook is what makes them testable without a
 * renderer, and testable is how they stay correct.
 */
export function useCheckout(api: ApiClient, onUnauthenticated: () => void): CheckoutHandle {
  const [state, dispatch] = useReducer(checkoutReducer, initialCheckoutState);
  const flight = useRef<CheckoutFlight | null>(null);
  flight.current ??= createCheckoutFlight();

  const submit = useCallback(
    (input: {
      readonly terminalId: string;
      readonly lines: readonly CartLine[];
      readonly cashReceivedMinor: string;
    }) => {
      const owned = flight.current;
      if (owned === null) return;
      void runCheckout(api, owned, input, dispatch, onUnauthenticated);
    },
    [api, onUnauthenticated],
  );

  const dismiss = useCallback(() => {
    dispatch({ type: 'dismiss' });
  }, []);

  const newSale = useCallback(() => {
    flight.current?.reset();
    dispatch({ type: 'new-sale' });
  }, []);

  return { state, submit, dismiss, newSale };
}
EOF

say "Web — shared interface pieces"

cat << 'EOF' > apps/pos-web/src/components/status-note.tsx
import { cn } from '@korvi/ui';
import type { JSX, ReactNode } from 'react';

/**
 * An operational message.
 *
 * The tone is carried by a word as well as by a colour. A cashier who does not
 * distinguish red from amber still has to be able to tell "لم تكتمل" from
 * "تنبيه", and WCAG 1.4.1 says the same thing more formally
 * (KORVI-DESIGN-SYSTEM.md §7.3).
 */
export type NoteTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

const TONE: Record<NoteTone, { readonly box: string; readonly label: string }> = {
  neutral: { box: 'bg-muted text-muted-foreground ring-border', label: 'ملاحظة' },
  info: { box: 'bg-primary/10 text-primary ring-primary/30', label: 'معلومة' },
  warning: { box: 'bg-warning/10 text-warning ring-warning/30', label: 'تنبيه' },
  danger: { box: 'bg-destructive/10 text-destructive ring-destructive/30', label: 'لم تكتمل' },
  success: { box: 'bg-success/10 text-success ring-success/30', label: 'تمّت' },
};

export interface StatusNoteProps {
  readonly tone: NoteTone;
  readonly children: ReactNode;
  readonly live?: boolean;
  readonly className?: string;
}

export function StatusNote({ tone, children, live = false, className }: StatusNoteProps): JSX.Element {
  const style = TONE[tone];
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-md px-3 py-2 text-sm ring-1 ring-inset',
        style.box,
        className,
      )}
      {...(live ? { role: 'status', 'aria-live': 'polite' } : {})}
    >
      <span className="shrink-0 font-semibold">{style.label}:</span>
      <span>{children}</span>
    </p>
  );
}
EOF

cat << 'EOF' > apps/pos-web/src/components/field.tsx
import { cn } from '@korvi/ui';
import type { InputHTMLAttributes, JSX, ReactNode, Ref } from 'react';

/**
 * A labelled input.
 *
 * The label is a real <label for>, not a placeholder. A placeholder disappears
 * the moment somebody types, which is the moment they most need to know what
 * the field was — and a screen reader never sees it as a name at all.
 *
 * `h-touch` rather than the ERP's h-10: 40px is below the 44px minimum and
 * mis-taps with a thumb (§3.4).
 */
export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly invalid?: boolean;
  readonly trailing?: ReactNode;
  readonly inputRef?: Ref<HTMLInputElement>;
}

export function Field({
  id,
  label,
  hint,
  invalid = false,
  trailing,
  inputRef,
  className,
  ...rest
}: FieldProps): JSX.Element {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative flex items-center">
        <input
          {...rest}
          id={id}
          ref={inputRef}
          aria-invalid={invalid}
          aria-describedby={hintId}
          className={cn(
            'h-touch w-full rounded-md border border-input bg-background px-3 text-base',
            'text-foreground placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'disabled:cursor-not-allowed disabled:opacity-50',
            invalid && 'border-destructive',
            trailing !== undefined && 'pe-12',
            className,
          )}
        />
        {trailing !== undefined ? (
          <span className="absolute end-1 flex items-center">{trailing}</span>
        ) : null}
      </div>
      {hint === undefined ? null : (
        <span id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}
EOF

cat << 'EOF' > apps/pos-web/src/components/screen.tsx
import { KorviMark } from '@korvi/ui';
import type { JSX, ReactNode } from 'react';

/**
 * The full-height frame used before the cashier workspace opens.
 *
 * Deliberately quiet: this is a machine at a counter, not a landing page.
 */
export interface ScreenProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function Screen({ title, subtitle, children, footer }: ScreenProps): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <KorviMark size="lg" />
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
            {subtitle === undefined ? null : (
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {children}
        {footer === undefined ? null : (
          <p className="text-center text-xs text-muted-foreground">{footer}</p>
        )}
      </div>
    </main>
  );
}
EOF

say "Web — login"

cat << 'EOF' > apps/pos-web/src/components/login-screen.tsx
'use client';

import { useCallback, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { Field } from './field';
import { Screen } from './screen';
import { StatusNote } from './status-note';
import { describeFailure } from '../lib/failures';
import type { JSX } from 'react';
import type { ApiClient } from '../lib/api';
import type { Principal } from '../lib/api-types';
import type { Failure } from '../lib/failures';

/**
 * The way in.
 *
 * Three fields, one generic failure, and no token anywhere. On success the
 * server sets an HttpOnly cookie the browser manages and this code cannot
 * read; the response body is used only for the cashier's name and the
 * affordances to show.
 *
 * The failure message never says which field was wrong. "No such establishment"
 * and "wrong password" are two free probes, and a cashier cannot act on the
 * difference anyway.
 */
export interface LoginScreenProps {
  readonly api: ApiClient;
  readonly onAuthenticated: (principal: Principal) => void;
  readonly notice?: Failure | null;
}

export function LoginScreen({ api, onAuthenticated, notice }: LoginScreenProps): JSX.Element {
  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // The commonest way to submit a form twice is to press Enter twice
      // before the first request returns.
      if (busy) return;
      setBusy(true);
      setFailure(null);
      try {
        onAuthenticated(await api.login({ tenantSlug, email, password }));
      } catch (error) {
        setFailure(describeFailure(error));
        setPassword('');
      } finally {
        setBusy(false);
      }
    },
    [api, busy, tenantSlug, email, password, onAuthenticated],
  );

  const shown = failure ?? notice ?? null;

  return (
    <Screen title="تسجيل الدخول" subtitle="نقطة بيع كورفي" footer="صُدرت عبر Korvi">
      <CardSurface className="p-6">
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          {shown === null ? null : (
            <StatusNote tone={shown.action === 'retry-same' ? 'warning' : 'danger'} live>
              {shown.message}
            </StatusNote>
          )}

          <Field
            id="tenant-slug"
            label="رمز المنشأة"
            name="organization"
            autoComplete="organization"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            dir="ltr"
            required
            autoFocus
            disabled={busy}
            value={tenantSlug}
            onChange={(event) => {
              setTenantSlug(event.target.value);
            }}
          />

          <Field
            id="email"
            label="البريد الإلكتروني"
            name="email"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            dir="ltr"
            required
            disabled={busy}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />

          <Field
            id="password"
            label="كلمة المرور"
            name="password"
            type={revealed ? 'text' : 'password'}
            autoComplete="current-password"
            dir="ltr"
            required
            disabled={busy}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            trailing={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={revealed}
                aria-label={revealed ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                disabled={busy}
                onClick={() => {
                  setRevealed((value) => !value);
                }}
              >
                {revealed ? 'إخفاء' : 'إظهار'}
              </Button>
            }
          />

          <Button type="submit" size="lg" loading={busy} className="mt-2 w-full">
            {busy ? 'جارٍ التحقق…' : 'دخول'}
          </Button>
        </form>
      </CardSurface>
    </Screen>
  );
}
EOF

say "Web — choosing a till, and opening its drawer"

cat << 'EOF' > apps/pos-web/src/components/terminal-picker.tsx
'use client';

import { BidiIsolate, Button, CardSurface } from '@korvi/ui';
import { Screen } from './screen';
import { StatusNote } from './status-note';
import type { JSX } from 'react';
import type { TerminalSummary } from '../lib/api-types';
import type { Failure } from '../lib/failures';

export interface TerminalPickerProps {
  readonly terminals: readonly TerminalSummary[];
  readonly onChoose: (terminal: TerminalSummary) => void;
  readonly onSignOut: () => void;
}

export function TerminalPicker({
  terminals,
  onChoose,
  onSignOut,
}: TerminalPickerProps): JSX.Element {
  return (
    <Screen title="اختر الصندوق" subtitle="الصناديق المفعّلة في فرعك">
      <CardSurface className="p-4">
        <ul className="flex flex-col gap-2">
          {terminals.map((terminal) => (
            <li key={terminal.id}>
              <Button
                variant="outline"
                size="lg"
                className="w-full justify-between"
                onClick={() => {
                  onChoose(terminal);
                }}
              >
                <span className="font-medium">{terminal.label}</span>
                <BidiIsolate className="text-sm text-muted-foreground">{terminal.code}</BidiIsolate>
              </Button>
            </li>
          ))}
        </ul>
      </CardSurface>
      <Button variant="ghost" onClick={onSignOut} className="mx-auto">
        تسجيل الخروج
      </Button>
    </Screen>
  );
}

export interface BlockedScreenProps {
  readonly title: string;
  readonly failure: Failure;
  readonly tone?: 'warning' | 'danger';
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly onChangeTerminal?: () => void;
  readonly onSignOut?: () => void;
  readonly signOutDisabled?: boolean;
}

/** A state the cashier cannot sell out of. Says what is wrong and who fixes it. */
export function BlockedScreen({
  title,
  failure,
  tone = 'warning',
  onRetry,
  retryLabel = 'إعادة المحاولة',
  onChangeTerminal,
  onSignOut,
  signOutDisabled = false,
}: BlockedScreenProps): JSX.Element {
  return (
    <Screen title={title}>
      <CardSurface className="flex flex-col gap-4 p-6">
        <StatusNote tone={tone} live>
          {failure.message}
        </StatusNote>
        <div className="flex flex-col gap-2">
          {onRetry === undefined ? null : (
            <Button size="lg" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {onChangeTerminal === undefined ? null : (
            <Button variant="outline" size="lg" onClick={onChangeTerminal}>
              اختيار صندوق آخر
            </Button>
          )}
          {onSignOut === undefined ? null : (
            <Button variant="ghost" onClick={onSignOut} disabled={signOutDisabled}>
              تسجيل الخروج
            </Button>
          )}
        </div>
      </CardSurface>
    </Screen>
  );
}
EOF

cat << 'EOF' > apps/pos-web/src/components/shift-gate.tsx
'use client';

import { useCallback, useState } from 'react';
import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { Field } from './field';
import { Screen } from './screen';
import { StatusNote } from './status-note';
import { formatMinor, parseSarToMinor } from '../lib/money';
import type { JSX } from 'react';
import type { TerminalSummary } from '../lib/api-types';
import type { Failure } from '../lib/failures';

/**
 * Opening the drawer.
 *
 * The float is typed in riyals and sent in halalas, converted by string
 * arithmetic through the domain's own parser. "20.5" is 2050 and "20.50" is
 * 2050; neither goes anywhere near a float (ADR-0002).
 */
export interface ShiftGateProps {
  readonly terminal: TerminalSummary;
  readonly busy: boolean;
  readonly failure: Failure | null;
  readonly onOpen: (openingFloatMinor: string) => void;
  readonly onChangeTerminal: (() => void) | null;
  readonly onSignOut: () => void;
}

export function ShiftGate({
  terminal,
  busy,
  failure,
  onOpen,
  onChangeTerminal,
  onSignOut,
}: ShiftGateProps): JSX.Element {
  const [amount, setAmount] = useState('');
  const [touched, setTouched] = useState(false);

  const parsedAmount = parseSarToMinor(amount);
  const invalid = touched && !parsedAmount.ok && amount.trim() !== '';

  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setTouched(true);
      const parsed = parseSarToMinor(amount.trim() === '' ? '0' : amount);
      if (!parsed.ok || busy) return;
      onOpen(parsed.value);
    },
    [amount, busy, onOpen],
  );

  return (
    <Screen
      title="افتح وردية"
      subtitle={`لا توجد وردية مفتوحة على ${terminal.label}`}
    >
      <CardSurface className="p-6">
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          {failure === null ? null : (
            <StatusNote tone="warning" live>
              {failure.message}
            </StatusNote>
          )}

          <Field
            id="opening-float"
            label="النقد الافتتاحي في الدرج (ريال)"
            inputMode="decimal"
            autoComplete="off"
            dir="ltr"
            autoFocus
            disabled={busy}
            invalid={invalid}
            value={amount}
            hint={
              parsedAmount.ok ? (
                <span>
                  يُسجَّل بمقدار <Numeric value={formatMinor(parsedAmount.value)} /> ريال
                </span>
              ) : (
                'اتركه فارغاً إذا كان الدرج صفراً. حتى منزلتين عشريتين.'
              )
            }
            onChange={(event) => {
              setAmount(event.target.value);
            }}
            onBlur={() => {
              setTouched(true);
            }}
          />

          <Button type="submit" size="lg" loading={busy} className="mt-2 w-full">
            {busy ? 'جارٍ الفتح…' : 'فتح الوردية'}
          </Button>
        </form>
      </CardSurface>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          الصندوق: <BidiIsolate>{terminal.code}</BidiIsolate>
        </span>
        <span className="flex gap-2">
          {onChangeTerminal === null ? null : (
            <Button variant="ghost" size="sm" onClick={onChangeTerminal}>
              تغيير الصندوق
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            خروج
          </Button>
        </span>
      </div>
    </Screen>
  );
}
EOF

say "Web — the cashier workspace"

cat << 'EOF' > apps/pos-web/src/components/top-bar.tsx
'use client';

import { BidiIsolate, Button, KorviMark } from '@korvi/ui';
import type { JSX } from 'react';
import type { TerminalSummary } from '../lib/api-types';

export interface TopBarProps {
  readonly cashierName: string;
  readonly terminal: TerminalSummary;
  readonly onSignOut: () => void;
  /** True while a transaction of unknown outcome is outstanding. */
  readonly signOutBlocked: boolean;
  readonly busy: boolean;
}

/**
 * Where the cashier is, in one line.
 *
 * The shift indicator names its state in words as well as colour: a green dot
 * on its own is not a status anybody can read out loud (§7.3).
 */
export function TopBar({
  cashierName,
  terminal,
  onSignOut,
  signOutBlocked,
  busy,
}: TopBarProps): JSX.Element {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4">
      <div className="flex items-center gap-4">
        <KorviMark size="sm" />
        {/* A truncated UUID is an implementation detail, not branch context.
            There is no safe display name in the contract this strike may read,
            so the till says which branch it means without pretending to name
            it. */}
        <span className="hidden text-sm text-muted-foreground sm:inline">الفرع الحالي</span>
        <span className="text-sm text-foreground">
          {terminal.label} · <BidiIsolate>{terminal.code}</BidiIsolate>
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2 rounded-md bg-success/10 px-2 py-1 text-xs font-medium text-success ring-1 ring-inset ring-success/30">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-success" />
          وردية مفتوحة
        </span>
        <span className="hidden text-sm font-medium text-foreground md:inline">{cashierName}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSignOut}
          disabled={busy || signOutBlocked}
          title={signOutBlocked ? 'لا يمكن الخروج قبل حسم العملية الحالية.' : undefined}
        >
          خروج
        </Button>
      </div>
    </header>
  );
}
EOF

cat << 'EOF' > apps/pos-web/src/components/product-panel.tsx
'use client';

import { BidiIsolate, CardSurface, Numeric, cn } from '@korvi/ui';
import { Field } from './field';
import { StatusNote } from './status-note';
import { formatMinor } from '../lib/money';
import type { JSX, Ref } from 'react';
import type { ProductSummary } from '../lib/api-types';
import type { SearchState } from '../lib/search';

/**
 * Search, and the results of searching.
 *
 * The field is the largest thing on the screen because it is where every sale
 * starts, and it keeps the focus: a scanner types into whatever is focused, so
 * anything that steals focus turns the next scan into keystrokes nowhere.
 *
 * The results area holds its height while a query is in flight. A list that
 * collapses and re-expands moves the item the cashier was reaching for.
 */
export interface ProductPanelProps {
  readonly term: string;
  readonly state: SearchState;
  readonly disabled: boolean;
  readonly inputRef: Ref<HTMLInputElement>;
  readonly onTermChange: (term: string) => void;
  readonly onSubmitTerm: () => void;
  readonly onPick: (product: ProductSummary) => void;
}

export function ProductPanel({
  term,
  state,
  disabled,
  inputRef,
  onTermChange,
  onSubmitTerm,
  onPick,
}: ProductPanelProps): JSX.Element {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" aria-label="البحث عن صنف">
      <Field
        id="product-search"
        label="ابحث أو امسح الباركود"
        type="search"
        inputMode="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
        disabled={disabled}
        value={term}
        inputRef={inputRef}
        className="h-touch-lg text-lg"
        placeholder="اسم الصنف، الرمز، أو الباركود"
        onChange={(event) => {
          onTermChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onSubmitTerm();
          }
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={state.status === 'loading'}>
        {state.status === 'failed' && state.failure !== null ? (
          <StatusNote tone="warning" live>
            {state.failure.message}
          </StatusNote>
        ) : null}

        {state.status === 'idle' ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            اكتب اسم الصنف أو امسح الباركود لبدء البيع.
          </p>
        ) : null}

        {state.status === 'loading' ? (
          <ul className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {[0, 1, 2, 3].map((slot) => (
              <li
                key={slot}
                aria-hidden="true"
                className="h-28 animate-pulse rounded-lg border border-border bg-muted"
              />
            ))}
          </ul>
        ) : null}

        {state.status === 'ready' && state.results.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground" role="status">
            لا توجد نتائج مطابقة.
          </p>
        ) : null}

        {state.status === 'ready' && state.results.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {state.results.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onPick(product);
                  }}
                  className={cn(
                    'flex h-28 w-full flex-col justify-between rounded-lg border border-border',
                    'bg-card p-3 text-start transition-colors',
                    'hover:border-primary/40 hover:bg-accent',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    'disabled:pointer-events-none disabled:opacity-50',
                  )}
                >
                  <span className="line-clamp-2 text-sm font-medium text-card-foreground">
                    {product.nameAr}
                  </span>
                  <span className="flex items-end justify-between gap-2">
                    <BidiIsolate className="text-xs text-muted-foreground">
                      {product.sku}
                    </BidiIsolate>
                    <Numeric
                      value={formatMinor(product.priceMinor)}
                      className="text-lg font-semibold text-foreground"
                    />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function ProductPanelSurface({ children }: { readonly children: JSX.Element }): JSX.Element {
  return <CardSurface className="flex min-h-0 flex-1 flex-col p-4">{children}</CardSurface>;
}
EOF

cat << 'EOF' > apps/pos-web/src/components/cart-panel.tsx
'use client';

import { useEffect, useState } from 'react';
import { BidiIsolate, Button, Numeric } from '@korvi/ui';
import { formatMinor } from '../lib/money';
import { formatScaled, parseQuantityToScaled } from '../lib/quantity';
import type { JSX } from 'react';
import type { PricedCart } from '@korvi/domain';
import type { CartAction, CartLine } from '../lib/cart';

/**
 * The basket.
 *
 * Quantity is edited as text and committed as a scaled integer, so a weighed
 * item can be typed as 1.250 without a float ever existing. A unit item is
 * stepped rather than typed, because a tin cannot be sold in thirds and the
 * server refuses one that is.
 */
interface CartRowProps {
  readonly line: CartLine;
  readonly locked: boolean;
  readonly lineTotalMinor: string;
  readonly dispatch: (action: CartAction) => void;
}

function CartRow({ line, locked, lineTotalMinor, dispatch }: CartRowProps): JSX.Element {
  const [draft, setDraft] = useState(() => formatScaled(line.quantityScaled));
  const [invalid, setInvalid] = useState(false);

  // The line is the authority; the field is a draft of it. Anything that
  // changes the quantity elsewhere (a step, a re-scan) has to show up here.
  useEffect(() => {
    setDraft(formatScaled(line.quantityScaled));
    setInvalid(false);
  }, [line.quantityScaled]);

  const commit = (): void => {
    const parsed = parseQuantityToScaled(draft, line.productType);
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    dispatch({ type: 'set-quantity', productId: line.productId, quantityScaled: parsed.value });
  };

  const quantityLabel = `كمية ${line.nameAr}`;
  const stepped = line.productType === 'unit';

  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-card-foreground">{line.nameAr}</span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <BidiIsolate>{line.sku}</BidiIsolate>
            <span aria-hidden="true">·</span>
            <Numeric value={formatMinor(line.unitPriceMinor)} />
            {line.unitLabel === null ? null : <span>/ {line.unitLabel}</span>}
          </span>
        </div>
        <Numeric
          value={formatMinor(lineTotalMinor)}
          className="shrink-0 text-lg font-semibold text-foreground"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {/* Whole-unit steppers belong to whole-unit products. "One less" has
              no meaning on 0.750 kg, and a generic implementation of it is how
              a minus button ends up increasing a quantity. A weighed line is
              edited in the field beside this. */}
          {stepped ? (
            <Button
              variant="outline"
              size="icon"
              aria-label={`إنقاص ${quantityLabel}`}
              disabled={locked}
              onClick={() => {
                dispatch({ type: 'step', productId: line.productId, direction: -1 });
              }}
            >
              −
            </Button>
          ) : null}

          <label className="sr-only" htmlFor={`qty-${line.productId}`}>
            {quantityLabel}
          </label>
          <input
            id={`qty-${line.productId}`}
            inputMode="decimal"
            dir="ltr"
            disabled={locked}
            aria-invalid={invalid}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
            className="numeric h-touch w-20 rounded-md border border-input bg-background text-center text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 aria-[invalid=true]:border-destructive"
          />

          {stepped ? (
            <Button
              variant="outline"
              size="icon"
              aria-label={`زيادة ${quantityLabel}`}
              disabled={locked}
              onClick={() => {
                dispatch({ type: 'step', productId: line.productId, direction: 1 });
              }}
            >
              +
            </Button>
          ) : null}
          {stepped ? null : (
            <span className="text-xs text-muted-foreground">{line.unitLabel ?? 'وزن'}</span>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          disabled={locked}
          aria-label={`حذف ${line.nameAr}`}
          onClick={() => {
            dispatch({ type: 'remove', productId: line.productId });
          }}
        >
          حذف
        </Button>
      </div>

      {invalid ? (
        <p className="text-xs text-destructive" role="status">
          كمية غير صالحة لهذا الصنف.
        </p>
      ) : null}
    </li>
  );
}

export interface CartPanelProps {
  readonly lines: readonly CartLine[];
  /** Priced once by the workspace and passed down, so the figures cannot diverge. */
  readonly preview: PricedCart;
  readonly locked: boolean;
  readonly dispatch: (action: CartAction) => void;
}

export function CartPanel({ lines, preview, locked, dispatch }: CartPanelProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between pb-2">
        <h2 className="text-base font-semibold text-card-foreground">السلة</h2>
        {lines.length === 0 ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={locked}
            onClick={() => {
              dispatch({ type: 'clear' });
            }}
          >
            إفراغ
          </Button>
        )}
      </div>

      {lines.length === 0 ? (
        <p className="flex flex-1 items-center justify-center py-8 text-center text-sm text-muted-foreground">
          السلة فارغة.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {lines.map((line, index) => (
            <CartRow
              key={line.productId}
              line={line}
              locked={locked}
              lineTotalMinor={(preview.lines[index]?.total.minor ?? 0n).toString()}
              dispatch={dispatch}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
EOF

say "Web — payment and the completed sale"

cat << 'EOF' > apps/pos-web/src/components/checkout-panel.tsx
'use client';

import { Button, Numeric } from '@korvi/ui';
import { Field } from './field';
import { StatusNote } from './status-note';
import { changeMinor, formatMinor } from '../lib/money';
import type { JSX, Ref } from 'react';
import type { CheckoutState } from '../lib/checkout';

/**
 * Cash, and what is owed back.
 *
 * The total shown here is a preview computed by the domain from the catalogue
 * prices the server sent. It is never what gets printed: the sale that comes
 * back from POST /v1/sales carries the figures, and those replace these.
 *
 * The button stays disabled while a request is in flight. That is the whole
 * defence against a double charge on this screen, and it is not optional.
 */
export interface CheckoutPanelProps {
  readonly totalMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly cash: string;
  readonly cashMinor: string | null;
  readonly lineCount: number;
  readonly locked: boolean;
  readonly state: CheckoutState;
  readonly cashRef: Ref<HTMLInputElement>;
  readonly onCashChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onDismiss: () => void;
}

export function CheckoutPanel({
  totalMinor,
  netMinor,
  vatMinor,
  cash,
  cashMinor,
  lineCount,
  locked,
  state,
  cashRef,
  onCashChange,
  onSubmit,
  onDismiss,
}: CheckoutPanelProps): JSX.Element {
  const change = cashMinor === null ? null : changeMinor(totalMinor, cashMinor);
  const submitting = state.phase === 'submitting';
  const blocked = state.failure?.action === 'blocking';
  const canSubmit = lineCount > 0 && cashMinor !== null && change !== null && !blocked;
  // The cash amount is part of the fingerprint the server compares. Editing it
  // while an attempt is outstanding would turn the retry into a different
  // intent, which the server would correctly refuse as a conflict.
  const cashFrozen = locked;

  return (
    <div className="flex shrink-0 flex-col gap-3 border-t border-border pt-3">
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between text-muted-foreground">
          <dt>الإجمالي قبل الضريبة</dt>
          <dd>
            <Numeric value={formatMinor(netMinor)} />
          </dd>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <dt>ضريبة القيمة المضافة</dt>
          <dd>
            <Numeric value={formatMinor(vatMinor)} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between pt-1">
          <dt className="text-base font-semibold text-card-foreground">المطلوب</dt>
          <dd>
            <Numeric value={formatMinor(totalMinor)} className="text-3xl font-bold text-foreground" />
          </dd>
        </div>
      </dl>

      <Field
        id="cash-received"
        label="النقد المستلم (ريال)"
        inputMode="decimal"
        autoComplete="off"
        dir="ltr"
        disabled={cashFrozen}
        invalid={cash.trim() !== '' && cashMinor === null}
        value={cash}
        inputRef={cashRef}
        className="h-touch-lg text-lg"
        onChange={(event) => {
          onCashChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && canSubmit && !submitting && !cashFrozen) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />

      <div className="flex items-baseline justify-between rounded-md bg-muted px-3 py-2 text-sm">
        <span className="text-muted-foreground">الباقي</span>
        {change === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Numeric value={formatMinor(change)} className="text-lg font-semibold text-foreground" />
        )}
      </div>

      {state.failure === null ? null : (
        <StatusNote tone={state.failure.action === 'blocking' ? 'danger' : 'warning'} live>
          {state.failure.message}
        </StatusNote>
      )}

      {state.attemptOutstanding ? (
        <StatusNote tone="warning">
          لم تصل نتيجة العملية. السلة مقفلة كما هي — أعد الإرسال بنفس العملية، ولا تُنشئ عملية جديدة.
        </StatusNote>
      ) : null}

      <div className="flex gap-2">
        <Button
          size="lg"
          className="flex-1"
          loading={submitting}
          disabled={!canSubmit}
          onClick={onSubmit}
        >
          {submitting ? 'جارٍ الإتمام…' : state.attemptOutstanding ? 'إعادة الإرسال' : 'إتمام البيع'}
        </Button>
        {state.failure === null || state.attemptOutstanding ? null : (
          <Button variant="outline" size="lg" onClick={onDismiss}>
            إخفاء
          </Button>
        )}
      </div>
    </div>
  );
}
EOF

cat << 'EOF' > apps/pos-web/src/components/sale-receipt.tsx
'use client';

import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { formatMinor } from '../lib/money';
import { formatScaled } from '../lib/quantity';
import { formatTimestamp } from '../lib/datetime';
import type { JSX } from 'react';
import type { SaleSummary } from '../lib/api-types';

/**
 * The sale, as the server recorded it.
 *
 * Every figure below comes from the response. Nothing is recomputed from the
 * cart, which by now is stale by definition: the server priced the sale from
 * its own catalogue, allocated the receipt number inside the transaction, and
 * decided the change. Re-deriving any of it here would be inventing a second
 * opinion about a tax document.
 */
export interface SaleReceiptProps {
  readonly sale: SaleSummary;
  readonly replayed: boolean;
  readonly onNewSale: () => void;
}

export function SaleReceipt({ sale, replayed, onNewSale }: SaleReceiptProps): JSX.Element {
  return (
    <CardSurface className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="inline-flex w-fit items-center rounded-md bg-success/10 px-2 py-1 text-xs font-semibold text-success ring-1 ring-inset ring-success/30">
            {replayed ? 'عملية مسجّلة مسبقاً' : 'تمّت العملية'}
          </span>
          <h2 className="text-lg font-semibold text-card-foreground">
            فاتورة <BidiIsolate>{sale.invoiceNumber}</BidiIsolate>
          </h2>
          <p className="text-xs text-muted-foreground">
            الكاشير {sale.cashierName} ·{' '}
            <BidiIsolate>{formatTimestamp(sale.issuedAt)}</BidiIsolate>
          </p>
        </div>
        <Numeric value={formatMinor(sale.totalMinor)} className="text-3xl font-bold text-foreground" />
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto border-y border-border">
        {sale.lines.map((line) => (
          <li
            key={line.lineNumber}
            className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm text-card-foreground">{line.nameAr}</span>
              <span className="text-xs text-muted-foreground">
                <Numeric value={formatScaled(line.quantityScaled)} />
                {' × '}
                <Numeric value={formatMinor(line.unitPriceMinor)} />
              </span>
            </span>
            <Numeric value={formatMinor(line.totalMinor)} className="text-sm font-medium" />
          </li>
        ))}
      </ul>

      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between text-muted-foreground">
          <dt>قبل الضريبة</dt>
          <dd>
            <Numeric value={formatMinor(sale.netMinor)} />
          </dd>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <dt>ضريبة القيمة المضافة</dt>
          <dd>
            <Numeric value={formatMinor(sale.vatMinor)} />
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-card-foreground">النقد المستلم</dt>
          <dd>
            <Numeric value={formatMinor(sale.cashReceivedMinor)} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between rounded-md bg-accent px-3 py-2">
          <dt className="font-semibold text-accent-foreground">الباقي للعميل</dt>
          <dd>
            <Numeric
              value={formatMinor(sale.changeMinor)}
              className="text-2xl font-bold text-accent-foreground"
            />
          </dd>
        </div>
      </dl>

      <Button size="lg" className="w-full" autoFocus onClick={onNewSale}>
        عملية بيع جديدة
      </Button>
    </CardSurface>
  );
}
EOF

say "Web — the workspace, assembled"

cat << 'EOF' > apps/pos-web/src/components/cashier-screen.tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardSurface } from '@korvi/ui';
import { TopBar } from './top-bar';
import { ProductPanel } from './product-panel';
import { CartPanel } from './cart-panel';
import { CheckoutPanel } from './checkout-panel';
import { SaleReceipt } from './sale-receipt';
import { StatusNote } from './status-note';
import { previewCart } from '../lib/cart';
import { intentLocked, signOutBlocked } from '../lib/checkout';
import { shiftNeedsRefresh } from '../lib/shift';
import { autoAddCandidate } from '../lib/search';
import { parseSarToMinor } from '../lib/money';
import { useCart } from '../hooks/use-cart';
import { useCheckout } from '../hooks/use-checkout';
import { useProductSearch } from '../hooks/use-product-search';
import type { JSX } from 'react';
import type { PriceMode } from '@korvi/domain';
import type { ApiClient } from '../lib/api';
import type { Principal, ProductSummary, ShiftSummary, TerminalSummary } from '../lib/api-types';

/**
 * Where a cashier spends the whole day.
 *
 * The eye moves search -> product -> cart -> total -> pay, and the layout says
 * so: the search field is the largest control on the screen and the total is
 * the largest number. Nothing else competes for attention.
 *
 * One rule governs everything below: while a checkout may or may not have
 * committed, nothing that feeds the request may change — not the basket, not a
 * quantity, not the cash, not the search box, and not the session. The retry
 * has to be able to resend the same intent, and an edited field would make it
 * a different one.
 */
export interface CashierScreenProps {
  readonly api: ApiClient;
  readonly principal: Principal;
  readonly terminal: TerminalSummary;
  /** The drawer this till is selling through. The server re-checks it anyway. */
  readonly shift: ShiftSummary;
  /** From tenant_settings, by way of GET /v1/terminals. Never guessed here. */
  readonly priceMode: PriceMode;
  readonly onSignOut: () => void;
  readonly onExpired: () => void;
  readonly onShiftChanged: () => void;
}

export function CashierScreen({
  api,
  principal,
  terminal,
  shift,
  priceMode,
  onSignOut,
  onExpired,
  onShiftChanged,
}: CashierScreenProps): JSX.Element {
  const cart = useCart();
  const search = useProductSearch(api);
  const checkout = useCheckout(api, onExpired);
  const [cash, setCash] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const cashInput = useRef<HTMLInputElement>(null);

  const preview = useMemo(() => previewCart(cart.lines, priceMode), [cart.lines, priceMode]);
  const parsedCash = parseSarToMinor(cash);
  const cashMinor = parsedCash.ok ? parsedCash.value : null;
  const locked = intentLocked(checkout.state);
  const outstanding = checkout.state.attemptOutstanding;

  const focusSearch = useCallback(() => {
    searchInput.current?.focus();
  }, []);

  const add = useCallback(
    (product: ProductSummary) => {
      if (locked) return;
      cart.dispatch({ type: 'add', product });
      search.reset();
      // Straight back to the field, so the next scan lands somewhere.
      focusSearch();
    },
    [cart, search, locked, focusSearch],
  );

  const submitTerm = useCallback(() => {
    if (locked) return;
    const candidate = autoAddCandidate(search.state);
    if (candidate !== null) {
      add(candidate);
      return;
    }
    search.runNow(search.term);
  }, [search, add, locked]);

  // A shift that stopped being usable — closed under the till, taken by
  // another cashier, or never opened — is not something to keep selling
  // through. The screen above re-reads it and decides.
  useEffect(() => {
    if (shiftNeedsRefresh(checkout.state.failure?.action)) onShiftChanged();
  }, [checkout.state.failure, onShiftChanged]);

  // The cash field is where the cashier has to look next.
  useEffect(() => {
    if (checkout.state.failure?.action === 'amend-cash') cashInput.current?.focus();
  }, [checkout.state.failure]);

  const newSale = useCallback(() => {
    checkout.newSale();
    cart.dispatch({ type: 'clear' });
    setCash('');
    search.reset();
    focusSearch();
  }, [checkout, cart, search, focusSearch]);

  const submit = useCallback(() => {
    if (cashMinor === null) return;
    checkout.submit({
      terminalId: terminal.id,
      lines: cart.lines,
      cashReceivedMinor: cashMinor,
    });
  }, [checkout, terminal.id, cart.lines, cashMinor]);

  const completed = checkout.state.phase === 'succeeded' ? checkout.state.sale : null;
  // Named so the value is used rather than merely accepted: a screen that
  // takes a shift it never reads is a screen that will drift out of step.
  const drawerLabel = `الوردية ${shift.id.slice(0, 8)}`;

  return (
    <div className="flex h-screen flex-col bg-muted/40">
      <TopBar
        cashierName={principal.user.displayName}
        terminal={terminal}
        busy={checkout.state.phase === 'submitting'}
        signOutBlocked={signOutBlocked(checkout.state)}
        onSignOut={onSignOut}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
        <CardSurface className="flex min-h-0 flex-1 flex-col p-4">
          <ProductPanel
            term={search.term}
            state={search.state}
            disabled={locked}
            inputRef={searchInput}
            onTermChange={search.setTerm}
            onSubmitTerm={submitTerm}
            onPick={add}
          />
        </CardSurface>

        <aside
          className="flex min-h-0 w-full shrink-0 flex-col lg:w-[26rem]"
          aria-label={`السلة والدفع — ${drawerLabel}`}
        >
          {completed === null ? (
            <CardSurface className="flex min-h-0 flex-1 flex-col p-4">
              {outstanding ? (
                <StatusNote tone="warning" className="mb-3" live>
                  العملية معلّقة ولم تُحسم. السلة والمبلغ مقفلان حتى تُعاد بنفس العملية.
                </StatusNote>
              ) : null}
              <CartPanel
                lines={cart.lines}
                preview={preview}
                locked={locked}
                dispatch={cart.dispatch}
              />
              <CheckoutPanel
                totalMinor={preview.total.minor.toString()}
                netMinor={preview.net.minor.toString()}
                vatMinor={preview.vat.minor.toString()}
                cash={cash}
                cashMinor={cashMinor}
                lineCount={cart.lines.length}
                locked={locked}
                state={checkout.state}
                cashRef={cashInput}
                onCashChange={setCash}
                onSubmit={submit}
                onDismiss={checkout.dismiss}
              />
            </CardSurface>
          ) : (
            <SaleReceipt
              sale={completed}
              replayed={checkout.state.replayed}
              onNewSale={newSale}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
EOF

say "Web — the shell that decides which screen you are on"

cat << 'EOF' > apps/pos-web/src/components/pos-app.tsx
'use client';

import { useCallback, useMemo } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { LoginScreen } from './login-screen';
import { Screen } from './screen';
import { StatusNote } from './status-note';
import { BlockedScreen, TerminalPicker } from './terminal-picker';
import { ShiftGate } from './shift-gate';
import { CashierScreen } from './cashier-screen';
import { createApiClient } from '../lib/api';
import { FOREIGN_SHIFT } from '../lib/shift';
import { useSession } from '../hooks/use-session';
import { useTerminal } from '../hooks/use-terminal';
import { useShift } from '../hooks/use-shift';
import type { JSX } from 'react';
import type { ApiClient } from '../lib/api';

/**
 * One decision, made in one place: which screen is the cashier on.
 *
 * Session, then till, then drawer, then selling. Each stage waits for the one
 * before it, and none of them is a security boundary — every request the
 * screens below make is re-checked by the server. What this buys is that a
 * cashier is never shown a till they cannot use or a basket they cannot sell.
 */
export interface PosAppProps {
  /** Injected by tests. Production builds the real client against this origin. */
  readonly api?: ApiClient;
}

function Waiting({ label }: { readonly label: string }): JSX.Element {
  return (
    <Screen title="نقطة بيع كورفي">
      <CardSurface className="p-6">
        <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
          {label}
        </p>
      </CardSurface>
    </Screen>
  );
}

export function PosApp({ api: injected }: PosAppProps = {}): JSX.Element {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const session = useSession(api);

  const authenticated = session.state.kind === 'ready';
  const terminal = useTerminal(api, authenticated, session.expire);
  const chosenTerminalId = terminal.state.kind === 'chosen' ? terminal.state.terminal.id : null;
  const cashierId = session.state.kind === 'ready' ? session.state.principal.user.id : '';
  const shift = useShift(api, chosenTerminalId, cashierId, session.expire);

  const signOut = useCallback(() => {
    session.signOut();
  }, [session]);

  if (session.state.kind === 'loading') return <Waiting label="جارٍ التحقق من الجلسة…" />;

  // Selling is already blocked here, before the request has been answered.
  if (session.state.kind === 'signing-out') {
    return <Waiting label="جارٍ تسجيل الخروج بأمان…" />;
  }

  /*
   * The one state that must never quietly become the login screen.
   *
   * The session cookie is HttpOnly: only the server can revoke it, and this
   * code cannot even read it. If the logout request did not arrive, the
   * session is still live — so showing the ordinary login form would tell a
   * cashier they had signed out of a till that will restore them on reload.
   * On a shared machine that is the next person's sale under the last
   * person's name.
   */
  if (session.state.kind === 'logout-failed') {
    return (
      <BlockedScreen
        title="لم يتم تأكيد الخروج"
        tone="danger"
        failure={{
          code: 'logout_unconfirmed',
          message:
            'لم يؤكّد الخادم إنهاء الجلسة، وقد تكون ما تزال مفتوحة. لا تترك الصندوق قبل نجاح تسجيل الخروج.',
          action: 'blocking',
        }}
        onRetry={signOut}
        retryLabel="إعادة محاولة تسجيل الخروج"
      />
    );
  }

  if (session.state.kind === 'unavailable') {
    return (
      <Screen title="الخدمة غير متاحة">
        <CardSurface className="flex flex-col gap-4 p-6">
          <StatusNote tone="warning" live>
            {session.state.failure.message}
          </StatusNote>
          <Button size="lg" onClick={session.retry}>
            إعادة المحاولة
          </Button>
        </CardSurface>
      </Screen>
    );
  }

  if (session.state.kind === 'anonymous') {
    return (
      <LoginScreen api={api} onAuthenticated={session.signedIn} notice={session.state.notice} />
    );
  }

  const principal = session.state.principal;

  if (terminal.state.kind === 'loading') return <Waiting label="جارٍ قراءة صناديق الفرع…" />;
  if (terminal.state.kind === 'blocked') {
    return (
      <BlockedScreen
        title="لا يمكن بدء البيع"
        failure={terminal.state.failure}
        onRetry={terminal.reload}
        onSignOut={signOut}
      />
    );
  }
  if (terminal.state.kind === 'choosing') {
    return (
      <TerminalPicker
        terminals={terminal.state.terminals}
        onChoose={terminal.choose}
        onSignOut={signOut}
      />
    );
  }

  const chosen = terminal.state.terminal;
  const settings = terminal.state.settings;

  if (shift.state.kind === 'loading') return <Waiting label="جارٍ قراءة حالة الوردية…" />;
  if (shift.state.kind === 'blocked') {
    return (
      <BlockedScreen
        title="تعذّر قراءة الوردية"
        failure={shift.state.failure}
        onRetry={shift.refresh}
        onChangeTerminal={terminal.change}
        onSignOut={signOut}
      />
    );
  }
  if (shift.state.kind === 'foreign') {
    // No takeover is offered, because none exists: the sale transaction
    // refuses a shift that is not the cashier's own.
    return (
      <BlockedScreen
        title="الوردية تخصّ كاشيراً آخر"
        failure={FOREIGN_SHIFT}
        onRetry={shift.refresh}
        onChangeTerminal={terminal.change}
        onSignOut={signOut}
      />
    );
  }
  if (shift.state.kind === 'closed') {
    return (
      <ShiftGate
        terminal={chosen}
        busy={shift.opening}
        failure={shift.openFailure}
        onOpen={shift.open}
        onChangeTerminal={terminal.change}
        onSignOut={signOut}
      />
    );
  }

  return (
    <CashierScreen
      api={api}
      principal={principal}
      terminal={chosen}
      shift={shift.state.shift}
      priceMode={settings.priceMode}
      onSignOut={signOut}
      onExpired={session.expire}
      onShiftChanged={shift.refresh}
    />
  );
}
EOF

cat << 'EOF' > apps/pos-web/src/app/page.tsx
import { PosApp } from '../components/pos-app';

/**
 * The till.
 *
 * A server component whose only job is to mount the client shell. There is no
 * server-side data fetching here on purpose: every read this app makes is
 * authenticated by a cookie that belongs to the browser, and fetching on the
 * server would mean either forwarding that cookie by hand or inventing a
 * second way to authenticate. Neither is worth it for a screen that is
 * interactive from its first frame anyway.
 */
export default function Home(): React.JSX.Element {
  return <PosApp />;
}
EOF

python3 - <<'PY'
path = 'apps/pos-web/src/app/layout.tsx'
s = open(path, encoding='utf-8').read()
old = "  description: 'نظام نقاط البيع للتجزئة والمطاعم',"
new = "  description: 'نظام نقاط البيع للتجزئة والمطاعم',\n  // A till is not a page anybody should find in a search engine.\n  robots: { index: false, follow: false },"
if 'robots:' not in s:
    assert old in s
    s = s.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(s)
    print('  layout metadata updated')
else:
    print('  layout already updated')
PY

python3 - <<'PY'
path = 'apps/pos-web/src/app/globals.css'
s = open(path, encoding='utf-8').read()
if '.sr-only' in s:
    print('  already present'); raise SystemExit(0)
s = s.rstrip('\n') + """

@layer base {
  /*
   * A visible focus ring on everything, once, rather than per component
   * (KORVI-DESIGN-SYSTEM.md §7.3). A cashier working by keyboard has to be
   * able to see where they are.
   */
  :focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px hsl(var(--background)),
      0 0 0 4px hsl(var(--ring));
  }

  /*
   * The till fills the window and never scrolls sideways. A horizontal
   * scrollbar on a checkout screen hides the total.
   */
  html,
  body {
    overflow-x: hidden;
  }
}

@layer utilities {
  /* Labels that exist for screen readers and for nothing else. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border-width: 0;
  }
}
"""
open(path, 'w', encoding='utf-8').write(s)
print('  globals extended')
PY

say "Lint — pos-web modules are browser code too"

python3 - <<'PY'
path = 'eslint.config.js'
s = open(path, encoding='utf-8').read()
old = "    files: ['packages/ui/**/*.tsx', 'apps/pos-web/**/*.tsx'],"
new = "    files: ['packages/ui/**/*.tsx', 'apps/pos-web/**/*.tsx', 'apps/pos-web/**/*.ts'],"
if new in s:
    print('  already widened')
else:
    assert old in s
    s = s.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(s)
    print('  browser globals widened to pos-web modules')
PY

say "Tests — money and quantity at the keyboard"

cat << 'EOF' > apps/pos-web/src/lib/__tests__/money.test.ts
import { describe, expect, it } from 'vitest';
import { changeMinor, formatMinor, parseSarToMinor } from '../money';

/**
 * The conversion between what a cashier types and what crosses the wire.
 *
 * Every case below is one a float would get wrong or accept when it should
 * not. 19.99 is the canonical example: `19.99 * 100` is 1998.9999999999998 in
 * binary floating point, and a till that rounds that is a till that loses a
 * halala a sale.
 */
describe('parseSarToMinor', () => {
  it.each([
    ['0', '0'],
    ['1', '100'],
    ['1.5', '150'],
    ['1.50', '150'],
    ['10.25', '1025'],
    ['19.99', '1999'],
    ['0.05', '5'],
    ['1234567.89', '123456789'],
    // Trailing point: mid-keystroke, not an error.
    ['20.', '2000'],
    ['  7.10  ', '710'],
  ])('reads %s as %s halalas', (input, expected) => {
    const parsed = parseSarToMinor(input);
    expect(parsed.ok && parsed.value).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['-1', 'format'],
    ['-0.50', 'format'],
    ['1e3', 'format'],
    ['1,50', 'format'],
    ['abc', 'format'],
    ['NaN', 'format'],
    ['Infinity', 'format'],
    ['.5', 'format'],
    ['1.234', 'precision'],
    ['0.001', 'precision'],
  ])('refuses %s', (input, reason) => {
    const parsed = parseSarToMinor(input);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe(reason);
  });

  it('never produces a floating point value', () => {
    // The result is a decimal string of an integer, always.
    for (const input of ['0.1', '0.2', '19.99', '0.07']) {
      const parsed = parseSarToMinor(input);
      expect(parsed.ok && /^[0-9]+$/.test(parsed.value)).toBe(true);
    }
    expect(parseSarToMinor('0.1').ok && parseSarToMinor('0.1')).toEqual({ ok: true, value: '10' });
  });
});

describe('formatMinor', () => {
  it.each([
    ['0', '0.00'],
    ['5', '0.05'],
    ['150', '1.50'],
    ['2300', '23.00'],
    ['123456789', '1234567.89'],
  ])('renders %s as %s', (input, expected) => {
    expect(formatMinor(input)).toBe(expected);
  });
});

describe('changeMinor', () => {
  it('returns what is owed back', () => {
    expect(changeMinor('2300', '5000')).toBe('2700');
    expect(changeMinor('2300', '2300')).toBe('0');
  });

  it('returns null rather than a negative change', () => {
    // Short cash is a refusal, not a negative number to render.
    expect(changeMinor('2300', '100')).toBeNull();
  });
});
EOF

cat << 'EOF' > apps/pos-web/src/lib/__tests__/quantity.test.ts
import { describe, expect, it } from 'vitest';
import { addScaled, formatScaled, parseQuantityToScaled, stepScaled } from '../quantity';

describe('parseQuantityToScaled, unit products', () => {
  it.each([
    ['1', '1000'],
    ['2', '2000'],
    ['12', '12000'],
  ])('reads %s units as %s', (input, expected) => {
    const parsed = parseQuantityToScaled(input, 'unit');
    expect(parsed.ok && parsed.value).toBe(expected);
  });

  it('refuses a fraction of a unit', () => {
    // A tin cannot be sold in halves, and the server refuses one that is.
    const parsed = parseQuantityToScaled('1.5', 'unit');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe('precision');
  });
});

describe('parseQuantityToScaled, weighted products', () => {
  it.each([
    ['1', '1000'],
    ['1.2', '1200'],
    ['1.25', '1250'],
    ['1.250', '1250'],
    ['0.125', '125'],
    ['0.001', '1'],
  ])('reads %s as %s', (input, expected) => {
    const parsed = parseQuantityToScaled(input, 'weighted');
    expect(parsed.ok && parsed.value).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['0', 'not-positive'],
    ['0.000', 'not-positive'],
    ['-1', 'format'],
    ['1e3', 'format'],
    ['NaN', 'format'],
    ['1,5', 'format'],
    ['1.2345', 'precision'],
  ])('refuses %s', (input, reason) => {
    const parsed = parseQuantityToScaled(input, 'weighted');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe(reason);
  });
});

describe('scaled arithmetic', () => {
  it('formats without trailing noise', () => {
    expect(formatScaled('2000')).toBe('2');
    expect(formatScaled('1250')).toBe('1.25');
    expect(formatScaled('125')).toBe('0.125');
  });

  it('adds as integers', () => {
    expect(addScaled('1000', '1250')).toBe('2250');
    // Well past what a double holds exactly, and still exact.
    expect(addScaled('9007199254740993', '1')).toBe('9007199254740994');
  });

  it('steps by whole units and never below one', () => {
    expect(stepScaled('1000', 1)).toBe('2000');
    expect(stepScaled('2000', -1)).toBe('1000');
    expect(stepScaled('1000', -1)).toBe('1000');
    expect(stepScaled('1500', -1)).toBe('1000');
  });

  it('never makes a quantity larger by decrementing it', () => {
    // The bug this exists to prevent: a clamp to "at least one unit" turns
    // 0.500 minus one into 1.000, so pressing minus doubles a weighed line.
    for (const scaled of ['1', '125', '500', '999', '1000', '1500', '2000', '12345']) {
      expect(BigInt(stepScaled(scaled, -1))).toBeLessThanOrEqual(BigInt(scaled));
    }
    expect(stepScaled('500', -1)).toBe('500');
    expect(stepScaled('125', -1)).toBe('125');
  });
});
EOF

say "Tests — the API boundary"

cat << 'EOF' > apps/pos-web/src/lib/__tests__/api-origin.test.ts
import { describe, expect, it } from 'vitest';
import { ApiOriginError, DEVELOPMENT_API_ORIGIN, resolveApiOrigin } from '../api-origin';

describe('resolveApiOrigin', () => {
  it('falls back to loopback when nothing is configured', () => {
    // Loopback rather than a guess: an unconfigured deployment fails to
    // connect, which is visible, instead of proxying somewhere unintended.
    expect(resolveApiOrigin(undefined)).toBe(DEVELOPMENT_API_ORIGIN);
    expect(resolveApiOrigin('  ')).toBe(DEVELOPMENT_API_ORIGIN);
  });

  it('accepts a bare origin', () => {
    expect(resolveApiOrigin('https://api.korvi.example')).toBe('https://api.korvi.example');
    expect(resolveApiOrigin('http://127.0.0.1:3001/')).toBe('http://127.0.0.1:3001');
  });

  it.each([
    ['not-a-url'],
    ['ftp://api.korvi.example'],
    ['https://user:secret@api.korvi.example'],
    ['https://api.korvi.example/v1'],
    ['https://api.korvi.example?x=1'],
  ])('refuses %s at build time', (value) => {
    expect(() => resolveApiOrigin(value)).toThrow(ApiOriginError);
  });
});
EOF

cat << 'EOF' > apps/pos-web/src/lib/__tests__/api.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError, CHECKOUT_TIMEOUT_MS, createApiClient } from '../api';

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function stub(responses: readonly Response[]): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init: init ?? {} });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return Promise.resolve(response ?? new Response(null, { status: 500 }));
    },
  };
}

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('the API client', () => {
  it('sends the session cookie and nothing else', async () => {
    const transport = stub([ok({ user: { id: 'u' } })]);
    await createApiClient(transport.fetch).me();

    const call = transport.calls[0]!;
    expect(call.url).toBe('/v1/auth/me');
    expect(call.init.credentials).toBe('same-origin');
    // No Authorization header: there is no token in JavaScript to put in one.
    expect(JSON.stringify(call.init.headers)).not.toMatch(/authorization/i);
  });

  it('posts exactly the three login fields', async () => {
    const transport = stub([ok({ user: { id: 'u' } })]);
    await createApiClient(transport.fetch).login({
      tenantSlug: 'korvi-a',
      email: 'sara@korvi-a.test',
      password: 'a-real-password-9!',
    });

    const call = transport.calls[0]!;
    expect(call.url).toBe('/v1/auth/login');
    expect(Object.keys(bodyOf(call.init)).sort()).toEqual(['email', 'password', 'tenantSlug']);
  });

  it('turns a 401 into an ApiError that says so', async () => {
    const transport = stub([ok({ error: 'unauthenticated' }, 401)]);
    const error = await createApiClient(transport.fetch)
      .me()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).unauthenticated).toBe(true);
    expect((error as ApiError).code).toBe('unauthenticated');
    expect((error as ApiError).ambiguous).toBe(false);
  });

  it('marks a request that never got an answer as ambiguous', async () => {
    const failing = vi.fn(() => Promise.reject(new TypeError('network down')));
    const error = await createApiClient(failing)
      .me()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).ambiguous).toBe(true);
    expect((error as ApiError).code).toBe('network');
  });

  it('lets an abort through untouched', async () => {
    // A cancelled search is the caller changing their mind, not an outage.
    const aborting = vi.fn(() =>
      Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
    const error = await createApiClient(aborting)
      .products({ q: 'x' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('handles the 204 that logout returns', async () => {
    const transport = stub([new Response(null, { status: 204 })]);
    await expect(createApiClient(transport.fetch).logout()).resolves.toBeUndefined();
  });

  it('bounds and encodes a product query', async () => {
    const transport = stub([ok({ products: [] })]);
    await createApiClient(transport.fetch).products({ q: 'حليب طازج', limit: 20 });
    expect(transport.calls[0]!.url).toBe(
      '/v1/products?q=%D8%AD%D9%84%D9%8A%D8%A8+%D8%B7%D8%A7%D8%B2%D8%AC&limit=20',
    );
  });

  it('gives up on a checkout that is never answered, and calls it ambiguous', async () => {
    // Deliberately not an AbortError. A cancelled search means nothing
    // happened; a checkout that timed out may already have committed, and the
    // two must not share a classification.
    vi.useFakeTimers();
    try {
      const hung = (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });

      const attempt = createApiClient(hung).checkout({
        operationId: 'op-1',
        terminalId: 'tm-1',
        cashReceivedMinor: '5000',
        lines: [{ productId: 'p-1', quantityScaled: '1000' }],
      });
      const caught = attempt.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(CHECKOUT_TIMEOUT_MS + 1);
      const error = await caught;

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('timeout');
      expect((error as ApiError).ambiguous).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a checkout that answers in time', async () => {
    vi.useFakeTimers();
    try {
      const transport = stub([ok({ sale: { saleId: 's1' }, replayed: false }, 201)]);
      const response = await createApiClient(transport.fetch).checkout({
        operationId: 'op-1',
        terminalId: 'tm-1',
        cashReceivedMinor: '5000',
        lines: [{ productId: 'p-1', quantityScaled: '1000' }],
      });
      expect(response.replayed).toBe(false);
      // The timer must be cleared, or the next tick aborts a settled request.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a null shift as no open shift', async () => {
    const transport = stub([ok({ shift: null })]);
    const shift = await createApiClient(transport.fetch).currentShift(
      '018f2000-0000-7000-8000-0000000000a2',
    );
    expect(shift).toBeNull();
  });
});
EOF

cat << 'EOF' > apps/pos-web/src/lib/__tests__/security.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../api';
import { forgetTerminalId, rememberTerminalId, rememberedTerminalId } from '../device-memory';
import type { CheckoutRequest } from '../api-types';

/**
 * The things that must never leave the browser, and the one thing that may.
 *
 * These are not style tests. Each asserts a boundary that, if it moved, would
 * hand a client authority the server spent three strikes refusing to give it.
 */

function capture(): { fetch: (url: string, init?: RequestInit) => Promise<Response>; last: () => RequestInit } {
  let seen: RequestInit = {};
  return {
    last: () => seen,
    fetch: (_url, init) => {
      seen = init ?? {};
      return Promise.resolve(
        new Response(JSON.stringify({ sale: {}, replayed: false }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

describe('the checkout payload', () => {
  it('carries ids, quantities, cash and an operation id — and nothing else', async () => {
    const transport = capture();
    await createApiClient(transport.fetch).checkout({
      operationId: '018f2000-0000-7000-8000-0000000000f1',
      terminalId: '018f2000-0000-7000-8000-0000000000a2',
      cashReceivedMinor: '5000',
      lines: [{ productId: '018f2000-0000-7000-8000-0000000000a5', quantityScaled: '2000' }],
    });

    const body = JSON.parse(String(transport.last().body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'cashReceivedMinor',
      'lines',
      'operationId',
      'terminalId',
    ]);
    const lines = body['lines'] as Record<string, unknown>[];
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(['productId', 'quantityScaled']);
  });

  it('drops anything a caller managed to attach to the request', async () => {
    // The whitelist is the control. Even if a component hands over an object
    // carrying a price, a tenant and a role, none of it is serialised.
    const polluted = {
      operationId: '018f2000-0000-7000-8000-0000000000f1',
      terminalId: '018f2000-0000-7000-8000-0000000000a2',
      cashReceivedMinor: '5000',
      lines: [
        {
          productId: '018f2000-0000-7000-8000-0000000000a5',
          quantityScaled: '2000',
          unitPriceMinor: '1',
          totalMinor: '1',
        },
      ],
      tenantId: '018f2000-0000-7000-8000-00000000000b',
      userId: '018f2000-0000-7000-8000-0000000000ff',
      branchId: '018f2000-0000-7000-8000-0000000000a1',
      roles: ['owner'],
      permissions: ['sale.void'],
      sequence: 99,
      invoiceNumber: '01-000001',
      changeMinor: '0',
    } as unknown as CheckoutRequest;

    const transport = capture();
    await createApiClient(transport.fetch).checkout(polluted);

    const serialised = String(transport.last().body);
    for (const forbidden of [
      'tenantId',
      'userId',
      'branchId',
      'roles',
      'permissions',
      'sequence',
      'invoiceNumber',
      'unitPriceMinor',
      'totalMinor',
      'changeMinor',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe('what the browser is allowed to remember', () => {
  const written = new Map<string, string>();

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => written.get(key) ?? null,
      setItem: (key: string, value: string) => {
        written.set(key, value);
      },
      removeItem: (key: string) => {
        written.delete(key);
      },
    },
  });

  afterEach(() => {
    written.clear();
  });

  it('stores a terminal id under one key and nothing else', () => {
    rememberTerminalId('018f2000-0000-7000-8000-0000000000a2');
    expect([...written.keys()]).toEqual(['korvi.pos.terminalId']);
    expect(rememberedTerminalId()).toBe('018f2000-0000-7000-8000-0000000000a2');
    // A terminal id proves nothing on its own; the server re-checks it against
    // the session's branch on every request.
    expect([...written.values()].join()).not.toMatch(/kps1\./);
    forgetTerminalId();
    expect(written.size).toBe(0);
  });

  it('survives storage being unavailable', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked by the browser');
      },
    });
    expect(rememberedTerminalId()).toBeNull();
    expect(() => {
      rememberTerminalId('x');
    }).not.toThrow();
  });
});
EOF

say "Tests — boot, terminal and shift"

cat << 'EOF' > apps/pos-web/src/lib/__tests__/boot.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { describeFailure } from '../failures';
import { loadSession } from '../session';
import { createLogoutController } from '../logout';
import { chooseTerminal, loadTerminals } from '../terminal';
import { forgetTerminalId, rememberTerminalId, rememberedTerminalId } from '../device-memory';
import { loadShift, shiftNeedsRefresh } from '../shift';
import type { ApiClient } from '../api';
import type { Principal, ShiftSummary, TerminalSummary, TerminalsResponse } from '../api-types';
import type { SessionState } from '../session';

const PRINCIPAL: Principal = {
  user: { id: 'u1', email: 'sara@korvi-a.test', displayName: 'سارة' },
  tenant: { id: 't1', slug: 'korvi-a' },
  session: { id: 's1' },
  roles: ['cashier'],
  permissions: ['product.read', 'sale.create', 'shift.open'],
  branchId: 'b1',
};

const TILL: TerminalSummary = { id: 'tm1', code: '01', label: 'صندوق ١', branchId: 'b1' };
const TILL2: TerminalSummary = { id: 'tm2', code: '02', label: 'صندوق ٢', branchId: 'b1' };
const SETTINGS = { priceMode: 'tax-inclusive', currency: 'SAR' } as const;

const SHIFT: ShiftSummary = {
  id: 'sh1',
  branchId: 'b1',
  terminalId: 'tm1',
  userId: 'u1',
  status: 'open',
  openingFloatMinor: '20000',
  openedAt: '2026-08-12T06:00:00.000Z',
};

function client(overrides: Partial<ApiClient>): ApiClient {
  const unimplemented = (): never => {
    throw new Error('not part of this test');
  };
  return {
    me: unimplemented,
    login: unimplemented,
    logout: unimplemented,
    terminals: unimplemented,
    products: unimplemented,
    currentShift: unimplemented,
    openShift: unimplemented,
    checkout: unimplemented,
    ...overrides,
  } as ApiClient;
}

describe('session restoration', () => {
  it('reports the principal when the cookie is still good', async () => {
    const state = await loadSession(client({ me: () => Promise.resolve(PRINCIPAL) }));
    expect(state).toEqual({ kind: 'ready', principal: PRINCIPAL });
  });

  it('sends a 401 to the login screen, not to an error screen', async () => {
    const state = await loadSession(
      client({ me: () => Promise.reject(new ApiError(401, 'unauthenticated', null)) }),
    );
    expect(state.kind).toBe('anonymous');
  });

  it('does not log a cashier out because the network blinked', async () => {
    // The distinction that matters: "I do not know you" and "I could not ask"
    // are different answers, and only one of them means show the login form.
    const state = await loadSession(
      client({ me: () => Promise.reject(new ApiError(0, 'network', null)) }),
    );
    expect(state.kind).toBe('unavailable');
  });
});

describe('signing out', () => {
  /**
   * The session cookie is HttpOnly. Only the server can revoke it, and this
   * code cannot read it or clear it. So a logout that was not confirmed is not
   * a logout, and saying otherwise on a shared till hands the next cashier the
   * previous one's session.
   */
  function harness(logout: () => Promise<void>) {
    const states: SessionState[] = [];
    const forget = vi.fn();
    const controller = createLogoutController({ logout }, forget);
    return {
      states,
      forget,
      controller,
      run: () => {
        controller.signOut(PRINCIPAL, (state) => states.push(state));
      },
    };
  }

  it('becomes anonymous and forgets the till once the server confirms', async () => {
    const harnessed = harness(() => Promise.resolve());
    harnessed.run();
    await vi.waitFor(() => {
      expect(harnessed.states.at(-1)?.kind).toBe('anonymous');
    });

    expect(harnessed.states.map((state) => state.kind)).toEqual(['signing-out', 'anonymous']);
    expect(harnessed.forget).toHaveBeenCalledTimes(1);
  });

  it('refuses to claim a logout the server never confirmed', async () => {
    const harnessed = harness(() => Promise.reject(new ApiError(0, 'network', null)));
    harnessed.run();
    await vi.waitFor(() => {
      expect(harnessed.states.at(-1)?.kind).toBe('logout-failed');
    });

    const last = harnessed.states.at(-1);
    expect(last?.kind).toBe('logout-failed');
    // Not anonymous, and the till is not forgotten: nothing was secured, and
    // clearing it would make the failure look like a clean exit.
    expect(harnessed.states.some((state) => state.kind === 'anonymous')).toBe(false);
    expect(harnessed.forget).not.toHaveBeenCalled();
  });

  it('completes on a retry that reaches the server', async () => {
    let attempts = 0;
    const harnessed = harness(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new ApiError(0, 'network', null)) : Promise.resolve();
    });

    harnessed.run();
    await vi.waitFor(() => {
      expect(harnessed.states.at(-1)?.kind).toBe('logout-failed');
    });
    harnessed.run();
    await vi.waitFor(() => {
      expect(harnessed.states.at(-1)?.kind).toBe('anonymous');
    });

    expect(attempts).toBe(2);
    expect(harnessed.forget).toHaveBeenCalledTimes(1);
  });

  it('sends one request however many times the button is pressed', async () => {
    let calls = 0;
    const releases: (() => void)[] = [];
    const harnessed = harness(
      () =>
        new Promise<void>((resolve) => {
          calls += 1;
          releases.push(resolve);
        }),
    );

    harnessed.run();
    harnessed.run();
    harnessed.run();
    expect(calls).toBe(1);
    expect(harnessed.controller.running()).toBe(true);

    releases[0]?.();
    await vi.waitFor(() => {
      expect(harnessed.states.at(-1)?.kind).toBe('anonymous');
    });
    expect(calls).toBe(1);
  });
});

describe('choosing a till', () => {
  const response = (terminals: readonly TerminalSummary[]): TerminalsResponse => ({
    branchId: 'b1',
    settings: SETTINGS,
    terminals,
  });

  it('selects the only till without asking', () => {
    expect(chooseTerminal(response([TILL]), null)).toEqual({
      kind: 'chosen',
      terminal: TILL,
      settings: SETTINGS,
    });
  });

  it('asks when there is more than one', () => {
    const state = chooseTerminal(response([TILL, TILL2]), null);
    expect(state.kind).toBe('choosing');
    expect(state.kind === 'choosing' && state.terminals).toHaveLength(2);
  });

  it('honours the till this browser used last', () => {
    expect(chooseTerminal(response([TILL, TILL2]), 'tm2')).toEqual({
      kind: 'chosen',
      terminal: TILL2,
      settings: SETTINGS,
    });
  });

  it('shows the selector again once the till is forgotten', () => {
    // "Change terminal" forgets the device id and asks again. Re-reading the
    // remembered id is what used to land straight back on the same till.
    const written = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => written.get(key) ?? null,
        setItem: (key: string, value: string) => {
          written.set(key, value);
        },
        removeItem: (key: string) => {
          written.delete(key);
        },
      },
    });

    rememberTerminalId(TILL2.id);
    expect(chooseTerminal(response([TILL, TILL2]), rememberedTerminalId())).toEqual({
      kind: 'chosen',
      terminal: TILL2,
      settings: SETTINGS,
    });

    forgetTerminalId();
    expect(chooseTerminal(response([TILL, TILL2]), rememberedTerminalId()).kind).toBe('choosing');
    // Only device context was touched. Nothing about the session moved.
    expect([...written.keys()]).toEqual([]);
  });

  it('forgets a remembered till the server no longer offers', () => {
    // Deactivated overnight. Remembering it would only produce a 404 later.
    expect(chooseTerminal(response([TILL, TILL2]), 'tm9').kind).toBe('choosing');
  });

  it('blocks when the branch has no active till at all', () => {
    const state = chooseTerminal(response([]), null);
    expect(state.kind).toBe('blocked');
    expect(state.kind === 'blocked' && state.failure.action).toBe('blocking');
  });

  it('carries the price mode the server decided', () => {
    const state = chooseTerminal(
      { branchId: 'b1', settings: { priceMode: 'tax-exclusive', currency: 'SAR' }, terminals: [TILL] },
      null,
    );
    expect(state.kind === 'chosen' && state.settings.priceMode).toBe('tax-exclusive');
  });

  it('blocks with a named reason when the principal has no branch', async () => {
    const state = await loadTerminals(
      client({ terminals: () => Promise.reject(new ApiError(409, 'branch_required', null)) }),
      null,
    );
    expect(state.kind).toBe('blocked');
    expect(state.kind === 'blocked' && state.failure.code).toBe('branch_required');
  });

  it('blocks rather than guessing when the tenant has no settings', async () => {
    const state = await loadTerminals(
      client({
        terminals: () => Promise.reject(new ApiError(409, 'tenant-misconfigured', null)),
      }),
      null,
    );
    expect(state.kind === 'blocked' && state.failure.code).toBe('tenant-misconfigured');
  });
});

describe('the shift gate', () => {
  it('goes straight through when this cashier has a shift open', async () => {
    const state = await loadShift(
      client({ currentShift: () => Promise.resolve(SHIFT) }),
      'tm1',
      'u1',
    );
    expect(state).toEqual({ kind: 'open', shift: SHIFT });
  });

  it('asks for one when there is none', async () => {
    const state = await loadShift(client({ currentShift: () => Promise.resolve(null) }), 'tm1', 'u1');
    expect(state).toEqual({ kind: 'closed' });
  });

  it('refuses to enter another cashier’s drawer', async () => {
    // The server would refuse the sale after a whole basket had been built.
    // One read up front turns that into a screen instead of a queue.
    const theirs: ShiftSummary = { ...SHIFT, userId: 'u2' };
    const state = await loadShift(
      client({ currentShift: () => Promise.resolve(theirs) }),
      'tm1',
      'u1',
    );
    expect(state).toEqual({ kind: 'foreign', shift: theirs });
  });

  it.each([
    ['no-open-shift', 409],
    ['shift-invalid', 409],
  ])('sends the till back to the shift flow after %s', (code, status) => {
    // A drawer that closed under the till mid-basket. Leaving the cashier on a
    // checkout button that will never work is worse than sending them back.
    expect(shiftNeedsRefresh(describeFailure(new ApiError(status, code, null)).action)).toBe(true);
  });

  it.each([['insufficient-cash', 422], ['insufficient-stock', 409]])(
    'does not disturb the shift for %s',
    (code, status) => {
      expect(shiftNeedsRefresh(describeFailure(new ApiError(status, code, null)).action)).toBe(
        false,
      );
    },
  );

  it('does not invent a shift when the read failed', async () => {
    const state = await loadShift(
      client({ currentShift: () => Promise.reject(new ApiError(0, 'network', null)) }),
      'tm1',
      'u1',
    );
    expect(state.kind).toBe('blocked');
  });
});
EOF

say "Tests — the cart"

cat << 'EOF' > apps/pos-web/src/lib/__tests__/cart.test.ts
import { describe, expect, it } from 'vitest';
import { cartReducer, cartToRequestLines, previewCart } from '../cart';
import type { CartLine } from '../cart';
import type { ProductSummary } from '../api-types';

const MILK: ProductSummary = {
  id: 'p-milk',
  sku: 'MILK-1L',
  nameAr: 'حليب طازج',
  nameEn: 'Fresh milk',
  productType: 'unit',
  unitLabel: null,
  priceMinor: '1150',
  vatBasisPoints: 1500,
  primaryBarcode: '6281000000001',
  trackInventory: true,
};

const RICE: ProductSummary = {
  ...MILK,
  id: 'p-rice',
  sku: 'RICE-5K',
  nameAr: 'أرز بسمتي',
  nameEn: 'Basmati rice',
  productType: 'weighted',
  unitLabel: 'كجم',
  priceMinor: '2400',
  primaryBarcode: '6281000000002',
};

function build(actions: readonly Parameters<typeof cartReducer>[1][]): readonly CartLine[] {
  return actions.reduce<readonly CartLine[]>((lines, action) => cartReducer(lines, action), []);
}

describe('the cart', () => {
  it('adds a product as one unit', () => {
    const lines = build([{ type: 'add', product: MILK }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantityScaled).toBe('1000');
  });

  it('merges a repeated add into the line that exists', () => {
    // The server refuses two lines for one product, and rightly: each would
    // pass a stock check their sum fails.
    const lines = build([
      { type: 'add', product: MILK },
      { type: 'add', product: RICE },
      { type: 'add', product: MILK },
      { type: 'add', product: MILK },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.productId === 'p-milk')?.quantityScaled).toBe('3000');
    expect(new Set(lines.map((line) => line.productId)).size).toBe(lines.length);
  });

  it('steps a unit line up and down without falling below one', () => {
    const lines = build([
      { type: 'add', product: MILK },
      { type: 'step', productId: 'p-milk', direction: 1 },
      { type: 'step', productId: 'p-milk', direction: -1 },
      { type: 'step', productId: 'p-milk', direction: -1 },
    ]);
    expect(lines[0]?.quantityScaled).toBe('1000');
  });

  it('will not step a weighed line at all', () => {
    // The screen does not offer the controls; this makes the action inert, so
    // a future caller cannot resurrect a minus button that doubles 0.500 kg.
    const lines = build([
      { type: 'add', product: RICE },
      { type: 'set-quantity', productId: 'p-rice', quantityScaled: '500' },
      { type: 'step', productId: 'p-rice', direction: -1 },
      { type: 'step', productId: 'p-rice', direction: 1 },
    ]);
    expect(lines[0]?.quantityScaled).toBe('500');
  });

  it('takes an explicit weighed quantity', () => {
    const lines = build([
      { type: 'add', product: RICE },
      { type: 'set-quantity', productId: 'p-rice', quantityScaled: '1250' },
    ]);
    expect(lines[0]?.quantityScaled).toBe('1250');
  });

  it('removes and clears', () => {
    const lines = build([
      { type: 'add', product: MILK },
      { type: 'add', product: RICE },
      { type: 'remove', productId: 'p-milk' },
    ]);
    expect(lines.map((line) => line.productId)).toEqual(['p-rice']);
    expect(cartReducer(lines, { type: 'clear' })).toEqual([]);
  });

  it('sends ids and quantities and nothing else', () => {
    const lines = build([{ type: 'add', product: MILK }]);
    expect(Object.keys(cartToRequestLines(lines)[0] ?? {}).sort()).toEqual([
      'productId',
      'quantityScaled',
    ]);
  });
});

describe('the preview', () => {
  it('prices two litres of milk exactly, tax-inclusive', () => {
    // 2 x 11.50 tax-inclusive: total 23.00, net 20.00, VAT 3.00. The same
    // arithmetic the server runs, because it is literally the same function.
    const lines = build([
      { type: 'add', product: MILK },
      { type: 'add', product: MILK },
    ]);
    const preview = previewCart(lines, 'tax-inclusive');
    expect(preview.total.minor).toBe(2300n);
    expect(preview.net.minor).toBe(2000n);
    expect(preview.vat.minor).toBe(300n);
  });

  it('prices the same catalogue price differently when the tenant sells tax-exclusive', () => {
    // 10.00 at 15% exclusive is 11.50 due. Hardcoding tax-inclusive here would
    // have shown 10.00 and short-changed the drawer by the VAT on every sale.
    const exclusive: ProductSummary = { ...MILK, priceMinor: '1000' };
    const lines = build([{ type: 'add', product: exclusive }]);

    const preview = previewCart(lines, 'tax-exclusive');
    expect(preview.net.minor).toBe(1000n);
    expect(preview.vat.minor).toBe(150n);
    expect(preview.total.minor).toBe(1150n);

    // The same basket under the other mode is a different total, which is the
    // whole reason the mode may not be guessed.
    expect(previewCart(lines, 'tax-inclusive').total.minor).toBe(1000n);
  });

  it('prices a weighed line by the scaled quantity', () => {
    const lines = build([
      { type: 'add', product: RICE },
      { type: 'set-quantity', productId: 'p-rice', quantityScaled: '1500' },
    ]);
    expect(previewCart(lines, 'tax-inclusive').total.minor).toBe(3600n);
  });

  it('totals an empty cart at zero rather than failing', () => {
    expect(previewCart([], 'tax-inclusive').total.minor).toBe(0n);
  });
});
EOF

say "Tests — checkout, retries and the operation id"

cat << 'EOF' > apps/pos-web/src/lib/__tests__/checkout.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { createCheckoutFlight, outcomeFor } from '../checkout-flight';
import { runCheckout } from '../checkout-submit';
import { checkoutReducer, initialCheckoutState, intentLocked, signOutBlocked, submitDisabled } from '../checkout';
import { describeFailure } from '../failures';
import type { CheckoutResponse, SaleSummary } from '../api-types';
import type { CartLine } from '../cart';
import type { CheckoutEvent, CheckoutState } from '../checkout';
import type { CheckoutIntent } from '../checkout-flight';

const SALE: SaleSummary = {
  saleId: 'sale-1',
  operationId: 'op-1',
  sequence: 12,
  invoiceNumber: '01-000012',
  issuedAt: '2026-08-12T07:00:00.000Z',
  currency: 'SAR',
  branchId: 'b1',
  terminalId: 'tm1',
  shiftId: 'sh1',
  cashierName: 'سارة',
  lines: [],
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  cashReceivedMinor: '5000',
  changeMinor: '2700',
};

const MILK: CartLine = {
  productId: 'p-milk',
  sku: 'MILK-1L',
  nameAr: 'حليب طازج',
  nameEn: null,
  productType: 'unit',
  unitLabel: null,
  unitPriceMinor: '1150',
  vatBasisPoints: 1500,
  quantityScaled: '2000',
};

const NETWORK = describeFailure(new ApiError(0, 'network', null));
const TIMEOUT = describeFailure(new ApiError(0, 'timeout', null));
const CONFLICT = describeFailure(new ApiError(409, 'idempotency-conflict', null));
const SHORT_CASH = describeFailure(new ApiError(422, 'insufficient-cash', null));

interface Deferred {
  readonly promise: Promise<CheckoutResponse>;
  resolve(response: CheckoutResponse): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (response: CheckoutResponse) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<CheckoutResponse>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The submit path, driven exactly as the hook drives it. */
function harness(behaviour: (intent: CheckoutIntent) => Promise<CheckoutResponse>) {
  const sent: CheckoutIntent[] = [];
  const events: CheckoutEvent[] = [];
  const expired = vi.fn();
  const flight = createCheckoutFlight();
  let minted = 0;

  const submit = (input: {
    terminalId: string;
    lines: readonly CartLine[];
    cashReceivedMinor: string;
  }): Promise<void> =>
    runCheckout(
      {
        checkout: (intent) => {
          sent.push(intent);
          return behaviour(intent);
        },
      },
      flight,
      input,
      (event) => events.push(event),
      expired,
      () => {
        minted += 1;
        return `op-${String(minted)}`;
      },
    );

  const state = (): CheckoutState => events.reduce(checkoutReducer, initialCheckoutState);

  return { sent, events, expired, flight, submit, state, minted: () => minted };
}

const BASKET = { terminalId: 'tm1', lines: [MILK], cashReceivedMinor: '5000' };

describe('two submits in one tick', () => {
  it('issues exactly one request and mints exactly one operation id', async () => {
    /*
     * The failure this closes. `dispatch` schedules a render; it does not
     * change anything synchronously. A guard that reads React state therefore
     * lets a double click through: both calls see idle, both mint their own
     * operation id, and the server sees two different intents — so its
     * idempotency contract, the thing that exists to prevent a double charge,
     * never engages.
     */
    const pending = deferred();
    const run = harness(() => pending.promise);

    const first = run.submit(BASKET);
    const second = run.submit(BASKET);

    expect(run.sent).toHaveLength(1);
    expect(run.minted()).toBe(1);

    pending.resolve({ sale: SALE, replayed: false });
    await Promise.all([first, second]);

    expect(run.sent).toHaveLength(1);
    expect(run.sent[0]?.operationId).toBe('op-1');
    expect(run.events.filter((event) => event.type === 'submit')).toHaveLength(1);
  });

  it('sends one body, not two that differ', async () => {
    const pending = deferred();
    const run = harness(() => pending.promise);

    void run.submit(BASKET);
    // A second click after the cashier nudged the cash field must not become a
    // second request under a second id.
    void run.submit({ ...BASKET, cashReceivedMinor: '6000' });

    expect(run.sent).toHaveLength(1);
    expect(run.sent[0]?.cashReceivedMinor).toBe('5000');
    pending.resolve({ sale: SALE, replayed: false });
  });
});

describe('an answer that never arrived', () => {
  it('replays the identical intent, id, cash and lines', async () => {
    const run = harness(() => Promise.reject(new ApiError(0, 'network', null)));
    await run.submit(BASKET);

    expect(run.flight.outstanding()).toBe(true);
    const frozen = run.flight.pending();
    expect(frozen?.operationId).toBe('op-1');

    // The cashier's screen has moved on — a different basket, a different
    // cash amount. The retry must not care.
    await run.submit({
      terminalId: 'tm2',
      lines: [{ ...MILK, quantityScaled: '9000' }],
      cashReceivedMinor: '9999',
    });

    expect(run.sent).toHaveLength(2);
    expect(run.sent[1]).toEqual(run.sent[0]);
    expect(run.sent[1]?.operationId).toBe('op-1');
    expect(run.sent[1]?.cashReceivedMinor).toBe('5000');
    expect(run.sent[1]?.lines).toEqual([{ productId: 'p-milk', quantityScaled: '2000' }]);
    expect(run.minted()).toBe(1);
  });

  it('treats a checkout timeout exactly as it treats a lost connection', async () => {
    const run = harness(() => Promise.reject(new ApiError(0, 'timeout', null)));
    await run.submit(BASKET);

    expect(run.flight.outstanding()).toBe(true);
    expect(run.flight.pending()?.operationId).toBe('op-1');
    expect(TIMEOUT.action).toBe('retry-same');
    expect(outcomeFor(TIMEOUT.action)).toBe('ambiguous');
  });

  it('cannot have its request edited from outside', () => {
    const flight = createCheckoutFlight();
    const intent = flight.begin(() => ({
      operationId: 'op-1',
      terminalId: 'tm1',
      cashReceivedMinor: '5000',
      lines: [{ productId: 'p-milk', quantityScaled: '2000' }],
    }));
    flight.settle('ambiguous');

    const held = intent as { cashReceivedMinor: string };
    expect(() => {
      held.cashReceivedMinor = '9999';
    }).toThrow(TypeError);
    expect(flight.pending()?.cashReceivedMinor).toBe('5000');
  });

  it('resolves to the sale the first attempt created', async () => {
    let attempts = 0;
    const run = harness(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new ApiError(0, 'network', null))
        : Promise.resolve({ sale: SALE, replayed: true });
    });

    await run.submit(BASKET);
    await run.submit(BASKET);

    const state = run.state();
    expect(state.phase).toBe('succeeded');
    expect(state.replayed).toBe(true);
    expect(state.attemptOutstanding).toBe(false);
  });
});

describe('a refusal the server decided', () => {
  it('lets the cashier amend, and the amended basket goes out under a new id', async () => {
    const run = harness(() => Promise.reject(new ApiError(422, 'insufficient-cash', null)));
    await run.submit(BASKET);

    expect(run.flight.outstanding()).toBe(false);
    // Nothing was recorded, so the id is retired rather than reused: a fresh
    // one can never collide with anything.
    expect(run.flight.pending()).toBeNull();

    const run2 = harness((intent) =>
      intent.cashReceivedMinor === '5000'
        ? Promise.reject(new ApiError(422, 'insufficient-cash', null))
        : Promise.resolve({ sale: SALE, replayed: false }),
    );
    await run2.submit(BASKET);
    await run2.submit({ ...BASKET, cashReceivedMinor: '9000' });

    expect(run2.sent).toHaveLength(2);
    expect(run2.sent[0]?.operationId).toBe('op-1');
    expect(run2.sent[1]?.operationId).toBe('op-2');
    expect(run2.sent[1]?.cashReceivedMinor).toBe('9000');
  });

  it('never silently mints a replacement after an idempotency conflict', async () => {
    // The id is burnt: a sale with a different basket already owns it. A new
    // one here would quietly ring the basket up a second time.
    const run = harness(() => Promise.reject(new ApiError(409, 'idempotency-conflict', null)));
    await run.submit(BASKET);

    expect(run.flight.blocked()).toBe(true);
    expect(run.flight.pending()?.operationId).toBe('op-1');

    await run.submit({ ...BASKET, cashReceivedMinor: '9000' });
    expect(run.sent).toHaveLength(1);
    expect(run.minted()).toBe(1);
  });

  it('starts clean only when the cashier starts a new sale', async () => {
    const run = harness(() => Promise.resolve({ sale: SALE, replayed: false }));
    await run.submit(BASKET);
    expect(run.flight.pending()?.operationId).toBe('op-1');

    run.flight.reset();
    await run.submit(BASKET);
    expect(run.sent[1]?.operationId).toBe('op-2');
  });

  it('drops everything when the session turns out to be gone', async () => {
    const run = harness(() => Promise.reject(new ApiError(401, 'unauthenticated', null)));
    await run.submit(BASKET);

    expect(run.expired).toHaveBeenCalledTimes(1);
    expect(run.flight.pending()).toBeNull();
    expect(run.events.some((event) => event.type === 'failed')).toBe(false);
  });
});

describe('what the screen locks', () => {
  const after = (events: readonly CheckoutEvent[]): CheckoutState =>
    events.reduce(checkoutReducer, initialCheckoutState);

  const INTENT: CheckoutIntent = {
    operationId: 'op-1',
    terminalId: 'tm1',
    cashReceivedMinor: '5000',
    lines: [{ productId: 'p-milk', quantityScaled: '2000' }],
  };

  it('freezes basket, cash and search while an attempt is outstanding', () => {
    const state = after([
      { type: 'submit', intent: INTENT },
      { type: 'failed', failure: NETWORK },
    ]);
    expect(intentLocked(state)).toBe(true);
    expect(signOutBlocked(state)).toBe(true);
  });

  it('freezes them while a request is in flight', () => {
    const state = after([{ type: 'submit', intent: INTENT }]);
    expect(intentLocked(state)).toBe(true);
    expect(submitDisabled(state)).toBe(true);
    expect(signOutBlocked(state)).toBe(true);
  });

  it('unfreezes after a refusal the cashier can act on', () => {
    const state = after([
      { type: 'submit', intent: INTENT },
      { type: 'failed', failure: SHORT_CASH },
    ]);
    expect(intentLocked(state)).toBe(false);
    expect(signOutBlocked(state)).toBe(false);
    expect(state.intent).toBeNull();
  });

  it('stops accepting submits after a conflict', () => {
    const state = after([
      { type: 'submit', intent: INTENT },
      { type: 'failed', failure: CONFLICT },
    ]);
    expect(submitDisabled(state)).toBe(true);
    expect(state.intent).toEqual(INTENT);
  });

  it('keeps the till locked on a completed sale until a new one is started', () => {
    const done = after([
      { type: 'submit', intent: INTENT },
      { type: 'succeeded', sale: SALE, replayed: false },
    ]);
    expect(intentLocked(done)).toBe(true);
    expect(checkoutReducer(done, { type: 'new-sale' })).toEqual(initialCheckoutState);
  });
});
EOF

say "Tests — search, and failures a cashier can act on"

cat << 'EOF' > apps/pos-web/src/lib/__tests__/search.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { autoAddCandidate, createProductSearch, initialSearchState } from '../search';
import type { ProductSummary } from '../api-types';
import type { SearchSource, SearchState } from '../search';

const MILK: ProductSummary = {
  id: 'p-milk',
  sku: 'MILK-1L',
  nameAr: 'حليب طازج',
  nameEn: null,
  productType: 'unit',
  unitLabel: null,
  priceMinor: '1150',
  vatBasisPoints: 1500,
  primaryBarcode: '6281000000001',
  trackInventory: true,
};

const RICE: ProductSummary = { ...MILK, id: 'p-rice', sku: 'RICE-5K', nameAr: 'أرز' };

interface Deferred {
  readonly promise: Promise<readonly ProductSummary[]>;
  resolve(results: readonly ProductSummary[]): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (results: readonly ProductSummary[]) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<readonly ProductSummary[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('product search', () => {
  it('never lets a slow earlier query overwrite a newer one', async () => {
    // The failure this prevents: the cashier finishes typing "حليب", the
    // answer for "ح" lands afterwards, and the grid shows the wrong products.
    const slow = deferred();
    const fast = deferred();
    const queries: string[] = [];
    const source: SearchSource = {
      products: (query) => {
        queries.push(query.q ?? '');
        return queries.length === 1 ? slow.promise : fast.promise;
      },
    };

    const states: SearchState[] = [];
    const search = createProductSearch(source, (state) => states.push(state));

    const first = search.run('ح');
    const second = search.run('حليب');
    fast.resolve([RICE]);
    await second;
    slow.resolve([MILK]);
    await first;

    const published = states.filter((state) => state.status === 'ready');
    expect(published).toHaveLength(1);
    expect(published[0]?.term).toBe('حليب');
    expect(published[0]?.results).toEqual([RICE]);
  });

  it('aborts the request it is replacing', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const pending = deferred();
    const source: SearchSource = {
      products: (_query, options) => {
        signals.push(options?.signal);
        return pending.promise;
      },
    };
    const search = createProductSearch(source, () => undefined);

    void search.run('ح');
    void search.run('حل');

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    pending.resolve([]);
  });

  it('treats an abort as a cancellation, not as a failure', async () => {
    // The deliberate asymmetry with checkout: nothing happened here and
    // nothing is owed, so there is no state to preserve and nothing to retry.
    const source: SearchSource = {
      products: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    };
    const states: SearchState[] = [];
    const search = createProductSearch(source, (state) => states.push(state));

    await search.run('حليب');
    expect(states.some((state) => state.status === 'failed')).toBe(false);
  });

  it('publishes nothing for an empty term and asks the server nothing', async () => {
    const products = vi.fn(() => Promise.resolve([] as readonly ProductSummary[]));
    const states: SearchState[] = [];
    const search = createProductSearch({ products }, (state) => states.push(state));

    await search.run('   ');

    expect(products).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ status: 'idle', results: [] });
  });

  it('turns a failure into something the cashier can read', async () => {
    const source: SearchSource = {
      products: () => Promise.reject(new ApiError(0, 'network', null)),
    };
    const states: SearchState[] = [];
    const search = createProductSearch(source, (state) => states.push(state));

    await search.run('حليب');

    const last = states.at(-1);
    expect(last?.status).toBe('failed');
    expect(last?.failure?.message).toContain('الخادم');
  });

  it('says nothing after cancel', async () => {
    const pending = deferred();
    const states: SearchState[] = [];
    const search = createProductSearch(
      { products: () => pending.promise },
      (state) => states.push(state),
    );

    const run = search.run('حليب');
    search.cancel();
    pending.resolve([MILK]);
    await run;

    expect(states.some((state) => state.status === 'ready')).toBe(false);
  });
});

describe('what a bare Enter may add', () => {
  const ready = (term: string, results: readonly ProductSummary[]): SearchState => ({
    ...initialSearchState,
    term,
    status: 'ready',
    results,
  });

  it('adds the single result of a scanned barcode', () => {
    expect(autoAddCandidate(ready('6281000000001', [MILK]))).toEqual(MILK);
  });

  it('adds the single result of an exact code', () => {
    expect(autoAddCandidate(ready('MILK-1L', [MILK]))).toEqual(MILK);
  });

  it('will not guess from a word, even when only one thing matches today', () => {
    // "حليب" matching one product now may match three next week, and silently
    // adding one of them is not a habit worth training into a cashier.
    expect(autoAddCandidate(ready('حليب', [MILK]))).toBeNull();
  });

  it('will not guess when several things matched', () => {
    expect(autoAddCandidate(ready('6281000000001', [MILK, RICE]))).toBeNull();
  });
});
EOF

cat << 'EOF' > apps/pos-web/src/lib/__tests__/failures.test.ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { describeFailure } from '../failures';
import { outcomeFor } from '../checkout-flight';

describe('describeFailure', () => {
  it.each([
    ['unauthenticated', 401, 'reauthenticate'],
    ['forbidden', 403, 'permission'],
    ['no-open-shift', 409, 'open-shift'],
    ['shift-invalid', 409, 'refresh-shift'],
    ['insufficient-stock', 409, 'amend-cart'],
    ['insufficient-cash', 422, 'amend-cash'],
    ['idempotency-conflict', 409, 'blocking'],
    ['branch_required', 409, 'blocking'],
    ['tenant-misconfigured', 409, 'blocking'],
    ['network', 0, 'retry-same'],
    ['timeout', 0, 'retry-same'],
  ])('routes %s to %s', (code, status, action) => {
    expect(describeFailure(new ApiError(status, code, null)).action).toBe(action);
  });

  it.each([
    ['retry-same', 'ambiguous'],
    ['blocking', 'blocked'],
    ['amend-cash', 'amendable'],
    ['amend-cart', 'amendable'],
    ['open-shift', 'amendable'],
    ['refresh-shift', 'amendable'],
  ])('classifies %s as %s for the flight', (action, outcome) => {
    expect(outcomeFor(action)).toBe(outcome);
  });

  it('prefers the server’s own Arabic where it sent some', () => {
    const failure = describeFailure(
      new ApiError(409, 'insufficient-stock', 'الكمية المطلوبة غير متوفرة في المخزون.'),
    );
    expect(failure.message).toBe('الكمية المطلوبة غير متوفرة في المخزون.');
  });

  it('says a timeout may have succeeded rather than that it failed', () => {
    // Nobody knows. Telling a cashier it failed is how a sale gets rung twice.
    expect(describeFailure(new ApiError(0, 'timeout', null)).message).toContain('قد تكون');
  });

  it('treats an unknown 5xx as worth retrying', () => {
    expect(describeFailure(new ApiError(503, 'unavailable', null)).action).toBe('retry-same');
  });

  it('never surfaces something that is not an API failure', () => {
    // A stack trace on a till screen helps nobody and tells an attacker the
    // shape of the server.
    const failure = describeFailure(new Error('relation "sales" does not exist'));
    expect(failure.message).not.toContain('sales');
    expect(failure.code).toBe('unexpected');
  });
});
EOF

cat << 'EOF' > apps/pos-web/src/lib/__tests__/datetime.test.ts
import { describe, expect, it } from 'vitest';
import { formatTimestamp } from '../datetime';

describe('formatTimestamp', () => {
  it('renders a receipt time rather than an ISO string', () => {
    const shown = formatTimestamp('2026-08-12T07:00:00.000Z');
    expect(shown).not.toContain('T');
    expect(shown).not.toContain('Z');
    expect(shown).toContain('2026');
  });

  it('is the same string wherever it runs', () => {
    // Fixed locale and fixed time zone: a value that formatted differently on
    // the server and in the browser is a hydration mismatch on every receipt.
    expect(formatTimestamp('2026-08-12T07:00:00.000Z')).toBe(
      formatTimestamp('2026-08-12T07:00:00.000Z'),
    );
  });

  it('shows Riyadh time, not the machine’s idea of local time', () => {
    // 07:00 UTC is 10:00 in Riyadh, whatever the till's clock is set to.
    expect(formatTimestamp('2026-08-12T07:00:00.000Z')).toMatch(/10:00/);
  });

  it('shows what arrived rather than throwing on a bad value', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});
EOF

say "Tests — the screens actually render"

cat << 'EOF' > apps/pos-web/src/__tests__/render-smoke.test.ts
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoginScreen } from '../components/login-screen';
import { BlockedScreen, TerminalPicker } from '../components/terminal-picker';
import { ShiftGate } from '../components/shift-gate';
import { CashierScreen } from '../components/cashier-screen';
import { SaleReceipt } from '../components/sale-receipt';
import { FOREIGN_SHIFT } from '../lib/shift';
import type { ApiClient } from '../lib/api';
import type { Principal, SaleSummary, ShiftSummary, TerminalSummary } from '../lib/api-types';

/**
 * Every screen, rendered.
 *
 * Not a substitute for using the till, and not claimed to be: this is a static
 * render, so no effect runs and no click is dispatched. What it does prove is
 * that each screen composes, that the props each one demands are the props it
 * is given, and that the Arabic and the server-supplied figures reach the
 * markup rather than a formatter throwing on the way.
 */

const api = {} as ApiClient;

const PRINCIPAL: Principal = {
  user: { id: 'u1', email: 'sara@korvi-a.test', displayName: 'سارة' },
  tenant: { id: 't1', slug: 'korvi-a' },
  session: { id: 's1' },
  roles: ['cashier'],
  permissions: ['product.read', 'sale.create', 'shift.open'],
  branchId: '018f2000-0000-7000-8000-0000000000a1',
};

const BRANCH = '018f2000-0000-7000-8000-0000000000a1';

const TILL: TerminalSummary = {
  id: 'tm1',
  code: '01',
  label: 'صندوق ١',
  branchId: BRANCH,
};

const SHIFT: ShiftSummary = {
  id: 'sh1',
  branchId: '018f2000-0000-7000-8000-0000000000a1',
  terminalId: 'tm1',
  userId: 'u1',
  status: 'open',
  openingFloatMinor: '20000',
  openedAt: '2026-08-12T06:00:00.000Z',
};

const SALE: SaleSummary = {
  saleId: 'sale-1',
  operationId: 'op-1',
  sequence: 12,
  invoiceNumber: '01-000012',
  issuedAt: '2026-08-12T07:00:00.000Z',
  currency: 'SAR',
  branchId: '018f2000-0000-7000-8000-0000000000a1',
  terminalId: 'tm1',
  shiftId: 'sh1',
  cashierName: 'سارة',
  lines: [
    {
      lineNumber: 1,
      productId: 'p-milk',
      sku: 'MILK-1L',
      nameAr: 'حليب طازج',
      quantityScaled: '2000',
      unitPriceMinor: '1150',
      netMinor: '2000',
      vatMinor: '300',
      totalMinor: '2300',
    },
  ],
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  cashReceivedMinor: '5000',
  changeMinor: '2700',
};

const noop = (): void => undefined;

describe('login', () => {
  const markup = renderToStaticMarkup(
    createElement(LoginScreen, { api, onAuthenticated: noop, notice: null }),
  );

  it('labels all three fields', () => {
    expect(markup).toContain('رمز المنشأة');
    expect(markup).toContain('البريد الإلكتروني');
    expect(markup).toContain('كلمة المرور');
  });

  it('uses real labels and password autocomplete', () => {
    expect(markup).toContain('for="tenant-slug"');
    // Case-insensitive: HTML attribute names are, and React's static renderer
    // passes this one through in the casing it was written in.
    expect(markup).toMatch(/autocomplete="organization"/i);
    expect(markup).toMatch(/autocomplete="username"/i);
    expect(markup).toMatch(/autocomplete="current-password"/i);
    expect(markup).toContain('type="password"');
  });
});

describe('terminal and shift', () => {
  it('lists the tills on offer', () => {
    const markup = renderToStaticMarkup(
      createElement(TerminalPicker, {
        terminals: [TILL, { ...TILL, id: 'tm2', code: '02', label: 'صندوق ٢' }],
        onChoose: noop,
        onSignOut: noop,
      }),
    );
    expect(markup).toContain('صندوق ١');
    expect(markup).toContain('صندوق ٢');
  });

  it('asks for the opening float in riyals', () => {
    const markup = renderToStaticMarkup(
      createElement(ShiftGate, {
        terminal: TILL,
        busy: false,
        failure: null,
        onOpen: noop,
        onChangeTerminal: null,
        onSignOut: noop,
      }),
    );
    expect(markup).toContain('النقد الافتتاحي');
    expect(markup).toContain('فتح الوردية');
  });
});

describe('the cashier workspace', () => {
  const markup = renderToStaticMarkup(
    createElement(CashierScreen, {
      api,
      principal: PRINCIPAL,
      terminal: TILL,
      shift: SHIFT,
      priceMode: 'tax-inclusive',
      onSignOut: noop,
      onExpired: noop,
      onShiftChanged: noop,
    }),
  );

  it('opens on the search field with an empty cart', () => {
    expect(markup).toContain('ابحث أو امسح الباركود');
    expect(markup).toContain('السلة فارغة');
  });

  it('shows the cashier, the till and an open shift in words', () => {
    expect(markup).toContain('سارة');
    expect(markup).toContain('صندوق ١');
    expect(markup).toContain('وردية مفتوحة');
  });

  it('gives branch context without printing an internal identifier at a customer', () => {
    expect(markup).toContain('الفرع الحالي');
    expect(markup).not.toContain(BRANCH.slice(0, 8));
  });

  it('shows a zero total rather than nothing', () => {
    expect(markup).toContain('المطلوب');
    expect(markup).toContain('0.00');
  });
});

describe('the states a cashier cannot sell out of', () => {
  it('says a logout was not confirmed instead of showing the login form', () => {
    // The failure this guards: the cookie is HttpOnly, so an unconfirmed
    // logout leaves the session live. A login screen here would tell a cashier
    // they had left a till that will restore them on reload.
    const markup = renderToStaticMarkup(
      createElement(BlockedScreen, {
        title: 'لم يتم تأكيد الخروج',
        tone: 'danger',
        failure: {
          code: 'logout_unconfirmed',
          message: 'لم يؤكّد الخادم إنهاء الجلسة، وقد تكون ما تزال مفتوحة.',
          action: 'blocking',
        },
        onRetry: noop,
        retryLabel: 'إعادة محاولة تسجيل الخروج',
      }),
    );
    expect(markup).toContain('لم يؤكّد الخادم');
    expect(markup).toContain('إعادة محاولة تسجيل الخروج');
    expect(markup).not.toContain('كلمة المرور');
  });

  it('offers another till when the drawer belongs to somebody else', () => {
    const markup = renderToStaticMarkup(
      createElement(BlockedScreen, {
        title: 'الوردية تخصّ كاشيراً آخر',
        failure: FOREIGN_SHIFT,
        onRetry: noop,
        onChangeTerminal: noop,
        onSignOut: noop,
      }),
    );
    expect(markup).toContain('وردية مفتوحة لكاشير آخر');
    expect(markup).toContain('اختيار صندوق آخر');
  });
});

describe('the completed sale', () => {
  const markup = renderToStaticMarkup(
    createElement(SaleReceipt, { sale: SALE, replayed: false, onNewSale: noop }),
  );

  it('shows the server’s invoice number and figures, not the cart’s', () => {
    expect(markup).toContain('01-000012');
    expect(markup).toContain('23.00');
    expect(markup).toContain('27.00');
    expect(markup).toContain('3.00');
  });

  it('prints a time a person can read rather than an ISO string', () => {
    expect(markup).not.toContain('2026-08-12T07:00:00.000Z');
    expect(markup).toContain('2026');
  });

  it('offers the next sale as the primary action', () => {
    expect(markup).toContain('عملية بيع جديدة');
  });

  it('says when a response was a replay rather than a new sale', () => {
    const replayed = renderToStaticMarkup(
      createElement(SaleReceipt, { sale: SALE, replayed: true, onNewSale: noop }),
    );
    expect(replayed).toContain('مسجّلة مسبقاً');
  });
});
EOF

say "Toolchain — TSX has to be transformed before it can be rendered"

python3 - <<'PY'
import sys
path = 'vitest.config.ts'
s = open(path, encoding='utf-8').read()
if 'jsx' in s:
    print('  already configured'); sys.exit(0)
old = """export default defineConfig({
  test: {"""
new = """export default defineConfig({
  // apps/pos-web/tsconfig.json sets `jsx: preserve`, because Next does its own
  // transform. Vite's would honour that and hand raw JSX to Node, so the test
  // runner is told to compile it. This changes nothing about the build.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {"""
assert old in s
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  jsx transform enabled for tests')
PY

python3 - <<'PY'
import json, sys
path = 'tsconfig.tests.json'
data = json.load(open(path, encoding='utf-8'))
if 'exclude' in data:
    print('  already scoped'); sys.exit(0)
# apps/pos-web is a Next project: bundler resolution, `jsx: preserve`, and its
# own tsconfig already includes src/**/*.ts, so `npm run typecheck` covers its
# tests. Checking them a second time under nodenext would only fail on the
# module resolution the app does not use.
data['exclude'] = ['apps/pos-web/**']
open(path, 'w', encoding='utf-8').write(json.dumps(data, indent=2) + '\n')
print('  pos-web left to its own project')
PY

say "ADR-0014 — the same-origin topology"

cat << 'EOF' > docs/decisions/ADR-0014-same-origin-browser-topology.md
# ADR-0014 — The browser talks to its own origin

Status: accepted
Date: 2026-08-14
Extends ADR-0012 (authentication), ADR-0013 (the checkout transaction).

## Context

Strike 2B put the session in an HttpOnly, SameSite=Lax, `__Host-` cookie and
made every state-changing request prove its `Origin` against an exact-match
list. That design only works if the browser and the API share an origin. The
obvious alternative — the browser calling `https://api.korvi.sa` directly from
`https://pos.korvi.sa` — breaks three of its four guarantees at once:
`__Host-` cannot be used across hosts, SameSite=Lax stops sending the cookie on
the requests that matter, and CORS has to be opened wide enough to let
credentials through.

## Decision

The browser calls `/v1/*` on the origin it was served from. Next rewrites that
path to Fastify.

```
browser ──/v1/sales──▶ Next (same origin) ──▶ Fastify
```

Consequences that follow from it rather than from any extra work:

- **No CORS anywhere.** Nothing crosses an origin, so there is no preflight to
  answer and no allow-list to widen. A wildcard would be impossible to reach
  even by accident.
- **The cookie stays first-party** on the host the cashier typed, which is what
  `__Host-` requires and what SameSite=Lax assumes.
- **The Origin header stays the browser's own.** Fastify's check in
  `apps/api/src/auth/origin.ts` is unchanged and still exact-match; the value it
  compares is the real origin, not something a proxy synthesised.
  `X-Forwarded-*` remains ignored, as it was.
- **No token exists in JavaScript.** There is nothing to attach to a request,
  nothing to put in `localStorage`, and nothing for a script on the page to
  read.

Next carries bytes. It does not authenticate, authorise, validate, price or
decide anything, and it must not start: every rule in Strikes 2B and 3A-1 lives
in Fastify, and a second implementation in a Node process nobody audits is how
those rules quietly diverge.

## Configuration

`KORVI_API_ORIGIN` names the upstream. It is read once, at build time, by
`resolveApiOrigin` (`apps/pos-web/src/lib/api-origin.ts`), which accepts a bare
`http`/`https` origin and nothing else — a value carrying a path, a query or
credentials stops the build rather than silently rewriting every API call
somewhere unintended.

Unset, it falls back to `http://127.0.0.1:3001`. Loopback is the deliberate
choice: a deployment that forgot to configure it fails to connect, which is
immediately visible, instead of reaching a host nobody chose.

The API's own `APP_ORIGINS` must list the public origin of this app — the one
the browser shows — and nothing else. In production Fastify refuses to boot
without it.

## Consequences

- One origin to serve, one certificate, one cookie domain.
- The API may be closed to the public internet entirely, reachable only from
  the web tier.
- A rewrite destination is baked into the build, so changing the upstream is a
  rebuild. That is the price of not resolving it per request, and it is the
  right side of the trade for a value that must never be attacker-influenced.
- The browser has no offline story and does not pretend to. A dropped
  connection surfaces as an ambiguous checkout the cashier may safely retry
  under the same operation id (ADR-0013), not as a queued sale.
EOF

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

say "Reference documents and Strike 3A-1 arithmetic unchanged?"
[ "$(cksum < docs/design/KORVI-DESIGN-SYSTEM.md)" = "$REF_DESIGN_SUM" ] \
  || die "docs/design/KORVI-DESIGN-SYSTEM.md changed. Aborting."
[ "$(cksum < docs/decisions/ADR-0013-checkout-transaction-and-idempotency.md)" = "$REF_ADR13_SUM" ] \
  || die "ADR-0013 changed. Aborting."
[ "$(cksum < apps/api/src/checkout/service.ts)" = "$SUM_CHECKOUT" ] \
  || die "The checkout pipeline was modified. Strike 3A-2 may not touch it."
[ "$(cksum < packages/database/src/repositories/sale-repository.ts)" = "$SUM_SALEREPO" ] \
  || die "The sale repository was modified. Strike 3A-2 may not touch it."
ok "checkout transaction, receipt allocation and the design system are byte-identical"

say "Committed migrations untouched?"
[ "$(cksum < "$STRIKE_2A_MIGRATION")" = "$SUM_2A" ] \
  || die "The Strike 2A migration was modified. That file is history."
[ "$(cksum < "$STRIKE_2B_MIGRATION")" = "$SUM_2B" ] \
  || die "The Strike 2B migration was modified. That file is history."
MIGRATION_COUNT="$(find packages/database/prisma/migrations -maxdepth 1 -type d -name '2026*' | wc -l | tr -d ' ')"
[ "$MIGRATION_COUNT" = "2" ] || die "Unexpected migration directory count: $MIGRATION_COUNT"
ok "both migrations byte-identical; no migration added"

say "No secret, no float, no mock on the selling path"
if grep -REq '(BEGIN [A-Z ]*PRIVATE KEY|sk_live_|AKIA[0-9A-Z]{16})' apps/pos-web/src apps/api/src 2>/dev/null; then
  die "Something resembling a credential reached a source file."
fi
if grep -REq '(parseFloat|parseInt|\.toFixed\(|Math\.(round|floor|ceil))' \
     apps/pos-web/src/lib/money.ts apps/pos-web/src/lib/quantity.ts apps/pos-web/src/lib/cart.ts 2>/dev/null; then
  die "Float arithmetic reached the money path (ADR-0002)."
fi
# A production mock is worse than a missing feature: it looks like it works.
if grep -REn --include='*.ts' --include='*.tsx' \
     '(mockLogin|fakeCheckout|fakeProducts|FAKE_TERMINAL|hardcodedSale)' \
     apps/pos-web/src 2>/dev/null | grep -v '__tests__'; then
  die "A production mock reached the browser app."
fi
ok "no credential material, no float in the money path, no production mock"

say "The browser stores no session material"
if grep -REn --include='*.ts' --include='*.tsx' \
     '(localStorage|document\.cookie)' apps/pos-web/src 2>/dev/null; then
  die "The browser app touches localStorage or document.cookie; the session is HttpOnly for a reason."
fi
if grep -REn --include='*.ts' --include='*.tsx' 'sessionStorage' apps/pos-web/src 2>/dev/null \
   | grep -v 'device-memory.ts' | grep -v '__tests__'; then
  die "sessionStorage is used outside device-memory.ts, which is the only sanctioned caller."
fi
ok "no token in storage; sessionStorage holds a terminal id and nothing else"

say "RTL and design-system rules"
# The invariant scan covers *.tsx; the app's non-component modules go through
# the same rule here so a class string built in a .ts file cannot slip past.
if grep -REn --include='*.ts' '\b(ml|mr|pl|pr)-[0-9]|\btext-(left|right)\b' apps/pos-web/src 2>/dev/null; then
  die "Physical direction utility in a pos-web module; use logical properties (KORVI-DESIGN-SYSTEM.md §6)."
fi
ok "logical properties only"

say "Formatting the new sources"
npx prettier --write --log-level warn \
  'apps/pos-web/src/**/*.{ts,tsx}' \
  'apps/pos-web/*.ts' \
  'apps/api/src/**/*.ts' \
  'docs/decisions/ADR-0014-same-origin-browser-topology.md' \
  vitest.config.ts tsconfig.tests.json eslint.config.js
npx prettier --check --log-level warn \
  'apps/pos-web/src/**/*.{ts,tsx}' \
  'apps/pos-web/*.ts' \
  'apps/api/src/**/*.ts' \
  'docs/decisions/ADR-0014-same-origin-browser-topology.md' \
  vitest.config.ts tsconfig.tests.json eslint.config.js \
  || die "Sources are still unformatted after a write pass."

say "Dependency pins — asked of the registry now, not remembered"
# The pin check is time-dependent by design: it compares what this repository
# pins against what the registry publishes today. A patch that hardcoded a
# version read months ago would either be a no-op or a lie, so the decision is
# made here, at execution, and it is bounded: the current stable line only.
PINNED_PG="$(node -p "require('./packages/database/package.json').dependencies.pg" 2>/dev/null || echo '')"
LATEST_PG="$(npm view pg version 2>/dev/null || true)"

if [ -z "$PINNED_PG" ]; then
  die "Could not read the pg pin from packages/database/package.json."
elif [ -z "$LATEST_PG" ]; then
  die "Could not reach the registry to check the pg pin.
     The gate compares against the public registry and cannot be run offline."
elif [ "$PINNED_PG" = "$LATEST_PG" ]; then
  ok "pg pinned at $PINNED_PG, which is what the registry publishes"
else
  case "$LATEST_PG" in
    *-*)
      die "The registry's latest pg is $LATEST_PG, a prerelease. Refusing to pin it."
      ;;
    8.*)
      say "pg $PINNED_PG is behind $LATEST_PG; taking the current stable 8.x"
      npm install "pg@$LATEST_PG" --save-exact --workspace @korvi/database --package-lock-only
      ok "pg pinned at $LATEST_PG; the live PostgreSQL suites below are the proof"
      ;;
    *)
      die "The registry's latest pg is $LATEST_PG — a new major line.
     A major driver upgrade is a decision with its own review and its own
     compatibility work, not something a UI patch takes on its way past.
     Bump it deliberately, or record the pin in ALLOWED_BEHIND in
     scripts/verify-versions.mjs with the reason."
      ;;
  esac
fi

say "Installing from the lockfile"
# npm ci, not npm install: the gate below has to be proven against the
# lockfile, not against whatever happens to be in node_modules.
npm ci

say "Running the full gate"
npm run --silent verify

cat << 'SUMMARY'

===============================================================================
  Korvi POS — Strike 3A-2 · the cashier interface
===============================================================================

  THE FLOW
    login  ->  terminal  ->  shift  ->  cashier  ->  checkout  ->  success

    Every step is a state, not a flag, and each waits for the one before it.
    A cashier is never shown a till they cannot use or a basket they cannot
    sell.

  SAME ORIGIN (ADR-0014)
    The browser calls /v1/* on its own origin; Next rewrites to Fastify. No
    CORS exists to widen, the cookie stays first-party and __Host- keeps
    working, and the Origin header Strike 2B checks is the browser's real one.
    KORVI_API_ORIGIN names the upstream and is validated at build time;
    unset, it is loopback, so a misconfigured deployment fails to connect
    rather than proxying somewhere nobody chose.

  ONE SERVER ADDITION
    GET /v1/terminals — requireSession + shift.open, branch taken from
    request.auth, active tills only, four UI-safe fields plus the tenant's
    price mode. It does not accept a branch and could not use one.

  BRANCH AUTHORISATION
    Every route that takes a terminalId now proves, before it does anything
    else, that the till exists in this tenant, is active, and belongs to the
    branch the session is pinned to. A tenant scope is not a branch scope:
    every branch of one merchant shares a tenant, so RLS never had an opinion
    here. A foreign-branch till is answered exactly as a till that does not
    exist — 404 unknown_terminal, byte-identical response — because a 403
    would confirm it is real. A principal with no branch gets 409
    branch_required and cannot name a till at all. Listing tills in the UI
    shapes the interface; it was never the authorisation boundary.

    Nothing else on the server changed: the checkout pipeline and the sale
    repository are asserted byte-identical above.

  WHAT THE BROWSER MAY ASSERT
    POST /v1/sales carries operationId, terminalId, cashReceivedMinor and
    lines of { productId, quantityScaled }. The body is built from a named
    whitelist, so a price, a tenant or a role cannot reach the server even if
    something upstream attaches one.

  MONEY AND QUANTITY
    Riyals in, halalas out, through @korvi/domain's own parsers. No
    parseFloat, no toFixed, no Math.round anywhere on the path — asserted by
    this script and by the invariant scan.

  ONE CHECKOUT AT A TIME
    Ownership of a checkout is claimed synchronously, in a plain object held
    across renders, before any await. Two submits in one tick issue one
    request and mint one operation id; React state is a mirror, never the
    boundary.

  RETRYING SAFELY
    The first attempt freezes an immutable intent — operation id, terminal,
    lines, quantities and cash — and every retry resends exactly that, never a
    request rebuilt from the screen. An unanswered request or a checkout
    timeout (20s) is ambiguous: the basket, the quantities, the cash field,
    the search box and logout all lock until it is resolved. A refusal the
    server decided and rolled back retires the id, so an amended basket goes
    out under a fresh one. An idempotency conflict is blocking and never
    silently mints a replacement.

  SIGNING OUT
    Only the server can revoke a session, so the screen never claims a logout
    it did not get confirmation of. Selling stops before the request goes out;
    an unconfirmed logout is its own blocking state with a retry, not a return
    to the login form.

  THE PRICE MODE IS THE SERVER'S
    GET /v1/terminals carries priceMode and currency, read from
    tenant_settings under the session's scope. The browser cannot send either
    and no longer assumes tax-inclusive; a tenant with no settings is a named
    operational failure rather than a wrong total.

  Printing, card and split tender, refunds, discounts, offline and ZATCA
  Phase 2 are not here and are not faked.

  Nothing was committed, pushed, reset or cleaned.

===============================================================================
SUMMARY

ok "Done."
