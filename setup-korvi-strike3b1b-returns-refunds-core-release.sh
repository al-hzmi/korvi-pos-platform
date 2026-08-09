#!/usr/bin/env bash
#
# setup-korvi-strike3b1b-returns-refunds-core-release.sh — Korvi POS · Strike 3B-1b
#
# The returns and refunds transaction engine, on top of Strike 3B-2A
# (main @ 690ddee):
#
#   POST /v1/returns                     goods back, money back, one transaction
#   GET  /v1/sales/lookup                find the sale a customer is holding
#   GET  /v1/sales/:saleId/returnable    what is left, per line
#
# Every figure is prorated from the sale that was already written. Cumulative,
# so any sequence of partial returns sums to the original exactly. Serialised
# on the sale row, so the last unit cannot come back twice.
#
# No user interface. No shift close. No ZATCA Phase 2. Nothing faked.
#
# Run from the repository root. Never commits, pushes, resets, or cleans.

set -euo pipefail

if [ -t 1 ]; then
  C_B='\033[1;34m'; C_R='\033[1;31m'; C_G='\033[1;32m'; C_0='\033[0m'
else
  C_B=''; C_R=''; C_G=''; C_0=''
fi
say() { printf "${C_B}==>${C_0} %s\n" "$1"; }
ok()  { printf "${C_G}[ok]${C_0} %s\n" "$1"; }
die() { printf "${C_R}[x]${C_0} %s\n" "$1" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg. This artifact has no bypass modes." ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Not inside a git repository."
cd "$ROOT"

[ "$(node -p "require('./package.json').name" 2>/dev/null)" = "korvi-pos-platform" ] \
  || die "This is not korvi-pos-platform."

BASELINE=690ddee97d65d7af3e0faef00188cae2d10e4953
git cat-file -e "${BASELINE}^{commit}" 2>/dev/null || die "Commit $BASELINE is not in this repository."
git merge-base --is-ancestor "$BASELINE" HEAD 2>/dev/null || die "HEAD does not descend from $BASELINE."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" = "24" ] || die "Node 24 LTS required (ADR-0007). Found $(node --version)."

sha_of() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

expect_file() {
  # $1 path, $2 sha256 of the baseline content this patch was written against.
  [ -f "$1" ] || die "Baseline file missing: $1"
  local actual; actual="$(sha_of "$1")"
  [ "$actual" = "$2" ] || die "$1 is not the file this patch was written against.
     expected $2
     found    $actual
     Refusing to overwrite work this artifact did not see."
}

OWNED="
apps/api/src
packages/database/src
packages/database/prisma
packages/domain/src
docs/decisions
"
# shellcheck disable=SC2086
DIRTY="$(git status --porcelain -- $OWNED 2>/dev/null || true)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" | sed 's/^/     /' >&2
  die "Uncommitted changes under a path this patch owns. Commit or stash them first."
fi

say "Preflight — the closed strikes are where this one expects them"
grep -q "'sale.refund'" packages/domain/src/rbac/permissions.ts \
  || die "sale.refund missing from the RBAC vocabulary; this strike does not invent one."
grep -q 'ownBranchTerminal' apps/api/src/routes/business.ts \
  || die "Strike 3A-2 branch guard missing."
grep -q 'tenders_one_cash_per_sale' packages/database/prisma/migrations/*/migration.sql \
  || die "Strike 3B-1a settlement migration missing."
grep -q 'createSearchSession' apps/pos-web/src/hooks/use-product-search.ts \
  || die "Strike 3B-2A search session missing."
grep -q 'LOGOUT_UNCONFIRMED' apps/pos-web/src/lib/session.ts \
  || die "Strike 3B-2A secure-logout constant missing."

MIGRATION_COUNT_BEFORE="$(find packages/database/prisma/migrations -maxdepth 1 -type d -name '2026*' -o -maxdepth 1 -type d -name '0000*' | wc -l | tr -d ' ')"

say "Preflight — recording what must not move"
while read -r want path; do
  [ -f "$path" ] || die "A protected file is missing: $path"
  got="$(sha_of "$path")"
  [ "$got" = "$want" ] || die "$path already differs from the baseline. Refusing to proceed."
done << 'FROZEN_LIST'
92362aa8953a02bd0068c27d03c4b56df1a433b95d48517bd29dfd1b8f259597  packages/domain/src/sale/finalize.ts
63f537ad17ddeced7e2a1a4698985b9d7bb962cbd44d08b173935300fb3eea90  packages/domain/src/tender/tender.ts
d5c62f7da1f40ec9c7e3f2174b5deb093fa0b9c96b9c34829ce0b348c1af92c5  packages/domain/src/pricing/line.ts
9f6263bc839472da4ace5f5a53cb84c2cd43ed36fff1069203d2626c24eb4368  packages/domain/src/pricing/index.ts
33e553b0e64a9c08ed18598c19b2a5f749e34395624b9855f44f44e95915909a  packages/domain/src/pricing/discount-authority.ts
dad3f8734377f565d85ba19e371968955b92d180eda486b47d1e5525aa9e70a1  packages/database/prisma/migrations/00000000000000_rls_foundation/migration.sql
9ea2755e0e8075807a939076bf9b30ba3e3ceff0b31b4f40917ce5bcab6888e9  packages/database/prisma/migrations/20260808120000_saas_foundation/migration.sql
33eb58c48f7698658694a0929e7adfcf94e05d09b4c67aef7bce5a09e89b0901  packages/database/prisma/migrations/20260810120000_auth_security/migration.sql
6d34c21448472d8060a43087cbbe68d1bb726a952423a53593dff3e0e87720da  packages/database/prisma/migrations/20260816120000_commercial_settlement/migration.sql
FROZEN_LIST
ok "settlement core, tender and pricing modules, and every committed migration are at baseline"

say "Preflight — every file this patch rewrites is the one it was written against"
expect_file packages/domain/src/index.ts 2f29362bbda2c6a004167b0b6c988d78c34a212069c08ddbe24b446acf21e38b
expect_file packages/domain/src/ports/persistence.ts 439927ae470080b202e0f8dd50be420c521bcf0b8e7a4295e15eef957a938e56
expect_file packages/database/prisma/schema.prisma d7abcd605877a20948e0acbe8953523c65acdc00260f758497978d3746c1ba0b
expect_file packages/database/src/errors.ts 6ae4012f7c291afc9af4e080edc60bfd3227fab1f422d1a7cb1c1c1790874a65
expect_file packages/database/src/index.ts c8e05845d2c3c219afe53376be6da16195938ff4a913d7f298c7ab75a05dbb67
expect_file packages/database/src/repositories/sale-repository.ts 8aa631eee05d9a3d60348fcb786de5d74e77f39f6869082bbc3a01e32b29d5c8
expect_file packages/database/src/__tests__/repository-tenancy.test.ts 580ea5df9b9204e33f21951fc8528fefdecc6f2a56e140112e63061ec649999d
expect_file apps/api/src/server.ts 71fd27fad4a2a4ae4e9ec9f59a8c64bf3ed03c811b0a872fe1ac13d0e78f5c5c
expect_file apps/api/src/checkout/service.ts e3b69394b17dcd42e6328b890432afcd120bef079fddc792ddf758c89a9ec1b6
expect_file apps/api/src/routes/validation.ts 6bd63a420e6d64d32d9b1d98829a863de883b76a6ffad1c9641ae609ecd2ca9c
expect_file apps/api/src/routes/business.ts a6f111693e081c4039c8fb447fc328f1a47d624a4358f9a2a10db95ab611c940
expect_file apps/api/src/__tests__/support/memory-business.ts 48d5921f86660fe87705e3690f84d4b16a68d6653882c180f4f33e702613ea51
expect_file apps/api/src/__tests__/business-routes.test.ts 5152bfdea530f358d2b43fe5187ccd947f26855acdb73c9533bafbb9f2dfb20e
expect_file apps/api/src/__tests__/checkout-live.test.ts c451b203135c3ed97943baae70571347354d2cf9949eed0cc77a7bb5d19e44b7
expect_file apps/api/src/__tests__/settlement-live.test.ts aac7569c11386c74da991f094a55f09a60e4946a31c4cdfd8b83512b891ba116
ok "all 15 rewritten files match the baseline"

for created in \
  docs/decisions/ADR-0016-returns-and-refunds.md \
  packages/domain/src/returns/prorate.ts \
  packages/domain/src/returns/returns.ts \
  packages/domain/src/returns/index.ts \
  packages/domain/src/returns/__tests__/returns.test.ts \
  packages/database/prisma/migrations/20260822120000_returns_refunds/migration.sql \
  packages/database/src/repositories/return-repository.ts \
  apps/api/src/returns/fingerprint.ts \
  apps/api/src/returns/service.ts \
  apps/api/src/__tests__/returns-routes.test.ts \
  apps/api/src/__tests__/returns-live.test.ts
do
  [ -e "$created" ] && die "This strike creates $created, and it already exists."
done

mkdir -p packages/domain/src/returns/__tests__ \
         packages/database/prisma/migrations/20260822120000_returns_refunds \
         apps/api/src/returns docs/decisions
ok "Baseline verified · $BASELINE in ancestry · Node $(node --version)"

say "Domain — what a return is worth"
cat << 'KORVI_EOF' > packages/domain/src/returns/prorate.ts
import { DomainError } from '../errors.js';

/**
 * How a partial return keeps its arithmetic honest.
 *
 * The naive implementation prorates each return on its own: take the line's
 * net, multiply by the quantity coming back, divide by the quantity sold,
 * round. It is wrong, and it is wrong in the direction that costs a merchant
 * money without anybody noticing. A line of three items whose net is 1000
 * halalas prorates to 333 each; three separate returns of one item refund 999
 * and the merchant keeps a halala that belongs to the customer. Return the
 * same three on one document and the refund is 1000. The same goods, two
 * different answers, and no error message anywhere.
 *
 * So nothing is prorated per return. Each component is prorated against the
 * *cumulative* quantity returned so far, and what this return pays is the
 * difference between the new cumulative target and what has already been
 * refunded:
 *
 *   target(q) = floor(original * q / soldQuantity)
 *   thisReturn = target(newCumulative) - alreadyRefunded
 *
 * At full quantity the target is the original component exactly, so the sum of
 * every return against a line equals the line — for any sequence of partial
 * returns, in any order, of any sizes. The remainder lands on whichever return
 * crosses the boundary rather than being lost at each step.
 *
 * `alreadyRefunded` is read from the return rows that exist, not recomputed
 * from the formula. If an earlier return was written by an older version of
 * this code, or corrected by hand, the cumulative identity still closes: the
 * last return absorbs the difference.
 *
 * Integer arithmetic throughout. Every value here is a bigint of minor units
 * or of scaled quantity, and there is no point at which a ratio becomes a
 * number (ADR-0002).
 */

export class ProrationError extends DomainError {
  public override readonly name = 'ProrationError';
}

/**
 * The cumulative share of `original` owed once `returned` of `sold` has come
 * back.
 *
 * Floor rather than round, and floor is deliberate: it makes the sequence
 * monotone, which is what makes every individual delta non-negative. A
 * rounding rule that could step down would produce a return line asking the
 * customer for money back.
 */
export function cumulativeTarget(original: bigint, returned: bigint, sold: bigint): bigint {
  if (sold <= 0n) throw new ProrationError('A line that sold nothing cannot be returned.');
  if (returned < 0n) throw new ProrationError('A negative cumulative return is not a quantity.');
  if (returned > sold) throw new ProrationError('More has been returned than was ever sold.');
  if (original < 0n) throw new ProrationError('A negative original component cannot be prorated.');

  // BigInt division truncates toward zero; both operands are non-negative, so
  // that is floor.
  return (original * returned) / sold;
}

/**
 * The five components that are prorated, and the one that is derived.
 *
 * Gross, net, the two discounts and VAT are each prorated against the
 * cumulative quantity. `total` is then derived as `net + vat` rather than
 * prorated, because that is the identity Korvi actually enforces on a line —
 * in the database, in the domain, and on a receipt.
 *
 * `gross - discounts` is deliberately *not* asserted to equal net. Under
 * tax-inclusive pricing, which is what Saudi retail uses, the extended price
 * already contains the VAT: gross minus the discounts is the *total*, and the
 * net is extracted from it. Under tax-exclusive pricing the same subtraction
 * gives the net. One expression cannot be both, so the only identity carried
 * here is the one that holds in either mode.
 *
 * Deriving `total` also keeps every delta non-negative: each prorated
 * component is monotone in the cumulative quantity, so each delta is at least
 * zero, and total is the sum of two such deltas.
 */
export interface LineComponents {
  readonly netMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly basketDiscountMinor: bigint;
  readonly vatMinor: bigint;
  readonly grossMinor: bigint;
  readonly totalMinor: bigint;
}

export interface ProrationInput {
  /** What the original sale line says. Never today's catalogue. */
  readonly original: LineComponents;
  readonly soldQuantityScaled: bigint;
  /** Finalized returns against this line, before this one. */
  readonly returnedQuantityScaled: bigint;
  readonly refunded: Pick<
    LineComponents,
    'grossMinor' | 'netMinor' | 'lineDiscountMinor' | 'basketDiscountMinor' | 'vatMinor'
  >;
  /** What is coming back now. */
  readonly quantityScaled: bigint;
}

export function prorateLine(input: ProrationInput): LineComponents {
  const { original, soldQuantityScaled: sold, refunded } = input;
  const cumulative = input.returnedQuantityScaled + input.quantityScaled;

  const grossMinor = cumulativeTarget(original.grossMinor, cumulative, sold) - refunded.grossMinor;
  const netMinor = cumulativeTarget(original.netMinor, cumulative, sold) - refunded.netMinor;
  const lineDiscountMinor =
    cumulativeTarget(original.lineDiscountMinor, cumulative, sold) - refunded.lineDiscountMinor;
  const basketDiscountMinor =
    cumulativeTarget(original.basketDiscountMinor, cumulative, sold) - refunded.basketDiscountMinor;
  const vatMinor = cumulativeTarget(original.vatMinor, cumulative, sold) - refunded.vatMinor;

  if (
    grossMinor < 0n ||
    netMinor < 0n ||
    lineDiscountMinor < 0n ||
    basketDiscountMinor < 0n ||
    vatMinor < 0n
  ) {
    // Only reachable when the refunded totals already exceed the cumulative
    // target — a line that has been over-refunded by something other than this
    // code. Refusing is the only safe answer: the alternative is a return
    // document that takes money back off a customer.
    throw new ProrationError('This line has already been refunded beyond its cumulative share.');
  }

  return {
    grossMinor,
    netMinor,
    lineDiscountMinor,
    basketDiscountMinor,
    vatMinor,
    totalMinor: netMinor + vatMinor,
  };
}
KORVI_EOF
cat << 'KORVI_EOF' > packages/domain/src/returns/returns.ts
import { DomainError } from '../errors.js';
import {
  ELECTRONIC_SCHEMES,
  MAX_TENDER_REFERENCE_LENGTH,
  looksLikeCardNumber,
} from '../tender/tender.js';
import { QUANTITY_SCALE } from '../quantity/quantity.js';
import { prorateLine } from './prorate.js';
import type { BasisPoints } from '../tax/basis-points.js';
import type { ProductType } from '../ports/persistence.js';
import type { TenderScheme } from '../tender/tender.js';
import type { LineComponents } from './prorate.js';

/**
 * Returning goods, as a commercial document.
 *
 * A return is a new document that refers to a sale; it never edits one. The
 * original sale is the only authority for what anything cost — a price change,
 * a VAT change, a rename or a deactivated product must not alter what a
 * customer gets back for goods they bought last month, and the only way to
 * guarantee that is to read the snapshot the sale wrote and nothing else.
 *
 * Everything in this module is pure. It decides what a return is worth and
 * refuses the ones that are not lawful; it does not know what a database, an
 * HTTP request or a shift is. The quantities it is asked about are the ones
 * the caller proved inside a transaction — this module cannot prevent a race
 * and does not pretend to (ADR-0013).
 */

export class InvalidReturnQuantityError extends DomainError {
  public override readonly name = 'InvalidReturnQuantityError';
}

export class OverReturnError extends DomainError {
  public override readonly name = 'OverReturnError';
}

export class DuplicateReturnLineError extends DomainError {
  public override readonly name = 'DuplicateReturnLineError';
}

export class UnknownSaleLineError extends DomainError {
  public override readonly name = 'UnknownSaleLineError';
}

export class NothingReturnableError extends DomainError {
  public override readonly name = 'NothingReturnableError';
}

export class SaleNotReturnableError extends DomainError {
  public override readonly name = 'SaleNotReturnableError';
}

export class InvalidRefundError extends DomainError {
  public override readonly name = 'InvalidRefundError';
}

/**
 * What one sale line permits, as proved from persisted rows.
 *
 * `productType` is the snapshot taken when the sale was written, not the
 * catalogue's answer today. A product changed from unit to weighted next year
 * must not make last year's receipt fractional, and reading the live row would
 * do exactly that. It is nullable because sale lines written before Korvi
 * snapshotted it cannot be improved retroactively: where the fact is absent,
 * no rule is invented (see ADR-0016).
 */
export interface ReturnableLine {
  readonly saleLineId: string;
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType | null;
  readonly vatBasisPoints: BasisPoints;
  readonly soldQuantityScaled: bigint;
  readonly returnedQuantityScaled: bigint;
  readonly original: LineComponents;
  readonly refunded: Pick<
    LineComponents,
    'grossMinor' | 'netMinor' | 'lineDiscountMinor' | 'basketDiscountMinor' | 'vatMinor'
  >;
}

export function remainingQuantity(line: ReturnableLine): bigint {
  const remaining = line.soldQuantityScaled - line.returnedQuantityScaled;
  return remaining > 0n ? remaining : 0n;
}

export type RefundKind = 'cash' | 'electronic';

export type RefundIntent =
  | { readonly kind: 'cash' }
  | {
      readonly kind: 'electronic';
      readonly scheme: TenderScheme;
      /** Somebody else's approval. Never a card number — see ADR-0015. */
      readonly reference: string;
    };

/**
 * One refund per return document, and one method on it.
 *
 * Split refunds are not refused because they are hard; they are refused
 * because Korvi has no way to prove that two external approvals against one
 * return are not the same approval counted twice. When there is a mechanism
 * that can prove it, that is a strike of its own.
 */
export function assertRefundIntent(intent: RefundIntent): void {
  if (intent.kind === 'cash') return;

  if (!ELECTRONIC_SCHEMES.includes(intent.scheme)) {
    throw new InvalidRefundError('That is not a scheme Korvi records refunds against.');
  }
  const reference = intent.reference.trim();
  if (reference === '') {
    throw new InvalidRefundError(
      'An electronic refund records an approval that happened elsewhere; it needs its reference.',
    );
  }
  if (reference.length > MAX_TENDER_REFERENCE_LENGTH) {
    throw new InvalidRefundError('That refund reference is longer than a reference should be.');
  }
  // The API refuses cardholder data by name and by value before anything
  // reaches here. This is the domain saying the same thing, so a caller that
  // is not the API cannot put a PAN in a settlement row either.
  if (looksLikeCardNumber(reference)) {
    throw new InvalidRefundError(
      'That reference looks like a card number. Korvi will not store one.',
    );
  }
}

export interface RequestedReturnLine {
  readonly saleLineId: string;
  readonly quantityScaled: bigint;
}

export interface ReturnLineDraft {
  readonly saleLineId: string;
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType | null;
  readonly vatBasisPoints: BasisPoints;
  readonly quantityScaled: bigint;
  readonly components: LineComponents;
}

export interface ReturnDraft {
  readonly lines: readonly ReturnLineDraft[];
  readonly grossMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly basketDiscountMinor: bigint;
  readonly netMinor: bigint;
  readonly vatMinor: bigint;
  readonly totalMinor: bigint;
}

export interface PlanReturnInput {
  readonly available: readonly ReturnableLine[];
  readonly requested: readonly RequestedReturnLine[];
  readonly refund: RefundIntent;
}

/**
 * Turn a request into the document it would produce, or refuse it.
 *
 * The quantities in `available` must have been read inside the transaction
 * that will write the result. A preflight read is a courtesy to the user
 * interface; it is not authority, and two cashiers returning the last unit of
 * the same line will both have seen it available.
 */
export function planReturn(input: PlanReturnInput): ReturnDraft {
  assertRefundIntent(input.refund);

  if (input.requested.length === 0) {
    throw new InvalidReturnQuantityError('A return of no lines is not a return.');
  }

  const byId = new Map(input.available.map((line) => [line.saleLineId, line]));
  const seen = new Set<string>();
  const lines: ReturnLineDraft[] = [];

  for (const request of input.requested) {
    if (seen.has(request.saleLineId)) {
      // Two rows for one line would each pass a remaining-quantity check their
      // sum fails, which is the same defect the checkout refuses on the way in.
      throw new DuplicateReturnLineError('One line, one row. Sum the quantity in the client.');
    }
    seen.add(request.saleLineId);

    const line = byId.get(request.saleLineId);
    // Not found and belonging to another sale are the same answer on purpose:
    // the caller learns that this sale does not have that line, and nothing
    // about whether the line exists somewhere else.
    if (line === undefined) {
      throw new UnknownSaleLineError('That line is not part of this sale.');
    }

    if (request.quantityScaled <= 0n) {
      throw new InvalidReturnQuantityError('A return quantity must be positive.');
    }
    // Whole units only where the sale itself recorded that the line was sold
    // by the unit. If the immutable product-type snapshot is absent, today's
    // catalogue is not consulted and divisibility is not used as a heuristic.
    // The only safe operation is returning the entire remaining quantity: that
    // requires no interpretation of whether the historical line was unit or
    // weighted. Any partial return must wait for a line whose type is known.
    if (line.productType === 'unit' && request.quantityScaled % QUANTITY_SCALE !== 0n) {
      throw new InvalidReturnQuantityError('A unit product cannot be returned in fractions.');
    }

    const remaining = remainingQuantity(line);
    if (line.productType === null && request.quantityScaled !== remaining) {
      throw new InvalidReturnQuantityError(
        'This historical line has no immutable unit/weight snapshot; only its entire remaining quantity can be returned.',
      );
    }
    if (remaining === 0n) {
      throw new NothingReturnableError('Everything on that line has already been returned.');
    }
    if (request.quantityScaled > remaining) {
      throw new OverReturnError('That is more than the line has left to return.');
    }

    lines.push({
      saleLineId: line.saleLineId,
      lineNumber: line.lineNumber,
      productId: line.productId,
      sku: line.sku,
      nameAr: line.nameAr,
      nameEn: line.nameEn,
      productType: line.productType,
      vatBasisPoints: line.vatBasisPoints,
      quantityScaled: request.quantityScaled,
      components: prorateLine({
        original: line.original,
        soldQuantityScaled: line.soldQuantityScaled,
        returnedQuantityScaled: line.returnedQuantityScaled,
        refunded: line.refunded,
        quantityScaled: request.quantityScaled,
      }),
    });
  }

  const sum = (pick: (components: LineComponents) => bigint): bigint =>
    lines.reduce((total, line) => total + pick(line.components), 0n);

  const draft: ReturnDraft = {
    lines,
    grossMinor: sum((components) => components.grossMinor),
    lineDiscountMinor: sum((components) => components.lineDiscountMinor),
    basketDiscountMinor: sum((components) => components.basketDiscountMinor),
    netMinor: sum((components) => components.netMinor),
    vatMinor: sum((components) => components.vatMinor),
    totalMinor: sum((components) => components.totalMinor),
  };

  if (draft.totalMinor <= 0n) {
    // A return worth nothing is a refund of nothing. It would still consume a
    // return number and a drawer movement, and reconcile against nothing.
    throw new NothingReturnableError('That return is worth nothing to refund.');
  }
  assertReturnReconciles(draft);
  return draft;
}

/**
 * The identity every money document in Korvi satisfies, asserted before it can
 * be written.
 *
 * `net + VAT = total`, at the line and at the document. It is deliberately the
 * only one: `gross - discounts` equals the total under tax-inclusive pricing
 * and the net under tax-exclusive, so asserting either would be wrong for half
 * of Korvi's tenants.
 *
 * The database says the same thing in CHECK constraints, and finding out there
 * means finding out from a driver error at the end of a transaction that has
 * already moved stock.
 */
export function assertReturnReconciles(draft: ReturnDraft): void {
  for (const line of draft.lines) {
    const { netMinor, vatMinor, totalMinor } = line.components;
    if (netMinor + vatMinor !== totalMinor) {
      throw new ProrationMismatchError('A return line does not reconcile: net + VAT <> total.');
    }
  }
  if (draft.netMinor + draft.vatMinor !== draft.totalMinor) {
    throw new ProrationMismatchError('The return does not reconcile: net + VAT <> total.');
  }
}

export class ProrationMismatchError extends DomainError {
  public override readonly name = 'ProrationMismatchError';
}
KORVI_EOF
cat << 'KORVI_EOF' > packages/domain/src/returns/index.ts
export * from './prorate.js';
export * from './returns.js';
KORVI_EOF
cat << 'KORVI_EOF' > packages/domain/src/index.ts
export * from './errors.js';
export * from './money/index.js';
export * from './tax/index.js';
export * from './quantity/index.js';
export * from './pricing/index.js';
export * from './tender/tender.js';
export * from './sale/index.js';
export * from './returns/index.js';
export * from './rbac/index.js';
export * from './shift/index.js';
export * from './ids/uuidv7.js';
export * from './zatca/tlv.js';
export * from './zatca/base64.js';
export * from './ports/persistence.js';
export * from './ports/auth.js';
export * from './ports/search.js';
export * from './ports/offline.js';
KORVI_EOF
cat << 'KORVI_EOF' > packages/domain/src/ports/persistence.ts
import { DomainError } from '../errors.js';
import type { BasisPoints } from '../tax/basis-points.js';
// Reused, not redeclared. A second `PriceMode` that happened to agree today
// would be free to disagree tomorrow, and the two would sit on either side of
// the persistence boundary.
import type { PriceMode } from '../pricing/line.js';
import type { TenderKind, TenderScheme } from '../tender/tender.js';

/**
 * Repository ports.
 *
 * The domain declares what it needs; packages/database supplies it. Prisma
 * types never cross this line, which is what keeps the core liftable into
 * Korvi ERP later (ADR-0001) and stops ORM shapes reaching the UI (ADR-0004).
 *
 * Two conventions hold throughout this file:
 *
 *   Money and quantity cross as decimal *strings* of the underlying integer —
 *   `"1500"` halalas, `"1250"` thousandths of a kilo. A bigint cannot be
 *   JSON-serialised and a number silently loses halalas above 2^53. See
 *   ADR-0002.
 *
 *   Timestamps cross as ISO 8601 strings. A Date is mutable and carries a
 *   local-timezone rendering that survives no boundary intact.
 */

/** Branded so a bare string cannot be passed where a tenant is expected. */
export type TenantId = string & { readonly __brand: 'TenantId' };

export function tenantId(value: string): TenantId {
  return value as TenantId;
}

/**
 * Every tenant-owned read and write carries this.
 *
 * A `TenantScope` is a *claim that has already been verified*. Nothing in this
 * package can verify it — that is the authentication layer's job, and it does
 * not exist yet. What this type does is make the absence visible: a repository
 * method cannot be called without one, so no future caller can reach the
 * database having merely read a tenant id off a request body.
 *
 * The repositories go further and establish PostgreSQL RLS context from the
 * scope, so a forged or mistaken id yields an empty result set rather than
 * another merchant's rows. That is the actual boundary; this type is the
 * reminder of where it sits.
 *
 * GlobalCatalog is deliberately outside it: the national barcode catalogue is
 * shared infrastructure, not tenant data, and giving it a tenantId would mean
 * storing hundreds of thousands of duplicate rows per merchant (ADR-0004).
 */
export interface TenantScope {
  readonly tenantId: TenantId;
}

/**
 * A row surfaced under one tenant's scope carried another tenant's id.
 *
 * If this is ever thrown, RLS has been bypassed or a query was written without
 * a tenant filter. It is deliberately fatal: returning the row would be a
 * cross-tenant data leak, and returning null would hide a broken boundary.
 */
export class CrossTenantAccessError extends DomainError {
  public override readonly name = 'CrossTenantAccessError';
}

/** Belt and braces over RLS. Every adapter mapper calls this. */
export function assertSameTenant(scope: TenantScope, rowTenantId: string): void {
  if (rowTenantId !== (scope.tenantId as string)) {
    throw new CrossTenantAccessError(
      'A row from another tenant reached a tenant-scoped read. Refusing to return it.',
    );
  }
}

// ---------------------------------------------------------------------------
// Tenancy and configuration
// ---------------------------------------------------------------------------

export type TenantStatus = 'active' | 'suspended' | 'closed';

/** The minimum needed to identify a tenant before any scope exists. */
export interface TenantIdentity {
  readonly id: TenantId;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
}

export interface Tenant extends TenantIdentity {
  readonly vatNumber: string | null;
}

export type Vertical = 'retail' | 'grocery' | 'restaurant' | 'pharmacy';

export interface TenantSettings {
  readonly tenantId: TenantId;
  readonly vertical: Vertical;
  readonly priceMode: PriceMode;
  readonly defaultVatBasisPoints: BasisPoints;
  readonly currency: string;
  readonly requireBarcode: boolean;
  readonly allowWeightedItems: boolean;
  readonly trackInventory: boolean;
  readonly allowNegativeStock: boolean;
  readonly receiptHeaderAr: string | null;
  readonly receiptFooterAr: string | null;
}

export interface Branch {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
}

export interface Terminal {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly lastSeenAt: string | null;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export type ProductType = 'unit' | 'weighted';

export interface Product {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly categoryId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType;
  readonly unitLabel: string;
  /** Minor units, as a string at this boundary. See ADR-0002. */
  readonly priceMinor: string;
  /**
   * Branded and validated, not a bare number. The adapter narrows the integer
   * column through `basisPointsFromColumn`, so a corrupt row fails at the
   * boundary instead of producing a wrong tax figure downstream.
   */
  readonly vatBasisPoints: BasisPoints;
  /**
   * A product may carry several barcodes — a case, a single, a re-label. The
   * primary one is what a receipt prints; the rest still scan.
   */
  readonly primaryBarcode: string | null;
  readonly barcodes: readonly string[];
  readonly trackInventory: boolean;
  readonly isActive: boolean;
}

export interface GlobalCatalogItem {
  readonly barcode: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly vatBasisPoints: BasisPoints;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type InventoryMovementKind = 'sale' | 'return' | 'adjustment' | 'receipt' | 'transfer';

export interface InventoryBalance {
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly productId: string;
  /** Scaled by 1000, signed. A negative balance is an oversell. */
  readonly quantityScaled: string;
}

export interface InventoryMovementInput {
  readonly id: string;
  readonly branchId: string;
  readonly productId: string;
  readonly kind: InventoryMovementKind;
  /** Signed and scaled by 1000: a sale is negative, a receipt positive. */
  readonly quantityScaled: string;
  readonly reason: string | null;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly actorUserId: string | null;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface Customer {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
  readonly isActive: boolean;
}

export interface CreateCustomerInput {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export type ShiftStatusRecord = 'open' | 'closed';

export type CashMovementKindRecord = 'sale' | 'refund' | 'pay-in' | 'pay-out' | 'opening-float';

export interface CashMovementRecord {
  readonly id: string;
  readonly shiftId: string;
  readonly kind: CashMovementKindRecord;
  /** Signed halalas: a pay-out and a refund are negative. */
  readonly amountMinor: string;
  readonly reason: string | null;
  readonly actorUserId: string | null;
  readonly occurredAt: string;
}

export interface ShiftRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly status: ShiftStatusRecord;
  readonly openingFloatMinor: string;
  readonly declaredCashMinor: string | null;
  readonly expectedCashMinor: string | null;
  readonly varianceMinor: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly movements: readonly CashMovementRecord[];
}

export interface OpenShiftInput {
  readonly id: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly openingFloatMinor: string;
  readonly openedAt: string;
  /** The opening-float movement, so the drawer's history starts at zero gaps. */
  readonly openingMovementId: string;
}

export interface CloseShiftInput {
  readonly shiftId: string;
  readonly declaredCashMinor: string;
  readonly expectedCashMinor: string;
  readonly varianceMinor: string;
  readonly closedAt: string;
}

// ---------------------------------------------------------------------------
// Sales and invoices
// ---------------------------------------------------------------------------

export type SaleStatus = 'finalized' | 'voided';

/**
 * A sale line as stored.
 *
 * Every descriptive and financial field is a snapshot. Nothing here is read
 * back from `products`: a price change tomorrow must not alter what yesterday's
 * invoice says, and a deleted product must not make an old receipt
 * unprintable.
 */
export interface SaleLineRecord {
  readonly id: string;
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  /**
   * Whether this line was sold by the unit or by weight, as it stood at the
   * moment of sale.
   *
   * Snapshotted rather than read back from `products` for the same reason the
   * price is: a product reclassified next year must not make last year's
   * receipt fractional, and a return engine that consulted the live catalogue
   * would let a catalogue edit change what a historical sale means.
   *
   * Null on lines written before Korvi recorded it, and on lines whose product
   * had already been deleted when the backfill ran. Null means "no immutable
   * fact proves the type" — never "unit". See ADR-0016.
   */
  readonly productType: ProductType | null;
  readonly unitPriceMinor: string;
  readonly vatBasisPoints: BasisPoints;
  readonly quantityScaled: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface SaleDiscountRecord {
  readonly id: string;
  readonly scope: 'line' | 'basket';
  readonly lineNumber: number | null;
  readonly kind: 'fixed' | 'percentage';
  readonly inputValue: string;
  readonly amountMinor: string;
  readonly reason: string | null;
  readonly grantedByUserId: string | null;
}

export interface TenderRecord {
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
}

export interface SaleRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly userId: string;
  readonly customerId: string | null;
  readonly operationId: string;
  readonly status: SaleStatus;
  readonly sequence: number;
  readonly priceMode: PriceMode;
  readonly currency: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly tenderedMinor: string;
  readonly changeMinor: string;
  readonly issuedAt: string;
  readonly lines: readonly SaleLineRecord[];
  readonly discounts: readonly SaleDiscountRecord[];
  readonly tenders: readonly TenderRecord[];
}

export type InvoiceType = 'simplified' | 'standard';

export interface InvoiceTaxBucketRecord {
  readonly vatBasisPoints: BasisPoints;
  readonly netMinor: string;
  readonly vatMinor: string;
}

export interface InvoiceRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly saleId: string;
  readonly invoiceNumber: string;
  readonly invoiceType: InvoiceType;
  readonly sellerName: string;
  readonly sellerVatNumber: string;
  readonly buyerName: string | null;
  readonly buyerVatNumber: string | null;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly currency: string;
  readonly issuedAt: string;
  readonly taxBreakdown: readonly InvoiceTaxBucketRecord[];
}

/**
 * Everything one checkout writes, in one value.
 *
 * The sale, its invoice, the stock it consumed, the cash it put in the drawer
 * and the idempotency reservation are a single fact about the world. Writing
 * them in separate calls would allow a crash to leave an invoice with no sale,
 * or stock decremented for a sale that never existed — so the port takes them
 * together and the adapter commits them in one transaction.
 */
export interface RecordSaleInput {
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
  readonly invoice: Omit<InvoiceRecord, 'tenantId' | 'invoiceNumber'>;
  readonly inventory: readonly InventoryMovementInput[];
  readonly cashMovement: CashMovementRecord | null;
  readonly idempotency: IdempotencyReservation;
}

// ---------------------------------------------------------------------------
// Idempotency and audit
// ---------------------------------------------------------------------------

export type IdempotencyStatus = 'reserved' | 'completed' | 'failed';

export interface IdempotencyReservation {
  readonly id: string;
  readonly scope: string;
  readonly operationId: string;
  /** Fingerprint of the request, so a replay with different content is seen. */
  readonly requestHash: string | null;
}

export interface IdempotencyRecord extends IdempotencyReservation {
  readonly tenantId: TenantId;
  readonly status: IdempotencyStatus;
  readonly resultType: string | null;
  readonly resultId: string | null;
  readonly completedAt: string | null;
}

export interface AuditEventInput {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly branchId: string | null;
  readonly terminalId: string | null;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string | null;
  /**
   * Structured context. Never a credential, token or password: audit rows are
   * the most widely read table in any support incident.
   */
  readonly metadata: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface TenantRepository {
  /** The tenant this scope names. Structurally incapable of returning another. */
  current(scope: TenantScope): Promise<Tenant | null>;
  settings(scope: TenantScope): Promise<TenantSettings | null>;
}

/*
 * There is deliberately no unscoped tenant lookup of any kind — no resolution
 * by hostname, by subdomain, or by any other public handle.
 *
 * Resolving a hostname to a tenant has to happen before a scope exists, which
 * makes it the one read that cannot be tenant-scoped — and `tenants` is under
 * RLS, so it cannot be served from this layer at all without a policy or a
 * role that weakens the boundary. That decision belongs with authentication,
 * which this strike does not build. Provisioning the first tenant is the same
 * shape of problem and has the same answer: it runs as the migration role, not
 * through a repository.
 *
 * Leaving the gap visible is the point. An unscoped `findBySlug` added here
 * "temporarily" would be the one method every later caller reaches for.
 */

/**
 * What an owner sees when they open Korvi.
 *
 * A read model, not a report engine: every figure is one a merchant can check
 * against the tills in front of them, and every one is derived from rows that
 * already exist. Nothing here is estimated, projected or smoothed.
 *
 * "Last 24 hours" rather than "today" on purpose. A calendar day needs a
 * tenant timezone, and Korvi does not persist one yet; inventing an answer
 * would put a wrong number on the first screen an owner ever sees. A rolling
 * window is exactly defined without one.
 *
 * Money crosses as decimal strings of halalas, like everywhere else (ADR-0002).
 */
export interface DashboardSummary {
  readonly activeProductCount: number;
  readonly terminalCount: number;
  readonly openShiftCount: number;
  readonly salesLast24HoursCount: number;
  readonly grossSalesLast24HoursMinor: string;
  readonly vatLast24HoursMinor: string;
  readonly currency: string;
  /** The start of the window, so the screen can say what it is showing. */
  readonly since: string;
}

export interface DashboardRepository {
  /** Tenant-scoped by construction; there is no parameter that could widen it. */
  summary(scope: TenantScope, since: string): Promise<DashboardSummary>;
}

export interface BranchRepository {
  findById(scope: TenantScope, id: string): Promise<Branch | null>;
  list(scope: TenantScope): Promise<readonly Branch[]>;
}

export interface TerminalRepository {
  findById(scope: TenantScope, id: string): Promise<Terminal | null>;
  findByCode(scope: TenantScope, code: string): Promise<Terminal | null>;
  listForBranch(scope: TenantScope, branchId: string): Promise<readonly Terminal[]>;
  markSeen(scope: TenantScope, id: string, at: string): Promise<void>;
}

/**
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
  search(scope: TenantScope, query: ProductSearchQuery): Promise<readonly Product[]>;
  findBySku(scope: TenantScope, sku: string): Promise<Product | null>;
  findByBarcode(scope: TenantScope, barcode: string): Promise<Product | null>;
  list(scope: TenantScope, limit: number): Promise<readonly Product[]>;
}

export interface InventoryRepository {
  balance(
    scope: TenantScope,
    branchId: string,
    productId: string,
  ): Promise<InventoryBalance | null>;
  listBalances(
    scope: TenantScope,
    branchId: string,
    limit: number,
  ): Promise<readonly InventoryBalance[]>;
  /** Records the movement and moves the balance in one transaction. */
  applyMovement(scope: TenantScope, movement: InventoryMovementInput): Promise<InventoryBalance>;
}

export interface CustomerRepository {
  findById(scope: TenantScope, id: string): Promise<Customer | null>;
  findByPhone(scope: TenantScope, phone: string): Promise<Customer | null>;
  list(scope: TenantScope, limit: number): Promise<readonly Customer[]>;
  create(scope: TenantScope, input: CreateCustomerInput): Promise<Customer>;
}

export interface ShiftRepository {
  findById(scope: TenantScope, id: string): Promise<ShiftRecord | null>;
  findOpenForTerminal(scope: TenantScope, terminalId: string): Promise<ShiftRecord | null>;
  open(scope: TenantScope, input: OpenShiftInput): Promise<ShiftRecord>;
  recordCashMovement(scope: TenantScope, movement: CashMovementRecord): Promise<void>;
  close(scope: TenantScope, input: CloseShiftInput): Promise<ShiftRecord>;
}

export interface SaleRepository {
  findById(scope: TenantScope, id: string): Promise<SaleRecord | null>;
  /** The idempotent read: a retry finds the sale its first attempt created. */
  findByOperationId(scope: TenantScope, operationId: string): Promise<SaleRecord | null>;
  invoiceForSale(scope: TenantScope, saleId: string): Promise<InvoiceRecord | null>;
  /** Sale, lines, tenders, invoice, stock and cash — one transaction. */
  record(scope: TenantScope, input: RecordSaleInput): Promise<SaleRecord>;
}

// ---------------------------------------------------------------------------
// Returns and refunds
// ---------------------------------------------------------------------------

export type ReturnStatus = 'finalized' | 'voided';

/**
 * How the money went back.
 *
 * `cash` leaves the drawer and is recorded as a negative movement against the
 * shift. `electronic` records that a refund was approved somewhere else — a
 * Mada terminal, an acquirer, a wallet — and carries that system's reference.
 * Korvi contacts no scheme and no bank, in this strike or in the settlement
 * one before it (ADR-0015, ADR-0016).
 */
export type RefundKindRecord = 'cash' | 'electronic' | 'card' | 'mada' | 'transfer';

export interface RefundRecord {
  readonly id: string;
  readonly kind: RefundKindRecord;
  readonly scheme: TenderScheme | null;
  readonly amountMinor: string;
  readonly reference: string | null;
  readonly issuedAt: string;
}

export interface ReturnLineRecord {
  readonly id: string;
  readonly lineNumber: number;
  readonly saleLineId: string;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType | null;
  readonly vatBasisPoints: BasisPoints;
  readonly quantityScaled: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface ReturnRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly saleId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly actorUserId: string;
  readonly operationId: string;
  readonly status: ReturnStatus;
  readonly sequence: number;
  readonly returnNumber: string;
  readonly reason: string | null;
  readonly currency: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly issuedAt: string;
  readonly lines: readonly ReturnLineRecord[];
  readonly refund: RefundRecord | null;
}

/**
 * What is left to return on a sale, as the database currently sees it.
 *
 * Every figure comes from persisted rows: the sale's own snapshot and the sum
 * of the finalized returns against it. Nothing is derived from the catalogue,
 * and nothing here is authority for a write — a second cashier can return the
 * last unit between this read and the transaction that acts on it, which is
 * why the same numbers are read again under lock (ADR-0016).
 */
export interface ReturnableSaleLine {
  readonly saleLineId: string;
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType | null;
  readonly vatBasisPoints: BasisPoints;
  readonly unitPriceMinor: string;
  readonly soldQuantityScaled: string;
  readonly returnedQuantityScaled: string;
  readonly remainingQuantityScaled: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly refundedGrossMinor: string;
  readonly refundedNetMinor: string;
  readonly refundedLineDiscountMinor: string;
  readonly refundedBasketDiscountMinor: string;
  readonly refundedVatMinor: string;
}

export interface ReturnableSale {
  readonly saleId: string;
  readonly branchId: string;
  readonly status: SaleStatus;
  readonly invoiceNumber: string | null;
  readonly currency: string;
  readonly issuedAt: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly refundedTotalMinor: string;
  readonly lines: readonly ReturnableSaleLine[];
}

/** One row of the till's "find the sale" list. Nothing a receipt would not show. */
export interface SaleLookupRow {
  readonly saleId: string;
  readonly invoiceNumber: string | null;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly currency: string;
  readonly totalMinor: string;
  readonly refundedTotalMinor: string;
  readonly fullyReturned: boolean;
}

export interface SaleLookupQuery {
  /** From the session, never from the client. */
  readonly branchId: string;
  readonly term: string;
  readonly limit: number;
}

/**
 * The plan a return would produce, computed from rows read under lock.
 *
 * The repository does not price anything: it loads the authoritative state
 * inside the transaction, hands it to this function, and writes what comes
 * back. Pricing stays in the domain and authority stays in the transaction,
 * which is the only arrangement where both are true at once.
 */
export interface RecordReturnPlan {
  readonly lines: readonly {
    readonly saleLineId: string;
    readonly lineNumber: number;
    readonly productId: string | null;
    readonly sku: string;
    readonly nameAr: string;
    readonly nameEn: string | null;
    readonly productType: ProductType | null;
    readonly vatBasisPoints: BasisPoints;
    readonly quantityScaled: string;
    readonly grossMinor: string;
    readonly lineDiscountMinor: string;
    readonly basketDiscountMinor: string;
    readonly netMinor: string;
    readonly vatMinor: string;
    readonly totalMinor: string;
  }[];
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface RecordReturnInput {
  readonly returnId: string;
  readonly saleId: string;
  readonly operationId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly actorUserId: string;
  readonly reason: string | null;
  readonly currency: string;
  readonly issuedAt: string;
  /** What the client asked to send back. Quantities only. */
  readonly requested: readonly { readonly saleLineId: string; readonly quantityScaled: string }[];
  readonly refund: {
    readonly id: string;
    readonly kind: 'cash' | 'electronic';
    readonly scheme: TenderScheme | null;
    readonly reference: string | null;
  };
  /** Ids minted by the caller, so a replay cannot mint a second set. */
  readonly lineIds: readonly string[];
  readonly inventoryIds: readonly string[];
  readonly cashMovementId: string;
  readonly idempotency: IdempotencyReservation;
  /**
   * Pure, and called inside the transaction with rows read under lock. It
   * throws the domain's own refusals, which roll the transaction back.
   */
  readonly plan: (state: ReturnableSale) => RecordReturnPlan;
}

export interface ReturnRepository {
  findById(scope: TenantScope, id: string): Promise<ReturnRecord | null>;
  /** The idempotent read: a retry finds the return its first attempt created. */
  findByOperationId(scope: TenantScope, operationId: string): Promise<ReturnRecord | null>;
  /** What is left to return, or null if this branch has no such sale. */
  returnableForSale(
    scope: TenantScope,
    branchId: string,
    saleId: string,
  ): Promise<ReturnableSale | null>;
  lookupSales(scope: TenantScope, query: SaleLookupQuery): Promise<readonly SaleLookupRow[]>;
  /** Return, lines, refund, stock and drawer — one transaction. */
  record(scope: TenantScope, input: RecordReturnInput): Promise<ReturnRecord>;
}

export interface IdempotencyRepository {
  find(
    scope: TenantScope,
    scopeKey: string,
    operationId: string,
  ): Promise<IdempotencyRecord | null>;
  reserve(scope: TenantScope, reservation: IdempotencyReservation): Promise<IdempotencyRecord>;
  complete(
    scope: TenantScope,
    scopeKey: string,
    operationId: string,
    result: { readonly resultType: string; readonly resultId: string; readonly at: string },
  ): Promise<void>;
}

export interface AuditRepository {
  append(scope: TenantScope, event: AuditEventInput): Promise<void>;
  list(scope: TenantScope, limit: number): Promise<readonly AuditEventInput[]>;
}

export interface GlobalCatalogRepository {
  findByBarcode(barcode: string): Promise<GlobalCatalogItem | null>;
}
KORVI_EOF
ok "domain — what a return is worth written"

say "Database — the schema a return document needs"
cat << 'KORVI_EOF' > packages/database/prisma/schema.prisma
// Korvi POS — SaaS data model.
//
// Rules that hold across every model here:
//
//   Tenancy   Every tenant-owned model carries tenantId, indexes it first in
//             every composite index, and is protected by RLS (ADR-0004). The
//             two exceptions are named and justified at the bottom of the file.
//
//   Money     BIGINT halalas. Never Float, never Decimal (ADR-0002).
//
//   Quantity  BIGINT scaled by 1000. A grocery scale reads 0.125 kg, and a
//             float weight multiplied by a price in halalas drifts exactly as
//             a float price does.
//
//   Rates     INTEGER basis points, 0..10000, constrained in the migration.
//
//   History   Finalized sales and invoices snapshot the description, price and
//             tax rate that applied at the moment of sale. Editing a product
//             tomorrow must not rewrite what yesterday's invoice says.
//
//   Ids       UUID columns, populated with UUIDv7 by the application so rows
//             sort in creation order (ADR-0003). No database default: an id
//             minted by the terminal offline must survive replay unchanged.

generator client {
  provider = "prisma-client"
  output   = "../generated/client"
}

datasource db {
  provider = "postgresql"
}

// ---------------------------------------------------------------------------
// Tenancy, identity and configuration
// ---------------------------------------------------------------------------

model Tenant {
  id        String   @id @db.Uuid
  name      String
  slug      String   @unique
  vatNumber String?  @db.VarChar(15)
  status    String   @default("active")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Every tenant-owned model points back here, which is exactly the point:
  // if a new model has no line in this list, it has no tenant, and the RLS
  // test will refuse it.
  branches           Branch[]
  users              User[]
  memberships        TenantMembership[]
  roles              Role[]
  rolePermissions    RolePermission[]
  userRoles          UserRole[]
  terminals          Terminal[]
  settings           TenantSettings?
  categories         Category[]
  products           Product[]
  productBarcodes    ProductBarcode[]
  productPrices      ProductPrice[]
  inventoryBalances  InventoryBalance[]
  inventoryMovements InventoryMovement[]
  customers          Customer[]
  shifts             Shift[]
  cashMovements      CashMovement[]
  sales              Sale[]
  saleLines          SaleLine[]
  saleDiscounts      SaleDiscount[]
  tenders            Tender[]
  invoices           Invoice[]
  taxBreakdown       InvoiceTaxBreakdown[]
  returns            Return[]
  returnLines        ReturnLine[]
  refunds            Refund[]
  idempotencyKeys    IdempotencyKey[]
  auditEvents        AuditEvent[]
  sessions           Session[]

  @@map("tenants")
}

model Branch {
  id        String   @id @db.Uuid
  tenantId  String   @db.Uuid
  code      String
  nameAr    String
  nameEn    String?
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant             Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  terminals          Terminal[]
  inventoryBalances  InventoryBalance[]
  inventoryMovements InventoryMovement[]
  shifts             Shift[]
  sales              Sale[]
  returns            Return[]
  memberships        TenantMembership[]

  @@unique([tenantId, code])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, isActive])
  @@map("branches")
}

model User {
  id           String  @id @db.Uuid
  tenantId     String  @db.Uuid
  email        String
  displayName  String
  /// Hash only. A plaintext or reversible credential must never reach a column.
  /// The encoding carries its own KDF parameters, so the cost can be raised
  /// later without invalidating hashes written under the old ones (ADR-0012).
  passwordHash String?
  isActive     Boolean @default(true)

  /// Consecutive failed attempts since the last success. Reset on success.
  failedLoginCount Int       @default(0)
  /// Set when the count crosses the threshold. A null value is not a lock.
  lockedUntil      DateTime?
  /// Bumped to invalidate every existing session for this user at once — a
  /// password change or a suspected compromise, without a session sweep.
  /// A session carries the version it was minted under and stops matching.
  authVersion      Int       @default(1)
  lastLoginAt      DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant        Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  memberships   TenantMembership[]
  roles         UserRole[]
  sessions      Session[]
  shifts        Shift[]
  sales         Sale[]
  auditEvents   AuditEvent[]
  saleDiscounts SaleDiscount[]
  returns       Return[]

  @@unique([tenantId, email])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, isActive])
  @@map("users")
}

