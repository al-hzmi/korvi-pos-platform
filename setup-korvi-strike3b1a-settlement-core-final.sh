#!/usr/bin/env bash
#
# setup-korvi-strike3b1a-settlement-core.sh — Korvi POS · Strike 3B-1a
#
# The settlement half of the commercial financial core, on top of Strike 3A-2
# (main @ 12b7f23):
#
#   discounts        line and basket, rate and fixed, server-authorised
#   split tender     one sale, several tenders, change only ever from cash
#   electronic       an externally approved payment, recorded — never processed
#
# POST /v1/sales keeps the cash-only shape the 3A-2 browser sends today and
# normalises it into the same settlement engine. One engine, two request
# shapes, no second checkout path.
#
# Returns, refunds, drawer movements and shift close are Strike 3B-1b.
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

# No bypass flags. This patch touches the arithmetic that decides what a
# customer is charged; a switch that skips its own gate has no business here.
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg
     This artifact has no bypass modes. Commit or stash your work and re-run." ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Not inside a git repository."
cd "$ROOT"

[ "$(node -p "require('./package.json').name" 2>/dev/null)" = "korvi-pos-platform" ] \
  || die "This is not korvi-pos-platform. Refusing to patch an unexpected repository."

BASELINE=12b7f23
if git cat-file -e "${BASELINE}^{commit}" 2>/dev/null; then
  git merge-base --is-ancestor "$BASELINE" HEAD 2>/dev/null \
    || die "HEAD does not descend from $BASELINE."
else
  die "Commit $BASELINE is not in this repository. Fetch origin/main first."
fi

MIG_2A=packages/database/prisma/migrations/20260808120000_saas_foundation/migration.sql
MIG_2B=packages/database/prisma/migrations/20260810120000_auth_security/migration.sql
NEW_MIGRATION=packages/database/prisma/migrations/20260816120000_commercial_settlement

for required in \
  "$MIG_2A" "$MIG_2B" \
  packages/domain/src/pricing/line.ts \
  packages/domain/src/tender/tender.ts \
  packages/domain/src/sale/finalize.ts \
  packages/domain/src/money/allocate.ts \
  packages/domain/src/ports/persistence.ts \
  packages/database/prisma/schema.prisma \
  packages/database/src/repositories/sale-repository.ts \
  apps/api/src/checkout/service.ts \
  apps/api/src/checkout/fingerprint.ts \
  apps/api/src/routes/validation.ts \
  apps/api/src/routes/business.ts \
  apps/api/src/__tests__/support/memory-business.ts \
  apps/pos-web/src/lib/api.ts \
  docs/decisions/ADR-0013-checkout-transaction-and-idempotency.md \
  docs/decisions/ADR-0014-same-origin-browser-topology.md \
  tsconfig.tests.json
do
  [ -f "$required" ] || die "Baseline file missing: $required
     This patch expects Strike 3A-2 (main @ $BASELINE)."
done

grep -q 'ownBranchTerminal'     apps/api/src/routes/business.ts   || die "Strike 3A-2 branch guard missing; baseline mismatch."
grep -q 'export function settle' packages/domain/src/tender/tender.ts || die "settle() missing."
grep -q 'export function priceCart' packages/domain/src/pricing/line.ts || die "priceCart() missing."
grep -q 'assertDiscountsPermitted' packages/domain/src/sale/finalize.ts || die "Discount ceiling missing."
grep -q 'CREATE TABLE "tenders"'  "$MIG_2A" || die "tenders table missing; baseline mismatch."
grep -q 'CREATE TABLE "sale_discounts"' "$MIG_2A" || die "sale_discounts table missing; baseline mismatch."
grep -q 'ALTER TABLE "tenders" ENABLE ROW LEVEL SECURITY' "$MIG_2A" || die "RLS on tenders missing."
grep -q 'ALTER TABLE "sale_discounts" ENABLE ROW LEVEL SECURITY' "$MIG_2A" || die "RLS on sale_discounts missing."

[ -d "$NEW_MIGRATION" ] && die "$NEW_MIGRATION already exists. This patch creates it."

# Both committed migrations are history. Nothing here may edit either.
SUM_2A="$(cksum < "$MIG_2A")"
SUM_2B="$(cksum < "$MIG_2B")"
REF_DESIGN_SUM="$(cksum < docs/design/KORVI-DESIGN-SYSTEM.md)"
REF_ADR13_SUM="$(cksum < docs/decisions/ADR-0013-checkout-transaction-and-idempotency.md)"
REF_ADR14_SUM="$(cksum < docs/decisions/ADR-0014-same-origin-browser-topology.md)"
# The browser is not part of this strike. Its sources must come out unchanged.
SUM_POSWEB="$(find apps/pos-web/src -type f -name '*.ts*' -print0 | sort -z | xargs -0 cksum | cksum)"

# Every path this script may write to. The pin step below can rewrite the
# database package manifest and the lockfile, so both are guarded too: a file
# the patch edits but the guard does not name is a file somebody loses work in.
OWNED_PATHS="
packages/domain/src
packages/database/src
packages/database/prisma
packages/database/package.json
package-lock.json
apps/api/src
docs/decisions
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

mkdir -p packages/domain/src/pricing/__tests__ packages/domain/src/tender/__tests__ \
         packages/database/src/__tests__ apps/api/src/__tests__ "$NEW_MIGRATION"

say "Domain — what a tender is allowed to be"

python3 - <<'PY'
import sys
path = 'packages/domain/src/errors.ts'
s = open(path, encoding='utf-8').read()
if 'InvalidTenderError' in s:
    print('  already present'); sys.exit(0)

s = s.rstrip('\n') + """

/**
 * A tender the settlement engine will not accept as stated.
 *
 * Distinct from UnderpaidError and NonCashChangeError, which are about the
 * arithmetic of a well-formed payment. This one is about the payment being
 * ill-formed before any arithmetic runs: a zero tender, two cash tenders, an
 * electronic tender with nothing to reconcile it against.
 */
export class InvalidTenderError extends DomainError {
  public override readonly name = 'InvalidTenderError';
}
"""
open(path, 'w', encoding='utf-8').write(s)
print('  InvalidTenderError added')
PY

python3 - <<'PY'
import sys
path = 'packages/domain/src/tender/tender.ts'
s = open(path, encoding='utf-8').read()
if 'ELECTRONIC_SCHEMES' in s:
    print('  already present'); sys.exit(0)

old = """export type TenderKind = 'cash' | 'card' | 'mada' | 'transfer';"""
new = """/**
 * How the money arrived.
 *
 * `electronic` is the shape this system actually supports: a payment that was
 * approved somewhere else — a Mada terminal, a wallet, an acquirer — and is
 * being recorded here as settled. Korvi does not contact a bank, a scheme or a
 * gateway, and nothing in this module should ever be read as claiming it did.
 *
 * `card`, `mada` and `transfer` predate that and remain legal so already
 * committed rows stay readable. No route produces them; new payments are
 * `electronic` with a scheme beside them, which is what lets a merchant see
 * "Mada" and "Visa" apart in a report without inventing a tender kind each
 * time a scheme is added.
 */
export type TenderKind = 'cash' | 'card' | 'mada' | 'transfer' | 'electronic';

/**
 * The schemes a cashier may record against an electronic tender.
 *
 * A closed list on purpose. It is a label on a settlement record, so an open
 * string would put unbounded operator text into a financial row and into every
 * report built on it.
 */
export const ELECTRONIC_SCHEMES = [
  'mada',
  'visa',
  'mastercard',
  'amex',
  'apple-pay',
  'other',
] as const;

export type TenderScheme = (typeof ELECTRONIC_SCHEMES)[number];

export function isElectronicScheme(value: string): value is TenderScheme {
  return (ELECTRONIC_SCHEMES as readonly string[]).includes(value);
}

/**
 * How long an external reference may be.
 *
 * Bounded because it is operator-supplied and lands in a financial row: an
 * unbounded field is a denial of service against every report that renders it.
 */
export const MAX_TENDER_REFERENCE_LENGTH = 64;

/**
 * Does this look like a card number rather than an approval code?
 *
 * Refusing fields *named* `pan` or `cardNumber` is necessary and nowhere near
 * sufficient: a broken integration will happily put a card number in a field
 * called `reference`, and Korvi would store it. So the value is inspected as
 * well as the key.
 *
 * Conservative on purpose. 13 to 19 digits that also satisfy Luhn is the
 * shape of a payment card and almost nothing else; ordinary approval codes
 * carry letters, or are shorter, or fail the checksum. A false positive costs
 * a cashier one re-key. A false negative costs the merchant a PCI incident.
 *
 * Spaces and hyphens are normalised for inspection only. The value itself is
 * never rewritten, never logged and never echoed back — a refusal that quotes
 * the number defeats the purpose.
 */
export function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^[0-9]{13,19}$/.test(digits)) return false;

  // Luhn, right to left, integer arithmetic only.
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}"""
assert old in s
s = s.replace(old, new, 1)

old = """export interface TenderLine {
  readonly kind: TenderKind;
  readonly amount: Money;
}"""
new = """export interface TenderLine {
  readonly kind: TenderKind;
  readonly amount: Money;
  /** Present on `electronic` and on nothing else. */
  readonly scheme?: TenderScheme;
  /** The external approval this settlement record points at. */
  readonly reference?: string;
}"""
assert old in s
s = s.replace(old, new, 1)

GUARD = '''
/**
 * Everything about a tender list that is wrong before the arithmetic starts.
 *
 * `settle` answers "does this add up". This answers "is this a payment at
 * all", and it lives in the domain rather than in a route because the rules
 * are commercial, not transport: a till, an integration and a repair script
 * must all be refused the same things.
 *
 * The rules, and why each one:
 *
 *   One cash tender. Two cash lines on one sale is a drawer that cannot be
 *   reconciled — the change has to come out of one of them and there is no
 *   fact that says which.
 *
 *   No zero tender. A zero line is either a mistake or an attempt to record a
 *   payment method that was not used, and both end up on a receipt.
 *
 *   Electronic carries a scheme and a reference; cash carries neither. A cash
 *   tender with an approval code is describing something that did not happen.
 *
 *   No repeated (scheme, reference). Two lines pointing at one approval is a
 *   double-count of somebody else's transaction. Two different references on
 *   the same scheme are fine — a customer may present two cards.
 *
 * Called by `finalizeSale`, not by `settle`: `settle` is the arithmetic and
 * still has to read tenders written before this vocabulary existed.
 */
export function assertTenderComposition(lines: readonly TenderLine[]): void {
  if (lines.length === 0) {
    throw new InvalidTenderError('A sale needs at least one tender.');
  }

  let cashCount = 0;
  const seen = new Set<string>();

  for (const line of lines) {
    if (line.amount.minor <= 0n) {
      throw new InvalidTenderError('A tender must be a positive amount.');
    }

    if (line.kind === 'cash') {
      cashCount += 1;
      if (cashCount > 1) {
        throw new InvalidTenderError('A sale may carry at most one cash tender.');
      }
      if (line.scheme !== undefined || line.reference !== undefined) {
        throw new InvalidTenderError('A cash tender carries no scheme and no reference.');
      }
      continue;
    }

    if (line.kind !== 'electronic') {
      // The legacy kinds are readable, not writable.
      throw new InvalidTenderError(`Tender kind "${line.kind}" may no longer be recorded.`);
    }

    if (line.scheme === undefined) {
      throw new InvalidTenderError('An electronic tender must name its scheme.');
    }
    const reference = line.reference ?? '';
    if (reference.trim() === '') {
      throw new InvalidTenderError('An electronic tender must carry an external reference.');
    }
    if (reference.length > MAX_TENDER_REFERENCE_LENGTH) {
      throw new InvalidTenderError('The external reference is too long.');
    }
    if (looksLikeCardNumber(reference)) {
      // Deliberately says nothing about the value. The message is read by a
      // developer fixing an integration, and it must not become the place a
      // card number gets written down.
      throw new InvalidTenderError('The external reference must not be a card number.');
    }

    const key = `${line.scheme}:${reference}`;
    if (seen.has(key)) {
      throw new InvalidTenderError('The same approval reference appears twice.');
    }
    seen.add(key);
  }
}
'''

anchor = "export function settle(due: Money, lines: readonly TenderLine[]): Settlement {"
assert anchor in s
s = s.replace(anchor, GUARD.strip() + '\n\n' + anchor, 1)

s = s.replace(
    "import { NonCashChangeError, UnderpaidError } from '../errors.js';",
    "import { InvalidTenderError, NonCashChangeError, UnderpaidError } from '../errors.js';",
    1,
)

# Deliberately NOT called from settle(). That function is the arithmetic —
# "does this add up" — and it still has to read rows written before this
# vocabulary existed. Composition is a commercial rule, so it is enforced at
# the commercial entry point, finalizeSale.

open(path, 'w', encoding='utf-8').write(s)
print('  tender composition rules added')
PY

say "Domain — a discount ceiling that rounding cannot walk through"

cat << 'EOF' > packages/domain/src/pricing/discount-authority.ts
import { BASIS_POINT_SCALE } from '../tax/basis-points.js';

/**
 * How much of a base a discount actually took, expressed as a rate.
 *
 * The authorisation a principal carries is a rate — `maxDiscountBasisPoints` —
 * but a cashier may also grant a fixed amount off, and the two have to be
 * comparable or the ceiling means nothing against half the discounts a shop
 * gives. So a fixed discount is converted to the rate it is equivalent to,
 * against the base it was taken from.
 *
 * Rounded UP, and that is the whole point of this function existing.
 *
 * Truncating division is the obvious way to write it and it is wrong in a way
 * nobody notices: a cashier authorised to 1000 bp on a base of 1999 halalas
 * may take 200 halalas, because 200 x 10000 / 1999 truncates to 1000. The real
 * rate is 1000.5 bp. One halala over the ceiling every time, granted by the
 * rounding rather than by the merchant — and repeatable, so it is a policy the
 * merchant never set. Rounding up means the ceiling is the ceiling.
 *
 * Integer arithmetic throughout. A rate computed through a float would drift
 * exactly where this is trying to be exact (ADR-0002).
 */
export function effectiveDiscountBasisPoints(grantedMinor: bigint, eligibleBase: bigint): bigint {
  if (grantedMinor <= 0n) return 0n;
  if (eligibleBase <= 0n) {
    // Something was discounted out of nothing. There is no rate that describes
    // that, and reporting zero would authorise it.
    return BASIS_POINT_SCALE + 1n;
  }
  const numerator = grantedMinor * BASIS_POINT_SCALE;
  // Ceiling division, written the integer way: no Math, no float, no rounding
  // mode to get wrong.
  return (numerator + eligibleBase - 1n) / eligibleBase;
}

/**
 * May this principal grant this discount against this base?
 *
 * `ceiling` comes from the session — the database decided it when the roles
 * were resolved — and never from the request. A browser that could send its
 * own ceiling would be authorising itself.
 */
export function isDiscountAuthorized(
  grantedMinor: bigint,
  eligibleBase: bigint,
  ceilingBasisPoints: bigint,
): boolean {
  if (grantedMinor <= 0n) return true;
  return effectiveDiscountBasisPoints(grantedMinor, eligibleBase) <= ceilingBasisPoints;
}
EOF

python3 - <<'PY'
import sys
path = 'packages/domain/src/pricing/index.ts'
s = open(path, encoding='utf-8').read()
if 'discount-authority' in s:
    print('  already exported'); sys.exit(0)
s = s.rstrip('\n') + "\nexport * from './discount-authority.js';\n"
open(path, 'w', encoding='utf-8').write(s)
print('  discount authority exported')
PY

python3 - <<'PY'
import sys
path = 'packages/domain/src/errors.ts'
s = open(path, encoding='utf-8').read()
if 'InvalidDiscountError' in s:
    print('  already present'); sys.exit(0)
s = s.rstrip('\n') + """

/**
 * A discount that is not economically possible.
 *
 * Distinct from DiscountNotPermittedError, which is about authority. This one
 * is about the request itself: more off a line than the line is worth.
 * `applyDiscount` caps such a value to its base, which is right for pricing
 * and wrong for authorisation — capping answers a request nobody made, at a
 * price the cashier never quoted.
 */
export class InvalidDiscountError extends DomainError {
  public override readonly name = 'InvalidDiscountError';
}
"""
open(path, 'w', encoding='utf-8').write(s)
print('  InvalidDiscountError added')
PY

say "Domain — a discount is measured against the base it is taken from"

# Written out first, so the replacement below is a file rather than a string
# nested three quoting levels deep. Removed again at the end of the block.
POLICY_FILE="$(mktemp)"
cat << 'EOF' > "$POLICY_FILE"
/**
 * The base a discount is measured against is the base it is taken from.
 *
 * This is the whole of the rule. Comparing every discount against the *cart*
 * gross lets a fixed amount destroy a small line and still look modest: a
 * manager capped at 2000 bp, given a 10.00 line beside a 90.00 line, could
 * take 10.00 off the small one — a 100 per cent discount on that line —
 * because 10.00 of a 100.00 cart reads as 1000 bp. The ceiling has to mean the
 * same thing wherever the discount lands, so each scope is checked against its
 * own base:
 *
 *   a line discount, against that line's undiscounted extended price;
 *   a basket discount, against the basket *after* line discounts, because that
 *     is the base priceCart actually applies it to;
 *   and then everything together, against the undiscounted cart gross, so
 *     several individually-legal discounts cannot be stacked into an illegal
 *     one.
 *
 * A requested rate is checked as a rate before any of that, because rounding
 * hides it otherwise: 2001 bp off 23.00 is 4.6023, which rounds to 4.60 — and
 * 4.60 reads back as exactly 2000 bp. The merchant set a rate; the rate is
 * what is checked.
 */
function assertDiscountsPermitted(input: FinalizeSaleInput): void {
  const ceiling = input.maxDiscountBasisPoints;

  function refuseRate(requested: bigint, scope: string): void {
    if (requested > ceiling) {
      throw new DiscountNotPermittedError(
        `A ${requested.toString()} bp ${scope} discount exceeds the ${ceiling.toString()} bp this user may grant.`,
      );
    }
  }

  function refuseAmount(amount: bigint, base: bigint, scope: string): void {
    // Rejected, not capped. applyDiscount would clamp this to the base, which
    // is correct for pricing and wrong here: clamping answers a request nobody
    // made, at a price the cashier never quoted.
    if (amount > base) {
      throw new InvalidDiscountError(
        `A ${scope} discount of ${amount.toString()} exceeds the ${base.toString()} it is taken from.`,
      );
    }
    if (!isDiscountAuthorized(amount, base, ceiling)) {
      const effective = effectiveDiscountBasisPoints(amount, base);
      throw new DiscountNotPermittedError(
        `A ${scope} discount of ${effective.toString()} bp exceeds the ${ceiling.toString()} bp this user may grant.`,
      );
    }
  }

  // --- each line, against its own extended price --------------------------
  let eligibleBasketBase = 0n;
  for (const line of input.cart.lines) {
    const gross = extendedPrice(line.unitPrice, line.quantity);
    const discount = line.discount ?? NO_DISCOUNT;

    if (discount.kind === 'percentage') {
      refuseRate(discount.value, 'line');
    } else if (discount.kind === 'fixed') {
      refuseAmount(discount.value, gross.minor, 'line');
    }

    // What a basket discount will actually be applied to.
    eligibleBasketBase += gross.minor - applyDiscount(gross, discount).minor;
  }

  // --- the basket, against what the lines left behind ---------------------
  const basket = input.cart.basketDiscount;
  if (basket !== undefined && basket.kind !== 'none') {
    if (basket.kind === 'percentage') {
      refuseRate(basket.value, 'basket');
    } else {
      refuseAmount(basket.value, eligibleBasketBase, 'basket');
    }
  }

  // --- and everything together, against the undiscounted cart -------------
  //
  // `exactOptionalPropertyTypes` is on, so the discount keys are removed
  // rather than set to undefined -- an absent key and a present undefined are
  // different things under that flag, and only the former means "no discount".
  const undiscounted = priceCart({
    priceMode: input.cart.priceMode,
    ...(input.cart.currency === undefined ? {} : { currency: input.cart.currency }),
    lines: input.cart.lines.map((line) => {
      const { discount: _discount, ...rest } = line;
      return rest;
    }),
  });

  const priced = priceCart(input.cart);
  const granted = priced.lineDiscountTotal.minor + priced.basketDiscountTotal.minor;
  if (granted === 0n) return;

  if (undiscounted.gross.minor === 0n) {
    throw new InvalidAmountError('Cannot discount a cart with no value.');
  }

  // Rounded up, not truncated: 200 halalas off 1999 is 1000.5 bp, and a
  // cashier capped at 1000 bp would otherwise be given it every time.
  const grantedBp = effectiveDiscountBasisPoints(granted, undiscounted.gross.minor);
  if (!isDiscountAuthorized(granted, undiscounted.gross.minor, ceiling)) {
    throw new DiscountNotPermittedError(
      `Discounts totalling ${grantedBp.toString()} bp exceed the ${ceiling.toString()} bp this user may grant.`,
    );
  }
}
EOF


