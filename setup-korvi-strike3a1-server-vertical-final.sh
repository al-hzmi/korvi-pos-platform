#!/usr/bin/env bash
#
# setup-korvi-strike3a1-server-vertical-final.sh — Korvi POS · Strike 3A-1
#
# The server half of the cashier vertical slice, on top of Strike 2B
# (main @ 3b54695):
#
#   GET  /v1/products          bounded search and listing, product.read
#   GET  /v1/shifts/current    the till's open shift, if any
#   POST /v1/shifts/open       open one, shift.open
#   POST /v1/sales             authoritative cash checkout, sale.create
#
# Prices, VAT, totals and change are computed on the server from persisted
# data using the existing domain. The browser sends identifiers, quantities
# and cash received — nothing else is trusted.
#
# No UI. That is Strike 3A-2.
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

BASELINE=3b54695
if git cat-file -e "${BASELINE}^{commit}" 2>/dev/null; then
  git merge-base --is-ancestor "$BASELINE" HEAD 2>/dev/null \
    || die "HEAD does not descend from $BASELINE."
else
  die "Commit $BASELINE is not in this repository. Fetch it first."
fi

STRIKE_2A_MIGRATION=packages/database/prisma/migrations/20260808120000_saas_foundation/migration.sql
STRIKE_2B_MIGRATION=packages/database/prisma/migrations/20260810120000_auth_security/migration.sql
for required in \
  "$STRIKE_2A_MIGRATION" \
  "$STRIKE_2B_MIGRATION" \
  packages/domain/src/pricing/line.ts \
  packages/domain/src/sale/finalize.ts \
  packages/domain/src/tender/tender.ts \
  packages/domain/src/shift/shift.ts \
  packages/domain/src/ports/persistence.ts \
  packages/domain/src/ports/auth.ts \
  packages/database/src/repositories/product-repository.ts \
  packages/database/src/repositories/sale-repository.ts \
  packages/database/src/repositories/shift-repository.ts \
  packages/database/src/repositories/inventory-repository.ts \
  packages/database/src/__tests__/repository-tenancy.test.ts \
  apps/api/src/auth/guards.ts \
  apps/api/src/server.ts
do
  [ -f "$required" ] || die "Baseline file missing: $required
     This patch expects Strike 2B (main @ $BASELINE)."
done

grep -q 'requirePermission' apps/api/src/auth/guards.ts || die "Auth guards missing; baseline mismatch."
grep -q 'FORCE ROW LEVEL SECURITY' "$STRIKE_2A_MIGRATION" || die "RLS markers missing; baseline mismatch."
grep -q 'login_tenant_slug' "$STRIKE_2B_MIGRATION" || die "Strike 2B markers missing; baseline mismatch."
grep -q 'export function priceCart' packages/domain/src/pricing/line.ts || die "priceCart missing."
grep -q 'export function settle' packages/domain/src/tender/tender.ts || die "settle missing."

# Both migrations are history. Nothing here may edit either.
SUM_2A="$(cksum < "$STRIKE_2A_MIGRATION")"
SUM_2B="$(cksum < "$STRIKE_2B_MIGRATION")"

if [ "$ALLOW_DIRTY" -eq 0 ]; then
  DIRTY="$(git status --porcelain -- \
    apps/api packages/database/src packages/domain/src docs/decisions \
    package.json scripts/verify.sh tsconfig.tests.json 2>/dev/null || true)"
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

mkdir -p apps/api/src/checkout apps/api/src/routes apps/api/src/__tests__

say "Domain — product search port and receipt allocation"

python3 - <<'PY'
import sys
path = 'packages/domain/src/ports/persistence.ts'
s = open(path, encoding='utf-8').read()

def swap(old, new, marker, label):
    global s
    if marker in s:
        print('  %s already present' % label); return
    if old not in s:
        sys.stderr.write('Could not find the anchor for %s.\n' % label); sys.exit(1)
    s = s.replace(old, new, 1)
    print('  %s' % label)

swap(
    """export interface ProductRepository {
  findById(scope: TenantScope, id: string): Promise<Product | null>;""",
    """/**
 * What a cashier typed into the search box.
 *
 * `limit` is required rather than optional: an unbounded product search is a
 * table scan across a merchant's whole catalogue, run on every keystroke.
 */
export interface ProductSearchQuery {
  readonly term: string;
  readonly limit: number;
}

export interface ProductRepository {
  findById(scope: TenantScope, id: string): Promise<Product | null>;
  /**
   * Prefix and code search for the till.
   *
   * Ordered so the common case is cheap: a barcode-shaped term is an exact
   * lookup before anything else runs, because a scanner produces one and the
   * cashier is already reaching for the next item.
   */
  search(scope: TenantScope, query: ProductSearchQuery): Promise<readonly Product[]>;""",
    'search(scope: TenantScope, query: ProductSearchQuery)',
    'ProductRepository.search',
)

swap(
    """export interface RecordSaleInput {
  readonly sale: Omit<SaleRecord, 'tenantId'>;
  readonly invoice: Omit<InvoiceRecord, 'tenantId'>;""",
    """export interface RecordSaleInput {
  /**
   * `sequence` is absent on purpose, and so is the invoice number.
   *
   * A receipt number is not something a caller can know: two tills in one
   * branch would both compute the same "next" one and the second insert would
   * collide on (tenantId, branchId, sequence). The adapter allocates both
   * inside the transaction that writes the sale, serialised on the branch row,
   * so a number is issued exactly once and only to a sale that commits.
   */
  readonly sale: Omit<SaleRecord, 'tenantId' | 'sequence'>;
  readonly invoice: Omit<InvoiceRecord, 'tenantId' | 'invoiceNumber'>;""",
    "Omit<SaleRecord, 'tenantId' | 'sequence'>",
    'RecordSaleInput narrowed',
)

open(path, 'w', encoding='utf-8').write(s)
PY

say "Database — product search"

python3 - <<'PY'
import sys
path = 'packages/database/src/repositories/product-repository.ts'
s = open(path, encoding='utf-8').read()

if 'async search(' in s:
    print('  already present'); sys.exit(0)

old = """    async list(scope: TenantScope, limit: number): Promise<readonly Product[]> {"""
new = """    async search(scope: TenantScope, query: ProductSearchQuery): Promise<readonly Product[]> {
      const term = query.term.normalize('NFKC').trim();
      const limit = Math.min(Math.max(query.limit, 1), 50);
      if (term === '') return [];

      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);

        // A scanner produces 8 to 14 digits and nothing else. Trying that as an
        // exact key first turns the commonest query in a shop into one index
        // probe, and skips the prefix work entirely when it hits.
        if (/^[0-9]{6,14}$/.test(term)) {
          const scanned = await tx.product.findFirst({
            where: {
              tenantId: tenant,
              isActive: true,
              OR: [{ barcodes: { some: { tenantId: tenant, barcode: term } } }, { sku: term }],
            },
            include: WITH_BARCODES,
          });
          if (scanned !== null) return [toDomain(scope, scanned)];
        }

        // Everything else is anchored. `startsWith` uses the (tenantId, nameAr)
        // and (tenantId, sku) indexes; a leading wildcard would not, and would
        // scan the whole catalogue on every keystroke.
        //
        // The suffix case is served by codeReverse: a cashier reading the last
        // digits off a label is asking a suffix question, and storing the
        // reversed code turns it back into a prefix one (ports/search.ts).
        const reversed = codeReverse(term);
        const rows = await tx.product.findMany({
          where: {
            tenantId: tenant,
            isActive: true,
            OR: [
              { nameAr: { startsWith: term } },
              { nameEn: { startsWith: term, mode: 'insensitive' } },
              { sku: { startsWith: term, mode: 'insensitive' } },
              { codeReverse: { startsWith: reversed } },
              { barcodes: { some: { tenantId: tenant, barcode: { startsWith: term } } } },
            ],
          },
          orderBy: [{ nameAr: 'asc' }],
          take: limit,
          include: WITH_BARCODES,
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },

    async list(scope: TenantScope, limit: number): Promise<readonly Product[]> {"""
assert old in s
s = s.replace(old, new, 1)

s = s.replace(
    "import { oneOf, rate, scoped, tenantParam } from './mapping.js';",
    "import { codeReverse } from '@korvi/domain';\nimport { oneOf, rate, scoped, tenantParam } from './mapping.js';",
    1,
)
s = s.replace(
    """  ProductRepository,
  ProductType,""",
    """  ProductRepository,
  ProductSearchQuery,
  ProductType,""",
    1,
)
open(path, 'w', encoding='utf-8').write(s)
print('  search added')
PY

say "Database — typed persistence failures the API can map"

python3 - <<'PY'
import sys
path = 'packages/database/src/errors.ts'
s = open(path, encoding='utf-8').read()
if 'InsufficientStockError' in s:
    print('  already present'); sys.exit(0)

s = s.rstrip('\n') + """

/**
 * A stock movement would have taken a balance below zero.
 *
 * Raised by the database mutation itself, not by a prior read: two tills
 * selling the last unit both see one in stock, and only the guarded UPDATE can
 * tell the loser apart from the winner.
 */
export class InsufficientStockError extends DatabaseError {
  public override readonly name = 'InsufficientStockError';
}

/**
 * The operation id was already recorded by a transaction that has now
 * committed.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` blocks on an uncommitted conflicting row,
 * so by the time this is thrown the competitor has definitely finished — which
 * is what makes it safe for the caller to go and read the result.
 */
export class OperationAlreadyRecordedError extends DatabaseError {
  public override readonly name = 'OperationAlreadyRecordedError';
}

/**
 * The shift named by a sale was not open, or not the one the sale claims.
 *
 * Checked while the sale transaction holds the shift row, because a shift can
 * be closed between a pre-flight read and a commit.
 */
export class ShiftUnusableError extends DatabaseError {
  public override readonly name = 'ShiftUnusableError';
  public readonly detail: string;

  public constructor(detail: string) {
    super(`Shift unusable: ${detail}`);
    this.detail = detail;
  }
}

/** A shift could not be opened on this terminal. */
export class ShiftOpenRefusedError extends DatabaseError {
  public override readonly name = 'ShiftOpenRefusedError';
  public readonly detail: 'unknown-terminal' | 'already-open';

  public constructor(detail: 'unknown-terminal' | 'already-open') {
    super(`Shift open refused: ${detail}`);
    this.detail = detail;
  }
}
"""
open(path, 'w', encoding='utf-8').write(s)
print('  errors added')
PY

python3 - <<'PY'
import sys
path = 'packages/database/src/index.ts'
s = open(path, encoding='utf-8').read()
if 'InsufficientStockError' in s:
    print('  already exported'); sys.exit(0)
s = s.replace(
    "export { DatabaseError, TenantContextError } from './errors.js';",
    "export {\n  DatabaseError,\n  TenantContextError,\n  InsufficientStockError,\n  OperationAlreadyRecordedError,\n  ShiftUnusableError,\n  ShiftOpenRefusedError,\n} from './errors.js';",
    1,
)
open(path, 'w', encoding='utf-8').write(s)
print('  errors exported')
PY

say "Database — stock guarded by the database, not by a prior read"

python3 - <<'PY'
import sys
path = 'packages/database/src/repositories/inventory-repository.ts'
s = open(path, encoding='utf-8').read()
if 'allowNegative' in s:
    print('  already guarded'); sys.exit(0)

old = """export async function applyMovementWithin(
  tx: TransactionClient,
  tenant: string,
  movement: InventoryMovementInput,
): Promise<BalanceRow> {
  const quantity = BigInt(movement.quantityScaled);

  await tx.inventoryMovement.create({"""
new = """export async function applyMovementWithin(
  tx: TransactionClient,
  tenant: string,
  movement: InventoryMovementInput,
  allowNegative = true,
): Promise<BalanceRow> {
  const quantity = BigInt(movement.quantityScaled);

  await tx.inventoryMovement.create({"""
assert old in s
s = s.replace(old, new, 1)

old = """  return tx.inventoryBalance.upsert({
    where: {
      tenantId_branchId_productId: {
        tenantId: tenant,
        branchId: movement.branchId,
        productId: movement.productId,
      },
    },
    create: {
      tenantId: tenant,
      branchId: movement.branchId,
      productId: movement.productId,
      quantityScaled: quantity,
    },
    update: { quantityScaled: { increment: quantity } },
  });
}"""
new = """  if (allowNegative) {
    return tx.inventoryBalance.upsert({
      where: {
        tenantId_branchId_productId: {
          tenantId: tenant,
          branchId: movement.branchId,
          productId: movement.productId,
        },
      },
      create: {
        tenantId: tenant,
        branchId: movement.branchId,
        productId: movement.productId,
        quantityScaled: quantity,
      },
      update: { quantityScaled: { increment: quantity } },
    });
  }

  // The merchant has said stock may not go negative, so the *mutation* has to
  // enforce it. A read followed by an increment cannot: two tills both see one
  // unit left, both pass their own check, and both decrement.
  //
  // The predicate is evaluated after the row lock is taken, so the second
  // transaction re-reads what the first committed and matches nothing.
  const updated = await tx.$queryRaw<{ quantityScaled: bigint }[]>`
    UPDATE "inventory_balances"
       SET "quantityScaled" = "quantityScaled" + ${quantity},
           "updatedAt" = now()
     WHERE "tenantId" = ${tenant}::uuid
       AND "branchId" = ${movement.branchId}::uuid
       AND "productId" = ${movement.productId}::uuid
       AND "quantityScaled" + ${quantity} >= 0
    RETURNING "quantityScaled"`;

  const row = updated.at(0);
  if (row !== undefined) {
    return {
      tenantId: tenant,
      branchId: movement.branchId,
      productId: movement.productId,
      quantityScaled: row.quantityScaled,
    };
  }

  // Nothing matched: either the balance row does not exist yet, or applying
  // this delta would go below zero. A shipment into a product with no row is
  // legitimate; taking stock off a shelf that has none is not.
  if (quantity < 0n) {
    throw new InsufficientStockError(
      'The branch does not hold enough of this product to satisfy the movement.',
    );
  }

  const created = await tx.inventoryBalance.upsert({
    where: {
      tenantId_branchId_productId: {
        tenantId: tenant,
        branchId: movement.branchId,
        productId: movement.productId,
      },
    },
    create: {
      tenantId: tenant,
      branchId: movement.branchId,
      productId: movement.productId,
      quantityScaled: quantity,
    },
    update: { quantityScaled: { increment: quantity } },
  });
  return created;
}"""
assert old in s
s = s.replace(old, new, 1)
s = s.replace(
    "import { withTenant } from '../tenant-context.js';",
    "import { withTenant } from '../tenant-context.js';\nimport { InsufficientStockError } from '../errors.js';",
    1,
)
open(path, 'w', encoding='utf-8').write(s)
print('  guarded decrement added')
PY

say "Database — receipt numbering inside the sale transaction"

python3 - <<'PY'
import sys
path = 'packages/database/src/repositories/sale-repository.ts'
s = open(path, encoding='utf-8').read()

if 'allocateReceipt' in s:
    print('  already present'); sys.exit(0)

ALLOC = '''
/**
 * Allocate the branch's next receipt number, inside the caller's transaction.
 *
 * `SELECT ... FOR UPDATE` on the branch row is the serialization boundary. Two
 * tills checking out at the same moment both want `MAX(sequence) + 1`; under
 * READ COMMITTED they would read the same number, and the second INSERT would
 * fail on (tenantId, branchId, sequence). Taking the branch row's lock first
 * makes the second wait for the first to commit, so it reads the number that
 * now exists.
 *
 * The lock is held for the rest of the transaction, which is what makes this
 * correct and also what makes it a per-branch queue. A checkout is a handful of
 * inserts; a shop that outgrows that wants a sequence object, and this is the
 * one place that would change.
 *
 * A rolled-back checkout releases the lock without having inserted anything, so
 * the number it was going to use is handed to the next transaction instead —
 * numbering has no gap. A committed sale that is later voided keeps its number,
 * because a tax document that vanishes from the series is worse than one marked
 * void.
 */
async function allocateReceipt(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
): Promise<{ sequence: number; invoiceNumber: string }> {
  const branches = await tx.$queryRaw<{ code: string }[]>`
    SELECT "code" FROM "branches"
     WHERE "id" = ${branchId}::uuid AND "tenantId" = ${tenant}::uuid
     FOR UPDATE`;
  const branch = branches.at(0);
  if (branch === undefined) {
    throw new DatabaseError('No such branch in this tenant; refusing to number a sale for it.');
  }

  const next = await tx.$queryRaw<{ sequence: number }[]>`
    SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "sales"
     WHERE "tenantId" = ${tenant}::uuid AND "branchId" = ${branchId}::uuid`;
  const sequence = Number(next.at(0)?.sequence ?? 1);

  // Branch code first, so two branches of one merchant never produce the same
  // string, and the series is readable on a printed receipt.
  return { sequence, invoiceNumber: `${branch.code}-${String(sequence).padStart(6, '0')}` };
}
'''

anchor = "const WITH_CHILDREN = {"
assert anchor in s
s = s.replace(anchor, ALLOC.lstrip('\n') + '\n' + anchor, 1)

old = """        const tenant = tenantParam(scope);
        const { sale, invoice, inventory, cashMovement, idempotency } = input;
"""
new = """        const tenant = tenantParam(scope);
        const { sale, invoice, inventory, cashMovement, idempotency } = input;

        // First, and inside this transaction: the number is issued to a sale
        // that is about to exist, not to a request that might not finish.
        const receipt = await allocateReceipt(tx, tenant, sale.branchId);
"""
assert old in s
s = s.replace(old, new, 1)

s = s.replace("            sequence: sale.sequence,", "            sequence: receipt.sequence,", 1)
s = s.replace("            invoiceNumber: invoice.invoiceNumber,", "            invoiceNumber: receipt.invoiceNumber,", 1)
open(path, 'w', encoding='utf-8').write(s)
print('  receipt allocation added')
PY

say "Database — the sale transaction owns shift, stock and idempotency"

python3 - <<'PY'
import sys
path = 'packages/database/src/repositories/sale-repository.ts'
s = open(path, encoding='utf-8').read()
if 'assertShiftUsable' in s:
    print('  already present'); sys.exit(0)