/// The user's standing within a tenant, and the branch they default to.
model TenantMembership {
  id              String   @id @db.Uuid
  tenantId        String   @db.Uuid
  userId          String   @db.Uuid
  defaultBranchId String?  @db.Uuid
  status          String   @default("active")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  tenant        Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user          User    @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: Cascade)
  defaultBranch Branch? @relation(fields: [tenantId, defaultBranchId], references: [tenantId, id], onDelete: NoAction)

  @@unique([tenantId, userId])
  @@index([tenantId, status])
  @@map("tenant_memberships")
}

/// Roles are per tenant so a merchant can define their own beyond the defaults.
model Role {
  id                     String   @id @db.Uuid
  tenantId               String   @db.Uuid
  key                    String
  nameAr                 String
  nameEn                 String?
  /// Ceiling this role may discount, in basis points of the undiscounted cart.
  maxDiscountBasisPoints Int      @default(0)
  isSystem               Boolean  @default(false)
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  tenant      Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  permissions RolePermission[]
  users       UserRole[]

  @@unique([tenantId, key])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("roles")
}

model RolePermission {
  id            String @id @db.Uuid
  tenantId      String @db.Uuid
  roleId        String @db.Uuid
  permissionKey String

  tenant     Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  role       Role       @relation(fields: [tenantId, roleId], references: [tenantId, id], onDelete: Cascade)
  permission Permission @relation(fields: [permissionKey], references: [key], onDelete: Restrict)

  @@unique([tenantId, roleId, permissionKey])
  @@index([tenantId, roleId])
  @@map("role_permissions")
}

model UserRole {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  userId   String @db.Uuid
  roleId   String @db.Uuid

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: Cascade)
  role   Role   @relation(fields: [tenantId, roleId], references: [tenantId, id], onDelete: Cascade)

  @@unique([tenantId, userId, roleId])
  @@index([tenantId, userId])
  @@map("user_roles")
}

model Terminal {
  id         String    @id @db.Uuid
  tenantId   String    @db.Uuid
  branchId   String    @db.Uuid
  code       String
  label      String
  /// Stable browser/device fingerprint, so a till can be recognised on return.
  deviceKey  String?
  isActive   Boolean   @default(true)
  lastSeenAt DateTime?
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  tenant  Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  branch  Branch   @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: Cascade)
  shifts  Shift[]
  sales   Sale[]
  returns Return[]

  @@unique([tenantId, code])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, branchId, isActive])
  @@map("terminals")
}

/// Vertical behaviour per tenant. One merchant's grocery settings must never
/// become another merchant's restaurant defaults.
model TenantSettings {
  tenantId String @id @db.Uuid

  vertical              String @default("retail")
  priceMode             String @default("tax-inclusive")
  defaultVatBasisPoints Int    @default(1500)
  currency              String @default("SAR")

  enableProductImages Boolean @default(false)
  requireBarcode      Boolean @default(true)
  allowWeightedItems  Boolean @default(false)
  trackInventory      Boolean @default(true)
  allowNegativeStock  Boolean @default(false)

  receiptHeaderAr String?
  receiptFooterAr String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("tenant_settings")
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

model Category {
  id        String   @id @db.Uuid
  tenantId  String   @db.Uuid
  nameAr    String
  nameEn    String?
  sortOrder Int      @default(0)
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant   Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  products Product[]

  @@unique([tenantId, nameAr])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, isActive, sortOrder])
  @@map("categories")
}

model Product {
  id         String  @id @db.Uuid
  tenantId   String  @db.Uuid
  categoryId String? @db.Uuid

  sku    String
  nameAr String
  nameEn String?

  /// 'unit' sells whole items; 'weighted' sells by scale reading.
  productType String @default("unit")
  unitLabel   String @default("each")

  /// Halalas per unit, in the tenant's price mode. Never Float.
  priceMinor     BigInt
  vatBasisPoints Int    @default(1500)

  /// The Phase 0 single-barcode column. Superseded by ProductBarcode, kept
  /// because dropping it would destroy data that has not been migrated yet.
  /// Nothing reads it: the repository resolves barcodes through the child
  /// table. It goes when a migration has moved every row.
  barcode String?

  /// Reversed primary barcode, so a suffix query becomes a prefix query.
  codeReverse String?
  imageUrl    String?

  trackInventory Boolean @default(true)
  isActive       Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant             Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  category           Category?           @relation(fields: [tenantId, categoryId], references: [tenantId, id], onDelete: NoAction)
  barcodes           ProductBarcode[]
  prices             ProductPrice[]
  inventoryBalances  InventoryBalance[]
  inventoryMovements InventoryMovement[]
  saleLines          SaleLine[]
  returnLines        ReturnLine[]

  @@unique([tenantId, sku])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, isActive])
  @@index([tenantId, barcode])
  @@index([tenantId, categoryId])
  @@index([tenantId, codeReverse])
  @@index([tenantId, nameAr])
  @@map("products")
}

model ProductBarcode {
  id        String   @id @db.Uuid
  tenantId  String   @db.Uuid
  productId String   @db.Uuid
  barcode   String
  isPrimary Boolean  @default(false)
  createdAt DateTime @default(now())

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: Cascade)

  /// Unique within a tenant, not globally: two merchants may legitimately
  /// carry the same EAN, and a global constraint would make the second one
  /// fail to onboard.
  @@unique([tenantId, barcode])
  @@index([tenantId, productId])
  @@map("product_barcodes")
}

/// Price history. A finalized sale never reads this table -- it snapshots the
/// figure it charged -- but a price change must leave a trail.
model ProductPrice {
  id             String    @id @db.Uuid
  tenantId       String    @db.Uuid
  productId      String    @db.Uuid
  priceMinor     BigInt
  vatBasisPoints Int
  effectiveFrom  DateTime
  effectiveTo    DateTime?
  createdAt      DateTime  @default(now())

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: Cascade)

  @@index([tenantId, productId, effectiveFrom])
  @@map("product_prices")
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/// The natural key is the primary key. A surrogate id would let a second
/// balance row for the same product exist without violating anything, and two
/// disagreeing stock figures is worse than none.
model InventoryBalance {
  tenantId       String   @db.Uuid
  branchId       String   @db.Uuid
  productId      String   @db.Uuid
  /// Scaled by 1000, signed: a negative balance is oversell, which the tenant
  /// may or may not permit.
  quantityScaled BigInt   @default(0)
  updatedAt      DateTime @updatedAt

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  branch  Branch  @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: Cascade)
  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: Cascade)

  @@id([tenantId, branchId, productId])
  @@index([tenantId, branchId])
  @@map("inventory_balances")
}

model InventoryMovement {
  id        String @id @db.Uuid
  tenantId  String @db.Uuid
  branchId  String @db.Uuid
  productId String @db.Uuid

  /// 'sale' | 'return' | 'adjustment' | 'receipt' | 'transfer'
  kind           String
  quantityScaled BigInt
  reason         String?

  /// The sale or return that caused it, when there was one.
  sourceType String?
  sourceId   String? @db.Uuid

  actorUserId String?  @db.Uuid
  occurredAt  DateTime
  createdAt   DateTime @default(now())

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  branch  Branch  @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: Cascade)
  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: NoAction)

  @@index([tenantId, branchId, productId, occurredAt])
  @@index([tenantId, sourceType, sourceId])
  @@map("inventory_movements")
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

model Customer {
  id        String   @id @db.Uuid
  tenantId  String   @db.Uuid
  nameAr    String
  nameEn    String?
  phone     String?
  email     String?
  vatNumber String?  @db.VarChar(15)
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sales  Sale[]

  @@unique([tenantId, phone])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, isActive])
  @@index([tenantId, nameAr])
  @@map("customers")
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

model Shift {
  id         String @id @db.Uuid
  tenantId   String @db.Uuid
  branchId   String @db.Uuid
  terminalId String @db.Uuid
  userId     String @db.Uuid

  status            String  @default("open")
  openingFloatMinor BigInt
  declaredCashMinor BigInt?
  expectedCashMinor BigInt?
  varianceMinor     BigInt?

  openedAt DateTime
  closedAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant        Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  branch        Branch         @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: Cascade)
  terminal      Terminal       @relation(fields: [tenantId, terminalId], references: [tenantId, id], onDelete: NoAction)
  user          User           @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: NoAction)
  cashMovements CashMovement[]
  sales         Sale[]
  returns       Return[]

  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, branchId, status])
  @@index([tenantId, terminalId, status])
  @@index([tenantId, openedAt])
  @@map("shifts")
}

model CashMovement {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  shiftId  String @db.Uuid

  /// 'sale' | 'refund' | 'pay-in' | 'pay-out' | 'opening-float'
  kind        String
  /// Signed halalas: a pay-out and a refund are negative, matching the domain.
  amountMinor BigInt
  reason      String?

  actorUserId String?  @db.Uuid
  occurredAt  DateTime
  createdAt   DateTime @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  shift  Shift  @relation(fields: [tenantId, shiftId], references: [tenantId, id], onDelete: Cascade)

  @@index([tenantId, shiftId, occurredAt])
  @@map("cash_movements")
}

// ---------------------------------------------------------------------------
// Sales — immutable once finalized
// ---------------------------------------------------------------------------

model Sale {
  id         String  @id @db.Uuid
  tenantId   String  @db.Uuid
  branchId   String  @db.Uuid
  terminalId String  @db.Uuid
  shiftId    String  @db.Uuid
  userId     String  @db.Uuid
  customerId String? @db.Uuid

  /// The client-supplied operation id. Unique per tenant, which is what makes
  /// a double-click, a network retry and an offline replay converge on one
  /// sale rather than three.
  operationId String

  status   String @default("finalized")
  sequence Int

  /// Every figure the receipt states, snapshotted. Recomputing from products
  /// later would produce a different answer after any price change.
  priceMode           String
  currency            String @default("SAR")
  grossMinor          BigInt
  lineDiscountMinor   BigInt
  basketDiscountMinor BigInt
  netMinor            BigInt
  vatMinor            BigInt
  totalMinor          BigInt
  tenderedMinor       BigInt
  changeMinor         BigInt

  issuedAt  DateTime
  createdAt DateTime @default(now())

  tenant    Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  branch    Branch         @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: NoAction)
  terminal  Terminal       @relation(fields: [tenantId, terminalId], references: [tenantId, id], onDelete: NoAction)
  shift     Shift          @relation(fields: [tenantId, shiftId], references: [tenantId, id], onDelete: NoAction)
  user      User           @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: NoAction)
  customer  Customer?      @relation(fields: [tenantId, customerId], references: [tenantId, id], onDelete: NoAction)
  lines     SaleLine[]
  discounts SaleDiscount[]
  tenders   Tender[]
  invoice   Invoice?
  returns   Return[]

  @@unique([tenantId, operationId])
  @@unique([tenantId, branchId, sequence])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, branchId, issuedAt])
  @@index([tenantId, shiftId])
  @@index([tenantId, status, issuedAt])
  @@index([tenantId, customerId])
  @@map("sales")
}

model SaleLine {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  saleId   String @db.Uuid

  /// Kept for reporting, but nothing on this row is read back from it.
  productId  String? @db.Uuid
  lineNumber Int

  /// Snapshot: what this product was called and cost at the moment of sale.
  sku            String
  nameAr         String
  nameEn         String?
  /// 'unit' | 'weighted', as it stood at the moment of sale. Null on lines
  /// written before Korvi recorded it. Never read back from `products`: a
  /// product reclassified next year must not make last year's receipt
  /// fractional (ADR-0016).
  productType    String?
  unitPriceMinor BigInt
  vatBasisPoints Int
  quantityScaled BigInt

  grossMinor          BigInt
  lineDiscountMinor   BigInt
  basketDiscountMinor BigInt
  netMinor            BigInt
  vatMinor            BigInt
  totalMinor          BigInt

  tenant      Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale        Sale         @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: Cascade)
  product     Product?     @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: NoAction)
  returnLines ReturnLine[]

  @@unique([tenantId, saleId, lineNumber])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, saleId])
  @@index([tenantId, productId])
  @@map("sale_lines")
}

model SaleDiscount {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  saleId   String @db.Uuid

  /// 'line' | 'basket'
  scope           String
  lineNumber      Int?
  /// 'fixed' | 'percentage'
  kind            String
  /// Halalas for fixed, basis points for percentage -- as entered.
  inputValue      BigInt
  /// Halalas actually granted after allocation.
  amountMinor     BigInt
  reason          String?
  grantedByUserId String? @db.Uuid

  createdAt DateTime @default(now())

  tenant    Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale      Sale   @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: Cascade)
  /// Tenant-consistent: a discount cannot be attributed to a user in another
  /// tenant, whatever the application believes (ADR-0004).
  grantedBy User?  @relation(fields: [tenantId, grantedByUserId], references: [tenantId, id], onDelete: NoAction)

  @@index([tenantId, saleId])
  @@index([tenantId, grantedByUserId])
  @@map("sale_discounts")
}

model Tender {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  saleId   String @db.Uuid

  /// 'cash' | 'electronic'. 'card' | 'mada' | 'transfer' are legacy and
  /// readable, but no route writes them any more.
  kind        String
  /// 'mada' | 'visa' | 'mastercard' | 'amex' | 'apple-pay' | 'other'.
  /// Present on an electronic tender and on nothing else.
  scheme      String?
  amountMinor BigInt
  /// Only cash can carry this above zero (ADR-0002).
  changeMinor BigInt  @default(0)
  /// The external approval this settlement record points at. Never a card
  /// number, never a PAN, never track data — see ADR-0015.
  reference   String?

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale   Sale   @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: Cascade)

  @@index([tenantId, saleId])
  @@index([tenantId, kind])
  @@index([tenantId, scheme])
  @@map("tenders")
}

// ---------------------------------------------------------------------------
// Invoices — the tax document, never rewritten
// ---------------------------------------------------------------------------

model Invoice {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  saleId   String @unique @db.Uuid

  invoiceNumber String
  /// 'simplified' | 'standard'
  invoiceType   String @default("simplified")

  /// Seller identity as it stood when the invoice was issued. A merchant who
  /// changes their registered name next year must not alter last year's tax
  /// documents.
  sellerName      String
  sellerVatNumber String  @db.VarChar(15)
  buyerName       String?
  buyerVatNumber  String? @db.VarChar(15)

  netMinor   BigInt
  vatMinor   BigInt
  totalMinor BigInt
  currency   String @default("SAR")

  issuedAt  DateTime
  createdAt DateTime @default(now())

  tenant       Tenant                @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale         Sale                  @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: NoAction)
  taxBreakdown InvoiceTaxBreakdown[]
  refunds      Refund[]

  @@unique([tenantId, invoiceNumber])
  /// The relation key for the one-to-one back to the sale. `saleId` is already
  /// globally unique, so this adds no constraint the data did not have — it
  /// states the pair the composite foreign key references.
  @@unique([tenantId, saleId])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, issuedAt])
  @@map("invoices")
}

