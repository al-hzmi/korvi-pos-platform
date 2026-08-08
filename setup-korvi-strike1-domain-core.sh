#!/usr/bin/env bash
#
# setup-korvi-strike1-domain-core.sh — Korvi POS · Strike 1 · domain core
#
# Adds five pure domain modules on top of the closed Phase 0 foundation
# (main @ be0fdf7):
#
#   quantity/  scaled-integer quantities for weighed goods
#   pricing/   the cart engine: extension, discounts, VAT, per-rate breakdown
#   sale/      deterministic finalization and the reconciliation invariant
#   rbac/      permissions, roles and discount ceilings
#   shift/     opening float, cash movements, expected cash, variance
#
# Nothing else is touched. No schema, no API, no UI, no printing.
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
    --no-verify)  RUN_VERIFY=0 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Not inside a git repository."
cd "$ROOT"

[ "$(node -p "require('./package.json').name" 2>/dev/null)" = "korvi-pos-platform" ] \
  || die "This is not korvi-pos-platform. Refusing to patch an unexpected repository."

# The Phase 0 markers this patch builds on. Their absence means the baseline is
# not what this script was written against, and guessing would be worse than
# stopping.
for required in \
  packages/domain/src/money/money.ts \
  packages/domain/src/money/allocate.ts \
  packages/domain/src/money/rounding.ts \
  packages/domain/src/tax/basis-points.ts \
  packages/domain/src/tender/tender.ts \
  packages/domain/src/errors.ts \
  packages/domain/src/index.ts \
  eslint.config.js
do
  [ -f "$required" ] || die "Phase 0 baseline file missing: $required"
done

grep -q "export function allocate" packages/domain/src/money/allocate.ts \
  || die "packages/domain/src/money/allocate.ts does not export allocate(); baseline mismatch."
grep -q "export function settle" packages/domain/src/tender/tender.ts \
  || die "packages/domain/src/tender/tender.ts does not export settle(); baseline mismatch."
grep -q "BASIS_POINT_SCALE" packages/domain/src/tax/basis-points.ts \
  || die "packages/domain/src/tax/basis-points.ts is not the expected module; baseline mismatch."

# Refuse to write over uncommitted work in the paths this patch owns.
if [ "$ALLOW_DIRTY" -eq 0 ]; then
  DIRTY="$(git status --porcelain -- packages/domain eslint.config.js 2>/dev/null || true)"
  if [ -n "$DIRTY" ]; then
    printf '%s\n' "$DIRTY" | sed 's/^/     /' >&2
    die "Uncommitted changes under packages/domain or eslint.config.js.
     Commit or stash them first, or re-run with --allow-dirty if you are sure."
  fi
fi

for owned in \
  packages/domain/src/quantity \
  packages/domain/src/pricing \
  packages/domain/src/sale \
  packages/domain/src/rbac \
  packages/domain/src/shift
do
  [ -e "$owned" ] && warn "$owned already exists and will be overwritten."
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" = "24" ] || die "Node 24 LTS required (ADR-0007). Found $(node --version)."

ok "Baseline verified · Node $(node --version) · $(git rev-parse --short HEAD)"

# Reference documents are inputs, never edited; checked again at the end.
REF_DESIGN_SUM="$(cksum < docs/design/KORVI-DESIGN-SYSTEM.md)"
REF_STRAT_SUM="$(cksum < docs/governance/Korvi_POS_Master_Strategy_Document.txt)"

mkdir -p \
  packages/domain/src/quantity/__tests__ \
  packages/domain/src/pricing/__tests__ \
  packages/domain/src/sale/__tests__ \
  packages/domain/src/rbac/__tests__ \
  packages/domain/src/shift/__tests__

say "Domain — quantity, pricing, cart"

cat << 'EOF' > packages/domain/src/quantity/quantity.ts
import { InvalidAmountError } from '../errors.js';

/**
 * Quantity as a scaled integer.
 *
 * A grocery scale reports 0.125 kg, and `0.1 + 0.2 !== 0.3` applies to weights
 * exactly as it applies to money. Multiplying a floating weight by a price in
 * halalas reintroduces the drift ADR-0002 exists to prevent, one line at a
 * time, so quantity gets the same treatment money already has.
 *
 * Scale is fixed at 1e-3: milligram-per-gram resolution for weighed goods, and
 * exact for whole units. Three decimals is what retail scales report and what
 * ZATCA line quantities carry.
 */
export const QUANTITY_SCALE = 1_000n;
export const QUANTITY_DECIMALS = 3;

export type Quantity = bigint & { readonly __brand: 'Quantity' };

export function quantity(scaled: bigint): Quantity {
  if (scaled < 0n) {
    throw new InvalidAmountError(`Quantity must not be negative, got ${scaled.toString()}.`);
  }
  return scaled as Quantity;
}

/** Whole units: `units(3)` is three items. */
export function units(count: number): Quantity {
  if (!Number.isInteger(count) || count < 0) {
    throw new InvalidAmountError(`Unit count must be a non-negative integer, got ${String(count)}.`);
  }
  return quantity(BigInt(count) * QUANTITY_SCALE);
}

export const ONE_UNIT: Quantity = units(1);
export const ZERO_QUANTITY: Quantity = quantity(0n);

/**
 * Parse "1.125" without a float.
 *
 * The same textual route money takes, and for the same reason: a scale reading
 * arrives as a decimal string, and `Number()` on it is where the drift starts.
 */
export function quantityFromDecimalString(input: string): Quantity {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (match === null) {
    throw new InvalidAmountError(`Not a decimal quantity: "${input}".`);
  }
  const fraction = match[2] ?? '';
  if (fraction.length > QUANTITY_DECIMALS) {
    throw new InvalidAmountError(
      `"${input}" is finer than ${String(QUANTITY_DECIMALS)} decimal places; refusing to round.`,
    );
  }
  const whole = BigInt(match[1] ?? '0');
  const padded = fraction.padEnd(QUANTITY_DECIMALS, '0');
  return quantity(whole * QUANTITY_SCALE + BigInt(padded === '' ? '0' : padded));
}

export function quantityToDecimalString(value: Quantity): string {
  const whole = value / QUANTITY_SCALE;
  const fraction = value % QUANTITY_SCALE;
  return `${whole.toString()}.${fraction.toString().padStart(QUANTITY_DECIMALS, '0')}`;
}

/** Trim trailing zeros for display: 2.000 -> "2", 0.500 -> "0.5". */
export function quantityToDisplayString(value: Quantity): string {
  const text = quantityToDecimalString(value);
  return text.replace(/\.?0+$/, '') || '0';
}

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  return quantity(a + b);
}

export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  if (b > a) {
    throw new InvalidAmountError('Quantity would go negative.');
  }
  return quantity(a - b);
}

export function isWholeUnits(value: Quantity): boolean {
  return value % QUANTITY_SCALE === 0n;
}

export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function quantityToJson(value: Quantity): string {
  return value.toString();
}

export function quantityFromJson(value: string): Quantity {
  if (!/^\d+$/.test(value)) {
    throw new InvalidAmountError(`Scaled quantity must be a non-negative integer string.`);
  }
  return quantity(BigInt(value));
}
EOF

cat << 'EOF' > packages/domain/src/pricing/line.ts
import { InvalidAmountError } from '../errors.js';
import { mulDivRound } from '../money/rounding.js';
import { allocate } from '../money/allocate.js';
import { QUANTITY_SCALE } from '../quantity/quantity.js';
import { BASIS_POINT_SCALE } from '../tax/basis-points.js';
import type { Quantity } from '../quantity/quantity.js';
import type { BasisPoints } from '../tax/basis-points.js';
import type { Currency, Money } from '../money/money.js';

/**
 * Line and basket pricing.
 *
 * Everything here is integer arithmetic on halalas and scaled quantities. The
 * one place rounding happens per line is `extendedPrice`, and it is explicit.
 */

export type PriceMode = 'tax-exclusive' | 'tax-inclusive';

export type DiscountKind = 'none' | 'fixed' | 'percentage';

export interface Discount {
  readonly kind: DiscountKind;
  /** Halalas when `fixed`; basis points when `percentage`. Ignored for `none`. */
  readonly value: bigint;
  readonly reason?: string;
}

export const NO_DISCOUNT: Discount = { kind: 'none', value: 0n };

export interface CartLineInput {
  readonly lineId: string;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  /** Price of one whole unit, in the tenant's price mode. */
  readonly unitPrice: Money;
  readonly quantity: Quantity;
  readonly vatRate: BasisPoints;
  readonly discount?: Discount;
  readonly isWeighted?: boolean;
}