GUARDS = """
/**
 * Prove the shift is still the one this sale claims, and still open.
 *
 * The pre-flight read in the checkout service happens before any of this; a
 * shift can be closed in between, and a sale posted into a closed shift is
 * money that reconciles against nothing. The row is locked, so a concurrent
 * close waits for this transaction rather than racing it.
 *
 * Terminal, branch and cashier are checked here rather than trusted from the
 * request, which is the same rule the rest of the pipeline follows.
 */
async function assertShiftUsable(
  tx: TransactionClient,
  tenant: string,
  sale: { shiftId: string; terminalId: string; branchId: string; userId: string },
): Promise<void> {
  const rows = await tx.$queryRaw<
    { status: string; terminalId: string; branchId: string; userId: string }[]
  >`
    SELECT "status", "terminalId", "branchId", "userId" FROM "shifts"
     WHERE "id" = ${sale.shiftId}::uuid AND "tenantId" = ${tenant}::uuid
     FOR UPDATE`;

  const shift = rows.at(0);
  if (shift === undefined) throw new ShiftUnusableError('unknown-shift');
  if (shift.status !== 'open') throw new ShiftUnusableError('shift-closed');
  if (shift.terminalId !== sale.terminalId) throw new ShiftUnusableError('terminal-mismatch');
  if (shift.branchId !== sale.branchId) throw new ShiftUnusableError('branch-mismatch');
  // One drawer, one cashier. A shared shift is a reconciliation nobody can do,
  // and no existing Korvi rule permits it.
  if (shift.userId !== sale.userId) throw new ShiftUnusableError('cashier-mismatch');
}

/**
 * Reserve the operation id, or discover that somebody else already did.
 *
 * `ON CONFLICT DO NOTHING` blocks on an uncommitted conflicting row, so when it
 * returns nothing the competing transaction has definitely committed — which is
 * what makes it safe for the caller to go and read the sale it produced. The
 * unique index stays the authority; this only turns losing the race into a
 * defined outcome instead of a raw constraint violation.
 */
async function reserveOperation(
  tx: TransactionClient,
  tenant: string,
  reservation: { id: string; scope: string; operationId: string; requestHash: string | null },
  resultId: string,
  completedAt: Date,
): Promise<void> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "idempotency_keys"
      ("id","tenantId","scope","operationId","status","resultType","resultId","requestHash","completedAt")
    VALUES (${reservation.id}::uuid, ${tenant}::uuid, ${reservation.scope}, ${reservation.operationId},
            'completed', 'sale', ${resultId}::uuid, ${reservation.requestHash}, ${completedAt})
    ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
    RETURNING "id"`;
  if (inserted.length === 0) throw new OperationAlreadyRecordedError(reservation.operationId);
}
"""

anchor = 'const WITH_CHILDREN = {'
assert anchor in s
s = s.replace(anchor, GUARDS.strip() + '\n\n' + anchor, 1)

old = """        const receipt = await allocateReceipt(tx, tenant, sale.branchId);
"""
new = """        const receipt = await allocateReceipt(tx, tenant, sale.branchId);

        // Before anything is written: the shift this sale names must still be
        // open, still on this terminal, still in this branch and still the
        // cashier's own.
        await assertShiftUsable(tx, tenant, {
          shiftId: sale.shiftId,
          terminalId: sale.terminalId,
          branchId: sale.branchId,
          userId: sale.userId,
        });

        // The merchant's overselling policy, read inside the transaction that
        // is about to move the stock.
        const settingsRows = await tx.$queryRaw<{ allowNegativeStock: boolean }[]>`
          SELECT "allowNegativeStock" FROM "tenant_settings"
           WHERE "tenantId" = ${tenant}::uuid`;
        const allowNegativeStock = settingsRows.at(0)?.allowNegativeStock ?? false;
"""
assert old in s
s = s.replace(old, new, 1)

old = """        await tx.idempotencyKey.create({
          data: {
            id: idempotency.id,
            tenantId: tenant,
            scope: idempotency.scope,
            operationId: idempotency.operationId,
            status: 'completed',
            resultType: 'sale',
            resultId: sale.id,
            requestHash: idempotency.requestHash,
            completedAt: new Date(sale.issuedAt),
          },
        });"""
new = """        await reserveOperation(tx, tenant, idempotency, sale.id, new Date(sale.issuedAt));"""
assert old in s
s = s.replace(old, new, 1)

old = """        for (const movement of inventory) {
          await applyMovementWithin(tx, tenant, movement);
        }"""
new = """        for (const movement of inventory) {
          // The guard is in the UPDATE, not in a prior read: two tills selling
          // the last unit both saw one in stock, and only this can tell them
          // apart. A refusal aborts the whole transaction.
          await applyMovementWithin(tx, tenant, movement, allowNegativeStock);
        }"""
assert old in s
s = s.replace(old, new, 1)

s = s.replace(
    "import { DatabaseError } from '../errors.js';",
    "import {\n  DatabaseError,\n  OperationAlreadyRecordedError,\n  ShiftUnusableError,\n} from '../errors.js';",
    1,
)
open(path, 'w', encoding='utf-8').write(s)
print('  sale transaction hardened')
PY

say "Database — opening a shift serialises on the terminal row"

python3 - <<'PY'
import sys
path = 'packages/database/src/repositories/shift-repository.ts'
s = open(path, encoding='utf-8').read()
if 'FOR UPDATE' in s:
    print('  already serialised'); sys.exit(0)

old = """        const tenant = tenantParam(scope);

        // A till with two open shifts has no answerable cash position, so the
        // second open is refused rather than allowed to produce one.
        const existing = await tx.shift.findFirst({
          where: { terminalId: input.terminalId, status: 'open', tenantId: tenant },
        });
        if (existing !== null) {
          throw new DatabaseError(
            `Terminal ${input.terminalId} already has an open shift (${existing.id}).`,
          );
        }
"""
new = """        const tenant = tenantParam(scope);

        // The terminal row is the serialization boundary. Two cashiers pressing
        // "open shift" on the same till at the same moment would both find no
        // open shift and both create one; there is no unique index that stops
        // that, because a terminal legitimately has many shifts over time.
        // Taking the lock first makes the second wait and then see the first.
        const terminals = await tx.$queryRaw<{ branchId: string; isActive: boolean }[]>`
          SELECT "branchId", "isActive" FROM "terminals"
           WHERE "id" = ${input.terminalId}::uuid AND "tenantId" = ${tenant}::uuid
           FOR UPDATE`;
        const terminal = terminals.at(0);
        if (terminal === undefined || !terminal.isActive) {
          throw new ShiftOpenRefusedError('unknown-terminal');
        }
        if (terminal.branchId !== input.branchId) {
          // The branch comes from the terminal everywhere else; a mismatch here
          // means the caller assembled the input from two different places.
          throw new ShiftOpenRefusedError('unknown-terminal');
        }

        // A till with two open shifts has no answerable cash position.
        const existing = await tx.shift.findFirst({
          where: { terminalId: input.terminalId, status: 'open', tenantId: tenant },
        });
        if (existing !== null) {
          throw new ShiftOpenRefusedError('already-open');
        }
"""
assert old in s
s = s.replace(old, new, 1)
s = s.replace(
    "import { DatabaseError } from '../errors.js';",
    "import { DatabaseError, ShiftOpenRefusedError } from '../errors.js';",
    1,
)
open(path, 'w', encoding='utf-8').write(s)
print('  terminal lock added')
PY

say "Database — the Strike 2A record() test follows the narrowed contract"

python3 - <<'PY'
import sys
path = 'packages/database/src/__tests__/repository-tenancy.test.ts'
s = open(path, encoding='utf-8').read()

if 'allocates the receipt number' in s:
    print('  already updated'); sys.exit(0)

# The fake now has to answer the two raw statements the allocation makes.
old = """        if (model === '$executeRaw') {
          return (_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
            contexts.push(values[0]);
            return Promise.resolve(1);
          };
        }"""
new = """        if (model === '$executeRaw') {
          return (_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
            contexts.push(values[0]);
            return Promise.resolve(1);
          };
        }
        if (model === '$queryRaw') {
          // The receipt allocation asks for the branch row and then for the
          // next number. Answering both keeps this a test of tenant scoping
          // rather than a test of how the numbering happens to be written.
          return (
            strings: TemplateStringsArray,
            ...values: unknown[]
          ): Promise<unknown[]> => {
            const sql = strings.join(' ');
            // The bound values travel with the statement, so a test can still
            // ask what was reserved without the fake parsing SQL.
            raw.push(`${sql} -- ${values.map((value) => String(value)).join(',')}`);
            if (sql.includes('"branches"')) return Promise.resolve([{ code: '01' }]);
            if (sql.includes('"terminals"')) {
              return Promise.resolve([{ branchId: 'b1', isActive: true }]);
            }
            if (sql.includes('"shifts"')) {
              return Promise.resolve([
                { status: 'open', terminalId: 't1', branchId: 'b1', userId: 'u1' },
              ]);
            }
            if (sql.includes('"tenant_settings"')) {
              return Promise.resolve([{ allowNegativeStock: false }]);
            }
            if (sql.includes('"idempotency_keys"')) return Promise.resolve([{ id: 'ik1' }]);
            if (sql.includes('"inventory_balances"')) {
              return Promise.resolve([{ quantityScaled: 0n }]);
            }
            return Promise.resolve([{ sequence: 12 }]);
          };
        }"""
assert old in s
s = s.replace(old, new, 1)

s = s.replace(
    """  const calls: Call[] = [];
  const contexts: unknown[] = [];""",
    """  const calls: Call[] = [];
  const contexts: unknown[] = [];
  const raw: string[] = [];""",
    1,
)
s = s.replace(
    """  readonly calls: Call[];
  readonly contexts: unknown[];
}""",
    """  readonly calls: Call[];
  readonly contexts: unknown[];
  readonly raw: string[];
}""",
    1,
)
s = s.replace(
    """  return { client, calls, contexts };""",
    """  return { client, calls, contexts, raw };""",
    1,
)

# The caller no longer supplies either number.
s = s.replace("""        operationId: 'op-1',
        status: 'finalized',
        sequence: 12,
        priceMode: 'tax-inclusive',""",
"""        operationId: 'op-1',
        status: 'finalized',
        priceMode: 'tax-inclusive',""", 1)
s = s.replace("""        saleId: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
        invoiceNumber: 'INV-000012',
        invoiceType: 'simplified',""",
"""        saleId: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
        invoiceType: 'simplified',""", 1)

old = """  it('reads the finalized sale back with money as strings', async () => {"""
new = """  it('allocates the receipt number itself, under the branch row lock', async () => {
    // The caller cannot supply it: two tills would compute the same "next"
    // number and the second insert would collide.
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    expect(f.raw.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    const created = f.calls.find((call) => `${call.model}.${call.method}` === 'sale.create');
    expect(show(created?.args['data'])).toContain('"sequence":12');

    const invoice = f.calls.find((call) => `${call.model}.${call.method}` === 'invoice.create');
    expect(show(invoice?.args['data'])).toContain('01-000012');
  });

  it('reads the finalized sale back with money as strings', async () => {"""
assert old in s
s = s.replace(old, new, 1)
# The transaction it describes has changed shape: the reservation and the
# balance move are raw statements now, because both are races a Prisma call
# cannot settle. The assertions follow the implementation rather than the other
# way round.
s = s.replace(
    """    const touched = f.calls.map((call) => `${call.model}.${call.method}`);
    for (const expected of [
      'idempotencyKey.create',
      'sale.create',
      'saleLine.createMany',
      'tender.createMany',
      'invoice.create',
      'invoiceTaxBreakdown.createMany',
      'inventoryMovement.create',
      'inventoryBalance.upsert',
      'cashMovement.create',
    ]) {
      expect(touched).toContain(expected);
    }
  });""",
    """    const touched = f.calls.map((call) => `${call.model}.${call.method}`);
    for (const expected of [
      'sale.create',
      'saleLine.createMany',
      'tender.createMany',
      'invoice.create',
      'invoiceTaxBreakdown.createMany',
      'inventoryMovement.create',
      'cashMovement.create',
    ]) {
      expect(touched).toContain(expected);
    }

    // The reservation and the balance move are raw statements: one so a
    // concurrent duplicate loses deterministically, the other so a shelf
    // cannot go below zero. Both are inside this same transaction.
    expect(f.raw.some((sql) => sql.includes('\"idempotency_keys\"'))).toBe(true);
    expect(f.raw.some((sql) => sql.includes('\"inventory_balances\"'))).toBe(true);
  });""",
    1,
)

s = s.replace(
    """    const reservation = f.calls.find((call) => call.model === 'idempotencyKey');
    const data = show(reservation?.args['data']);
    expect(data).toContain('op-1');
    expect(data).toContain('checkout');
    expect(data).toContain(TENANT);
  });""",
    """    const reservation = f.raw.find((sql) => sql.includes('\"idempotency_keys\"'));
    expect(reservation).toBeDefined();
    expect(reservation).toContain('op-1');
    expect(reservation).toContain('checkout');
    expect(reservation).toContain(TENANT);
    // Losing the race has to be a defined outcome the service can map, not a
    // raw unique-constraint violation on its way to the client.
    expect(reservation).toContain('ON CONFLICT');
    expect(reservation).toContain('DO NOTHING');
  });""",
    1,
)

s = s.replace(
    """  it('moves stock by increment rather than by read-modify-write', async () => {
    // Two terminals selling the last unit would both read 1 and both write 0.
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    const upsert = f.calls.find((call) => call.method === 'upsert');
    expect(show(upsert?.args['update'])).toContain('increment');
  });""",
    """  it('moves stock by a guarded UPDATE rather than a read-modify-write', async () => {
    // Two terminals selling the last unit would both read 1 and both write 0.
    // The predicate is evaluated after the row lock is taken, so the loser
    // matches nothing and its whole transaction goes back.
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    const update = f.raw.find((sql) => sql.includes('\"inventory_balances\"'));
    expect(update).toBeDefined();
    expect(update).toContain('UPDATE');
    expect(update).toContain('>= 0');
  });""",
    1,
)

s = s.replace(
    """  it('refuses to open a second shift on a till that already has one', async () => {
    const f = fake({ 'shift.findFirst': [{ id: 's-open', tenantId: TENANT, status: 'open' }] });
    await expect(
      createShiftRepository(f.client).open(scope, {
        id: 's2',
        branchId: 'b1',
        terminalId: 't1',
        userId: 'u1',
        openingFloatMinor: '20000',
        openedAt: AT,
        openingMovementId: 'cm0',
      }),
    ).rejects.toThrow(/already has an open shift/i);
  });""",
    """  it('refuses to open a second shift on a till that already has one', async () => {
    const f = fake({ 'shift.findFirst': [{ id: 's-open', tenantId: TENANT, status: 'open' }] });
    await expect(
      createShiftRepository(f.client).open(scope, {
        id: 's2',
        branchId: 'b1',
        terminalId: 't1',
        userId: 'u1',
        openingFloatMinor: '20000',
        openedAt: AT,
        openingMovementId: 'cm0',
      }),
    ).rejects.toThrow(ShiftOpenRefusedError);
    // And it serialises on the terminal row first, because two cashiers
    // pressing the button together would both find no open shift.
    expect(f.raw.some((sql) => sql.includes('\"terminals\"') && sql.includes('FOR UPDATE'))).toBe(
      true,
    );
  });""",
    1,
)

s = s.replace(
    "import { createShiftRepository } from '../repositories/shift-repository.js';",
    "import { createShiftRepository } from '../repositories/shift-repository.js';\nimport { ShiftOpenRefusedError } from '../errors.js';",
    1,
)

open(path, 'w', encoding='utf-8').write(s)
print('  updated')
PY

say "API — checkout intent fingerprint"

cat << 'EOF' > apps/api/src/checkout/fingerprint.ts
import { createHash } from 'node:crypto';

/**
 * What the client says it wants to happen.
 *
 * Only the fields that make one checkout a different checkout from another.
 * Nothing here is authoritative — prices, VAT and totals are read from the
 * database — but if any of it changes, the request is a different request and
 * must not be answered with an earlier sale.
 */
export interface CheckoutIntent {
  readonly branchId: string;
  readonly terminalId: string;
  readonly lines: readonly { readonly productId: string; readonly quantityScaled: string }[];
  readonly cashReceivedMinor: string;
}

/**
 * A stable fingerprint of the intent, stored beside the idempotency key.
 *
 * The point is to make a replay provable rather than assumed. An operation id
 * that comes back with a different basket is not a retry — it is a second sale
 * wearing the first one's name, usually because a client reused a key it should
 * have regenerated. Returning the earlier sale there would silently drop a
 * transaction the cashier believes they rang up.
 *
 * Canonicalised before hashing: lines are sorted by product, so a client that
 * reorders the basket between attempts still fingerprints the same, and the
 * separators cannot be forged from field content because ids and scaled
 * integers contain neither of them.
 *
 * Nothing secret goes in. It is product ids, quantities and a cash figure —
 * exactly what the sale row itself will hold in the clear.
 */
export function fingerprintIntent(intent: CheckoutIntent): string {
  const lines = [...intent.lines]
    .sort((left, right) => (left.productId < right.productId ? -1 : 1))
    .map((line) => `${line.productId}:${line.quantityScaled}`)
    .join(',');

  const canonical = [
    'v1',
    intent.branchId,
    intent.terminalId,
    intent.cashReceivedMinor,
    lines,
  ].join('|');

  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}
EOF

say "API — the checkout pipeline"

cat << 'EOF' > apps/api/src/checkout/service.ts
import {
  InvalidAmountError,
  NonCashChangeError,
  UnderpaidError,
  basisPoints,
  finalizeSale,
  maxDiscountForRoles,
  money,
  moneyToMajorString,
  newId as defaultNewId,
  quantity,
  saleReconciles,
  tenantId as brandTenantId,
} from '@korvi/domain';
import { InsufficientStockError, OperationAlreadyRecordedError, ShiftUnusableError } from '@korvi/database';
import { fingerprintIntent } from './fingerprint.js';
import type {
  AuditRepository,
  AuthenticatedPrincipal,
  CartLineInput,
  Currency,
  IdempotencyRepository,
  InventoryMovementInput,
  InventoryRepository,
  PriceMode,
  Product,
  ProductRepository,
  SaleRecord,
  SaleRepository,
  ShiftRepository,
  TenantRepository,
  TenantScope,
} from '@korvi/domain';

/**
 * The cash checkout.
 *
 * The browser sends product ids, quantities and the cash it was handed. That is
 * the whole of what a client is allowed to assert. Prices, VAT rates, the price
 * mode, the seller's tax identity, the receipt number and every derived figure
 * come from persistence and from the domain — because a till is operated by
 * people whose interests do not always align with the merchant's, and because
 * the browser is not a place where money can be decided.
 */