POLICY_FILE="$POLICY_FILE" python3 - <<'PY'
import os, sys
path = 'packages/domain/src/sale/finalize.ts'
s = open(path, encoding='utf-8').read()
if 'eligibleBasketBase' in s:
    print('  already patched'); sys.exit(0)

s = s.replace(
    "import { priceCart } from '../pricing/line.js';",
    "import { NO_DISCOUNT, applyDiscount, extendedPrice, priceCart } from '../pricing/line.js';\n"
    "import {\n"
    "  effectiveDiscountBasisPoints,\n"
    "  isDiscountAuthorized,\n"
    "} from '../pricing/discount-authority.js';\n"
    "import { assertTenderComposition } from '../tender/tender.js';",
    1,
)
s = s.replace(
    "import { DomainError, InvalidAmountError } from '../errors.js';",
    "import { DomainError, InvalidAmountError, InvalidDiscountError } from '../errors.js';",
    1,
)

old = """  const priced = priceCart(input.cart);
  if (priced.total.minor <= 0n) {
    throw new InvalidAmountError('A finalized sale must have a positive total.');
  }

  const settlement = settle(priced.total, input.tenders);"""
new = """  const priced = priceCart(input.cart);
  if (priced.total.minor <= 0n) {
    throw new InvalidAmountError('A finalized sale must have a positive total.');
  }

  // Composition before settlement: a zero tender, a second cash line or an
  // electronic line with no approval behind it is not a payment to settle.
  // After the cart, so a basket that priced to nothing is still reported as
  // the cart problem it is.
  assertTenderComposition(input.tenders);

  const settlement = settle(priced.total, input.tenders);"""
assert old in s, 'settle anchor'
s = s.replace(old, new, 1)

start = s.index('function assertDiscountsPermitted(input: FinalizeSaleInput): void {')
end = s.index('/**\n * Reconciliation invariant, assertable at any point.')
policy = open(os.environ['POLICY_FILE'], encoding='utf-8').read()
s = s[:start] + policy + s[end:]
open(path, 'w', encoding='utf-8').write(s)
print('  discount authority measured against the right base')
PY
rm -f "$POLICY_FILE"

say "Domain — the existing sale tests speak the new tender vocabulary"

python3 - <<'PY'
import re, sys
path = 'packages/domain/src/sale/__tests__/finalize.test.ts'
s = open(path, encoding='utf-8').read()
if "kind: 'electronic'" in s:
    print('  already updated'); sys.exit(0)

# `card`, `mada` and `transfer` remain readable but are no longer writable:
# a new payment is `electronic` and names its scheme and its approval.
def electronic(match):
    scheme = match.group(1)
    amount = match.group(2)
    mapped = 'mada' if scheme == 'mada' else 'visa'
    return (
        "{ kind: 'electronic', scheme: '%s', reference: 'AUTH-%s', amount: money(%sn) }"
        % (mapped, amount.replace('_', ''), amount)
    )

s = re.sub(r"\{ kind: '(card|mada|transfer)', amount: money\(([0-9_]+)n\) \}", electronic, s)
open(path, 'w', encoding='utf-8').write(s)
print('  finalize tests updated')
PY

say "Database — one forward migration for the settlement facts"

cat << 'EOF' > packages/database/prisma/migrations/20260816120000_commercial_settlement/migration.sql
-- Korvi POS — Strike 3B-1a · commercial settlement
--
-- Two columns, and the constraints that make them mean something.
--
-- No new table. `tenders` and `sale_discounts` were created in the SaaS
-- foundation with RLS ENABLEd and FORCEd, deny-by-default policies, and
-- composite tenant-consistent foreign keys to `sales`. A settlement is a fact
-- about a sale, not an entity of its own, so it belongs on those rows — and
-- extending them inherits the whole tenancy boundary rather than re-deriving
-- it (ADR-0004).
--
-- Forward only. The two committed migrations are history and are not touched.

-- --------------------------------------------------------------------------
-- Tenders: how the money actually arrived
-- --------------------------------------------------------------------------

ALTER TABLE "tenders" ADD COLUMN "scheme" TEXT;

-- `electronic` is the kind a till may write from now on: a payment approved
-- somewhere else and recorded here as settled. The older kinds stay legal so
-- rows already committed remain readable; nothing produces them any more.
ALTER TABLE "tenders" DROP CONSTRAINT "tenders_kind";
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_kind"
  CHECK ("kind" IN ('cash', 'card', 'mada', 'transfer', 'electronic'));

-- A closed list. The scheme is a label on a financial row and appears in every
-- report built on it, so it is not a free-text field an operator can invent.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_scheme_values"
  CHECK ("scheme" IS NULL OR "scheme" IN ('mada', 'visa', 'mastercard', 'amex', 'apple-pay', 'other'));

-- An electronic settlement names its scheme, and nothing else may carry one.
-- Written as an equality between two booleans so both directions hold: no
-- electronic tender without a scheme, no cash tender wearing one.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_scheme_electronic_only"
  CHECK (("kind" = 'electronic') = ("scheme" IS NOT NULL));

-- The reference points at an approval that happened elsewhere. It is the only
-- thing tying this row to that event, so an electronic tender must have one —
-- and it is operator-supplied, so it is bounded.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_electronic_reference"
  CHECK ("kind" <> 'electronic' OR ("reference" IS NOT NULL AND btrim("reference") <> ''));
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_reference_bounded"
  CHECK ("reference" IS NULL OR char_length("reference") <= 64);

-- A tender of nothing is not a payment. The original constraint allowed zero,
-- which let a sale carry a line describing a method that was never used.
ALTER TABLE "tenders" DROP CONSTRAINT "tenders_amount_non_negative";
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_amount_positive" CHECK ("amountMinor" > 0);

-- Change comes out of the drawer, so it can never exceed what went into it.
-- The existing tenders_change_cash_only says only cash may carry change; this
-- says it may not carry more than it was given.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_change_within_amount"
  CHECK ("changeMinor" <= "amountMinor");

-- A cash tender carries no approval code, because there is nothing external
-- to point at. Written so the legacy non-cash kinds stay readable.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_cash_no_reference"
  CHECK ("kind" <> 'cash' OR "reference" IS NULL);

-- The two composition rules the domain enforces, enforced again here.
--
-- Defence in depth, and the depth matters: the domain refuses these first, so
-- an ordinary checkout never meets a unique violation. What these stop is
-- everything that is not an ordinary checkout — a repair script, a migration,
-- an integration written against the tables.
--
-- One cash tender per sale: two cash lines is a drawer nobody can reconcile,
-- because the change has to come out of one of them and no fact says which.
CREATE UNIQUE INDEX "tenders_one_cash_per_sale"
  ON "tenders"("tenantId", "saleId") WHERE "kind" = 'cash';

-- One approval counted once: two rows pointing at one authorisation is a
-- double-count of somebody else's transaction.
CREATE UNIQUE INDEX "tenders_one_approval_per_sale"
  ON "tenders"("tenantId", "saleId", "scheme", "reference") WHERE "kind" = 'electronic';

CREATE INDEX "tenders_tenantId_scheme_idx" ON "tenders"("tenantId", "scheme");

-- --------------------------------------------------------------------------
-- Sale discounts: enough to explain a receipt years later
-- --------------------------------------------------------------------------

-- The receipt has to be explainable from what was written, not from replaying
-- today's pricing rules against a catalogue that has moved on.
ALTER TABLE "sale_discounts" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "sale_discounts" ADD CONSTRAINT "sale_discounts_input_non_negative"
  CHECK ("inputValue" >= 0);

-- A rate discount is basis points and cannot exceed the whole thing.
ALTER TABLE "sale_discounts" ADD CONSTRAINT "sale_discounts_rate_bounded"
  CHECK ("kind" <> 'percentage' OR "inputValue" <= 10000);

-- A line discount names its line; a basket discount does not have one.
ALTER TABLE "sale_discounts" ADD CONSTRAINT "sale_discounts_line_scope"
  CHECK (("scope" = 'line') = ("lineNumber" IS NOT NULL));

-- Who granted it, tenant-consistently. A discount attributed to a user in
-- another tenant is not an audit trail, and a plain reference to users(id)
-- would permit exactly that (ADR-0004).
ALTER TABLE "sale_discounts" ADD CONSTRAINT "sale_discounts_tenantId_grantedByUserId_fkey"
  FOREIGN KEY ("tenantId", "grantedByUserId") REFERENCES "users"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "sale_discounts_tenantId_grantedByUserId_idx"
  ON "sale_discounts"("tenantId", "grantedByUserId");
EOF

python3 - <<'PY'
import sys
path = 'packages/database/prisma/schema.prisma'
s = open(path, encoding='utf-8').read()
if 'scheme' in s and 'saleDiscounts' in s:
    print('  already updated'); sys.exit(0)

old = """  /// 'cash' | 'card' | 'mada' | 'transfer'
  kind        String
  amountMinor BigInt
  /// Only cash can carry this above zero (ADR-0002).
  changeMinor BigInt @default(0)
  reference   String?"""
new = """  /// 'cash' | 'electronic'. 'card' | 'mada' | 'transfer' are legacy and
  /// readable, but no route writes them any more.
  kind        String
  /// 'mada' | 'visa' | 'mastercard' | 'amex' | 'apple-pay' | 'other'.
  /// Present on an electronic tender and on nothing else.
  scheme      String?
  amountMinor BigInt
  /// Only cash can carry this above zero (ADR-0002).
  changeMinor BigInt @default(0)
  /// The external approval this settlement record points at. Never a card
  /// number, never a PAN, never track data — see ADR-0015.
  reference   String?"""
assert old in s, 'tender columns'
s = s.replace(old, new, 1)

old = """  @@index([tenantId, saleId])
  @@index([tenantId, kind])
  @@map("tenders")"""
new = """  @@index([tenantId, saleId])
  @@index([tenantId, kind])
  @@index([tenantId, scheme])
  @@map("tenders")"""
assert old in s, 'tender indexes'
s = s.replace(old, new, 1)

old = """  reason      String?
  grantedByUserId String? @db.Uuid

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale   Sale   @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: Cascade)

  @@index([tenantId, saleId])
  @@map("sale_discounts")"""
new = """  reason      String?
  grantedByUserId String? @db.Uuid

  createdAt DateTime @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale   Sale   @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: Cascade)
  /// Tenant-consistent: a discount cannot be attributed to a user in another
  /// tenant, whatever the application believes (ADR-0004).
  grantedBy User? @relation(fields: [tenantId, grantedByUserId], references: [tenantId, id], onDelete: NoAction)

  @@index([tenantId, saleId])
  @@index([tenantId, grantedByUserId])
  @@map("sale_discounts")"""
assert old in s, 'sale discount columns'
s = s.replace(old, new, 1)

old = """  sales       Sale[]
  auditEvents AuditEvent[]"""
new = """  sales       Sale[]
  auditEvents AuditEvent[]
  saleDiscounts SaleDiscount[]"""
assert old in s, 'user back-relation'
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  schema updated')
PY

say "Domain — the tender record carries its scheme"

python3 - <<'PY'
import sys
path = 'packages/domain/src/ports/persistence.ts'
s = open(path, encoding='utf-8').read()
if 'TenderScheme' in s:
    print('  already present'); sys.exit(0)

s = s.replace(
    "import type { TenderKind } from '../tender/tender.js';",
    "import type { TenderKind, TenderScheme } from '../tender/tender.js';",
    1,
)
old = """export interface TenderRecord {
  readonly id: string;
  readonly kind: TenderKind;
  readonly amountMinor: string;
  readonly changeMinor: string;
  readonly reference: string | null;
}"""
new = """export interface TenderRecord {
  readonly id: string;
  readonly kind: TenderKind;
  /** Present on an electronic tender and null on cash. */
  readonly scheme: TenderScheme | null;
  readonly amountMinor: string;
  readonly changeMinor: string;
  /**
   * The external approval reference.
   *
   * Korvi records that a payment was approved elsewhere; it does not perform
   * one. This is the pointer back to whatever did — never a card number.
   */
  readonly reference: string | null;
}"""
assert old in s
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  TenderRecord.scheme added')
PY

say "Database — persist the scheme with the tender"

python3 - <<'PY'
import sys
path = 'packages/database/src/repositories/sale-repository.ts'
s = open(path, encoding='utf-8').read()
if 'scheme: tender.scheme' in s:
    print('  already persisted'); sys.exit(0)

old = """        await tx.tender.createMany({
          data: sale.tenders.map((tender) => ({
            id: tender.id,
            tenantId: tenant,
            saleId: sale.id,
            kind: tender.kind,
            amountMinor: BigInt(tender.amountMinor),
            changeMinor: BigInt(tender.changeMinor),
            reference: tender.reference,
          })),
        });"""
new = """        await tx.tender.createMany({
          data: sale.tenders.map((tender) => ({
            id: tender.id,
            tenantId: tenant,
            saleId: sale.id,
            kind: tender.kind,
            scheme: tender.scheme,
            amountMinor: BigInt(tender.amountMinor),
            changeMinor: BigInt(tender.changeMinor),
            reference: tender.reference,
          })),
        });"""
assert old in s, 'tender createMany'
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  tender scheme persisted')
PY

python3 - <<'PY'
import sys
path = 'packages/database/src/repositories/sale-repository.ts'
s = open(path, encoding='utf-8').read()
if 'tenders.scheme' in s:
    print('  already mapped'); sys.exit(0)

# `electronic` joins the readable kinds; the older three stay so rows written
# before this strike still map.
s = s.replace(
    "const TENDER_KINDS: readonly TenderKind[] = ['cash', 'card', 'mada', 'transfer'];",
    "const TENDER_KINDS: readonly TenderKind[] = [\n"
    "  'cash',\n"
    "  'card',\n"
    "  'mada',\n"
    "  'transfer',\n"
    "  'electronic',\n"
    "];\n"
    "const TENDER_SCHEMES: readonly TenderScheme[] = [...ELECTRONIC_SCHEMES];",
    1,
)
s = s.replace(
    "import { withTenant } from '../tenant-context.js';",
    "import { ELECTRONIC_SCHEMES } from '@korvi/domain';\nimport { withTenant } from '../tenant-context.js';",
    1,
)
s = s.replace("  TenderKind,", "  TenderKind,\n  TenderScheme,", 1)

s = s.replace(
    """interface TenderRow {
  id: string;
  kind: string;
  amountMinor: bigint;""",
    """interface TenderRow {
  id: string;
  kind: string;
  scheme: string | null;
  amountMinor: bigint;""",
    1,
)

# The read path has to hand the scheme back, or a replayed sale loses it.
old = """    kind: oneOf(TENDER_KINDS, row.kind, 'tenders.kind'),"""
new = """    kind: oneOf(TENDER_KINDS, row.kind, 'tenders.kind'),
    scheme: row.scheme === null ? null : oneOf(TENDER_SCHEMES, row.scheme, 'tenders.scheme'),"""
if old not in s:
    sys.stderr.write('Could not find the tender row mapping.\n'); sys.exit(1)
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  tender scheme mapped on read')
PY

say "Database — the Strike 2A record() test carries a scheme"

python3 - <<'PY'
import sys
path = 'packages/database/src/__tests__/repository-tenancy.test.ts'
s = open(path, encoding='utf-8').read()
if 'scheme:' in s:
    print('  already updated'); sys.exit(0)

old = "          { id: 'te1', kind: 'cash', amountMinor: '2000', changeMinor: '850', reference: null },"
new = ("          // Cash carries no scheme, and the record type now says so.\n"
       "          {\n"
       "            id: 'te1',\n"
       "            kind: 'cash',\n"
       "            scheme: null,\n"
       "            amountMinor: '2000',\n"
       "            changeMinor: '850',\n"
       "            reference: null,\n"
       "          },")
if old not in s:
    sys.stderr.write('Could not find the tender fixture in the tenancy test.\n'); sys.exit(1)
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  tenancy test tender updated')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/checkout-live.test.ts'
s = open(path, encoding='utf-8').read()
if 'scheme: null' in s:
    print('  already updated'); sys.exit(0)

old = "          { id: newId(), kind: 'cash', amountMinor: '1150', changeMinor: '0', reference: null },"
new = ("          {\n"
       "            id: newId(),\n"
       "            kind: 'cash',\n"
       "            scheme: null,\n"
       "            amountMinor: '1150',\n"
       "            changeMinor: '0',\n"
       "            reference: null,\n"
       "          },")
if old not in s:
    sys.stderr.write('Could not find the tender fixture in the live checkout test.\n'); sys.exit(1)
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  live checkout test tender updated')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/support/memory-business.ts'
s = open(path, encoding='utf-8').read()
if 'cashMovements' in s:
    print('  already recording'); sys.exit(0)

s = s.replace(
    """  public keys: IdempotencyRecord[] = [];""",
    """  public keys: IdempotencyRecord[] = [];
  /** Drawer effects, so a test can prove what a split payment did to the till. */
  public cashMovements: { kind: string; amountMinor: string; shiftId: string }[] = [];""",
    1,
)

old = """      store.sales.push(sale);"""
new = """      store.sales.push(sale);
      if (input.cashMovement !== null) {
        store.cashMovements.push({
          kind: input.cashMovement.kind,
          amountMinor: input.cashMovement.amountMinor,
          shiftId: input.cashMovement.shiftId,
        });
      }"""
if old not in s:
    sys.stderr.write('Could not find the sale push in the memory store.\n'); sys.exit(1)
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  memory store records drawer effects')
PY

say "API — what a checkout request may say"

python3 - <<'PY'
import sys
path = 'apps/api/src/routes/validation.ts'
s = open(path, encoding='utf-8').read()
if 'tenderBody' in s:
    print('  already present'); sys.exit(0)