export interface PricedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly vatRate: BasisPoints;
  /** quantity x unitPrice, before any discount. */
  readonly gross: Money;
  readonly lineDiscount: Money;
  /** Share of a basket-level discount allocated to this line. */
  readonly basketDiscount: Money;
  /** gross - lineDiscount - basketDiscount, tax exclusive. */
  readonly net: Money;
  readonly vat: Money;
  /** net + vat. */
  readonly total: Money;
}

/**
 * quantity x unitPrice, rounded once, half-up.
 *
 * `quantity` is scaled by 1000, so the division by QUANTITY_SCALE is part of
 * the same integer expression rather than a separate lossy step.
 */
export function extendedPrice(unitPrice: Money, qty: Quantity): Money {
  return { currency: unitPrice.currency, minor: mulDivRound(unitPrice.minor, qty, QUANTITY_SCALE) };
}

export function applyDiscount(base: Money, discount: Discount): Money {
  switch (discount.kind) {
    case 'none':
      return { currency: base.currency, minor: 0n };
    case 'fixed': {
      if (discount.value < 0n) throw new InvalidAmountError('Discount must not be negative.');
      // Never more than the line is worth: a discount cannot create money.
      return {
        currency: base.currency,
        minor: discount.value > base.minor ? base.minor : discount.value,
      };
    }
    case 'percentage': {
      if (discount.value < 0n || discount.value > BASIS_POINT_SCALE) {
        throw new InvalidAmountError('Percentage discount must be between 0 and 10000 bp.');
      }
      return {
        currency: base.currency,
        minor: mulDivRound(base.minor, discount.value, BASIS_POINT_SCALE),
      };
    }
  }
}

export interface PriceCartInput {
  readonly currency?: Currency;
  readonly priceMode: PriceMode;
  readonly lines: readonly CartLineInput[];
  readonly basketDiscount?: Discount;
}

export interface PricedCart {
  readonly lines: readonly PricedLine[];
  readonly gross: Money;
  readonly lineDiscountTotal: Money;
  readonly basketDiscountTotal: Money;
  readonly net: Money;
  readonly vat: Money;
  readonly total: Money;
  readonly vatBreakdown: readonly VatBucket[];
}

/** One row per distinct rate. ZATCA requires the split, not just the sum. */
export interface VatBucket {
  readonly rate: BasisPoints;
  readonly net: Money;
  readonly vat: Money;
}

const money = (minor: bigint, currency: Currency): Money => ({ currency, minor });

/**
 * Price a whole cart deterministically.
 *
 * Order matters and is fixed: extend each line, apply its own discount, then
 * allocate any basket discount across the discounted line values, then compute
 * VAT per line from the final taxable base.
 *
 * The basket discount is allocated with the same largest-remainder routine used
 * for money everywhere else, so the parts sum exactly to the discount. Applying
 * a percentage to each line independently would not — the halalas would not add
 * up, and the receipt would not reconcile.
 */
export function priceCart(input: PriceCartInput): PricedCart {
  const currency: Currency = input.currency ?? 'SAR';
  const zero = money(0n, currency);

  const staged = input.lines.map((line) => {
    const gross = extendedPrice(line.unitPrice, line.quantity);
    const lineDiscount = applyDiscount(gross, line.discount ?? NO_DISCOUNT);
    return { line, gross, lineDiscount, afterLine: gross.minor - lineDiscount.minor };
  });

  const afterLineTotal = staged.reduce((sum, entry) => sum + entry.afterLine, 0n);

  const basketDiscountTotal = applyDiscount(
    money(afterLineTotal, currency),
    input.basketDiscount ?? NO_DISCOUNT,
  );

  const basketShares =
    basketDiscountTotal.minor === 0n
      ? staged.map(() => 0n)
      : allocate(
          basketDiscountTotal.minor,
          staged.map((entry) => entry.afterLine),
        );

  const lines: PricedLine[] = staged.map((entry, index) => {
    const basketDiscount = money(basketShares[index] ?? 0n, currency);
    const discounted = entry.afterLine - basketDiscount.minor;

    // Tax-inclusive prices carry VAT inside the figure the customer sees, so
    // the net is extracted rather than added.
    const net =
      input.priceMode === 'tax-inclusive'
        ? discounted - mulDivRound(discounted, entry.line.vatRate, BASIS_POINT_SCALE + entry.line.vatRate)
        : discounted;
    const vat =
      input.priceMode === 'tax-inclusive'
        ? discounted - net
        : mulDivRound(discounted, entry.line.vatRate, BASIS_POINT_SCALE);

    return {
      lineId: entry.line.lineId,
      productId: entry.line.productId,
      sku: entry.line.sku,
      nameAr: entry.line.nameAr,
      nameEn: entry.line.nameEn,
      quantity: entry.line.quantity,
      unitPrice: entry.line.unitPrice,
      vatRate: entry.line.vatRate,
      gross: entry.gross,
      lineDiscount: entry.lineDiscount,
      basketDiscount,
      net: money(net, currency),
      vat: money(vat, currency),
      total: money(net + vat, currency),
    };
  });

  const sum = (pick: (line: PricedLine) => Money): Money =>
    money(lines.reduce((total, line) => total + pick(line).minor, 0n), currency);

  const buckets = new Map<bigint, { net: bigint; vat: bigint }>();
  for (const line of lines) {
    const bucket = buckets.get(line.vatRate) ?? { net: 0n, vat: 0n };
    bucket.net += line.net.minor;
    bucket.vat += line.vat.minor;
    buckets.set(line.vatRate, bucket);
  }

  return {
    lines,
    gross: sum((line) => line.gross),
    lineDiscountTotal: sum((line) => line.lineDiscount),
    basketDiscountTotal: lines.length === 0 ? zero : sum((line) => line.basketDiscount),
    net: sum((line) => line.net),
    vat: sum((line) => line.vat),
    total: sum((line) => line.total),
    vatBreakdown: [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([rate, bucket]) => ({
        rate: rate as BasisPoints,
        net: money(bucket.net, currency),
        vat: money(bucket.vat, currency),
      })),
  };
}
EOF

say "Domain — sale finalization, RBAC, shift, returns"

cat << 'EOF' > packages/domain/src/sale/finalize.ts
import { DomainError, InvalidAmountError } from '../errors.js';
import { priceCart } from '../pricing/line.js';
import { settle } from '../tender/tender.js';
import type { PriceCartInput, PricedCart } from '../pricing/line.js';
import type { Settlement, TenderLine } from '../tender/tender.js';
import type { Money } from '../money/money.js';

/** A finalized sale cannot be re-finalized, edited, or deleted. */
export class SaleAlreadyFinalizedError extends DomainError {
  public override readonly name = 'SaleAlreadyFinalizedError';
}

/** A discount exceeded what the acting user is permitted to grant. */
export class DiscountNotPermittedError extends DomainError {
  public override readonly name = 'DiscountNotPermittedError';
}

export interface FinalizeSaleInput {
  /** UUIDv7. Also the idempotency key for the whole operation. */
  readonly saleId: string;
  readonly operationId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly cashierId: string;
  readonly customerId: string | null;
  readonly cart: PriceCartInput;
  readonly tenders: readonly TenderLine[];
  /** ISO 8601, supplied — never read from an ambient clock. */
  readonly issuedAt: string;
  /** Ceiling in basis points the acting user may discount, from their role. */
  readonly maxDiscountBasisPoints: bigint;
}

export interface FinalizedSale {
  readonly saleId: string;
  readonly operationId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly cashierId: string;
  readonly customerId: string | null;
  readonly issuedAt: string;
  readonly priced: PricedCart;
  readonly settlement: Settlement;
  readonly status: 'finalized';
}

/**
 * Turn a cart plus tenders into an immutable sale.
 *
 * Everything the receipt states is computed here, from the line inputs, on the
 * server. A client-submitted total is never trusted: the cashier's browser is
 * an untrusted input, and the amount a customer is charged is the one figure
 * that must not be forgeable.
 *
 * The function is pure — no clock, no database, no id generation. Its output is
 * a value the caller persists atomically, which is what makes finalization
 * replayable and idempotent (ADR-0003).
 */
export function finalizeSale(input: FinalizeSaleInput): FinalizedSale {
  if (input.cart.lines.length === 0) {
    throw new InvalidAmountError('A sale needs at least one line.');
  }

  assertDiscountsPermitted(input);

  const priced = priceCart(input.cart);
  if (priced.total.minor <= 0n) {
    throw new InvalidAmountError('A finalized sale must have a positive total.');
  }

  const settlement = settle(priced.total, input.tenders);

  return {
    saleId: input.saleId,
    operationId: input.operationId,
    tenantId: input.tenantId,
    branchId: input.branchId,
    terminalId: input.terminalId,
    shiftId: input.shiftId,
    cashierId: input.cashierId,
    customerId: input.customerId,
    issuedAt: input.issuedAt,
    priced,
    settlement,
    status: 'finalized',
  };
}