export type CheckoutFailureReason =
  | 'empty-cart'
  | 'no-open-shift'
  | 'unknown-product'
  | 'product-unavailable'
  | 'invalid-quantity'
  | 'insufficient-stock'
  | 'insufficient-cash'
  | 'idempotency-conflict'
  | 'duplicate-line'
  | 'shift-invalid'
  | 'tenant-misconfigured';

export interface CheckoutFailure {
  readonly outcome: 'failure';
  readonly reason: CheckoutFailureReason;
  /** Safe to show a cashier; never a database or security detail. */
  readonly detail?: string;
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

export interface CheckoutSuccess {
  readonly outcome: 'success';
  /** True when this request replayed an operation id that already completed. */
  readonly replayed: boolean;
  readonly sale: SaleSummary;
}

export type CheckoutResult = CheckoutSuccess | CheckoutFailure;

export interface CheckoutLineInput {
  readonly productId: string;
  /** Scaled by 1000, as a string. Never a float (ADR-0002). */
  readonly quantityScaled: string;
}

export interface CheckoutInput {
  readonly principal: AuthenticatedPrincipal;
  readonly operationId: string;
  readonly terminalId: string;
  readonly lines: readonly CheckoutLineInput[];
  readonly cashReceivedMinor: string;
}

export interface CheckoutDeps {
  readonly tenants: TenantRepository;
  readonly products: ProductRepository;
  readonly inventory: InventoryRepository;
  readonly shifts: ShiftRepository;
  readonly sales: SaleRepository;
  readonly idempotency: IdempotencyRepository;
  readonly audit: AuditRepository;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly onAuditError?: (error: unknown) => void;
}

const IDEMPOTENCY_SCOPE = 'checkout';

function fail(reason: CheckoutFailureReason, detail?: string): CheckoutFailure {
  return detail === undefined ? { outcome: 'failure', reason } : { outcome: 'failure', reason, detail };
}

function summarise(sale: SaleRecord, invoiceNumber: string, cashierName: string): SaleSummary {
  return {
    saleId: sale.id,
    operationId: sale.operationId,
    sequence: sale.sequence,
    invoiceNumber,
    issuedAt: sale.issuedAt,
    currency: sale.currency,
    branchId: sale.branchId,
    terminalId: sale.terminalId,
    shiftId: sale.shiftId,
    cashierName,
    lines: sale.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productId: line.productId,
      sku: line.sku,
      nameAr: line.nameAr,
      quantityScaled: line.quantityScaled,
      unitPriceMinor: line.unitPriceMinor,
      netMinor: line.netMinor,
      vatMinor: line.vatMinor,
      totalMinor: line.totalMinor,
    })),
    netMinor: sale.netMinor,
    vatMinor: sale.vatMinor,
    totalMinor: sale.totalMinor,
    cashReceivedMinor: sale.tenderedMinor,
    changeMinor: sale.changeMinor,
  };
}

export interface CheckoutService {
  checkout(input: CheckoutInput): Promise<CheckoutResult>;
}

export function createCheckoutService(deps: CheckoutDeps): CheckoutService {
  const { now = () => new Date(), newId = defaultNewId, onAuditError = () => undefined } = deps;

  /**
   * Answer a request whose operation id belongs to a transaction that has
   * already committed.
   *
   * Reached from two directions — the pre-flight read, and losing the
   * ON CONFLICT race — and both need the same answer, so both come here.
   */
  async function resolveCompetingOperation(
    scope: TenantScope,
    input: CheckoutInput,
    intentHash: string,
    displayName: string,
  ): Promise<CheckoutResult> {
    const reserved = await deps.idempotency.find(scope, IDEMPOTENCY_SCOPE, input.operationId);
    if (reserved !== null && reserved.requestHash !== intentHash) {
      return fail('idempotency-conflict');
    }
    const existing = await deps.sales.findByOperationId(scope, input.operationId);
    if (existing === null) {
      // Reserved but no sale: the competitor rolled back after all, or the
      // reservation belongs to something other than a completed checkout.
      // Refusing is the only safe answer — retrying could double-charge.
      return fail('idempotency-conflict');
    }
    const invoice = await deps.sales.invoiceForSale(scope, existing.id);
    return {
      outcome: 'success',
      replayed: true,
      sale: summarise(existing, invoice?.invoiceNumber ?? '', displayName),
    };
  }

  return {
    async checkout(input: CheckoutInput): Promise<CheckoutResult> {
      const scope: TenantScope = { tenantId: brandTenantId(input.principal.tenantId) };
      if (input.lines.length === 0) return fail('empty-cart');

      // A cash sale needs somewhere for the cash to go. The shift also supplies
      // the branch, so the client never names one.
      // Two lines for one product would each pass a stock check the sum fails.
      // Aggregating them silently would also change what the cashier sees, so
      // the request is refused and the client asked to send one line.
      const seen = new Set<string>();
      for (const line of input.lines) {
        if (seen.has(line.productId)) return fail('duplicate-line');
        seen.add(line.productId);
      }

      const shift = await deps.shifts.findOpenForTerminal(scope, input.terminalId);
      if (shift === null) return fail('no-open-shift');
      // The drawer belongs to one cashier. Ringing into somebody else's shift
      // makes their variance unanswerable at close.
      if (shift.userId !== input.principal.userId) return fail('shift-invalid');
      // A principal pinned to a branch may not transact through a till in
      // another one.
      if (input.principal.branchId !== null && input.principal.branchId !== shift.branchId) {
        return fail('shift-invalid');
      }

      const intentHash = fingerprintIntent({
        branchId: shift.branchId,
        terminalId: input.terminalId,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          quantityScaled: line.quantityScaled,
        })),
        cashReceivedMinor: input.cashReceivedMinor,
      });

      // Replay, before anything is computed or written.
      const reserved = await deps.idempotency.find(scope, IDEMPOTENCY_SCOPE, input.operationId);
      if (reserved !== null) {
        // The same key with a different basket is not a retry. Answering it
        // with the earlier sale would quietly drop a transaction the cashier
        // believes they rang up.
        if (reserved.requestHash !== intentHash) return fail('idempotency-conflict');
        const existing = await deps.sales.findByOperationId(scope, input.operationId);
        if (existing !== null) {
          const invoice = await deps.sales.invoiceForSale(scope, existing.id);
          return {
            outcome: 'success',
            replayed: true,
            sale: summarise(existing, invoice?.invoiceNumber ?? '', input.principal.displayName),
          };
        }
      }

      const tenant = await deps.tenants.current(scope);
      const settings = await deps.tenants.settings(scope);
      if (tenant === null || settings === null) {
        return fail('tenant-misconfigured', 'إعدادات المنشأة غير مكتملة.');
      }

      // Prices come from here and nowhere else.
      const loaded: { product: Product; scaled: bigint }[] = [];
      for (const line of input.lines) {
        const product = await deps.products.findById(scope, line.productId);
        if (product === null) return fail('unknown-product');
        if (!product.isActive) return fail('product-unavailable');

        let scaled: bigint;
        try {
          scaled = quantity(BigInt(line.quantityScaled));
        } catch {
          return fail('invalid-quantity');
        }
        if (scaled <= 0n) return fail('invalid-quantity');
        // A unit product cannot be sold in thirds. The scale is 1000, so a
        // whole unit is a multiple of it.
        if (product.productType === 'unit' && scaled % 1_000n !== 0n) {
          return fail('invalid-quantity');
        }
        loaded.push({ product, scaled });
      }

      // Stock, before the money is touched. Selling what is not there is a
      // decision the merchant makes in settings, not one the till makes.
      if (!settings.allowNegativeStock) {
        for (const entry of loaded) {
          if (!entry.product.trackInventory) continue;
          const balance = await deps.inventory.balance(scope, shift.branchId, entry.product.id);
          const available = balance === null ? 0n : BigInt(balance.quantityScaled);
          if (available < entry.scaled) return fail('insufficient-stock');
        }
      }

      const currency: Currency = 'SAR';
      const cart = {
        priceMode: settings.priceMode as PriceMode,
        currency,
        lines: loaded.map((entry, index): CartLineInput => ({
          lineId: String(index + 1),
          productId: entry.product.id,
          sku: entry.product.sku,
          nameAr: entry.product.nameAr,
          nameEn: entry.product.nameEn,
          unitPrice: money(BigInt(entry.product.priceMinor), currency),
          quantity: quantity(entry.scaled),
          vatRate: basisPoints(entry.product.vatBasisPoints),
          isWeighted: entry.product.productType === 'weighted',
        })),
      };

      const saleId = newId();
      const issuedAt = now().toISOString();
      let finalized;
      try {
        finalized = finalizeSale({
          saleId,
          operationId: input.operationId,
          tenantId: input.principal.tenantId,
          branchId: shift.branchId,
          terminalId: input.terminalId,
          shiftId: shift.id,
          cashierId: input.principal.userId,
          customerId: null,
          cart,
          tenders: [{ kind: 'cash', amount: money(BigInt(input.cashReceivedMinor), currency) }],
          issuedAt,
          // The ceiling comes from the roles the database granted, never from
          // the request. No discount is offered in this strike; passing the
          // real figure keeps the guard live for when one is.
          maxDiscountBasisPoints: maxDiscountForRoles(input.principal.roles),
        });
      } catch (error) {
        if (error instanceof UnderpaidError) return fail('insufficient-cash');
        if (error instanceof NonCashChangeError) return fail('insufficient-cash');
        if (error instanceof InvalidAmountError) return fail('invalid-quantity');
        throw error;
      }

      // Belt and braces over the domain's own arithmetic: a sale that does not
      // reconcile must never reach a customer, and the database CHECK that also
      // says so is not a good place to find out.
      if (!saleReconciles(finalized)) {
        throw new Error('The finalized sale does not reconcile; refusing to persist it.');
      }

      const priced = finalized.priced;
      let recorded;
      try {
        recorded = await deps.sales.record(scope, {
          sale: {
            id: saleId,
            branchId: shift.branchId,
            terminalId: input.terminalId,
            shiftId: shift.id,
            userId: input.principal.userId,
            customerId: null,
            operationId: input.operationId,
            status: 'finalized',
            priceMode: cart.priceMode,
            currency,
            grossMinor: priced.gross.minor.toString(),
            lineDiscountMinor: priced.lineDiscountTotal.minor.toString(),
            basketDiscountMinor: priced.basketDiscountTotal.minor.toString(),
            netMinor: priced.net.minor.toString(),
            vatMinor: priced.vat.minor.toString(),
            totalMinor: priced.total.minor.toString(),
            tenderedMinor: finalized.settlement.tendered.minor.toString(),
            changeMinor: finalized.settlement.change.minor.toString(),
            issuedAt,
            lines: priced.lines.map((line, index) => ({
              id: newId(),
              lineNumber: index + 1,
              productId: line.productId,
              sku: line.sku,
              nameAr: line.nameAr,
              nameEn: line.nameEn,
              unitPriceMinor: line.unitPrice.minor.toString(),
              vatBasisPoints: line.vatRate,
              quantityScaled: line.quantity.toString(),
              grossMinor: line.gross.minor.toString(),
              lineDiscountMinor: line.lineDiscount.minor.toString(),
              basketDiscountMinor: line.basketDiscount.minor.toString(),
              netMinor: line.net.minor.toString(),
              vatMinor: line.vat.minor.toString(),
              totalMinor: line.total.minor.toString(),
            })),
            discounts: [],
            tenders: [
              {
                id: newId(),
                kind: 'cash',
                amountMinor: finalized.settlement.tendered.minor.toString(),
                changeMinor: finalized.settlement.change.minor.toString(),
                reference: null,
              },
            ],
          },
          invoice: {
            id: newId(),
            saleId,
            invoiceType: 'simplified',
            sellerName: tenant.name,
            sellerVatNumber: tenant.vatNumber ?? '',
            buyerName: null,
            buyerVatNumber: null,
            netMinor: priced.net.minor.toString(),
            vatMinor: priced.vat.minor.toString(),
            totalMinor: priced.total.minor.toString(),
            currency,
            issuedAt,
            taxBreakdown: priced.vatBreakdown.map((bucket) => ({
              vatBasisPoints: bucket.rate,
              netMinor: bucket.net.minor.toString(),
              vatMinor: bucket.vat.minor.toString(),
            })),
          },
          inventory: loaded
            .filter((entry) => entry.product.trackInventory)
            .map((entry): InventoryMovementInput => ({
              id: newId(),
              branchId: shift.branchId,
              productId: entry.product.id,
              kind: 'sale',
              // Negative: stock leaves the shelf.
              quantityScaled: (-entry.scaled).toString(),
              reason: null,
              sourceType: 'sale',
              sourceId: saleId,
              actorUserId: input.principal.userId,
              occurredAt: issuedAt,
            })),
          cashMovement: {
            id: newId(),
            shiftId: shift.id,
            kind: 'sale',
            // What the drawer gained: the sale total, not what was handed over.
            amountMinor: priced.total.minor.toString(),
            reason: null,
            actorUserId: input.principal.userId,
            occurredAt: issuedAt,
          },
          idempotency: {
            id: newId(),
            scope: IDEMPOTENCY_SCOPE,
            operationId: input.operationId,
            requestHash: intentHash,
          },
        });
      } catch (error) {
        // The database is the authority on all three of these, because all
        // three are races a prior read cannot settle. Each rolls the whole
        // transaction back; none of them reaches the client as a driver error.
        if (error instanceof InsufficientStockError) return fail('insufficient-stock');
        if (error instanceof ShiftUnusableError) return fail('shift-invalid');
        if (error instanceof OperationAlreadyRecordedError) {
          // A competing transaction owned this operation id and has now
          // committed — ON CONFLICT DO NOTHING waited for it. Read what it
          // produced and answer as a replay, or as a conflict if its intent
          // differed.
          return resolveCompetingOperation(scope, input, intentHash, input.principal.displayName);
        }
        throw error;
      }

      const invoice = await deps.sales.invoiceForSale(scope, recorded.id);

      // Outside the transaction, and its failure does not undo the sale: the
      // money has moved and the receipt is printed by the time this runs.
      try {
        await deps.audit.append(scope, {
          id: newId(),
          actorUserId: input.principal.userId,
          branchId: shift.branchId,
          terminalId: input.terminalId,
          eventType: 'sale.completed',
          entityType: 'sale',
          entityId: recorded.id,
          metadata: {
            sequence: recorded.sequence,
            total: moneyToMajorString(priced.total),
            lines: recorded.lines.length,
          },
          occurredAt: issuedAt,
        });
      } catch (error) {
        onAuditError(error);
      }

      return {
        outcome: 'success',
        replayed: false,
        sale: summarise(recorded, invoice?.invoiceNumber ?? '', input.principal.displayName),
      };
    },
  };
}
EOF

say "API — request validation"

cat << 'EOF' > apps/api/src/routes/validation.ts
import { z } from 'zod';

/**
 * Bounds, in one place.
 *
 * Every one of these exists because its absence is a denial of service: an
 * unbounded page size is the whole catalogue serialised on one request, an
 * unbounded line count is a transaction that never commits, and an unbounded
 * search term is a scan per keystroke.
 */
export const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'not a uuid');

/** Halalas as a decimal string. Never a number: JSON floats lose halalas. */
export const MINOR = z.string().regex(/^(0|[1-9][0-9]{0,14})$/, 'not an integer amount');

/** Scaled by 1000. Same reasoning, and the same refusal to accept a float. */
export const SCALED_QUANTITY = z
  .string()
  .regex(/^[1-9][0-9]{0,11}$/, 'not a positive scaled quantity');

export const MAX_PAGE_SIZE = 50;
export const MAX_CART_LINES = 200;

export const productQuery = z.object({
  q: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

export const currentShiftQuery = z.object({ terminalId: UUID });

export const openShiftBody = z.object({
  terminalId: UUID,
  openingFloatMinor: MINOR,
});

export const checkoutBody = z.object({
  operationId: UUID,
  terminalId: UUID,
  cashReceivedMinor: MINOR,
  lines: z
    .array(z.object({ productId: UUID, quantityScaled: SCALED_QUANTITY }))
    .min(1)
    .max(MAX_CART_LINES)
    // Two lines for one product would each pass a stock check their sum fails.
    // One line per product, with the quantity summed by the client.
    .refine(
      (lines) => new Set(lines.map((line) => line.productId)).size === lines.length,
      { message: 'duplicate product line' },
    ),
});

/**
 * The fields a client may never send.
 *
 * Rejected rather than ignored. Silently dropping `unitPrice` would let a
 * client believe it had set one, and the first person to notice would be an
 * auditor comparing a receipt to a database row.
 */
export const FORBIDDEN_FIELDS = [
  'tenantId',
  'userId',
  'cashierId',
  'branchId',
  'unitPrice',
  'unitPriceMinor',
  'subtotal',
  'netMinor',
  'vatMinor',
  'totalMinor',
  'changeMinor',
  'sequence',
  'invoiceNumber',
  'role',
  'roles',
  'permissions',
  'maxDiscountBasisPoints',
  'discount',
] as const;

export function namesForbiddenField(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(body, field)) return field;
  }
  return null;
}
EOF

say "API — product, shift and sale routes"

cat << 'EOF' > apps/api/src/routes/business.ts
import { tenantId as brandTenantId } from '@korvi/domain';
import { ShiftOpenRefusedError } from '@korvi/database';
import {
  checkoutBody,
  currentShiftQuery,
  namesForbiddenField,
  openShiftBody,
  productQuery,
} from './validation.js';
import type { CheckoutFailureReason, CheckoutService } from '../checkout/service.js';
import type { Guards } from '../auth/guards.js';
import type {
  AuthenticatedPrincipal,
  ProductRepository,
  ShiftRepository,
  TenantScope,
  TerminalRepository,
} from '@korvi/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The cashier's server surface. Four routes, and nothing a till does not need.
 *
 * Every one of them derives the tenant from `request.auth`, which the session
 * guard filled in from the database. There is no route on which a tenant id,
 * a user id, a role or a price can arrive from the client and be believed.
 */

export interface BusinessDeps {
  readonly products: ProductRepository;
  readonly shifts: ShiftRepository;
  readonly terminals: TerminalRepository;
  readonly checkout: CheckoutService;
}

export interface BusinessRouteOptions {
  readonly deps: BusinessDeps;
  readonly guards: Guards;
  readonly newId: () => string;
}

/**
 * Arabic, because the person reading it is standing at a till.
 *
 * Each one says what to do next and nothing about why the server thinks so:
 * "المنتج غير متوفر" is actionable, and the stock figure that produced it is
 * not the customer's business.
 */