BLOCK = '''
/** Basis points, as an integer. The same scale the domain and the database use. */
export const BASIS_POINTS = z.number().int().min(0).max(10_000);

export const MAX_TENDERS = 8;
export const MAX_TENDER_REFERENCE = 64;
export const MAX_DISCOUNT_REASON = 120;

/**
 * A payment that happened.
 *
 * `cash` is money in the drawer. `electronic` is a payment approved somewhere
 * else — a Mada terminal, a wallet, an acquirer — that Korvi is recording as
 * settled. Korvi does not talk to a bank, and this shape is careful not to
 * suggest it does: there is a scheme, there is somebody else's reference, and
 * there is nothing that could carry an instruction to move money.
 */
export const tenderBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cash'),
    amountMinor: MINOR,
  }),
  z.object({
    kind: z.literal('electronic'),
    amountMinor: MINOR,
    scheme: z.enum(['mada', 'visa', 'mastercard', 'amex', 'apple-pay', 'other']),
    reference: z.string().trim().min(1).max(MAX_TENDER_REFERENCE),
  }),
]);

/**
 * Card data this API refuses to receive.
 *
 * Rejected rather than ignored, and named in the response. A client sending a
 * PAN has a bug that will keep sending it, and the first person to find out
 * should be the developer rather than an auditor reading a database. Korvi is
 * not in the cardholder-data business and this is where that is enforced.
 */
export const FORBIDDEN_CARD_FIELDS = [
  'pan',
  'cardNumber',
  'card_number',
  'cardnumber',
  'cvv',
  'cvv2',
  'cvc',
  'track1',
  'track2',
  'trackData',
  'expiry',
  'expiryMonth',
  'expiryYear',
  'pin',
  'pinBlock',
  'emvData',
] as const;

/**
 * A discount as requested. What is granted is decided on the server.
 *
 * `rate` is basis points; `fixed` is halalas. Both are checked against the
 * principal's own ceiling before anything is priced, and a fixed amount is
 * converted to the rate it really represents so it cannot walk under the
 * ceiling (ADR-0015).
 */
export const discountBody = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('basis-points'),
    value: BASIS_POINTS,
    reason: z.string().trim().max(MAX_DISCOUNT_REASON).optional(),
  }),
  z.object({
    mode: z.literal('fixed'),
    amountMinor: MINOR,
    reason: z.string().trim().max(MAX_DISCOUNT_REASON).optional(),
  }),
]);
'''

anchor = "export const productQuery = z.object({"
assert anchor in s
s = s.replace(anchor, BLOCK.strip() + '\n\n' + anchor, 1)

old = """export const checkoutBody = z.object({
  operationId: UUID,
  terminalId: UUID,
  cashReceivedMinor: MINOR,
  lines: z
    .array(z.object({ productId: UUID, quantityScaled: SCALED_QUANTITY }))
    .min(1)
    .max(MAX_CART_LINES)
    // Two lines for one product would each pass a stock check their sum fails.
    // One line per product, with the quantity summed by the client.
    .refine((lines) => new Set(lines.map((line) => line.productId)).size === lines.length, {
      message: 'duplicate product line',
    }),
});"""

new = """/**
 * A checkout, in either of the two shapes a client may send.
 *
 * The cash-only shape is what the till in production sends today and it keeps
 * working unchanged. The tender list is the general shape. They are mutually
 * exclusive on purpose: a request carrying both is a client that does not know
 * which one it means, and guessing on its behalf is how a sale gets settled
 * twice over.
 *
 * Both normalise into one settlement engine downstream. There is no second
 * checkout path and there must never be one.
 */
export const checkoutBody = z
  .object({
    operationId: UUID,
    terminalId: UUID,
    cashReceivedMinor: MINOR.optional(),
    tenders: z.array(tenderBody).min(1).max(MAX_TENDERS).optional(),
    basketDiscount: discountBody.optional(),
    lines: z
      .array(
        z.object({
          productId: UUID,
          quantityScaled: SCALED_QUANTITY,
          discount: discountBody.optional(),
        }),
      )
      .min(1)
      .max(MAX_CART_LINES)
      // Two lines for one product would each pass a stock check their sum
      // fails. One line per product, with the quantity summed by the client.
      .refine((lines) => new Set(lines.map((line) => line.productId)).size === lines.length, {
        message: 'duplicate product line',
      }),
  })
  .refine(
    (body) => (body.cashReceivedMinor === undefined) !== (body.tenders === undefined),
    { message: 'send either cashReceivedMinor or tenders, not both and not neither' },
  );"""
assert old in s
s = s.replace(old, new, 1)

old = """export function namesForbiddenField(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(body, field)) return field;
  }
  return null;
}"""
new = """export function namesForbiddenField(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(body, field)) return field;
  }
  return null;
}

/**
 * Look for cardholder data anywhere in the request, not just at the top.
 *
 * A PAN arrives nested inside a tender far more plausibly than at the root, so
 * a top-level check would be theatre. Bounded depth, because the thing being
 * defended against is hostile input and an unbounded walk is its own problem.
 */
export function namesCardField(body: unknown, depth = 0): string | null {
  if (depth > 4 || body === null || typeof body !== 'object') return null;

  if (Array.isArray(body)) {
    for (const entry of body) {
      const found = namesCardField(entry, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  const record = body as Record<string, unknown>;
  for (const field of FORBIDDEN_CARD_FIELDS) {
    if (Object.hasOwn(record, field)) return field;
  }
  for (const value of Object.values(record)) {
    const found = namesCardField(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}"""
assert old in s
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  tender, discount and card-field validation added')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/routes/validation.ts'
s = open(path, encoding='utf-8').read()
if 'carriesCardNumber' in s:
    print('  already present'); sys.exit(0)

BLOCK = '''
/**
 * A card number sent as a value rather than as a field name.
 *
 * Refusing keys called `pan` or `cardNumber` is necessary and nowhere near
 * sufficient: a broken integration will put a card number in a field called
 * `reference`, and it would be persisted. So values are inspected too, with
 * the domain's own conservative test — 13 to 19 digits that satisfy Luhn.
 *
 * Bounded depth, like the field scan. Nothing here is logged or echoed: a
 * refusal that quotes the number is a refusal that writes it down.
 */
export function carriesCardNumber(body: unknown, depth = 0): boolean {
  if (depth > 4 || body === null) return false;
  if (typeof body === 'string') return looksLikeCardNumber(body);
  if (typeof body !== 'object') return false;

  if (Array.isArray(body)) {
    return body.some((entry) => carriesCardNumber(entry, depth + 1));
  }
  return Object.values(body as Record<string, unknown>).some((value) =>
    carriesCardNumber(value, depth + 1),
  );
}
'''

anchor = 'export function namesCardField(body: unknown, depth = 0): string | null {'
assert anchor in s
s = s.replace(anchor, BLOCK.strip() + '\n\n' + anchor, 1)
s = s.replace("import { z } from 'zod';", "import { looksLikeCardNumber } from '@korvi/domain';\nimport { z } from 'zod';", 1)
open(path, 'w', encoding='utf-8').write(s)
print('  value-level card-number guard added')
PY

say "API — the intent fingerprint covers how the sale was paid"

cat << 'EOF' > apps/api/src/checkout/fingerprint.ts
import { createHash } from 'node:crypto';

/**
 * What the client says it wants to happen.
 *
 * Only the fields that make one checkout a different checkout from another.
 * Nothing here is authoritative — prices, VAT and totals are read from the
 * database — but if any of it changes, the request is a different request and
 * must not be answered with an earlier sale.
 *
 * Payment composition is part of the intent, not decoration. The same basket
 * settled as 50 cash + 50 Mada is a different commercial event from the same
 * basket settled entirely in cash: the drawer differs, the reconciliation
 * differs, and the customer's card statement differs. Replaying one as the
 * other would be silently wrong in a way nobody could reconstruct.
 *
 * Discounts likewise: a basket that was 10% off is not the basket that was
 * not.
 */
export interface CheckoutIntentLine {
  readonly productId: string;
  readonly quantityScaled: string;
  /** Canonical description of the line discount, or the empty string. */
  readonly discount: string;
}

export interface CheckoutIntentTender {
  readonly kind: string;
  readonly amountMinor: string;
  readonly scheme: string;
  readonly reference: string;
}

export interface CheckoutIntent {
  readonly branchId: string;
  readonly terminalId: string;
  readonly lines: readonly CheckoutIntentLine[];
  readonly tenders: readonly CheckoutIntentTender[];
  /** Canonical description of the basket discount, or the empty string. */
  readonly basketDiscount: string;
}

/**
 * A stable fingerprint of the intent, stored beside the idempotency key.
 *
 * The point is to make a replay provable rather than assumed. An operation id
 * that comes back with a different basket — or a different payment — is not a
 * retry; it is a second sale wearing the first one's name, usually because a
 * client reused a key it should have regenerated. Returning the earlier sale
 * there would silently drop a transaction the cashier believes they rang up.
 *
 * Canonicalised before hashing, as a structured value rather than a joined
 * string: an approval reference is free text and may contain any separator a
 * hand-written encoding could choose, so the encoding is JSON and the
 * separators cannot be forged from field content at all.
 *
 * Nothing secret goes in. Ids, quantities, amounts, a scheme name and an
 * external approval reference — exactly what the sale row itself will hold in
 * the clear. No card data reaches this function because the API refuses to
 * receive any.
 *
 * `v2` because the payment fields joined the canonical form. A key minted
 * under v1 hashes differently and is treated as a different intent, which is
 * the safe direction: a conflict is visible, a false replay is not.
 */
export function fingerprintIntent(intent: CheckoutIntent): string {
  /*
   * Structured, not concatenated.
   *
   * The obvious canonical form joins fields with `:` and records with `,`,
   * and it is wrong the moment one of those fields is free text. An approval
   * reference is free text. `reference = "R,electronic:visa:100:X"` on a
   * single tender produces the same joined string as two separate tenders
   * with references `"R"` and `"X"` — two materially different sales, one
   * fingerprint, and a replay that returns the wrong one. SHA-256 cannot
   * repair an ambiguous serialisation; it faithfully hashes the collision.
   *
   * JSON gives the separators structure instead of meaning: a comma inside a
   * string is escaped as part of that string and can never be read as the
   * boundary between two of them.
   *
   * Sorted before serialisation, by the serialisation of each record, so the
   * order a cashier keyed things in does not change the fingerprint while the
   * things themselves still do.
   */
  const lines = intent.lines
    .map((line): readonly string[] => [line.productId, line.quantityScaled, line.discount])
    .sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1));

  const tenders = intent.tenders
    .map((tender): readonly string[] => [
      tender.kind,
      tender.scheme,
      tender.amountMinor,
      tender.reference,
    ])
    .sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1));

  const canonical = JSON.stringify([
    'v2',
    intent.branchId,
    intent.terminalId,
    intent.basketDiscount,
    tenders,
    lines,
  ]);

  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}
EOF

say "API — one settlement engine, two request shapes"

python3 - <<'PY'
import sys
path = 'apps/api/src/checkout/service.ts'
s = open(path, encoding='utf-8').read()
if 'CheckoutTenderInput' in s:
    print('  already patched'); sys.exit(0)

# ---- imports -------------------------------------------------------------
s = s.replace(
    """import {
  InvalidAmountError,
  NonCashChangeError,
  UnderpaidError,""",
    """import {
  DiscountNotPermittedError,
  InvalidAmountError,
  InvalidTenderError,
  NonCashChangeError,
  UnderpaidError,""",
    1,
)
s = s.replace(
    """import type {
  AuditRepository,
  AuthenticatedPrincipal,
  CartLineInput,""",
    """import type {
  AuditRepository,
  AuthenticatedPrincipal,
  CartLineInput,
  Discount,""",
    1,
)
s = s.replace(
    """  SaleRecord,
  SaleRepository,""",
    """  SaleDiscountRecord,
  SaleRecord,
  SaleRepository,
  TenderLine,
  TenderRecord,
  TenderScheme,""",
    1,
)

# ---- reasons -------------------------------------------------------------
s = s.replace(
    """  | 'insufficient-cash'
  | 'idempotency-conflict'""",
    """  | 'insufficient-cash'
  | 'invalid-tender'
  | 'electronic-overpay'
  | 'ambiguous-payment'
  | 'invalid-discount'
  | 'discount-not-authorized'
  | 'idempotency-conflict'""",
    1,
)

# ---- request shapes ------------------------------------------------------
s = s.replace(
    """export interface CheckoutLineInput {
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
}""",
    """/**
 * A discount as asked for, before anything has agreed to it.
 *
 * `basis-points` is a rate; `fixed` is halalas off. What is actually granted
 * is decided by the domain against the principal's own ceiling.
 */
export type CheckoutDiscountInput =
  | { readonly mode: 'basis-points'; readonly value: number; readonly reason?: string | undefined }
  | { readonly mode: 'fixed'; readonly amountMinor: string; readonly reason?: string | undefined };

/**
 * A payment that has already happened.
 *
 * `electronic` records a settlement approved elsewhere — a terminal, a wallet,
 * an acquirer. Korvi contacts none of them and this type does not pretend
 * otherwise: there is a scheme, somebody else's reference, and nothing that
 * could move money.
 */
export type CheckoutTenderInput =
  | { readonly kind: 'cash'; readonly amountMinor: string }
  | {
      readonly kind: 'electronic';
      readonly amountMinor: string;
      readonly scheme: TenderScheme;
      readonly reference: string;
    };

export interface CheckoutLineInput {
  readonly productId: string;
  /** Scaled by 1000, as a string. Never a float (ADR-0002). */
  readonly quantityScaled: string;
  // `| undefined` rather than a bare optional: these arrive straight from a
  // parsed request body, where an absent key really is `undefined`, and
  // exactOptionalPropertyTypes treats the two as different things.
  readonly discount?: CheckoutDiscountInput | undefined;
}

export interface CheckoutInput {
  readonly principal: AuthenticatedPrincipal;
  readonly operationId: string;
  readonly terminalId: string;
  readonly lines: readonly CheckoutLineInput[];
  /**
   * The cash-only shape the production till sends today.
   *
   * Exactly one of this and `tenders` may be present. Both, or neither, is a
   * client that does not know what it is asking for, and guessing on its
   * behalf is how a sale gets settled twice over.
   */
  readonly cashReceivedMinor?: string | undefined;
  readonly tenders?: readonly CheckoutTenderInput[] | undefined;
  readonly basketDiscount?: CheckoutDiscountInput | undefined;
}""",
    1,
)

open(path, 'w', encoding='utf-8').write(s)
print('  request shapes widened')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/checkout/service.ts'
s = open(path, encoding='utf-8').read()
if 'normalizePayment' in s:
    print('  already patched'); sys.exit(0)

HELPERS = '''
/**
 * The one place the two request shapes become one thing.
 *
 * A second checkout engine for "advanced" payments would be two implementations
 * of the arithmetic that decides what a customer is charged, and they would
 * diverge — quietly, on the path nobody exercises. So the legacy cash figure is
 * turned into a one-line tender list here, at the edge, and everything after
 * this point sees only a tender list.
 */
function normalizePayment(
  input: CheckoutInput,
): readonly CheckoutTenderInput[] | CheckoutFailureReason {
  const hasCash = input.cashReceivedMinor !== undefined;
  const hasTenders = input.tenders !== undefined;

  if (hasCash === hasTenders) return 'ambiguous-payment';
  if (input.tenders !== undefined) return input.tenders;

  const cash = input.cashReceivedMinor ?? '0';
  // A legacy request that handed over nothing is underpaid, which is what it
  // was before this strike. Reporting it as a malformed tender would change a
  // refusal the till already understands.
  if (BigInt(cash) <= 0n) return 'insufficient-cash';
  return [{ kind: 'cash', amountMinor: cash }];
}

/** A requested discount, in the vocabulary the domain prices with. */
function toDomainDiscount(requested: CheckoutDiscountInput): Discount {
  return requested.mode === 'basis-points'
    ? { kind: 'percentage', value: BigInt(requested.value) }
    : { kind: 'fixed', value: BigInt(requested.amountMinor) };
}

/** What the client asked for, canonically, for the intent fingerprint. */
function describeDiscount(requested: CheckoutDiscountInput | undefined): string {
  if (requested === undefined) return '';
  return requested.mode === 'basis-points'
    ? `bp:${String(requested.value)}`
    : `fx:${requested.amountMinor}`;
}

function toTenderLine(tender: CheckoutTenderInput, currency: Currency): TenderLine {
  return tender.kind === 'cash'
    ? { kind: 'cash', amount: money(BigInt(tender.amountMinor), currency) }
    : {
        kind: 'electronic',
        amount: money(BigInt(tender.amountMinor), currency),
        scheme: tender.scheme,
        reference: tender.reference,
      };
}
'''