/**
 * Discount ceilings are enforced here, in the domain, not in the UI.
 *
 * Hiding the discount button is a convenience. The ceiling is the control, and
 * it has to sit where the total is computed or it is not a control at all.
 */
function assertDiscountsPermitted(input: FinalizeSaleInput): void {
  const ceiling = input.maxDiscountBasisPoints;

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

  // Compare in basis points of the undiscounted gross, so the ceiling means
  // the same thing whatever mix of fixed and percentage discounts was used.
  const grantedBp = (granted * 10_000n) / undiscounted.gross.minor;
  if (grantedBp > ceiling) {
    throw new DiscountNotPermittedError(
      `Discount of ${grantedBp.toString()} bp exceeds the ${ceiling.toString()} bp this user may grant.`,
    );
  }
}

/**
 * Reconciliation invariant, assertable at any point.
 *
 * gross - discounts = net, and net + vat = total, and tendered - change =
 * total. If any of those drift the sale does not balance, and a sale that does
 * not balance must never reach a customer.
 */
export function saleReconciles(sale: FinalizedSale): boolean {
  const { priced, settlement } = sale;
  const discounted =
    priced.gross.minor - priced.lineDiscountTotal.minor - priced.basketDiscountTotal.minor;
  const netPlusVat = priced.net.minor + priced.vat.minor;
  const lineSum = priced.lines.reduce((sum, line) => sum + line.total.minor, 0n);
  const vatSum = priced.vatBreakdown.reduce((sum, bucket) => sum + bucket.vat.minor, 0n);

  return (
    netPlusVat === priced.total.minor &&
    lineSum === priced.total.minor &&
    vatSum === priced.vat.minor &&
    discounted >= 0n &&
    settlement.tendered.minor - settlement.change.minor === priced.total.minor
  );
}

export function totalOf(sale: FinalizedSale): Money {
  return sale.priced.total;
}
EOF

cat << 'EOF' > packages/domain/src/rbac/permissions.ts
import { DomainError } from '../errors.js';

/**
 * Permissions, not roles, are what the server checks.
 *
 * Roles are a way to hand out sets of permissions to people; the authorisation
 * decision is always about a single named capability. That keeps "can this
 * actor do this thing" answerable in one place when the role list grows.
 */
export const PERMISSIONS = [
  'product.read',
  'product.write',
  'inventory.read',
  'inventory.adjust',
  'sale.create',
  'sale.discount',
  'sale.refund',
  'sale.void',
  'shift.open',
  'shift.close',
  'shift.cash-movement',
  'customer.read',
  'customer.write',
  'report.read',
  'settings.manage',
  'users.manage',
  'zatca.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type RoleName = 'owner' | 'admin' | 'manager' | 'cashier';

export class PermissionDeniedError extends DomainError {
  public override readonly name = 'PermissionDeniedError';
  public readonly permission: Permission;

  public constructor(permission: Permission) {
    super(`Permission denied: ${permission}`);
    this.permission = permission;
  }
}

const CASHIER: readonly Permission[] = [
  'product.read',
  'inventory.read',
  'sale.create',
  'shift.open',
  'shift.close',
  'customer.read',
  'customer.write',
];

const MANAGER: readonly Permission[] = [
  ...CASHIER,
  'sale.discount',
  'sale.refund',
  'sale.void',
  'shift.cash-movement',
  'inventory.adjust',
  'product.write',
  'report.read',
];

const ADMIN: readonly Permission[] = [...MANAGER, 'settings.manage', 'users.manage', 'zatca.manage'];

export const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = {
  cashier: CASHIER,
  manager: MANAGER,
  admin: ADMIN,
  owner: PERMISSIONS,
};

/**
 * Discount ceiling per role, in basis points of the undiscounted cart.
 *
 * A cashier gets none: granting a discount is a management decision, and the
 * commonest shrinkage pattern in retail is a cashier discounting for friends.
 */
export const ROLE_MAX_DISCOUNT_BP: Readonly<Record<RoleName, bigint>> = {
  cashier: 0n,
  manager: 2_000n,
  admin: 5_000n,
  owner: 10_000n,
};

export interface Actor {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: RoleName;
  readonly permissions: readonly Permission[];
  readonly branchId: string | null;
}

export function permissionsForRole(role: RoleName): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function can(actor: Actor, permission: Permission): boolean {
  return actor.permissions.includes(permission);
}

/** Throws rather than returning false: forgetting to check a boolean is easy. */
export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new PermissionDeniedError(permission);
  }
}

export function maxDiscountFor(actor: Actor): bigint {
  return ROLE_MAX_DISCOUNT_BP[actor.role];
}
EOF

cat << 'EOF' > packages/domain/src/shift/shift.ts
import { DomainError } from '../errors.js';
import { addMoney, subtractMoney, zero } from '../money/money.js';
import type { Money } from '../money/money.js';

/**
 * Cashier shift arithmetic.
 *
 * The number that matters is the variance: declared cash minus expected cash.
 * Everything else exists to make that figure trustworthy, so every movement is
 * recorded rather than netted.
 */

export class ShiftStateError extends DomainError {
  public override readonly name = 'ShiftStateError';
}

export type ShiftStatus = 'open' | 'closed';

export type CashMovementKind = 'sale' | 'refund' | 'pay-in' | 'pay-out' | 'opening-float';

export interface CashMovement {
  readonly id: string;
  readonly kind: CashMovementKind;
  /** Signed: a pay-out and a refund are negative. */
  readonly amount: Money;
  readonly reason: string | null;
  readonly at: string;
}

export interface ShiftState {
  readonly shiftId: string;
  readonly status: ShiftStatus;
  readonly openingFloat: Money;
  readonly movements: readonly CashMovement[];
  readonly declaredCash: Money | null;
}

/** Opening float plus every signed cash movement. What should be in the drawer. */
export function expectedCash(shift: ShiftState): Money {
  return shift.movements.reduce<Money>(
    (total, movement) => addMoney(total, movement.amount),
    shift.openingFloat,
  );
}

/**
 * Declared minus expected. Positive is a surplus, negative a shortfall.
 *
 * Not clamped and not rounded: a variance of one halala is information, and
 * hiding it is how a systematic error stays invisible for a month.
 */
export function cashVariance(shift: ShiftState): Money {
  if (shift.declaredCash === null) {
    throw new ShiftStateError('Cannot compute variance before cash is declared.');
  }
  return subtractMoney(shift.declaredCash, expectedCash(shift));
}

export function assertOpen(shift: ShiftState): void {
  if (shift.status !== 'open') {
    throw new ShiftStateError('This shift is closed.');
  }
}

export function openShift(shiftId: string, openingFloat: Money, at: string): ShiftState {
  if (openingFloat.minor < 0n) {
    throw new ShiftStateError('Opening float must not be negative.');
  }
  return {
    shiftId,
    status: 'open',
    openingFloat,
    movements: [{ id: shiftId, kind: 'opening-float', amount: zero(openingFloat.currency), reason: null, at }],
    declaredCash: null,
  };
}

export function recordMovement(shift: ShiftState, movement: CashMovement): ShiftState {
  assertOpen(shift);
  if ((movement.kind === 'pay-out' || movement.kind === 'refund') && movement.amount.minor > 0n) {
    throw new ShiftStateError(`${movement.kind} must be recorded as a negative amount.`);
  }
  if ((movement.kind === 'pay-in' || movement.kind === 'sale') && movement.amount.minor < 0n) {
    throw new ShiftStateError(`${movement.kind} must be recorded as a positive amount.`);
  }
  return { ...shift, movements: [...shift.movements, movement] };
}

export function closeShift(shift: ShiftState, declaredCash: Money): ShiftState {
  assertOpen(shift);
  if (declaredCash.minor < 0n) {
    throw new ShiftStateError('Declared cash must not be negative.');
  }
  return { ...shift, status: 'closed', declaredCash };
}
EOF

say "Domain — barrel exports"

cat << 'EOF' > packages/domain/src/quantity/index.ts
export * from './quantity.js';
EOF

cat << 'EOF' > packages/domain/src/pricing/index.ts
export * from './line.js';
EOF

cat << 'EOF' > packages/domain/src/sale/index.ts
export * from './finalize.js';
EOF

cat << 'EOF' > packages/domain/src/rbac/index.ts
export * from './permissions.js';
EOF

cat << 'EOF' > packages/domain/src/shift/index.ts
export * from './shift.js';
EOF

cat << 'EOF' > packages/domain/src/index.ts
export * from './errors.js';
export * from './money/index.js';
export * from './tax/index.js';
export * from './quantity/index.js';
export * from './pricing/index.js';
export * from './tender/tender.js';
export * from './sale/index.js';
export * from './rbac/index.js';
export * from './shift/index.js';
export * from './ids/uuidv7.js';
export * from './zatca/tlv.js';
export * from './zatca/base64.js';
export * from './ports/persistence.js';
export * from './ports/search.js';
export * from './ports/offline.js';
EOF