const MESSAGES: Readonly<Record<CheckoutFailureReason, string>> = {
  'empty-cart': 'لا توجد أصناف في السلة.',
  'no-open-shift': 'لا توجد وردية مفتوحة على هذا الصندوق. افتح وردية أولاً.',
  'unknown-product': 'أحد الأصناف غير موجود.',
  'product-unavailable': 'أحد الأصناف لم يعد متاحاً للبيع.',
  'invalid-quantity': 'الكمية غير صالحة لهذا الصنف.',
  'insufficient-stock': 'الكمية المطلوبة غير متوفرة في المخزون.',
  'insufficient-cash': 'المبلغ المستلم أقل من المطلوب.',
  'idempotency-conflict': 'طلب سابق بنفس المعرّف يحمل محتوى مختلفاً.',
  'duplicate-line': 'الصنف مكرر في السلة. ادمج الكمية في سطر واحد.',
  'shift-invalid': 'الوردية لم تعد صالحة لهذا الصندوق. تحقّق من الوردية.',
  'tenant-misconfigured': 'إعدادات المنشأة غير مكتملة.',
};

/** 409 for the two states a retry can resolve; 422 for a request that cannot. */
const STATUS: Readonly<Record<CheckoutFailureReason, number>> = {
  'empty-cart': 422,
  'no-open-shift': 409,
  'unknown-product': 422,
  'product-unavailable': 409,
  'invalid-quantity': 422,
  'insufficient-stock': 409,
  'insufficient-cash': 422,
  'idempotency-conflict': 409,
  'duplicate-line': 422,
  'shift-invalid': 409,
  'tenant-misconfigured': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

export function registerBusinessRoutes(app: FastifyInstance, options: BusinessRouteOptions): void {
  const { deps, guards, newId } = options;

  app.get(
    '/v1/products',
    { preHandler: [guards.requireSession, guards.requirePermission('product.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const parsed = productQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const scope = scopeOf(principal);
      const term = (parsed.data.q ?? '').trim();
      const products =
        term === ''
          ? await deps.products.list(scope, parsed.data.limit)
          : await deps.products.search(scope, { term, limit: parsed.data.limit });

      // Listing is not filtered by the repository, so an inactive product that
      // is no longer sellable is dropped here rather than offered to a cashier.
      const sellable = products.filter((product) => product.isActive);
      return reply.code(200).send({
        products: sellable.map((product) => ({
          id: product.id,
          sku: product.sku,
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          productType: product.productType,
          unitLabel: product.unitLabel,
          priceMinor: product.priceMinor,
          vatBasisPoints: Number(product.vatBasisPoints),
          primaryBarcode: product.primaryBarcode,
          trackInventory: product.trackInventory,
        })),
        limit: parsed.data.limit,
      });
    },
  );

  app.get(
    '/v1/shifts/current',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.open')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const parsed = currentShiftQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const shift = await deps.shifts.findOpenForTerminal(scopeOf(principal), parsed.data.terminalId);
      if (shift === null) return reply.code(200).send({ shift: null });

      return reply.code(200).send({
        shift: {
          id: shift.id,
          branchId: shift.branchId,
          terminalId: shift.terminalId,
          userId: shift.userId,
          status: shift.status,
          openingFloatMinor: shift.openingFloatMinor,
          openedAt: shift.openedAt,
        },
      });
    },
  );

  app.post(
    '/v1/shifts/open',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.open')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      const parsed = openShiftBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const scope = scopeOf(principal);
      // The branch comes from the terminal, not from the request: a till is
      // physically in one branch and the client has no standing to say which.
      const terminal = await deps.terminals.findById(scope, parsed.data.terminalId);
      if (terminal === null || !terminal.isActive) {
        return reply.code(404).send({ error: 'unknown_terminal', message: 'الصندوق غير معروف.' });
      }

      const openedAt = new Date().toISOString();
      let shift;
      try {
        // The repository takes the terminal row's lock and re-checks for an
        // open shift while holding it, so two cashiers pressing this at the
        // same moment serialise rather than both succeeding.
        shift = await deps.shifts.open(scope, {
          id: newId(),
          branchId: terminal.branchId,
          terminalId: terminal.id,
          // The person opening the shift is whoever the session says it is.
          userId: principal.userId,
          openingFloatMinor: parsed.data.openingFloatMinor,
          openedAt,
          openingMovementId: newId(),
        });
      } catch (error) {
        if (error instanceof ShiftOpenRefusedError) {
          if (error.detail === 'already-open') {
            return reply.code(409).send({
              error: 'shift_already_open',
              message: 'توجد وردية مفتوحة على هذا الصندوق.',
            });
          }
          return reply.code(404).send({ error: 'unknown_terminal', message: 'الصندوق غير معروف.' });
        }
        throw error;
      }

      return reply.code(201).send({
        shift: {
          id: shift.id,
          branchId: shift.branchId,
          terminalId: shift.terminalId,
          userId: shift.userId,
          status: shift.status,
          openingFloatMinor: shift.openingFloatMinor,
          openedAt: shift.openedAt,
        },
      });
    },
  );

  app.post(
    '/v1/sales',
    { preHandler: [guards.requireSession, guards.requirePermission('sale.create')] },
    async (request, reply: FastifyReply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      // Rejected rather than ignored. A client that thinks it set the price
      // should be told it cannot, not left to discover it from an auditor.
      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      const parsed = checkoutBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await deps.checkout.checkout({
        principal,
        operationId: parsed.data.operationId,
        terminalId: parsed.data.terminalId,
        cashReceivedMinor: parsed.data.cashReceivedMinor,
        lines: parsed.data.lines,
      });

      if (result.outcome === 'failure') {
        request.log.info({ reason: result.reason }, 'checkout refused');
        return reply
          .code(STATUS[result.reason])
          .send({ error: result.reason, message: result.detail ?? MESSAGES[result.reason] });
      }

      // 200 rather than 201 on a replay: nothing was created this time.
      return reply.code(result.replayed ? 200 : 201).send({ sale: result.sale, replayed: result.replayed });
    },
  );
}
EOF

say "API — wiring"

python3 - <<'PY'
import sys
path = 'apps/api/src/server.ts'
s = open(path, encoding='utf-8').read()

if 'registerBusinessRoutes' in s:
    print('  already wired'); sys.exit(0)

s = s.replace(
    """import { createAuthRepository, createAuditRepository, createPrismaClient } from '@korvi/database';""",
    """import {
  createAuditRepository,
  createAuthRepository,
  createCustomerRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createSaleRepository,
  createShiftRepository,
  createTenantRepository,
  createTerminalRepository,
} from '@korvi/database';""",
    1,
)
s = s.replace(
    """import { createGuards } from './auth/guards.js';""",
    """import { newId } from '@korvi/domain';
import { createGuards } from './auth/guards.js';
import { createCheckoutService } from './checkout/service.js';
import { registerBusinessRoutes } from './routes/business.js';""",
    1,
)
s = s.replace("""import Fastify from 'fastify';
import { newId } from '@korvi/domain';""", """import Fastify from 'fastify';""", 1)
s = s.replace(
    """import type { AuthService } from './auth/service.js';""",
    """import type { AuthService } from './auth/service.js';
import type { BusinessDeps } from './routes/business.js';""",
    1,
)

s = s.replace(
    """export interface ServerDeps {""",
    """export interface ServerDeps {
  /**
   * The cashier's repositories and checkout pipeline.
   *
   * Supplied by tests with in-memory implementations; built from DATABASE_URL
   * on first use otherwise, for the same reason `auth` is.
   */
  readonly business?: BusinessDeps;""",
    1,
)

old = """  const service = deps.auth ?? lazyAuthService(config);
  const guards = createGuards(service, config);"""
new = """  const service = deps.auth ?? lazyAuthService(config);
  const guards = createGuards(service, config);
  const business = deps.business ?? lazyBusinessDeps(config);"""
assert old in s
s = s.replace(old, new, 1)

old = """  registerHealthRoutes(app);
  registerAuthRoutes(app, { service, guards, config });
  return app;"""
new = """  registerHealthRoutes(app);
  registerAuthRoutes(app, { service, guards, config });
  registerBusinessRoutes(app, { deps: business, guards, newId });
  return app;"""
assert old in s
s = s.replace(old, new, 1)

LAZY = '''
/**
 * The cashier's persistence, built once, on first use.
 *
 * Same shape as the auth service above and for the same reason: a process that
 * only answers /health should not open a connection, and a missing
 * DATABASE_URL is an operator's problem reported as 503 rather than a
 * credential failure.
 */
function lazyBusinessDeps(config: ApiConfig): BusinessDeps {
  let built: BusinessDeps | null = null;

  const resolve = (): BusinessDeps => {
    if (built !== null) return built;
    const url = config.DATABASE_URL;
    if (url === undefined) throw new AuthUnavailableError('DATABASE_URL is not configured.');
    const prisma = createPrismaClient(url);
    const products = createProductRepository(prisma);
    const shifts = createShiftRepository(prisma);
    const terminals = createTerminalRepository(prisma);
    built = {
      products,
      shifts,
      terminals,
      checkout: createCheckoutService({
        tenants: createTenantRepository(prisma),
        products,
        inventory: createInventoryRepository(prisma),
        shifts,
        sales: createSaleRepository(prisma),
        idempotency: createIdempotencyRepository(prisma),
        audit: createAuditRepository(prisma),
      }),
    };
    return built;
  };

  return {
    products: {
      findById: (scope, id) => resolve().products.findById(scope, id),
      findBySku: (scope, sku) => resolve().products.findBySku(scope, sku),
      findByBarcode: (scope, barcode) => resolve().products.findByBarcode(scope, barcode),
      search: (scope, query) => resolve().products.search(scope, query),
      list: (scope, limit) => resolve().products.list(scope, limit),
    },
    shifts: {
      findById: (scope, id) => resolve().shifts.findById(scope, id),
      findOpenForTerminal: (scope, terminalId) =>
        resolve().shifts.findOpenForTerminal(scope, terminalId),
      open: (scope, input) => resolve().shifts.open(scope, input),
      recordCashMovement: (scope, movement) => resolve().shifts.recordCashMovement(scope, movement),
      close: (scope, input) => resolve().shifts.close(scope, input),
    },
    terminals: {
      findById: (scope, id) => resolve().terminals.findById(scope, id),
      findByCode: (scope, code) => resolve().terminals.findByCode(scope, code),
      listForBranch: (scope, branchId) => resolve().terminals.listForBranch(scope, branchId),
      markSeen: (scope, id, at) => resolve().terminals.markSeen(scope, id, at),
    },
    checkout: { checkout: (input) => resolve().checkout.checkout(input) },
  };
}
'''

anchor = "export function buildServer("
assert anchor in s
s = s.replace(anchor, LAZY.lstrip('\n') + '\n' + anchor, 1)

# createCustomerRepository is imported for completeness of the barrel check but
# not used; drop it rather than leave an unused import.
s = s.replace("  createCustomerRepository,\n", "", 1)
open(path, 'w', encoding='utf-8').write(s)
print('  server wired')
PY

say "Tests — in-memory cashier persistence"

cat << 'EOF' > apps/api/src/__tests__/support/memory-business.ts
import { basisPoints, tenantId as brandTenantId } from '@korvi/domain';
import {
  InsufficientStockError,
  OperationAlreadyRecordedError,
  ShiftOpenRefusedError,
  ShiftUnusableError,
} from '@korvi/database';
import type {
  AuditEventInput,
  AuditRepository,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyRepository,
  InventoryBalance,
  InventoryMovementInput,
  InventoryRepository,
  OpenShiftInput,
  Product,
  ProductRepository,
  ProductSearchQuery,
  RecordSaleInput,
  SaleRecord,
  SaleRepository,
  ShiftRecord,
  ShiftRepository,
  Tenant,
  TenantRepository,
  TenantScope,
  TenantSettings,
  Terminal,
  TerminalRepository,
  InvoiceRecord,
} from '@korvi/domain';

/**
 * The cashier's persistence, in memory.
 *
 * It mirrors the two properties of the real adapters that the checkout pipeline
 * depends on and that a looser fake would quietly hide: every read is filtered
 * by the scope's tenant, and `record` is all-or-nothing. A fake that ignored
 * either would make the isolation and atomicity tests pass for the wrong reason.
 *
 * The receipt number is allocated inside `record`, exactly as the adapter does
 * it, because the pipeline is not allowed to supply one.
 */

export interface MemoryProduct extends Product {
  branchStock: Record<string, string>;
}

export class MemoryBusinessStore {
  public tenants: Tenant[] = [];
  public settings: TenantSettings[] = [];
  public terminals: Terminal[] = [];
  public shifts: ShiftRecord[] = [];
  public products: MemoryProduct[] = [];
  public sales: SaleRecord[] = [];
  public invoices: InvoiceRecord[] = [];
  public movements: (InventoryMovementInput & { tenantId: string })[] = [];
  public keys: IdempotencyRecord[] = [];
  public audit: AuditEventInput[] = [];
  /** Set to make the persisting transaction fail after it has begun. */
  public recordFails = false;
}

function scopeId(scope: TenantScope): string {
  return scope.tenantId as string;
}

export function memoryTenantRepository(store: MemoryBusinessStore): TenantRepository {
  return {
    current: (scope) =>
      Promise.resolve(store.tenants.find((t) => (t.id as string) === scopeId(scope)) ?? null),
    settings: (scope) =>
      Promise.resolve(
        store.settings.find((s) => (s.tenantId as string) === scopeId(scope)) ?? null,
      ),
  };
}

export function memoryTerminalRepository(store: MemoryBusinessStore): TerminalRepository {
  const mine = (scope: TenantScope): Terminal[] =>
    store.terminals.filter((t) => (t.tenantId as string) === scopeId(scope));
  return {
    findById: (scope, id) => Promise.resolve(mine(scope).find((t) => t.id === id) ?? null),
    findByCode: (scope, code) => Promise.resolve(mine(scope).find((t) => t.code === code) ?? null),
    listForBranch: (scope, branchId) =>
      Promise.resolve(mine(scope).filter((t) => t.branchId === branchId)),
    markSeen: () => Promise.resolve(),
  };
}

export function memoryProductRepository(store: MemoryBusinessStore): ProductRepository {
  const mine = (scope: TenantScope): MemoryProduct[] =>
    store.products.filter((p) => (p.tenantId as string) === scopeId(scope));
  return {
    findById: (scope, id) => Promise.resolve(mine(scope).find((p) => p.id === id) ?? null),
    findBySku: (scope, sku) => Promise.resolve(mine(scope).find((p) => p.sku === sku) ?? null),
    findByBarcode: (scope, barcode) =>
      Promise.resolve(mine(scope).find((p) => p.barcodes.includes(barcode)) ?? null),
    search: (scope, query: ProductSearchQuery) => {
      const term = query.term.trim();
      const exact = mine(scope).find(
        (p) => p.isActive && (p.sku === term || p.barcodes.includes(term)),
      );
      if (/^[0-9]{6,14}$/.test(term) && exact !== undefined) return Promise.resolve([exact]);
      return Promise.resolve(
        mine(scope)
          .filter(
            (p) =>
              p.isActive &&
              (p.nameAr.startsWith(term) ||
                (p.nameEn ?? '').toLowerCase().startsWith(term.toLowerCase()) ||
                p.sku.toLowerCase().startsWith(term.toLowerCase()) ||
                p.barcodes.some((code) => code.startsWith(term))),
          )
          .slice(0, query.limit),
      );
    },
    list: (scope, limit) => Promise.resolve(mine(scope).slice(0, limit)),
  };
}

export function memoryInventoryRepository(store: MemoryBusinessStore): InventoryRepository {
  return {
    balance: (scope, branchId, productId) => {
      const product = store.products.find(
        (p) => (p.tenantId as string) === scopeId(scope) && p.id === productId,
      );
      const scaled = product?.branchStock[branchId];
      return Promise.resolve(
        scaled === undefined
          ? null
          : ({
              tenantId: brandTenantId(scopeId(scope)),
              branchId,
              productId,
              quantityScaled: scaled,
            } satisfies InventoryBalance),
      );
    },
    listBalances: () => Promise.resolve([]),
    applyMovement: (scope, movement) => {
      store.movements.push({ ...movement, tenantId: scopeId(scope) });
      return Promise.resolve({
        tenantId: brandTenantId(scopeId(scope)),
        branchId: movement.branchId,
        productId: movement.productId,
        quantityScaled: movement.quantityScaled,
      });
    },
  };
}

export function memoryShiftRepository(store: MemoryBusinessStore): ShiftRepository {
  const mine = (scope: TenantScope): ShiftRecord[] =>
    store.shifts.filter((s) => (s.tenantId as string) === scopeId(scope));
  return {
    findById: (scope, id) => Promise.resolve(mine(scope).find((s) => s.id === id) ?? null),
    findOpenForTerminal: (scope, terminalId) =>
      Promise.resolve(
        mine(scope).find((s) => s.terminalId === terminalId && s.status === 'open') ?? null,
      ),
    open: (scope, input: OpenShiftInput) => {
      const terminal = store.terminals.find(
        (t) => (t.tenantId as string) === scopeId(scope) && t.id === input.terminalId,
      );
      if (terminal === undefined || !terminal.isActive) {
        return Promise.reject(new ShiftOpenRefusedError('unknown-terminal'));
      }
      if (mine(scope).some((s) => s.terminalId === input.terminalId && s.status === 'open')) {
        return Promise.reject(new ShiftOpenRefusedError('already-open'));
      }
      const shift: ShiftRecord = {
        id: input.id,
        tenantId: brandTenantId(scopeId(scope)),
        branchId: input.branchId,
        terminalId: input.terminalId,
        userId: input.userId,
        status: 'open',
        openingFloatMinor: input.openingFloatMinor,
        declaredCashMinor: null,
        expectedCashMinor: null,
        varianceMinor: null,
        openedAt: input.openedAt,
        closedAt: null,
        movements: [],
      };
      store.shifts.push(shift);
      return Promise.resolve(shift);
    },
    recordCashMovement: () => Promise.resolve(),
    close: (scope, input) => {
      const shift = mine(scope).find((s) => s.id === input.shiftId);
      if (shift === undefined) throw new Error('no such shift');
      return Promise.resolve({ ...shift, status: 'closed' });
    },
  };
}

export function memorySaleRepository(store: MemoryBusinessStore): SaleRepository {
  const mine = (scope: TenantScope): SaleRecord[] =>
    store.sales.filter((s) => (s.tenantId as string) === scopeId(scope));

  return {
    findById: (scope, id) => Promise.resolve(mine(scope).find((s) => s.id === id) ?? null),
    findByOperationId: (scope, operationId) =>
      Promise.resolve(mine(scope).find((s) => s.operationId === operationId) ?? null),
    invoiceForSale: (scope, saleId) =>
      Promise.resolve(
        store.invoices.find(
          (i) => (i.tenantId as string) === scopeId(scope) && i.saleId === saleId,
        ) ?? null,
      ),
    record: (scope, input: RecordSaleInput) => {
      // All or nothing, like the transaction it stands in for. Everything is
      // staged and only appended once every step has succeeded, and the three
      // guards the real transaction holds are checked in the same order.
      if (store.recordFails) return Promise.reject(new Error('persistence failed'));

      const tenant = scopeId(scope);

      const shift = store.shifts.find(
        (s) => (s.tenantId as string) === tenant && s.id === input.sale.shiftId,
      );
      if (shift === undefined) return Promise.reject(new ShiftUnusableError('unknown-shift'));
      if (shift.status !== 'open') return Promise.reject(new ShiftUnusableError('shift-closed'));
      if (shift.terminalId !== input.sale.terminalId) {
        return Promise.reject(new ShiftUnusableError('terminal-mismatch'));
      }
      if (shift.branchId !== input.sale.branchId) {
        return Promise.reject(new ShiftUnusableError('branch-mismatch'));
      }
      if (shift.userId !== input.sale.userId) {
        return Promise.reject(new ShiftUnusableError('cashier-mismatch'));
      }

      const allowNegativeStock =
        store.settings.find((s) => (s.tenantId as string) === tenant)?.allowNegativeStock ?? false;
      if (!allowNegativeStock) {
        // The guard lives here, with the write, exactly as the guarded UPDATE
        // does. A fake that checked earlier would hide the race it stands for.
        for (const movement of input.inventory) {
          const product = store.products.find((prod) => prod.id === movement.productId);
          const held = product?.branchStock[movement.branchId];
          if (held === undefined) continue;
          if (BigInt(held) + BigInt(movement.quantityScaled) < 0n) {
            return Promise.reject(new InsufficientStockError('would go below zero'));
          }
        }
      }
      const branchSales = store.sales.filter(
        (s) => (s.tenantId as string) === tenant && s.branchId === input.sale.branchId,
      );
      const sequence = branchSales.reduce((max, s) => Math.max(max, s.sequence), 0) + 1;
      const invoiceNumber = `01-${String(sequence).padStart(6, '0')}`;

      if (
        store.keys.some(
          (k) =>
            (k.tenantId as string) === tenant &&
            k.scope === input.idempotency.scope &&
            k.operationId === input.idempotency.operationId,
        )
      ) {
        // What ON CONFLICT DO NOTHING reports once the competitor has
        // committed: a defined outcome, not a raw constraint violation.
        return Promise.reject(new OperationAlreadyRecordedError(input.idempotency.operationId));
      }

      const sale: SaleRecord = {
        ...input.sale,
        tenantId: brandTenantId(tenant),
        sequence,
      };
      const invoice: InvoiceRecord = {
        ...input.invoice,
        tenantId: brandTenantId(tenant),
        invoiceNumber,
      };

      store.sales.push(sale);
      store.invoices.push(invoice);
      for (const movement of input.inventory) {
        store.movements.push({ ...movement, tenantId: tenant });
        const product = store.products.find((p) => p.id === movement.productId);
        const held = product?.branchStock[movement.branchId];
        if (product !== undefined && held !== undefined) {
          product.branchStock[movement.branchId] = (
            BigInt(held) + BigInt(movement.quantityScaled)
          ).toString();
        }
      }
      store.keys.push({
        id: input.idempotency.id,
        tenantId: brandTenantId(tenant),
        scope: input.idempotency.scope,
        operationId: input.idempotency.operationId,
        status: 'completed',
        resultType: 'sale',
        resultId: sale.id,
        requestHash: input.idempotency.requestHash,
        completedAt: input.sale.issuedAt,
      });
      return Promise.resolve(sale);
    },
  };
}

export function memoryIdempotencyRepository(store: MemoryBusinessStore): IdempotencyRepository {
  return {
    find: (scope, scopeKey, operationId) =>
      Promise.resolve(
        store.keys.find(
          (k) =>
            (k.tenantId as string) === scopeId(scope) &&
            k.scope === scopeKey &&
            k.operationId === operationId,
        ) ?? null,
      ),
    reserve: (scope, reservation: IdempotencyReservation) => {
      const record: IdempotencyRecord = {
        ...reservation,
        tenantId: brandTenantId(scopeId(scope)),
        status: 'reserved',
        resultType: null,
        resultId: null,
        completedAt: null,
      };
      store.keys.push(record);
      return Promise.resolve(record);
    },
    complete: () => Promise.resolve(),
  };
}

export function memoryAuditRepository(store: MemoryBusinessStore): AuditRepository {
  return {
    append: (_scope, event) => {
      store.audit.push(event);
      return Promise.resolve();
    },
    list: () => Promise.resolve(store.audit),
  };
}

/** A tenant, a till, an open shift and two products — the minimum for a sale. */
export interface Fixture {
  readonly tenant: string;
  readonly branch: string;
  readonly terminal: string;
  readonly shift: string;
  readonly user: string;
  readonly milk: string;
  readonly rice: string;
}

export function seedStore(store: MemoryBusinessStore, f: Fixture, openShift = true): void {
  store.tenants.push({
    id: brandTenantId(f.tenant),
    slug: `t-${f.tenant.slice(-4)}`,
    name: 'متجر كورفي',
    status: 'active',
    vatNumber: '300000000000003',
  });
  store.settings.push({
    tenantId: brandTenantId(f.tenant),
    vertical: 'retail',
    priceMode: 'tax-inclusive',
    defaultVatBasisPoints: basisPoints(1500),
    currency: 'SAR',
    requireBarcode: true,
    allowWeightedItems: true,
    trackInventory: true,
    allowNegativeStock: false,
    receiptHeaderAr: null,
    receiptFooterAr: null,
  });
  store.terminals.push({
    id: f.terminal,
    tenantId: brandTenantId(f.tenant),
    branchId: f.branch,
    code: '01',
    label: 'صندوق ١',
    isActive: true,
    lastSeenAt: null,
  });
  if (openShift) {
    store.shifts.push({
      id: f.shift,
      tenantId: brandTenantId(f.tenant),
      branchId: f.branch,
      terminalId: f.terminal,
      userId: f.user,
      status: 'open',
      openingFloatMinor: '20000',
      declaredCashMinor: null,
      expectedCashMinor: null,
      varianceMinor: null,
      openedAt: '2026-08-12T06:00:00.000Z',
      closedAt: null,
      movements: [],
    });
  }
  store.products.push(
    {
      id: f.milk,
      tenantId: brandTenantId(f.tenant),
      categoryId: null,
      sku: 'MILK-1L',
      nameAr: 'حليب طازج',
      nameEn: 'Fresh milk',
      productType: 'unit',
      unitLabel: 'each',
      priceMinor: '1150',
      vatBasisPoints: basisPoints(1500),
      primaryBarcode: '6281000000001',
      barcodes: ['6281000000001'],
      trackInventory: true,
      isActive: true,
      branchStock: { [f.branch]: '10000' },
    },
    {
      id: f.rice,
      tenantId: brandTenantId(f.tenant),
      categoryId: null,
      sku: 'RICE-5K',
      nameAr: 'أرز بسمتي',
      nameEn: 'Basmati rice',
      productType: 'weighted',
      unitLabel: 'kg',
      priceMinor: '2400',
      vatBasisPoints: basisPoints(1500),
      primaryBarcode: '6281000000002',
      barcodes: ['6281000000002'],
      trackInventory: true,
      isActive: true,
      branchStock: { [f.branch]: '5000' },
    },
  );
}
EOF

say "Tests — the checkout pipeline"

cat << 'EOF' > apps/api/src/__tests__/checkout-service.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { createCheckoutService } from '../checkout/service.js';
import { fingerprintIntent } from '../checkout/fingerprint.js';
import {
  MemoryBusinessStore,
  memoryAuditRepository,
  memoryIdempotencyRepository,
  memoryInventoryRepository,
  memoryProductRepository,
  memorySaleRepository,
  memoryShiftRepository,
  memoryTenantRepository,
  seedStore,
} from './support/memory-business.js';
import type { CheckoutService } from '../checkout/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Fixture } from './support/memory-business.js';

const A: Fixture = {
  tenant: '018f1000-0000-7000-8000-00000000000a',
  branch: '018f1000-0000-7000-8000-0000000000a1',
  terminal: '018f1000-0000-7000-8000-0000000000a2',
  shift: '018f1000-0000-7000-8000-0000000000a3',
  user: '018f1000-0000-7000-8000-0000000000a4',
  milk: '018f1000-0000-7000-8000-0000000000a5',
  rice: '018f1000-0000-7000-8000-0000000000a6',
};

const OPERATION = '018f1000-0000-7000-8000-0000000000f1';

let store: MemoryBusinessStore;
let service: CheckoutService;
let counter: number;

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    tenantId: A.tenant,
    tenantSlug: 'korvi',
    userId: A.user,
    sessionId: '018f1000-0000-7000-8000-0000000000e1',
    email: 'sara@korvi.test',
    displayName: 'سارة',
    roles: ['cashier'],
    permissions: [...ROLE_PERMISSIONS.cashier],
    maxDiscountBasisPoints: 0n,
    branchId: A.branch,
    ...overrides,
  };
}