anchor = "const IDEMPOTENCY_SCOPE = 'checkout';"
assert anchor in s
s = s.replace(anchor, HELPERS.strip() + '\n\n' + anchor, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  payment normalisation added')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/checkout/service.ts'
s = open(path, encoding='utf-8').read()
if 'const payment = normalizePayment(input);' in s:
    print('  already patched'); sys.exit(0)

# ---- the pipeline body ---------------------------------------------------
old = """      const intentHash = fingerprintIntent({
        branchId: shift.branchId,
        terminalId: input.terminalId,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          quantityScaled: line.quantityScaled,
        })),
        cashReceivedMinor: input.cashReceivedMinor,
      });"""
new = """      const payment = normalizePayment(input);
      if (typeof payment === 'string') return fail(payment);

      const intentHash = fingerprintIntent({
        branchId: shift.branchId,
        terminalId: input.terminalId,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          quantityScaled: line.quantityScaled,
          discount: describeDiscount(line.discount),
        })),
        tenders: payment.map((tender) => ({
          kind: tender.kind,
          amountMinor: tender.amountMinor,
          scheme: tender.kind === 'electronic' ? tender.scheme : '',
          reference: tender.kind === 'electronic' ? tender.reference : '',
        })),
        basketDiscount: describeDiscount(input.basketDiscount),
      });"""
assert old in s, 'fingerprint call'
s = s.replace(old, new, 1)

# ---- the cart carries discounts -----------------------------------------
old = """      const currency: Currency = 'SAR';
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
      };"""
new = """      const currency: Currency = 'SAR';
      const cart = {
        priceMode: settings.priceMode as PriceMode,
        currency,
        lines: loaded.map((entry, index): CartLineInput => {
          const requested = input.lines[index]?.discount;
          return {
            lineId: String(index + 1),
            productId: entry.product.id,
            sku: entry.product.sku,
            nameAr: entry.product.nameAr,
            nameEn: entry.product.nameEn,
            unitPrice: money(BigInt(entry.product.priceMinor), currency),
            quantity: quantity(entry.scaled),
            vatRate: basisPoints(entry.product.vatBasisPoints),
            isWeighted: entry.product.productType === 'weighted',
            // Omitted rather than set to undefined: exactOptionalPropertyTypes
            // is on, and an absent key is what "no discount" means there.
            ...(requested === undefined ? {} : { discount: toDomainDiscount(requested) }),
          };
        }),
        ...(input.basketDiscount === undefined
          ? {}
          : { basketDiscount: toDomainDiscount(input.basketDiscount) }),
      };"""
assert old in s, 'cart construction'
s = s.replace(old, new, 1)

# ---- finalize with the real tender list ---------------------------------
old = """          tenders: [{ kind: 'cash', amount: money(BigInt(input.cashReceivedMinor), currency) }],"""
new = """          tenders: payment.map((tender) => toTenderLine(tender, currency)),"""
assert old in s, 'finalize tenders'
s = s.replace(old, new, 1)

# ---- domain failures the cashier can act on ------------------------------
old = """      } catch (error) {
        if (error instanceof UnderpaidError) return fail('insufficient-cash');
        if (error instanceof NonCashChangeError) return fail('insufficient-cash');
        if (error instanceof InvalidAmountError) return fail('invalid-quantity');
        throw error;
      }"""
new = """      } catch (error) {
        // The ceiling is the merchant's policy, and refusing loudly is the
        // point: silently clamping a discount to what was permitted would give
        // the customer a different price from the one the cashier promised.
        if (error instanceof DiscountNotPermittedError) return fail('discount-not-authorized');
        if (error instanceof InvalidTenderError) return fail('invalid-tender');
        // Told apart on purpose. Underpaid is "give me more money"; an
        // electronic overpay is "that card was charged too much", which no
        // amount of cash fixes because only cash can give change back.
        if (error instanceof NonCashChangeError) return fail('electronic-overpay');
        if (error instanceof UnderpaidError) return fail('insufficient-cash');
        if (error instanceof InvalidAmountError) {
          // A cart that priced to nothing is a discount problem, not a
          // quantity one, and the cashier fixes it in a different place.
          return fail(discounted ? 'invalid-discount' : 'invalid-quantity');
        }
        throw error;
      }"""
assert old in s, 'finalize catch'
s = s.replace(old, new, 1)

old = """      const saleId = newId();
      const issuedAt = now().toISOString();"""
new = """      const saleId = newId();
      const issuedAt = now().toISOString();
      const discounted =
        input.basketDiscount !== undefined || input.lines.some((line) => line.discount !== undefined);"""
assert old in s
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  pipeline settles a tender list')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/checkout/service.ts'
s = open(path, encoding='utf-8').read()
if 'grantedByUserId: input.principal.userId' in s:
    print('  already patched'); sys.exit(0)

# ---- persist the tenders and the discounts -------------------------------
old = """            discounts: [],
            tenders: [
              {
                id: newId(),
                kind: 'cash',
                amountMinor: finalized.settlement.tendered.minor.toString(),
                changeMinor: finalized.settlement.change.minor.toString(),
                reference: null,
              },
            ],"""
new = """            // Enough to explain the receipt years later without replaying
            // today's pricing rules against a catalogue that has moved on:
            // what was asked for, what was granted, and by whom.
            discounts: recordedDiscounts,
            tenders: recordedTenders,"""
assert old in s, 'sale discounts/tenders'
s = s.replace(old, new, 1)

old = """      const priced = finalized.priced;
      let recorded;"""
new = """      const priced = finalized.priced;

      /*
       * Change is drawn from cash and from nowhere else, so it is attributed
       * to the cash tender rather than spread across the list. An electronic
       * row with change on it would describe a card terminal handing money
       * back, which is not a thing that happens — and the database refuses it
       * anyway (tenders_change_cash_only).
       */
      const recordedTenders: TenderRecord[] = payment.map((tender) => ({
        id: newId(),
        kind: tender.kind,
        scheme: tender.kind === 'electronic' ? tender.scheme : null,
        amountMinor: tender.amountMinor,
        changeMinor:
          tender.kind === 'cash' ? finalized.settlement.change.minor.toString() : '0',
        reference: tender.kind === 'electronic' ? tender.reference : null,
      }));

      const recordedDiscounts: SaleDiscountRecord[] = [];
      input.lines.forEach((line, index) => {
        const requested = line.discount;
        if (requested === undefined) return;
        const pricedLine = priced.lines[index];
        if (pricedLine === undefined) return;
        recordedDiscounts.push({
          id: newId(),
          scope: 'line',
          lineNumber: index + 1,
          kind: requested.mode === 'basis-points' ? 'percentage' : 'fixed',
          inputValue:
            requested.mode === 'basis-points'
              ? String(requested.value)
              : requested.amountMinor,
          amountMinor: pricedLine.lineDiscount.minor.toString(),
          reason: requested.reason ?? null,
          // From the session. A browser that could name the grantor could
          // attribute its own discount to somebody else.
          grantedByUserId: input.principal.userId,
        });
      });

      if (input.basketDiscount !== undefined) {
        const requested = input.basketDiscount;
        recordedDiscounts.push({
          id: newId(),
          scope: 'basket',
          lineNumber: null,
          kind: requested.mode === 'basis-points' ? 'percentage' : 'fixed',
          inputValue:
            requested.mode === 'basis-points' ? String(requested.value) : requested.amountMinor,
          amountMinor: priced.basketDiscountTotal.minor.toString(),
          reason: requested.reason ?? null,
          grantedByUserId: input.principal.userId,
        });
      }

      let recorded;"""
assert old in s, 'priced anchor'
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  tenders and discounts persisted')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/checkout/service.ts'
s = open(path, encoding='utf-8').read()
if "'sale.discounted'" in s:
    print('  already audited'); sys.exit(0)

old = """          metadata: {
            sequence: recorded.sequence,
            total: moneyToMajorString(priced.total),
            lines: recorded.lines.length,
          },"""
new = """          metadata: {
            sequence: recorded.sequence,
            total: moneyToMajorString(priced.total),
            lines: recorded.lines.length,
            // Money given away and money taken by something other than cash
            // are the two things a merchant reviews. Amounts and schemes only —
            // never a reference, which belongs to somebody else's system.
            discountMinor: (
              priced.lineDiscountTotal.minor + priced.basketDiscountTotal.minor
            ).toString(),
            tenderKinds: recordedTenders
              .map((tender) => (tender.scheme === null ? tender.kind : tender.scheme))
              .sort()
              .join(','),
          },"""
assert old in s, 'audit metadata'
s = s.replace(old, new, 1)

old = """          eventType: 'sale.completed',"""
new = """          eventType: recordedDiscounts.length > 0 ? 'sale.discounted' : 'sale.completed',"""
assert old in s
s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  discounted sales audited distinctly')
PY

say "API — the new refusals, in Arabic, with the right status"

python3 - <<'PY'
import sys
path = 'apps/api/src/routes/business.ts'
s = open(path, encoding='utf-8').read()
if "'electronic-overpay'" in s:
    print('  already present'); sys.exit(0)

s = s.replace(
    """  'insufficient-cash': 'المبلغ المستلم أقل من المطلوب.',""",
    """  'insufficient-cash': 'المبلغ المستلم أقل من المطلوب.',
  'invalid-tender': 'بيانات الدفع غير صالحة. راجع طريقة الدفع والمبلغ.',
  'electronic-overpay':
    'مبلغ الدفع الإلكتروني يتجاوز المطلوب، والباقي لا يُعاد إلا نقداً.',
  'ambiguous-payment': 'أرسل نقداً أو قائمة دفعات، لا الاثنين معاً.',
  'invalid-discount': 'الخصم غير صالح لهذه السلة.',
  'discount-not-authorized': 'الخصم المطلوب يتجاوز الحد المسموح لهذا المستخدم.',""",
    1,
)
s = s.replace(
    """  'insufficient-cash': 422,""",
    """  'insufficient-cash': 422,
  'invalid-tender': 422,
  'electronic-overpay': 422,
  'ambiguous-payment': 400,
  'invalid-discount': 422,
  // 403: the request is well-formed and the server understood it. This user
  // may not grant that much.
  'discount-not-authorized': 403,""",
    1,
)

old = """      const forbidden = namesForbiddenField(request.body);
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
      });"""
new = """      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      // Cardholder data is refused by name, at any depth. Korvi records that a
      // payment was approved elsewhere; it is not in the business of holding
      // the instrument that approved it (ADR-0015).
      const cardField = namesCardField(request.body);
      if (cardField !== null) {
        return reply.code(400).send({ error: 'card_data_refused', field: cardField });
      }
      const parsed = checkoutBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await deps.checkout.checkout({
        principal,
        operationId: parsed.data.operationId,
        terminalId: parsed.data.terminalId,
        lines: parsed.data.lines,
        ...(parsed.data.cashReceivedMinor === undefined
          ? {}
          : { cashReceivedMinor: parsed.data.cashReceivedMinor }),
        ...(parsed.data.tenders === undefined ? {} : { tenders: parsed.data.tenders }),
        ...(parsed.data.basketDiscount === undefined
          ? {}
          : { basketDiscount: parsed.data.basketDiscount }),
      });"""
assert old in s, 'sale route body'
s = s.replace(old, new, 1)

s = s.replace(
    """  namesForbiddenField,
  openShiftBody,""",
    """  namesCardField,
  namesForbiddenField,
  openShiftBody,""",
    1,
)
open(path, 'w', encoding='utf-8').write(s)
print('  route contract extended')
PY

say "API — the drawer, the permission, the summary and the audit"

python3 - <<'PY'
import sys
path = 'apps/api/src/checkout/service.ts'
s = open(path, encoding='utf-8').read()
if 'cashRetainedMinor' in s:
    print('  already patched'); sys.exit(0)

# ---- B5: a summary that says what it means -------------------------------
old = """export interface SaleSummary {
  readonly saleId: string;"""
new = """export interface SaleSummaryTender {
  readonly kind: string;
  readonly scheme: string | null;
  readonly amountMinor: string;
  readonly changeMinor: string;
  readonly reference: string | null;
}

export interface SaleSummary {
  readonly saleId: string;"""
assert old in s, 'summary anchor'
s = s.replace(old, new, 1)

old = """  readonly cashReceivedMinor: string;
  readonly changeMinor: string;
}"""
new = """  /**
   * Every tender added up, before change.
   *
   * Distinct from `cashReceivedMinor` on purpose. On a split payment they are
   * different numbers, and calling the total "cash received" is a statement
   * about the drawer that is simply false.
   */
  readonly tenderedMinor: string;
  /** Cash, and only cash. Equal to `tenderedMinor` on a cash-only sale. */
  readonly cashReceivedMinor: string;
  readonly changeMinor: string;
  /** What was actually presented, for the receipt and for reconciliation. */
  readonly tenders: readonly SaleSummaryTender[];
}"""
assert old in s, 'summary tail'
s = s.replace(old, new, 1)

old = """    netMinor: sale.netMinor,
    vatMinor: sale.vatMinor,
    totalMinor: sale.totalMinor,
    cashReceivedMinor: sale.tenderedMinor,
    changeMinor: sale.changeMinor,
  };
}"""
new = """    netMinor: sale.netMinor,
    vatMinor: sale.vatMinor,
    totalMinor: sale.totalMinor,
    tenderedMinor: sale.tenderedMinor,
    // From the persisted tender rows, on a fresh sale and on a replay alike.
    // Deriving it from the total would be right only while every sale was
    // cash, which stopped being true with this strike.
    cashReceivedMinor: sale.tenders
      .filter((tender) => tender.kind === 'cash')
      .reduce((total, tender) => total + BigInt(tender.amountMinor), 0n)
      .toString(),
    changeMinor: sale.changeMinor,
    tenders: sale.tenders.map((tender) => ({
      kind: tender.kind,
      scheme: tender.scheme,
      amountMinor: tender.amountMinor,
      changeMinor: tender.changeMinor,
      reference: tender.reference,
    })),
  };
}"""
assert old in s, 'summarise body'
s = s.replace(old, new, 1)

# ---- B2: the permission, not just the ceiling ----------------------------
old = """      const saleId = newId();
      const issuedAt = now().toISOString();
      const discounted ="""
new = """      // A ceiling says how much; the permission says whether at all. A
      // principal can hold a role-derived ceiling while their persisted
      // permission set omits sale.discount, and permissions are what the
      // server checks (CLAUDE.md, RBAC).
      if (
        (input.basketDiscount !== undefined ||
          input.lines.some((line) => line.discount !== undefined)) &&
        !input.principal.permissions.includes('sale.discount')
      ) {
        return fail('discount-not-authorized');
      }

      const saleId = newId();
      const issuedAt = now().toISOString();
      const discounted ="""
assert old in s, 'permission anchor'
s = s.replace(old, new, 1)

# ---- B1: the drawer moves by the cash that stayed in it ------------------
old = """          cashMovement: {
            id: newId(),
            shiftId: shift.id,
            kind: 'sale',
            // What the drawer gained: the sale total, not what was handed over.
            amountMinor: priced.total.minor.toString(),
            reason: null,
            actorUserId: input.principal.userId,
            occurredAt: issuedAt,
          },"""
new = """          // What the drawer actually gained.
          //
          // The sale total was right only while every sale was cash. On a
          // split payment the card settles part of it and never touches the
          // drawer, so recording the total would overstate the till by exactly
          // the electronic portion — and a shift would reconcile short by that
          // amount, every day, with nothing to point at.
          //
          // Null rather than a zero row when nothing was taken in cash: a
          // movement of nothing is a movement that did not happen.
          cashMovement:
            cashRetainedMinor > 0n
              ? {
                  id: newId(),
                  shiftId: shift.id,
                  kind: 'sale',
                  amountMinor: cashRetainedMinor.toString(),
                  reason: null,
                  actorUserId: input.principal.userId,
                  occurredAt: issuedAt,
                }
              : null,"""
assert old in s, 'cash movement anchor'
s = s.replace(old, new, 1)

old = """      const recordedDiscounts: SaleDiscountRecord[] = [];"""
new = """      /*
       * Cash tendered, less the change handed back. The only part of a sale
       * that reaches the drawer.
       */
      const cashRetainedMinor =
        payment
          .filter((tender) => tender.kind === 'cash')
          .reduce((total, tender) => total + BigInt(tender.amountMinor), 0n) -
        finalized.settlement.change.minor;

      const recordedDiscounts: SaleDiscountRecord[] = [];"""
assert old in s, 'cash retained anchor'
s = s.replace(old, new, 1)

# ---- B3: a structurally impossible discount is not an authority problem --
s = s.replace(
    "        if (error instanceof DiscountNotPermittedError) return fail('discount-not-authorized');",
    "        if (error instanceof InvalidDiscountError) return fail('invalid-discount');\n"
    "        if (error instanceof DiscountNotPermittedError) return fail('discount-not-authorized');",
    1,
)
s = s.replace(
    """import {
  DiscountNotPermittedError,
  InvalidAmountError,""",
    """import {
  DiscountNotPermittedError,
  InvalidAmountError,
  InvalidDiscountError,""",
    1,
)
open(path, 'w', encoding='utf-8').write(s)
print('  drawer, permission, summary and discount errors corrected')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/checkout/service.ts'
s = open(path, encoding='utf-8').read()
if "eventType: 'sale.completed'," in s and "'sale.discounted'" in s and 'discountAudit' in s:
    print('  already patched'); sys.exit(0)

# ---- B8: sale.completed is the canonical event, always -------------------
old = """          eventType: recordedDiscounts.length > 0 ? 'sale.discounted' : 'sale.completed',"""
new = """          eventType: 'sale.completed',"""
assert old in s, 'audit event anchor'
s = s.replace(old, new, 1)

old = """      } catch (error) {
        onAuditError(error);
      }

      return {
        outcome: 'success',
        replayed: false,"""
new = """
        // A discount is a second fact about the same sale, not a different
        // sale. Emitting it instead of sale.completed would break the
        // invariant that every completed sale emits one, and every report
        // built on that invariant with it.
        if (recordedDiscounts.length > 0) {
          await deps.audit.append(scope, {
            id: newId(),
            actorUserId: input.principal.userId,
            branchId: shift.branchId,
            terminalId: input.terminalId,
            eventType: 'sale.discounted',
            entityType: 'sale',
            entityId: recorded.id,
            metadata: {
              sequence: recorded.sequence,
              discountMinor: (
                priced.lineDiscountTotal.minor + priced.basketDiscountTotal.minor
              ).toString(),
              // Scope and kind, so a manager reviewing give-aways can see the
              // shape of them. No reference, no scheme, no card data.
              scopes: recordedDiscounts.map((discount) => discount.scope).sort().join(','),
              grantedByUserId: input.principal.userId,
            },
            occurredAt: issuedAt,
          });
        }
      } catch (error) {
        onAuditError(error);
      }

      return {
        outcome: 'success',
        replayed: false,"""
assert old in s, 'audit tail anchor'
s = s.replace(old, new, 1)
# Name it so the guard above can see the patch has been applied.
s = s.replace("        // A discount is a second fact about the same sale",
              "        // discountAudit: a discount is a second fact about the same sale", 1)
open(path, 'w', encoding='utf-8').write(s)
print('  sale.completed preserved; sale.discounted added alongside')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/routes/business.ts'
s = open(path, encoding='utf-8').read()
if 'carriesCardNumber' in s:
    print('  already present'); sys.exit(0)

old = """      const cardField = namesCardField(request.body);
      if (cardField !== null) {
        return reply.code(400).send({ error: 'card_data_refused', field: cardField });
      }"""
new = """      const cardField = namesCardField(request.body);
      if (cardField !== null) {
        return reply.code(400).send({ error: 'card_data_refused', field: cardField });
      }
      // And by value, not only by field name: a card number arrives in a field
      // called `reference` far more plausibly than in one called `pan`. The
      // response names no field and echoes nothing — a refusal that quotes the
      // number is a refusal that writes it down.
      if (carriesCardNumber(request.body)) {
        return reply.code(400).send({ error: 'card_data_refused' });
      }"""
assert old in s, 'card field anchor'
s = s.replace(old, new, 1)
s = s.replace("  namesCardField,\n  namesForbiddenField,", "  carriesCardNumber,\n  namesCardField,\n  namesForbiddenField,", 1)
open(path, 'w', encoding='utf-8').write(s)
print('  value-level card refusal wired at the edge')
PY

say "Tests — the discount ceiling, and the rounding that used to walk through it"

cat << 'EOF' > packages/domain/src/pricing/__tests__/discount-authority.test.ts
import { describe, expect, it } from 'vitest';
import { effectiveDiscountBasisPoints, isDiscountAuthorized } from '../discount-authority.js';

describe('effectiveDiscountBasisPoints', () => {
  it('reports the exact rate when it divides evenly', () => {
    expect(effectiveDiscountBasisPoints(1_000n, 10_000n)).toBe(1_000n);
    expect(effectiveDiscountBasisPoints(10_000n, 10_000n)).toBe(10_000n);
    expect(effectiveDiscountBasisPoints(0n, 10_000n)).toBe(0n);
  });

  it('rounds up, because a ceiling that rounds down is not a ceiling', () => {
    /*
     * The case this function exists for. 200 halalas off 1999 is 1000.5 basis
     * points. Truncating division reports 1000, so a cashier capped at 1000
     * gets it — every time, repeatably, as a policy the merchant never set.
     */
    expect((200n * 10_000n) / 1_999n).toBe(1_000n);
    expect(effectiveDiscountBasisPoints(200n, 1_999n)).toBe(1_001n);
  });

  it.each([
    [1n, 3n, 3_334n],
    [1n, 10_000n, 1n],
    [7n, 999n, 71n],
    [333n, 1_000n, 3_330n],
  ])('reports %s off %s as %s bp', (granted, base, expected) => {
    expect(effectiveDiscountBasisPoints(granted, base)).toBe(expected);
  });

  it('never reports a rate below the true one', () => {
    // The property that matters: the reported rate is always >= the real one,
    // so authorisation can only ever be stricter than the arithmetic, never
    // looser. Integer comparison — the true rate is granted*10000/base.
    for (let base = 1n; base <= 400n; base += 1n) {
      for (let granted = 1n; granted <= base; granted += 7n) {
        const reported = effectiveDiscountBasisPoints(granted, base);
        expect(reported * base).toBeGreaterThanOrEqual(granted * 10_000n);
      }
    }
  });

  it('refuses to describe a discount taken out of nothing', () => {
    // There is no rate that describes it, and reporting zero would authorise
    // it against every ceiling including a cashier's zero.
    expect(effectiveDiscountBasisPoints(100n, 0n)).toBeGreaterThan(10_000n);
  });
});

describe('isDiscountAuthorized', () => {
  it('permits a discount inside the ceiling', () => {
    expect(isDiscountAuthorized(1_000n, 10_000n, 1_000n)).toBe(true);
    expect(isDiscountAuthorized(999n, 10_000n, 1_000n)).toBe(true);
  });

  it('refuses the half-basis-point over the ceiling', () => {
    expect(isDiscountAuthorized(200n, 1_999n, 1_000n)).toBe(false);
  });

  it('gives a cashier with no discount authority no discount at all', () => {
    // ROLE_MAX_DISCOUNT_BP.cashier is 0. One halala off is still a discount.
    expect(isDiscountAuthorized(1n, 100_000n, 0n)).toBe(false);
    expect(isDiscountAuthorized(0n, 100_000n, 0n)).toBe(true);
  });
});
EOF

say "Tests — what a payment has to look like before it is arithmetic"

cat << 'EOF' > packages/domain/src/tender/__tests__/composition.test.ts
import { describe, expect, it } from 'vitest';
import { InvalidTenderError, NonCashChangeError, UnderpaidError } from '../../errors.js';
import { money } from '../../money/money.js';
import { assertTenderComposition, settle } from '../tender.js';
import type { TenderLine } from '../tender.js';

const cash = (minor: bigint): TenderLine => ({ kind: 'cash', amount: money(minor) });
const card = (minor: bigint, reference = 'AUTH-1'): TenderLine => ({
  kind: 'electronic',
  scheme: 'mada',
  reference,
  amount: money(minor),
});

describe('tender composition', () => {
  it('accepts a cash tender and an electronic one together', () => {
    expect(() => {
      assertTenderComposition([card(1_000n), cash(1_300n)]);
    }).not.toThrow();
  });

  it('refuses an empty payment', () => {
    expect(() => {
      assertTenderComposition([]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses a tender of nothing', () => {
    // A zero line records a method that was not used, and it reaches a receipt.
    expect(() => {
      assertTenderComposition([cash(0n)]);
    }).toThrow(InvalidTenderError);
    expect(() => {
      assertTenderComposition([card(1_000n), cash(0n)]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses a negative tender', () => {
    expect(() => {
      assertTenderComposition([cash(-100n)]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses a second cash tender', () => {
    // Two cash lines is a drawer nobody can reconcile: the change has to come
    // out of one of them and no fact says which.
    expect(() => {
      assertTenderComposition([cash(500n), cash(500n)]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses an electronic tender with no scheme or no reference', () => {
    expect(() => {
      assertTenderComposition([{ kind: 'electronic', amount: money(500n), reference: 'A' }]);
    }).toThrow(InvalidTenderError);
    expect(() => {
      assertTenderComposition([{ kind: 'electronic', amount: money(500n), scheme: 'visa' }]);
    }).toThrow(InvalidTenderError);
    expect(() => {
      assertTenderComposition([
        { kind: 'electronic', amount: money(500n), scheme: 'visa', reference: '   ' },
      ]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses an unbounded reference', () => {
    expect(() => {
      assertTenderComposition([card(500n, 'x'.repeat(65))]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses a cash tender wearing an approval code', () => {
    expect(() => {
      assertTenderComposition([{ kind: 'cash', amount: money(500n), reference: 'AUTH-1' }]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses the same approval counted twice', () => {
    expect(() => {
      assertTenderComposition([card(500n, 'AUTH-9'), card(500n, 'AUTH-9')]);
    }).toThrow(InvalidTenderError);
  });

  it('allows one scheme twice under different approvals', () => {
    // A customer with two cards is ordinary.
    expect(() => {
      assertTenderComposition([card(500n, 'AUTH-1'), card(500n, 'AUTH-2')]);
    }).not.toThrow();
  });

  it('refuses the legacy kinds as new payments', () => {
    // Readable, because rows written before this vocabulary still exist. Not
    // writable, because a kind with no scheme beside it cannot be reported on.
    expect(() => {
      assertTenderComposition([{ kind: 'mada', amount: money(500n) }]);
    }).toThrow(InvalidTenderError);
  });
});

describe('split settlement', () => {
  it('gives change from cash when a card covers part of the total', () => {
    // 23.00 due, 10.00 on Mada, 20.00 cash: 7.00 back, and 13.00 stays in the
    // drawer.
    const settlement = settle(money(2_300n), [card(1_000n), cash(2_000n)]);
    expect(settlement.tendered.minor).toBe(3_000n);
    expect(settlement.change.minor).toBe(700n);
    expect(settlement.changeFrom).toBe('cash');
    expect(settlement.tendered.minor - settlement.change.minor).toBe(2_300n);
  });

  it('refuses an electronic tender larger than the amount due', () => {
    // 24.00 on a card against a 23.00 sale is a customer overcharged by a
    // pound, and no amount of cash in the drawer can give it back.
    expect(() => settle(money(2_300n), [card(2_400n)])).toThrow(NonCashChangeError);
  });

  it('refuses electronic tenders that together exceed the total', () => {
    expect(() =>
      settle(money(2_300n), [card(1_500n, 'AUTH-1'), card(1_500n, 'AUTH-2')]),
    ).toThrow(NonCashChangeError);
  });

  it('settles three tenders exactly, with no change', () => {
    const settlement = settle(money(10_000n), [
      card(2_000n, 'AUTH-1'),
      card(3_000n, 'AUTH-2'),
      cash(5_000n),
    ]);
    expect(settlement.change.minor).toBe(0n);
    expect(settlement.changeFrom).toBeNull();
  });

  it('refuses a payment that does not cover the total', () => {
    expect(() => settle(money(2_300n), [card(1_000n), cash(1_000n)])).toThrow(UnderpaidError);
  });

  it('lets cash alone overpay', () => {
    const settlement = settle(money(2_300n), [cash(5_000n)]);
    expect(settlement.change.minor).toBe(2_700n);
  });
});
EOF

say "Tests — a discounted basket that reconciles to the halala"

cat << 'EOF' > packages/domain/src/pricing/__tests__/discount-reconciliation.test.ts
import { describe, expect, it } from 'vitest';
import { money } from '../../money/money.js';
import { quantity } from '../../quantity/quantity.js';
import { basisPoints } from '../../tax/basis-points.js';
import { priceCart } from '../line.js';
import type { CartLineInput, PriceMode } from '../line.js';

/**
 * The invariant a receipt lives or dies by.
 *
 * gross - line discounts - basket discount = net, net + VAT = total, and the
 * per-line shares of a basket discount sum to the basket discount exactly. The
 * awkward numbers below are the point: a discount that does not divide evenly
 * across lines is where a halala goes missing, and a receipt that is one
 * halala out is a receipt a merchant cannot sign.
 */
function line(id: string, unit: bigint, qty: bigint, rate = 1_500): CartLineInput {
  return {
    lineId: id,
    productId: `p-${id}`,
    sku: `SKU-${id}`,
    nameAr: 'صنف',
    nameEn: null,
    unitPrice: money(unit),
    quantity: quantity(qty),
    vatRate: basisPoints(rate),
  };
}

function reconciles(mode: PriceMode, input: Parameters<typeof priceCart>[0]): void {
  const priced = priceCart({ ...input, priceMode: mode });

  const lineSum = priced.lines.reduce((total, entry) => total + entry.net.minor, 0n);
  const vatSum = priced.lines.reduce((total, entry) => total + entry.vat.minor, 0n);
  const basketShares = priced.lines.reduce((total, entry) => total + entry.basketDiscount.minor, 0n);
  const lineShares = priced.lines.reduce((total, entry) => total + entry.lineDiscount.minor, 0n);

  // The parts are the whole. Not approximately.
  expect(basketShares).toBe(priced.basketDiscountTotal.minor);
  expect(lineShares).toBe(priced.lineDiscountTotal.minor);
  expect(lineSum).toBe(priced.net.minor);
  expect(vatSum).toBe(priced.vat.minor);
  expect(priced.net.minor + priced.vat.minor).toBe(priced.total.minor);

  for (const entry of priced.lines) {
    expect(entry.net.minor).toBeGreaterThanOrEqual(0n);
    expect(entry.lineDiscount.minor + entry.basketDiscount.minor).toBeLessThanOrEqual(
      entry.gross.minor,
    );
  }
}

describe('discount allocation', () => {
  it.each(['tax-inclusive', 'tax-exclusive'] as const)(
    'splits an indivisible basket discount exactly (%s)',
    (mode) => {
      // 1 halala across three lines: somebody gets it, deterministically, and
      // the shares still sum to 1.
      reconciles(mode, {
        priceMode: mode,
        lines: [line('a', 333n, 1_000n), line('b', 333n, 1_000n), line('c', 333n, 1_000n)],
        basketDiscount: { kind: 'fixed', value: 1n },
      });
    },
  );

  it.each(['tax-inclusive', 'tax-exclusive'] as const)(
    'splits an awkward percentage of an awkward basket (%s)',
    (mode) => {
      reconciles(mode, {
        priceMode: mode,
        lines: [
          line('a', 1_999n, 3_000n),
          line('b', 777n, 1_250n),
          line('c', 1n, 7_000n),
          line('d', 45_037n, 1_000n, 500),
        ],
        basketDiscount: { kind: 'percentage', value: 1_337n },
      });
    },
  );

  it('reconciles line and basket discounts together', () => {
    reconciles('tax-inclusive', {
      priceMode: 'tax-inclusive',
      lines: [
        { ...line('a', 1_150n, 2_000n), discount: { kind: 'percentage', value: 1_000n } },
        { ...line('b', 2_400n, 1_500n), discount: { kind: 'fixed', value: 7n } },
        line('c', 99n, 3_333n),
      ],
      basketDiscount: { kind: 'fixed', value: 1_111n },
    });
  });

  it('never discounts a line below nothing', () => {
    // A basket discount larger than the basket cannot make a line owe money.
    reconciles('tax-inclusive', {
      priceMode: 'tax-inclusive',
      lines: [line('a', 100n, 1_000n), line('b', 200n, 1_000n)],
      basketDiscount: { kind: 'fixed', value: 999_999n },
    });
  });

  it('allocates the same way every time', () => {
    const input = {
      priceMode: 'tax-inclusive' as const,
      lines: [line('a', 333n, 1_000n), line('b', 333n, 1_000n), line('c', 334n, 1_000n)],
      basketDiscount: { kind: 'fixed' as const, value: 5n },
    };
    const first = priceCart(input).lines.map((entry) => entry.basketDiscount.minor);
    const second = priceCart(input).lines.map((entry) => entry.basketDiscount.minor);
    expect(first).toEqual(second);
    expect(first.reduce((total, share) => total + share, 0n)).toBe(5n);
  });
});
EOF

say "Tests — the base a discount is measured against"

cat << 'EOF' > packages/domain/src/sale/__tests__/discount-authority.test.ts
import { describe, expect, it } from 'vitest';
import { InvalidDiscountError } from '../../errors.js';
import { money } from '../../money/money.js';
import { quantity } from '../../quantity/quantity.js';
import { basisPoints } from '../../tax/basis-points.js';
import { DiscountNotPermittedError, finalizeSale } from '../finalize.js';
import type { CartLineInput, Discount } from '../../pricing/line.js';
import type { FinalizeSaleInput } from '../finalize.js';

/**
 * A ceiling has to mean the same thing wherever the discount lands.
 *
 * The scenario these tests are built around: a small line beside a large one.
 * Measured against the whole cart, a fixed amount can wipe out the small line
 * entirely and still read as a modest percentage. Measured against the line it
 * came off, it reads as what it is.
 */
function line(id: string, unit: bigint, discount?: Discount): CartLineInput {
  return {
    lineId: id,
    productId: `p-${id}`,
    sku: `SKU-${id}`,
    nameAr: 'صنف',
    nameEn: null,
    unitPrice: money(unit),
    quantity: quantity(1_000n),
    vatRate: basisPoints(1500),
    ...(discount === undefined ? {} : { discount }),
  };
}

function sale(
  lines: readonly CartLineInput[],
  ceiling: bigint,
  basketDiscount?: Discount,
): FinalizeSaleInput {
  return {
    saleId: 's1',
    operationId: 'op1',
    tenantId: 't1',
    branchId: 'b1',
    terminalId: 'tm1',
    shiftId: 'sh1',
    cashierId: 'u1',
    customerId: null,
    cart: {
      priceMode: 'tax-inclusive',
      lines,
      ...(basketDiscount === undefined ? {} : { basketDiscount }),
    },
    tenders: [{ kind: 'cash', amount: money(1_000_000n) }],
    issuedAt: '2026-08-18T00:00:00.000Z',
    maxDiscountBasisPoints: ceiling,
  };
}

describe('a line discount is measured against its own line', () => {
  it('refuses a fixed amount that wipes out a small line beside a large one', () => {
    // 10.00 off a 10.00 line is 100 per cent of that line. Against the 100.00
    // cart it reads as 1000 bp, which a manager capped at 2000 would be given.
    expect(() =>
      finalizeSale(
        sale([line('a', 1_000n, { kind: 'fixed', value: 1_000n }), line('b', 9_000n)], 2_000n),
      ),
    ).toThrow(DiscountNotPermittedError);
  });

  it('allows a fixed line discount inside the ceiling for that line', () => {
    // 2.00 off a 10.00 line is exactly 2000 bp.
    const finalized = finalizeSale(
      sale([line('a', 1_000n, { kind: 'fixed', value: 200n }), line('b', 9_000n)], 2_000n),
    );
    expect(finalized.priced.lineDiscountTotal.minor).toBe(200n);
  });

  it('refuses the halala that rounds over the ceiling', () => {
    // 2.01 off 10.00 is 2010 bp once the rate is computed honestly.
    expect(() =>
      finalizeSale(sale([line('a', 1_000n, { kind: 'fixed', value: 201n })], 2_000n)),
    ).toThrow(DiscountNotPermittedError);
  });

  it('refuses more off a line than the line is worth, without clamping it', () => {
    // applyDiscount would cap this to the line value, which is right for
    // pricing and wrong here: capping answers a request nobody made.
    expect(() =>
      finalizeSale(sale([line('a', 1_000n, { kind: 'fixed', value: 1_500n })], 10_000n)),
    ).toThrow(InvalidDiscountError);
  });

  it('refuses a rate above the ceiling before anything is priced', () => {
    expect(() =>
      finalizeSale(sale([line('a', 1_000n, { kind: 'percentage', value: 2_001n })], 2_000n)),
    ).toThrow(DiscountNotPermittedError);
  });
});

describe('a basket discount is measured against what the lines left', () => {
  it('uses the after-line base, which is what priceCart applies it to', () => {
    // Lines total 100.00, less a 10.00 line discount, leaves 90.00. 18.00 off
    // that is exactly 2000 bp; against the undiscounted 100.00 it would look
    // like 1800.
    const finalized = finalizeSale(
      sale(
        [line('a', 1_000n, { kind: 'fixed', value: 1_000n }), line('b', 9_000n)],
        10_000n,
        { kind: 'fixed', value: 1_800n },
      ),
    );
    expect(finalized.priced.basketDiscountTotal.minor).toBe(1_800n);
  });

  it('refuses a basket discount larger than the base it is taken from', () => {
    expect(() =>
      finalizeSale(sale([line('a', 1_000n)], 10_000n, { kind: 'fixed', value: 1_001n })),
    ).toThrow(InvalidDiscountError);
  });

  it('refuses a basket rate above the ceiling', () => {
    expect(() =>
      finalizeSale(sale([line('a', 10_000n)], 2_000n, { kind: 'percentage', value: 2_001n })),
    ).toThrow(DiscountNotPermittedError);
  });
});

describe('and everything together', () => {
  it('refuses two individually-legal discounts that stack past the ceiling', () => {
    // 1500 bp off a line and 1500 bp off the basket are each inside a 2000 bp
    // ceiling. Together they are not, and the aggregate guard is what says so.
    expect(() =>
      finalizeSale(
        sale(
          [line('a', 10_000n, { kind: 'percentage', value: 1_500n })],
          2_000n,
          { kind: 'percentage', value: 1_500n },
        ),
      ),
    ).toThrow(DiscountNotPermittedError);
  });

  it('permits a combination that stays inside it', () => {
    const finalized = finalizeSale(
      sale(
        [line('a', 10_000n, { kind: 'percentage', value: 1_000n })],
        2_000n,
        { kind: 'percentage', value: 1_000n },
      ),
    );
    // 1000 off, then 900 off the 9000 that is left: 1900 of 10000 is 1900 bp.
    expect(
      finalized.priced.lineDiscountTotal.minor + finalized.priced.basketDiscountTotal.minor,
    ).toBe(1_900n);
  });

  it('lets a cashier with no discount authority sell, and grant nothing', () => {
    expect(() => finalizeSale(sale([line('a', 1_000n)], 0n))).not.toThrow();
    expect(() =>
      finalizeSale(sale([line('a', 1_000n, { kind: 'fixed', value: 1n })], 0n)),
    ).toThrow(DiscountNotPermittedError);
  });
});
EOF

say "Tests — a card number is refused by value, not only by name"

cat << 'EOF' > packages/domain/src/tender/__tests__/card-number.test.ts
import { describe, expect, it } from 'vitest';
import { InvalidTenderError } from '../../errors.js';
import { money } from '../../money/money.js';
import { assertTenderComposition, looksLikeCardNumber } from '../tender.js';

/**
 * Synthetic test numbers only. These are the industry's published
 * never-issued values; none of them belongs to anybody.
 */
const TEST_PANS = ['4111111111111111', '5555555555554444', '378282246310005', '4111 1111 1111 1111', '4111-1111-1111-1111'];

const APPROVALS = ['004512', 'AUTH-77', 'A1B2C3', '123456', '00000000', '4111111111111112'];

describe('looksLikeCardNumber', () => {
  it.each(TEST_PANS)('recognises %s', (value) => {
    expect(looksLikeCardNumber(value)).toBe(true);
  });

  it.each(APPROVALS)('leaves the ordinary approval code %s alone', (value) => {
    // The last one is a 16-digit value that fails Luhn: length alone is not
    // the test, or half the reference codes in the world become unusable.
    expect(looksLikeCardNumber(value)).toBe(false);
  });

  it('is not fooled by separators', () => {
    expect(looksLikeCardNumber(' 4111  1111-1111 1111 ')).toBe(true);
  });
});

describe('the tender guard', () => {
  it('refuses a card number hiding in the approval reference', () => {
    // A broken integration will put one here long before it puts one in a
    // field called `pan`, and Korvi would otherwise persist it.
    expect(() => {
      assertTenderComposition([
        {
          kind: 'electronic',
          scheme: 'visa',
          reference: '4111111111111111',
          amount: money(1_000n),
        },
      ]);
    }).toThrow(InvalidTenderError);
  });

  it('says nothing about the value it refused', () => {
    try {
      assertTenderComposition([
        {
          kind: 'electronic',
          scheme: 'visa',
          reference: '4111111111111111',
          amount: money(1_000n),
        },
      ]);
      throw new Error('expected a refusal');
    } catch (error) {
      // The message is read by a developer fixing an integration. It must not
      // become the place the number gets written down.
      expect((error as Error).message).not.toContain('4111');
    }
  });

  it('still accepts a real approval code', () => {
    expect(() => {
      assertTenderComposition([
        { kind: 'electronic', scheme: 'mada', reference: '004512', amount: money(1_000n) },
      ]);
    }).not.toThrow();
  });
});
EOF

say "Tests — the settlement contract at the HTTP boundary"

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/business-routes.test.ts'
s = open(path, encoding='utf-8').read()
if "describe('POST /v1/sales — settlement'" in s:
    print('  already present'); sys.exit(0)

BLOCK = """describe('POST /v1/sales — settlement', () => {
  const operation = '018f2000-0000-7000-8000-0000000000e1';

  /** Milk is 11.50 tax-inclusive; two of them is 23.00 exactly. */
  function checkout(
    server: FastifyInstance,
    cookie: string,
    overrides: Record<string, unknown> = {},
  ) {
    return server.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: operation,
        terminalId: A.terminal,
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        ...overrides,
      },
    });
  }

  it('still accepts the cash-only shape the till sends today', async () => {
    // The production browser is not being changed by this strike. If this
    // test ever needs editing, something has gone wrong.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, { cashReceivedMinor: '5000' });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ sale: Record<string, string> }>();
    expect(body.sale['totalMinor']).toBe('2300');
    expect(body.sale['changeMinor']).toBe('2700');
  });

  it('settles a card and cash together, with the change out of the cash', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-77', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      sale: Record<string, string> & {
        tenders: { kind: string; scheme: string | null; amountMinor: string }[];
      };
    }>();
    expect(body.sale['totalMinor']).toBe('2300');
    // Three concepts, three numbers. Calling the tendered total "cash
    // received" was a statement about the drawer that was simply false.
    expect(body.sale['tenderedMinor']).toBe('3000');
    expect(body.sale['cashReceivedMinor']).toBe('2000');
    expect(body.sale['changeMinor']).toBe('700');
    expect(body.sale.tenders.map((tender) => [tender.kind, tender.scheme, tender.amountMinor])).toEqual([
      ['electronic', 'mada', '1000'],
      ['cash', null, '2000'],
    ]);

    // 13.00 of the 20.00 cash stays in the drawer; the card settled 10.00.
    const recorded = business.sales[0];
    const tenders = recorded?.tenders ?? [];
    expect(tenders).toHaveLength(2);
    const cash = tenders.find((tender) => tender.kind === 'cash');
    const card = tenders.find((tender) => tender.kind === 'electronic');
    expect(cash?.changeMinor).toBe('700');
    expect(cash?.scheme).toBeNull();
    expect(card?.scheme).toBe('mada');
    expect(card?.reference).toBe('AUTH-77');
    expect(card?.changeMinor).toBe('0');
  });

  it('refuses a card charged more than the sale', async () => {
    // No mechanism exists to hand the difference back.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [
        { kind: 'electronic', scheme: 'visa', reference: 'AUTH-1', amountMinor: '2400' },
      ],
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'electronic-overpay' });
    expect(business.sales).toHaveLength(0);
  });

  it.each([
    ['both', { cashReceivedMinor: '5000', tenders: [{ kind: 'cash', amountMinor: '5000' }] }],
    ['neither', {}],
  ])('refuses a request naming %s payment shape', async (_label, overrides) => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, overrides);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_body' });
    expect(business.sales).toHaveLength(0);
  });

  it.each([
    ['pan', { pan: '4111111111111111' }],
    ['cvv', { cvv: '123' }],
    ['track2', { track2: ';4111111111111111=2512?' }],
  ])('refuses cardholder data sent as %s', async (field, extra) => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      cashReceivedMinor: '5000',
      ...extra,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'card_data_refused', field });
  });

  it('finds cardholder data nested inside a tender', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [
        {
          kind: 'electronic',
          scheme: 'mada',
          reference: 'AUTH-1',
          amountMinor: '2300',
          cardNumber: '4111111111111111',
        },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'card_data_refused', field: 'cardNumber' });
  });

  it.each([
    ['zero', [{ kind: 'cash', amountMinor: '0' }]],
    ['two cash lines', [
      { kind: 'cash', amountMinor: '1200' },
      { kind: 'cash', amountMinor: '1200' },
    ]],
    ['a repeated approval', [
      { kind: 'electronic', scheme: 'mada', reference: 'AUTH-1', amountMinor: '1150' },
      { kind: 'electronic', scheme: 'mada', reference: 'AUTH-1', amountMinor: '1150' },
    ]],
  ])('refuses %s as a tender list', async (_label, tenders) => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, { tenders });
    // Either the schema catches it or the domain does; both refuse, and
    // neither creates a sale.
    expect([400, 422]).toContain(response.statusCode);
    expect(business.sales).toHaveLength(0);
  });

  it('refuses an unknown scheme', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [
        { kind: 'electronic', scheme: 'bitcoin', reference: 'AUTH-1', amountMinor: '2300' },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an oversized approval reference', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [
        {
          kind: 'electronic',
          scheme: 'mada',
          reference: 'A'.repeat(65),
          amountMinor: '2300',
        },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 409 when the same key is reused with a different payment mix', async () => {
    // The same basket paid a different way is a different commercial event.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const first = await checkout(app, cookie, { cashReceivedMinor: '5000' });
    expect(first.statusCode).toBe(201);

    const second = await checkout(app, cookie, {
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-2', amountMinor: '2300' },
      ],
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'idempotency-conflict' });
    expect(business.sales).toHaveLength(1);
  });

  it('replays a legacy cash request sent again as its tender equivalent', async () => {
    // The two shapes normalise to the same intent, so this is a retry and not
    // a conflict.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    await checkout(app, cookie, { cashReceivedMinor: '5000' });
    const again = await checkout(app, cookie, {
      tenders: [{ kind: 'cash', amountMinor: '5000' }],
    });

    expect(again.statusCode).toBe(200);
    expect(again.json<{ replayed: boolean }>().replayed).toBe(true);
    expect(business.sales).toHaveLength(1);
  });
});

describe('POST /v1/sales — discounts', () => {
  const operation = '018f2000-0000-7000-8000-0000000000e2';

  function discounted(
    server: FastifyInstance,
    cookie: string,
    overrides: Record<string, unknown>,
  ) {
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

  it('refuses any discount from a cashier, who is authorised for none', async () => {
    // ROLE_MAX_DISCOUNT_BP.cashier is 0 bp. One halala off is still a discount.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await discounted(app, cookie, {
      basketDiscount: { mode: 'fixed', amountMinor: '1' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'discount-not-authorized' });
    expect(business.sales).toHaveLength(0);
  });

  it('lets a manager grant a discount inside their ceiling, and records it', async () => {
    app = await build('manager');
    const cookie = await cookieFor(app);
    const response = await discounted(app, cookie, {
      basketDiscount: { mode: 'basis-points', value: 1_000, reason: 'عرض الافتتاح' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ sale: Record<string, string> }>();
    // 23.00 less 10% is 20.70.
    expect(body.sale['totalMinor']).toBe('2070');

    const recorded = business.sales[0];
    expect(recorded?.discounts).toHaveLength(1);
    expect(recorded?.discounts[0]).toMatchObject({
      scope: 'basket',
      kind: 'percentage',
      inputValue: '1000',
      amountMinor: '230',
      reason: 'عرض الافتتاح',
      grantedByUserId: A.user,
    });
  });

  it('refuses a manager a discount beyond their ceiling', async () => {
    // ROLE_MAX_DISCOUNT_BP.manager is 2000 bp.
    app = await build('manager');
    const cookie = await cookieFor(app);
    const response = await discounted(app, cookie, {
      basketDiscount: { mode: 'basis-points', value: 2_001 },
    });
    expect(response.statusCode).toBe(403);
    expect(business.sales).toHaveLength(0);
  });

  it('refuses a fixed discount that is over the ceiling by less than a basis point', async () => {
    /*
     * The rounding case, end to end. 23.00 at 2000 bp permits 4.60 exactly;
     * 4.61 is 2004 bp once the rate is computed honestly, and truncation used
     * to report it as 2004 too — but on a base that does not divide evenly the
     * old arithmetic let a discount just over the line through.
     */
    app = await build('manager');
    const cookie = await cookieFor(app);

    const allowed = await discounted(app, cookie, {
      basketDiscount: { mode: 'fixed', amountMinor: '460' },
    });
    expect(allowed.statusCode).toBe(201);

    app = await build('manager');
    const cookie2 = await cookieFor(app);
    const refused = await discounted(app, cookie2, {
      basketDiscount: { mode: 'fixed', amountMinor: '461' },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('records a line discount against the line that got it', async () => {
    app = await build('manager');
    const cookie = await cookieFor(app);
    const response = await discounted(app, cookie, {
      lines: [
        {
          productId: A.milk,
          quantityScaled: '2000',
          discount: { mode: 'fixed', amountMinor: '150' },
        },
      ],
    });

    expect(response.statusCode).toBe(201);
    const recorded = business.sales[0];
    expect(recorded?.discounts[0]).toMatchObject({
      scope: 'line',
      lineNumber: 1,
      kind: 'fixed',
      inputValue: '150',
      amountMinor: '150',
    });
    expect(recorded?.totalMinor).toBe('2150');
  });

  it('never lets a client name the discount it was granted', async () => {
    app = await build('manager');
    const cookie = await cookieFor(app);
    const response = await discounted(app, cookie, {
      basketDiscount: { mode: 'basis-points', value: 1_000 },
      discount: { mode: 'fixed', amountMinor: '2300' },
    });
    // `discount` is on the forbidden-field list and is refused by name.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'forbidden_field', field: 'discount' });
  });
});

describe('POST /v1/sales', () => {"""

old = "describe('POST /v1/sales', () => {"
assert old in s
s = s.replace(old, BLOCK, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  settlement and discount route tests added')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/checkout-service.test.ts'
s = open(path, encoding='utf-8').read()
if 'ambiguous-payment' in s:
    print('  already present'); sys.exit(0)

BLOCK = """
describe('the two payment shapes', () => {
  it('refuses a request that names both, and one that names neither', async () => {
    // Guessing which the client meant is how a sale gets settled twice over.
    const both = await service.checkout({
      principal: principal(),
      operationId: '018f1000-0000-7000-8000-0000000000d1',
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      tenders: [{ kind: 'cash', amountMinor: '5000' }],
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    expect(both.outcome === 'failure' && both.reason).toBe('ambiguous-payment');

    const neither = await service.checkout({
      principal: principal(),
      operationId: '018f1000-0000-7000-8000-0000000000d2',
      terminalId: A.terminal,
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    expect(neither.outcome === 'failure' && neither.reason).toBe('ambiguous-payment');
    expect(store.sales).toHaveLength(0);
  });

  it('normalises the legacy cash figure into one cash tender', async () => {
    const result = await service.checkout({
      principal: principal(),
      operationId: '018f1000-0000-7000-8000-0000000000d3',
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const tenders = store.sales[0]?.tenders ?? [];
    expect(tenders).toHaveLength(1);
    expect(tenders[0]).toMatchObject({ kind: 'cash', scheme: null, amountMinor: '5000' });
    expect(tenders[0]?.changeMinor).toBe('2700');
  });

  it('still reports an empty legacy cash amount as underpaid', async () => {
    // The refusal the till already understands. Reporting it as a malformed
    // tender would change a contract this strike promised not to break.
    const result = await service.checkout({
      principal: principal(),
      operationId: '018f1000-0000-7000-8000-0000000000d4',
      terminalId: A.terminal,
      cashReceivedMinor: '0',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    expect(result.outcome === 'failure' && result.reason).toBe('insufficient-cash');
  });
});
"""

# Appended at the end of the file, after the existing describes.
s = s.rstrip('\n') + '\n' + BLOCK
open(path, 'w', encoding='utf-8').write(s)
print('  checkout service payment-shape tests added')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/checkout-service.test.ts'
s = open(path, encoding='utf-8').read()
if 'tenders: [{ kind:' in s and 'basketDiscount:' in s:
    print('  fingerprint tests already updated'); sys.exit(0)

start = s.index("describe('the intent fingerprint', () => {")
end = s.index("describe('what a client may not decide', () => {")

BLOCK = """describe('the intent fingerprint', () => {
  const base = {
    branchId: A.branch,
    terminalId: A.terminal,
    lines: [{ productId: A.milk, quantityScaled: '2000', discount: '' }],
    tenders: [{ kind: 'cash', amountMinor: '5000', scheme: '', reference: '' }],
    basketDiscount: '',
  };

  it('is stable across line order', () => {
    const two = {
      ...base,
      lines: [...base.lines, { productId: A.rice, quantityScaled: '1000', discount: '' }],
    };
    const reversed = { ...two, lines: [...two.lines].reverse() };
    expect(fingerprintIntent(two)).toBe(fingerprintIntent(reversed));
  });

  it('is stable across tender order', () => {
    // A cashier who keys the card first and a cashier who keys the cash first
    // are describing the same payment.
    const split = {
      ...base,
      tenders: [
        { kind: 'cash', amountMinor: '2000', scheme: '', reference: '' },
        { kind: 'electronic', amountMinor: '1000', scheme: 'mada', reference: 'AUTH-1' },
      ],
    };
    const swapped = { ...split, tenders: [...split.tenders].reverse() };
    expect(fingerprintIntent(split)).toBe(fingerprintIntent(swapped));
  });

  it.each([
    ['quantity', { ...base, lines: [{ productId: A.milk, quantityScaled: '2001', discount: '' }] }],
    ['product', { ...base, lines: [{ productId: A.rice, quantityScaled: '2000', discount: '' }] }],
    ['terminal', { ...base, terminalId: A.shift }],
    [
      'cash figure',
      { ...base, tenders: [{ kind: 'cash', amountMinor: '5001', scheme: '', reference: '' }] },
    ],
    [
      'payment mix',
      {
        ...base,
        tenders: [
          { kind: 'electronic', amountMinor: '2300', scheme: 'mada', reference: 'AUTH-1' },
        ],
      },
    ],
    [
      'approval reference',
      {
        ...base,
        tenders: [
          { kind: 'electronic', amountMinor: '2300', scheme: 'mada', reference: 'AUTH-2' },
        ],
      },
    ],
    ['basket discount', { ...base, basketDiscount: 'bp:1000' }],
    [
      'line discount',
      { ...base, lines: [{ productId: A.milk, quantityScaled: '2000', discount: 'fx:150' }] },
    ],
  ])('changes with the %s', (_label, changed) => {
    // Each of these is a different commercial event. Replaying one as another
    // would be wrong in a way nobody could reconstruct from the sale row.
    expect(fingerprintIntent(changed)).not.toBe(fingerprintIntent(base));
  });

  it('carries nothing secret', () => {
    // A digest of ids, quantities, amounts, a scheme name and somebody else's
    // approval reference — the same things the sale row holds in the clear.
    expect(fingerprintIntent(base)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

"""
s = s[:start] + BLOCK + s[end:]
open(path, 'w', encoding='utf-8').write(s)
print('  fingerprint tests updated')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/business-routes.test.ts'
s = open(path, encoding='utf-8').read()
if "describe('POST /v1/sales — the drawer'" in s:
    print('  already present'); sys.exit(0)

BLOCK = """describe('POST /v1/sales — the drawer', () => {
  function checkout(
    server: FastifyInstance,
    cookie: string,
    overrides: Record<string, unknown> = {},
  ) {
    return server.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000e5',
        terminalId: A.terminal,
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        ...overrides,
      },
    });
  }

  it('moves the drawer by the cash that stayed in it, not by the sale total', async () => {
    // 23.00 sale, 10.00 on a card, 20.00 cash, 7.00 back. The drawer gained
    // 13.00. Recording 23.00 would leave every shift short by the card
    // portion, every day, with nothing to point at.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    await checkout(app, cookie, {
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-3', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });

    expect(business.cashMovements).toHaveLength(1);
    expect(business.cashMovements[0]).toMatchObject({ kind: 'sale', amountMinor: '1300' });
  });

  it('records no drawer movement at all for an electronic-only sale', async () => {
    // Nothing was taken in cash. A zero row is a movement that did not happen.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await checkout(app, cookie, {
      tenders: [
        { kind: 'electronic', scheme: 'visa', reference: 'AUTH-4', amountMinor: '2300' },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(business.cashMovements).toHaveLength(0);
  });

  it('leaves the cash-only drawer effect exactly as it was', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    await checkout(app, cookie, { cashReceivedMinor: '5000' });

    // 50.00 given, 27.00 back, 23.00 retained — which for a cash-only sale is
    // the total, as it always was.
    expect(business.cashMovements[0]).toMatchObject({ kind: 'sale', amountMinor: '2300' });
  });
});

describe('POST /v1/sales — discount permission', () => {
  it('refuses a discount from a principal whose grants omit sale.discount', async () => {
    // The ceiling says how much; the permission says whether at all. A role
    // may confer a ceiling while the persisted grant does not confer the
    // capability, and permissions are what the server checks.
    app = await build('manager');
    auth.grants[0] = {
      tenantId: A.tenant,
      userId: A.user,
      roles: ['manager'],
      permissions: ['product.read', 'sale.create', 'shift.open'],
    };
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000e6',
        terminalId: A.terminal,
        cashReceivedMinor: '5000',
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        basketDiscount: { mode: 'basis-points', value: 500 },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'discount-not-authorized' });
    expect(business.sales).toHaveLength(0);
  });

  it('still lets that principal sell without a discount', async () => {
    app = await build('manager');
    auth.grants[0] = {
      tenantId: A.tenant,
      userId: A.user,
      roles: ['manager'],
      permissions: ['product.read', 'sale.create', 'shift.open'],
    };
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000e7',
        terminalId: A.terminal,
        cashReceivedMinor: '5000',
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
      },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('POST /v1/sales — a card number by any name', () => {
  it('refuses an approval reference that is really a card number', async () => {
    // A synthetic test PAN. Rejecting fields called `pan` does not stop an
    // integration putting one in `reference`.
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000e8',
        terminalId: A.terminal,
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        tenders: [
          {
            kind: 'electronic',
            scheme: 'visa',
            reference: '4111 1111 1111 1111',
            amountMinor: '2300',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'card_data_refused' });
    // The refusal must not become the place the number gets written down.
    expect(response.payload).not.toContain('4111');
    expect(business.sales).toHaveLength(0);
  });

  it('leaves ordinary approval codes alone', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000e9',
        terminalId: A.terminal,
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
        tenders: [
          { kind: 'electronic', scheme: 'mada', reference: '004512', amountMinor: '2300' },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('POST /v1/sales — settlement', () => {"""

old = "describe('POST /v1/sales — settlement', () => {"
assert old in s
s = s.replace(old, BLOCK, 1)
open(path, 'w', encoding='utf-8').write(s)
print('  drawer, permission and card-value tests added')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/checkout-service.test.ts'
s = open(path, encoding='utf-8').read()
if 'cannot be made to collide' in s:
    print('  already present'); sys.exit(0)

BLOCK = """
describe('the canonical form cannot be forged', () => {
  const base = {
    branchId: A.branch,
    terminalId: A.terminal,
    lines: [{ productId: A.milk, quantityScaled: '2000', discount: '' }],
    basketDiscount: '',
  };

  it('cannot be made to collide with a delimiter-bearing reference', () => {
    /*
     * The concrete attack on a hand-joined canonical form. Joining fields with
     * ':' and records with ',' means a reference containing both can spell out
     * a second record. One tender whose reference is
     * "R,electronic:visa:100:X" would produce the same joined string as two
     * tenders with references "R" and "X" — two materially different sales,
     * one fingerprint, and a replay that returns the wrong one.
     *
     * JSON gives the separators structure rather than meaning, so the two
     * cannot meet.
     */
    const one = {
      ...base,
      tenders: [
        {
          kind: 'electronic',
          amountMinor: '100',
          scheme: 'mada',
          reference: 'R,electronic:visa:100:X',
        },
      ],
    };
    const two = {
      ...base,
      tenders: [
        { kind: 'electronic', amountMinor: '100', scheme: 'mada', reference: 'R' },
        { kind: 'electronic', amountMinor: '100', scheme: 'visa', reference: 'X' },
      ],
    };

    expect(fingerprintIntent(one)).not.toBe(fingerprintIntent(two));
  });

  it('cannot be made to collide across the field boundary', () => {
    const spilled = {
      ...base,
      tenders: [
        { kind: 'electronic', amountMinor: '100', scheme: 'mada', reference: '"],["x' },
      ],
    };
    const plain = {
      ...base,
      tenders: [{ kind: 'electronic', amountMinor: '100', scheme: 'mada', reference: 'x' }],
    };
    expect(fingerprintIntent(spilled)).not.toBe(fingerprintIntent(plain));
  });

  it('cannot be made to collide across the line boundary', () => {
    const spilled = {
      ...base,
      tenders: [{ kind: 'cash', amountMinor: '100', scheme: '', reference: '' }],
      lines: [{ productId: A.milk, quantityScaled: '2000', discount: 'fx:1,p:2' }],
    };
    const plain = {
      ...base,
      tenders: [{ kind: 'cash', amountMinor: '100', scheme: '', reference: '' }],
      lines: [
        { productId: A.milk, quantityScaled: '2000', discount: 'fx:1' },
        { productId: A.rice, quantityScaled: 'p:2', discount: '' },
      ],
    };
    expect(fingerprintIntent(spilled)).not.toBe(fingerprintIntent(plain));
  });
});
"""
s = s.rstrip('\n') + '\n' + BLOCK
open(path, 'w', encoding='utf-8').write(s)
print('  canonicalisation collision tests added')
PY

python3 - <<'PY'
import sys
path = 'apps/api/src/__tests__/checkout-service.test.ts'
s = open(path, encoding='utf-8').read()
if 'emits sale.completed for every sale' in s:
    print('  already present'); sys.exit(0)

BLOCK = """
describe('what the audit says', () => {
  it('emits sale.completed for every sale, discounted or not', async () => {
    const result = await service.checkout({
      principal: principal(),
      operationId: '018f1000-0000-7000-8000-0000000000d5',
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);
    expect(store.audit.map((event) => event.eventType)).toEqual(['sale.completed']);
  });

  it('adds sale.discounted alongside it, never instead of it', async () => {
    // Replacing the canonical event would break the invariant that every
    // completed sale emits one, and every report built on that invariant.
    const result = await service.checkout({
      principal: principal({
        roles: ['manager'],
        permissions: [...ROLE_PERMISSIONS.manager],
        maxDiscountBasisPoints: 2_000n,
      }),
      operationId: '018f1000-0000-7000-8000-0000000000d6',
      terminalId: A.terminal,
      cashReceivedMinor: '5000',
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
      basketDiscount: { mode: 'basis-points', value: 1_000 },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    expect(store.audit.map((event) => event.eventType)).toEqual([
      'sale.completed',
      'sale.discounted',
    ]);
    // Nothing that belongs to somebody else's system.
    expect(JSON.stringify(store.audit)).not.toContain('AUTH-');
  });
});
"""
s = s.rstrip('\n') + '\n' + BLOCK
open(path, 'w', encoding='utf-8').write(s)
print('  audit compatibility tests added')
PY

say "Tests — settlement against a real PostgreSQL server"

cat << 'EOF' > apps/api/src/__tests__/settlement-live.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { basisPoints, newId, tenantId as brandTenantId } from '@korvi/domain';
import {
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
  TenantScope,
} from '@korvi/domain';

/**
 * Settlement, priced and persisted by a real server.
 *
 * The questions here are the ones a fake cannot answer: whether a split tender
 * survives the round trip with its scheme and its change attribution intact,
 * whether a discounted sale reconciles against the CHECK constraints the
 * database itself enforces, and whether a failure part-way through leaves
 * anything behind.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with
 * every migration applied, connected as the application role — not a
 * superuser, which bypasses RLS.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const S = {
  tenant: '018f5000-0000-7000-8000-00000000000a',
  slug: 'settle-live-a',
  branch: '018f5000-0000-7000-8000-0000000000b1',
  terminal: '018f5000-0000-7000-8000-0000000000c1',
  shift: '018f5000-0000-7000-8000-0000000000d1',
  user: '018f5000-0000-7000-8000-0000000000e1',
  membership: '018f5000-0000-7000-8000-0000000000e2',
  milk: '018f5000-0000-7000-8000-0000000000f1',
  odd: '018f5000-0000-7000-8000-0000000000f2',
} as const;

describe.skipIf(url === '')('settlement, live', () => {
  let prisma: PrismaClient;
  let service: CheckoutService;
  let sales: SaleRepository;
  let principal: AuthenticatedPrincipal;

  const scope: TenantScope = { tenantId: brandTenantId(S.tenant) };

  async function remove(): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: S.tenant } });
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: S.tenant,
          name: 'متجر كورفي',
          slug: S.slug,
          vatNumber: '300000000000003',
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({ data: { tenantId: S.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: { id: S.branch, tenantId: S.tenant, code: '05', nameAr: 'الفرع', updatedAt: new Date() },
      });
      await tx.user.create({
        data: {
          id: S.user,
          tenantId: S.tenant,
          email: 'noura@settle-live-a.test',
          displayName: 'نورة',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: S.membership, tenantId: S.tenant, userId: S.user, updatedAt: new Date() },
      });
      await tx.terminal.create({
        data: {
          id: S.terminal,
          tenantId: S.tenant,
          branchId: S.branch,
          code: '01',
          label: 'صندوق ١',
          updatedAt: new Date(),
        },
      });
      await tx.shift.create({
        data: {
          id: S.shift,
          tenantId: S.tenant,
          branchId: S.branch,
          terminalId: S.terminal,
          userId: S.user,
          openingFloatMinor: 20_000n,
          openedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      for (const [id, sku, price] of [
        [S.milk, 'MILK-1L', 1_150n],
        // A price that divides badly, on purpose.
        [S.odd, 'ODD-1', 333n],
      ] as const) {
        await tx.product.create({
          data: {
            id,
            tenantId: S.tenant,
            sku,
            nameAr: 'صنف',
            priceMinor: price,
            vatBasisPoints: 1500,
            updatedAt: new Date(),
          },
        });
        await tx.inventoryBalance.create({
          data: {
            tenantId: S.tenant,
            branchId: S.branch,
            productId: id,
            quantityScaled: 1_000_000n,
            updatedAt: new Date(),
          },
        });
      }
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, S.user, 'manager');

    sales = createSaleRepository(prisma);
    service = createCheckoutService({
      tenants: createTenantRepository(prisma),
      products: createProductRepository(prisma),
      inventory: createInventoryRepository(prisma),
      shifts: createShiftRepository(prisma),
      sales,
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });

    principal = {
      tenantId: S.tenant,
      tenantSlug: S.slug,
      userId: S.user,
      sessionId: newId(),
      email: 'noura@settle-live-a.test',
      displayName: 'نورة',
      roles: ['manager'],
      permissions: ['sale.create', 'sale.discount', 'product.read'],
      // The ceiling a manager carries. Read from the roles, never the request.
      maxDiscountBasisPoints: 2_000n,
      branchId: S.branch,
    };
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  it('persists a split tender with its scheme, its reference and its change', async () => {
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-LIVE-1', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const rows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.tender.findMany({ where: { saleId: result.sale.saleId }, orderBy: { kind: 'asc' } }),
    );

    expect(rows).toHaveLength(2);
    const cash = rows.find((row) => row.kind === 'cash');
    const card = rows.find((row) => row.kind === 'electronic');

    expect(card?.scheme).toBe('mada');
    expect(card?.reference).toBe('AUTH-LIVE-1');
    expect(card?.amountMinor).toBe(1_000n);
    // A card terminal cannot hand money back, and the row says so.
    expect(card?.changeMinor).toBe(0n);

    expect(cash?.scheme).toBeNull();
    expect(cash?.amountMinor).toBe(2_000n);
    expect(cash?.changeMinor).toBe(700n);

    // 23.00 due, 30.00 given, 7.00 back: 13.00 of cash stays in the drawer.
    expect(result.sale.totalMinor).toBe('2300');
    expect(result.sale.changeMinor).toBe('700');
    const retained = (cash?.amountMinor ?? 0n) - (cash?.changeMinor ?? 0n);
    expect(retained).toBe(1_300n);
  }, 30_000);

  it('reads a split tender back with its scheme intact', async () => {
    // A replay has to return what was recorded, not a cash-shaped guess.
    const operationId = newId();
    const request = {
      principal,
      operationId,
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '1000' }],
      tenders: [
        { kind: 'electronic' as const, scheme: 'visa' as const, reference: 'AUTH-LIVE-2', amountMinor: '1150' },
      ],
    };
    const first = await service.checkout(request);
    const second = await service.checkout(request);
    if (first.outcome !== 'success' || second.outcome !== 'success') throw new Error('expected success');

    expect(second.replayed).toBe(true);
    const recorded = await sales.findByOperationId(scope, operationId);
    expect(recorded?.tenders[0]).toMatchObject({
      kind: 'electronic',
      scheme: 'visa',
      reference: 'AUTH-LIVE-2',
      changeMinor: '0',
    });
  }, 30_000);

  it('reconciles a discounted basket that does not divide evenly', async () => {
    // Three lines at 3.33, 10% off the basket. The discount is 1 halala short
    // of dividing by three, and the database's own CHECK constraints refuse a
    // sale whose parts do not sum to its total.
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.odd, quantityScaled: '3000' }],
      basketDiscount: { mode: 'basis-points', value: 1_000, reason: 'عرض' },
      tenders: [{ kind: 'cash', amountMinor: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const rows = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sale: await tx.sale.findFirstOrThrow({
        where: { id: result.sale.saleId },
        include: { lines: true, discounts: true, invoice: { include: { taxBreakdown: true } } },
      }),
    }));

    const sale = rows.sale;
    const lineNet = sale.lines.reduce((total, line) => total + line.netMinor, 0n);
    const lineVat = sale.lines.reduce((total, line) => total + line.vatMinor, 0n);
    const basketShares = sale.lines.reduce((total, line) => total + line.basketDiscountMinor, 0n);

    expect(lineNet).toBe(sale.netMinor);
    expect(lineVat).toBe(sale.vatMinor);
    expect(sale.netMinor + sale.vatMinor).toBe(sale.totalMinor);
    expect(basketShares).toBe(sale.basketDiscountMinor);
    expect(sale.tenderedMinor - sale.changeMinor).toBe(sale.totalMinor);

    // 9.99 less 10% is 8.99 (999 - 100 rounded once), and the discount row
    // records what was asked for and what was actually granted.
    expect(sale.discounts).toHaveLength(1);
    expect(sale.discounts[0]?.scope).toBe('basket');
    expect(sale.discounts[0]?.kind).toBe('percentage');
    expect(sale.discounts[0]?.inputValue).toBe(1_000n);
    expect(sale.discounts[0]?.amountMinor).toBe(sale.basketDiscountMinor);
    expect(sale.discounts[0]?.grantedByUserId).toBe(S.user);
    expect(sale.discounts[0]?.createdAt).toBeInstanceOf(Date);

    // The tax breakdown still adds up to the invoice.
    const buckets = sale.invoice?.taxBreakdown ?? [];
    expect(buckets.reduce((total, bucket) => total + bucket.vatMinor, 0n)).toBe(sale.vatMinor);
  }, 30_000);

  it('refuses a discount past the ceiling before anything is written', async () => {
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { tenantId: S.tenant } }),
    );
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      basketDiscount: { mode: 'basis-points', value: 2_001 },
      tenders: [{ kind: 'cash', amountMinor: '2000' }],
    });

    expect(result.outcome === 'failure' && result.reason).toBe('discount-not-authorized');
    const after = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { tenantId: S.tenant } }),
    );
    expect(after).toBe(before);
  }, 30_000);

  it('leaves nothing behind when a discounted split-tender sale dies mid-transaction', async () => {
    /*
     * The failure lands after the receipt number has been taken, after the
     * operation id has been reserved, and after the sale row itself exists —
     * a sale line pointing at a product that does not exist fails the foreign
     * key in PostgreSQL. Everything must go back, including the tender rows
     * and the discount rows this strike added.
     */
    const ghost = '018f5000-0000-7000-8000-0000000000ff';
    const saleId = newId();
    const operationId = newId();
    const issuedAt = new Date().toISOString();

    const doomed: RecordSaleInput = {
      sale: {
        id: saleId,
        branchId: S.branch,
        terminalId: S.terminal,
        shiftId: S.shift,
        userId: S.user,
        customerId: null,
        operationId,
        status: 'finalized',
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        grossMinor: '1150',
        lineDiscountMinor: '0',
        basketDiscountMinor: '150',
        netMinor: '870',
        vatMinor: '130',
        totalMinor: '1000',
        tenderedMinor: '1000',
        changeMinor: '0',
        issuedAt,
        lines: [
          {
            id: newId(),
            lineNumber: 1,
            productId: ghost,
            sku: 'GHOST-1',
            nameAr: 'صنف',
            nameEn: null,
            unitPriceMinor: '1150',
            vatBasisPoints: basisPoints(1500),
            quantityScaled: '1000',
            grossMinor: '1150',
            lineDiscountMinor: '0',
            basketDiscountMinor: '150',
            netMinor: '870',
            vatMinor: '130',
            totalMinor: '1000',
          },
        ],
        discounts: [
          {
            id: newId(),
            scope: 'basket',
            lineNumber: null,
            kind: 'fixed',
            inputValue: '150',
            amountMinor: '150',
            reason: 'test',
            grantedByUserId: S.user,
          },
        ],
        tenders: [
          {
            id: newId(),
            kind: 'electronic',
            scheme: 'mada',
            amountMinor: '1000',
            changeMinor: '0',
            reference: 'AUTH-DOOMED',
          },
        ],
      },
      invoice: {
        id: newId(),
        saleId,
        invoiceType: 'simplified',
        sellerName: 'متجر كورفي',
        sellerVatNumber: '300000000000003',
        buyerName: null,
        buyerVatNumber: null,
        netMinor: '870',
        vatMinor: '130',
        totalMinor: '1000',
        currency: 'SAR',
        issuedAt,
        taxBreakdown: [{ vatBasisPoints: basisPoints(1500), netMinor: '870', vatMinor: '130' }],
      },
      inventory: [],
      cashMovement: {
        id: newId(),
        shiftId: S.shift,
        kind: 'sale',
        amountMinor: '1000',
        reason: null,
        actorUserId: S.user,
        occurredAt: issuedAt,
      },
      idempotency: {
        id: newId(),
        scope: 'checkout',
        operationId,
        requestHash: null,
      },
    };

    await expect(sales.record(scope, doomed)).rejects.toThrow();

    const survivors = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { id: saleId } }),
      lines: await tx.saleLine.count({ where: { saleId } }),
      tenders: await tx.tender.count({ where: { saleId } }),
      discounts: await tx.saleDiscount.count({ where: { saleId } }),
      invoices: await tx.invoice.count({ where: { saleId } }),
      keys: await tx.idempotencyKey.count({ where: { operationId } }),
    }));
    expect(survivors).toEqual({
      sales: 0,
      lines: 0,
      tenders: 0,
      discounts: 0,
      invoices: 0,
      keys: 0,
    });
  }, 30_000);

  it('lets the database refuse a settlement the application should never write', async () => {
    // The constraints are the last line, not the first. Each of these is
    // written directly, past every application guard.
    const badRows: readonly [string, string][] = [
      [
        'an electronic tender with no scheme',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","amountMinor","changeMinor","reference")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'electronic', 100, 0, 'AUTH-X')`,
      ],
      [
        'a cash tender wearing an approval reference',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","amountMinor","changeMinor","reference")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'cash', 100, 0, 'AUTH-Z')`,
      ],
      [
        'a cash tender wearing a scheme',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","scheme","amountMinor","changeMinor")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'cash', 'visa', 100, 0)`,
      ],
      [
        'an electronic tender giving change',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","scheme","amountMinor","changeMinor","reference")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'electronic', 'mada', 100, 10, 'AUTH-Y')`,
      ],
      [
        'a tender of nothing',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","amountMinor","changeMinor")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'cash', 0, 0)`,
      ],
      [
        'change larger than the cash it came from',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","amountMinor","changeMinor")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'cash', 100, 101)`,
      ],
      [
        'a rate discount above 100 per cent',
        `INSERT INTO "sale_discounts" ("id","tenantId","saleId","scope","kind","inputValue","amountMinor")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'basket', 'percentage', 10001, 1)`,
      ],
      [
        'a line discount naming no line',
        `INSERT INTO "sale_discounts" ("id","tenantId","saleId","scope","kind","inputValue","amountMinor")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'line', 'fixed', 1, 1)`,
      ],
    ];

    const anchor = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '1000' }],
      tenders: [{ kind: 'cash', amountMinor: '1150' }],
    });
    if (anchor.outcome !== 'success') throw new Error(anchor.reason);

    for (const [description, sql] of badRows) {
      await expect(
        withTenant(prisma, scope.tenantId, (tx) =>
          tx.$executeRawUnsafe(sql, S.tenant, anchor.sale.saleId),
        ),
        description,
      ).rejects.toThrow();
    }
  }, 60_000);

  it('moves the drawer by the cash that stayed in it', async () => {
    // 23.00 sale, 10.00 on a card, 20.00 cash, 7.00 back. The drawer gained
    // 13.00 — not 23.00, which is what recording the total would have said and
    // what would have left every shift short by the card portion.
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-DRAWER-1', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const movements = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.findMany({
        where: { tenantId: S.tenant, shiftId: S.shift, kind: 'sale' },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      }),
    );
    expect(movements[0]?.amountMinor).toBe(1_300n);
  }, 30_000);

  it('records no drawer movement for a sale settled entirely on a card', async () => {
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { tenantId: S.tenant, kind: 'sale' } }),
    );
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      tenders: [
        { kind: 'electronic', scheme: 'visa', reference: 'AUTH-DRAWER-2', amountMinor: '2300' },
      ],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const after = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { tenantId: S.tenant, kind: 'sale' } }),
    );
    // Nothing was taken in cash, so nothing moved. A zero row would be a
    // movement that did not happen.
    expect(after).toBe(before);
  }, 30_000);

  it('leaves the cash-only drawer effect exactly as it was', async () => {
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      cashReceivedMinor: '5000',
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const movements = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.findMany({
        where: { tenantId: S.tenant, shiftId: S.shift, kind: 'sale' },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      }),
    );
    // 50.00 given, 27.00 back, 23.00 retained — the total, as it always was.
    expect(movements[0]?.amountMinor).toBe(2_300n);
    expect(result.sale.tenderedMinor).toBe('5000');
    expect(result.sale.cashReceivedMinor).toBe('5000');
  }, 30_000);

  it('tells the tendered total apart from the cash in the drawer', async () => {
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-SUMMARY-1', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    expect(result.sale.tenderedMinor).toBe('3000');
    expect(result.sale.cashReceivedMinor).toBe('2000');
    expect(result.sale.changeMinor).toBe('700');

    // And a replay says the same, from the persisted rows.
    const replay = await service.checkout({
      principal,
      operationId: result.sale.operationId,
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-SUMMARY-1', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });
    if (replay.outcome !== 'success') throw new Error(replay.reason);
    expect(replay.replayed).toBe(true);
    expect(replay.sale.tenderedMinor).toBe('3000');
    expect(replay.sale.cashReceivedMinor).toBe('2000');
    expect(
      replay.sale.tenders.map((tender) => [tender.kind, tender.scheme, tender.amountMinor]).sort(),
    ).toEqual([
      ['cash', null, '2000'],
      ['electronic', 'mada', '1000'],
    ]);
  }, 30_000);

  it('lets the database refuse a second cash tender and a repeated approval', async () => {
    // Defence in depth. The domain refuses both first, so an ordinary checkout
    // never meets these; what they stop is everything that is not one.
    const anchor = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '1000' }],
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-DUP-1', amountMinor: '575' },
        { kind: 'cash', amountMinor: '575' },
      ],
    });
    if (anchor.outcome !== 'success') throw new Error(anchor.reason);

    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "tenders" ("id","tenantId","saleId","kind","amountMinor","changeMinor")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'cash', 100, 0)`,
          S.tenant,
          anchor.sale.saleId,
        ),
      ),
    ).rejects.toThrow(/tenders_one_cash_per_sale/);

    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "tenders" ("id","tenantId","saleId","kind","scheme","reference","amountMinor","changeMinor")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'electronic', 'mada', 'AUTH-DUP-1', 100, 0)`,
          S.tenant,
          anchor.sale.saleId,
        ),
      ),
    ).rejects.toThrow(/tenders_one_approval_per_sale/);

    // A different approval on the same scheme is ordinary and stays legal.
    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "tenders" ("id","tenantId","saleId","kind","scheme","reference","amountMinor","changeMinor")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'electronic', 'mada', 'AUTH-DUP-2', 100, 0)`,
          S.tenant,
          anchor.sale.saleId,
        ),
      ),
    ).resolves.toBeDefined();
  }, 30_000);

  it('refuses a discount attributed to a user in another tenant', async () => {
    // Composite tenant-consistent foreign key (ADR-0004): RLS is not the only
    // thing standing between two merchants' audit trails.
    const anchor = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '1000' }],
      tenders: [{ kind: 'cash', amountMinor: '1150' }],
    });
    if (anchor.outcome !== 'success') throw new Error(anchor.reason);

    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "sale_discounts"
             ("id","tenantId","saleId","scope","kind","inputValue","amountMinor","grantedByUserId")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'basket', 'fixed', 1, 1, $3::uuid)`,
          S.tenant,
          anchor.sale.saleId,
          '018f5000-0000-7000-8000-00000000dead',
        ),
      ),
    ).rejects.toThrow(/sale_discounts_tenantId_grantedByUserId_fkey/);
  }, 30_000);
});