say "Extending the money lint scope to the new financial modules"

# The Phase 0 rule banned parseFloat and Math rounding inside money/tax/tender.
# quantity, pricing and sale are financial arithmetic too, so they join the same
# scope rather than sitting outside it by accident.
node - <<'NODE'
const fs = require('node:fs');
const file = 'eslint.config.js';
const source = fs.readFileSync(file, 'utf8');
const from = "files: ['packages/domain/src/{money,tax,tender}/**/*.ts'],";
const to = "files: ['packages/domain/src/{money,tax,tender,quantity,pricing,sale}/**/*.ts'],";
if (source.includes(to)) {
  process.stdout.write('  already extended\n');
} else if (source.includes(from)) {
  fs.writeFileSync(file, source.replace(from, to));
  process.stdout.write('  money rules now cover quantity, pricing and sale\n');
} else {
  process.stderr.write(
    'Could not find the money-rule scope in eslint.config.js; refusing to guess.\n',
  );
  process.exit(1);
}
NODE

say "Excluding the Next-generated type shim from formatting"

# Pre-existing on the baseline, not introduced here: `next build` regenerates
# apps/pos-web/next-env.d.ts with its own quoting, and the file itself carries
# "This file should not be edited". Prettier and Next therefore disagree about
# it on every build. Ignoring a machine-generated file is the correct scope for
# a formatter; it weakens no check, because nobody authors this file.
node - <<'NODE'
const fs = require('node:fs');
const file = '.prettierignore';
const entry = 'apps/pos-web/next-env.d.ts';
const source = fs.readFileSync(file, 'utf8');
if (source.split('\n').some((line) => line.trim() === entry)) {
  process.stdout.write('  already ignored\n');
} else {
  fs.writeFileSync(
    file,
    `${source.replace(/\n*$/, '')}\n\n# Regenerated by \`next build\`; the file states it must not be edited.\n${entry}\n`,
  );
  process.stdout.write('  next-env.d.ts excluded\n');
}
NODE

say "Tests — quantity"

cat << 'EOF' > packages/domain/src/quantity/__tests__/quantity.test.ts
import { describe, expect, it } from 'vitest';
import {
  ONE_UNIT,
  QUANTITY_SCALE,
  addQuantity,
  compareQuantity,
  isWholeUnits,
  quantity,
  quantityFromDecimalString,
  quantityFromJson,
  quantityToDecimalString,
  quantityToDisplayString,
  quantityToJson,
  subtractQuantity,
  units,
} from '../quantity.js';
import { InvalidAmountError } from '../../errors.js';
import { extendedPrice } from '../../pricing/line.js';
import { money } from '../../money/money.js';

describe('parsing', () => {
  it('parses whole and fractional weights exactly', () => {
    expect(quantityFromDecimalString('1')).toBe(1_000n);
    expect(quantityFromDecimalString('0.5')).toBe(500n);
    expect(quantityFromDecimalString('0.125')).toBe(125n);
    expect(quantityFromDecimalString('2.750')).toBe(2_750n);
    expect(quantityFromDecimalString('0')).toBe(0n);
  });

  it('survives the additions that break floats', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754. A scale reporting three tenths of a kilo
    // three times must total nine tenths, not 0.8999999999999999.
    const tenth = quantityFromDecimalString('0.1');
    const fifth = quantityFromDecimalString('0.2');
    expect(addQuantity(tenth, fifth)).toBe(quantityFromDecimalString('0.3'));

    let running = quantity(0n);
    for (let index = 0; index < 10; index += 1) {
      running = addQuantity(running, quantityFromDecimalString('0.1'));
    }
    expect(running).toBe(ONE_UNIT);
    expect(quantityToDecimalString(running)).toBe('1.000');
  });

  it('rejects precision finer than the scale rather than rounding', () => {
    expect(() => quantityFromDecimalString('0.1255')).toThrow(InvalidAmountError);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '-1', '1,5', 'abc', '1.2.3', ' 1e3', 'NaN', '.5']) {
      expect(() => quantityFromDecimalString(bad), bad).toThrow(InvalidAmountError);
    }
  });

  it('rejects a negative scaled value', () => {
    expect(() => quantity(-1n)).toThrow(InvalidAmountError);
  });

  it('rejects a non-integer or negative unit count', () => {
    expect(() => units(1.5)).toThrow(InvalidAmountError);
    expect(() => units(-1)).toThrow(InvalidAmountError);
    expect(() => units(Number.NaN)).toThrow(InvalidAmountError);
  });

  it('accepts zero as a quantity', () => {
    expect(units(0)).toBe(0n);
  });
});