/// One row per distinct VAT rate on the invoice. The Authority wants the split,
/// not just the sum.
model InvoiceTaxBreakdown {
  id        String @id @db.Uuid
  tenantId  String @db.Uuid
  invoiceId String @db.Uuid

  vatBasisPoints Int
  netMinor       BigInt
  vatMinor       BigInt

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  invoice Invoice @relation(fields: [tenantId, invoiceId], references: [tenantId, id], onDelete: Cascade)

  @@unique([tenantId, invoiceId, vatBasisPoints])
  @@index([tenantId, invoiceId])
  @@map("invoice_tax_breakdown")
}

// ---------------------------------------------------------------------------
// Returns — new records, never edits to the original
// ---------------------------------------------------------------------------

model Return {
  id         String  @id @db.Uuid
  tenantId   String  @db.Uuid
  saleId     String  @db.Uuid
  branchId   String  @db.Uuid
  /// Where the goods came back over the counter. Attribution, not authority:
  /// the server resolves it from the session's branch (ADR-0016).
  terminalId String? @db.Uuid
  /// The open drawer the refund is answerable to.
  shiftId    String? @db.Uuid

  operationId String
  status      String  @default("finalized")
  reason      String?

  /// Per-branch, allocated under the branch row's lock like a receipt number.
  sequence     Int?
  returnNumber String?
  currency     String  @default("SAR")

  /// The same six figures a sale carries, so a credit note can be produced
  /// years later without replaying today's prices or discounts.
  grossMinor          BigInt @default(0)
  lineDiscountMinor   BigInt @default(0)
  basketDiscountMinor BigInt @default(0)
  netMinor            BigInt
  vatMinor            BigInt
  totalMinor          BigInt

  actorUserId String   @db.Uuid
  issuedAt    DateTime
  createdAt   DateTime @default(now())

  tenant   Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale     Sale         @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: NoAction)
  branch   Branch       @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: NoAction)
  terminal Terminal?    @relation(fields: [tenantId, terminalId], references: [tenantId, id], onDelete: NoAction)
  shift    Shift?       @relation(fields: [tenantId, shiftId], references: [tenantId, id], onDelete: NoAction)
  actor    User         @relation(fields: [tenantId, actorUserId], references: [tenantId, id], onDelete: NoAction)
  lines    ReturnLine[]
  refunds  Refund[]

  @@unique([tenantId, operationId])
  @@unique([tenantId, branchId, sequence])
  @@unique([tenantId, returnNumber])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@index([tenantId, saleId])
  @@index([tenantId, issuedAt])
  @@index([tenantId, branchId, issuedAt])
  @@index([tenantId, shiftId])
  @@map("returns")
}

model ReturnLine {
  id         String @id @db.Uuid
  tenantId   String @db.Uuid
  returnId   String @db.Uuid
  saleLineId String @db.Uuid

  /// The sale line's own number, carried over so a credit note lists the goods
  /// in the order the invoice did.
  lineNumber Int?
  productId  String? @db.Uuid

  /// Snapshots of the snapshot. The sale line already froze these; copying
  /// them again means a credit note can be produced from the return document
  /// alone, without joining back through a sale that may be archived.
  sku            String?
  nameAr         String?
  nameEn         String?
  productType    String?
  vatBasisPoints Int?

  quantityScaled BigInt

  grossMinor          BigInt @default(0)
  lineDiscountMinor   BigInt @default(0)
  basketDiscountMinor BigInt @default(0)
  netMinor            BigInt
  vatMinor            BigInt
  totalMinor          BigInt

  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  return   Return   @relation(fields: [tenantId, returnId], references: [tenantId, id], onDelete: Cascade)
  saleLine SaleLine @relation(fields: [tenantId, saleLineId], references: [tenantId, id], onDelete: NoAction)
  product  Product? @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: NoAction)

  /// One row per sale line per return. Two rows for one line would each pass
  /// a remaining-quantity check their sum fails.
  @@unique([tenantId, returnId, saleLineId])
  @@index([tenantId, returnId])
  @@index([tenantId, saleLineId])
  @@index([tenantId, productId])
  @@map("return_lines")
}

model Refund {
  id        String  @id @db.Uuid
  tenantId  String  @db.Uuid
  returnId  String  @db.Uuid
  invoiceId String? @db.Uuid

  /// 'cash' | 'electronic'. 'card' | 'mada' | 'transfer' are legacy and
  /// readable; nothing writes them any more. The column was named `method`
  /// until ADR-0016 renamed it, so the vocabulary matches a tender's.
  kind        String
  /// 'mada' | 'visa' | 'mastercard' | 'amex' | 'apple-pay' | 'other'.
  /// Present on an electronic refund and on nothing else.
  scheme      String?
  amountMinor BigInt
  /// The external approval this refund points at. Never a card number.
  reference   String?

  issuedAt  DateTime
  createdAt DateTime @default(now())

  tenant  Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  return  Return   @relation(fields: [tenantId, returnId], references: [tenantId, id], onDelete: Cascade)
  invoice Invoice? @relation(fields: [tenantId, invoiceId], references: [tenantId, id], onDelete: NoAction)

  /// One refund per return document (ADR-0016). A second row would be a
  /// second settlement against goods that only came back once.
  @@unique([tenantId, returnId])
  @@map("refunds")
}

// ---------------------------------------------------------------------------
// Idempotency and audit
// ---------------------------------------------------------------------------

/// Reservation record for a replayable operation.
///
/// The unique key is (tenantId, scope, operationId): the same checkout retried
/// after a dropped connection reserves the same row, finds it already
/// completed, and returns the recorded result instead of ringing up a second
/// sale.
model IdempotencyKey {
  id       String @id @db.Uuid
  tenantId String @db.Uuid

  /// 'checkout' | 'return' | 'shift-close' ...
  scope       String
  operationId String

  /// 'reserved' | 'completed' | 'failed'
  status String @default("reserved")

  /// What the operation produced, so a retry can be answered without redoing
  /// the work. Never contains credentials.
  resultType String?
  resultId   String? @db.Uuid

  /// Fingerprint of the request body, so a replay carrying different content
  /// under the same operation id is detected rather than silently accepted.
  requestHash String?

  createdAt   DateTime  @default(now())
  completedAt DateTime?
  expiresAt   DateTime?

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, scope, operationId])
  @@index([tenantId, status])
  @@index([expiresAt])
  @@map("idempotency_keys")
}

/// Append-only. Nothing updates or deletes an audit row.
model AuditEvent {
  id       String @id @db.Uuid
  tenantId String @db.Uuid

  actorUserId String? @db.Uuid
  branchId    String? @db.Uuid
  terminalId  String? @db.Uuid

  eventType  String
  entityType String
  entityId   String?

  /// Structured context. Never credentials, tokens or password material.
  metadata Json?

  occurredAt DateTime
  createdAt  DateTime @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  actor  User?  @relation(fields: [tenantId, actorUserId], references: [tenantId, id], onDelete: NoAction)

  @@index([tenantId, occurredAt])
  @@index([tenantId, entityType, entityId])
  @@index([tenantId, eventType, occurredAt])
  @@map("audit_events")
}

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Global reference data — the only tables without tenantId
// ---------------------------------------------------------------------------

/// The permission catalogue.
///
/// Global because it is the application's own vocabulary, identical for every
/// tenant and not derived from anyone's data. Tenants bind these keys to their
/// own roles through RolePermission, which is tenant-owned.
model Permission {
  key           String   @id
  descriptionAr String
  descriptionEn String?
  createdAt     DateTime @default(now())

  roles RolePermission[]

  @@map("permissions")
}

/// The national barcode catalogue.
///
/// Shared infrastructure: hundreds of thousands of rows identical for every
/// merchant, none of it anyone's private data. Copying it per tenant would
/// multiply the table by the customer count for no isolation benefit
/// (ADR-0004).
model GlobalCatalogItem {
  barcode        String   @id
  nameAr         String
  nameEn         String?
  vatBasisPoints Int      @default(1500)
  updatedAt      DateTime @updatedAt

  @@map("global_catalog_items")
}
KORVI_EOF
cat << 'KORVI_EOF' > packages/database/prisma/migrations/20260822120000_returns_refunds/migration.sql
-- Korvi POS — Strike 3B-1b · returns and refunds
--
-- Forward only. The four committed migrations are history and are not touched.
--
-- `returns`, `return_lines` and `refunds` already exist: the SaaS foundation
-- created them with RLS ENABLEd and FORCEd, deny-by-default policies and
-- composite tenant-consistent foreign keys. They were a sketch — enough shape
-- to reserve the names, not enough to be a commercial document. This migration
-- grows them into one, and adds nothing that would let a return be written
-- without a branch, a till, a drawer, a number and an operator.
--
-- Nothing is dropped. Every column added to a table that may already hold rows
-- is added nullable or with a default, backfilled from facts that already
-- exist, and constrained afterwards.

-- --------------------------------------------------------------------------
-- Sale lines: the one immutable fact a return engine needs and did not have
-- --------------------------------------------------------------------------
--
-- Whether a line was sold by the unit or by weight decides whether half of it
-- may come back. Reading it from `products` at return time would mean a
-- catalogue edit could change what a historical sale means — reclassify a
-- product as weighted and last year's unit sales become fractionally
-- returnable. So it is snapshotted, like the price and the name beside it.
--
-- Nullable on purpose. Rows written before this migration cannot be improved
-- retroactively: today's editable catalogue is NOT historical evidence. A
-- product may have been reclassified since the sale, so copying its current
-- type here would silently rewrite what a historical sale means. Existing
-- rows therefore remain NULL. NULL means "no immutable fact proves the type";
-- the return engine allows only the entire remaining quantity for such a line,
-- because a full remainder needs no unit-vs-weight interpretation. Partial
-- returns require a real immutable snapshot written by the sale path.
ALTER TABLE "sale_lines" ADD COLUMN "productType" TEXT;

ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_type"
  CHECK ("productType" IS NULL OR "productType" IN ('unit', 'weighted'));

-- --------------------------------------------------------------------------
-- Returns: a document, not a note
-- --------------------------------------------------------------------------

ALTER TABLE "returns" ADD COLUMN "terminalId" UUID;
ALTER TABLE "returns" ADD COLUMN "shiftId" UUID;
ALTER TABLE "returns" ADD COLUMN "sequence" INTEGER;
ALTER TABLE "returns" ADD COLUMN "returnNumber" TEXT;
ALTER TABLE "returns" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'SAR';
ALTER TABLE "returns" ADD COLUMN "grossMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "returns" ADD COLUMN "lineDiscountMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "returns" ADD COLUMN "basketDiscountMinor" BIGINT NOT NULL DEFAULT 0;

-- Any row that predates this migration carried net, VAT and total and nothing
-- else. Gross is set to the total, which is what an undiscounted return's
-- extended price was; there were no discounts to describe, and inventing a
-- split would be a claim about a document nobody wrote.
UPDATE "returns" SET "grossMinor" = "totalMinor" WHERE "grossMinor" = 0;

-- net + VAT = total is already enforced by returns_reconciles, and it is
-- deliberately the only money identity asserted here. `gross - discounts`
-- equals the total under tax-inclusive pricing and the net under
-- tax-exclusive, so a constraint asserting either would be wrong for half of
-- Korvi's tenants — the same reason `sale_lines` only checks net + VAT.

ALTER TABLE "returns" ADD CONSTRAINT "returns_amounts_non_negative"
  CHECK ("grossMinor" >= 0 AND "lineDiscountMinor" >= 0 AND "basketDiscountMinor" >= 0
         AND "netMinor" >= 0 AND "vatMinor" >= 0);

-- A return worth nothing is not a return. It would consume a number and a
-- drawer movement and reconcile against nothing.
ALTER TABLE "returns" ADD CONSTRAINT "returns_total_positive" CHECK ("totalMinor" > 0);

ALTER TABLE "returns" ADD CONSTRAINT "returns_status"
  CHECK ("status" IN ('finalized', 'voided'));

-- A number is issued per branch and never reused. Both halves are unique so a
-- concurrent allocation collides here rather than producing two documents with
-- one number.
CREATE UNIQUE INDEX "returns_tenantId_branchId_sequence_key"
  ON "returns"("tenantId", "branchId", "sequence");
CREATE UNIQUE INDEX "returns_tenantId_returnNumber_key"
  ON "returns"("tenantId", "returnNumber");

CREATE INDEX "returns_tenantId_branchId_issuedAt_idx"
  ON "returns"("tenantId", "branchId", "issuedAt");
CREATE INDEX "returns_tenantId_shiftId_idx" ON "returns"("tenantId", "shiftId");

-- Tenant-consistent, like every other reference in this schema: the key is
-- (tenantId, id), so PostgreSQL refuses a return that points at another
-- merchant's till, drawer or operator even if the application is wrong
-- (ADR-0004).
ALTER TABLE "returns" ADD CONSTRAINT "returns_tenantId_terminalId_fkey"
  FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "returns" ADD CONSTRAINT "returns_tenantId_shiftId_fkey"
  FOREIGN KEY ("tenantId", "shiftId") REFERENCES "shifts"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "returns" ADD CONSTRAINT "returns_tenantId_actorUserId_fkey"
  FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- Return lines: enough to print a credit note from the return alone
-- --------------------------------------------------------------------------

ALTER TABLE "return_lines" ADD COLUMN "lineNumber" INTEGER;
ALTER TABLE "return_lines" ADD COLUMN "productId" UUID;
ALTER TABLE "return_lines" ADD COLUMN "sku" TEXT;
ALTER TABLE "return_lines" ADD COLUMN "nameAr" TEXT;
ALTER TABLE "return_lines" ADD COLUMN "nameEn" TEXT;
ALTER TABLE "return_lines" ADD COLUMN "productType" TEXT;
ALTER TABLE "return_lines" ADD COLUMN "vatBasisPoints" INTEGER;
ALTER TABLE "return_lines" ADD COLUMN "grossMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "return_lines" ADD COLUMN "lineDiscountMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "return_lines" ADD COLUMN "basketDiscountMinor" BIGINT NOT NULL DEFAULT 0;

-- Copied from the sale line the return already points at, which is itself a
-- snapshot. The copy is what lets a credit note be produced from the return
-- document without joining back through a sale.
UPDATE "return_lines" AS rl
   SET "lineNumber"     = sl."lineNumber",
       "productId"      = sl."productId",
       "sku"            = sl."sku",
       "nameAr"         = sl."nameAr",
       "nameEn"         = sl."nameEn",
       "productType"    = sl."productType",
       "vatBasisPoints" = sl."vatBasisPoints",
       "grossMinor"     = rl."totalMinor"
  FROM "sale_lines" AS sl
 WHERE sl."tenantId" = rl."tenantId"
   AND sl."id" = rl."saleLineId"
   AND rl."sku" IS NULL;

ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_amounts_non_negative"
  CHECK ("grossMinor" >= 0 AND "lineDiscountMinor" >= 0 AND "basketDiscountMinor" >= 0
         AND "netMinor" >= 0 AND "vatMinor" >= 0);
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_product_type"
  CHECK ("productType" IS NULL OR "productType" IN ('unit', 'weighted'));
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_vat_rate_bounded"
  CHECK ("vatBasisPoints" IS NULL OR ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000));

-- One row per sale line per return. Two rows for one line would each pass a
-- remaining-quantity check that their sum fails — the same defect the checkout
-- refuses when a basket names one product twice.
CREATE UNIQUE INDEX "return_lines_tenantId_returnId_saleLineId_key"
  ON "return_lines"("tenantId", "returnId", "saleLineId");

CREATE INDEX "return_lines_tenantId_productId_idx"
  ON "return_lines"("tenantId", "productId");

ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_tenantId_productId_fkey"
  FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- Refunds: a settlement record, in the same vocabulary as a tender
-- --------------------------------------------------------------------------
--
-- `method` becomes `kind` so a refund and a tender describe money with the
-- same words. A rename carries every row across; nothing is dropped and
-- nothing is rewritten.
ALTER TABLE "refunds" RENAME COLUMN "method" TO "kind";
ALTER TABLE "refunds" RENAME CONSTRAINT "refunds_method" TO "refunds_kind";

ALTER TABLE "refunds" ADD COLUMN "scheme" TEXT;

-- 'electronic' is what a till writes from now on: a refund approved somewhere
-- else and recorded here. The older values stay legal so committed rows remain
-- readable, exactly as the settlement strike did for tenders.
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_kind";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_kind"
  CHECK ("kind" IN ('cash', 'electronic', 'card', 'mada', 'transfer'));

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_scheme_values"
  CHECK ("scheme" IS NULL OR "scheme" IN ('mada', 'visa', 'mastercard', 'amex', 'apple-pay', 'other'));

-- An electronic refund names its scheme, and nothing else may carry one.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_scheme_electronic_only"
  CHECK (("kind" = 'electronic') = ("scheme" IS NOT NULL));

-- The reference points at an approval that happened elsewhere. It is the only
-- thing tying this row to that event, so an electronic refund must have one —
-- and it is operator-supplied, so it is bounded.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_electronic_reference"
  CHECK ("kind" <> 'electronic' OR ("reference" IS NOT NULL AND btrim("reference") <> ''));
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reference_bounded"
  CHECK ("reference" IS NULL OR char_length("reference") <= 64);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_cash_no_reference"
  CHECK ("kind" <> 'cash' OR "reference" IS NULL);

-- One refund per return document. Korvi has no way to prove that two external
-- approvals against one return are not the same approval counted twice, so it
-- refuses to hold both.
DROP INDEX IF EXISTS "refunds_tenantId_returnId_idx";
CREATE UNIQUE INDEX "refunds_tenantId_returnId_key" ON "refunds"("tenantId", "returnId");
KORVI_EOF
ok "database — the schema a return document needs written"

say "Database — the write path"
cat << 'KORVI_EOF' > packages/database/src/errors.ts
/** Base class for database-layer failures Korvi raises deliberately. */
export class DatabaseError extends Error {
  public override readonly name: string = 'DatabaseError';

  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Tenant context could not be established.
 *
 * Raised rather than proceeding without context: under RLS a missing context
 * yields an empty result set, which reads like "this merchant has no products"
 * instead of "the query was wrong".
 */
export class TenantContextError extends DatabaseError {
  public override readonly name = 'TenantContextError';
}

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

/**
 * A return was asked for against a sale that cannot carry one.
 *
 * The detail tells the caller apart from the customer: a sale in another
 * branch and a sale that does not exist are both `unknown-sale`, so no answer
 * reveals that another branch's sale exists (ADR-0016).
 */
export class ReturnNotAllowedError extends DatabaseError {
  public override readonly name = 'ReturnNotAllowedError';
  public readonly detail: 'unknown-sale' | 'sale-not-finalized';