beforeEach(() => {
  store = new MemoryBusinessStore();
  seedStore(store, A);
  counter = 0;
  service = createCheckoutService({
    tenants: memoryTenantRepository(store),
    products: memoryProductRepository(store),
    inventory: memoryInventoryRepository(store),
    shifts: memoryShiftRepository(store),
    sales: memorySaleRepository(store),
    idempotency: memoryIdempotencyRepository(store),
    audit: memoryAuditRepository(store),
    now: () => new Date('2026-08-12T09:00:00.000Z'),
    newId: () => {
      counter += 1;
      return `018f1000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
    },
  });
});

function checkout(overrides: Partial<Parameters<CheckoutService['checkout']>[0]> = {}) {
  return service.checkout({
    principal: principal(),
    operationId: OPERATION,
    terminalId: A.terminal,
    cashReceivedMinor: '5000',
    lines: [{ productId: A.milk, quantityScaled: '2000' }],
    ...overrides,
  });
}

describe('a cash sale', () => {
  it('prices from persistence and returns exact figures', async () => {
    // Two litres of milk at 11.50 tax-inclusive: 23.00 total, of which
    // 3.00 is VAT at 15% and 20.00 is net. Cash 50.00, change 27.00.
    const result = await checkout();
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    expect(result.sale.totalMinor).toBe('2300');
    expect(result.sale.vatMinor).toBe('300');
    expect(result.sale.netMinor).toBe('2000');
    expect(result.sale.cashReceivedMinor).toBe('5000');
    expect(result.sale.changeMinor).toBe('2700');
    expect(result.replayed).toBe(false);
  });

  it('reconciles: net + vat = total, and the lines sum to it', async () => {
    const result = await checkout({
      lines: [
        { productId: A.milk, quantityScaled: '3000' },
        { productId: A.rice, quantityScaled: '1500' },
      ],
      cashReceivedMinor: '10000',
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const net = BigInt(result.sale.netMinor);
    const vat = BigInt(result.sale.vatMinor);
    const total = BigInt(result.sale.totalMinor);
    expect(net + vat).toBe(total);

    const lineTotals = result.sale.lines.reduce((sum, line) => sum + BigInt(line.totalMinor), 0n);
    expect(lineTotals).toBe(total);
    expect(BigInt(result.sale.cashReceivedMinor) - BigInt(result.sale.changeMinor)).toBe(total);
  });

  it('takes the unit price from the database, whatever the client believes', async () => {
    // The request carries no price at all — there is nowhere to put one.
    const result = await checkout();
    if (result.outcome !== 'success') throw new Error(result.reason);
    expect(result.sale.lines[0]?.unitPriceMinor).toBe('1150');

    // Replaced rather than mutated: a Product is readonly, which is the point.
    store.products[0] = { ...store.products[0]!, priceMinor: '1200' };
    const after = await checkout({ operationId: '018f1000-0000-7000-8000-0000000000f2' });
    if (after.outcome !== 'success') throw new Error(after.reason);
    expect(after.sale.lines[0]?.unitPriceMinor).toBe('1200');
  });

  it('allocates the receipt number and invoice number on the server', async () => {
    const first = await checkout();
    const second = await checkout({ operationId: '018f1000-0000-7000-8000-0000000000f2' });
    if (first.outcome !== 'success' || second.outcome !== 'success') throw new Error('expected two sales');

    expect(first.sale.sequence).toBe(1);
    expect(second.sale.sequence).toBe(2);
    expect(first.sale.invoiceNumber).toBe('01-000001');
    expect(second.sale.invoiceNumber).toBe('01-000002');
  });

  it('moves stock off the shelf', async () => {
    await checkout();
    const movement = store.movements.at(0);
    expect(movement?.kind).toBe('sale');
    expect(movement?.quantityScaled).toBe('-2000');
    expect(store.products[0]?.branchStock[A.branch]).toBe('8000');
  });

  it('records the sale in the audit trail without a secret', async () => {
    await checkout();
    const event = store.audit.find((entry) => entry.eventType === 'sale.completed');
    expect(event).toBeDefined();
    expect(JSON.stringify(event)).not.toContain('scrypt$');
    expect(JSON.stringify(event)).not.toContain('kps1.');
  });
});

describe('what a cash sale refuses', () => {
  it('refuses when the till has no open shift', async () => {
    store.shifts = [];
    const result = await checkout();
    expect(result.outcome === 'failure' && result.reason).toBe('no-open-shift');
  });

  it('refuses an empty cart', async () => {
    const result = await checkout({ lines: [] });
    expect(result.outcome === 'failure' && result.reason).toBe('empty-cart');
  });

  it('refuses cash that does not cover the total', async () => {
    const result = await checkout({ cashReceivedMinor: '2299' });
    expect(result.outcome === 'failure' && result.reason).toBe('insufficient-cash');
  });

  it('accepts cash that covers it exactly, with no change', async () => {
    const result = await checkout({ cashReceivedMinor: '2300' });
    if (result.outcome !== 'success') throw new Error(result.reason);
    expect(result.sale.changeMinor).toBe('0');
  });

  it('refuses a product that is not in this tenant', async () => {
    const result = await checkout({
      lines: [{ productId: '018f1000-0000-7000-8000-0000000000ff', quantityScaled: '1000' }],
    });
    expect(result.outcome === 'failure' && result.reason).toBe('unknown-product');
  });

  it('refuses a deactivated product', async () => {
    store.products[0] = { ...store.products[0]!, isActive: false };
    const result = await checkout();
    expect(result.outcome === 'failure' && result.reason).toBe('product-unavailable');
  });

  it('refuses a fractional quantity of a unit product', async () => {
    // Half a bottle of milk is not a thing a till may ring up.
    const result = await checkout({ lines: [{ productId: A.milk, quantityScaled: '1500' }] });
    expect(result.outcome === 'failure' && result.reason).toBe('invalid-quantity');
  });

  it('accepts a fractional quantity of a weighed product', async () => {
    const result = await checkout({
      lines: [{ productId: A.rice, quantityScaled: '1250' }],
      cashReceivedMinor: '5000',
    });
    if (result.outcome !== 'success') throw new Error(result.reason);
    // 1.25 kg at 24.00 = 30.00.
    expect(result.sale.totalMinor).toBe('3000');
  });

  it('refuses to sell stock the branch does not have', async () => {
    store.products[0]!.branchStock[A.branch] = '1000';
    const result = await checkout({ lines: [{ productId: A.milk, quantityScaled: '2000' }] });
    expect(result.outcome === 'failure' && result.reason).toBe('insufficient-stock');
    expect(store.sales).toHaveLength(0);
  });

  it('allows overselling only when the merchant has said so', async () => {
    store.settings[0] = { ...store.settings[0]!, allowNegativeStock: true };
    store.products[0]!.branchStock[A.branch] = '1000';
    const result = await checkout({ lines: [{ productId: A.milk, quantityScaled: '2000' }] });
    expect(result.outcome).toBe('success');
    expect(store.products[0]?.branchStock[A.branch]).toBe('-1000');
  });

  it('refuses a duplicate product line rather than aggregating it silently', async () => {
    // Six and six against a stock of ten: each line passes on its own and the
    // sum does not.
    const result = await checkout({
      lines: [
        { productId: A.milk, quantityScaled: '6000' },
        { productId: A.milk, quantityScaled: '6000' },
      ],
      cashReceivedMinor: '20000',
    });
    expect(result.outcome === 'failure' && result.reason).toBe('duplicate-line');
    expect(store.sales).toHaveLength(0);
  });

  it('refuses to ring into another cashier’s shift', async () => {
    const other = '018f1000-0000-7000-8000-0000000000c9';
    const result = await checkout({ principal: principal({ userId: other }) });
    expect(result.outcome === 'failure' && result.reason).toBe('shift-invalid');
  });

  it('refuses a till in a branch the principal is not pinned to', async () => {
    const result = await checkout({
      principal: principal({ branchId: '018f1000-0000-7000-8000-0000000000ca' }),
    });
    expect(result.outcome === 'failure' && result.reason).toBe('shift-invalid');
  });

  it('refuses at the persistence boundary when the shift closed underneath it', async () => {
    // The pre-flight read saw an open shift; the fake closes it the way the
    // database would have, and the transaction refuses.
    const closing = createCheckoutService({
      tenants: memoryTenantRepository(store),
      products: memoryProductRepository(store),
      inventory: memoryInventoryRepository(store),
      shifts: {
        ...memoryShiftRepository(store),
        findOpenForTerminal: async (scope, terminalId) => {
          const found = await memoryShiftRepository(store).findOpenForTerminal(scope, terminalId);
          store.shifts[0] = { ...store.shifts[0]!, status: 'closed' };
          return found;
        },
      },
      sales: memorySaleRepository(store),
      idempotency: memoryIdempotencyRepository(store),
      audit: memoryAuditRepository(store),
    });

    const result = await closing.checkout({
      principal: principal(),
      operationId: OPERATION,
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    expect(result.outcome === 'failure' && result.reason).toBe('shift-invalid');
    expect(store.sales).toHaveLength(0);
  });

  it('leaves nothing behind when persistence fails', async () => {
    store.recordFails = true;
    await expect(checkout()).rejects.toThrow(/persistence failed/);
    expect(store.sales).toHaveLength(0);
    expect(store.invoices).toHaveLength(0);
    expect(store.movements).toHaveLength(0);
    expect(store.keys).toHaveLength(0);
    expect(store.products[0]?.branchStock[A.branch]).toBe('10000');
  });
});

describe('idempotency', () => {
  it('returns the same sale for the same key and the same intent', async () => {
    const first = await checkout();
    const second = await checkout();
    if (first.outcome !== 'success' || second.outcome !== 'success') throw new Error('expected success');

    expect(second.replayed).toBe(true);
    expect(second.sale.saleId).toBe(first.sale.saleId);
    expect(second.sale.sequence).toBe(first.sale.sequence);
    // And nothing was written the second time.
    expect(store.sales).toHaveLength(1);
    expect(store.movements).toHaveLength(1);
  });

  it.each([
    ['a changed quantity', { lines: [{ productId: A.milk, quantityScaled: '3000' }] }],
    ['a changed product', { lines: [{ productId: A.rice, quantityScaled: '2000' }] }],
    ['changed cash received', { cashReceivedMinor: '6000' }],
  ])('refuses the same key with %s', async (_label, overrides) => {
    await checkout();
    const replay = await checkout(overrides);
    expect(replay.outcome === 'failure' && replay.reason).toBe('idempotency-conflict');
    expect(store.sales).toHaveLength(1);
  });

  it('is not confused by the basket being reordered', async () => {
    const lines = [
      { productId: A.milk, quantityScaled: '2000' },
      { productId: A.rice, quantityScaled: '1000' },
    ];
    const first = await checkout({ lines, cashReceivedMinor: '10000' });
    const second = await checkout({ lines: [...lines].reverse(), cashReceivedMinor: '10000' });
    if (first.outcome !== 'success' || second.outcome !== 'success') throw new Error('expected success');
    expect(second.replayed).toBe(true);
    expect(second.sale.saleId).toBe(first.sale.saleId);
  });
});

describe('the intent fingerprint', () => {
  const base = {
    branchId: A.branch,
    terminalId: A.terminal,
    lines: [{ productId: A.milk, quantityScaled: '2000' }],
    cashReceivedMinor: '5000',
  };

  it('is stable across line order', () => {
    const two = { ...base, lines: [...base.lines, { productId: A.rice, quantityScaled: '1000' }] };
    const reversed = { ...two, lines: [...two.lines].reverse() };
    expect(fingerprintIntent(two)).toBe(fingerprintIntent(reversed));
  });

  it.each([
    ['quantity', { ...base, lines: [{ productId: A.milk, quantityScaled: '2001' }] }],
    ['product', { ...base, lines: [{ productId: A.rice, quantityScaled: '2000' }] }],
    ['cash', { ...base, cashReceivedMinor: '5001' }],
    ['terminal', { ...base, terminalId: A.shift }],
  ])('changes with the %s', (_label, changed) => {
    expect(fingerprintIntent(changed)).not.toBe(fingerprintIntent(base));
  });

  it('carries nothing secret', () => {
    // It is a digest of ids, quantities and a cash figure — the same things
    // the sale row holds in the clear.
    expect(fingerprintIntent(base)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('what a client may not decide', () => {
  it('ignores a client-asserted tenant, taking the principal at its word instead', async () => {
    // There is no field for it, and the pipeline reads only the principal.
    const result = await service.checkout({
      principal: principal({ tenantId: A.tenant }),
      operationId: OPERATION,
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);
    expect(store.sales[0]?.tenantId).toBe(A.tenant);
    expect(store.sales[0]?.userId).toBe(A.user);
  });

  it('cannot reach another tenant’s product even with its real id', async () => {
    const B: Fixture = {
      tenant: '018f1000-0000-7000-8000-00000000000b',
      branch: '018f1000-0000-7000-8000-0000000000b1',
      terminal: '018f1000-0000-7000-8000-0000000000b2',
      shift: '018f1000-0000-7000-8000-0000000000b3',
      user: '018f1000-0000-7000-8000-0000000000b4',
      milk: '018f1000-0000-7000-8000-0000000000b5',
      rice: '018f1000-0000-7000-8000-0000000000b6',
    };
    seedStore(store, B);

    const result = await checkout({ lines: [{ productId: B.milk, quantityScaled: '1000' }] });
    expect(result.outcome === 'failure' && result.reason).toBe('unknown-product');
  });

  it('writes the cashier from the session, not from anywhere else', async () => {
    await checkout({ principal: principal({ userId: A.user }) });
    expect(store.sales[0]?.userId).toBe(A.user);
    expect(store.sales[0]?.shiftId).toBe(A.shift);
    expect(store.sales[0]?.branchId).toBe(A.branch);
  });
});
EOF

say "Tests — the HTTP boundary"

cat << 'EOF' > apps/api/src/__tests__/business-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { createCheckoutService } from '../checkout/service.js';
import {
  MemoryAuthStore,
  memoryAuditRepository as memoryAuthAudit,
  memoryAuthRepository,
} from './support/memory-auth.js';
import {
  MemoryBusinessStore,
  memoryAuditRepository,
  memoryIdempotencyRepository,
  memoryInventoryRepository,
  memoryProductRepository,
  memorySaleRepository,
  memoryShiftRepository,
  memoryTenantRepository,
  memoryTerminalRepository,
  seedStore,
} from './support/memory-business.js';
import type { Fixture } from './support/memory-business.js';
import type { RoleName } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-real-password-9!';

const A: Fixture = {
  tenant: '018f2000-0000-7000-8000-00000000000a',
  branch: '018f2000-0000-7000-8000-0000000000a1',
  terminal: '018f2000-0000-7000-8000-0000000000a2',
  shift: '018f2000-0000-7000-8000-0000000000a3',
  user: '018f2000-0000-7000-8000-0000000000a4',
  milk: '018f2000-0000-7000-8000-0000000000a5',
  rice: '018f2000-0000-7000-8000-0000000000a6',
};

let app: FastifyInstance;
let business: MemoryBusinessStore;
let auth: MemoryAuthStore;

async function build(role: RoleName, openShift = true): Promise<FastifyInstance> {
  business = new MemoryBusinessStore();
  seedStore(business, A, openShift);

  auth = new MemoryAuthStore();
  auth.tenants.push({ id: A.tenant, slug: 'korvi-a', name: 'Korvi A', status: 'active' });
  auth.users.push({
    id: A.user,
    tenantId: A.tenant,
    email: 'sara@korvi-a.test',
    displayName: 'سارة',
    passwordHash: await hashPassword(PASSWORD, FAST),
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    authVersion: 1,
    lastLoginAt: null,
  });
  auth.memberships.push({ tenantId: A.tenant, userId: A.user, status: 'active', defaultBranchId: A.branch });
  auth.grants.push({
    tenantId: A.tenant,
    userId: A.user,
    roles: [role],
    permissions: [...ROLE_PERMISSIONS[role]],
  });

  let counter = 0;
  const server = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: createAuthService({
      repository: memoryAuthRepository(auth),
      audit: memoryAuthAudit(auth),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    }),
    business: {
      products: memoryProductRepository(business),
      shifts: memoryShiftRepository(business),
      terminals: memoryTerminalRepository(business),
      checkout: createCheckoutService({
        tenants: memoryTenantRepository(business),
        products: memoryProductRepository(business),
        inventory: memoryInventoryRepository(business),
        shifts: memoryShiftRepository(business),
        sales: memorySaleRepository(business),
        idempotency: memoryIdempotencyRepository(business),
        audit: memoryAuditRepository(business),
        newId: () => {
          counter += 1;
          return `018f2000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
        },
      }),
    },
  });
  await server.ready();
  return server;
}