describe.skipIf(url !== '')('settlement, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
EOF

say "ADR-0015 — settlement, discounts and the boundary of what Korvi claims"

cat << 'EOF' > docs/decisions/ADR-0015-commercial-settlement.md
# ADR-0015 — Commercial settlement: tenders and discounts

Status: accepted
Date: 2026-08-18
Extends ADR-0002 (money), ADR-0004 (multi-tenancy), ADR-0013 (the checkout
transaction).

Scope: the sale side of the commercial core. Returns, refunds, drawer
movements and shift close are Strike 3B-1b and are deliberately not here.

## Context

Until this strike a Korvi sale was cash, whole, and undiscounted. That is a
real shop for about a week. What a merchant actually needs is to take part of a
sale on a card and the rest in cash, and to take money off a price without
handing the cashier the ability to give the shop away.

Both are arithmetic problems before they are feature problems, and the
arithmetic is where a POS quietly loses money.

## Decision 1 — Two request shapes, one settlement engine

`POST /v1/sales` accepts either `cashReceivedMinor` — the shape the production
till sends today — or a `tenders` array. Exactly one. A request carrying both
is refused, because a client that sends both does not know which it means and
guessing on its behalf is how a sale gets settled twice over.

The legacy figure is normalised into a one-line cash tender at the edge of the
service. Everything after that point sees a tender list. There is no second
checkout path and there must never be one: two implementations of the
arithmetic that decides what a customer is charged will diverge, quietly, on
whichever path is exercised least.

## Decision 2 — Electronic tender is a record, not a payment

Korvi does not contact a bank, a scheme, an acquirer, a gateway or a wallet.
An `electronic` tender means: *this payment was approved somewhere else, and
Korvi is recording the settlement.* Nothing in the code, the schema or the API
should ever be read as claiming otherwise.

What it carries: a closed list of schemes (`mada`, `visa`, `mastercard`,
`amex`, `apple-pay`, `other`) and an external reference, bounded to 64
characters. The scheme is closed because it is a label on a financial row that
every future report groups by, and an open string would put unbounded operator
text into that.

What it does not carry, and what the API refuses at any nesting depth — by
field name *and* by value: PAN, card number, CVV/CVC, track data, expiry, PIN,
EMV data. The value check matters more than the name check, because a broken
integration will put a card number in a field called `reference` long before it
puts one in a field called `pan`. Anything that normalises to 13–19 digits and
satisfies Luhn is treated as a probable card number and refused, at the HTTP
edge and again in the domain. The refusal names no value and echoes nothing: a
message that quotes the number is a message that writes it down. Ordinary
approval codes — shorter, or carrying letters, or failing the checksum — are
unaffected. A client sending
those has a bug that will keep sending them, and the person who should find out
is the developer rather than an auditor reading a database years later. Korvi
is not in the cardholder-data business, and the refusal is where that stops
being a policy and starts being a control.

The older `card` / `mada` / `transfer` kinds remain readable so rows already
committed still map. No route writes them.

## Decision 3 — Change comes from cash, and only from cash

The settlement rules, all enforced in the domain rather than in a route,
because a till, an integration and a repair script must be refused the same
things:

- the tenders must cover the total, or the sale is underpaid;
- the electronic total may never exceed the amount due — a card charged 24.00
  against a 23.00 sale is a customer overcharged, and no amount of cash in the
  drawer can give it back, so it is refused rather than settled;
- change is drawn from cash and attributed to the cash tender row. An
  electronic row with change on it would describe a card terminal handing money
  back. The database refuses it too (`tenders_change_cash_only`,
  `tenders_change_within_amount`);
- at most one cash tender. Two cash lines is a drawer nobody can reconcile:
  the change has to come out of one of them and no fact says which;
- no zero tender, because a zero line records a method that was not used and
  it reaches a receipt;
- no repeated `(scheme, reference)`, because two lines pointing at one approval
  double-count somebody else's transaction. Two different references on the
  same scheme are fine — a customer may present two cards.

What stays in the drawer from a sale is therefore `cash tendered − change`,
and that — not the sale total — is what the sale's cash movement records. The
total was right only while every sale was cash: on a split payment the card
settles part of it and never touches the till, so recording the total would
overstate the drawer by exactly the electronic portion, every day, with nothing
to point at. A sale settled entirely on a card writes **no** cash movement at
all; a zero row would be a movement that did not happen. This is the figure
Strike 3B-1b reconciles against.

The API response tells the three apart, because they are three different
facts: `tenderedMinor` (everything presented), `cashReceivedMinor` (the cash
tender alone) and `changeMinor`. On a cash-only sale the first two are equal,
which is why the 3A-2 browser is unaffected. A `tenders` array carries the
composition for the receipt, read from the persisted rows on a fresh sale and
on a replay alike.

## Decision 4 — A discount needs the permission *and* the ceiling

`maxDiscountBasisPoints` says how much. It does not say whether at all. A
principal can hold a role-derived ceiling while their persisted permission set
omits `sale.discount`, and permissions — not roles — are what this server
checks. Any line or basket discount therefore requires both: the permission in
the persisted grant, and the amount inside the ceiling. Neither is ever read
from the request.

A sale with no discount needs only `sale.create`, exactly as before.

## Decision 5 — A discount ceiling that rounding cannot walk through

Discounts are line-level or basket-level, and either a rate in basis points or
a fixed number of halalas. The authority is `maxDiscountBasisPoints` on the
authenticated principal, resolved from persisted roles — never from the
request. A cashier's ceiling is `0`, so a cashier grants nothing; a manager's
is 2000 bp.

A fixed discount has to be comparable to a rate ceiling or the ceiling means
nothing against half the discounts a shop gives. So it is converted to the rate
it represents, against the undiscounted gross:

```
effectiveBp = ceil(grantedMinor × 10000 / eligibleBase)
```

**Rounded up, and that is the point.** Truncating division is the obvious way
to write it and it is wrong in a way nobody notices: 200 halalas off a base of
1999 is 1000.5 bp, and truncation reports 1000 — so a cashier capped at 1000 bp
is granted it, every time, repeatably. One halala over the ceiling as a policy
the merchant never set. Ceiling division means the ceiling is a ceiling: a
discount is authorised only if the rate it truly represents is inside it.

Over the ceiling is a deterministic refusal (`discount-not-authorized`, HTTP
403), never a silent clamp. Clamping would charge the customer a different
price from the one the cashier promised them.

### The base is the base it was taken from

Comparing every discount against the *cart* gross lets a fixed amount destroy a
small line and still look modest: a manager capped at 2000 bp, given a 10.00
line beside a 90.00 line, could take 10.00 off the small one — a 100 per cent
discount on that line — because 10.00 of a 100.00 cart reads as 1000 bp. So
each scope is measured against its own base:

- a **line** discount against that line's undiscounted extended price;
- a **basket** discount against the basket *after* line discounts, because that
  is the base `priceCart` actually applies it to;
- and then **everything together** against the undiscounted cart gross, so
  several individually-legal discounts cannot be stacked into an illegal one.

A fixed amount larger than the base it is taken from is refused as
`invalid-discount` — not capped. `applyDiscount` clamps such a value, which is
right for pricing and wrong for authorisation: clamping answers a request
nobody made, at a price the cashier never quoted. Exceeding *authority* with an
otherwise valid amount is `discount-not-authorized`. The two are told apart
because a cashier fixes them in different places.

## Decision 6 — Allocation reconciles exactly

A basket discount is allocated across lines with the same largest-remainder
routine money uses everywhere else, so the per-line shares sum to the discount
exactly. Applying a percentage to each line independently would not — the
halalas would not add up and the receipt would not reconcile.

The invariants, asserted in the domain and again by the database's own CHECK
constraints:

```
Σ line basket-discount shares = basket discount
gross − line discounts − basket discount = net
net + VAT = total
tendered − change = total
```

No line net goes below zero. No discount exceeds its eligible base.

## Decision 7 — Persist what explains the receipt

Every applied discount is written with its scope, its kind, the value that was
*requested*, the amount that was actually *granted*, the reason, the user who
granted it and when. A receipt has to be explainable years later from what was
written, not by replaying today's pricing rules against a catalogue that has
moved on.

`grantedByUserId` carries a composite tenant-consistent foreign key to `users`.
A discount attributed to a user in another tenant is not an audit trail, and a
plain reference to `users(id)` would permit exactly that (ADR-0004).

## Decision 8 — Payment is part of the intent

The idempotency fingerprint (ADR-0013) now covers the tender composition and
the discounts as well as the basket. The same basket settled as 50 cash + 50
Mada is a different commercial event from the same basket settled in cash: the
drawer differs, the reconciliation differs, and the customer's card statement
differs. Replaying one as the other would be wrong in a way nobody could
reconstruct afterwards.

The canonical form is a **structured value serialised as JSON**, not a string
joined with hand-picked delimiters. That distinction is load-bearing: an
approval reference is free text, and a reference containing `:` and `,` can
spell out a second tender record. `reference = "R,electronic:visa:100:X"` on one
tender produces the same joined string as two tenders referenced `"R"` and
`"X"` — two materially different sales, one fingerprint, and a replay that
returns the wrong one. SHA-256 cannot repair an ambiguous serialisation; it
faithfully hashes the collision. JSON gives the separators structure instead of
meaning. Records are sorted by their own serialisation before hashing, so key
order does not matter while content still does.

The fingerprint is versioned `v2`. A key minted under `v1` hashes differently
and is treated as a different intent — a visible conflict rather than an
invisible false replay, which is the safe direction.

Because both request shapes normalise before hashing, a legacy cash request
retried as its tender equivalent is a *replay*, not a conflict.

### Backed by the database

The two composition rules are also PostgreSQL invariants: a partial unique
index on `(tenantId, saleId) WHERE kind = 'cash'`, and another on
`(tenantId, saleId, scheme, reference) WHERE kind = 'electronic'`. Defence in
depth — the domain refuses both first, so an ordinary checkout never meets a
unique violation. What they stop is everything that is not an ordinary
checkout: a repair script, a migration, an integration written against the
tables.

## Consequences

- A merchant can take a split payment and give change correctly, or be told
  precisely why the payment was refused.
- A discount is bounded by the merchant's policy rather than by the interface,
  and the bound cannot be crossed by rounding.
- Everything needed to print an authoritative receipt for a discounted,
  split-tender sale is persisted. Printing itself is a later strike.
- No cardholder data enters the system, by construction rather than by
  convention.
- ZATCA Phase 2 is untouched and not claimed. The rows this strike writes —
  discount provenance, per-rate VAT buckets, tender composition — are the
  accounting facts that pipeline will need, which is why they are persisted
  rather than derived.
EOF

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

say "History and the browser are untouched?"
[ "$(cksum < "$MIG_2A")" = "$SUM_2A" ] || die "The Strike 2A migration was modified. That file is history."
[ "$(cksum < "$MIG_2B")" = "$SUM_2B" ] || die "The Strike 2B migration was modified. That file is history."
[ "$(cksum < docs/design/KORVI-DESIGN-SYSTEM.md)" = "$REF_DESIGN_SUM" ] || die "The design system changed."
[ "$(cksum < docs/decisions/ADR-0013-checkout-transaction-and-idempotency.md)" = "$REF_ADR13_SUM" ] || die "ADR-0013 changed."
[ "$(cksum < docs/decisions/ADR-0014-same-origin-browser-topology.md)" = "$REF_ADR14_SUM" ] || die "ADR-0014 changed."
NOW_POSWEB="$(find apps/pos-web/src -type f -name '*.ts*' -print0 | sort -z | xargs -0 cksum | cksum)"
[ "$NOW_POSWEB" = "$SUM_POSWEB" ] || die "apps/pos-web changed. The cashier interface is not part of this strike."
ok "migrations, ADR-0013/0014 and the whole browser app are byte-identical"

say "Exactly one new migration"
MIGRATION_COUNT="$(find packages/database/prisma/migrations -maxdepth 1 -type d -name '2026*' | wc -l | tr -d ' ')"
[ "$MIGRATION_COUNT" = "3" ] || die "Unexpected migration directory count: $MIGRATION_COUNT"
[ -f "$NEW_MIGRATION/migration.sql" ] || die "The new migration was not written."
ok "3 migrations; the new one is $(basename "$NEW_MIGRATION")"

say "No float, no secret, no card data on the financial path"
if grep -REq '(parseFloat|parseInt\(|\.toFixed\(|Math\.(round|floor|ceil))' \
     packages/domain/src/pricing packages/domain/src/tender packages/domain/src/sale \
     apps/api/src/checkout 2>/dev/null; then
  grep -REn '(parseFloat|parseInt\(|\.toFixed\(|Math\.(round|floor|ceil))' \
    packages/domain/src/pricing packages/domain/src/tender packages/domain/src/sale \
    apps/api/src/checkout >&2
  die "Float arithmetic reached the settlement path (ADR-0002)."
fi
if grep -REq '(BEGIN [A-Z ]*PRIVATE KEY|sk_live_|AKIA[0-9A-Z]{16})' apps/api/src packages/domain/src 2>/dev/null; then
  die "Something resembling a credential reached a source file."
fi
# Cardholder data must not be storable. Nothing in the persistence layer may
# so much as name it; in the domain the single exception is the guard that
# exists to refuse it, which necessarily says what it is refusing.
if grep -REn --include='*.ts' '\b(pan|cvv|cvc|track2|cardNumber)\b' packages/database/src 2>/dev/null; then
  die "Cardholder-data vocabulary reached the persistence layer."
fi
if grep -REn --include='*.ts' '\b(pan|cvv|cvc|track2|cardNumber)\b' packages/domain/src 2>/dev/null \
   | grep -v 'src/tender/tender.ts' | grep -v '__tests__'; then
  die "Cardholder-data vocabulary reached the domain outside the refusal guard."
fi
# And no schema column could ever hold it.
if grep -REiq '(pan|cvv|cvc|track2|cardnumber|expiry|pinblock)[[:space:]]+(String|Bytes|Int)' \
     packages/database/prisma/schema.prisma 2>/dev/null; then
  die "A schema column is shaped to hold cardholder data."
fi
ok "integer arithmetic only; no credential material; no card data below the API edge"

say "Formatting the new sources"
npx prettier --write --log-level warn \
  'packages/domain/src/**/*.ts' \
  'packages/database/src/**/*.ts' \
  'apps/api/src/**/*.ts' \
  'docs/decisions/ADR-0015-commercial-settlement.md'
# The Prisma schema is formatted by Prisma's own formatter, not by Prettier —
# the repository has no prettier-plugin-prisma and this strike does not add a
# dependency to get one.
npx prisma format --schema packages/database/prisma/schema.prisma >/dev/null
npx prettier --check --log-level warn \
  'packages/domain/src/**/*.ts' \
  'packages/database/src/**/*.ts' \
  'apps/api/src/**/*.ts' \
  'docs/decisions/ADR-0015-commercial-settlement.md' \
  || die "Sources are still unformatted after a write pass."

say "Dependency pins — asked of the registry now, not remembered"
# Time-dependent by design: the gate compares what this repository pins against
# what the registry publishes today. The decision is made here, at execution,
# and it is bounded to the current stable line of a package already in use.
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
    *-*) die "The registry's latest pg is $LATEST_PG, a prerelease. Refusing to pin it." ;;
    8.*)
      say "pg $PINNED_PG is behind $LATEST_PG; taking the current stable 8.x"
      npm install "pg@$LATEST_PG" --save-exact --workspace @korvi/database --package-lock-only
      ok "pg pinned at $LATEST_PG; the live PostgreSQL suites are the proof"
      ;;
    *)
      die "The registry's latest pg is $LATEST_PG — a new major line.
     A major driver upgrade is a decision with its own review and its own
     compatibility work, not something a settlement patch takes on its way
     past. Bump it deliberately, or record the pin in ALLOWED_BEHIND in
     scripts/verify-versions.mjs with the reason."
      ;;
  esac