  public constructor(detail: 'unknown-sale' | 'sale-not-finalized') {
    super(`Return not allowed: ${detail}`);
    this.detail = detail;
  }
}
KORVI_EOF
cat << 'KORVI_EOF' > packages/database/src/repositories/return-repository.ts
import { ELECTRONIC_SCHEMES } from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import {
  DatabaseError,
  OperationAlreadyRecordedError,
  ReturnNotAllowedError,
  ShiftUnusableError,
} from '../errors.js';
import { applyMovementWithin } from './inventory-repository.js';
import { iso, minor, oneOf, rate, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
import type {
  ProductType,
  RecordReturnInput,
  RefundKindRecord,
  RefundRecord,
  ReturnLineRecord,
  ReturnRecord,
  ReturnRepository,
  ReturnStatus,
  ReturnableSale,
  ReturnableSaleLine,
  SaleLookupQuery,
  SaleLookupRow,
  SaleStatus,
  TenantScope,
  TenderScheme,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * The return write path.
 *
 * One method does the whole commercial fact: the document, its lines, the
 * refund record, the stock that came back onto the shelf, the cash that left
 * the drawer, the number, and the idempotency reservation. Splitting them
 * across calls would let a crash leave a refund with no return, or stock
 * credited for goods nobody accepted.
 *
 * Two things make it safe under concurrency, and neither is an application
 * lock:
 *
 *   The sale row is taken FOR UPDATE first. Every return against a sale
 *   queues on that one row, so "how much is left on this line" is read by one
 *   transaction at a time. Two cashiers returning the last unit do not both
 *   see it available — the second reads the state the first committed.
 *
 *   The branch row is taken FOR UPDATE before a number is issued, exactly as
 *   the sale repository does for receipts, so a number is allocated once and
 *   only to a document that commits.
 *
 * Pricing is not done here. The caller passes a pure `plan` function; this
 * adapter reads the authoritative state under lock and hands it over. That is
 * what keeps arithmetic in the domain without moving authority out of the
 * transaction (ADR-0016).
 */

const RETURN_STATUSES: readonly ReturnStatus[] = ['finalized', 'voided'];
const SALE_STATUSES: readonly SaleStatus[] = ['finalized', 'voided'];
const PRODUCT_TYPES: readonly ProductType[] = ['unit', 'weighted'];
const REFUND_KINDS: readonly RefundKindRecord[] = [
  'cash',
  'electronic',
  'card',
  'mada',
  'transfer',
];
const REFUND_SCHEMES: readonly TenderScheme[] = [...ELECTRONIC_SCHEMES];

/** Bounded, because a lookup is a query a cashier runs while a queue waits. */
const MAX_LOOKUP_LIMIT = 25;

function productType(value: string | null): ProductType | null {
  return value === null ? null : oneOf(PRODUCT_TYPES, value, 'productType');
}

interface ReturnLineRow {
  id: string;
  lineNumber: number | null;
  saleLineId: string;
  productId: string | null;
  sku: string | null;
  nameAr: string | null;
  nameEn: string | null;
  productType: string | null;
  vatBasisPoints: number | null;
  quantityScaled: bigint;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
}

interface RefundRow {
  id: string;
  kind: string;
  scheme: string | null;
  amountMinor: bigint;
  reference: string | null;
  issuedAt: Date;
}

interface ReturnRow {
  id: string;
  tenantId: string;
  saleId: string;
  branchId: string;
  terminalId: string | null;
  shiftId: string | null;
  actorUserId: string;
  operationId: string;
  status: string;
  sequence: number | null;
  returnNumber: string | null;
  reason: string | null;
  currency: string;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
  issuedAt: Date;
  lines: ReturnLineRow[];
  refunds: RefundRow[];
}

function lineToDomain(row: ReturnLineRow): ReturnLineRecord {
  return {
    id: row.id,
    lineNumber: row.lineNumber ?? 0,
    saleLineId: row.saleLineId,
    productId: row.productId,
    sku: row.sku ?? '',
    nameAr: row.nameAr ?? '',
    nameEn: row.nameEn,
    productType: productType(row.productType),
    vatBasisPoints: rate(row.vatBasisPoints ?? 0),
    quantityScaled: minor(row.quantityScaled),
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
  };
}

function refundToDomain(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    kind: oneOf(REFUND_KINDS, row.kind, 'refunds.kind'),
    scheme: row.scheme === null ? null : oneOf(REFUND_SCHEMES, row.scheme, 'refunds.scheme'),
    amountMinor: minor(row.amountMinor),
    reference: row.reference,
    issuedAt: iso(row.issuedAt),
  };
}

function returnToDomain(scope: TenantScope, row: ReturnRow): ReturnRecord {
  if (row.terminalId === null || row.shiftId === null) {
    throw new DatabaseError('A return without a terminal or a shift cannot be attributed.');
  }
  if (row.sequence === null || row.returnNumber === null) {
    throw new DatabaseError('A return without a number is not a document.');
  }
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    saleId: row.saleId,
    branchId: row.branchId,
    terminalId: row.terminalId,
    shiftId: row.shiftId,
    actorUserId: row.actorUserId,
    operationId: row.operationId,
    status: oneOf(RETURN_STATUSES, row.status, 'returns.status'),
    sequence: row.sequence,
    returnNumber: row.returnNumber,
    reason: row.reason,
    currency: row.currency,
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
    issuedAt: iso(row.issuedAt),
    lines: row.lines.map(lineToDomain),
    refund: row.refunds.length === 0 ? null : refundToDomain(row.refunds[0] as RefundRow),
  };
}

const WITH_CHILDREN = {
  lines: { orderBy: { lineNumber: 'asc' } },
  refunds: true,
} as const;

async function loadReturn(
  tx: TransactionClient,
  tenant: string,
  where: { id: string } | { operationId: string },
): Promise<ReturnRow | null> {
  return tx.return.findFirst({ where: { ...where, tenantId: tenant }, include: WITH_CHILDREN });
}

interface SaleHeadRow {
  id: string;
  branchId: string;
  status: string;
  currency: string;
  issuedAt: Date;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
}

interface SaleLineRow {
  id: string;
  lineNumber: number;
  productId: string | null;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  productType: string | null;
  vatBasisPoints: number;
  unitPriceMinor: bigint;
  quantityScaled: bigint;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
}

interface ReturnedAggregateRow {
  saleLineId: string;
  quantityScaled: bigint | null;
  grossMinor: bigint | null;
  netMinor: bigint | null;
  lineDiscountMinor: bigint | null;
  basketDiscountMinor: bigint | null;
  vatMinor: bigint | null;
  totalMinor: bigint | null;
}

/**
 * PostgreSQL widens SUM(bigint) to `numeric`, which the driver hands back as a
 * string. Casting in SQL keeps the value a bigint all the way through; this is
 * the belt to that braces, so no arithmetic here can silently become a float.
 */
function big(value: bigint | string | null): bigint {
  if (value === null) return 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

/**
 * What has already come back, per line, from finalized returns only.
 *
 * One grouped query rather than one per line: a basket of forty items would
 * otherwise be forty round trips inside a transaction holding the sale's lock.
 */
async function returnedSoFar(
  tx: TransactionClient,
  tenant: string,
  saleId: string,
): Promise<Map<string, ReturnedAggregateRow>> {
  const rows = await tx.$queryRaw<ReturnedAggregateRow[]>`
    SELECT rl."saleLineId"                            AS "saleLineId",
           SUM(rl."quantityScaled")::bigint           AS "quantityScaled",
           SUM(rl."grossMinor")::bigint               AS "grossMinor",
           SUM(rl."netMinor")::bigint                 AS "netMinor",
           SUM(rl."lineDiscountMinor")::bigint        AS "lineDiscountMinor",
           SUM(rl."basketDiscountMinor")::bigint      AS "basketDiscountMinor",
           SUM(rl."vatMinor")::bigint                 AS "vatMinor",
           SUM(rl."totalMinor")::bigint               AS "totalMinor"
      FROM "return_lines" rl
      JOIN "returns" r
        ON r."tenantId" = rl."tenantId" AND r."id" = rl."returnId"
     WHERE rl."tenantId" = ${tenant}::uuid
       AND r."saleId" = ${saleId}::uuid
       AND r."status" = 'finalized'
     GROUP BY rl."saleLineId"`;
  return new Map(rows.map((row) => [row.saleLineId, row]));
}

function stateFrom(
  sale: SaleHeadRow,
  lines: readonly SaleLineRow[],
  returned: Map<string, ReturnedAggregateRow>,
  invoiceNumber: string | null,
): ReturnableSale {
  let refundedTotal = 0n;
  const mapped: ReturnableSaleLine[] = lines.map((line) => {
    const prior = returned.get(line.id);
    const returnedQuantity = big(prior?.quantityScaled ?? null);
    refundedTotal += big(prior?.totalMinor ?? null);
    const remaining = line.quantityScaled - returnedQuantity;
    return {
      saleLineId: line.id,
      lineNumber: line.lineNumber,
      productId: line.productId,
      sku: line.sku,
      nameAr: line.nameAr,
      nameEn: line.nameEn,
      productType: productType(line.productType),
      vatBasisPoints: rate(line.vatBasisPoints),
      unitPriceMinor: minor(line.unitPriceMinor),
      soldQuantityScaled: minor(line.quantityScaled),
      returnedQuantityScaled: minor(returnedQuantity),
      remainingQuantityScaled: minor(remaining > 0n ? remaining : 0n),
      grossMinor: minor(line.grossMinor),
      lineDiscountMinor: minor(line.lineDiscountMinor),
      basketDiscountMinor: minor(line.basketDiscountMinor),
      netMinor: minor(line.netMinor),
      vatMinor: minor(line.vatMinor),
      totalMinor: minor(line.totalMinor),
      refundedGrossMinor: minor(big(prior?.grossMinor ?? null)),
      refundedNetMinor: minor(big(prior?.netMinor ?? null)),
      refundedLineDiscountMinor: minor(big(prior?.lineDiscountMinor ?? null)),
      refundedBasketDiscountMinor: minor(big(prior?.basketDiscountMinor ?? null)),
      refundedVatMinor: minor(big(prior?.vatMinor ?? null)),
    };
  });

  return {
    saleId: sale.id,
    branchId: sale.branchId,
    status: oneOf(SALE_STATUSES, sale.status, 'sales.status'),
    invoiceNumber,
    currency: sale.currency,
    issuedAt: iso(sale.issuedAt),
    netMinor: minor(sale.netMinor),
    vatMinor: minor(sale.vatMinor),
    totalMinor: minor(sale.totalMinor),
    refundedTotalMinor: minor(refundedTotal),
    lines: mapped,
  };
}

/**
 * Prove the shift is open, on this till, in this branch, and the operator's
 * own — while holding its row.
 *
 * The same rule the sale path enforces, for the same reason: a refund posted
 * into somebody else's drawer makes their variance unanswerable at close, and
 * a preflight read can be overtaken by a close.
 */
async function assertShiftUsable(
  tx: TransactionClient,
  tenant: string,
  claim: { shiftId: string; terminalId: string; branchId: string; userId: string },
): Promise<void> {
  const rows = await tx.$queryRaw<
    { status: string; terminalId: string; branchId: string; userId: string }[]
  >`
    SELECT "status", "terminalId", "branchId", "userId" FROM "shifts"
     WHERE "id" = ${claim.shiftId}::uuid AND "tenantId" = ${tenant}::uuid
     FOR UPDATE`;

  const shift = rows.at(0);
  if (shift === undefined) throw new ShiftUnusableError('unknown-shift');
  if (shift.status !== 'open') throw new ShiftUnusableError('shift-closed');
  if (shift.terminalId !== claim.terminalId) throw new ShiftUnusableError('terminal-mismatch');
  if (shift.branchId !== claim.branchId) throw new ShiftUnusableError('branch-mismatch');
  if (shift.userId !== claim.userId) throw new ShiftUnusableError('cashier-mismatch');
}

/**
 * Allocate the branch's next return number, inside the caller's transaction.
 *
 * Its own series, separate from receipts: a return is not a sale and a
 * merchant counting invoices should not find returns interleaved. The
 * serialization is the branch row's lock, exactly as for a receipt — two tills
 * returning at once both want MAX(sequence) + 1, and under READ COMMITTED they
 * would read the same number.
 */
async function allocateReturnNumber(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
): Promise<{ sequence: number; returnNumber: string }> {
  const branches = await tx.$queryRaw<{ code: string }[]>`
    SELECT "code" FROM "branches"
     WHERE "id" = ${branchId}::uuid AND "tenantId" = ${tenant}::uuid
     FOR UPDATE`;
  const branch = branches.at(0);
  if (branch === undefined) {
    throw new DatabaseError('No such branch in this tenant; refusing to number a return for it.');
  }

  const next = await tx.$queryRaw<{ sequence: number }[]>`
    SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "returns"
     WHERE "tenantId" = ${tenant}::uuid AND "branchId" = ${branchId}::uuid`;
  const sequence = Number(next.at(0)?.sequence ?? 1);

  // `R-` first, so no reader ever mistakes a credit for an invoice.
  return { sequence, returnNumber: `R-${branch.code}-${String(sequence).padStart(6, '0')}` };
}

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
            'completed', 'return', ${resultId}::uuid, ${reservation.requestHash}, ${completedAt})
    ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
    RETURNING "id"`;
  if (inserted.length === 0) throw new OperationAlreadyRecordedError(reservation.operationId);
}

export function createReturnRepository(prisma: PrismaClient): ReturnRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<ReturnRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadReturn(tx, tenantParam(scope), { id });
        return row === null ? null : returnToDomain(scope, row);
      });
    },

    async findByOperationId(scope: TenantScope, operationId: string): Promise<ReturnRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadReturn(tx, tenantParam(scope), { operationId });
        return row === null ? null : returnToDomain(scope, row);
      });
    },

    async returnableForSale(
      scope: TenantScope,
      branchId: string,
      saleId: string,
    ): Promise<ReturnableSale | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const sale = await tx.sale.findFirst({
          where: { id: saleId, tenantId: tenant, branchId },
          select: {
            id: true,
            branchId: true,
            status: true,
            currency: true,
            issuedAt: true,
            netMinor: true,
            vatMinor: true,
            totalMinor: true,
          },
        });
        // A sale in another branch is answered exactly as a sale that does not
        // exist. The caller learns nothing about the rest of the tenant.
        if (sale === null) return null;

        const lines = await tx.saleLine.findMany({
          where: { tenantId: tenant, saleId },
          orderBy: { lineNumber: 'asc' },
        });
        const invoice = await tx.invoice.findFirst({
          where: { tenantId: tenant, saleId },
          select: { invoiceNumber: true },
        });
        const returned = await returnedSoFar(tx, tenant, saleId);
        return stateFrom(sale, lines, returned, invoice?.invoiceNumber ?? null);
      });
    },

    async lookupSales(
      scope: TenantScope,
      query: SaleLookupQuery,
    ): Promise<readonly SaleLookupRow[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const term = query.term.trim();
        if (term === '') return [];
        const limit = Math.min(Math.max(query.limit, 1), MAX_LOOKUP_LIMIT);

        // Three ways a cashier can name a sale, all indexed and all bounded:
        // the invoice number printed on the receipt, the branch sequence, and
        // the sale's own id when a system quotes one. The branch comes from the
        // session, so no query can widen past it.
        const sequence = /^[0-9]{1,9}$/.test(term) ? Number(term) : -1;
        const isUuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(term);

        const rows = await tx.$queryRaw<
          {
            id: string;
            sequence: number;
            issuedAt: Date;
            currency: string;
            totalMinor: bigint;
            invoiceNumber: string | null;
            refundedTotalMinor: bigint | string | null;
          }[]
        >`
          SELECT s."id"            AS "id",
                 s."sequence"      AS "sequence",
                 s."issuedAt"      AS "issuedAt",
                 s."currency"      AS "currency",
                 s."totalMinor"    AS "totalMinor",
                 i."invoiceNumber" AS "invoiceNumber",
                 (SELECT COALESCE(SUM(r."totalMinor"), 0)::bigint FROM "returns" r
                   WHERE r."tenantId" = s."tenantId" AND r."saleId" = s."id"
                     AND r."status" = 'finalized') AS "refundedTotalMinor"
            FROM "sales" s
            LEFT JOIN "invoices" i
              ON i."tenantId" = s."tenantId" AND i."saleId" = s."id"
           WHERE s."tenantId" = ${tenant}::uuid
             AND s."branchId" = ${query.branchId}::uuid
             AND s."status" = 'finalized'
             AND (
                   i."invoiceNumber" = ${term}
                   OR s."sequence" = ${sequence}
                   OR (${isUuid} AND s."id"::text = ${term})
                 )
           ORDER BY s."issuedAt" DESC
           LIMIT ${limit}`;

        return rows.map((row) => ({
          saleId: row.id,
          invoiceNumber: row.invoiceNumber,
          sequence: row.sequence,
          issuedAt: iso(row.issuedAt),
          currency: row.currency,
          totalMinor: minor(row.totalMinor),
          refundedTotalMinor: minor(big(row.refundedTotalMinor)),
          fullyReturned: big(row.refundedTotalMinor) >= big(row.totalMinor),
        }));
      });
    },

    async record(scope: TenantScope, input: RecordReturnInput): Promise<ReturnRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);

        /*
         * The serialization boundary.
         *
         * Every return against this sale queues here, so "what is left on this
         * line" is read by one transaction at a time. Without it, two cashiers
         * returning the last unit both read one remaining and both write a
         * return — and no CHECK constraint can catch that, because each row is
         * individually lawful.
         */
        const heads = await tx.$queryRaw<SaleHeadRow[]>`
          SELECT "id", "branchId", "status", "currency", "issuedAt",
                 "netMinor", "vatMinor", "totalMinor"
            FROM "sales"
           WHERE "id" = ${input.saleId}::uuid AND "tenantId" = ${tenant}::uuid
           FOR UPDATE`;
        const sale = heads.at(0);
        if (sale === undefined) throw new ReturnNotAllowedError('unknown-sale');
        // Branch is the session's, never the request's. A sale in another
        // branch is refused with the answer a missing sale gets.
        if (sale.branchId !== input.branchId) throw new ReturnNotAllowedError('unknown-sale');
        if (sale.status !== 'finalized') throw new ReturnNotAllowedError('sale-not-finalized');

        /*
         * The lines, in id order.
         *
         * The sale row above is what makes over-return impossible; these locks
         * are for deadlock hygiene. A deterministic order means two
         * transactions touching overlapping line sets acquire them in the same
         * sequence and one waits, rather than each holding what the other
         * needs.
         */
        const wanted = [...new Set(input.requested.map((line) => line.saleLineId))].sort();
        if (wanted.length > 0) {
          await tx.$queryRaw`
            SELECT "id" FROM "sale_lines"
             WHERE "tenantId" = ${tenant}::uuid
               AND "saleId" = ${input.saleId}::uuid
               AND "id" = ANY(${wanted}::uuid[])
             ORDER BY "id"
             FOR UPDATE`;
        }

        const lines = await tx.saleLine.findMany({
          where: { tenantId: tenant, saleId: input.saleId },
          orderBy: { lineNumber: 'asc' },
        });
        const invoice = await tx.invoice.findFirst({
          where: { tenantId: tenant, saleId: input.saleId },
          select: { invoiceNumber: true },
        });
        const returned = await returnedSoFar(tx, tenant, input.saleId);

        // Pure, and inside the lock. Its refusals roll everything back.
        const plan = input.plan(stateFrom(sale, lines, returned, invoice?.invoiceNumber ?? null));

        const number = await allocateReturnNumber(tx, tenant, input.branchId);

        await assertShiftUsable(tx, tenant, {
          shiftId: input.shiftId,
          terminalId: input.terminalId,
          branchId: input.branchId,
          userId: input.actorUserId,
        });

        const issuedAt = new Date(input.issuedAt);
        await reserveOperation(tx, tenant, input.idempotency, input.returnId, issuedAt);

        await tx.return.create({
          data: {
            id: input.returnId,
            tenantId: tenant,
            saleId: input.saleId,
            branchId: input.branchId,
            terminalId: input.terminalId,
            shiftId: input.shiftId,
            actorUserId: input.actorUserId,
            operationId: input.operationId,
            status: 'finalized',
            sequence: number.sequence,
            returnNumber: number.returnNumber,
            reason: input.reason,
            currency: input.currency,
            grossMinor: BigInt(plan.grossMinor),
            lineDiscountMinor: BigInt(plan.lineDiscountMinor),
            basketDiscountMinor: BigInt(plan.basketDiscountMinor),
            netMinor: BigInt(plan.netMinor),
            vatMinor: BigInt(plan.vatMinor),
            totalMinor: BigInt(plan.totalMinor),
            issuedAt,
          },
        });

        await tx.returnLine.createMany({
          data: plan.lines.map((line, index) => {
            const id = input.lineIds[index];
            if (id === undefined) {
              throw new DatabaseError('A return line was planned without an id to write it under.');
            }
            return {
              id,
              tenantId: tenant,
              returnId: input.returnId,
              saleLineId: line.saleLineId,
              lineNumber: line.lineNumber,
              productId: line.productId,
              sku: line.sku,
              nameAr: line.nameAr,
              nameEn: line.nameEn,
              productType: line.productType,
              vatBasisPoints: Number(line.vatBasisPoints),
              quantityScaled: BigInt(line.quantityScaled),
              grossMinor: BigInt(line.grossMinor),
              lineDiscountMinor: BigInt(line.lineDiscountMinor),
              basketDiscountMinor: BigInt(line.basketDiscountMinor),
              netMinor: BigInt(line.netMinor),
              vatMinor: BigInt(line.vatMinor),
              totalMinor: BigInt(line.totalMinor),
            };
          }),
        });

        /*
         * Stock comes back only where it went out.
         *
         * The authority is the original sale's own movements, not
         * `products.trackInventory` as it stands today. A merchant who turned
         * tracking on last week must not have last month's returns credit
         * stock that was never decremented — the balance would drift upward by
         * exactly the returns, with nothing to point at.
         */
        const sold = await tx.$queryRaw<{ productId: string }[]>`
          SELECT DISTINCT "productId" FROM "inventory_movements"
           WHERE "tenantId" = ${tenant}::uuid
             AND "sourceType" = 'sale'
             AND "sourceId" = ${input.saleId}::uuid`;
        const consumed = new Set(sold.map((row) => row.productId));

        let movement = 0;
        for (const line of plan.lines) {
          if (line.productId === null || !consumed.has(line.productId)) continue;
          const id = input.inventoryIds[movement];
          movement += 1;
          if (id === undefined) {
            throw new DatabaseError(
              'A stock reversal was planned without an id to write it under.',
            );
          }
          await applyMovementWithin(
            tx,
            tenant,
            {
              id,
              branchId: input.branchId,
              productId: line.productId,
              kind: 'return',
              // Positive: the goods are back on the shelf.
              quantityScaled: line.quantityScaled,
              reason: null,
              sourceType: 'return',
              sourceId: input.returnId,
              actorUserId: input.actorUserId,
              occurredAt: input.issuedAt,
            },
            true,
          );
        }

        await tx.refund.create({
          data: {
            id: input.refund.id,
            tenantId: tenant,
            returnId: input.returnId,
            invoiceId: null,
            kind: input.refund.kind,
            scheme: input.refund.scheme,
            // Server-derived, always. The client never says what a refund is
            // worth; the lines it asked for decide.
            amountMinor: BigInt(plan.totalMinor),
            reference: input.refund.reference,
            issuedAt,
          },
        });

        /*
         * Cash out of the drawer, and only cash.
         *
         * Negative, because the drawer holds less afterwards. An electronic
         * refund writes nothing here: the money goes back through somebody
         * else's system and the till never held it.
         *
         * No balance check. Expected cash is accounting state, not a count of
         * the notes in the drawer, and refusing a lawful refund because a
         * running total looks low would be Korvi inventing a policy the
         * merchant never asked for.
         */
        if (input.refund.kind === 'cash') {
          await tx.cashMovement.create({
            data: {
              id: input.cashMovementId,
              tenantId: tenant,
              shiftId: input.shiftId,
              kind: 'refund',
              amountMinor: -BigInt(plan.totalMinor),
              reason: null,
              actorUserId: input.actorUserId,
              occurredAt: issuedAt,
            },
          });
        }

        const row = await loadReturn(tx, tenant, { id: input.returnId });
        if (row === null) {
          throw new DatabaseError('The return just written could not be read back.');
        }
        return returnToDomain(scope, row);
      });
    },
  };
}
KORVI_EOF
cat << 'KORVI_EOF' > packages/database/src/repositories/sale-repository.ts
import { ELECTRONIC_SCHEMES } from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { DatabaseError, OperationAlreadyRecordedError, ShiftUnusableError } from '../errors.js';
import { applyMovementWithin } from './inventory-repository.js';
import { iso, minor, oneOf, rate, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
import type {
  InvoiceRecord,
  InvoiceType,
  PriceMode,
  ProductType,
  RecordSaleInput,
  SaleDiscountRecord,
  SaleLineRecord,
  SaleRecord,
  SaleRepository,
  SaleStatus,
  TenantScope,
  TenderKind,
  TenderScheme,
  TenderRecord,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const STATUSES: readonly SaleStatus[] = ['finalized', 'voided'];
const PRICE_MODES: readonly PriceMode[] = ['tax-inclusive', 'tax-exclusive'];
const TENDER_KINDS: readonly TenderKind[] = ['cash', 'card', 'mada', 'transfer', 'electronic'];
const TENDER_SCHEMES: readonly TenderScheme[] = [...ELECTRONIC_SCHEMES];
const INVOICE_TYPES: readonly InvoiceType[] = ['simplified', 'standard'];
const PRODUCT_TYPES: readonly ProductType[] = ['unit', 'weighted'];
const DISCOUNT_SCOPES = ['line', 'basket'] as const;
const DISCOUNT_KINDS = ['fixed', 'percentage'] as const;

interface LineRow {
  id: string;
  lineNumber: number;
  productId: string | null;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  productType: string | null;
  unitPriceMinor: bigint;
  vatBasisPoints: number;
  quantityScaled: bigint;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
}

interface DiscountRow {
  id: string;
  scope: string;
  lineNumber: number | null;
  kind: string;
  inputValue: bigint;
  amountMinor: bigint;
  reason: string | null;
  grantedByUserId: string | null;
}

interface TenderRow {
  id: string;
  kind: string;
  scheme: string | null;
  amountMinor: bigint;
  changeMinor: bigint;
  reference: string | null;
}

interface SaleRow {
  id: string;
  tenantId: string;
  branchId: string;
  terminalId: string;
  shiftId: string;
  userId: string;
  customerId: string | null;
  operationId: string;
  status: string;
  sequence: number;
  priceMode: string;
  currency: string;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
  tenderedMinor: bigint;
  changeMinor: bigint;
  issuedAt: Date;
  lines: LineRow[];
  discounts: DiscountRow[];
  tenders: TenderRow[];
}

interface BucketRow {
  vatBasisPoints: number;
  netMinor: bigint;
  vatMinor: bigint;
}

interface InvoiceRow {
  id: string;
  tenantId: string;
  saleId: string;
  invoiceNumber: string;
  invoiceType: string;
  sellerName: string;
  sellerVatNumber: string;
  buyerName: string | null;
  buyerVatNumber: string | null;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
  currency: string;
  issuedAt: Date;
  taxBreakdown: BucketRow[];
}

function lineToDomain(row: LineRow): SaleLineRecord {
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    productId: row.productId,
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    // Snapshotted at the moment of sale, never read back from `products`: a
    // return engine that consulted the live catalogue would let an edit change
    // what a historical sale means (ADR-0016).
    productType:
      row.productType === null
        ? null
        : oneOf(PRODUCT_TYPES, row.productType, 'sale_lines.productType'),
    unitPriceMinor: minor(row.unitPriceMinor),
    vatBasisPoints: rate(row.vatBasisPoints),
    quantityScaled: minor(row.quantityScaled),
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
  };
}

function discountToDomain(row: DiscountRow): SaleDiscountRecord {
  return {
    id: row.id,
    scope: oneOf(DISCOUNT_SCOPES, row.scope, 'sale_discounts.scope'),
    lineNumber: row.lineNumber,
    kind: oneOf(DISCOUNT_KINDS, row.kind, 'sale_discounts.kind'),
    inputValue: minor(row.inputValue),
    amountMinor: minor(row.amountMinor),
    reason: row.reason,
    grantedByUserId: row.grantedByUserId,
  };
}

function tenderToDomain(row: TenderRow): TenderRecord {
  return {
    id: row.id,
    kind: oneOf(TENDER_KINDS, row.kind, 'tenders.kind'),
    scheme: row.scheme === null ? null : oneOf(TENDER_SCHEMES, row.scheme, 'tenders.scheme'),
    amountMinor: minor(row.amountMinor),
    changeMinor: minor(row.changeMinor),
    reference: row.reference,
  };
}

function saleToDomain(scope: TenantScope, row: SaleRow): SaleRecord {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    terminalId: row.terminalId,
    shiftId: row.shiftId,
    userId: row.userId,
    customerId: row.customerId,
    operationId: row.operationId,
    status: oneOf(STATUSES, row.status, 'sales.status'),
    sequence: row.sequence,
    priceMode: oneOf(PRICE_MODES, row.priceMode, 'sales.priceMode'),
    currency: row.currency,
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
    tenderedMinor: minor(row.tenderedMinor),
    changeMinor: minor(row.changeMinor),
    issuedAt: iso(row.issuedAt),
    lines: row.lines.map(lineToDomain),
    discounts: row.discounts.map(discountToDomain),
    tenders: row.tenders.map(tenderToDomain),
  };
}

function invoiceToDomain(scope: TenantScope, row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    saleId: row.saleId,
    invoiceNumber: row.invoiceNumber,
    invoiceType: oneOf(INVOICE_TYPES, row.invoiceType, 'invoices.invoiceType'),
    sellerName: row.sellerName,
    sellerVatNumber: row.sellerVatNumber,
    buyerName: row.buyerName,
    buyerVatNumber: row.buyerVatNumber,
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
    currency: row.currency,
    issuedAt: iso(row.issuedAt),
    taxBreakdown: row.taxBreakdown.map((bucket) => ({
      vatBasisPoints: rate(bucket.vatBasisPoints),
      netMinor: minor(bucket.netMinor),
      vatMinor: minor(bucket.vatMinor),
    })),
  };
}

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

const WITH_CHILDREN = {
  lines: { orderBy: { lineNumber: 'asc' } },
  discounts: true,
  tenders: true,
} as const;

async function loadSale(
  tx: TransactionClient,
  tenant: string,
  where: { id: string } | { operationId: string },
): Promise<SaleRow | null> {
  return tx.sale.findFirst({ where: { ...where, tenantId: tenant }, include: WITH_CHILDREN });
}

/**
 * The sale write path.
 *
 * `record` takes the whole checkout as one value and commits it in one
 * transaction: the sale, its lines and tenders, the tax document, the stock it
 * consumed, the cash it put in the drawer, and the idempotency reservation.
 * Splitting those across calls would let a crash leave an invoice with no
 * sale, or stock decremented for a sale that never existed.
 *
 * Replay safety comes from the database, not from a check-then-write. The
 * unique index on (tenantId, scope, operationId) means a second attempt at the
 * same checkout fails at insert rather than ringing up a second sale, and the
 * caller answers the retry from `findByOperationId`. A pre-flight "does it
 * exist?" query would still race between the read and the write.
 */
export function createSaleRepository(prisma: PrismaClient): SaleRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<SaleRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadSale(tx, tenantParam(scope), { id });
        return row === null ? null : saleToDomain(scope, row);
      });
    },

    async findByOperationId(scope: TenantScope, operationId: string): Promise<SaleRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadSale(tx, tenantParam(scope), { operationId });
        return row === null ? null : saleToDomain(scope, row);
      });
    },

    async invoiceForSale(scope: TenantScope, saleId: string): Promise<InvoiceRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.invoice.findFirst({
          where: { saleId, tenantId: tenantParam(scope) },
          include: { taxBreakdown: { orderBy: { vatBasisPoints: 'asc' } } },
        });
        return row === null ? null : invoiceToDomain(scope, row);
      });
    },

    async record(scope: TenantScope, input: RecordSaleInput): Promise<SaleRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const { sale, invoice, inventory, cashMovement, idempotency } = input;

        // First, and inside this transaction: the number is issued to a sale
        // that is about to exist, not to a request that might not finish.
        const receipt = await allocateReceipt(tx, tenant, sale.branchId);

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

        await reserveOperation(tx, tenant, idempotency, sale.id, new Date(sale.issuedAt));

        await tx.sale.create({
          data: {
            id: sale.id,
            tenantId: tenant,
            branchId: sale.branchId,
            terminalId: sale.terminalId,
            shiftId: sale.shiftId,
            userId: sale.userId,
            customerId: sale.customerId,
            operationId: sale.operationId,
            status: sale.status,
            sequence: receipt.sequence,
            priceMode: sale.priceMode,
            currency: sale.currency,
            grossMinor: BigInt(sale.grossMinor),
            lineDiscountMinor: BigInt(sale.lineDiscountMinor),
            basketDiscountMinor: BigInt(sale.basketDiscountMinor),
            netMinor: BigInt(sale.netMinor),
            vatMinor: BigInt(sale.vatMinor),
            totalMinor: BigInt(sale.totalMinor),
            tenderedMinor: BigInt(sale.tenderedMinor),
            changeMinor: BigInt(sale.changeMinor),
            issuedAt: new Date(sale.issuedAt),
          },
        });

        await tx.saleLine.createMany({
          data: sale.lines.map((line) => ({
            id: line.id,
            tenantId: tenant,
            saleId: sale.id,
            productId: line.productId,
            lineNumber: line.lineNumber,
            sku: line.sku,
            nameAr: line.nameAr,
            nameEn: line.nameEn,
            productType: line.productType,
            unitPriceMinor: BigInt(line.unitPriceMinor),
            vatBasisPoints: Number(line.vatBasisPoints),
            quantityScaled: BigInt(line.quantityScaled),
            grossMinor: BigInt(line.grossMinor),
            lineDiscountMinor: BigInt(line.lineDiscountMinor),
            basketDiscountMinor: BigInt(line.basketDiscountMinor),
            netMinor: BigInt(line.netMinor),
            vatMinor: BigInt(line.vatMinor),
            totalMinor: BigInt(line.totalMinor),
          })),
        });

        if (sale.discounts.length > 0) {
          await tx.saleDiscount.createMany({
            data: sale.discounts.map((discount) => ({
              id: discount.id,
              tenantId: tenant,
              saleId: sale.id,
              scope: discount.scope,
              lineNumber: discount.lineNumber,
              kind: discount.kind,
              inputValue: BigInt(discount.inputValue),
              amountMinor: BigInt(discount.amountMinor),
              reason: discount.reason,
              grantedByUserId: discount.grantedByUserId,
            })),
          });
        }

        await tx.tender.createMany({
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
        });

        await tx.invoice.create({
          data: {
            id: invoice.id,
            tenantId: tenant,
            saleId: sale.id,
            invoiceNumber: receipt.invoiceNumber,
            invoiceType: invoice.invoiceType,
            sellerName: invoice.sellerName,
            sellerVatNumber: invoice.sellerVatNumber,
            buyerName: invoice.buyerName,
            buyerVatNumber: invoice.buyerVatNumber,
            netMinor: BigInt(invoice.netMinor),
            vatMinor: BigInt(invoice.vatMinor),
            totalMinor: BigInt(invoice.totalMinor),
            currency: invoice.currency,
            issuedAt: new Date(invoice.issuedAt),
          },
        });

        if (invoice.taxBreakdown.length > 0) {
          await tx.invoiceTaxBreakdown.createMany({
            data: invoice.taxBreakdown.map((bucket, index) => ({
              // The bucket has no identity of its own; it is a projection of
              // the invoice, so its id is derived from the invoice's and its
              // position rather than minted separately.
              id: bucketId(invoice.id, index),
              tenantId: tenant,
              invoiceId: invoice.id,
              vatBasisPoints: Number(bucket.vatBasisPoints),
              netMinor: BigInt(bucket.netMinor),
              vatMinor: BigInt(bucket.vatMinor),
            })),
          });
        }

        for (const movement of inventory) {
          // The guard is in the UPDATE, not in a prior read: two tills selling
          // the last unit both saw one in stock, and only this can tell them
          // apart. A refusal aborts the whole transaction.
          await applyMovementWithin(tx, tenant, movement, allowNegativeStock);
        }

        if (cashMovement !== null) {
          await tx.cashMovement.create({
            data: {
              id: cashMovement.id,
              tenantId: tenant,
              shiftId: cashMovement.shiftId,
              kind: cashMovement.kind,
              amountMinor: BigInt(cashMovement.amountMinor),
              reason: cashMovement.reason,
              actorUserId: cashMovement.actorUserId,
              occurredAt: new Date(cashMovement.occurredAt),
            },
          });
        }

        const row = await loadSale(tx, tenant, { id: sale.id });
        if (row === null) {
          throw new DatabaseError('The sale just written could not be read back.');
        }
        return saleToDomain(scope, row);
      });
    },
  };
}

/**
 * A deterministic UUID for a tax bucket, derived from its invoice.
 *
 * Deterministic so that replaying the same invoice cannot produce a second set
 * of buckets under new ids. The last two hex digits of the invoice's id are
 * replaced by the bucket index, which keeps the value a syntactically valid
 * UUID and unique within the invoice.
 */
export function bucketId(invoiceId: string, index: number): string {
  if (index > 0xff) {
    throw new DatabaseError('An invoice with more than 256 tax buckets is not a real invoice.');
  }
  const suffix = index.toString(16).padStart(2, '0');
  return `${invoiceId.slice(0, invoiceId.length - 2)}${suffix}`;
}
KORVI_EOF
cat << 'KORVI_EOF' > packages/database/src/index.ts
export { createPrismaClient } from './client.js';
export type { PrismaClient } from './client.js';

export { withTenant, withoutTenant, withLoginSlug, normalizeTenantSlug } from './tenant-context.js';
export type { TransactionClient } from './tenant-context.js';

export {
  DatabaseError,
  TenantContextError,
  InsufficientStockError,
  OperationAlreadyRecordedError,
  ShiftUnusableError,
  ShiftOpenRefusedError,
  ReturnNotAllowedError,
} from './errors.js';

export { createTenantRepository } from './repositories/tenant-repository.js';
export { createBranchRepository } from './repositories/branch-repository.js';
export { createDashboardRepository } from './repositories/dashboard-repository.js';
export { createTerminalRepository } from './repositories/terminal-repository.js';
export {
  createProductRepository,
  createGlobalCatalogRepository,
} from './repositories/product-repository.js';
// `applyMovementWithin` is deliberately not re-exported. It takes a raw tenant
// string and an open transaction, which is safe only because the sale
// repository calls it from inside withTenant. On the public surface it would
// be a way to write stock into an arbitrary tenant.
export { createInventoryRepository } from './repositories/inventory-repository.js';
export { createCustomerRepository } from './repositories/customer-repository.js';
export { createShiftRepository } from './repositories/shift-repository.js';
export { createSaleRepository } from './repositories/sale-repository.js';
export { createReturnRepository } from './repositories/return-repository.js';
export { createIdempotencyRepository } from './repositories/idempotency-repository.js';
export { createAuditRepository } from './repositories/audit-repository.js';
export { createAuthRepository } from './repositories/auth-repository.js';
export {
  PERMISSION_CATALOGUE,
  DEFAULT_ROLES,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  assignRole,
} from './provisioning/rbac.js';
export type { ProvisionedRole } from './provisioning/rbac.js';
KORVI_EOF
ok "database — the write path written"

say "API — the return engine"
cat << 'KORVI_EOF' > apps/api/src/returns/fingerprint.ts
import { createHash } from 'node:crypto';

/**
 * What the client says it wants sent back.
 *
 * Only the material intent: which sale, at which till, which lines, how much
 * of each, and how the money goes back. Nothing derived by the server is in
 * here — not the amount, not the branch, not the shift, not the operator, not
 * the return number. Those are consequences of the request, not part of it,
 * and including them would make a lawful retry hash differently the moment a
 * shift rolled over.
 *
 * The refund method *is* intent. The same goods returned for cash and returned
 * to a card are two different commercial events: one empties the drawer and
 * the other does not, and a merchant reconciling a till needs them told apart.
 * Replaying one as the other would be silently wrong.
 *
 * The reason is not included. It is a free-text note a cashier may retype
 * differently on a retry, and treating a typo as a different transaction would
 * turn a network hiccup into a refused refund at the counter.
 */
export interface ReturnIntentLine {
  readonly saleLineId: string;
  readonly quantityScaled: string;
}

export interface ReturnIntent {
  readonly saleId: string;
  readonly terminalId: string;
  readonly lines: readonly ReturnIntentLine[];
  readonly refundKind: string;
  readonly refundScheme: string;
  readonly refundReference: string;
}

/**
 * A stable fingerprint of the intent, stored beside the idempotency key.
 *
 * Canonicalised as structured JSON rather than a joined string, for the reason
 * the checkout fingerprint spells out: an approval reference is free text and
 * can contain any separator a hand-rolled encoding might pick, so the
 * separators must come from the encoding and not from field content. Records
 * are sorted by their own serialisation so the order a cashier keyed the lines
 * in does not change the hash while the lines themselves still do.
 */
export function fingerprintReturnIntent(intent: ReturnIntent): string {
  const lines = intent.lines
    .map((line): readonly string[] => [line.saleLineId, line.quantityScaled])
    .sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1));

  const canonical = JSON.stringify([
    'return.v1',
    intent.saleId,
    intent.terminalId,
    intent.refundKind,
    intent.refundScheme,
    intent.refundReference,
    lines,
  ]);

  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/returns/service.ts
import {
  DuplicateReturnLineError,
  InvalidRefundError,
  InvalidReturnQuantityError,
  NothingReturnableError,
  OverReturnError,
  ProrationError,
  ProrationMismatchError,
  UnknownSaleLineError,
  newId as defaultNewId,
  planReturn,
  tenantId as brandTenantId,
} from '@korvi/domain';
import {
  OperationAlreadyRecordedError,
  ReturnNotAllowedError,
  ShiftUnusableError,
} from '@korvi/database';
import { fingerprintReturnIntent } from './fingerprint.js';
import type {
  AuditRepository,
  AuthenticatedPrincipal,
  IdempotencyRepository,
  RecordReturnPlan,
  ReturnRecord,
  ReturnRepository,
  ReturnableLine,
  ReturnableSale,
  SaleLookupRow,
  TenantScope,
  TenderScheme,
  TerminalRepository,
  ShiftRepository,
} from '@korvi/domain';

/**
 * Returns, from the server's side of the counter.
 *
 * The engine is deliberately shaped like the checkout service beside it: the
 * same idempotency discipline, the same refusal to believe anything the
 * browser says about money, the same habit of letting the database settle
 * every race a read cannot. What differs is where the numbers come from. A
 * checkout prices a basket against the catalogue; a return prices nothing at
 * all — every halala is prorated from the sale that was already written, and
 * a price change since then is none of its business (ADR-0016).
 *
 * The UI this serves does not exist yet. That is the point: by the time it
 * does, everything that could go wrong at a counter has already been decided
 * here, where it can be tested.
 */

export type ReturnFailureReason =
  | 'sale-not-found'
  | 'return-not-allowed'
  | 'nothing-returnable'
  | 'over-return'
  | 'invalid-return-quantity'
  | 'duplicate-return-line'
  | 'unknown-sale-line'
  | 'refund-invalid'
  | 'idempotency-conflict'
  | 'no-open-shift'
  | 'shift-invalid'
  | 'unknown-terminal'
  | 'branch-required';

export interface ReturnFailure {
  readonly outcome: 'failure';
  readonly reason: ReturnFailureReason;
  readonly detail?: string;
}

export interface ReturnSummaryLine {
  readonly lineNumber: number;
  readonly saleLineId: string;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly quantityScaled: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface ReturnSummaryRefund {
  readonly kind: string;
  readonly scheme: string | null;
  readonly amountMinor: string;
  readonly reference: string | null;
}

export interface ReturnSummary {
  readonly returnId: string;
  readonly returnNumber: string;
  readonly saleId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly currency: string;
  readonly reason: string | null;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly issuedAt: string;
  readonly lines: readonly ReturnSummaryLine[];
  readonly refund: ReturnSummaryRefund | null;
}

export interface ReturnSuccess {
  readonly outcome: 'success';
  readonly replayed: boolean;
  readonly document: ReturnSummary;
}

export type ReturnResult = ReturnSuccess | ReturnFailure;

export type RefundInput =
  | { readonly kind: 'cash' }
  | { readonly kind: 'electronic'; readonly scheme: TenderScheme; readonly reference: string };

export interface ReturnLineInput {
  readonly saleLineId: string;
  readonly quantityScaled: string;
}

export interface CreateReturnInput {
  readonly principal: AuthenticatedPrincipal;
  readonly operationId: string;
  readonly terminalId: string;
  readonly saleId: string;
  readonly reason?: string | undefined;
  readonly lines: readonly ReturnLineInput[];
  readonly refund: RefundInput;
}

export interface ReturnDeps {
  readonly returns: ReturnRepository;
  readonly terminals: TerminalRepository;
  readonly shifts: ShiftRepository;
  readonly idempotency: IdempotencyRepository;
  readonly audit: AuditRepository;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly onAuditError?: (error: unknown) => void;
}

const IDEMPOTENCY_SCOPE = 'return';

function fail(reason: ReturnFailureReason, detail?: string): ReturnFailure {
  return detail === undefined
    ? { outcome: 'failure', reason }
    : { outcome: 'failure', reason, detail };
}

function summarise(record: ReturnRecord): ReturnSummary {
  return {
    returnId: record.id,
    returnNumber: record.returnNumber,
    saleId: record.saleId,
    operationId: record.operationId,
    sequence: record.sequence,
    branchId: record.branchId,
    terminalId: record.terminalId,
    shiftId: record.shiftId,
    currency: record.currency,
    reason: record.reason,
    grossMinor: record.grossMinor,
    lineDiscountMinor: record.lineDiscountMinor,
    basketDiscountMinor: record.basketDiscountMinor,
    netMinor: record.netMinor,
    vatMinor: record.vatMinor,
    totalMinor: record.totalMinor,
    issuedAt: record.issuedAt,
    lines: record.lines.map((line) => ({
      lineNumber: line.lineNumber,
      saleLineId: line.saleLineId,
      productId: line.productId,
      sku: line.sku,
      nameAr: line.nameAr,
      quantityScaled: line.quantityScaled,
      grossMinor: line.grossMinor,
      lineDiscountMinor: line.lineDiscountMinor,
      basketDiscountMinor: line.basketDiscountMinor,
      netMinor: line.netMinor,
      vatMinor: line.vatMinor,
      totalMinor: line.totalMinor,
    })),
    refund:
      record.refund === null
        ? null
        : {
            kind: record.refund.kind,
            scheme: record.refund.scheme,
            amountMinor: record.refund.amountMinor,
            // The pointer at somebody else's approval, which is what makes a
            // refund traceable. Never a card number: the API refuses one by
            // name and by value, and so does the domain.
            reference: record.refund.reference,
          },
  };
}

/** The persisted state, in the vocabulary the domain prices with. */
function toReturnableLines(state: ReturnableSale): readonly ReturnableLine[] {
  return state.lines.map((line) => ({
    saleLineId: line.saleLineId,
    lineNumber: line.lineNumber,
    productId: line.productId,
    sku: line.sku,
    nameAr: line.nameAr,
    nameEn: line.nameEn,
    productType: line.productType,
    vatBasisPoints: line.vatBasisPoints,
    soldQuantityScaled: BigInt(line.soldQuantityScaled),
    returnedQuantityScaled: BigInt(line.returnedQuantityScaled),
    original: {
      grossMinor: BigInt(line.grossMinor),
      lineDiscountMinor: BigInt(line.lineDiscountMinor),
      basketDiscountMinor: BigInt(line.basketDiscountMinor),
      netMinor: BigInt(line.netMinor),
      vatMinor: BigInt(line.vatMinor),
      totalMinor: BigInt(line.totalMinor),
    },
    refunded: {
      grossMinor: BigInt(line.refundedGrossMinor),
      netMinor: BigInt(line.refundedNetMinor),
      lineDiscountMinor: BigInt(line.refundedLineDiscountMinor),
      basketDiscountMinor: BigInt(line.refundedBasketDiscountMinor),
      vatMinor: BigInt(line.refundedVatMinor),
    },
  }));
}

export interface ReturnService {
  create(input: CreateReturnInput): Promise<ReturnResult>;
  lookup(
    principal: AuthenticatedPrincipal,
    term: string,
    limit: number,
  ): Promise<readonly SaleLookupRow[] | ReturnFailure>;
  returnable(
    principal: AuthenticatedPrincipal,
    saleId: string,
  ): Promise<ReturnableSale | ReturnFailure>;
}

export function createReturnService(deps: ReturnDeps): ReturnService {
  const { now = () => new Date(), newId = defaultNewId, onAuditError = () => undefined } = deps;

  const scopeOf = (principal: AuthenticatedPrincipal): TenantScope => ({
    tenantId: brandTenantId(principal.tenantId),
  });

  /**
   * The till this principal may act through, or nothing.
   *
   * Exists, active, and in the session's own branch. A failure of any one of
   * them is the same answer, so a cashier pinned to one branch cannot probe
   * for tills in another.
   */
  async function ownBranchTerminal(
    principal: AuthenticatedPrincipal,
    terminalId: string,
  ): Promise<{ id: string; branchId: string } | null> {
    const terminal = await deps.terminals.findById(scopeOf(principal), terminalId);
    if (terminal === null || !terminal.isActive) return null;
    if (terminal.branchId !== principal.branchId) return null;
    return { id: terminal.id, branchId: terminal.branchId };
  }

  /** Answer a request whose operation id belongs to a committed transaction. */
  async function resolveCompeting(
    scope: TenantScope,
    operationId: string,
    intentHash: string,
  ): Promise<ReturnResult> {
    const reserved = await deps.idempotency.find(scope, IDEMPOTENCY_SCOPE, operationId);
    if (reserved !== null && reserved.requestHash !== intentHash) {
      return fail('idempotency-conflict');
    }
    const existing = await deps.returns.findByOperationId(scope, operationId);
    if (existing === null) {
      // Reserved, but nothing to show for it. Retrying could refund twice, so
      // the honest answer is a conflict.
      return fail('idempotency-conflict');
    }
    return { outcome: 'success', replayed: true, document: summarise(existing) };
  }

  return {
    async lookup(principal, term, limit) {
      if (principal.branchId === null) return fail('branch-required');
      const rows = await deps.returns.lookupSales(scopeOf(principal), {
        branchId: principal.branchId,
        term,
        limit,
      });
      return rows;
    },

    async returnable(principal, saleId) {
      if (principal.branchId === null) return fail('branch-required');
      const state = await deps.returns.returnableForSale(
        scopeOf(principal),
        principal.branchId,
        saleId,
      );
      // Another branch's sale and a sale that does not exist get the same
      // answer, deliberately.
      if (state === null) return fail('sale-not-found');
      if (state.status !== 'finalized') return fail('return-not-allowed');
      return state;
    },

    async create(input: CreateReturnInput): Promise<ReturnResult> {
      const scope = scopeOf(input.principal);

      if (input.principal.branchId === null) return fail('branch-required');
      if (input.lines.length === 0) return fail('invalid-return-quantity');

      const seen = new Set<string>();
      for (const line of input.lines) {
        if (seen.has(line.saleLineId)) return fail('duplicate-return-line');
        seen.add(line.saleLineId);
      }

      const terminal = await ownBranchTerminal(input.principal, input.terminalId);
      if (terminal === null) return fail('unknown-terminal');

      // A refund has to come out of somewhere. The shift also supplies nothing
      // the client could have named — the branch is the session's and the
      // drawer is the one open on this till.
      const shift = await deps.shifts.findOpenForTerminal(scope, terminal.id);
      if (shift === null) return fail('no-open-shift');
      if (shift.userId !== input.principal.userId) return fail('shift-invalid');
      if (shift.branchId !== terminal.branchId) return fail('shift-invalid');

      const intentHash = fingerprintReturnIntent({
        saleId: input.saleId,
        terminalId: input.terminalId,
        lines: input.lines.map((line) => ({
          saleLineId: line.saleLineId,
          quantityScaled: line.quantityScaled,
        })),
        refundKind: input.refund.kind,
        refundScheme: input.refund.kind === 'electronic' ? input.refund.scheme : '',
        refundReference: input.refund.kind === 'electronic' ? input.refund.reference : '',
      });

      // Replay, before anything is computed or written.
      const reserved = await deps.idempotency.find(scope, IDEMPOTENCY_SCOPE, input.operationId);
      if (reserved !== null) {
        if (reserved.requestHash !== intentHash) return fail('idempotency-conflict');
        const existing = await deps.returns.findByOperationId(scope, input.operationId);
        if (existing !== null) {
          return { outcome: 'success', replayed: true, document: summarise(existing) };
        }
      }

      // A courtesy read, so a request that was never going to work is refused
      // without opening a transaction. It is not authority: the same numbers
      // are read again under the sale's lock, and that read is the one that
      // decides.
      const preflight = await deps.returns.returnableForSale(
        scope,
        input.principal.branchId,
        input.saleId,
      );
      if (preflight === null) return fail('sale-not-found');
      if (preflight.status !== 'finalized') return fail('return-not-allowed');

      const returnId = newId();
      const issuedAt = now().toISOString();
      const requested = input.lines.map((line) => ({
        saleLineId: line.saleLineId,
        quantityScaled: line.quantityScaled,
      }));

      let recorded: ReturnRecord;
      try {
        recorded = await deps.returns.record(scope, {
          returnId,
          saleId: input.saleId,
          operationId: input.operationId,
          branchId: terminal.branchId,
          terminalId: terminal.id,
          shiftId: shift.id,
          actorUserId: input.principal.userId,
          reason: input.reason ?? null,
          currency: preflight.currency,
          issuedAt,
          requested,
          refund: {
            id: newId(),
            kind: input.refund.kind,
            scheme: input.refund.kind === 'electronic' ? input.refund.scheme : null,
            reference: input.refund.kind === 'electronic' ? input.refund.reference : null,
          },
          lineIds: input.lines.map(() => newId()),
          inventoryIds: input.lines.map(() => newId()),
          cashMovementId: newId(),
          idempotency: {
            id: newId(),
            scope: IDEMPOTENCY_SCOPE,
            operationId: input.operationId,
            requestHash: intentHash,
          },
          /*
           * The arithmetic, run inside the transaction against rows read under
           * the sale's lock. Everything it refuses rolls the transaction back
           * before a number is issued or a halala moves.
           */
          plan: (state): RecordReturnPlan => {
            const draft = planReturn({
              available: toReturnableLines(state),
              requested: requested.map((line) => ({
                saleLineId: line.saleLineId,
                quantityScaled: BigInt(line.quantityScaled),
              })),
              refund: input.refund,
            });
            return {
              lines: draft.lines.map((line) => ({
                saleLineId: line.saleLineId,
                lineNumber: line.lineNumber,
                productId: line.productId,
                sku: line.sku,
                nameAr: line.nameAr,
                nameEn: line.nameEn,
                productType: line.productType,
                vatBasisPoints: line.vatBasisPoints,
                quantityScaled: line.quantityScaled.toString(),
                grossMinor: line.components.grossMinor.toString(),
                lineDiscountMinor: line.components.lineDiscountMinor.toString(),
                basketDiscountMinor: line.components.basketDiscountMinor.toString(),
                netMinor: line.components.netMinor.toString(),
                vatMinor: line.components.vatMinor.toString(),
                totalMinor: line.components.totalMinor.toString(),
              })),
              grossMinor: draft.grossMinor.toString(),
              lineDiscountMinor: draft.lineDiscountMinor.toString(),
              basketDiscountMinor: draft.basketDiscountMinor.toString(),
              netMinor: draft.netMinor.toString(),
              vatMinor: draft.vatMinor.toString(),
              totalMinor: draft.totalMinor.toString(),
            };
          },
        });
      } catch (error) {
        // Every one of these is a deliberate refusal. None of them reaches the
        // client as a driver error, and none of them leaves a partial return
        // behind: they are all thrown inside the transaction.
        if (error instanceof OverReturnError) return fail('over-return');
        if (error instanceof NothingReturnableError) return fail('nothing-returnable');
        if (error instanceof DuplicateReturnLineError) return fail('duplicate-return-line');
        if (error instanceof UnknownSaleLineError) return fail('unknown-sale-line');
        if (error instanceof InvalidReturnQuantityError) return fail('invalid-return-quantity');
        if (error instanceof InvalidRefundError) return fail('refund-invalid');
        if (error instanceof ProrationError || error instanceof ProrationMismatchError) {
          return fail('return-not-allowed');
        }
        if (error instanceof ReturnNotAllowedError) {
          return fail(error.detail === 'unknown-sale' ? 'sale-not-found' : 'return-not-allowed');
        }
        if (error instanceof ShiftUnusableError) return fail('shift-invalid');
        if (error instanceof OperationAlreadyRecordedError) {
          return resolveCompeting(scope, input.operationId, intentHash);
        }
        throw error;
      }

      // Outside the transaction, and its failure does not undo the refund: the
      // money has gone back and the customer has left by the time this runs.
      try {
        await deps.audit.append(scope, {
          id: newId(),
          actorUserId: input.principal.userId,
          branchId: recorded.branchId,
          terminalId: recorded.terminalId,
          eventType: 'sale.returned',
          entityType: 'return',
          entityId: recorded.id,
          metadata: {
            returnNumber: recorded.returnNumber,
            saleId: recorded.saleId,
            totalMinor: recorded.totalMinor,
            refundKind: recorded.refund?.kind ?? '',
            // The scheme, because a manager reviewing refunds needs the shape
            // of them. Never the reference: it belongs to somebody else's
            // system and an audit row is the most widely read table there is.
            refundScheme: recorded.refund?.scheme ?? '',
            lines: recorded.lines.length,
          },
          occurredAt: recorded.issuedAt,
        });
      } catch (error) {
        onAuditError(error);
      }

      return { outcome: 'success', replayed: false, document: summarise(recorded) };
    },
  };
}
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/checkout/service.ts
import {
  DiscountNotPermittedError,
  InvalidAmountError,
  InvalidDiscountError,
  InvalidTenderError,
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
import {
  InsufficientStockError,
  OperationAlreadyRecordedError,
  ShiftUnusableError,
} from '@korvi/database';
import { fingerprintIntent } from './fingerprint.js';
import type {
  AuditRepository,
  AuthenticatedPrincipal,
  CartLineInput,
  Discount,
  Currency,
  IdempotencyRepository,
  InventoryMovementInput,
  InventoryRepository,
  PriceMode,
  Product,
  ProductRepository,
  SaleDiscountRecord,
  SaleRecord,
  SaleRepository,
  TenderLine,
  TenderRecord,
  TenderScheme,
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
  | 'invalid-tender'
  | 'electronic-overpay'
  | 'ambiguous-payment'
  | 'invalid-discount'
  | 'discount-not-authorized'
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

export interface SaleSummaryTender {
  readonly kind: string;
  readonly scheme: string | null;
  readonly amountMinor: string;
  readonly changeMinor: string;
  readonly reference: string | null;
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
  /**
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
}

export interface CheckoutSuccess {
  readonly outcome: 'success';
  /** True when this request replayed an operation id that already completed. */
  readonly replayed: boolean;
  readonly sale: SaleSummary;
}

export type CheckoutResult = CheckoutSuccess | CheckoutFailure;

/**
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

const IDEMPOTENCY_SCOPE = 'checkout';

function fail(reason: CheckoutFailureReason, detail?: string): CheckoutFailure {
  return detail === undefined
    ? { outcome: 'failure', reason }
    : { outcome: 'failure', reason, detail };
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

      const payment = normalizePayment(input);
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
      };

      // A ceiling says how much; the permission says whether at all. A
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
      const discounted =
        input.basketDiscount !== undefined ||
        input.lines.some((line) => line.discount !== undefined);
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
          tenders: payment.map((tender) => toTenderLine(tender, currency)),
          issuedAt,
          // The ceiling comes from the roles the database granted, never from
          // the request. No discount is offered in this strike; passing the
          // real figure keeps the guard live for when one is.
          maxDiscountBasisPoints: maxDiscountForRoles(input.principal.roles),
        });
      } catch (error) {
        // The ceiling is the merchant's policy, and refusing loudly is the
        // point: silently clamping a discount to what was permitted would give
        // the customer a different price from the one the cashier promised.
        if (error instanceof InvalidDiscountError) return fail('invalid-discount');
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
      }

      // Belt and braces over the domain's own arithmetic: a sale that does not
      // reconcile must never reach a customer, and the database CHECK that also
      // says so is not a good place to find out.
      if (!saleReconciles(finalized)) {
        throw new Error('The finalized sale does not reconcile; refusing to persist it.');
      }

      const priced = finalized.priced;

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
        changeMinor: tender.kind === 'cash' ? finalized.settlement.change.minor.toString() : '0',
        reference: tender.kind === 'electronic' ? tender.reference : null,
      }));

      /*
       * Cash tendered, less the change handed back. The only part of a sale
       * that reaches the drawer.
       */
      const cashRetainedMinor =
        payment
          .filter((tender) => tender.kind === 'cash')
          .reduce((total, tender) => total + BigInt(tender.amountMinor), 0n) -
        finalized.settlement.change.minor;

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
            requested.mode === 'basis-points' ? String(requested.value) : requested.amountMinor,
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
              // The one immutable fact a return needs and a priced line does
              // not carry: unit or weighted, as the catalogue said at this
              // moment (ADR-0016). Nothing else on this path changed.
              productType: loaded[index]?.product.productType ?? null,
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
            // Enough to explain the receipt years later without replaying
            // today's pricing rules against a catalogue that has moved on:
            // what was asked for, what was granted, and by whom.
            discounts: recordedDiscounts,
            tenders: recordedTenders,
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
          // What the drawer actually gained.
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
              : null,
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
          },
          occurredAt: issuedAt,
        });

        // discountAudit: a discount is a second fact about the same sale, not a different
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
              scopes: recordedDiscounts
                .map((discount) => discount.scope)
                .sort()
                .join(','),
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
        replayed: false,
        sale: summarise(recorded, invoice?.invoiceNumber ?? '', input.principal.displayName),
      };
    },
  };
}
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/routes/validation.ts
import { looksLikeCardNumber } from '@korvi/domain';
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
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'not a uuid',
  );

/** Halalas as a decimal string. Never a number: JSON floats lose halalas. */
export const MINOR = z.string().regex(/^(0|[1-9][0-9]{0,14})$/, 'not an integer amount');

/** Scaled by 1000. Same reasoning, and the same refusal to accept a float. */
export const SCALED_QUANTITY = z
  .string()
  .regex(/^[1-9][0-9]{0,11}$/, 'not a positive scaled quantity');

export const MAX_PAGE_SIZE = 50;
export const MAX_CART_LINES = 200;

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

export const productQuery = z.object({
  q: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

export const currentShiftQuery = z.object({ terminalId: UUID });

export const openShiftBody = z.object({
  terminalId: UUID,
  openingFloatMinor: MINOR,
});

/**
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
  .refine((body) => (body.cashReceivedMinor === undefined) !== (body.tenders === undefined), {
    message: 'send either cashReceivedMinor or tenders, not both and not neither',
  });

/**
 * A return, as a client may state it.
 *
 * Quantities and identifiers, and nothing that decides money. The refund
 * amount is absent because the client does not get a say in it: the lines it
 * asks to send back determine what is owed, and the server prorates that from
 * the sale it already wrote (ADR-0016).
 */
export const MAX_RETURN_LINES = 200;
export const MAX_RETURN_REASON = 200;

export const refundBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cash') }),
  z.object({
    kind: z.literal('electronic'),
    scheme: z.enum(['mada', 'visa', 'mastercard', 'amex', 'apple-pay', 'other']),
    reference: z.string().trim().min(1).max(MAX_TENDER_REFERENCE),
  }),
]);

export const returnBody = z.object({
  operationId: UUID,
  terminalId: UUID,
  saleId: UUID,
  reason: z.string().trim().max(MAX_RETURN_REASON).optional(),
  refund: refundBody,
  lines: z
    .array(
      z.object({
        saleLineId: UUID,
        quantityScaled: SCALED_QUANTITY,
      }),
    )
    .min(1)
    .max(MAX_RETURN_LINES)
    // Two rows for one line would each pass a remaining-quantity check their
    // sum fails. One row per line, with the quantity summed by the client.
    .refine((lines) => new Set(lines.map((line) => line.saleLineId)).size === lines.length, {
      message: 'duplicate return line',
    }),
});

export const saleLookupQuery = z.object({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export const saleIdParams = z.object({ saleId: UUID });

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
  // A return decides none of these either. `refundTotal` and `returnTotal` are
  // named because a client that computed one has a bug that will keep sending
  // it, and the first person to notice should not be an auditor.
  'shiftId',
  'terminalCode',
  'refundTotal',
  'refundTotalMinor',
  'returnTotal',
  'returnTotalMinor',
  'returnNumber',
  'grossMinor',
  'lineDiscountMinor',
  'basketDiscountMinor',
  'vatBasisPoints',
  'currency',
  'price',
] as const;

export function namesForbiddenField(body: unknown): string | null {
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
}
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/routes/business.ts
import { tenantId as brandTenantId } from '@korvi/domain';
import { ShiftOpenRefusedError } from '@korvi/database';
import {
  checkoutBody,
  currentShiftQuery,
  carriesCardNumber,
  namesCardField,
  namesForbiddenField,
  openShiftBody,
  productQuery,
  returnBody,
  saleIdParams,
  saleLookupQuery,
} from './validation.js';
import type { CheckoutFailureReason, CheckoutService } from '../checkout/service.js';
import type { ReturnFailureReason, ReturnService } from '../returns/service.js';
import type { Guards } from '../auth/guards.js';
import type {
  AuthenticatedPrincipal,
  DashboardRepository,
  ProductRepository,
  ShiftRepository,
  TenantRepository,
  TenantScope,
  Terminal,
  TerminalRepository,
} from '@korvi/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The cashier's server surface. Five routes, and nothing a till does not need.
 *
 * Every one of them derives the tenant from `request.auth`, which the session
 * guard filled in from the database. There is no route on which a tenant id,
 * a user id, a role or a price can arrive from the client and be believed.
 */

export interface BusinessDeps {
  /** Read-only, and only for the settings the till has to render correctly. */
  readonly tenants: TenantRepository;
  readonly dashboard: DashboardRepository;
  readonly products: ProductRepository;
  readonly shifts: ShiftRepository;
  readonly terminals: TerminalRepository;
  readonly checkout: CheckoutService;
  readonly returns: ReturnService;
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
  'invalid-tender': 'بيانات الدفع غير صالحة. راجع طريقة الدفع والمبلغ.',
  'electronic-overpay': 'مبلغ الدفع الإلكتروني يتجاوز المطلوب، والباقي لا يُعاد إلا نقداً.',
  'ambiguous-payment': 'أرسل نقداً أو قائمة دفعات، لا الاثنين معاً.',
  'invalid-discount': 'الخصم غير صالح لهذه السلة.',
  'discount-not-authorized': 'الخصم المطلوب يتجاوز الحد المسموح لهذا المستخدم.',
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
  'invalid-tender': 422,
  'electronic-overpay': 422,
  'ambiguous-payment': 400,
  'invalid-discount': 422,
  // 403: the request is well-formed and the server understood it. This user
  // may not grant that much.
  'discount-not-authorized': 403,
  'idempotency-conflict': 409,
  'duplicate-line': 422,
  'shift-invalid': 409,
  'tenant-misconfigured': 409,
};

/**
 * The same discipline as a checkout's messages: what to do next, and nothing
 * about why the server thinks so. `sale-not-found` is deliberately the answer
 * for a sale in another branch as well as for one that does not exist — a
 * cashier learns nothing about the rest of the merchant from a refusal.
 */
const RETURN_MESSAGES: Readonly<Record<ReturnFailureReason, string>> = {
  'sale-not-found': 'لا توجد فاتورة بهذا الرقم في هذا الفرع.',
  'return-not-allowed': 'لا يمكن إرجاع هذه الفاتورة.',
  'nothing-returnable': 'لا يوجد ما يمكن إرجاعه من هذه الفاتورة.',
  'over-return': 'الكمية المطلوبة أكبر من المتبقي للإرجاع.',
  'invalid-return-quantity': 'كمية الإرجاع غير صالحة لهذا الصنف.',
  'duplicate-return-line': 'الصنف مكرر في طلب الإرجاع. ادمج الكمية في سطر واحد.',
  'unknown-sale-line': 'أحد الأسطر ليس ضمن هذه الفاتورة.',
  'refund-invalid': 'بيانات الاسترداد غير صالحة. راجع طريقة الاسترداد ومرجعها.',
  'idempotency-conflict': 'طلب سابق بنفس المعرّف يحمل محتوى مختلفاً.',
  'no-open-shift': 'لا توجد وردية مفتوحة على هذا الصندوق. افتح وردية أولاً.',
  'shift-invalid': 'الوردية لم تعد صالحة لهذا الصندوق. تحقّق من الوردية.',
  'unknown-terminal': 'الصندوق غير معروف.',
  'branch-required': 'لا يوجد فرع مرتبط بهذا المستخدم. راجع إعدادات المنشأة.',
};

const RETURN_STATUS: Readonly<Record<ReturnFailureReason, number>> = {
  'sale-not-found': 404,
  'return-not-allowed': 409,
  'nothing-returnable': 409,
  'over-return': 409,
  'invalid-return-quantity': 422,
  'duplicate-return-line': 422,
  'unknown-sale-line': 422,
  'refund-invalid': 422,
  'idempotency-conflict': 409,
  'no-open-shift': 409,
  'shift-invalid': 409,
  // The same 404 a till in another branch gets from every other route.
  'unknown-terminal': 404,
  'branch-required': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

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

  /**
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
  /**
   * The owner's dashboard.
   *
   * `report.read` rather than a new permission: this is the smallest read of
   * the numbers a report would show, and the vocabulary in
   * packages/domain/src/rbac is not something a UI strike gets to extend. A
   * cashier does not hold it; a manager does.
   *
   * The window is 24 rolling hours, decided here and not by the client. A
   * calendar day would need a tenant timezone Korvi does not persist, and the
   * first screen an owner sees is the wrong place to invent one.
   */
  app.get(
    '/v1/dashboard/summary',
    { preHandler: [guards.requireSession, guards.requirePermission('report.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const summary = await deps.dashboard.summary(scopeOf(principal), since);
      return reply.code(200).send(summary);
    },
  );

  app.get(
    '/v1/terminals',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.open')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      // A principal with no branch has no till to be at. Deterministic and
      // named, so the browser can render an operational message rather than
      // guessing from an empty list.
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

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
          message: 'إعدادات المنشأة غير مكتملة.',
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
    '/v1/shifts/current',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.open')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      // Branch context is mandatory for the cashier vertical. Without it there
      // is no set of tills this principal may ask about, and answering for an
      // arbitrary one is the defect this refuses.
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const parsed = currentShiftQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      // Before any shift is read. A shift row carries the branch, the cashier,
      // the opening float and the time it started — none of which a cashier in
      // another branch should be able to see.
      const terminal = await ownBranchTerminal(deps.terminals, principal, parsed.data.terminalId);
      if (terminal === null) return reply.code(404).send(UNKNOWN_TERMINAL);

      const shift = await deps.shifts.findOpenForTerminal(scopeOf(principal), terminal.id);
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

      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      const parsed = openShiftBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const scope = scopeOf(principal);
      // The branch comes from the terminal, not from the request: a till is
      // physically in one branch and the client has no standing to say which.
      // But which tills this principal may name is a separate question, and
      // opening a real shift on another branch's till is a write, not a peek.
      const terminal = await ownBranchTerminal(deps.terminals, principal, parsed.data.terminalId);
      if (terminal === null) return reply.code(404).send(UNKNOWN_TERMINAL);

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
      // Cardholder data is refused by name, at any depth. Korvi records that a
      // payment was approved elsewhere; it is not in the business of holding
      // the instrument that approved it (ADR-0015).
      const cardField = namesCardField(request.body);
      if (cardField !== null) {
        return reply.code(400).send({ error: 'card_data_refused', field: cardField });
      }
      // And by value, not only by field name: a card number arrives in a field
      // called `reference` far more plausibly than in one called `pan`. The
      // response names no field and echoes nothing — a refusal that quotes the
      // number is a refusal that writes it down.
      if (carriesCardNumber(request.body)) {
        return reply.code(400).send({ error: 'card_data_refused' });
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
      });

      if (result.outcome === 'failure') {
        request.log.info({ reason: result.reason }, 'checkout refused');
        return reply
          .code(STATUS[result.reason])
          .send({ error: result.reason, message: result.detail ?? MESSAGES[result.reason] });
      }

      // 200 rather than 201 on a replay: nothing was created this time.
      return reply
        .code(result.replayed ? 200 : 201)
        .send({ sale: result.sale, replayed: result.replayed });
    },
  );
  /**
   * Find the sale a customer is standing there with.
   *
   * `sale.refund` rather than a new permission: looking a sale up in order to
   * return it is the first half of returning it, and the vocabulary in
   * packages/domain/src/rbac is not something a route gets to extend.
   *
   * Branch-scoped from the session, bounded, and indexed on all three of the
   * things a cashier can read off a receipt. There is no query that lists a
   * merchant's history.
   */
  app.get(
    '/v1/sales/lookup',
    { preHandler: [guards.requireSession, guards.requirePermission('sale.refund')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const parsed = saleLookupQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const found = await deps.returns.lookup(principal, parsed.data.q, parsed.data.limit);
      if (!Array.isArray(found)) {
        const failure = found as { reason: ReturnFailureReason };
        return reply
          .code(RETURN_STATUS[failure.reason])
          .send({ error: failure.reason, message: RETURN_MESSAGES[failure.reason] });
      }

      return reply.code(200).send({ sales: found, limit: parsed.data.limit });
    },
  );

  /**
   * What is left to return on one sale.
   *
   * Read-only and truthful: a sale everything has already come back from is
   * reported as such rather than hidden, because a cashier holding the receipt
   * needs to know which of those two situations they are in. A sale in another
   * branch is answered exactly as a sale that does not exist.
   */
  app.get(
    '/v1/sales/:saleId/returnable',
    { preHandler: [guards.requireSession, guards.requirePermission('sale.refund')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const parsed = saleIdParams.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_params' });

      const state = await deps.returns.returnable(principal, parsed.data.saleId);
      if ('outcome' in state) {
        return reply
          .code(RETURN_STATUS[state.reason])
          .send({ error: state.reason, message: RETURN_MESSAGES[state.reason] });
      }

      // Shaped here rather than sent through: a repository record is not a
      // response, and basis points cross the wire as an integer the way every
      // other Korvi route sends them.
      return reply.code(200).send({
        sale: {
          saleId: state.saleId,
          invoiceNumber: state.invoiceNumber,
          issuedAt: state.issuedAt,
          currency: state.currency,
          netMinor: state.netMinor,
          vatMinor: state.vatMinor,
          totalMinor: state.totalMinor,
          refundedTotalMinor: state.refundedTotalMinor,
          lines: state.lines.map((line) => ({
            saleLineId: line.saleLineId,
            lineNumber: line.lineNumber,
            productId: line.productId,
            sku: line.sku,
            nameAr: line.nameAr,
            nameEn: line.nameEn,
            productType: line.productType,
            vatBasisPoints: Number(line.vatBasisPoints),
            unitPriceMinor: line.unitPriceMinor,
            soldQuantityScaled: line.soldQuantityScaled,
            returnedQuantityScaled: line.returnedQuantityScaled,
            remainingQuantityScaled: line.remainingQuantityScaled,
            grossMinor: line.grossMinor,
            lineDiscountMinor: line.lineDiscountMinor,
            basketDiscountMinor: line.basketDiscountMinor,
            netMinor: line.netMinor,
            vatMinor: line.vatMinor,
            totalMinor: line.totalMinor,
          })),
        },
      });
    },
  );

  /**
   * Send goods back and put the money where it came from.
   *
   * The request carries a till and a list of lines. It does not carry a
   * branch, a shift, a cashier, a price, a VAT figure or a refund total —
   * every one of those is derived from the session and the sale that was
   * already written, and a client that tries to send one is refused by name
   * rather than quietly ignored.
   */
  app.post(
    '/v1/returns',
    { preHandler: [guards.requireSession, guards.requirePermission('sale.refund')] },
    async (request, reply: FastifyReply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      // Cardholder data is refused by name and by value, at any depth, exactly
      // as it is on a checkout. A refund reference is free text, which is
      // precisely where a broken integration puts a card number (ADR-0015).
      const cardField = namesCardField(request.body);
      if (cardField !== null) {
        return reply.code(400).send({ error: 'card_data_refused', field: cardField });
      }
      if (carriesCardNumber(request.body)) {
        return reply.code(400).send({ error: 'card_data_refused' });
      }

      const parsed = returnBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await deps.returns.create({
        principal,
        operationId: parsed.data.operationId,
        terminalId: parsed.data.terminalId,
        saleId: parsed.data.saleId,
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
        lines: parsed.data.lines,
        refund: parsed.data.refund,
      });

      if (result.outcome === 'failure') {
        request.log.info({ reason: result.reason }, 'return refused');
        return reply
          .code(RETURN_STATUS[result.reason])
          .send({ error: result.reason, message: result.detail ?? RETURN_MESSAGES[result.reason] });
      }

      // 200 rather than 201 on a replay: nothing was created this time.
      return reply
        .code(result.replayed ? 200 : 201)
        .send({ return: result.document, replayed: result.replayed });
    },
  );
}
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/server.ts
import Fastify from 'fastify';
import {
  createAuditRepository,
  createDashboardRepository,
  createAuthRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createSaleRepository,
  createReturnRepository,
  createShiftRepository,
  createTenantRepository,
  createTerminalRepository,
} from '@korvi/database';
import { newId } from '@korvi/domain';
import { createGuards } from './auth/guards.js';
import { createCheckoutService } from './checkout/service.js';
import { createReturnService } from './returns/service.js';
import { registerBusinessRoutes } from './routes/business.js';
import { createAuthService } from './auth/service.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import type { AuthService } from './auth/service.js';
import type { BusinessDeps } from './routes/business.js';
import type { ApiConfig } from './config.js';
import type { FastifyInstance } from 'fastify';

export interface ServerDeps {
  /**
   * The cashier's repositories and checkout pipeline.
   *
   * Supplied by tests with in-memory implementations; built from DATABASE_URL
   * on first use otherwise, for the same reason `auth` is.
   */
  readonly business?: BusinessDeps;
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
    const tenants = createTenantRepository(prisma);
    const dashboard = createDashboardRepository(prisma);
    const idempotency = createIdempotencyRepository(prisma);
    const audit = createAuditRepository(prisma);
    built = {
      tenants,
      dashboard,
      products,
      shifts,
      terminals,
      checkout: createCheckoutService({
        tenants,
        products,
        inventory: createInventoryRepository(prisma),
        shifts,
        sales: createSaleRepository(prisma),
        idempotency,
        audit,
      }),
      returns: createReturnService({
        returns: createReturnRepository(prisma),
        terminals,
        shifts,
        idempotency,
        audit,
      }),
    };
    return built;
  };

  return {
    tenants: {
      current: (scope) => resolve().tenants.current(scope),
      settings: (scope) => resolve().tenants.settings(scope),
    },
    dashboard: { summary: (scope, since) => resolve().dashboard.summary(scope, since) },
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
    returns: {
      create: (input) => resolve().returns.create(input),
      lookup: (principal, term, limit) => resolve().returns.lookup(principal, term, limit),
      returnable: (principal, saleId) => resolve().returns.returnable(principal, saleId),
    },
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
  const business = deps.business ?? lazyBusinessDeps(config);

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
  registerBusinessRoutes(app, { deps: business, guards, newId });
  return app;
}
KORVI_EOF
ok "api — the return engine written"

say "Tests"
cat << 'KORVI_EOF' > packages/domain/src/returns/__tests__/returns.test.ts
import { describe, expect, it } from 'vitest';
import { basisPoints } from '../../tax/basis-points.js';
import { cumulativeTarget } from '../prorate.js';
import {
  DuplicateReturnLineError,
  InvalidRefundError,
  InvalidReturnQuantityError,
  NothingReturnableError,
  OverReturnError,
  UnknownSaleLineError,
  planReturn,
} from '../returns.js';
import type { ReturnableLine, RefundIntent } from '../returns.js';
import type { LineComponents } from '../prorate.js';

/**
 * The arithmetic a merchant would find out about eventually.
 *
 * Most of this file is one property stated several ways: however a line is
 * broken up across returns, the sum of what the customer gets back equals what
 * they paid for those goods — to the halala, on every component, not just on
 * the total. Get it wrong and nothing crashes; a merchant simply keeps a few
 * halalas of somebody else's money on every partial return, forever.
 */

const CASH: RefundIntent = { kind: 'cash' };

/**
 * A line whose components divide badly by three, which is the whole point.
 *
 * gross 1000 - lineDiscount 101 - basketDiscount 7 = net 892, and 892 + 133 =
 * total 1025. Every one of those has a remainder over three units.
 */
const AWKWARD: LineComponents = {
  grossMinor: 1000n,
  lineDiscountMinor: 101n,
  basketDiscountMinor: 7n,
  netMinor: 892n,
  vatMinor: 133n,
  totalMinor: 1025n,
};

const NOTHING_REFUNDED = {
  grossMinor: 0n,
  netMinor: 0n,
  lineDiscountMinor: 0n,
  basketDiscountMinor: 0n,
  vatMinor: 0n,
};

function line(overrides: Partial<ReturnableLine> = {}): ReturnableLine {
  return {
    saleLineId: 'line-1',
    lineNumber: 1,
    productId: 'product-1',
    sku: 'MILK-1L',
    nameAr: 'حليب طازج',
    nameEn: null,
    productType: 'unit',
    vatBasisPoints: basisPoints(1500),
    soldQuantityScaled: 3_000n,
    returnedQuantityScaled: 0n,
    original: AWKWARD,
    refunded: NOTHING_REFUNDED,
    ...overrides,
  };
}

describe('cumulative proration', () => {
  it('is the whole component at the whole quantity', () => {
    expect(cumulativeTarget(1025n, 3_000n, 3_000n)).toBe(1025n);
    expect(cumulativeTarget(0n, 3_000n, 3_000n)).toBe(0n);
  });

  it('floors, so the sequence never steps backwards', () => {
    expect(cumulativeTarget(1000n, 1_000n, 3_000n)).toBe(333n);
    expect(cumulativeTarget(1000n, 2_000n, 3_000n)).toBe(666n);
  });

  it('refuses a line that sold nothing, or more back than went out', () => {
    expect(() => cumulativeTarget(100n, 1n, 0n)).toThrow();
    expect(() => cumulativeTarget(100n, 4n, 3n)).toThrow();
  });
});

describe('a whole return', () => {
  it('gives back exactly what the line was worth', () => {
    const draft = planReturn({
      available: [line()],
      requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
      refund: CASH,
    });

    expect(draft.grossMinor).toBe(1000n);
    expect(draft.lineDiscountMinor).toBe(101n);
    expect(draft.basketDiscountMinor).toBe(7n);
    expect(draft.netMinor).toBe(892n);
    expect(draft.vatMinor).toBe(133n);
    expect(draft.totalMinor).toBe(1025n);
  });

  it('follows the line the sale wrote, not the price times the quantity', () => {
    // The unit price no longer explains this line: a discount was granted at
    // the till. A return that recomputed from a price would refund the
    // undiscounted amount and hand the customer money they never paid.
    const draft = planReturn({
      available: [line()],
      requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
      refund: CASH,
    });
    expect(draft.totalMinor).toBe(AWKWARD.totalMinor);
  });
});

describe('sequential partial returns', () => {
  it('sums to the original on every component, one unit at a time', () => {
    let returned = 0n;
    let refunded = { ...NOTHING_REFUNDED };
    const totals = { gross: 0n, ld: 0n, bd: 0n, net: 0n, vat: 0n, total: 0n };

    for (let i = 0; i < 3; i += 1) {
      const draft = planReturn({
        available: [line({ returnedQuantityScaled: returned, refunded })],
        requested: [{ saleLineId: 'line-1', quantityScaled: 1_000n }],
        refund: CASH,
      });

      // Each document is internally consistent on its own, not only in sum.
      expect(draft.netMinor + draft.vatMinor).toBe(draft.totalMinor);

      totals.gross += draft.grossMinor;
      totals.ld += draft.lineDiscountMinor;
      totals.bd += draft.basketDiscountMinor;
      totals.net += draft.netMinor;
      totals.vat += draft.vatMinor;
      totals.total += draft.totalMinor;

      returned += 1_000n;
      refunded = {
        grossMinor: refunded.grossMinor + draft.grossMinor,
        netMinor: refunded.netMinor + draft.netMinor,
        lineDiscountMinor: refunded.lineDiscountMinor + draft.lineDiscountMinor,
        basketDiscountMinor: refunded.basketDiscountMinor + draft.basketDiscountMinor,
        vatMinor: refunded.vatMinor + draft.vatMinor,
      };
    }

    expect(totals.gross).toBe(AWKWARD.grossMinor);
    expect(totals.ld).toBe(AWKWARD.lineDiscountMinor);
    expect(totals.bd).toBe(AWKWARD.basketDiscountMinor);
    expect(totals.net).toBe(AWKWARD.netMinor);
    expect(totals.vat).toBe(AWKWARD.vatMinor);
    expect(totals.total).toBe(AWKWARD.totalMinor);
  });

  it('never rounds the same halala twice: two then one closes exactly', () => {
    const first = planReturn({
      available: [line()],
      requested: [{ saleLineId: 'line-1', quantityScaled: 2_000n }],
      refund: CASH,
    });
    const second = planReturn({
      available: [
        line({
          returnedQuantityScaled: 2_000n,
          refunded: {
            grossMinor: first.grossMinor,
            netMinor: first.netMinor,
            lineDiscountMinor: first.lineDiscountMinor,
            basketDiscountMinor: first.basketDiscountMinor,
            vatMinor: first.vatMinor,
          },
        }),
      ],
      requested: [{ saleLineId: 'line-1', quantityScaled: 1_000n }],
      refund: CASH,
    });

    expect(first.totalMinor + second.totalMinor).toBe(AWKWARD.totalMinor);
    expect(first.vatMinor + second.vatMinor).toBe(AWKWARD.vatMinor);
    expect(first.lineDiscountMinor + second.lineDiscountMinor).toBe(AWKWARD.lineDiscountMinor);
  });

  it('closes exactly for a weighted line returned in three uneven pieces', () => {
    // 1.234 kg sold; 0.4, 0.5 and 0.334 back. Nothing divides.
    const weighted = line({
      productType: 'weighted',
      soldQuantityScaled: 1_234n,
      original: {
        grossMinor: 4_321n,
        lineDiscountMinor: 0n,
        basketDiscountMinor: 199n,
        netMinor: 4_122n,
        vatMinor: 618n,
        totalMinor: 4_740n,
      },
    });

    let returned = 0n;
    let refunded = { ...NOTHING_REFUNDED };
    let total = 0n;
    for (const piece of [400n, 500n, 334n]) {
      const draft = planReturn({
        available: [
          weighted.returnedQuantityScaled === returned && returned === 0n
            ? weighted
            : { ...weighted, returnedQuantityScaled: returned, refunded },
        ],
        requested: [{ saleLineId: 'line-1', quantityScaled: piece }],
        refund: CASH,
      });
      total += draft.totalMinor;
      returned += piece;
      refunded = {
        grossMinor: refunded.grossMinor + draft.grossMinor,
        netMinor: refunded.netMinor + draft.netMinor,
        lineDiscountMinor: refunded.lineDiscountMinor + draft.lineDiscountMinor,
        basketDiscountMinor: refunded.basketDiscountMinor + draft.basketDiscountMinor,
        vatMinor: refunded.vatMinor + draft.vatMinor,
      };
    }

    expect(returned).toBe(1_234n);
    expect(total).toBe(4_740n);
    expect(refunded.netMinor).toBe(4_122n);
    expect(refunded.basketDiscountMinor).toBe(199n);
    expect(refunded.vatMinor).toBe(618n);
  });
});

describe('what a return may not be', () => {
  it('refuses nothing, and refuses a negative', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: 0n }],
        refund: CASH,
      }),
    ).toThrow(InvalidReturnQuantityError);

    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: -1_000n }],
        refund: CASH,
      }),
    ).toThrow(InvalidReturnQuantityError);
  });

  it('refuses a third of a unit product', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: 333n }],
        refund: CASH,
      }),
    ).toThrow(InvalidReturnQuantityError);
  });

  it('allows a fraction of a weighted product', () => {
    const draft = planReturn({
      available: [line({ productType: 'weighted' })],
      requested: [{ saleLineId: 'line-1', quantityScaled: 333n }],
      refund: CASH,
    });
    expect(draft.totalMinor).toBeGreaterThan(0n);
  });

  it('refuses a partial return when the historical product type was never recorded', () => {
    // A pre-snapshot sale line has no immutable proof that it was unit or
    // weighted. Today's catalogue and quantity divisibility are both unsafe
    // guesses, so a partial return is refused.
    expect(() =>
      planReturn({
        available: [line({ productType: null })],
        requested: [{ saleLineId: 'line-1', quantityScaled: 333n }],
        refund: CASH,
      }),
    ).toThrow(InvalidReturnQuantityError);
  });

  it('allows the entire remaining quantity when the historical product type is unknown', () => {
    // Returning the complete remainder requires no unit-vs-weight inference.
    const draft = planReturn({
      available: [line({ productType: null })],
      requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
      refund: CASH,
    });
    expect(draft.totalMinor).toBeGreaterThan(0n);
  });

  it('refuses the same line twice in one document', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [
          { saleLineId: 'line-1', quantityScaled: 1_000n },
          { saleLineId: 'line-1', quantityScaled: 1_000n },
        ],
        refund: CASH,
      }),
    ).toThrow(DuplicateReturnLineError);
  });

  it('refuses more than the line has left', () => {
    expect(() =>
      planReturn({
        available: [line({ returnedQuantityScaled: 2_000n, refunded: NOTHING_REFUNDED })],
        requested: [{ saleLineId: 'line-1', quantityScaled: 2_000n }],
        refund: CASH,
      }),
    ).toThrow(OverReturnError);
  });

  it('refuses a line that has already come back in full', () => {
    expect(() =>
      planReturn({
        available: [line({ returnedQuantityScaled: 3_000n, refunded: NOTHING_REFUNDED })],
        requested: [{ saleLineId: 'line-1', quantityScaled: 1_000n }],
        refund: CASH,
      }),
    ).toThrow(NothingReturnableError);
  });

  it('refuses a line that belongs to another sale', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'somebody-elses-line', quantityScaled: 1_000n }],
        refund: CASH,
      }),
    ).toThrow(UnknownSaleLineError);
  });

  it('refuses a document worth nothing', () => {
    const free = line({
      original: {
        grossMinor: 0n,
        lineDiscountMinor: 0n,
        basketDiscountMinor: 0n,
        netMinor: 0n,
        vatMinor: 0n,
        totalMinor: 0n,
      },
    });
    expect(() =>
      planReturn({
        available: [free],
        requested: [{ saleLineId: 'line-1', quantityScaled: 1_000n }],
        refund: CASH,
      }),
    ).toThrow(NothingReturnableError);
  });
});

describe('how the money goes back', () => {
  it('records an electronic refund against somebody else’s approval', () => {
    const draft = planReturn({
      available: [line()],
      requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
      refund: { kind: 'electronic', scheme: 'mada', reference: 'AUTH-99812' },
    });
    expect(draft.totalMinor).toBe(1025n);
  });

  it('refuses an electronic refund with nothing to point at', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
        refund: { kind: 'electronic', scheme: 'mada', reference: '   ' },
      }),
    ).toThrow(InvalidRefundError);
  });

  it('refuses a reference longer than a reference', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
        refund: { kind: 'electronic', scheme: 'visa', reference: 'X'.repeat(65) },
      }),
    ).toThrow(InvalidRefundError);
  });

  it('refuses a card number wearing a reference’s clothes', () => {
    // 4111 1111 1111 1111 satisfies Luhn. A refund reference is free text,
    // which is exactly where a broken integration puts one.
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
        refund: { kind: 'electronic', scheme: 'visa', reference: '4111 1111 1111 1111' },
      }),
    ).toThrow(InvalidRefundError);
  });

  it('derives the refund from the lines, so nothing else can name it', () => {
    const draft = planReturn({
      available: [line(), line({ saleLineId: 'line-2', lineNumber: 2 })],
      requested: [
        { saleLineId: 'line-1', quantityScaled: 1_000n },
        { saleLineId: 'line-2', quantityScaled: 3_000n },
      ],
      refund: CASH,
    });
    const fromLines = draft.lines.reduce((total, row) => total + row.components.totalMinor, 0n);
    expect(draft.totalMinor).toBe(fromLines);
  });
});
KORVI_EOF
cat << 'KORVI_EOF' > packages/database/src/__tests__/repository-tenancy.test.ts
import { describe, expect, it } from 'vitest';
import { basisPoints, tenantId } from '@korvi/domain';
import { createAuditRepository } from '../repositories/audit-repository.js';
import { createBranchRepository } from '../repositories/branch-repository.js';
import { createCustomerRepository } from '../repositories/customer-repository.js';
import { createIdempotencyRepository } from '../repositories/idempotency-repository.js';
import { createInventoryRepository } from '../repositories/inventory-repository.js';
import { createProductRepository } from '../repositories/product-repository.js';
import { createSaleRepository } from '../repositories/sale-repository.js';
import { createShiftRepository } from '../repositories/shift-repository.js';
import { ShiftOpenRefusedError } from '../errors.js';
import { createTenantRepository } from '../repositories/tenant-repository.js';
import { createTerminalRepository } from '../repositories/terminal-repository.js';
import type { RecordSaleInput, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * What reaches the database, without a database.
 *
 * The fake records every model call a repository makes and every value bound
 * into the tenant-context statement. That is enough to prove the two things
 * this layer is responsible for:
 *
 *   every read and write is filtered by the scope's tenant, and
 *   every one of them runs inside a transaction that has already established
 *   `app.tenant_id`.
 *
 * It deliberately proves nothing about PostgreSQL's own behaviour. Whether RLS
 * actually blocks a cross-tenant read is a question for a live server, and
 * asserting it here would be asserting something this file cannot see.
 */

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const OTHER_TENANT = '018f3a1c-9b2e-7c4d-8e5f-ffffffffffff';
const scope: TenantScope = { tenantId: tenantId(TENANT) };
const AT = '2026-08-08T10:00:00.000Z';

interface Call {
  readonly model: string;
  readonly method: string;
  readonly args: Record<string, unknown>;
}

interface Fake {
  readonly client: PrismaClient;
  readonly calls: Call[];
  readonly contexts: unknown[];
  readonly raw: string[];
}

/** Replies keyed by `model.method`, consumed in order, the last one repeating. */
type Replies = Record<string, readonly unknown[]>;

function fake(replies: Replies = {}): Fake {
  const calls: Call[] = [];
  const contexts: unknown[] = [];
  const raw: string[] = [];
  const cursor = new Map<string, number>();

  const reply = (model: string, method: string): unknown => {
    const key = `${model}.${method}`;
    const queue = replies[key];
    if (queue === undefined || queue.length === 0) {
      if (method === 'findMany') return [];
      if (method === 'createMany' || method === 'updateMany') return { count: 1 };
      return null;
    }
    const index = cursor.get(key) ?? 0;
    cursor.set(key, index + 1);
    return queue[Math.min(index, queue.length - 1)];
  };

  const tx = new Proxy(
    {},
    {
      get(_target, model: string | symbol): unknown {
        if (typeof model !== 'string') return undefined;
        if (model === '$executeRaw') {
          return (_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
            contexts.push(values[0]);
            return Promise.resolve(1);
          };
        }
        if (model === '$queryRaw') {
          // The receipt allocation asks for the branch row and then for the
          // next number. Answering both keeps this a test of tenant scoping
          // rather than a test of how the numbering happens to be written.
          return (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
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
        }
        return new Proxy(
          {},
          {
            get(_inner, method: string | symbol): unknown {
              if (typeof method !== 'string') return undefined;
              return (args: Record<string, unknown> = {}): Promise<unknown> => {
                calls.push({ model, method, args });
                return Promise.resolve(reply(model, method));
              };
            },
          },
        );
      },
    },
  );

  const client = {
    $transaction: (work: (t: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;

  return { client, calls, contexts, raw };
}

/** JSON with bigint rendered rather than thrown on. */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
}

function branchRow(tenant = TENANT): Record<string, unknown> {
  return { id: 'b1', tenantId: tenant, code: '01', nameAr: 'الفرع', nameEn: null, isActive: true };
}

function productRow(): Record<string, unknown> {
  return {
    id: 'p1',
    tenantId: TENANT,
    categoryId: null,
    sku: 'SKU-1',
    nameAr: 'حليب',
    nameEn: 'Milk',
    productType: 'unit',
    unitLabel: 'each',
    priceMinor: 1150n,
    vatBasisPoints: 1500,
    trackInventory: true,
    isActive: true,
    barcodes: [
      { barcode: '6281000000001', isPrimary: true },
      { barcode: '6281000000002', isPrimary: false },
    ],
  };
}

/** Every operation this layer exposes, driven once. */
async function exerciseEverything(f: Fake): Promise<void> {
  const prisma = f.client;

  await createTenantRepository(prisma).current(scope);
  await createTenantRepository(prisma).settings(scope);
  await createBranchRepository(prisma).findById(scope, 'b1');
  await createBranchRepository(prisma).list(scope);
  await createTerminalRepository(prisma).findById(scope, 't1');
  await createTerminalRepository(prisma).findByCode(scope, '01');
  await createTerminalRepository(prisma).listForBranch(scope, 'b1');
  await createTerminalRepository(prisma).markSeen(scope, 't1', AT);
  await createProductRepository(prisma).findById(scope, 'p1');
  await createProductRepository(prisma).findBySku(scope, 'SKU-1');
  await createProductRepository(prisma).findByBarcode(scope, '6281000000001');
  await createProductRepository(prisma).list(scope, 10);
  await createInventoryRepository(prisma).balance(scope, 'b1', 'p1');
  await createInventoryRepository(prisma).listBalances(scope, 'b1', 10);
  await createInventoryRepository(prisma).applyMovement(scope, {
    id: 'm1',
    branchId: 'b1',
    productId: 'p1',
    kind: 'adjustment',
    quantityScaled: '-1000',
    reason: 'تالف',
    sourceType: null,
    sourceId: null,
    actorUserId: 'u1',
    occurredAt: AT,
  });
  await createCustomerRepository(prisma).findById(scope, 'c1');
  await createCustomerRepository(prisma).findByPhone(scope, '0500000000');
  await createCustomerRepository(prisma).list(scope, 10);
  await createCustomerRepository(prisma).create(scope, {
    id: 'c2',
    nameAr: 'عميل',
    nameEn: null,
    phone: '0500000001',
    email: null,
    vatNumber: null,
  });
  await createShiftRepository(prisma).findById(scope, 's1');
  await createShiftRepository(prisma).findOpenForTerminal(scope, 't1');
  await createSaleRepository(prisma).findById(scope, 'sale1');
  await createSaleRepository(prisma).findByOperationId(scope, 'op-1');
  await createSaleRepository(prisma).invoiceForSale(scope, 'sale1');
  await createIdempotencyRepository(prisma).find(scope, 'checkout', 'op-1');
  await createIdempotencyRepository(prisma).reserve(scope, {
    id: 'ik1',
    scope: 'checkout',
    operationId: 'op-1',
    requestHash: 'abc',
  });
  await createIdempotencyRepository(prisma).complete(scope, 'checkout', 'op-1', {
    resultType: 'sale',
    resultId: 'sale1',
    at: AT,
  });
  await createAuditRepository(prisma).append(scope, {
    id: 'a1',
    actorUserId: 'u1',
    branchId: 'b1',
    terminalId: 't1',
    eventType: 'sale.finalized',
    entityType: 'sale',
    entityId: 'sale1',
    metadata: { sequence: 12 },
    occurredAt: AT,
  });
  await createAuditRepository(prisma).list(scope, 10);
}

/** Replies rich enough that mapping code runs rather than short-circuiting. */
const FULL_REPLIES: Replies = {
  'inventoryBalance.upsert': [
    { tenantId: TENANT, branchId: 'b1', productId: 'p1', quantityScaled: -1000n },
  ],
  'customer.create': [
    {
      id: 'c2',
      tenantId: TENANT,
      nameAr: 'عميل',
      nameEn: null,
      phone: '0500000001',
      email: null,
      vatNumber: null,
      isActive: true,
    },
  ],
  'idempotencyKey.create': [
    {
      id: 'ik1',
      tenantId: TENANT,
      scope: 'checkout',
      operationId: 'op-1',
      status: 'reserved',
      resultType: null,
      resultId: null,
      requestHash: 'abc',
      completedAt: null,
    },
  ],
};

describe('every repository operation is tenant-scoped', () => {
  it('establishes the scope tenant on the transaction before any query', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    // One context statement per operation, and every one carries this tenant.
    expect(f.contexts.length).toBeGreaterThanOrEqual(25);
    for (const value of f.contexts) {
      expect(value).toBe(TENANT);
    }
  });

  it('binds the scope tenant into the where clause of every query that has one', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    const withWhere = f.calls.filter((call) => 'where' in call.args);
    expect(withWhere.length).toBeGreaterThanOrEqual(20);

    for (const call of withWhere) {
      const where = show(call.args['where']);
      expect(
        where.includes(TENANT),
        `${call.model}.${call.method} queried without a tenant filter: ${where}`,
      ).toBe(true);
    }
  });

  it('binds the scope tenant into the data of every row it writes', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    const creates = f.calls.filter(
      (call) => call.method === 'create' || call.method === 'createMany',
    );
    expect(creates.length).toBeGreaterThan(0);

    for (const call of creates) {
      const data = show(call.args['data']);
      expect(
        data.includes(TENANT),
        `${call.model}.${call.method} wrote a row with no tenant: ${data}`,
      ).toBe(true);
    }
  });

  it('never updates or deletes a row by primary key alone', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    // `update` and `delete` take a unique selector, which cannot carry a
    // tenant filter alongside it — an id from another tenant would be written.
    // `updateMany` can, and is what the repositories use.
    for (const call of f.calls) {
      expect([call.model, call.method]).not.toContain('update');
      expect([call.model, call.method]).not.toContain('delete');
      expect([call.model, call.method]).not.toContain('deleteMany');
    }
  });

  it('takes no tenant id from anywhere but the scope', async () => {
    // Each repository method's arguments are ids, codes and values — never a
    // tenant. The only tenant that can reach a query is the scope's.
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    for (const call of f.calls) {
      const rendered = show(call.args);
      expect(rendered).not.toContain(OTHER_TENANT);
    }
  });

  it('reads a product with all of its barcodes', async () => {
    const f = fake({ 'product.findFirst': [productRow()] });
    const product = await createProductRepository(f.client).findById(scope, 'p1');

    expect(product?.primaryBarcode).toBe('6281000000001');
    expect(product?.barcodes).toEqual(['6281000000001', '6281000000002']);
    expect(product?.priceMinor).toBe('1150');
    expect(product?.vatBasisPoints).toBe(basisPoints(1500));
  });

  it('scopes a barcode lookup to the tenant, because barcodes are not globally unique', async () => {
    const f = fake({ 'product.findFirst': [productRow()] });
    await createProductRepository(f.client).findByBarcode(scope, '6281000000001');

    const call = f.calls.find((candidate) => candidate.model === 'product');
    const where = show(call?.args['where']);
    expect(where).toContain('6281000000001');
    expect(where).toContain(TENANT);
  });

  it('refuses a row belonging to another tenant instead of returning it', async () => {
    // Under RLS this row cannot reach us. If it ever does, the boundary is
    // broken, and returning it would be a cross-tenant leak.
    const f = fake({ 'branch.findFirst': [branchRow(OTHER_TENANT)] });
    await expect(createBranchRepository(f.client).findById(scope, 'b1')).rejects.toThrow(
      /another tenant/i,
    );
  });

  it('rejects a malformed tenant id before it reaches a query', async () => {
    const f = fake();
    const bad: TenantScope = { tenantId: tenantId('not-a-uuid') };
    await expect(createBranchRepository(f.client).list(bad)).rejects.toThrow(/tenant UUID/i);
    expect(f.calls).toHaveLength(0);
  });
});

describe('writes that must be atomic', () => {
  function saleInput(): RecordSaleInput {
    return {
      sale: {
        id: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
        branchId: 'b1',
        terminalId: 't1',
        shiftId: 's1',
        userId: 'u1',
        customerId: null,
        operationId: 'op-1',
        status: 'finalized',
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        grossMinor: '1150',
        lineDiscountMinor: '0',
        basketDiscountMinor: '0',
        netMinor: '1000',
        vatMinor: '150',
        totalMinor: '1150',
        tenderedMinor: '2000',
        changeMinor: '850',
        issuedAt: AT,
        lines: [
          {
            id: 'l1',
            lineNumber: 1,
            productId: 'p1',
            sku: 'SKU-1',
            nameAr: 'حليب',
            nameEn: 'Milk',
            productType: 'unit',
            unitPriceMinor: '1150',
            vatBasisPoints: basisPoints(1500),
            quantityScaled: '1000',
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
          // Cash carries no scheme, and the record type now says so.
          {
            id: 'te1',
            kind: 'cash',
            scheme: null,
            amountMinor: '2000',
            changeMinor: '850',
            reference: null,
          },
        ],
      },
      invoice: {
        id: '018f3a1c-9b2e-7c4d-8e5f-0000000000aa',
        saleId: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
        invoiceType: 'simplified',
        sellerName: 'متجر كورفي',
        sellerVatNumber: '300000000000003',
        buyerName: null,
        buyerVatNumber: null,
        netMinor: '1000',
        vatMinor: '150',
        totalMinor: '1150',
        currency: 'SAR',
        issuedAt: AT,
        taxBreakdown: [{ vatBasisPoints: basisPoints(1500), netMinor: '1000', vatMinor: '150' }],
      },
      inventory: [
        {
          id: 'm1',
          branchId: 'b1',
          productId: 'p1',
          kind: 'sale',
          quantityScaled: '-1000',
          reason: null,
          sourceType: 'sale',
          sourceId: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
          actorUserId: 'u1',
          occurredAt: AT,
        },
      ],
      cashMovement: {
        id: 'cm1',
        shiftId: 's1',
        kind: 'sale',
        amountMinor: '1150',
        reason: null,
        actorUserId: 'u1',
        occurredAt: AT,
      },
      idempotency: { id: 'ik1', scope: 'checkout', operationId: 'op-1', requestHash: 'abc' },
    };
  }

  const saleRow: Record<string, unknown> = {
    id: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
    tenantId: TENANT,
    branchId: 'b1',
    terminalId: 't1',
    shiftId: 's1',
    userId: 'u1',
    customerId: null,
    operationId: 'op-1',
    status: 'finalized',
    sequence: 12,
    priceMode: 'tax-inclusive',
    currency: 'SAR',
    grossMinor: 1150n,
    lineDiscountMinor: 0n,
    basketDiscountMinor: 0n,
    netMinor: 1000n,
    vatMinor: 150n,
    totalMinor: 1150n,
    tenderedMinor: 2000n,
    changeMinor: 850n,
    issuedAt: new Date(AT),
    lines: [],
    discounts: [],
    tenders: [],
  };

  it('writes the sale, its invoice, its stock and its cash in one transaction', async () => {
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    // One context statement means one transaction: a crash cannot leave an
    // invoice without its sale, or stock consumed by a sale that never was.
    expect(f.contexts).toEqual([TENANT]);

    const touched = f.calls.map((call) => `${call.model}.${call.method}`);
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
    expect(f.raw.some((sql) => sql.includes('"idempotency_keys"'))).toBe(true);
    expect(f.raw.some((sql) => sql.includes('"inventory_balances"'))).toBe(true);
  });

  it('reserves the operation id in the same transaction as the sale', async () => {
    // The unique index is what makes a retry collide instead of ringing up a
    // second sale; reserving in a separate transaction would leave a window.
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    const reservation = f.raw.find((sql) => sql.includes('"idempotency_keys"'));
    expect(reservation).toBeDefined();
    expect(reservation).toContain('op-1');
    expect(reservation).toContain('checkout');
    expect(reservation).toContain(TENANT);
    // Losing the race has to be a defined outcome the service can map, not a
    // raw unique-constraint violation on its way to the client.
    expect(reservation).toContain('ON CONFLICT');
    expect(reservation).toContain('DO NOTHING');
  });

  it('moves stock by a guarded UPDATE rather than a read-modify-write', async () => {
    // Two terminals selling the last unit would both read 1 and both write 0.
    // The predicate is evaluated after the row lock is taken, so the loser
    // matches nothing and its whole transaction goes back.
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    const update = f.raw.find((sql) => sql.includes('"inventory_balances"'));
    expect(update).toBeDefined();
    expect(update).toContain('UPDATE');
    expect(update).toContain('>= 0');
  });

  it('allocates the receipt number itself, under the branch row lock', async () => {
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

  it('reads the finalized sale back with money as strings', async () => {
    const f = fake({ 'sale.findFirst': [saleRow] });
    const sale = await createSaleRepository(f.client).record(scope, saleInput());

    expect(sale.totalMinor).toBe('1150');
    expect(sale.changeMinor).toBe('850');
    expect(sale.issuedAt).toBe(AT);
  });

  it('refuses to open a second shift on a till that already has one', async () => {
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
    expect(f.raw.some((sql) => sql.includes('"terminals"') && sql.includes('FOR UPDATE'))).toBe(
      true,
    );
  });

  it('refuses to close a shift that is not open', async () => {
    const f = fake({ 'shift.updateMany': [{ count: 0 }] });
    await expect(
      createShiftRepository(f.client).close(scope, {
        shiftId: 's1',
        declaredCashMinor: '31150',
        expectedCashMinor: '31000',
        varianceMinor: '150',
        closedAt: AT,
      }),
    ).rejects.toThrow(/not open/i);
  });

  it('refuses a cash movement against a closed shift', async () => {
    const f = fake({ 'shift.findFirst': [{ id: 's1', tenantId: TENANT, status: 'closed' }] });
    await expect(
      createShiftRepository(f.client).recordCashMovement(scope, {
        id: 'cm2',
        shiftId: 's1',
        kind: 'pay-out',
        amountMinor: '-5000',
        reason: 'مصروف',
        actorUserId: 'u1',
        occurredAt: AT,
      }),
    ).rejects.toThrow(/closed shift/i);
  });
});
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/__tests__/support/memory-business.ts
import { basisPoints, tenantId as brandTenantId } from '@korvi/domain';
import {
  InsufficientStockError,
  OperationAlreadyRecordedError,
  ReturnNotAllowedError,
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
  RecordReturnInput,
  RecordSaleInput,
  ReturnRecord,
  ReturnRepository,
  ReturnableSale,
  ReturnableSaleLine,
  SaleLookupQuery,
  SaleLookupRow,
  SaleRecord,
  SaleRepository,
  ShiftRecord,
  ShiftRepository,
  Tenant,
  DashboardRepository,
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
  public returns: ReturnRecord[] = [];
  public movements: (InventoryMovementInput & { tenantId: string })[] = [];
  public keys: IdempotencyRecord[] = [];
  /** Drawer effects, so a test can prove what a split payment did to the till. */
  public cashMovements: { kind: string; amountMinor: string; shiftId: string }[] = [];
  public audit: AuditEventInput[] = [];
  /** Opening-float movement ids, so a test can prove none was written. */
  public openingMovements: string[] = [];
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

/**
 * The dashboard, counted from the same store the rest of these fakes use.
 *
 * Deliberately derived rather than stubbed: a test that asserts a hardcoded
 * total proves the assertion, not the aggregate.
 */
export function memoryDashboardRepository(store: MemoryBusinessStore): DashboardRepository {
  return {
    summary: (scope, since) => {
      const tenant = scopeId(scope);
      const from = Date.parse(since);
      const sales = store.sales.filter(
        (sale) =>
          (sale.tenantId as string) === tenant &&
          sale.status === 'finalized' &&
          Date.parse(sale.issuedAt) >= from,
      );
      const sum = (pick: (sale: (typeof sales)[number]) => string): string =>
        sales.reduce((total, sale) => total + BigInt(pick(sale)), 0n).toString();

      return Promise.resolve({
        activeProductCount: store.products.filter(
          (product) => (product.tenantId as string) === tenant && product.isActive,
        ).length,
        terminalCount: store.terminals.filter(
          (terminal) => (terminal.tenantId as string) === tenant && terminal.isActive,
        ).length,
        openShiftCount: store.shifts.filter(
          (shift) => (shift.tenantId as string) === tenant && shift.status === 'open',
        ).length,
        salesLast24HoursCount: sales.length,
        grossSalesLast24HoursMinor: sum((sale) => sale.totalMinor),
        vatLast24HoursMinor: sum((sale) => sale.vatMinor),
        currency:
          store.settings.find((entry) => (entry.tenantId as string) === tenant)?.currency ?? 'SAR',
        since,
      });
    },
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
      store.openingMovements.push(input.openingMovementId);
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
      if (input.cashMovement !== null) {
        store.cashMovements.push({
          kind: input.cashMovement.kind,
          amountMinor: input.cashMovement.amountMinor,
          shiftId: input.cashMovement.shiftId,
        });
      }
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

/**
 * Returns, over the same store.
 *
 * The two properties the route tests depend on are the ones a looser fake
 * would hide: the plan is computed from the state this store actually holds
 * (so a second partial return sees what the first one took), and `record` is
 * all-or-nothing. Concurrency is not modelled here and cannot be — that is
 * what the live PostgreSQL suite is for.
 */
export function memoryReturnRepository(store: MemoryBusinessStore): ReturnRepository {
  const stateFor = (
    scope: TenantScope,
    branchId: string | null,
    saleId: string,
  ): ReturnableSale | null => {
    const sale = store.sales.find(
      (row) =>
        row.id === saleId &&
        (row.tenantId as string) === scopeId(scope) &&
        (branchId === null || row.branchId === branchId),
    );
    if (sale === undefined) return null;

    const mine = store.returns.filter(
      (row) =>
        row.saleId === saleId &&
        (row.tenantId as string) === scopeId(scope) &&
        row.status === 'finalized',
    );
    const invoice = store.invoices.find(
      (row) => row.saleId === saleId && (row.tenantId as string) === scopeId(scope),
    );

    let refundedTotal = 0n;
    const lines: ReturnableSaleLine[] = sale.lines.map((line) => {
      const prior = mine.flatMap((row) => row.lines).filter((row) => row.saleLineId === line.id);
      const sum = (pick: (row: (typeof prior)[number]) => string): bigint =>
        prior.reduce((total, row) => total + BigInt(pick(row)), 0n);
      const returned = sum((row) => row.quantityScaled);
      refundedTotal += sum((row) => row.totalMinor);
      const remaining = BigInt(line.quantityScaled) - returned;
      return {
        saleLineId: line.id,
        lineNumber: line.lineNumber,
        productId: line.productId,
        sku: line.sku,
        nameAr: line.nameAr,
        nameEn: line.nameEn,
        productType: line.productType,
        vatBasisPoints: line.vatBasisPoints,
        unitPriceMinor: line.unitPriceMinor,
        soldQuantityScaled: line.quantityScaled,
        returnedQuantityScaled: returned.toString(),
        remainingQuantityScaled: (remaining > 0n ? remaining : 0n).toString(),
        grossMinor: line.grossMinor,
        lineDiscountMinor: line.lineDiscountMinor,
        basketDiscountMinor: line.basketDiscountMinor,
        netMinor: line.netMinor,
        vatMinor: line.vatMinor,
        totalMinor: line.totalMinor,
        refundedGrossMinor: sum((row) => row.grossMinor).toString(),
        refundedNetMinor: sum((row) => row.netMinor).toString(),
        refundedLineDiscountMinor: sum((row) => row.lineDiscountMinor).toString(),
        refundedBasketDiscountMinor: sum((row) => row.basketDiscountMinor).toString(),
        refundedVatMinor: sum((row) => row.vatMinor).toString(),
      };
    });

    return {
      saleId: sale.id,
      branchId: sale.branchId,
      status: sale.status,
      invoiceNumber: invoice?.invoiceNumber ?? null,
      currency: sale.currency,
      issuedAt: sale.issuedAt,
      netMinor: sale.netMinor,
      vatMinor: sale.vatMinor,
      totalMinor: sale.totalMinor,
      refundedTotalMinor: refundedTotal.toString(),
      lines,
    };
  };

  return {
    findById: (scope, id) =>
      Promise.resolve(
        store.returns.find((row) => row.id === id && (row.tenantId as string) === scopeId(scope)) ??
          null,
      ),

    findByOperationId: (scope, operationId) =>
      Promise.resolve(
        store.returns.find(
          (row) => row.operationId === operationId && (row.tenantId as string) === scopeId(scope),
        ) ?? null,
      ),

    returnableForSale: (scope, branchId, saleId) =>
      Promise.resolve(stateFor(scope, branchId, saleId)),

    lookupSales: (scope, query: SaleLookupQuery) => {
      const term = query.term.trim();
      const rows: SaleLookupRow[] = store.sales
        .filter(
          (sale) =>
            (sale.tenantId as string) === scopeId(scope) &&
            sale.branchId === query.branchId &&
            sale.status === 'finalized',
        )
        .filter((sale) => {
          const invoice = store.invoices.find((row) => row.saleId === sale.id);
          return (
            invoice?.invoiceNumber === term || String(sale.sequence) === term || sale.id === term
          );
        })
        .slice(0, Math.min(query.limit, 25))
        .map((sale) => {
          const refunded = store.returns
            .filter((row) => row.saleId === sale.id && row.status === 'finalized')
            .reduce((total, row) => total + BigInt(row.totalMinor), 0n);
          const invoice = store.invoices.find((row) => row.saleId === sale.id);
          return {
            saleId: sale.id,
            invoiceNumber: invoice?.invoiceNumber ?? null,
            sequence: sale.sequence,
            issuedAt: sale.issuedAt,
            currency: sale.currency,
            totalMinor: sale.totalMinor,
            refundedTotalMinor: refunded.toString(),
            fullyReturned: refunded >= BigInt(sale.totalMinor),
          };
        });
      return Promise.resolve(rows);
    },

    record: (scope: TenantScope, input: RecordReturnInput) => {
      const state = stateFor(scope, input.branchId, input.saleId);
      if (state === null) throw new ReturnNotAllowedError('unknown-sale');
      if (state.status !== 'finalized') throw new ReturnNotAllowedError('sale-not-finalized');

      const shift = store.shifts.find(
        (row) => row.id === input.shiftId && (row.tenantId as string) === scopeId(scope),
      );
      if (shift === undefined || shift.status !== 'open') {
        throw new ShiftUnusableError('shift-closed');
      }
      if (shift.userId !== input.actorUserId) throw new ShiftUnusableError('cashier-mismatch');

      if (
        store.keys.some(
          (key) =>
            (key.tenantId as string) === scopeId(scope) &&
            key.scope === input.idempotency.scope &&
            key.operationId === input.operationId,
        )
      ) {
        throw new OperationAlreadyRecordedError(input.operationId);
      }

      // Thrown before anything is written, exactly as the real adapter does it.
      const plan = input.plan(state);

      const sequence =
        store.returns.filter(
          (row) => (row.tenantId as string) === scopeId(scope) && row.branchId === input.branchId,
        ).length + 1;

      const record: ReturnRecord = {
        id: input.returnId,
        tenantId: brandTenantId(scopeId(scope)),
        saleId: input.saleId,
        branchId: input.branchId,
        terminalId: input.terminalId,
        shiftId: input.shiftId,
        actorUserId: input.actorUserId,
        operationId: input.operationId,
        status: 'finalized',
        sequence,
        returnNumber: `R-01-${String(sequence).padStart(6, '0')}`,
        reason: input.reason,
        currency: input.currency,
        grossMinor: plan.grossMinor,
        lineDiscountMinor: plan.lineDiscountMinor,
        basketDiscountMinor: plan.basketDiscountMinor,
        netMinor: plan.netMinor,
        vatMinor: plan.vatMinor,
        totalMinor: plan.totalMinor,
        issuedAt: input.issuedAt,
        lines: plan.lines.map((line, index) => ({
          id: input.lineIds[index] ?? `line-${String(index)}`,
          lineNumber: line.lineNumber,
          saleLineId: line.saleLineId,
          productId: line.productId,
          sku: line.sku,
          nameAr: line.nameAr,
          nameEn: line.nameEn,
          productType: line.productType,
          vatBasisPoints: line.vatBasisPoints,
          quantityScaled: line.quantityScaled,
          grossMinor: line.grossMinor,
          lineDiscountMinor: line.lineDiscountMinor,
          basketDiscountMinor: line.basketDiscountMinor,
          netMinor: line.netMinor,
          vatMinor: line.vatMinor,
          totalMinor: line.totalMinor,
        })),
        refund: {
          id: input.refund.id,
          kind: input.refund.kind,
          scheme: input.refund.scheme,
          // Server-derived, always.
          amountMinor: plan.totalMinor,
          reference: input.refund.reference,
          issuedAt: input.issuedAt,
        },
      };

      store.returns.push(record);
      store.keys.push({
        id: input.idempotency.id,
        tenantId: brandTenantId(scopeId(scope)),
        scope: input.idempotency.scope,
        operationId: input.operationId,
        status: 'completed',
        resultType: 'return',
        resultId: input.returnId,
        requestHash: input.idempotency.requestHash,
        completedAt: input.issuedAt,
      });

      let movement = 0;
      for (const line of plan.lines) {
        const consumed = store.movements.some(
          (row) =>
            row.sourceType === 'sale' &&
            row.sourceId === input.saleId &&
            row.productId === line.productId,
        );
        if (line.productId === null || !consumed) continue;
        store.movements.push({
          id: input.inventoryIds[movement] ?? `mv-${String(movement)}`,
          tenantId: scopeId(scope),
          branchId: input.branchId,
          productId: line.productId,
          kind: 'return',
          quantityScaled: line.quantityScaled,
          reason: null,
          sourceType: 'return',
          sourceId: input.returnId,
          actorUserId: input.actorUserId,
          occurredAt: input.issuedAt,
        });
        movement += 1;
      }

      if (input.refund.kind === 'cash') {
        store.cashMovements.push({
          kind: 'refund',
          amountMinor: (-BigInt(plan.totalMinor)).toString(),
          shiftId: input.shiftId,
        });
      }

      return Promise.resolve(record);
    },
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
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/__tests__/business-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { createCheckoutService } from '../checkout/service.js';
import { createReturnService } from '../returns/service.js';
import {
  MemoryAuthStore,
  memoryAuditRepository as memoryAuthAudit,
  memoryAuthRepository,
} from './support/memory-auth.js';
import {
  MemoryBusinessStore,
  memoryAuditRepository,
  memoryDashboardRepository,
  memoryIdempotencyRepository,
  memoryInventoryRepository,
  memoryProductRepository,
  memoryReturnRepository,
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
  auth.memberships.push({
    tenantId: A.tenant,
    userId: A.user,
    status: 'active',
    defaultBranchId: A.branch,
  });
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
      tenants: memoryTenantRepository(business),
      dashboard: memoryDashboardRepository(business),
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
      returns: createReturnService({
        returns: memoryReturnRepository(business),
        terminals: memoryTerminalRepository(business),
        shifts: memoryShiftRepository(business),
        idempotency: memoryIdempotencyRepository(business),
        audit: memoryAuditRepository(business),
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

describe('GET /v1/dashboard/summary', () => {
  it('refuses without a session', async () => {
    app = await build('cashier');
    const response = await app.inject({ method: 'GET', url: '/v1/dashboard/summary' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a cashier, who does not hold report.read', async () => {
    app = await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    // Nothing about the tenant leaks through a refusal.
    expect(response.payload).not.toContain('grossSales');
  });

  it('answers a manager with real, tenant-scoped figures', async () => {
    app = await build('manager');
    const cookie = await cookieFor(app);

    const sale = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: { cookie, origin: ORIGIN },
      payload: {
        operationId: '018f2000-0000-7000-8000-0000000000c1',
        terminalId: A.terminal,
        cashReceivedMinor: '5000',
        lines: [{ productId: A.milk, quantityScaled: '2000' }],
      },
    });
    expect(sale.statusCode).toBe(201);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<Record<string, unknown>>();
    // 2 x 11.50 tax-inclusive: 23.00 with 3.00 of VAT. Counted, not guessed.
    expect(body['salesLast24HoursCount']).toBe(1);
    expect(body['grossSalesLast24HoursMinor']).toBe('2300');
    expect(body['vatLast24HoursMinor']).toBe('300');
    expect(body['openShiftCount']).toBe(1);
    expect(body['terminalCount']).toBe(1);
    expect(body['activeProductCount']).toBe(2);
    expect(body['currency']).toBe('SAR');
  });

  it('keeps money as a string, never a JSON number', async () => {
    // A JSON number loses halalas past 2^53 and rounds on the way in. The
    // aggregate crosses as a decimal string exactly like every other amount.
    app = await build('manager');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary',
      headers: { cookie },
    });
    const body = response.json<Record<string, unknown>>();
    expect(typeof body['grossSalesLast24HoursMinor']).toBe('string');
    expect(typeof body['vatLast24HoursMinor']).toBe('string');
  });

  it('counts nothing belonging to another tenant', async () => {
    // The repository takes a scope and has no parameter that could widen it;
    // this proves the route does not widen it either.
    app = await build('manager');
    business.sales.push({
      ...(business.sales[0] ?? ({} as (typeof business.sales)[number])),
      id: '018f2000-0000-7000-8000-0000000000c9',
      tenantId:
        '018f2000-0000-7000-8000-00000000000b' as (typeof business.sales)[number]['tenantId'],
      status: 'finalized',
      totalMinor: '999999',
      vatMinor: '99999',
      issuedAt: new Date().toISOString(),
    });

    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary',
      headers: { cookie },
    });
    const body = response.json<Record<string, unknown>>();
    expect(body['grossSalesLast24HoursMinor']).toBe('0');
    expect(body['salesLast24HoursCount']).toBe(0);
  });
});

describe('branch authorisation', () => {
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
      label: '\u0635\u0646\u062f\u0648\u0642 \u0641\u0631\u0639 \u0622\u062e\u0631',
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

  it('answers for the cashier\u2019s own till', async () => {
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

  it('will not read a shift on another branch\u2019s till, and leaks nothing about it', async () => {
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

  it('will not open a shift on another branch\u2019s till', async () => {
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
    expect(
      business.shifts.some(
        (shift) => shift.terminalId === OTHER_TERMINAL && shift.branchId === A.branch,
      ),
    ).toBe(false);
    expect(business.openingMovements).toHaveLength(0);
  });

  it('still opens a shift on the cashier\u2019s own till', async () => {
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

  it('refuses a deactivated till in the cashier\u2019s own branch', async () => {
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
      const response = await app.inject({
        method: 'GET',
        url: '/v1/terminals',
        headers: { cookie },
      });
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

describe('GET /v1/terminals', () => {
  it('refuses without a session', async () => {
    app = await build('cashier');
    const response = await app.inject({ method: 'GET', url: '/v1/terminals' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the active tills of the session\u2019s own branch', async () => {
    app = await build('cashier');
    business.terminals.push({
      id: '018f2000-0000-7000-8000-0000000000b1',
      tenantId: business.terminals[0]!.tenantId,
      branchId: A.branch,
      code: '02',
      label: '\u0635\u0646\u062f\u0648\u0642 \u0662',
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
      label: '\u0641\u0631\u0639 \u0622\u062e\u0631',
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

  it('carries the tenant’s price mode so the till never guesses it', async () => {
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
    expect(response.json<{ settings: { priceMode: string; currency: string } }>().settings).toEqual(
      {
        priceMode: 'tax-inclusive',
        currency: 'SAR',
      },
    );
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

describe('POST /v1/sales — the drawer', () => {
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
      tenders: [{ kind: 'electronic', scheme: 'visa', reference: 'AUTH-4', amountMinor: '2300' }],
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
        tenders: [{ kind: 'electronic', scheme: 'mada', reference: '004512', amountMinor: '2300' }],
      },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('POST /v1/sales — settlement', () => {
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
    expect(
      body.sale.tenders.map((tender) => [tender.kind, tender.scheme, tender.amountMinor]),
    ).toEqual([
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
      tenders: [{ kind: 'electronic', scheme: 'visa', reference: 'AUTH-1', amountMinor: '2400' }],
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
    [
      'two cash lines',
      [
        { kind: 'cash', amountMinor: '1200' },
        { kind: 'cash', amountMinor: '1200' },
      ],
    ],
    [
      'a repeated approval',
      [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-1', amountMinor: '1150' },
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-1', amountMinor: '1150' },
      ],
    ],
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
      tenders: [{ kind: 'electronic', scheme: 'mada', reference: 'AUTH-2', amountMinor: '2300' }],
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

  function discounted(server: FastifyInstance, cookie: string, overrides: Record<string, unknown>) {
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
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/__tests__/checkout-live.test.ts
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
        data: {
          id: T.branch,
          tenantId: T.tenant,
          code: '01',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
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
    if (first.outcome !== 'success' || second.outcome !== 'success')
      throw new Error('expected success');

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
            productType: 'unit',
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
          {
            id: newId(),
            kind: 'cash',
            scheme: null,
            amountMinor: '1150',
            changeMinor: '0',
            reference: null,
          },
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
        data: {
          id: C.branch,
          tenantId: C.tenant,
          code: '09',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
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
      sales.record(
        scope,
        recordInput({ saleId, productId: product, operationId, quantityScaled: '1000' }),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    const left = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { tenantId: C.tenant, id: saleId } }),
      keys: await tx.idempotencyKey.count({ where: { tenantId: C.tenant, operationId } }),
      movements: await tx.inventoryMovement.count({
        where: { tenantId: C.tenant, productId: product },
      }),
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
      sales.record(
        scope,
        recordInput({ saleId, productId: ghost, operationId, quantityScaled: '1000' }),
      ),
    ).rejects.toThrow();

    const survivors = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { tenantId: C.tenant, id: saleId } }),
      lines: await tx.saleLine.count({ where: { tenantId: C.tenant, saleId } }),
      invoices: await tx.invoice.count({ where: { tenantId: C.tenant, saleId } }),
      tenders: await tx.tender.count({ where: { tenantId: C.tenant, saleId } }),
      movements: await tx.inventoryMovement.count({
        where: { tenantId: C.tenant, sourceId: saleId },
      }),
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
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/__tests__/settlement-live.test.ts
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
        data: {
          id: S.branch,
          tenantId: S.tenant,
          code: '05',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
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
        {
          kind: 'electronic' as const,
          scheme: 'visa' as const,
          reference: 'AUTH-LIVE-2',
          amountMinor: '1150',
        },
      ],
    };
    const first = await service.checkout(request);
    const second = await service.checkout(request);
    if (first.outcome !== 'success' || second.outcome !== 'success')
      throw new Error('expected success');

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
            productType: 'unit',
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
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/__tests__/returns-routes.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { createCheckoutService } from '../checkout/service.js';
import { createReturnService } from '../returns/service.js';
import {
  MemoryAuthStore,
  memoryAuditRepository as memoryAuthAudit,
  memoryAuthRepository,
} from './support/memory-auth.js';
import {
  MemoryBusinessStore,
  memoryAuditRepository,
  memoryDashboardRepository,
  memoryIdempotencyRepository,
  memoryInventoryRepository,
  memoryProductRepository,
  memoryReturnRepository,
  memorySaleRepository,
  memoryShiftRepository,
  memoryTenantRepository,
  memoryTerminalRepository,
  seedStore,
} from './support/memory-business.js';
import type { Fixture } from './support/memory-business.js';
import type { RoleName } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

/**
 * The return surface, over a real Fastify instance.
 *
 * What is being defended here is not arithmetic — the domain suite does that —
 * but authority. Every one of these asks the same question from a different
 * angle: can the browser decide something it has no standing to decide? The
 * branch, the drawer, the operator, the price, the VAT and the refund total
 * are all server facts, and a request that names one is refused rather than
 * quietly ignored.
 */

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-real-password-9!';

const A: Fixture = {
  tenant: '018f3000-0000-7000-8000-00000000000a',
  branch: '018f3000-0000-7000-8000-0000000000a1',
  terminal: '018f3000-0000-7000-8000-0000000000a2',
  shift: '018f3000-0000-7000-8000-0000000000a3',
  user: '018f3000-0000-7000-8000-0000000000a4',
  milk: '018f3000-0000-7000-8000-0000000000a5',
  rice: '018f3000-0000-7000-8000-0000000000a6',
};

/** A till in the same tenant but another branch. Never this session's. */
const FOREIGN_TERMINAL = '018f3000-0000-7000-8000-0000000000b2';
const FOREIGN_BRANCH = '018f3000-0000-7000-8000-0000000000b1';

let app: FastifyInstance;
let business: MemoryBusinessStore;
let auth: MemoryAuthStore;
let ids = 0;

function nextId(): string {
  ids += 1;
  return `018f3000-0000-7000-8000-${String(ids).padStart(12, '0')}`;
}

async function build(
  role: RoleName,
  options: { openShift?: boolean; branch?: string | null } = {},
) {
  const { openShift = true, branch = A.branch } = options;
  ids = 0;
  business = new MemoryBusinessStore();
  seedStore(business, A, openShift);

  // A second till, in a branch this session is not pinned to.
  business.terminals.push({
    id: FOREIGN_TERMINAL,
    tenantId: business.terminals[0]?.tenantId ?? business.tenants[0]!.id,
    branchId: FOREIGN_BRANCH,
    code: '09',
    label: 'صندوق فرع آخر',
    isActive: true,
    lastSeenAt: null,
  });

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
  auth.memberships.push({
    tenantId: A.tenant,
    userId: A.user,
    status: 'active',
    defaultBranchId: branch,
  });
  auth.grants.push({
    tenantId: A.tenant,
    userId: A.user,
    roles: [role],
    permissions: [...ROLE_PERMISSIONS[role]],
  });

  const server = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: createAuthService({
      repository: memoryAuthRepository(auth),
      audit: memoryAuthAudit(auth),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    }),
    business: {
      tenants: memoryTenantRepository(business),
      dashboard: memoryDashboardRepository(business),
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
        newId: nextId,
      }),
      returns: createReturnService({
        returns: memoryReturnRepository(business),
        terminals: memoryTerminalRepository(business),
        shifts: memoryShiftRepository(business),
        idempotency: memoryIdempotencyRepository(business),
        audit: memoryAuditRepository(business),
        newId: nextId,
      }),
    },
  });
  await server.ready();
  app = server;
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

interface SoldSale {
  readonly saleId: string;
  readonly lineId: string;
  readonly totalMinor: string;
}

/** Ring up three cartons of milk, so there is something to send back. */
async function sell(cookie: string, quantityScaled = '3000'): Promise<SoldSale> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/sales',
    headers: { cookie, origin: ORIGIN },
    payload: {
      operationId: nextId(),
      terminalId: A.terminal,
      cashReceivedMinor: '10000',
      lines: [{ productId: A.milk, quantityScaled }],
    },
  });
  expect(response.statusCode).toBe(201);
  const body = JSON.parse(response.payload) as {
    sale: { saleId: string; totalMinor: string };
  };
  const stored = business.sales.find((sale) => sale.id === body.sale.saleId);
  expect(stored).toBeDefined();
  return {
    saleId: body.sale.saleId,
    lineId: stored!.lines[0]!.id,
    totalMinor: body.sale.totalMinor,
  };
}

function returnPayload(sale: SoldSale, overrides: Record<string, unknown> = {}) {
  return {
    operationId: nextId(),
    terminalId: A.terminal,
    saleId: sale.saleId,
    refund: { kind: 'cash' },
    lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
    ...overrides,
  };
}

afterEach(async () => {
  await app.close();
});

describe('who may return anything', () => {
  it('refuses an anonymous request', async () => {
    await build('manager');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { origin: ORIGIN },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a cashier, who does not hold sale.refund', async () => {
    await build('cashier');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(ROLE_PERMISSIONS.cashier).not.toContain('sale.refund');
  });

  it('refuses a manager with no branch to act in', async () => {
    await build('manager', { branch: null });
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sales/lookup?q=1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error).toBe('branch_required');
  });
});

describe('a return the server accepts', () => {
  it('refunds one of three, from the sale and not the catalogue', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    // The price triples after the sale. Nothing about the refund may change.
    const index = business.products.findIndex((row) => row.id === A.milk);
    business.products[index] = { ...business.products[index]!, priceMinor: '3450' };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload) as {
      return: {
        returnNumber: string;
        totalMinor: string;
        netMinor: string;
        vatMinor: string;
        refund: { kind: string; amountMinor: string; reference: string | null };
        lines: { quantityScaled: string; totalMinor: string }[];
      };
      replayed: boolean;
    };

    expect(body.replayed).toBe(false);
    expect(body.return.returnNumber).toBe('R-01-000001');
    // One carton of 1150 including 15% VAT: a third of a 3450 line.
    expect(body.return.totalMinor).toBe('1150');
    expect(BigInt(body.return.netMinor) + BigInt(body.return.vatMinor)).toBe(1150n);
    expect(body.return.refund.kind).toBe('cash');
    expect(body.return.refund.amountMinor).toBe('1150');
    expect(body.return.refund.reference).toBeNull();
    expect(body.return.lines).toHaveLength(1);
  });

  it('takes the cash out of the open drawer, once', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    const refunds = business.cashMovements.filter((row) => row.kind === 'refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountMinor).toBe('-1150');
    expect(refunds[0]!.shiftId).toBe(A.shift);
  });

  it('puts the stock back, once, because the sale took it out', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    const reversals = business.movements.filter((row) => row.sourceType === 'return');
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.quantityScaled).toBe('1000');
    expect(reversals[0]!.kind).toBe('return');
  });

  it('records an electronic refund against its external approval, and moves no cash', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        refund: { kind: 'electronic', scheme: 'mada', reference: 'AUTH-77120' },
      }),
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload) as {
      return: { refund: { kind: string; scheme: string; reference: string } };
    };
    expect(body.return.refund.kind).toBe('electronic');
    expect(body.return.refund.scheme).toBe('mada');
    expect(body.return.refund.reference).toBe('AUTH-77120');
    expect(business.cashMovements.filter((row) => row.kind === 'refund')).toHaveLength(0);
  });

  it('answers a replay with the same document and creates nothing', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);
    const payload = returnPayload(sale);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.payload).replayed).toBe(true);
    expect(JSON.parse(second.payload).return.returnId).toBe(
      JSON.parse(first.payload).return.returnId,
    );
    expect(business.returns).toHaveLength(1);
  });

  it('refuses the same operation id carrying different intent', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);
    const payload = returnPayload(sale);

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload,
    });
    const conflicting = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: { ...payload, lines: [{ saleLineId: sale.lineId, quantityScaled: '2000' }] },
    });

    expect(conflicting.statusCode).toBe(409);
    expect(JSON.parse(conflicting.payload).error).toBe('idempotency-conflict');
    expect(business.returns).toHaveLength(1);
  });
});

describe('what the browser may not decide', () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ['a refund total', { refundTotalMinor: '9999' }],
    ['a price', { unitPriceMinor: '1' }],
    ['a VAT figure', { vatMinor: '0' }],
    ['a branch', { branchId: '018f3000-0000-7000-8000-0000000000b1' }],
    ['a shift', { shiftId: '018f3000-0000-7000-8000-0000000000a3' }],
    ['a cashier', { userId: '018f3000-0000-7000-8000-0000000000a4' }],
    ['a return number', { returnNumber: 'R-01-000009' }],
  ];

  for (const [what, extra] of cases) {
    it(`refuses ${what} by name`, async () => {
      await build('manager');
      const cookie = await cookieFor(app);
      const sale = await sell(cookie);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/returns',
        headers: { cookie, origin: ORIGIN },
        payload: returnPayload(sale, extra),
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).error).toBe('forbidden_field');
      expect(business.returns).toHaveLength(0);
    });
  }

  it('refuses a card number hiding in the refund reference', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        refund: { kind: 'electronic', scheme: 'visa', reference: '4111111111111111' },
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toBe('card_data_refused');
    // The refusal does not echo the number back into a log or a response body.
    expect(response.payload).not.toContain('4111');
  });
});

describe('which sale, and whose till', () => {
  it('says nothing about a till in another branch', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, { terminalId: FOREIGN_TERMINAL }),
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload).error).toBe('unknown-terminal');
    expect(response.payload).not.toContain(FOREIGN_BRANCH);
  });

  it('says nothing about a sale that is not this branch’s', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);
    // Move the sale to another branch behind the service's back.
    business.sales[0] = { ...business.sales[0]!, branchId: FOREIGN_BRANCH };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload).error).toBe('sale-not-found');
    expect(response.payload).not.toContain(FOREIGN_BRANCH);
  });

  it('refuses a drawer that belongs to another cashier', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);
    business.shifts[0] = {
      ...business.shifts[0]!,
      userId: '018f3000-0000-7000-8000-0000000000c9',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error).toBe('shift-invalid');
  });

  it('refuses when no shift is open on the till', async () => {
    await build('manager', { openShift: true });
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);
    business.shifts[0] = { ...business.shifts[0]!, status: 'closed' };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error).toBe('no-open-shift');
  });
});

describe('finding the sale and seeing what is left', () => {
  it('finds a sale by its invoice number, bounded', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    await sell(cookie);
    const invoiceNumber = business.invoices[0]!.invoiceNumber;

    const response = await app.inject({
      method: 'GET',
      url: `/v1/sales/lookup?q=${encodeURIComponent(invoiceNumber)}&limit=5`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as {
      sales: { saleId: string; totalMinor: string; fullyReturned: boolean }[];
      limit: number;
    };
    expect(body.limit).toBe(5);
    expect(body.sales).toHaveLength(1);
    expect(body.sales[0]!.fullyReturned).toBe(false);
  });

  it('refuses an unbounded lookup', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sales/lookup?q=1&limit=5000',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('reports what is left after a partial return, per line', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/sales/${sale.saleId}/returnable`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as {
      sale: {
        refundedTotalMinor: string;
        lines: {
          soldQuantityScaled: string;
          returnedQuantityScaled: string;
          remainingQuantityScaled: string;
        }[];
      };
    };
    expect(body.sale.refundedTotalMinor).toBe('1150');
    expect(body.sale.lines[0]!.soldQuantityScaled).toBe('3000');
    expect(body.sale.lines[0]!.returnedQuantityScaled).toBe('1000');
    expect(body.sale.lines[0]!.remainingQuantityScaled).toBe('2000');
  });

  it('tells the truth about a sale with nothing left rather than hiding it', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie, '1000');

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/sales/${sale.saleId}/returnable`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as {
      sale: { lines: { remainingQuantityScaled: string }[] };
    };
    expect(body.sale.lines[0]!.remainingQuantityScaled).toBe('0');
  });

  it('refuses a second return of goods that already came back', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie, '1000');

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale),
    });

    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.payload).error).toBe('nothing-returnable');
    expect(business.returns).toHaveLength(1);
  });

  it('refuses more than the sale has left', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie, '1000');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        lines: [{ saleLineId: sale.lineId, quantityScaled: '2000' }],
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error).toBe('over-return');
    expect(business.returns).toHaveLength(0);
  });

  it('refuses a line that belongs to another sale', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        lines: [{ saleLineId: '018f3000-0000-7000-8000-0000000000f9', quantityScaled: '1000' }],
      }),
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.payload).error).toBe('unknown-sale-line');
  });

  it('refuses a third of a carton of milk', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        lines: [{ saleLineId: sale.lineId, quantityScaled: '333' }],
      }),
    });

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.payload).error).toBe('invalid-return-quantity');
  });

  it('refuses the same line twice in one request, before anything is written', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        lines: [
          { saleLineId: sale.lineId, quantityScaled: '1000' },
          { saleLineId: sale.lineId, quantityScaled: '1000' },
        ],
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(business.returns).toHaveLength(0);
  });
});

describe('the audit trail', () => {
  it('records the return with safe facts and no reference', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const sale = await sell(cookie);

    await app.inject({
      method: 'POST',
      url: '/v1/returns',
      headers: { cookie, origin: ORIGIN },
      payload: returnPayload(sale, {
        refund: { kind: 'electronic', scheme: 'mada', reference: 'AUTH-55501' },
      }),
    });

    const event = business.audit.find((row) => row.eventType === 'sale.returned');
    expect(event).toBeDefined();
    expect(event!.entityType).toBe('return');
    expect(event!.metadata?.refundKind).toBe('electronic');
    expect(event!.metadata?.refundScheme).toBe('mada');
    expect(JSON.stringify(event!.metadata)).not.toContain('AUTH-55501');
  });
});
KORVI_EOF
cat << 'KORVI_EOF' > apps/api/src/__tests__/returns-live.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  assignRole,
  createAuditRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createReturnRepository,
  createSaleRepository,
  createShiftRepository,
  createTenantRepository,
  createTerminalRepository,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  withTenant,
} from '@korvi/database';
import { createCheckoutService } from '../checkout/service.js';
import { createReturnService } from '../returns/service.js';
import type { CheckoutService } from '../checkout/service.js';
import type { ReturnService } from '../returns/service.js';
import type { PrismaClient } from '@korvi/database';
import type { AuthenticatedPrincipal, ReturnRepository, TenantScope } from '@korvi/domain';

/**
 * Returns, against a real PostgreSQL server.
 *
 * The questions here cannot be answered by a fake, because every one of them
 * is about what two transactions do to each other. Whether the last unit of a
 * line can come back twice, whether one operation id can produce two refunds,
 * whether a return number can be issued to a transaction that then rolls back,
 * and whether a failure part-way through leaves stock credited or cash moved.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with
 * every migration applied, connected as the application role — not a
 * superuser, which bypasses RLS and would make the isolation tests pass for
 * the wrong reason.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const R = {
  tenant: '018f6000-0000-7000-8000-00000000000a',
  slug: 'returns-live-a',
  branch: '018f6000-0000-7000-8000-0000000000b1',
  terminal: '018f6000-0000-7000-8000-0000000000c1',
  shift: '018f6000-0000-7000-8000-0000000000d1',
  user: '018f6000-0000-7000-8000-0000000000e1',
  membership: '018f6000-0000-7000-8000-0000000000e2',
  milk: '018f6000-0000-7000-8000-0000000000f1',
  odd: '018f6000-0000-7000-8000-0000000000f2',
  loose: '018f6000-0000-7000-8000-0000000000f3',
} as const;

/** A second merchant, used only to prove it can see nothing of the first. */
const OTHER = {
  tenant: '018f6000-0000-7000-8000-00000000001a',
  slug: 'returns-live-b',
} as const;

describe.skipIf(url === '')('returns, live', () => {
  let prisma: PrismaClient;
  let checkout: CheckoutService;
  let returns: ReturnService;
  let repository: ReturnRepository;
  let principal: AuthenticatedPrincipal;

  const scope: TenantScope = { tenantId: brandTenantId(R.tenant) };
  const otherScope: TenantScope = { tenantId: brandTenantId(OTHER.tenant) };

  async function remove(): Promise<void> {
    for (const id of [R.tenant, OTHER.tenant]) {
      await withTenant(prisma, brandTenantId(id), async (tx) => {
        await tx.tenant.deleteMany({ where: { id } });
      });
    }
  }

  /** Ring up a sale, so there is something to send back. */
  async function sell(
    productId: string,
    quantityScaled: string,
  ): Promise<{ saleId: string; lineId: string; totalMinor: string }> {
    const result = await checkout.checkout({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      lines: [{ productId, quantityScaled }],
      cashReceivedMinor: '100000',
    });
    if (result.outcome !== 'success') throw new Error(result.reason);
    const line = result.sale.lines[0];
    if (line === undefined) throw new Error('a sale with no lines');
    const stored = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.saleLine.findFirst({ where: { saleId: result.sale.saleId } }),
    );
    if (stored === null) throw new Error('the sale line was not persisted');
    return {
      saleId: result.sale.saleId,
      lineId: stored.id,
      totalMinor: result.sale.totalMinor,
    };
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: R.tenant,
          name: 'متجر المرتجعات',
          slug: R.slug,
          vatNumber: '300000000000003',
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({ data: { tenantId: R.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: {
          id: R.branch,
          tenantId: R.tenant,
          code: '07',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: R.user,
          tenantId: R.tenant,
          email: 'huda@returns-live-a.test',
          displayName: 'هدى',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: {
          id: R.membership,
          tenantId: R.tenant,
          userId: R.user,
          defaultBranchId: R.branch,
          updatedAt: new Date(),
        },
      });
      await tx.terminal.create({
        data: {
          id: R.terminal,
          tenantId: R.tenant,
          branchId: R.branch,
          code: '01',
          label: 'صندوق ١',
          updatedAt: new Date(),
        },
      });
      await tx.shift.create({
        data: {
          id: R.shift,
          tenantId: R.tenant,
          branchId: R.branch,
          terminalId: R.terminal,
          userId: R.user,
          openingFloatMinor: 20_000n,
          openedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      for (const [id, sku, price, type, tracked] of [
        [R.milk, 'MILK-1L', 1_150n, 'unit', true],
        // A price whose line does not divide by three, on purpose.
        [R.odd, 'ODD-1', 1_000n, 'unit', true],
        // Sold by weight, and never tracked in stock.
        [R.loose, 'LOOSE-1', 2_275n, 'weighted', false],
      ] as const) {
        await tx.product.create({
          data: {
            id,
            tenantId: R.tenant,
            sku,
            nameAr: 'صنف',
            productType: type,
            priceMinor: price,
            vatBasisPoints: 1500,
            trackInventory: tracked,
            updatedAt: new Date(),
          },
        });
        await tx.inventoryBalance.create({
          data: {
            tenantId: R.tenant,
            branchId: R.branch,
            productId: id,
            quantityScaled: 1_000_000n,
            updatedAt: new Date(),
          },
        });
      }
    });

    await withTenant(prisma, otherScope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: OTHER.tenant,
          name: 'متجر آخر',
          slug: OTHER.slug,
          updatedAt: new Date(),
        },
      });
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, R.user, 'manager');

    repository = createReturnRepository(prisma);
    checkout = createCheckoutService({
      tenants: createTenantRepository(prisma),
      products: createProductRepository(prisma),
      inventory: createInventoryRepository(prisma),
      shifts: createShiftRepository(prisma),
      sales: createSaleRepository(prisma),
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });
    returns = createReturnService({
      returns: repository,
      terminals: createTerminalRepository(prisma),
      shifts: createShiftRepository(prisma),
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });

    principal = {
      tenantId: R.tenant,
      tenantSlug: R.slug,
      userId: R.user,
      sessionId: newId(),
      email: 'huda@returns-live-a.test',
      displayName: 'هدى',
      roles: ['manager'],
      permissions: ['sale.create', 'sale.refund', 'product.read'],
      maxDiscountBasisPoints: 2_000n,
      branchId: R.branch,
    };
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  it('A. writes the document, its lines and its refund in one transaction', async () => {
    const sale = await sell(R.milk, '2000');
    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const stored = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.return.findFirst({
        where: { id: result.document.returnId },
        include: { lines: true, refunds: true },
      }),
    );

    expect(stored).not.toBeNull();
    expect(stored?.returnNumber).toMatch(/^R-07-\d{6}$/);
    expect(stored?.lines).toHaveLength(1);
    expect(stored?.refunds).toHaveLength(1);
    // net + VAT = total, asserted by the database itself as well as here.
    expect((stored?.netMinor ?? 0n) + (stored?.vatMinor ?? 0n)).toBe(stored?.totalMinor);
    // The refund is what the lines came to, not what anybody asked for.
    expect(stored?.refunds[0]?.amountMinor).toBe(stored?.totalMinor);
  });

  it('B. a cash return credits the stock and debits the drawer, once each', async () => {
    const sale = await sell(R.milk, '2000');
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({ where: { branchId: R.branch, productId: R.milk } }),
    );

    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '2000' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const [movements, cash, after] = await withTenant(prisma, scope.tenantId, async (tx) => [
      await tx.inventoryMovement.findMany({
        where: { sourceType: 'return', sourceId: result.document.returnId },
      }),
      await tx.cashMovement.findMany({ where: { shiftId: R.shift, kind: 'refund' } }),
      await tx.inventoryBalance.findFirst({ where: { branchId: R.branch, productId: R.milk } }),
    ]);

    expect(movements).toHaveLength(1);
    expect(movements[0]?.quantityScaled).toBe(2_000n);
    // The sale took two out; the return puts exactly those two back.
    expect((after?.quantityScaled ?? 0n) - (before?.quantityScaled ?? 0n)).toBe(2_000n);

    const mine = cash.filter((row) => row.amountMinor === -BigInt(result.document.totalMinor));
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0]?.amountMinor).toBeLessThan(0n);
  });

  it('B2. no stock is invented for a product the sale never decremented', async () => {
    const sale = await sell(R.loose, '1500');
    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '500' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const movements = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryMovement.findMany({
        where: { sourceType: 'return', sourceId: result.document.returnId },
      }),
    );
    // The sale never wrote a movement for this product, so neither does the
    // return. Crediting stock that was never taken would drift the balance
    // upward with nothing to point at.
    expect(movements).toHaveLength(0);
  });

  it('C. an electronic refund records its approval and moves no cash', async () => {
    const sale = await sell(R.milk, '1000');
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { shiftId: R.shift, kind: 'refund' } }),
    );

    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'electronic', scheme: 'mada', reference: 'AUTH-RET-1' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const [refund, after] = await withTenant(prisma, scope.tenantId, async (tx) => [
      await tx.refund.findFirst({ where: { returnId: result.document.returnId } }),
      await tx.cashMovement.count({ where: { shiftId: R.shift, kind: 'refund' } }),
    ]);

    expect(refund?.kind).toBe('electronic');
    expect(refund?.scheme).toBe('mada');
    expect(refund?.reference).toBe('AUTH-RET-1');
    expect(after).toBe(before);
  });

  it('D. two cashiers returning the last unit: exactly one succeeds', async () => {
    const sale = await sell(R.milk, '1000');

    const both = await Promise.all([
      returns.create({
        principal,
        operationId: newId(),
        terminalId: R.terminal,
        saleId: sale.saleId,
        lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
        refund: { kind: 'cash' },
      }),
      returns.create({
        principal,
        operationId: newId(),
        terminalId: R.terminal,
        saleId: sale.saleId,
        lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
        refund: { kind: 'cash' },
      }),
    ]);

    const won = both.filter((result) => result.outcome === 'success');
    const lost = both.filter((result) => result.outcome === 'failure');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // A named business answer, not a driver error and not a 500.
    expect(['over-return', 'nothing-returnable']).toContain(
      lost[0]?.outcome === 'failure' ? lost[0].reason : '',
    );

    const [lines, refunds, movements] = await withTenant(prisma, scope.tenantId, async (tx) => {
      const rows = await tx.return.findMany({
        where: { saleId: sale.saleId },
        include: { lines: true, refunds: true },
      });
      return [
        rows.flatMap((row) => row.lines),
        rows.flatMap((row) => row.refunds),
        await tx.inventoryMovement.findMany({
          where: { sourceType: 'return', sourceId: { in: rows.map((row) => row.id) } },
        }),
      ];
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantityScaled).toBe(1_000n);
    expect(refunds).toHaveLength(1);
    expect(movements).toHaveLength(1);
  });

  it('E. the same operation id twice at once produces one return', async () => {
    const sale = await sell(R.milk, '2000');
    const operationId = newId();
    const request = {
      principal,
      operationId,
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' as const },
    };

    const both = await Promise.all([returns.create(request), returns.create(request)]);
    const succeeded = both.filter((result) => result.outcome === 'success');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const rows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.return.findMany({ where: { operationId } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('F. the same operation id with different intent is a conflict', async () => {
    const sale = await sell(R.milk, '3000');
    const operationId = newId();

    const first = await returns.create({
      principal,
      operationId,
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    expect(first.outcome).toBe('success');

    const second = await returns.create({
      principal,
      operationId,
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '2000' }],
      refund: { kind: 'cash' },
    });

    expect(second.outcome).toBe('failure');
    if (second.outcome === 'failure') expect(second.reason).toBe('idempotency-conflict');
  });

  it('G. concurrent returns take unique, gapless numbers', async () => {
    const sales = await Promise.all([
      sell(R.milk, '1000'),
      sell(R.milk, '1000'),
      sell(R.milk, '1000'),
      sell(R.milk, '1000'),
    ]);

    const results = await Promise.all(
      sales.map((sale) =>
        returns.create({
          principal,
          operationId: newId(),
          terminalId: R.terminal,
          saleId: sale.saleId,
          lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
          refund: { kind: 'cash' },
        }),
      ),
    );

    const numbers = results
      .filter((result) => result.outcome === 'success')
      .map((result) => (result.outcome === 'success' ? result.document.returnNumber : ''));

    expect(numbers).toHaveLength(4);
    expect(new Set(numbers).size).toBe(4);
    for (const number of numbers) expect(number).toMatch(/^R-07-\d{6}$/);
  });

  it('H. PostgreSQL refuses a return that points across tenants', async () => {
    const sale = await sell(R.milk, '1000');

    await expect(
      withTenant(prisma, otherScope.tenantId, async (tx) =>
        tx.return.create({
          data: {
            id: newId(),
            tenantId: OTHER.tenant,
            // Another merchant's sale. RLS never sees this row as a problem —
            // it is the composite foreign key that refuses it.
            saleId: sale.saleId,
            branchId: R.branch,
            actorUserId: R.user,
            operationId: newId(),
            netMinor: 100n,
            vatMinor: 15n,
            totalMinor: 115n,
            grossMinor: 100n,
            issuedAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('I. another tenant can read none of it', async () => {
    const sale = await sell(R.milk, '1000');
    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const seen = await withTenant(prisma, otherScope.tenantId, async (tx) => ({
      returns: await tx.return.count(),
      lines: await tx.returnLine.count(),
      refunds: await tx.refund.count(),
    }));

    expect(seen.returns).toBe(0);
    expect(seen.lines).toBe(0);
    expect(seen.refunds).toBe(0);

    // And the scoped read finds it, so the zeros above mean isolation rather
    // than an empty table.
    const mine = await repository.findById(scope, result.document.returnId);
    expect(mine?.returnNumber).toBe(result.document.returnNumber);
  });

  it('J. a failure after the work has begun leaves nothing behind', async () => {
    const sale = await sell(R.milk, '2000');
    const operationId = newId();
    const returnId = newId();

    const before = await withTenant(prisma, scope.tenantId, async (tx) => ({
      returns: await tx.return.count(),
      movements: await tx.inventoryMovement.count(),
      cash: await tx.cashMovement.count(),
      keys: await tx.idempotencyKey.count(),
    }));

    /*
     * A refund reference longer than the column permits.
     *
     * The service and the domain both refuse this before a transaction opens,
     * which is exactly why the repository is called directly here: the point
     * is to fail at the *last* write, after the document, its lines, the stock
     * reversal and the number have all been written inside the transaction.
     * Anything left behind afterwards would be a partial commercial fact.
     */
    await expect(
      repository.record(scope, {
        returnId,
        saleId: sale.saleId,
        operationId,
        branchId: R.branch,
        terminalId: R.terminal,
        shiftId: R.shift,
        actorUserId: R.user,
        reason: null,
        currency: 'SAR',
        issuedAt: new Date().toISOString(),
        requested: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
        refund: {
          id: newId(),
          kind: 'electronic',
          scheme: 'mada',
          reference: 'X'.repeat(200),
        },
        lineIds: [newId()],
        inventoryIds: [newId()],
        cashMovementId: newId(),
        idempotency: { id: newId(), scope: 'return', operationId, requestHash: 'whatever' },
        plan: (state) => {
          const line = state.lines[0];
          if (line === undefined) throw new Error('no line to return');
          return {
            lines: [
              {
                saleLineId: line.saleLineId,
                lineNumber: line.lineNumber,
                productId: line.productId,
                sku: line.sku,
                nameAr: line.nameAr,
                nameEn: line.nameEn,
                productType: line.productType,
                vatBasisPoints: line.vatBasisPoints,
                quantityScaled: '1000',
                grossMinor: '1150',
                lineDiscountMinor: '0',
                basketDiscountMinor: '0',
                netMinor: '1000',
                vatMinor: '150',
                totalMinor: '1150',
              },
            ],
            grossMinor: '1150',
            lineDiscountMinor: '0',
            basketDiscountMinor: '0',
            netMinor: '1000',
            vatMinor: '150',
            totalMinor: '1150',
          };
        },
      }),
    ).rejects.toThrow();

    const after = await withTenant(prisma, scope.tenantId, async (tx) => ({
      returns: await tx.return.count(),
      movements: await tx.inventoryMovement.count(),
      cash: await tx.cashMovement.count(),
      keys: await tx.idempotencyKey.count(),
      thisOne: await tx.return.count({ where: { id: returnId } }),
      thisLine: await tx.returnLine.count({ where: { returnId } }),
      thisRefund: await tx.refund.count({ where: { returnId } }),
      thisKey: await tx.idempotencyKey.count({ where: { operationId } }),
      thisMovement: await tx.inventoryMovement.count({ where: { sourceId: returnId } }),
    }));

    expect(after.returns).toBe(before.returns);
    expect(after.movements).toBe(before.movements);
    expect(after.cash).toBe(before.cash);
    expect(after.keys).toBe(before.keys);
    expect(after.thisOne).toBe(0);
    expect(after.thisLine).toBe(0);
    expect(after.thisRefund).toBe(0);
    expect(after.thisKey).toBe(0);
    expect(after.thisMovement).toBe(0);

    // And the number the rolled-back transaction was going to use is handed to
    // the next one instead: the series has no gap.
    const next = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });
    expect(next.outcome).toBe('success');
  });

  it('K. cumulative proration closes exactly across sequential partial returns', async () => {
    // Three units at 1000 halalas inclusive: a line whose net and VAT both
    // carry a remainder over three.
    const sale = await sell(R.odd, '3000');
    const original = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.saleLine.findFirst({ where: { id: sale.lineId } }),
    );

    for (let i = 0; i < 3; i += 1) {
      const result = await returns.create({
        principal,
        operationId: newId(),
        terminalId: R.terminal,
        saleId: sale.saleId,
        lines: [{ saleLineId: sale.lineId, quantityScaled: '1000' }],
        refund: { kind: 'cash' },
      });
      if (result.outcome !== 'success') throw new Error(result.reason);
    }

    const rows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.returnLine.findMany({ where: { saleLineId: sale.lineId } }),
    );
    const sum = (pick: (row: (typeof rows)[number]) => bigint): bigint =>
      rows.reduce((total, row) => total + pick(row), 0n);

    expect(rows).toHaveLength(3);
    expect(sum((row) => row.quantityScaled)).toBe(original?.quantityScaled);
    expect(sum((row) => row.grossMinor)).toBe(original?.grossMinor);
    expect(sum((row) => row.lineDiscountMinor)).toBe(original?.lineDiscountMinor);
    expect(sum((row) => row.basketDiscountMinor)).toBe(original?.basketDiscountMinor);
    expect(sum((row) => row.netMinor)).toBe(original?.netMinor);
    expect(sum((row) => row.vatMinor)).toBe(original?.vatMinor);
    expect(sum((row) => row.totalMinor)).toBe(original?.totalMinor);

    // And there is nothing left to send back.
    const state = await returns.returnable(principal, sale.saleId);
    if ('outcome' in state) throw new Error('the sale became unreadable');
    expect(state.lines[0]?.remainingQuantityScaled).toBe('0');
  });

  it('L. the original sale stays the authority after the catalogue moves', async () => {
    const sale = await sell(R.milk, '2000');

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.update({
        where: { tenantId_id: { tenantId: R.tenant, id: R.milk } },
        data: { priceMinor: 9_999n, vatBasisPoints: 500, isActive: false, nameAr: 'اسم جديد' },
      });
    });

    const result = await returns.create({
      principal,
      operationId: newId(),
      terminalId: R.terminal,
      saleId: sale.saleId,
      lines: [{ saleLineId: sale.lineId, quantityScaled: '2000' }],
      refund: { kind: 'cash' },
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    // A price change, a VAT change, a rename and a deactivation later: the
    // customer gets back exactly what they paid.
    expect(result.document.totalMinor).toBe(sale.totalMinor);
    expect(result.document.lines[0]?.sku).toBe('MILK-1L');

    // Put it back for any test that runs after this one.
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.update({
        where: { tenantId_id: { tenantId: R.tenant, id: R.milk } },
        data: { priceMinor: 1_150n, vatBasisPoints: 1500, isActive: true, nameAr: 'صنف' },
      });
    });
  });
});
KORVI_EOF
ok "tests written"

say "The decision record"
cat << 'KORVI_EOF' > docs/decisions/ADR-0016-returns-and-refunds.md
# ADR-0016 — Returns and refunds

Status: accepted · Strike 3B-1b · supersedes nothing · builds on ADR-0002,
ADR-0004, ADR-0013, ADR-0015

## Context

Korvi could take money and could not give it back. `returns`, `return_lines`
and `refunds` existed as a sketch from the SaaS foundation — enough shape to
reserve the names, not enough to be a commercial document: no till, no drawer,
no operator, no number, no gross, no discounts, and no engine behind them.

A return is the operation where a point of sale is most likely to lose a
merchant money quietly. Nothing crashes when a partial refund is a halala
short; it simply happens on every partial return, forever.

## Decision

### The original sale is the only authority

Every figure on a return is prorated from the persisted sale line — its gross,
its two discount components, its net, its VAT and its total. Nothing is
recomputed from `products`. A price change, a VAT change, a rename, a
reclassification or a deactivation after the sale must not alter what a
customer gets back, and the only way to guarantee that is to never read the
catalogue at return time.

A sale that is not `finalized` is not returnable.

### Cumulative proration, never per-return rounding

For each component, the cumulative share owed after `q` of `Q` has come back is

    target(component, q) = floor(component * q / Q)

and what a return pays is `target(newCumulative) - alreadyRefunded`, where
`alreadyRefunded` is the sum of the finalized return rows rather than a
recomputation. At full quantity the target is the original component exactly,
so however a line is broken up — in any order, in any sizes, unit or weighted —
the sum of every return against it equals the line, on every component.

Rounding each return independently loses the remainder at every step. Three
returns of one unit from a line of three whose net is 1000 would refund 999,
and the same goods returned together would refund 1000.

`total` is derived as `net + VAT`; the other five components are prorated.
`gross - discounts` is deliberately not asserted to equal anything: under
tax-inclusive pricing it is the total, under tax-exclusive it is the net, and
one constraint cannot be both. That is why `sale_lines` only ever checked
`net + VAT = total`, and returns follow it.

### Unit versus weighted comes from a snapshot

`sale_lines.productType` is added and written at the moment of sale. Reading
the live product row at return time would mean a catalogue edit could change
what a historical sale means. The column is nullable, and rows written before
this migration deliberately remain NULL: today's editable catalogue is not
historical evidence. NULL means "no immutable fact proves the type". For such
a line the engine permits only the entire remaining quantity, because a full
remainder needs no unit-vs-weight interpretation; partial returns require the
immutable snapshot. A quantity that happens to be a whole number is not
evidence that the line was sold by the unit, and no heuristic of that shape is
acceptable.

This is the one change to the sale write path in this strike. It is additive:
one column, one value, and no arithmetic.

### The transaction is the authority, not the read

`ReturnRepository.record` owns the whole commercial fact in one transaction:
the document, its lines, the refund record, the stock reversal, the drawer
movement, the return number and the idempotency reservation.

The serialization boundary is `SELECT ... FROM sales ... FOR UPDATE`. Every
return against a sale queues on that row, so remaining quantity is read by one
transaction at a time; two cashiers returning the last unit cannot both see it
available. Sale lines are additionally locked in id order for deadlock hygiene.
There is no application-level lock anywhere.

Pricing stays in the domain by passing a pure `plan` function into `record`:
the adapter reads the authoritative state under lock and hands it over. Its
refusals roll the transaction back before a number is issued.

The preflight read in the service is a courtesy to the user interface. It is
explicitly not authority.

### Numbering

A return takes its own per-branch series, allocated under the branch row's
lock exactly as a receipt number is, and rendered `R-<branch>-<000001>`. A
rolled-back return releases the number to the next transaction, so the series
has no gap; a committed return keeps its number forever.

### Idempotency

Scope `return`. The fingerprint covers the material intent — sale, till, the
canonicalised lines and quantities, and the refund method with its scheme and
reference. It excludes everything the server derives (amount, branch, shift,
operator, number) and excludes the free-text reason, which a cashier may retype
differently on a retry. Same id and same intent replays the same document; same
id and different intent is `idempotency-conflict`.

### Refunds

One refund per return document, enforced by a unique index. Either cash, which
writes a negative `refund` movement against the open shift, or electronic,
which records that an approval happened elsewhere and writes no drawer
movement. Korvi contacts no scheme, acquirer, wallet or bank. The reference is
bounded, and cardholder data is refused by field name and by value — the same
Luhn check the settlement strike introduced, reused rather than reimplemented.

No cash-availability rule. Expected cash is accounting state, not a count of
the notes in the drawer, and refusing a lawful refund because a running total
looks low would be Korvi inventing a policy the merchant never asked for.

### Inventory

Stock is credited only where the original sale actually decremented it, proved
from that sale's own `inventory_movements` rows rather than from
`products.trackInventory` as it stands today. A merchant who enabled tracking
last week must not have last month's returns inflate a balance that was never
reduced.

### Authorisation

`sale.refund`, which already exists; no permission was invented. The branch
comes from the session, the till is proved to be in that branch, and the shift
must be open, on that till, in that branch and the operator's own. A sale in
another branch and a sale that does not exist get the same answer, so no
refusal reveals that another branch's sale exists.

## Boundaries

This is not a ZATCA credit note. Nothing here is signed, nothing is cleared,
and nothing claims to be reported. What the return document does carry is every
immutable tax fact a Phase 2 credit-note pipeline will need — quantities, the
VAT rate per line, and net, VAT and total per line and per document — so that
pipeline can be built without reconstructing historical prices or discounts.

Manual pay-in and pay-out, shift close, drawer reconciliation, the returns user
interface, receipt printing and payment-provider integration are not in this
strike and are not stubbed.

## Consequences

Returns per sale are serialised on the sale row. A sale being returned by two
tills at once queues; this is the correct trade for an invariant no constraint
can express, and the lock is held for the length of one small transaction.

A merchant may return goods against a sale whose product has since been
deleted. The line still refunds correctly, because everything it needs was
snapshotted; only the stock reversal is skipped, because there is nothing to
credit.
KORVI_EOF
ok "the decision record written"

say "Nothing that must not have moved, moved"
while read -r want path; do
  got="$(sha_of "$path")"
  [ "$got" = "$want" ] || die "$path changed. This strike must not touch it."
done << 'FROZEN_AFTER'
92362aa8953a02bd0068c27d03c4b56df1a433b95d48517bd29dfd1b8f259597  packages/domain/src/sale/finalize.ts
63f537ad17ddeced7e2a1a4698985b9d7bb962cbd44d08b173935300fb3eea90  packages/domain/src/tender/tender.ts
d5c62f7da1f40ec9c7e3f2174b5deb093fa0b9c96b9c34829ce0b348c1af92c5  packages/domain/src/pricing/line.ts
9f6263bc839472da4ace5f5a53cb84c2cd43ed36fff1069203d2626c24eb4368  packages/domain/src/pricing/index.ts
33e553b0e64a9c08ed18598c19b2a5f749e34395624b9855f44f44e95915909a  packages/domain/src/pricing/discount-authority.ts
dad3f8734377f565d85ba19e371968955b92d180eda486b47d1e5525aa9e70a1  packages/database/prisma/migrations/00000000000000_rls_foundation/migration.sql
9ea2755e0e8075807a939076bf9b30ba3e3ceff0b31b4f40917ce5bcab6888e9  packages/database/prisma/migrations/20260808120000_saas_foundation/migration.sql
33eb58c48f7698658694a0929e7adfcf94e05d09b4c67aef7bce5a09e89b0901  packages/database/prisma/migrations/20260810120000_auth_security/migration.sql
6d34c21448472d8060a43087cbbe68d1bb726a952423a53593dff3e0e87720da  packages/database/prisma/migrations/20260816120000_commercial_settlement/migration.sql
FROZEN_AFTER
ok "settlement, tender and pricing modules byte-identical"

MIGRATION_COUNT_AFTER="$(find packages/database/prisma/migrations -maxdepth 1 -type d -name '2026*' -o -maxdepth 1 -type d -name '0000*' | wc -l | tr -d ' ')"
[ "$MIGRATION_COUNT_AFTER" = "$((MIGRATION_COUNT_BEFORE + 1))" ] \
  || die "Expected exactly one new migration ($MIGRATION_COUNT_BEFORE -> $MIGRATION_COUNT_AFTER)."
ok "exactly one new migration"

say "Reading what was written"
NEW_SOURCES="
packages/domain/src/returns/prorate.ts
packages/domain/src/returns/returns.ts
packages/database/src/repositories/return-repository.ts
apps/api/src/returns/service.ts
apps/api/src/returns/fingerprint.ts
apps/api/src/routes/business.ts
apps/api/src/routes/validation.ts
"
# shellcheck disable=SC2086
if grep -nE 'parseFloat|toFixed\(|Math\.(round|floor|ceil)\(' $NEW_SOURCES; then
  die "Floating-point arithmetic reached money (ADR-0002)."
fi
# shellcheck disable=SC2086
if grep -nEi 'password|secret|api[_-]?key|bearer [A-Za-z0-9]|postgres(ql)?://' $NEW_SOURCES; then
  die "Credential material in a source file."
fi
# The domain names the card vocabulary once, in the refund guard that refuses
# it. Nothing below the API edge may name it at all.
if grep -nEi '\b(pan|cardNumber|card_number|cvv|cvc|track2|emvData)\b' \
     packages/database/src/repositories/return-repository.ts \
     packages/database/prisma/migrations/20260822120000_returns_refunds/migration.sql; then
  die "Cardholder-data vocabulary below the API edge."
fi
if grep -nE 'queryRawUnsafe|executeRawUnsafe' packages/database/src/repositories/return-repository.ts; then
  die "Unsafe raw SQL in the return repository."
fi
grep -q 'FOR UPDATE' packages/database/src/repositories/return-repository.ts \
  || die "The return repository has no serialization boundary."
grep -q 'withTenant' packages/database/src/repositories/return-repository.ts \
  || die "The return repository bypasses the RLS scope helper (ADR-0004)."
grep -q "requirePermission('sale.refund')" apps/api/src/routes/business.ts \
  || die "A return route is not gated on sale.refund."

MIGRATION=packages/database/prisma/migrations/20260822120000_returns_refunds/migration.sql
# Every table this migration touches already carries RLS from the SaaS
# foundation. The check is that it adds no table that would not.
if grep -nE '^[[:space:]]*CREATE TABLE' "$MIGRATION"; then
  die "This migration creates a table. Every tenant table needs its own RLS policy; none was written."
fi
grep -q 'REFERENCES "terminals"("tenantId", "id")' "$MIGRATION" \
  || die "The return-to-terminal key is not tenant-consistent."
grep -q 'REFERENCES "shifts"("tenantId", "id")' "$MIGRATION" \
  || die "The return-to-shift key is not tenant-consistent."
grep -q 'REFERENCES "users"("tenantId", "id")' "$MIGRATION" \
  || die "The return-to-operator key is not tenant-consistent."
if grep -nEi 'DROP TABLE|TRUNCATE|DROP DATABASE|DROP SCHEMA' "$MIGRATION"; then
  die "Destructive statement in a forward migration."
fi
# The ADR names the ZATCA boundary. It must not claim to have crossed it.
grep -q 'nothing claims to be reported' docs/decisions/ADR-0016-returns-and-refunds.md \
  || die "The ADR no longer states the ZATCA boundary."
ok "integer money only · no credential or card material · tenant-consistent keys · no destructive SQL"

say "Formatting"
npx prisma format --schema packages/database/prisma/schema.prisma >/dev/null
npx prettier --write --log-level warn \
  'packages/domain/src/**/*.ts' \
  'packages/database/src/**/*.ts' \
  'apps/api/src/**/*.ts' \
  'docs/decisions/ADR-0016-returns-and-refunds.md'
npx prettier --check --log-level warn \
  'packages/domain/src/**/*.ts' \
  'packages/database/src/**/*.ts' \
  'apps/api/src/**/*.ts' \
  'docs/decisions/ADR-0016-returns-and-refunds.md' \
  || die "Sources are still unformatted after a write pass."

say "Installing from the lockfile"
npm ci

if [ -n "${KORVI_TEST_DATABASE_URL:-}" ]; then
  say "Applying the new migration to the test database"
  # Forward only. `migrate deploy` applies pending migrations and does nothing
  # else: it never resets, never drops and never squashes. The live suites in
  # the gate below are meaningless against a schema that predates this strike.
  (cd packages/database && DATABASE_URL="$KORVI_TEST_DATABASE_URL" npx prisma migrate deploy)
fi

say "Running the full gate"
npm run --silent verify

say "Live PostgreSQL"
if [ -n "${KORVI_TEST_DATABASE_URL:-}" ]; then
  # The concurrency, atomicity and isolation claims are only claims until this
  # runs. `npm run verify` has already executed it as part of the suite; this
  # is the focused re-run, so the result is visible on its own.
  npx vitest run \
    apps/api/src/__tests__/returns-live.test.ts \
    apps/api/src/__tests__/settlement-live.test.ts \
    packages/database/src/__tests__/rls-live.test.ts
  ok "live PostgreSQL suites passed"
else
  printf '\n  KORVI_TEST_DATABASE_URL is not set, so the live suites SKIPPED.\n'
  printf '  The concurrency, rollback and RLS claims are unproven on this machine.\n'
  printf '  Point it at a throwaway PostgreSQL 16 database with every migration\n'
  printf '  applied, connected as the application role (never a superuser), and\n'
  printf '  run this script again.\n\n'
fi

cat << 'SUMMARY'

===============================================================================
  Korvi POS — Strike 3B-1b · returns and refunds core
===============================================================================

  THE ORIGINAL SALE IS THE AUTHORITY
    Every figure is prorated from the persisted sale line. A price change, a
    VAT change, a rename, a reclassification or a deactivated product cannot
    alter what a customer gets back. The catalogue is not read at return time.

  CUMULATIVE PRORATING
    target(component, q) = floor(component * q / soldQuantity), and a return
    pays the difference between that and what has already been refunded. Any
    sequence of partial returns — any order, any sizes, unit or weighted —
    sums to the original exactly, on gross, both discounts, net, VAT and
    total. Nothing is rounded twice.

  CONCURRENCY
    SELECT ... FROM sales ... FOR UPDATE is the boundary; sale lines are
    locked in id order behind it. Two cashiers returning the last unit: one
    succeeds, the other gets over-return or nothing-returnable. No P2002, no
    serialization error, no 500. No application lock anywhere.

  ONE TRANSACTION
    Document, lines, refund, stock reversal, drawer movement, return number
    and idempotency reservation commit together or not at all. A failure after
    the work has begun leaves no return, no line, no refund, no movement, no
    cash effect, no key — and no consumed number.

  THE DRAWER AND THE SHELF
    A cash refund writes one negative movement against the open shift. An
    electronic refund writes none. Stock is credited only where the original
    sale's own movements prove it was decremented — never from today's
    trackInventory flag.

  AUTHORISATION
    sale.refund, which already existed. Branch from the session, till proved
    to be in it, shift open and the operator's own. A sale in another branch
    is answered exactly as a sale that does not exist.

  MIGRATION
    20260822120000_returns_refunds — forward only, nothing dropped, no new
    table. The four committed migrations are byte-identical.

  NOT IN THIS STRIKE
    The returns user interface, manual pay-in and pay-out, shift close and
    reconciliation, receipt printing, real payment-provider integration and
    ZATCA Phase 2. The return document carries the tax facts a credit note
    will need; it is not a credit note and does not claim to be.

  Nothing was committed, pushed, reset or cleaned.

===============================================================================
SUMMARY

ok "Done."