async function cookieFor(server: FastifyInstance): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return header.split(';')[0] ?? '';
}

afterEach(async () => {
  await app.close();
});

describe('GET /v1/products', () => {
  beforeEach(async () => {
    app = await build('cashier');
  });

  it('refuses without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/products' });
    expect(response.statusCode).toBe(401);
  });

  it('lists the tenant’s products for a cashier', async () => {
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/products', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ products: { sku: string }[] }>();
    expect(body.products.map((p) => p.sku).sort()).toEqual(['MILK-1L', 'RICE-5K']);
  });

  it('finds a product by the start of its Arabic name', async () => {
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/products?q=' + encodeURIComponent('حليب'),
      headers: { cookie },
    });
    const body = response.json<{ products: { sku: string }[] }>();
    expect(body.products).toHaveLength(1);
    expect(body.products[0]?.sku).toBe('MILK-1L');
  });

  it('resolves a scanned barcode to exactly one product', async () => {
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/products?q=6281000000002',
      headers: { cookie },
    });
    const body = response.json<{ products: { sku: string }[] }>();
    expect(body.products).toHaveLength(1);
    expect(body.products[0]?.sku).toBe('RICE-5K');
  });

  it('never offers a deactivated product to a till', async () => {
    business.products[0] = { ...business.products[0]!, isActive: false };
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/products', headers: { cookie } });
    const body = response.json<{ products: { sku: string }[] }>();
    expect(body.products.map((p) => p.sku)).toEqual(['RICE-5K']);
  });

  it('bounds the page size rather than serialising the catalogue', async () => {
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/products?limit=5000',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /v1/products, without the permission', () => {
  it('answers 403 for a role that may not read the catalogue', async () => {
    app = await build('cashier');
    // Strip the permission the way a real tenant would: by not granting it.
    auth.grants[0] = { tenantId: A.tenant, userId: A.user, roles: ['cashier'], permissions: [] };
    const cookie = await cookieFor(app);
    const response = await app.inject({ method: 'GET', url: '/v1/products', headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });
});

describe('shifts', () => {
  it('reports no open shift, then opens one', async () => {
    app = await build('cashier', false);
    const cookie = await cookieFor(app);

    const before = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${A.terminal}`,
      headers: { cookie },
    });
    expect(before.json()).toEqual({ shift: null });

    const opened = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: A.terminal, openingFloatMinor: '20000' },
    });
    expect(opened.statusCode).toBe(201);
    const body = opened.json<{ shift: { branchId: string; userId: string } }>();
    // The branch came from the terminal and the cashier from the session.
    expect(body.shift.branchId).toBe(A.branch);
    expect(body.shift.userId).toBe(A.user);
  });

  it('refuses a second shift on the same till', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: A.terminal, openingFloatMinor: '20000' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects a body that names a branch', async () => {
    app = await build('cashier', false);
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: { cookie, origin: ORIGIN },
      payload: { terminalId: A.terminal, openingFloatMinor: '20000', branchId: A.branch },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'forbidden_field', field: 'branchId' });
  });
});

describe('POST /v1/sales', () => {
  const operation = '018f2000-0000-7000-8000-0000000000f1';

  function sale(server: FastifyInstance, cookie: string, overrides: Record<string, unknown> = {}) {
    return server.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: operation,
        terminalId: A.terminal,
        cashReceivedMinor: '5000',
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        ...overrides,
      },
    });
  }

  it('completes a cash sale and returns a safe summary', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie);

    expect(response.statusCode).toBe(201);
    const body = response.json<{ sale: Record<string, string>; replayed: boolean }>();
    expect(body.sale['totalMinor']).toBe('2300');
    expect(body.sale['changeMinor']).toBe('2700');
    expect(body.sale['invoiceNumber']).toBe('01-000001');
    expect(body.replayed).toBe(false);
    // Nothing internal crosses the wire.
    expect(response.payload).not.toContain('tokenHash');
    expect(response.payload).not.toContain('passwordHash');
    expect(response.payload).not.toContain('requestHash');
  });

  it.each([
    ['unitPriceMinor', { unitPriceMinor: '1' }],
    ['totalMinor', { totalMinor: '1' }],
    ['tenantId', { tenantId: '018f2000-0000-7000-8000-00000000000b' }],
    ['userId', { userId: '018f2000-0000-7000-8000-0000000000ff' }],
    ['roles', { roles: ['owner'] }],
    ['sequence', { sequence: 99 }],
  ])('rejects a body that tries to set %s', async (field, overrides) => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie, overrides);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'forbidden_field', field });
  });

  it('answers 409 with an Arabic message when there is no open shift', async () => {
    app = await build('cashier', false);
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toContain('وردية');
  });

  it('answers 422 when the cash does not cover the total', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie, { cashReceivedMinor: '100' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'insufficient-cash' });
  });

  it('replays the same sale for a repeated request, creating nothing', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const first = await sale(app, cookie);
    const second = await sale(app, cookie);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ replayed: boolean }>().replayed).toBe(true);
    expect(business.sales).toHaveLength(1);
  });

  it('answers 409 when the same key carries a different basket', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    await sale(app, cookie);
    const conflicting = await sale(app, cookie, {
      lines: [{ productId: A.milk, quantityScaled: '4000' }],
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ error: 'idempotency-conflict' });
    expect(business.sales).toHaveLength(1);
  });

  it('refuses a caller without sale.create', async () => {
    app = await build('cashier');
    auth.grants[0] = {
      tenantId: A.tenant,
      userId: A.user,
      roles: ['cashier'],
      permissions: ['product.read'],
    };
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie);
    expect(response.statusCode).toBe(403);
  });

  it('refuses an unauthenticated checkout', async () => {
    app = await build('cashier');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { origin: ORIGIN },
      payload: {
        operationId: operation,
        terminalId: A.terminal,
        cashReceivedMinor: '5000',
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('bounds the number of cart lines', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await sale(app, cookie, {
      lines: Array.from({ length: 500 }, () => ({ productId: A.milk, quantityScaled: '1000' })),
    });
    expect(response.statusCode).toBe(400);
  });
});
EOF

say "Tests — live checkout, numbering and concurrency"

cat << 'EOF' > apps/api/src/__tests__/checkout-live.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { basisPoints, newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  InsufficientStockError,
  ShiftOpenRefusedError,
  assignRole,
  createAuditRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createSaleRepository,
  createShiftRepository,
  createTenantRepository,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  withTenant,
} from '@korvi/database';
import { createCheckoutService } from '../checkout/service.js';
import type { CheckoutService } from '../checkout/service.js';
import type { PrismaClient } from '@korvi/database';
import type {
  AuthenticatedPrincipal,
  RecordSaleInput,
  SaleRepository,
  ShiftRepository,
  TenantScope,
} from '@korvi/domain';

/**
 * The checkout against a real PostgreSQL server.
 *
 * Three things only a live database can settle: that the whole sale commits or
 * none of it does, that two tills checking out at the same instant receive
 * different receipt numbers, and that a rolled-back attempt leaves nothing —
 * not a sale, not a movement, not a reserved operation id.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with every
 * migration applied, connected as the application role — not a superuser, which
 * bypasses RLS.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const T = {
  tenant: '018f3000-0000-7000-8000-00000000000a',
  slug: 'sale-live-a',
  branch: '018f3000-0000-7000-8000-0000000000a1',
  terminal: '018f3000-0000-7000-8000-0000000000a2',
  terminal2: '018f3000-0000-7000-8000-0000000000a7',
  shift: '018f3000-0000-7000-8000-0000000000a3',
  shift2: '018f3000-0000-7000-8000-0000000000a8',
  user: '018f3000-0000-7000-8000-0000000000a4',
  membership: '018f3000-0000-7000-8000-0000000000a5',
  milk: '018f3000-0000-7000-8000-0000000000a6',
} as const;

describe.skipIf(url === '')('cash checkout, live', () => {
  let prisma: PrismaClient;
  let service: CheckoutService;
  let principal: AuthenticatedPrincipal;

  const scope: TenantScope = { tenantId: brandTenantId(T.tenant) };

  async function remove(): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: T.tenant } });
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: T.tenant,
          name: 'متجر كورفي',
          slug: T.slug,
          vatNumber: '300000000000003',
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({ data: { tenantId: T.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: { id: T.branch, tenantId: T.tenant, code: '01', nameAr: 'الفرع', updatedAt: new Date() },
      });
      await tx.user.create({
        data: {
          id: T.user,
          tenantId: T.tenant,
          email: 'sara@sale-live-a.test',
          displayName: 'سارة',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: T.membership, tenantId: T.tenant, userId: T.user, updatedAt: new Date() },
      });
      for (const [id, code] of [
        [T.terminal, '01'],
        [T.terminal2, '02'],
      ] as const) {
        await tx.terminal.create({
          data: {
            id,
            tenantId: T.tenant,
            branchId: T.branch,
            code,
            label: `صندوق ${code}`,
            updatedAt: new Date(),
          },
        });
      }
      for (const [id, terminal] of [
        [T.shift, T.terminal],
        [T.shift2, T.terminal2],
      ] as const) {
        await tx.shift.create({
          data: {
            id,
            tenantId: T.tenant,
            branchId: T.branch,
            terminalId: terminal,
            userId: T.user,
            openingFloatMinor: 20_000n,
            openedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }
      await tx.product.create({
        data: {
          id: T.milk,
          tenantId: T.tenant,
          sku: 'MILK-1L',
          nameAr: 'حليب طازج',
          priceMinor: 1150n,
          vatBasisPoints: 1500,
          updatedAt: new Date(),
        },
      });
      await tx.inventoryBalance.create({
        data: {
          tenantId: T.tenant,
          branchId: T.branch,
          productId: T.milk,
          quantityScaled: 1_000_000n,
          updatedAt: new Date(),
        },
      });
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, T.user, 'cashier');

    const products = createProductRepository(prisma);
    service = createCheckoutService({
      tenants: createTenantRepository(prisma),
      products,
      inventory: createInventoryRepository(prisma),
      shifts: createShiftRepository(prisma),
      sales: createSaleRepository(prisma),
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });

    principal = {
      tenantId: T.tenant,
      tenantSlug: T.slug,
      userId: T.user,
      sessionId: newId(),
      email: 'sara@sale-live-a.test',
      displayName: 'سارة',
      roles: ['cashier'],
      permissions: ['sale.create', 'product.read'],
      maxDiscountBasisPoints: 0n,
      branchId: T.branch,
    };
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  function checkout(terminalId: string, operationId: string, quantityScaled = '2000') {
    return service.checkout({
      principal,
      operationId,
      terminalId,
      cashReceivedMinor: '10000',
      lines: [{ productId: T.milk, quantityScaled }],
    });
  }

  it('persists a whole sale: lines, invoice, tender, stock and cash', async () => {
    const result = await checkout(T.terminal, newId());
    if (result.outcome !== 'success') throw new Error(result.reason);

    const rows = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sale: await tx.sale.findFirst({
        where: { id: result.sale.saleId },
        include: { lines: true, tenders: true, invoice: { include: { taxBreakdown: true } } },
      }),
      movements: await tx.inventoryMovement.count({ where: { sourceId: result.sale.saleId } }),
      cash: await tx.cashMovement.count({ where: { shiftId: T.shift, kind: 'sale' } }),
    }));

    expect(rows.sale?.lines).toHaveLength(1);
    expect(rows.sale?.tenders).toHaveLength(1);
    expect(rows.sale?.invoice?.taxBreakdown).toHaveLength(1);
    expect(rows.sale?.totalMinor).toBe(2300n);
    expect(rows.movements).toBe(1);
    expect(rows.cash).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('gives two simultaneous checkouts in one branch different receipt numbers', async () => {
    // The branch row lock is the whole point. Without it both transactions read
    // the same MAX(sequence) and one dies on the unique key.
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { tenantId: T.tenant, branchId: T.branch } }),
    );

    const [left, right] = await Promise.all([
      checkout(T.terminal, newId()),
      checkout(T.terminal2, newId()),
    ]);

    if (left.outcome !== 'success' || right.outcome !== 'success') {
      throw new Error('both concurrent checkouts must succeed');
    }
    expect(left.sale.sequence).not.toBe(right.sale.sequence);
    expect([left.sale.sequence, right.sale.sequence].sort((a, b) => a - b)).toEqual([
      before + 1,
      before + 2,
    ]);
    expect(left.sale.invoiceNumber).not.toBe(right.sale.invoiceNumber);

    const after = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { tenantId: T.tenant, branchId: T.branch } }),
    );
    expect(after).toBe(before + 2);
  }, 30_000);

  it('keeps numbering dense: a rolled-back attempt hands its number on', async () => {
    // The rollback releases the branch lock without inserting, so the number it
    // would have used is still the next one available. Documented in ADR-0013.
    const operation = newId();
    const doomed = service.checkout({
      principal,
      operationId: operation,
      terminalId: T.terminal,
      cashReceivedMinor: '10000',
      // A whole number of units, far beyond the seeded balance, so the stock
      // guard is what refuses it rather than the quantity check.
      lines: [{ productId: T.milk, quantityScaled: '999999999000' }],
    });
    const refused = await doomed;
    expect(refused.outcome === 'failure' && refused.reason).toBe('insufficient-stock');

    const nothing = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { operationId: operation } }),
      keys: await tx.idempotencyKey.count({ where: { operationId: operation } }),
    }));
    expect(nothing).toEqual({ sales: 0, keys: 0 });

    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.aggregate({
        where: { tenantId: T.tenant, branchId: T.branch },
        _max: { sequence: true },
      }),
    );
    const next = await checkout(T.terminal, newId());
    if (next.outcome !== 'success') throw new Error(next.reason);
    expect(next.sale.sequence).toBe((before._max.sequence ?? 0) + 1);
  }, 30_000);

  it('replays an operation id without writing a second sale', async () => {
    const operation = newId();
    const first = await checkout(T.terminal, operation);
    const second = await checkout(T.terminal, operation);
    if (first.outcome !== 'success' || second.outcome !== 'success') throw new Error('expected success');

    expect(second.replayed).toBe(true);
    expect(second.sale.saleId).toBe(first.sale.saleId);
    expect(second.sale.sequence).toBe(first.sale.sequence);

    const count = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { operationId: operation } }),
    );
    expect(count).toBe(1);
  }, 30_000);

  it('refuses the same operation id with a different basket', async () => {
    const operation = newId();
    await checkout(T.terminal, operation, '2000');
    const conflicting = await checkout(T.terminal, operation, '3000');
    expect(conflicting.outcome === 'failure' && conflicting.reason).toBe('idempotency-conflict');

    const count = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { operationId: operation } }),
    );
    expect(count).toBe(1);
  }, 30_000);

  it('cannot sell another tenant’s product', async () => {
    const foreign = { ...principal, tenantId: '018f3000-0000-7000-8000-00000000000f' };
    const result = await service.checkout({
      principal: foreign,
      operationId: newId(),
      terminalId: T.terminal,
      cashReceivedMinor: '10000',
      lines: [{ productId: T.milk, quantityScaled: '1000' }],
    });
    // The shift belongs to another tenant and is invisible under this scope.
    expect(result.outcome === 'failure' && result.reason).toBe('no-open-shift');
  }, 30_000);
});

/**
 * The races.
 *
 * Everything here is a question a single-threaded test cannot ask: whether the
 * last unit on the shelf can be sold twice, whether one operation id can
 * produce two sales, whether one till can have two open shifts, and whether a
 * transaction that dies after taking a receipt number leaves anything behind.
 *
 * Its own tenant, because each of these leaves stock, numbering or shifts in a
 * state the next would otherwise inherit.
 */
const C = {
  tenant: '018f4000-0000-7000-8000-00000000000a',
  slug: 'sale-race-a',
  branch: '018f4000-0000-7000-8000-0000000000b1',
  terminalA: '018f4000-0000-7000-8000-0000000000c1',
  terminalB: '018f4000-0000-7000-8000-0000000000c2',
  idleTerminal: '018f4000-0000-7000-8000-0000000000c3',
  shiftA: '018f4000-0000-7000-8000-0000000000d1',
  shiftB: '018f4000-0000-7000-8000-0000000000d2',
  user: '018f4000-0000-7000-8000-0000000000e1',
  membership: '018f4000-0000-7000-8000-0000000000e2',
} as const;

describe.skipIf(url === '')('checkout races, live', () => {
  let prisma: PrismaClient;
  let service: CheckoutService;
  let sales: SaleRepository;
  let shifts: ShiftRepository;
  let principal: AuthenticatedPrincipal;

  const scope: TenantScope = { tenantId: brandTenantId(C.tenant) };

  async function remove(): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: C.tenant } });
    });
  }

  /** A product with a known shelf quantity, so a test can ask for exactly one more. */
  async function seedProduct(id: string, sku: string, quantityScaled: bigint): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.create({
        data: {
          id,
          tenantId: C.tenant,
          sku,
          nameAr: 'صنف',
          priceMinor: 1150n,
          vatBasisPoints: 1500,
          updatedAt: new Date(),
        },
      });
      await tx.inventoryBalance.create({
        data: {
          tenantId: C.tenant,
          branchId: C.branch,
          productId: id,
          quantityScaled,
          updatedAt: new Date(),
        },
      });
    });
  }

  async function balanceOf(productId: string): Promise<bigint> {
    return withTenant(prisma, scope.tenantId, async (tx) => {
      const row = await tx.inventoryBalance.findFirst({
        where: { tenantId: C.tenant, branchId: C.branch, productId },
      });
      return row?.quantityScaled ?? 0n;
    });
  }

  async function movementsFor(productId: string): Promise<number> {
    return withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryMovement.count({ where: { tenantId: C.tenant, productId } }),
    );
  }

  async function salesFor(operationId: string): Promise<number> {
    return withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { tenantId: C.tenant, operationId } }),
    );
  }

  async function nextSequence(): Promise<number> {
    const row = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.aggregate({
        where: { tenantId: C.tenant, branchId: C.branch },
        _max: { sequence: true },
      }),
    );
    return (row._max.sequence ?? 0) + 1;
  }

  async function setOverselling(allowed: boolean): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenantSettings.update({
        where: { tenantId: C.tenant },
        data: { allowNegativeStock: allowed, updatedAt: new Date() },
      });
    });
  }

  function checkout(
    terminalId: string,
    operationId: string,
    productId: string,
    quantityScaled = '1000',
  ) {
    return service.checkout({
      principal,
      operationId,
      terminalId,
      cashReceivedMinor: '10000',
      lines: [{ productId, quantityScaled }],
    });
  }

  /**
   * A minimal reconciling sale, assembled by hand.
   *
   * Some of these questions are about the repository's transaction and not
   * about the service in front of it — whether the stock guard lives in the
   * UPDATE rather than in a prior read, and what survives a failure after the
   * receipt number has been taken. Going straight at `record()` asks exactly
   * that, with no pre-flight check standing in the way.
   */
  function recordInput(args: {
    saleId: string;
    productId: string;
    operationId: string;
    quantityScaled: string;
  }): RecordSaleInput {
    const issuedAt = new Date().toISOString();
    return {
      sale: {
        id: args.saleId,
        branchId: C.branch,
        terminalId: C.terminalA,
        shiftId: C.shiftA,
        userId: C.user,
        customerId: null,
        operationId: args.operationId,
        status: 'finalized',
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        grossMinor: '1150',
        lineDiscountMinor: '0',
        basketDiscountMinor: '0',
        netMinor: '1000',
        vatMinor: '150',
        totalMinor: '1150',
        tenderedMinor: '1150',
        changeMinor: '0',
        issuedAt,
        lines: [
          {
            id: newId(),
            lineNumber: 1,
            productId: args.productId,
            sku: 'RACE-1',
            nameAr: 'صنف',
            nameEn: null,
            unitPriceMinor: '1150',
            vatBasisPoints: basisPoints(1500),
            quantityScaled: args.quantityScaled,
            grossMinor: '1150',
            lineDiscountMinor: '0',
            basketDiscountMinor: '0',
            netMinor: '1000',
            vatMinor: '150',
            totalMinor: '1150',
          },
        ],
        discounts: [],
        tenders: [
          { id: newId(), kind: 'cash', amountMinor: '1150', changeMinor: '0', reference: null },
        ],
      },
      invoice: {
        id: newId(),
        saleId: args.saleId,
        invoiceType: 'simplified',
        sellerName: 'متجر كورفي',
        sellerVatNumber: '300000000000003',
        buyerName: null,
        buyerVatNumber: null,
        netMinor: '1000',
        vatMinor: '150',
        totalMinor: '1150',
        currency: 'SAR',
        issuedAt,
        taxBreakdown: [{ vatBasisPoints: basisPoints(1500), netMinor: '1000', vatMinor: '150' }],
      },
      inventory: [
        {
          id: newId(),
          branchId: C.branch,
          productId: args.productId,
          kind: 'sale',
          quantityScaled: `-${args.quantityScaled}`,
          reason: null,
          sourceType: 'sale',
          sourceId: args.saleId,
          actorUserId: C.user,
          occurredAt: issuedAt,
        },
      ],
      cashMovement: {
        id: newId(),
        shiftId: C.shiftA,
        kind: 'sale',
        amountMinor: '1150',
        reason: null,
        actorUserId: C.user,
        occurredAt: issuedAt,
      },
      idempotency: {
        id: newId(),
        scope: 'checkout',
        operationId: args.operationId,
        requestHash: null,
      },
    };
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: C.tenant,
          name: 'متجر كورفي',
          slug: C.slug,
          vatNumber: '300000000000003',
          updatedAt: new Date(),
        },
      });
      // allowNegativeStock defaults to false: the merchant's shelf is the limit
      // until they say otherwise.
      await tx.tenantSettings.create({ data: { tenantId: C.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: { id: C.branch, tenantId: C.tenant, code: '09', nameAr: 'الفرع', updatedAt: new Date() },
      });
      await tx.user.create({
        data: {
          id: C.user,
          tenantId: C.tenant,
          email: 'sara@sale-race-a.test',
          displayName: 'سارة',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: C.membership, tenantId: C.tenant, userId: C.user, updatedAt: new Date() },
      });
      for (const [id, code] of [
        [C.terminalA, '01'],
        [C.terminalB, '02'],
        [C.idleTerminal, '03'],
      ] as const) {
        await tx.terminal.create({
          data: {
            id,
            tenantId: C.tenant,
            branchId: C.branch,
            code,
            label: `صندوق ${code}`,
            updatedAt: new Date(),
          },
        });
      }
      // Two tills open, one deliberately left closed for the shift-open race.
      for (const [id, terminal] of [
        [C.shiftA, C.terminalA],
        [C.shiftB, C.terminalB],
      ] as const) {
        await tx.shift.create({
          data: {
            id,
            tenantId: C.tenant,
            branchId: C.branch,
            terminalId: terminal,
            userId: C.user,
            openingFloatMinor: 20_000n,
            openedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, C.user, 'cashier');

    sales = createSaleRepository(prisma);
    shifts = createShiftRepository(prisma);
    service = createCheckoutService({
      tenants: createTenantRepository(prisma),
      products: createProductRepository(prisma),
      inventory: createInventoryRepository(prisma),
      shifts,
      sales,
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });

    principal = {
      tenantId: C.tenant,
      tenantSlug: C.slug,
      userId: C.user,
      sessionId: newId(),
      email: 'sara@sale-race-a.test',
      displayName: 'سارة',
      roles: ['cashier'],
      permissions: ['sale.create', 'product.read'],
      maxDiscountBasisPoints: 0n,
      branchId: C.branch,
    };
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  it('sells the last unit to exactly one of two simultaneous checkouts', async () => {
    const product = '018f4000-0000-7000-8000-0000000000f1';
    await seedProduct(product, 'LAST-1', 1_000n);

    // Two tills, two shifts, one unit between them. Both read a stock of one
    // before either commits, which is precisely why the read cannot be the
    // guard.
    const results = await Promise.all([
      checkout(C.terminalA, newId(), product),
      checkout(C.terminalB, newId(), product),
    ]);

    const won = results.filter((result) => result.outcome === 'success');
    const lost = results.filter((result) => result.outcome === 'failure');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.outcome === 'failure' && lost[0].reason).toBe('insufficient-stock');

    // One sale, one movement, and a shelf at zero rather than below it.
    expect(await movementsFor(product)).toBe(1);
    expect(await balanceOf(product)).toBe(0n);
    const sold = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.saleLine.count({ where: { tenantId: C.tenant, productId: product } }),
    );
    expect(sold).toBe(1);
  }, 60_000);

  it('refuses the oversell in the UPDATE itself, and rolls the sale back with it', async () => {
    // Straight at the repository, so nothing checks stock before the mutation
    // does. This is the case the concurrent test can only reach by luck.
    const product = '018f4000-0000-7000-8000-0000000000f2';
    await seedProduct(product, 'NONE-1', 0n);

    const saleId = newId();
    const operationId = newId();
    await expect(
      sales.record(scope, recordInput({ saleId, productId: product, operationId, quantityScaled: '1000' })),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    const left = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { tenantId: C.tenant, id: saleId } }),
      keys: await tx.idempotencyKey.count({ where: { tenantId: C.tenant, operationId } }),
      movements: await tx.inventoryMovement.count({ where: { tenantId: C.tenant, productId: product } }),
    }));
    expect(left).toEqual({ sales: 0, keys: 0, movements: 0 });
    expect(await balanceOf(product)).toBe(0n);
  }, 60_000);

  it('lets a merchant who allows overselling sell what is not on the shelf', async () => {
    // The negative control for the guard: with the policy turned on, the same
    // movement is written and the balance goes below zero.
    const product = '018f4000-0000-7000-8000-0000000000f3';
    await seedProduct(product, 'NEG-1', 1_000n);
    await setOverselling(true);
    try {
      const results = await Promise.all([
        checkout(C.terminalA, newId(), product),
        checkout(C.terminalB, newId(), product),
      ]);
      expect(results.every((result) => result.outcome === 'success')).toBe(true);
      expect(await movementsFor(product)).toBe(2);
      expect(await balanceOf(product)).toBe(-1_000n);
    } finally {
      await setOverselling(false);
    }
  }, 60_000);

  it('answers two simultaneous identical requests with one sale', async () => {
    const product = '018f4000-0000-7000-8000-0000000000f4';
    await seedProduct(product, 'IDEM-1', 10_000n);
    const operationId = newId();

    const [left, right] = await Promise.all([
      checkout(C.terminalA, operationId, product),
      checkout(C.terminalA, operationId, product),
    ]);

    // Both callers get an answer, and it is the same answer. The loser did not
    // fail — it read what the winner committed, because ON CONFLICT DO NOTHING
    // waited for that transaction before returning nothing.
    if (left.outcome !== 'success' || right.outcome !== 'success') {
      throw new Error('both callers must receive the sale');
    }
    expect(left.sale.saleId).toBe(right.sale.saleId);
    expect(left.sale.sequence).toBe(right.sale.sequence);
    expect(left.sale.invoiceNumber).toBe(right.sale.invoiceNumber);
    // Exactly one of them actually wrote it.
    expect([left.replayed, right.replayed].filter(Boolean)).toHaveLength(1);

    expect(await salesFor(operationId)).toBe(1);
    // Stock left the shelf once, not twice.
    expect(await movementsFor(product)).toBe(1);
    expect(await balanceOf(product)).toBe(9_000n);
  }, 60_000);

  it('refuses the second of two simultaneous requests that disagree about the basket', async () => {
    const product = '018f4000-0000-7000-8000-0000000000f5';
    await seedProduct(product, 'IDEM-2', 10_000n);
    const operationId = newId();

    const settled = await Promise.allSettled([
      checkout(C.terminalA, operationId, product, '1000'),
      checkout(C.terminalA, operationId, product, '2000'),
    ]);

    // Neither call may throw: a unique-constraint violation is an internal
    // detail, and the route above this maps a reason, not an exception.
    expect(settled.every((entry) => entry.status === 'fulfilled')).toBe(true);
    const results = settled.map((entry) =>
      entry.status === 'fulfilled' ? entry.value : { outcome: 'failure' as const, reason: 'threw' },
    );
    const won = results.filter((result) => result.outcome === 'success');
    const lost = results.filter((result) => result.outcome === 'failure');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.outcome === 'failure' && lost[0].reason).toBe('idempotency-conflict');

    expect(await salesFor(operationId)).toBe(1);
    expect(await movementsFor(product)).toBe(1);
  }, 60_000);

  it('opens exactly one shift when two cashiers press the button together', async () => {
    const [left, right] = await Promise.allSettled([
      shifts.open(scope, {
        id: newId(),
        branchId: C.branch,
        terminalId: C.idleTerminal,
        userId: C.user,
        openingFloatMinor: '20000',
        openedAt: new Date().toISOString(),
        openingMovementId: newId(),
      }),
      shifts.open(scope, {
        id: newId(),
        branchId: C.branch,
        terminalId: C.idleTerminal,
        userId: C.user,
        openingFloatMinor: '20000',
        openedAt: new Date().toISOString(),
        openingMovementId: newId(),
      }),
    ]);

    const outcomes = [left, right];
    expect(outcomes.filter((entry) => entry?.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((entry) => entry?.status === 'rejected');
    if (refused === undefined || refused.status !== 'rejected') {
      throw new Error('one of the two opens must be refused');
    }
    // A defined refusal, not a raw constraint violation: there is no unique
    // index that could produce one, because a terminal legitimately has many
    // shifts over time.
    expect(refused.reason).toBeInstanceOf(ShiftOpenRefusedError);
    expect((refused.reason as ShiftOpenRefusedError).detail).toBe('already-open');

    const state = await withTenant(prisma, scope.tenantId, async (tx) => ({
      open: await tx.shift.count({
        where: { tenantId: C.tenant, terminalId: C.idleTerminal, status: 'open' },
      }),
      total: await tx.shift.count({ where: { tenantId: C.tenant, terminalId: C.idleTerminal } }),
      floats: await tx.cashMovement.count({
        where: { tenantId: C.tenant, kind: 'opening-float', shift: { terminalId: C.idleTerminal } },
      }),
    }));
    expect(state).toEqual({ open: 1, total: 1, floats: 1 });
  }, 60_000);

  it('leaves nothing behind when a sale dies after its number was taken', async () => {
    // A sale line pointing at a product that does not exist. The insert passes
    // Prisma and fails the foreign key in PostgreSQL — after allocateReceipt
    // has already taken the branch lock and the next number, and after the
    // operation id has already been reserved. Everything must go back.
    const ghost = '018f4000-0000-7000-8000-0000000000ff';
    const saleId = newId();
    const operationId = newId();
    const expected = await nextSequence();
    // Earlier tests in this file have already put sale movements in this
    // drawer, so the question is whether the count changes, not what it is.
    const cashBefore = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { tenantId: C.tenant, shiftId: C.shiftA, kind: 'sale' } }),
    );

    await expect(
      sales.record(scope, recordInput({ saleId, productId: ghost, operationId, quantityScaled: '1000' })),
    ).rejects.toThrow();

    const survivors = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { tenantId: C.tenant, id: saleId } }),
      lines: await tx.saleLine.count({ where: { tenantId: C.tenant, saleId } }),
      invoices: await tx.invoice.count({ where: { tenantId: C.tenant, saleId } }),
      tenders: await tx.tender.count({ where: { tenantId: C.tenant, saleId } }),
      movements: await tx.inventoryMovement.count({ where: { tenantId: C.tenant, sourceId: saleId } }),
      cash: await tx.cashMovement.count({
        where: { tenantId: C.tenant, shiftId: C.shiftA, kind: 'sale' },
      }),
      keys: await tx.idempotencyKey.count({ where: { tenantId: C.tenant, operationId } }),
    }));
    expect(survivors).toEqual({
      sales: 0,
      lines: 0,
      invoices: 0,
      tenders: 0,
      movements: 0,
      cash: cashBefore,
      keys: 0,
    });

    // And the number it would have used is still the next one available: the
    // rollback released the branch lock without inserting, so the series has
    // no gap.
    const product = '018f4000-0000-7000-8000-0000000000f6';
    await seedProduct(product, 'GAP-1', 10_000n);
    const next = await checkout(C.terminalA, newId(), product);
    if (next.outcome !== 'success') throw new Error(next.reason);
    expect(next.sale.sequence).toBe(expected);
  }, 60_000);
});

describe.skipIf(url !== '')('cash checkout, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
EOF

say "ADR-0013 — the checkout transaction"

cat << 'EOF' > docs/decisions/ADR-0013-checkout-transaction-and-idempotency.md
# ADR-0013 — The checkout transaction, receipt numbering and idempotency

Status: accepted
Date: 2026-08-12
Extends ADR-0002 (money), ADR-0003 (identifiers), ADR-0004 (multi-tenancy).

## Context

A checkout is the one operation in a POS where a partial write is a financial
error rather than a bug. Three questions had to be answered before a till could
be built on top of it.

## Decision 1 — One transaction, and the client is not in it

`SaleRepository.record` already committed the sale, its lines, its tenders, the
invoice and its tax breakdown, the stock movements, the drawer movement and the
idempotency reservation together. The checkout pipeline adds nothing outside
that boundary except the audit line, which is written afterwards and whose
failure is logged rather than raised — by then the money has moved and the
customer has the goods.

Everything the sale states is computed on the server: unit price and VAT rate
are read from `products`, the price mode and the overselling policy from
`tenant_settings`, the seller's tax identity from `tenants`, the branch and
shift from the open shift on the terminal, and the cashier from the session.
The request carries product ids, scaled quantities, a terminal, an operation id
and the cash that was handed over. Naming any of the other fields is a 400 with
the offending name, not a silent drop: a client that believes it set the price
should be told it cannot, rather than leaving an auditor to find out.

## Decision 2 — The receipt number is allocated under the branch row lock

`sale.sequence` and `invoice.invoiceNumber` are issued inside the transaction
that writes the sale, by `SELECT … FROM branches … FOR UPDATE` followed by
`MAX(sequence) + 1` on that branch.

`MAX + 1` on its own is wrong, and wrong in the way that only shows up on a busy
Friday: under READ COMMITTED two tills read the same number and the second
INSERT dies on `(tenantId, branchId, sequence)`. Taking the branch row's lock
first makes the second transaction wait for the first to commit and then read
the number that now exists. The lock is held to the end of the transaction,
which makes checkout a short per-branch queue — acceptable for a handful of
inserts, and the single place to change if a shop ever outgrows it.

The caller cannot supply either value; `RecordSaleInput` has no field for them.

**Numbering after a rollback.** A transaction that rolls back releases the lock
without having inserted, so the number it was going to use is handed to the next
transaction: the series stays dense, and a refused checkout leaves no gap. A
sale that commits and is later voided keeps its number, because a tax document
that disappears from the series is worse than one marked void. Both behaviours
are asserted live.

## Decision 3 — Idempotency is a claim about intent, and the database settles it

The operation id alone is not enough. A client that reuses a key with a
different basket is not retrying; it is ringing up a second sale under the first
one's name, and answering it with the earlier sale silently drops a transaction
the cashier believes they completed.

So a SHA-256 fingerprint of the canonical intent — branch, terminal, sorted
`productId:quantityScaled` pairs, cash received — is stored in the existing
`idempotency_keys.requestHash` column and compared on every replay. Same key and
same intent replays the original sale and writes nothing. Same key and different
intent is refused with a conflict. The lines are sorted before hashing, so a
client that reorders the basket between attempts still matches.

The fingerprint holds nothing secret: it is a digest of the same ids, quantities
and cash figure the sale row stores in the clear.

The pre-flight read cannot be the guard, because two requests carrying one key
can be in flight at the same instant and both find nothing. The reservation is
therefore written as

```sql
INSERT INTO "idempotency_keys" (...)
VALUES (...)
ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
RETURNING "id"
```

inside the sale transaction. `ON CONFLICT DO NOTHING` blocks on an *uncommitted*
conflicting row, so returning no row proves the competing transaction has
finished — which is what makes it safe to then go and read the sale it produced.
The loser's own transaction rolls back and the service answers from the
committed one: a replay when the intents match, a conflict when they do not.
A raw unique-constraint violation never leaves the repository; it is turned into
`OperationAlreadyRecordedError` at the boundary and into a reason above it, so
the HTTP layer answers 200, 201 or 409 and never 500.

## Decision 4 — Overselling is the merchant's decision, and the UPDATE enforces it

Stock is checked before any money is touched, against the branch's balance, and
only for products that carry `trackInventory`. A shortfall is refused unless
`tenant_settings.allowNegativeStock` is set, which is the merchant saying they
would rather sell and reconcile later.

That pre-flight check is a courtesy — it produces a clean refusal before the
domain does any arithmetic — but it is not what makes the policy hold. Two tills
selling the last unit both read a stock of one, and a read followed by an
increment cannot tell them apart. The decrement is therefore conditional, in the
same transaction as the sale:

```sql
UPDATE "inventory_balances"
   SET "quantityScaled" = "quantityScaled" + $delta, "updatedAt" = now()
 WHERE "tenantId" = $tenant AND "branchId" = $branch AND "productId" = $product
   AND "quantityScaled" + $delta >= 0
RETURNING "quantityScaled"
```

The predicate is evaluated after the row lock is taken, so the second
transaction re-reads what the first committed and matches nothing. No rows plus a
negative delta is `InsufficientStockError`, which aborts the whole transaction —
sale, lines, invoice, tender, drawer movement and reservation all go back — and
reaches the client as `insufficient-stock`. There is no read-modify-write in
Node and no process-local mutex; a second API instance would not weaken this.

Two lines naming the same product are refused rather than summed: each would
pass a stock check their total fails, and quietly merging them would also change
what the cashier sees on the receipt.

## Decision 5 — The shift is revalidated inside the sale transaction

The open shift is read before pricing, to get the branch and to refuse a till
with no drawer open. That read is stale by the time the sale commits: a shift can
be closed in between, and a sale posted into a closed shift is money that
reconciles against nothing.

So the sale transaction locks the shift row and proves it again — same tenant,
same id, status still `open`, same terminal, same branch, and the same cashier.
One drawer belongs to one cashier: no existing Korvi rule permits a shared shift,
and none is invented here. A principal pinned to a branch cannot transact through
a till in another one. Any of these failing is `ShiftUnusableError`, the whole
transaction rolls back, and the client is told `shift-invalid`.

Opening a shift has the mirror-image problem and no unique index that could
solve it, because a terminal legitimately has many shifts over its life. Two
cashiers pressing "open shift" together would both find no open shift and both
create one. `ShiftRepository.open` therefore takes `SELECT … FROM terminals …
FOR UPDATE` first, so the second waits and then sees the first. The refusal is
`ShiftOpenRefusedError`, which the route maps to a 409 — again, never a driver
error.

## Consequences

- A failed checkout leaves no sale, no line, no invoice, no tender, no stock
  movement, no drawer movement and no reserved operation id.
- Two tills in one branch never collide on a receipt number, and never share
  one.
- A double-clicked checkout is answered once, even when both clicks are in
  flight together; a mis-keyed reuse is refused.
- The last unit on a shelf is sold once. With `allowNegativeStock` set it is
  sold twice, because the merchant asked for that.
- Receipt numbering is dense across rollbacks and stable across voids.
- Checkout is a short per-branch queue, and shift opening a short per-terminal
  one. Both are the price of correctness here, and both are the single place to
  change if a shop outgrows them.
- No concurrency decision is made in Node. PostgreSQL is the authority for all
  four races, which is what makes a second API instance safe.
- ZATCA Phase 2 is untouched. The sale and invoice rows keep the shape that
  pipeline will need; nothing here claims a reported invoice was produced.
EOF

say "Test sources join the typecheck"

# The defect this closes: `tsc` is configured per workspace to exclude
# __tests__, because a test must not land in a published dist. Vitest strips
# types rather than checking them, so a test file could import a name its
# package does not export and nothing in the gate would notice — which is
# exactly what happened to the first cut of this strike.
#
# A no-emit project over the test sources alone fixes it without touching what
# the build produces.
cat << 'EOF' > tsconfig.tests.json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "noUnusedLocals": false,
    "noUnusedParameters": false
  },
  "include": [
    "apps/*/src/**/__tests__/**/*.ts",
    "apps/*/src/**/*.test.ts",
    "packages/*/src/**/__tests__/**/*.ts",
    "packages/*/src/**/*.test.ts"
  ]
}
EOF

python3 - <<'PY'
import json, sys
path = 'package.json'
data = json.load(open(path, encoding='utf-8'))
scripts = data['scripts']
if 'typecheck:tests' in scripts:
    print('  script already present'); sys.exit(0)
ordered = {}
for key, value in scripts.items():
    ordered[key] = value
    if key == 'typecheck':
        ordered['typecheck:tests'] = 'tsc -p tsconfig.tests.json'
data['scripts'] = ordered
open(path, 'w', encoding='utf-8').write(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
print('  typecheck:tests script added')
PY

python3 - <<'PY'
import sys
path = 'scripts/verify.sh'
s = open(path, encoding='utf-8').read()
if 'typecheck:tests' in s:
    print('  gate step already present'); sys.exit(0)
old = """step "Typecheck"
npm run --silent typecheck
"""
new = """step "Typecheck"
npm run --silent typecheck

# Separately, because every workspace excludes its tests from the build: a test
# that imports a name its package does not export must fail the gate, not the
# reviewer.
step "Typecheck (tests)"
npm run --silent typecheck:tests
"""
if old not in s:
    sys.stderr.write('Could not find the typecheck step in scripts/verify.sh.\n'); sys.exit(1)
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  gate step added')
PY

# Three baseline test helpers took their parameter as `typeof A`, which under
# `as const` is the literal type of fixture A and nothing else. Every call with
# B, C or D was an error nobody could see, because these files were never
# typechecked. The parameter wants the shape, not that one value.
python3 - <<'PY'
paths = [
    'apps/api/src/__tests__/auth-live.test.ts',
    'packages/database/src/__tests__/auth-live.test.ts',
    'packages/database/src/__tests__/rls-live.test.ts',
]
for path in paths:
    s = open(path, encoding='utf-8').read()
    if 'typeof A' not in s:
        print('  %s already widened' % path); continue
    s = s.replace('t: typeof A', 't: Readonly<Record<keyof typeof A, string>>')
    open(path, 'w', encoding='utf-8').write(s)
    print('  %s widened' % path)
PY

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

say "Reference documents unchanged?"
[ "$(cksum < docs/design/KORVI-DESIGN-SYSTEM.md)" = "$REF_DESIGN_SUM" ] \
  || die "docs/design/KORVI-DESIGN-SYSTEM.md changed. Aborting."
[ "$(cksum < docs/governance/Korvi_POS_Master_Strategy_Document.txt)" = "$REF_STRAT_SUM" ] \
  || die "docs/governance/Korvi_POS_Master_Strategy_Document.txt changed. Aborting."
ok "reference documents intact"

say "Committed migrations untouched?"
[ "$(cksum < "$STRIKE_2A_MIGRATION")" = "$SUM_2A" ] \
  || die "The Strike 2A migration was modified. That file is history."
[ "$(cksum < "$STRIKE_2B_MIGRATION")" = "$SUM_2B" ] \
  || die "The Strike 2B migration was modified. That file is history."
ok "both migrations byte-identical"

say "No new migration was needed"
# Strike 3A-1 adds no column and no table: the receipt number, the fingerprint
# column and the inventory model all already exist. A migration that changes
# nothing is a migration to maintain for no reason.
NEW_MIGRATIONS="$(find packages/database/prisma/migrations -maxdepth 1 -type d -name '2026*' | wc -l | tr -d ' ')"
[ "$NEW_MIGRATIONS" = "2" ] || die "Unexpected migration directory count: $NEW_MIGRATIONS"
ok "schema unchanged; no migration added"

say "Checking no secret and no float reached the new sources"
if grep -REq '(BEGIN [A-Z ]*PRIVATE KEY|sk_live_|AKIA[0-9A-Z]{16})' apps/api/src 2>/dev/null; then
  die "Something resembling a credential reached a source file."
fi
if grep -REq '(parseFloat|\.toFixed\()' apps/api/src/checkout 2>/dev/null; then
  die "Float arithmetic reached the checkout path (ADR-0002)."
fi
ok "no credential material, no float in the money path"

say "Formatting the new sources"
# Not silenced: a formatter that has something to say about a file this patch
# wrote is a thing to see, not to swallow.
npx prettier --write --log-level warn \
  'apps/api/src/**/*.ts' \
  'packages/database/src/**/*.ts' \
  'packages/domain/src/**/*.ts' \
  'docs/decisions/ADR-0013-checkout-transaction-and-idempotency.md' \
  tsconfig.tests.json package.json
npx prettier --check --log-level warn \
  'apps/api/src/**/*.ts' \
  'packages/database/src/**/*.ts' \
  'packages/domain/src/**/*.ts' \
  'docs/decisions/ADR-0013-checkout-transaction-and-idempotency.md' \
  tsconfig.tests.json package.json \
  || die "Sources are still unformatted after a write pass."

if [ "$RUN_VERIFY" -eq 1 ]; then
  say "Running the full gate"
  npm run --silent verify
else
  warn "Skipping verification (--no-verify)."
fi

cat << 'SUMMARY'

===============================================================================
  Korvi POS — Strike 3A-1 · cashier server vertical applied
===============================================================================

  GET  /v1/products              product.read. Bounded listing and search:
                                 a barcode-shaped term is an exact lookup
                                 first, everything else is anchored on the
                                 existing (tenantId, nameAr) / (tenantId, sku)
                                 indexes and on codeReverse for suffix
                                 queries. Inactive products never reach a till.

  GET  /v1/shifts/current        shift.open. The open shift on a terminal.
  POST /v1/shifts/open           shift.open. The branch comes from the
                                 terminal and the cashier from the session;
                                 naming either in the body is a 400.

  POST /v1/sales                 sale.create. The authoritative cash sale.

  The pipeline: session -> permission -> open shift -> idempotency check ->
  authoritative product and settings load -> stock policy -> priceCart ->
  settle -> one transaction (sale, lines, tender, invoice, tax breakdown,
  stock movement, drawer movement, idempotency reservation) -> audit.

  Receipt numbering is allocated inside that transaction under
  SELECT ... FOR UPDATE on the branch row, so two tills never collide and
  never share a number. A rolled-back checkout hands its number on, leaving
  no gap. See ADR-0013.

  Idempotency compares a SHA-256 fingerprint of the intent — branch,
  terminal, sorted product/quantity pairs, cash received — against the
  existing requestHash column. Same key and same intent replays the sale and
  writes nothing; same key and different intent is a 409. Under true
  concurrency the reservation is an INSERT ... ON CONFLICT DO NOTHING
  RETURNING inside the sale transaction, so the loser waits for the winner and
  then answers from what it committed. No unique-constraint error reaches HTTP.

  Stock is enforced by the decrement itself:

    UPDATE inventory_balances SET quantityScaled = quantityScaled + $delta
     WHERE ... AND quantityScaled + $delta >= 0 RETURNING quantityScaled

  so the last unit on a shelf is sold exactly once, and the loser's whole
  transaction rolls back. The shift is revalidated under its own row lock
  inside that transaction, and opening a shift serialises on the terminal row.

  Live suite is opt-in and skips loudly:

    KORVI_TEST_DATABASE_URL=postgresql://korvi@localhost:5432/korvi_pos_test \
      npx vitest run apps/api/src/__tests__/checkout-live.test.ts

  No UI, no card or split tender, no returns, no discounts, no offline, no
  ZATCA reporting. Those are later strikes; 3A-2 is the cashier interface.

  Nothing was committed, pushed, reset or cleaned.

===============================================================================
SUMMARY

ok "Done."