fi

say "Installing from the lockfile"
npm ci

say "Running the full gate"
npm run --silent verify

cat << 'SUMMARY'

===============================================================================
  Korvi POS — Strike 3B-1a · commercial settlement core
===============================================================================

  TWO SHAPES, ONE ENGINE
    POST /v1/sales takes either cashReceivedMinor — what the production till
    sends today, unchanged — or a tenders array. Exactly one; both or neither
    is a 400. The legacy figure normalises into a one-line cash tender at the
    edge, and nothing downstream knows which shape it came from.

  TENDERS
    cash, and electronic with a closed scheme list and a bounded external
    reference. Korvi records that a payment was approved somewhere else; it
    contacts no bank, scheme, acquirer or wallet, and says so. PAN, CVV, track
    data, expiry, PIN and EMV data are refused by name at any nesting depth.

  SETTLEMENT
    Electronic may never exceed the amount due. Change comes from cash and is
    attributed to the cash tender row. One cash tender at most. No zero
    tender. No approval reference counted twice. Enforced in the domain, and
    again by CHECK constraints in the database.

  DISCOUNTS
    Line and basket, rate or fixed. Two gates: the persisted grant must carry
    sale.discount, and the amount must be inside maxDiscountBasisPoints —
    both from the session, never the request. Each scope is measured against
    the base it was taken from: a line against its own extended price, the
    basket against what the lines left, and everything together against the
    undiscounted cart. A fixed discount is converted with CEILING division.
    More off a line than the line is worth is invalid-discount, refused
    rather than clamped; over authority is a 403.

  THE DRAWER
    A sale's cash movement is cash tendered less change, never the total. A
    card settles part of a split sale and never touches the till; an
    electronic-only sale writes no cash movement at all. The response tells
    tenderedMinor, cashReceivedMinor and changeMinor apart, and carries the
    tender composition for the receipt.

  RECONCILIATION
    Basket discounts allocate by largest remainder, so the shares sum to the
    discount exactly. gross - discounts = net, net + VAT = total, tendered -
    change = total. Asserted in the domain and by the database.

  MIGRATION
    20260816120000_commercial_settlement — two columns and the constraints
    that make them mean something. No new table: tenders and sale_discounts
    already carry RLS and composite tenant-consistent foreign keys.

  Returns, refunds, drawer movements and shift close are Strike 3B-1b.
  Printing, real payment-provider integration and ZATCA Phase 2 are not here
  and are not faked.

  Nothing was committed, pushed, reset or cleaned.

===============================================================================
SUMMARY

ok "Done."