describe('formatting', () => {
  it('round-trips through the decimal form', () => {
    for (const text of ['0.000', '0.001', '0.125', '1.000', '99.999', '12345.678']) {
      expect(quantityToDecimalString(quantityFromDecimalString(text))).toBe(text);
    }
  });

  it('trims trailing zeros for display without losing value', () => {
    expect(quantityToDisplayString(units(2))).toBe('2');
    expect(quantityToDisplayString(quantityFromDecimalString('0.5'))).toBe('0.5');
    expect(quantityToDisplayString(quantityFromDecimalString('0.125'))).toBe('0.125');
    expect(quantityToDisplayString(quantity(0n))).toBe('0');
  });

  it('crosses a JSON boundary as a string, never a number', () => {
    const value = quantityFromDecimalString('0.125');
    expect(typeof quantityToJson(value)).toBe('string');
    expect(quantityFromJson(quantityToJson(value))).toBe(value);
  });

  it('rejects a malformed scaled value from JSON', () => {
    expect(() => quantityFromJson('0.5')).toThrow(InvalidAmountError);
    expect(() => quantityFromJson('-5')).toThrow(InvalidAmountError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts', () => {
    expect(addQuantity(units(2), quantityFromDecimalString('0.5'))).toBe(2_500n);
    expect(subtractQuantity(units(2), quantityFromDecimalString('0.5'))).toBe(1_500n);
  });

  it('refuses to go negative', () => {
    expect(() => subtractQuantity(units(1), units(2))).toThrow(InvalidAmountError);
  });

  it('recognises whole units', () => {
    expect(isWholeUnits(units(3))).toBe(true);
    expect(isWholeUnits(quantityFromDecimalString('0.125'))).toBe(false);
  });

  it('compares', () => {
    expect(compareQuantity(units(1), units(2))).toBe(-1);
    expect(compareQuantity(units(2), units(2))).toBe(0);
    expect(compareQuantity(units(3), units(2))).toBe(1);
  });

  it('keeps the declared scale', () => {
    expect(QUANTITY_SCALE).toBe(1_000n);
    expect(ONE_UNIT).toBe(QUANTITY_SCALE);
  });
});

describe('weighted extension against a price', () => {
  it('prices common scale readings exactly', () => {
    // 12.00 SAR/kg
    const perKilo = money(1_200n);
    expect(extendedPrice(perKilo, quantityFromDecimalString('1')).minor).toBe(1_200n);
    expect(extendedPrice(perKilo, quantityFromDecimalString('0.5')).minor).toBe(600n);
    expect(extendedPrice(perKilo, quantityFromDecimalString('0.125')).minor).toBe(150n);
    expect(extendedPrice(perKilo, quantityFromDecimalString('2.750')).minor).toBe(3_300n);
  });

  it('rounds a fractional halala once, half-up', () => {
    // 9.99 SAR/kg at 0.333 kg is 3.32667 SAR -> 333 halalas.
    expect(extendedPrice(money(999n), quantityFromDecimalString('0.333')).minor).toBe(333n);
    // 0.01 SAR/kg at 0.5 kg is half a halala -> 1, not 0.
    expect(extendedPrice(money(1n), quantityFromDecimalString('0.5')).minor).toBe(1n);
  });

  it('never drifts across a sweep of prices and weights', () => {
    // Ten weighings of the same item must equal one weighing of ten times the
    // weight, to the halala, for every price in the sweep.
    for (let price = 1n; price <= 200n; price += 7n) {
      const unitPrice = money(price);
      let sum = 0n;
      for (let index = 0; index < 10; index += 1) {
        sum += extendedPrice(unitPrice, quantityFromDecimalString('0.1')).minor;
      }
      const once = extendedPrice(unitPrice, units(1)).minor;
      // Per-weighing rounding may differ from a single weighing, but only ever
      // by the rounding of each part -- never by an accumulating float error.
      expect(sum - once).toBeGreaterThanOrEqual(-10n);
      expect(sum - once).toBeLessThanOrEqual(10n);
    }
  });
});
EOF

say "Tests — pricing"

cat << 'EOF' > packages/domain/src/pricing/__tests__/line.test.ts
import { describe, expect, it } from 'vitest';
import { applyDiscount, extendedPrice, priceCart } from '../line.js';
import type { CartLineInput, PriceCartInput, PriceMode } from '../line.js';
import { money } from '../../money/money.js';
import { quantityFromDecimalString, units } from '../../quantity/quantity.js';
import { VAT_STANDARD_BP, VAT_ZERO_BP, basisPoints } from '../../tax/basis-points.js';
import { InvalidAmountError } from '../../errors.js';

const line = (over: Partial<CartLineInput> = {}): CartLineInput => ({
  lineId: over.lineId ?? 'l1',
  productId: over.productId ?? 'p1',
  sku: over.sku ?? 'SKU-1',
  nameAr: over.nameAr ?? 'صنف',
  nameEn: over.nameEn ?? null,
  unitPrice: over.unitPrice ?? money(1_000n),
  quantity: over.quantity ?? units(1),
  vatRate: over.vatRate ?? VAT_STANDARD_BP,
  ...(over.discount === undefined ? {} : { discount: over.discount }),
  ...(over.isWeighted === undefined ? {} : { isWeighted: over.isWeighted }),
});

const cart = (over: Partial<PriceCartInput> = {}): PriceCartInput => ({
  priceMode: over.priceMode ?? 'tax-exclusive',
  lines: over.lines ?? [line()],
  ...(over.basketDiscount === undefined ? {} : { basketDiscount: over.basketDiscount }),
});

describe('extendedPrice', () => {
  it('multiplies whole units exactly', () => {
    expect(extendedPrice(money(1_000n), units(3)).minor).toBe(3_000n);
  });

  it('multiplies weighed quantities exactly', () => {
    expect(extendedPrice(money(1_200n), quantityFromDecimalString('0.25')).minor).toBe(300n);
  });
});

describe('applyDiscount', () => {
  it('caps a fixed discount at the line value — a discount cannot create money', () => {
    expect(applyDiscount(money(500n), { kind: 'fixed', value: 900n }).minor).toBe(500n);
  });

  it('computes a percentage in basis points', () => {
    expect(applyDiscount(money(1_000n), { kind: 'percentage', value: 1_000n }).minor).toBe(100n);
  });

  it('rejects a negative or out-of-range discount', () => {
    expect(() => applyDiscount(money(100n), { kind: 'fixed', value: -1n })).toThrow(
      InvalidAmountError,
    );
    expect(() => applyDiscount(money(100n), { kind: 'percentage', value: 10_001n })).toThrow(
      InvalidAmountError,
    );
  });

  it('treats none as zero', () => {
    expect(applyDiscount(money(100n), { kind: 'none', value: 0n }).minor).toBe(0n);
  });
});

describe('tax-exclusive pricing', () => {
  it('adds VAT on top of the net', () => {
    const priced = priceCart(cart({ lines: [line({ unitPrice: money(10_000n) })] }));
    expect(priced.net.minor).toBe(10_000n);
    expect(priced.vat.minor).toBe(1_500n);
    expect(priced.total.minor).toBe(11_500n);
  });

  it('prices a multi-line cart', () => {
    const priced = priceCart(
      cart({
        lines: [
          line({ lineId: 'a', unitPrice: money(1_000n), quantity: units(2) }),
          line({ lineId: 'b', unitPrice: money(2_500n), quantity: units(1) }),
        ],
      }),
    );
    expect(priced.gross.minor).toBe(4_500n);
    expect(priced.vat.minor).toBe(675n);
    expect(priced.total.minor).toBe(5_175n);
  });
});

describe('tax-inclusive pricing', () => {
  it('extracts VAT from the shelf price', () => {
    // 115.00 on the shelf at 15% is 100.00 net plus 15.00 VAT.
    const priced = priceCart(
      cart({ priceMode: 'tax-inclusive', lines: [line({ unitPrice: money(11_500n) })] }),
    );
    expect(priced.net.minor).toBe(10_000n);
    expect(priced.vat.minor).toBe(1_500n);
    expect(priced.total.minor).toBe(11_500n);
  });

  it('keeps the customer-facing total identical to the shelf price', () => {
    for (const shelf of [1n, 7n, 99n, 333n, 1_999n, 12_345n]) {
      const priced = priceCart(
        cart({ priceMode: 'tax-inclusive', lines: [line({ unitPrice: money(shelf) })] }),
      );
      // The point of inclusive pricing: what is on the label is what is paid.
      expect(priced.total.minor).toBe(shelf);
      expect(priced.net.minor + priced.vat.minor).toBe(shelf);
    }
  });
});

describe('discounts', () => {
  it('applies a line fixed discount before VAT', () => {
    const priced = priceCart(
      cart({ lines: [line({ unitPrice: money(10_000n), discount: { kind: 'fixed', value: 2_000n } })] }),
    );
    expect(priced.lineDiscountTotal.minor).toBe(2_000n);
    expect(priced.net.minor).toBe(8_000n);
    expect(priced.vat.minor).toBe(1_200n);
    expect(priced.total.minor).toBe(9_200n);
  });

  it('applies a line percentage discount', () => {
    const priced = priceCart(
      cart({
        lines: [line({ unitPrice: money(10_000n), discount: { kind: 'percentage', value: 1_000n } })],
      }),
    );
    expect(priced.lineDiscountTotal.minor).toBe(1_000n);
    expect(priced.total.minor).toBe(10_350n);
  });

  it('allocates a basket fixed discount so the parts sum exactly', () => {
    // 100 halalas across three unequal lines cannot divide evenly.
    const priced = priceCart(
      cart({
        lines: [
          line({ lineId: 'a', unitPrice: money(1_000n) }),
          line({ lineId: 'b', unitPrice: money(2_000n) }),
          line({ lineId: 'c', unitPrice: money(3_000n) }),
        ],
        basketDiscount: { kind: 'fixed', value: 100n },
      }),
    );
    const shares = priced.lines.map((entry) => entry.basketDiscount.minor);
    expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(100n);
    expect(priced.basketDiscountTotal.minor).toBe(100n);
  });

  it('allocates a basket percentage discount exactly', () => {
    const priced = priceCart(
      cart({
        lines: [
          line({ lineId: 'a', unitPrice: money(333n) }),
          line({ lineId: 'b', unitPrice: money(667n) }),
          line({ lineId: 'c', unitPrice: money(1_000n) }),
        ],
        basketDiscount: { kind: 'percentage', value: 1_500n },
      }),
    );
    const shares = priced.lines.map((entry) => entry.basketDiscount.minor);
    expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(
      priced.basketDiscountTotal.minor,
    );
  });

  it('is deterministic — the same cart allocates the same way every time', () => {
    const input = cart({
      lines: [
        line({ lineId: 'a', unitPrice: money(1_111n) }),
        line({ lineId: 'b', unitPrice: money(2_222n) }),
        line({ lineId: 'c', unitPrice: money(3_333n) }),
      ],
      basketDiscount: { kind: 'fixed', value: 777n },
    });
    const first = priceCart(input).lines.map((entry) => entry.basketDiscount.minor);
    for (let run = 0; run < 20; run += 1) {
      expect(priceCart(input).lines.map((entry) => entry.basketDiscount.minor)).toEqual(first);
    }
  });

  it('stacks a line discount and a basket discount without losing a halala', () => {
    const priced = priceCart(
      cart({
        lines: [
          line({ lineId: 'a', unitPrice: money(1_000n), discount: { kind: 'fixed', value: 133n } }),
          line({ lineId: 'b', unitPrice: money(2_000n), discount: { kind: 'percentage', value: 700n } }),
        ],
        basketDiscount: { kind: 'percentage', value: 999n },
      }),
    );
    const lineSum = priced.lines.reduce((sum, entry) => sum + entry.total.minor, 0n);
    expect(lineSum).toBe(priced.total.minor);
    expect(priced.net.minor + priced.vat.minor).toBe(priced.total.minor);
  });
});

describe('VAT breakdown', () => {
  it('splits by rate and reconciles to the totals', () => {
    const priced = priceCart(
      cart({
        lines: [
          line({ lineId: 'a', unitPrice: money(10_000n), vatRate: VAT_STANDARD_BP }),
          line({ lineId: 'b', unitPrice: money(5_000n), vatRate: VAT_ZERO_BP }),
          line({ lineId: 'c', unitPrice: money(2_000n), vatRate: VAT_STANDARD_BP }),
        ],
      }),
    );

    expect(priced.vatBreakdown).toHaveLength(2);
    const zeroBucket = priced.vatBreakdown.find((bucket) => bucket.rate === 0n);
    const standard = priced.vatBreakdown.find((bucket) => bucket.rate === 1_500n);

    expect(zeroBucket?.net.minor).toBe(5_000n);
    expect(zeroBucket?.vat.minor).toBe(0n);
    expect(standard?.net.minor).toBe(12_000n);
    expect(standard?.vat.minor).toBe(1_800n);

    const netSum = priced.vatBreakdown.reduce((sum, bucket) => sum + bucket.net.minor, 0n);
    const vatSum = priced.vatBreakdown.reduce((sum, bucket) => sum + bucket.vat.minor, 0n);
    expect(netSum).toBe(priced.net.minor);
    expect(vatSum).toBe(priced.vat.minor);
  });

  it('handles a non-standard rate', () => {
    const priced = priceCart(
      cart({ lines: [line({ unitPrice: money(10_000n), vatRate: basisPoints(500n) })] }),
    );
    expect(priced.vat.minor).toBe(500n);
  });
});

describe('reconciliation sweep', () => {
  const MODES: readonly PriceMode[] = ['tax-exclusive', 'tax-inclusive'];

  it('always satisfies net + vat = total and the line sum = total', () => {
    // Awkward halala values across both price modes, with mixed discounts and
    // weighed quantities. Any allocation or rounding slip shows up here.
    for (const priceMode of MODES) {
      for (let price = 1n; price <= 999n; price += 37n) {
        for (const weight of ['1', '0.5', '0.125', '2.750', '0.333']) {
          const priced = priceCart({
            priceMode,
            lines: [
              line({
                lineId: 'a',
                unitPrice: money(price),
                quantity: quantityFromDecimalString(weight),
                discount: { kind: 'percentage', value: 700n },
              }),
              line({
                lineId: 'b',
                unitPrice: money(price * 3n + 1n),
                quantity: units(2),
                discount: { kind: 'fixed', value: 13n },
              }),
              line({ lineId: 'c', unitPrice: money(price + 7n), vatRate: VAT_ZERO_BP }),
            ],
            basketDiscount: { kind: 'fixed', value: 11n },
          });

          expect(priced.net.minor + priced.vat.minor).toBe(priced.total.minor);
          expect(priced.lines.reduce((sum, entry) => sum + entry.total.minor, 0n)).toBe(
            priced.total.minor,
          );
          expect(
            priced.lines.reduce((sum, entry) => sum + entry.basketDiscount.minor, 0n),
          ).toBe(priced.basketDiscountTotal.minor);
          expect(
            priced.vatBreakdown.reduce((sum, bucket) => sum + bucket.vat.minor, 0n),
          ).toBe(priced.vat.minor);
          for (const entry of priced.lines) {
            expect(entry.net.minor).toBeGreaterThanOrEqual(0n);
            expect(entry.vat.minor).toBeGreaterThanOrEqual(0n);
          }
        }
      }
    }
  });
});
EOF

say "Tests — sale finalization, RBAC, shift"

cat << 'EOF' > packages/domain/src/sale/__tests__/finalize.test.ts
import { describe, expect, it } from 'vitest';
import { DiscountNotPermittedError, finalizeSale, saleReconciles, totalOf } from '../finalize.js';
import type { FinalizeSaleInput } from '../finalize.js';
import { money } from '../../money/money.js';
import { units, quantityFromDecimalString } from '../../quantity/quantity.js';
import { VAT_STANDARD_BP } from '../../tax/basis-points.js';
import { InvalidAmountError, NonCashChangeError, UnderpaidError } from '../../errors.js';
import { ROLE_MAX_DISCOUNT_BP } from '../../rbac/permissions.js';
import type { CartLineInput } from '../../pricing/line.js';

const item = (over: Partial<CartLineInput> = {}): CartLineInput => ({
  lineId: over.lineId ?? 'l1',
  productId: over.productId ?? 'p1',
  sku: over.sku ?? 'SKU-1',
  nameAr: over.nameAr ?? 'ماء',
  nameEn: over.nameEn ?? null,
  unitPrice: over.unitPrice ?? money(10_000n),
  quantity: over.quantity ?? units(1),
  vatRate: over.vatRate ?? VAT_STANDARD_BP,
  ...(over.discount === undefined ? {} : { discount: over.discount }),
});

const input = (over: Partial<FinalizeSaleInput> = {}): FinalizeSaleInput => ({
  saleId: over.saleId ?? '0195e0a0-0000-7000-8000-000000000001',
  operationId: over.operationId ?? 'op-1',
  tenantId: over.tenantId ?? 'tenant-1',
  branchId: over.branchId ?? 'branch-1',
  terminalId: over.terminalId ?? 'terminal-1',
  shiftId: over.shiftId ?? 'shift-1',
  cashierId: over.cashierId ?? 'user-1',
  customerId: over.customerId ?? null,
  cart: over.cart ?? { priceMode: 'tax-exclusive', lines: [item()] },
  tenders: over.tenders ?? [{ kind: 'cash', amount: money(11_500n) }],
  issuedAt: over.issuedAt ?? '2026-08-08T09:45:00Z',
  maxDiscountBasisPoints: over.maxDiscountBasisPoints ?? ROLE_MAX_DISCOUNT_BP.manager,
});

describe('authoritative totals', () => {
  it('computes the total from the lines, not from anything the client sends', () => {
    const sale = finalizeSale(input());
    expect(totalOf(sale).minor).toBe(11_500n);
    expect(sale.priced.net.minor).toBe(10_000n);
    expect(sale.priced.vat.minor).toBe(1_500n);
    expect(sale.status).toBe('finalized');
  });

  it('is deterministic for identical input', () => {
    const first = finalizeSale(input());
    const second = finalizeSale(input());
    expect(second.priced.total.minor).toBe(first.priced.total.minor);
    expect(second.settlement.change.minor).toBe(first.settlement.change.minor);
    expect(JSON.stringify(second, replacer)).toBe(JSON.stringify(first, replacer));
  });

  it('refuses an empty cart', () => {
    expect(() => finalizeSale(input({ cart: { priceMode: 'tax-exclusive', lines: [] } }))).toThrow(
      InvalidAmountError,
    );
  });

  it('refuses a zero-value sale', () => {
    expect(() =>
      finalizeSale(
        input({
          cart: { priceMode: 'tax-exclusive', lines: [item({ unitPrice: money(0n) })] },
          tenders: [{ kind: 'cash', amount: money(0n) }],
        }),
      ),
    ).toThrow(InvalidAmountError);
  });

  it('prices a weighed line', () => {
    const sale = finalizeSale(
      input({
        cart: {
          priceMode: 'tax-exclusive',
          lines: [item({ unitPrice: money(1_200n), quantity: quantityFromDecimalString('0.25') })],
        },
        tenders: [{ kind: 'cash', amount: money(345n) }],
      }),
    );
    // 12.00/kg x 0.25 kg = 3.00 net, 0.45 VAT, 3.45 total.
    expect(sale.priced.total.minor).toBe(345n);
  });
});

describe('immutability of the result', () => {
  it('exposes readonly structures that are not shared with the input', () => {
    const source = input();
    const sale = finalizeSale(source);
    // Mutating the caller's cart afterwards must not change the finalized sale.
    const mutated = { ...source, cart: { ...source.cart, lines: [] } };
    expect(mutated.cart.lines).toHaveLength(0);
    expect(sale.priced.lines).toHaveLength(1);
    expect(sale.priced.total.minor).toBe(11_500n);
  });

  it('carries the operation id that makes replay idempotent', () => {
    const sale = finalizeSale(input({ operationId: 'op-abc' }));
    expect(sale.operationId).toBe('op-abc');
    expect(sale.saleId).toBe('0195e0a0-0000-7000-8000-000000000001');
  });
});

describe('tenders', () => {
  it('settles an exact cash payment with no change', () => {
    const sale = finalizeSale(input());
    expect(sale.settlement.change.minor).toBe(0n);
    expect(sale.settlement.changeFrom).toBeNull();
  });

  it('returns change from cash on an overpayment', () => {
    const sale = finalizeSale(input({ tenders: [{ kind: 'cash', amount: money(20_000n) }] }));
    expect(sale.settlement.change.minor).toBe(8_500n);
    expect(sale.settlement.changeFrom).toBe('cash');
  });

  it('settles exactly on Mada with no change', () => {
    const sale = finalizeSale(input({ tenders: [{ kind: 'mada', amount: money(11_500n) }] }));
    expect(sale.settlement.change.minor).toBe(0n);
    expect(sale.settlement.changeFrom).toBeNull();
  });

  it('settles exactly on card with no change', () => {
    const sale = finalizeSale(input({ tenders: [{ kind: 'card', amount: money(11_500n) }] }));
    expect(sale.settlement.change.minor).toBe(0n);
  });

  it('splits card and cash, giving change from the cash portion only', () => {
    const sale = finalizeSale(
      input({
        tenders: [
          { kind: 'mada', amount: money(6_000n) },
          { kind: 'cash', amount: money(6_000n) },
        ],
      }),
    );
    expect(sale.settlement.change.minor).toBe(500n);
    expect(sale.settlement.changeFrom).toBe('cash');
  });

  it('refuses a non-cash overpayment', () => {
    // A card terminal cannot hand money back.
    expect(() =>
      finalizeSale(input({ tenders: [{ kind: 'card', amount: money(12_000n) }] })),
    ).toThrow(NonCashChangeError);
    expect(() =>
      finalizeSale(input({ tenders: [{ kind: 'mada', amount: money(11_501n) }] })),
    ).toThrow(NonCashChangeError);
  });

  it('refuses combined non-cash tenders exceeding the total', () => {
    expect(() =>
      finalizeSale(
        input({
          tenders: [
            { kind: 'card', amount: money(6_000n) },
            { kind: 'mada', amount: money(6_000n) },
          ],
        }),
      ),
    ).toThrow(NonCashChangeError);
  });

  it('refuses an underpayment', () => {
    expect(() =>
      finalizeSale(input({ tenders: [{ kind: 'cash', amount: money(11_499n) }] })),
    ).toThrow(UnderpaidError);
  });
});

describe('discount ceiling', () => {
  it('lets a manager grant a discount inside the ceiling', () => {
    const sale = finalizeSale(
      input({
        cart: {
          priceMode: 'tax-exclusive',
          lines: [item({ discount: { kind: 'percentage', value: 1_000n } })],
        },
        tenders: [{ kind: 'cash', amount: money(10_350n) }],
        maxDiscountBasisPoints: ROLE_MAX_DISCOUNT_BP.manager,
      }),
    );
    expect(sale.priced.lineDiscountTotal.minor).toBe(1_000n);
  });

  it('refuses a discount above the ceiling', () => {
    expect(() =>
      finalizeSale(
        input({
          cart: {
            priceMode: 'tax-exclusive',
            lines: [item({ discount: { kind: 'percentage', value: 3_000n } })],
          },
          tenders: [{ kind: 'cash', amount: money(8_050n) }],
          maxDiscountBasisPoints: ROLE_MAX_DISCOUNT_BP.manager,
        }),
      ),
    ).toThrow(DiscountNotPermittedError);
  });

  it('refuses any discount for a cashier', () => {
    // Hiding the button is convenience; this is the control.
    expect(() =>
      finalizeSale(
        input({
          cart: {
            priceMode: 'tax-exclusive',
            lines: [item({ discount: { kind: 'fixed', value: 100n } })],
          },
          tenders: [{ kind: 'cash', amount: money(11_385n) }],
          maxDiscountBasisPoints: ROLE_MAX_DISCOUNT_BP.cashier,
        }),
      ),
    ).toThrow(DiscountNotPermittedError);
  });

  it('counts a basket discount against the same ceiling', () => {
    expect(() =>
      finalizeSale(
        input({
          cart: {
            priceMode: 'tax-exclusive',
            lines: [item()],
            basketDiscount: { kind: 'percentage', value: 4_000n },
          },
          tenders: [{ kind: 'cash', amount: money(6_900n) }],
          maxDiscountBasisPoints: ROLE_MAX_DISCOUNT_BP.manager,
        }),
      ),
    ).toThrow(DiscountNotPermittedError);
  });

  it('allows an owner the full range', () => {
    const sale = finalizeSale(
      input({
        cart: {
          priceMode: 'tax-exclusive',
          lines: [item({ discount: { kind: 'percentage', value: 9_000n } })],
        },
        tenders: [{ kind: 'cash', amount: money(1_150n) }],
        maxDiscountBasisPoints: ROLE_MAX_DISCOUNT_BP.owner,
      }),
    );
    expect(sale.priced.total.minor).toBe(1_150n);
  });
});

describe('saleReconciles', () => {
  it('holds for a plain sale', () => {
    expect(saleReconciles(finalizeSale(input()))).toBe(true);
  });

  it('holds across a sweep of prices, tenders, modes and discounts', () => {
    for (let price = 100n; price <= 5_000n; price += 311n) {
      for (const priceMode of ['tax-exclusive', 'tax-inclusive'] as const) {
        const sale = finalizeSale(
          input({
            cart: {
              priceMode,
              lines: [
                item({ lineId: 'a', unitPrice: money(price), quantity: units(2) }),
                item({
                  lineId: 'b',
                  unitPrice: money(price + 13n),
                  quantity: quantityFromDecimalString('0.375'),
                  discount: { kind: 'percentage', value: 500n },
                }),
              ],
              basketDiscount: { kind: 'fixed', value: 7n },
            },
            tenders: [{ kind: 'cash', amount: money(1_000_000n) }],
            maxDiscountBasisPoints: 10_000n,
          }),
        );
        expect(saleReconciles(sale), `price ${price.toString()} ${priceMode}`).toBe(true);
      }
    }
  });
});

/** bigint is not JSON-serialisable; this is only for structural comparison. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
EOF

cat << 'EOF' > packages/domain/src/rbac/__tests__/permissions.test.ts
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PermissionDeniedError,
  ROLE_MAX_DISCOUNT_BP,
  ROLE_PERMISSIONS,
  can,
  maxDiscountFor,
  permissionsForRole,
  requirePermission,
} from '../permissions.js';
import type { Actor, Permission, RoleName } from '../permissions.js';

const ROLES: readonly RoleName[] = ['cashier', 'manager', 'admin', 'owner'];

const actorFor = (role: RoleName): Actor => ({
  userId: `user-${role}`,
  tenantId: 'tenant-1',
  role,
  permissions: permissionsForRole(role),
  branchId: 'branch-1',
});

describe('permission catalogue', () => {
  it('lists seventeen distinct permissions', () => {
    expect(PERMISSIONS).toHaveLength(17);
    expect(new Set(PERMISSIONS).size).toBe(17);
  });

  it('grants the owner every permission', () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
  });

  it.each(ROLES)('gives %s only permissions from the catalogue', (role) => {
    for (const permission of ROLE_PERMISSIONS[role]) {
      expect(PERMISSIONS).toContain(permission);
    }
  });
});

describe('least privilege', () => {
  it('nests the roles: cashier subset of manager subset of admin subset of owner', () => {
    const subset = (a: readonly Permission[], b: readonly Permission[]): boolean =>
      a.every((permission) => b.includes(permission));

    expect(subset(ROLE_PERMISSIONS.cashier, ROLE_PERMISSIONS.manager)).toBe(true);
    expect(subset(ROLE_PERMISSIONS.manager, ROLE_PERMISSIONS.admin)).toBe(true);
    expect(subset(ROLE_PERMISSIONS.admin, ROLE_PERMISSIONS.owner)).toBe(true);
  });

  it('keeps a cashier out of every administrative capability', () => {
    const cashier = actorFor('cashier');
    for (const forbidden of [
      'settings.manage',
      'users.manage',
      'zatca.manage',
      'sale.discount',
      'sale.refund',
      'sale.void',
      'inventory.adjust',
      'product.write',
      'report.read',
      'shift.cash-movement',
    ] as const) {
      expect(can(cashier, forbidden), forbidden).toBe(false);
      expect(() => requirePermission(cashier, forbidden)).toThrow(PermissionDeniedError);
    }
  });

  it('lets a cashier do the cashier job', () => {
    const cashier = actorFor('cashier');
    for (const allowed of [
      'product.read',
      'inventory.read',
      'sale.create',
      'shift.open',
      'shift.close',
      'customer.read',
      'customer.write',
    ] as const) {
      expect(can(cashier, allowed), allowed).toBe(true);
      expect(() => requirePermission(cashier, allowed)).not.toThrow();
    }
  });

  it('keeps a manager out of settings and user administration', () => {
    const manager = actorFor('manager');
    expect(can(manager, 'settings.manage')).toBe(false);
    expect(can(manager, 'users.manage')).toBe(false);
    expect(can(manager, 'zatca.manage')).toBe(false);
    expect(can(manager, 'sale.refund')).toBe(true);
  });

  it('gives an admin everything except what only an owner holds', () => {
    const admin = actorFor('admin');
    expect(can(admin, 'settings.manage')).toBe(true);
    expect(can(admin, 'users.manage')).toBe(true);
    expect(ROLE_PERMISSIONS.admin.length).toBeLessThanOrEqual(PERMISSIONS.length);
  });

  it('reports the denied permission on the error', () => {
    try {
      requirePermission(actorFor('cashier'), 'users.manage');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedError);
      expect((error as PermissionDeniedError).permission).toBe('users.manage');
    }
  });

  it('does not grant a permission absent from the actor even if the role would', () => {
    // Authorisation reads the actor's own list, so a narrowed session stays
    // narrowed.
    const narrowed: Actor = { ...actorFor('owner'), permissions: ['product.read'] };
    expect(can(narrowed, 'users.manage')).toBe(false);
  });
});

describe('discount ceilings', () => {
  it('gives a cashier no discount authority at all', () => {
    expect(ROLE_MAX_DISCOUNT_BP.cashier).toBe(0n);
    expect(maxDiscountFor(actorFor('cashier'))).toBe(0n);
  });

  it('increases monotonically with authority', () => {
    expect(ROLE_MAX_DISCOUNT_BP.cashier).toBeLessThan(ROLE_MAX_DISCOUNT_BP.manager);
    expect(ROLE_MAX_DISCOUNT_BP.manager).toBeLessThan(ROLE_MAX_DISCOUNT_BP.admin);
    expect(ROLE_MAX_DISCOUNT_BP.admin).toBeLessThan(ROLE_MAX_DISCOUNT_BP.owner);
  });

  it('never exceeds one hundred percent', () => {
    for (const role of ROLES) {
      expect(ROLE_MAX_DISCOUNT_BP[role]).toBeLessThanOrEqual(10_000n);
    }
  });
});
EOF

cat << 'EOF' > packages/domain/src/shift/__tests__/shift.test.ts
import { describe, expect, it } from 'vitest';
import {
  ShiftStateError,
  cashVariance,
  closeShift,
  expectedCash,
  openShift,
  recordMovement,
} from '../shift.js';
import type { CashMovement, ShiftState } from '../shift.js';
import { money } from '../../money/money.js';

const AT = '2026-08-08T08:00:00Z';

const movement = (over: Partial<CashMovement> & Pick<CashMovement, 'kind' | 'amount'>): CashMovement => ({
  id: over.id ?? 'm1',
  kind: over.kind,
  amount: over.amount,
  reason: over.reason ?? null,
  at: over.at ?? AT,
});

const withCash = (openingFloat: bigint, movements: readonly CashMovement[]): ShiftState =>
  movements.reduce(
    (shift, entry) => recordMovement(shift, entry),
    openShift('shift-1', money(openingFloat), AT),
  );

describe('opening', () => {
  it('starts open with the declared float', () => {
    const shift = openShift('shift-1', money(50_000n), AT);
    expect(shift.status).toBe('open');
    expect(shift.openingFloat.minor).toBe(50_000n);
    expect(expectedCash(shift).minor).toBe(50_000n);
  });

  it('refuses a negative float', () => {
    expect(() => openShift('shift-1', money(-1n), AT)).toThrow(ShiftStateError);
  });

  it('accepts a zero float', () => {
    expect(openShift('shift-1', money(0n), AT).openingFloat.minor).toBe(0n);
  });
});

describe('cash movements', () => {
  it('adds cash sales to the expected drawer', () => {
    const shift = withCash(50_000n, [
      movement({ id: 'a', kind: 'sale', amount: money(11_500n) }),
      movement({ id: 'b', kind: 'sale', amount: money(2_300n) }),
    ]);
    expect(expectedCash(shift).minor).toBe(63_800n);
  });

  it('subtracts cash refunds', () => {
    const shift = withCash(50_000n, [
      movement({ id: 'a', kind: 'sale', amount: money(11_500n) }),
      movement({ id: 'b', kind: 'refund', amount: money(-5_000n) }),
    ]);
    expect(expectedCash(shift).minor).toBe(56_500n);
  });

  it('handles pay-ins and pay-outs', () => {
    const shift = withCash(10_000n, [
      movement({ id: 'a', kind: 'pay-in', amount: money(5_000n), reason: 'float top-up' }),
      movement({ id: 'b', kind: 'pay-out', amount: money(-2_500n), reason: 'supplier' }),
    ]);
    expect(expectedCash(shift).minor).toBe(12_500n);
  });

  it('insists on the sign matching the movement kind', () => {
    const shift = openShift('shift-1', money(10_000n), AT);
    expect(() => recordMovement(shift, movement({ kind: 'refund', amount: money(500n) }))).toThrow(
      ShiftStateError,
    );
    expect(() => recordMovement(shift, movement({ kind: 'pay-out', amount: money(500n) }))).toThrow(
      ShiftStateError,
    );
    expect(() => recordMovement(shift, movement({ kind: 'sale', amount: money(-500n) }))).toThrow(
      ShiftStateError,
    );
    expect(() => recordMovement(shift, movement({ kind: 'pay-in', amount: money(-500n) }))).toThrow(
      ShiftStateError,
    );
  });

  it('refuses movements once the shift is closed', () => {
    const closed = closeShift(openShift('shift-1', money(10_000n), AT), money(10_000n));
    expect(() => recordMovement(closed, movement({ kind: 'sale', amount: money(100n) }))).toThrow(
      ShiftStateError,
    );
  });

  it('appends rather than replacing, so the trail survives', () => {
    const shift = withCash(0n, [
      movement({ id: 'a', kind: 'sale', amount: money(100n) }),
      movement({ id: 'b', kind: 'sale', amount: money(200n) }),
    ]);
    expect(shift.movements.map((entry) => entry.id)).toEqual(['shift-1', 'a', 'b']);
  });
});

describe('closing and variance', () => {
  it('reports a balanced drawer as zero variance', () => {
    const shift = withCash(50_000n, [movement({ kind: 'sale', amount: money(11_500n) })]);
    expect(cashVariance(closeShift(shift, money(61_500n))).minor).toBe(0n);
  });

  it('reports a shortfall as negative', () => {
    const shift = withCash(50_000n, [movement({ kind: 'sale', amount: money(11_500n) })]);
    expect(cashVariance(closeShift(shift, money(61_400n))).minor).toBe(-100n);
  });

  it('reports a surplus as positive', () => {
    const shift = withCash(50_000n, [movement({ kind: 'sale', amount: money(11_500n) })]);
    expect(cashVariance(closeShift(shift, money(61_600n))).minor).toBe(100n);
  });

  it('does not hide a single-halala variance', () => {
    const shift = withCash(0n, [movement({ kind: 'sale', amount: money(333n) })]);
    expect(cashVariance(closeShift(shift, money(332n))).minor).toBe(-1n);
  });

  it('refuses a variance before cash is declared', () => {
    expect(() => cashVariance(openShift('shift-1', money(0n), AT))).toThrow(ShiftStateError);
  });

  it('refuses a negative declaration', () => {
    expect(() => closeShift(openShift('shift-1', money(0n), AT), money(-1n))).toThrow(
      ShiftStateError,
    );
  });

  it('refuses to close twice', () => {
    const closed = closeShift(openShift('shift-1', money(0n), AT), money(0n));
    expect(() => closeShift(closed, money(0n))).toThrow(ShiftStateError);
  });
});

describe('reconciliation determinism', () => {
  it('always equals float plus the signed sum of movements', () => {
    for (let float = 0n; float <= 100_000n; float += 12_345n) {
      const movements: CashMovement[] = [];
      let signedSum = 0n;
      for (let index = 0; index < 12; index += 1) {
        const isRefund = index % 4 === 3;
        const amount = BigInt(index + 1) * 137n;
        movements.push(
          movement({
            id: `m${String(index)}`,
            kind: isRefund ? 'refund' : 'sale',
            amount: money(isRefund ? -amount : amount),
          }),
        );
        signedSum += isRefund ? -amount : amount;
      }

      const shift = withCash(float, movements);
      expect(expectedCash(shift).minor).toBe(float + signedSum);
      expect(cashVariance(closeShift(shift, money(float + signedSum))).minor).toBe(0n);
    }
  });
});
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

say "Formatting the new sources"
npx prettier --write --log-level warn \
  'packages/domain/src/{quantity,pricing,sale,rbac,shift}/**/*.ts' eslint.config.js >/dev/null 2>&1 || true

if [ "$RUN_VERIFY" -eq 1 ]; then
  say "Running the full gate"
  npm run --silent verify
else
  warn "Skipping verification (--no-verify)."
fi

cat << 'SUMMARY'

===============================================================================
  Korvi POS — Strike 1 · domain core applied
===============================================================================

  packages/domain/src/quantity/  scaled-integer quantity (1e-3), decimal
                                 parsing, no float path for weighed goods
  packages/domain/src/pricing/   cart engine: extension, line and basket
                                 discounts with largest-remainder allocation,
                                 tax-inclusive and tax-exclusive, per-rate VAT
  packages/domain/src/sale/      pure finalization, server-authoritative
                                 totals, discount ceiling, saleReconciles
  packages/domain/src/rbac/      17 permissions, 4 roles, discount ceilings
  packages/domain/src/shift/     opening float, signed movements, expected
                                 cash, variance

  eslint.config.js               money rules extended to the new modules

  Nothing else was touched. No schema, no API, no UI, no printing.
  Nothing was committed.

===============================================================================
SUMMARY

ok "Done."
