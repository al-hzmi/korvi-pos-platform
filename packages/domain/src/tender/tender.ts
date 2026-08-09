import { InvalidTenderError, NonCashChangeError, UnderpaidError } from '../errors.js';
import { compareMoney, subtractMoney, sumMoney, zero } from '../money/money.js';
import type { Money } from '../money/money.js';

/**
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
}

/**
 * Only cash can give change back.
 *
 * A card terminal settles the exact amount it was asked for; there is no
 * mechanism by which it returns money to the customer. Encoding that as data
 * rather than an `if` keeps the rule in one place when wallets are added.
 */
export const CHANGE_CAPABLE_TENDERS: readonly TenderKind[] = ['cash'];

export function canGiveChange(kind: TenderKind): boolean {
  return CHANGE_CAPABLE_TENDERS.includes(kind);
}

export interface TenderLine {
  readonly kind: TenderKind;
  readonly amount: Money;
  /** Present on `electronic` and on nothing else. */
  readonly scheme?: TenderScheme;
  /** The external approval this settlement record points at. */
  readonly reference?: string;
}

export interface Settlement {
  readonly due: Money;
  readonly tendered: Money;
  /** Always drawn from cash. Zero when the payment was exact. */
  readonly change: Money;
  readonly changeFrom: TenderKind | null;
}

/**
 * Settle a sale against one or more tenders.
 *
 * The guard that matters: non-cash tenders may not exceed the amount due. The
 * cashier is expected to key the card amount first and let cash absorb the
 * remainder, which is also how the physical workflow runs.
 */
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

export function settle(due: Money, lines: readonly TenderLine[]): Settlement {
  if (due.minor < 0n) {
    throw new UnderpaidError('Amount due must not be negative.');
  }

  const currency = due.currency;
  const tendered = sumMoney(
    lines.map((line) => line.amount),
    currency,
  );

  for (const line of lines) {
    if (line.amount.minor < 0n) {
      throw new UnderpaidError(`Tender ${line.kind} must not be negative.`);
    }
  }

  const nonCash = sumMoney(
    lines.filter((line) => !canGiveChange(line.kind)).map((line) => line.amount),
    currency,
  );

  if (compareMoney(nonCash, due) > 0) {
    throw new NonCashChangeError(
      'Non-cash tenders exceed the amount due, and only cash can return change.',
    );
  }

  if (compareMoney(tendered, due) < 0) {
    throw new UnderpaidError('Tendered total does not cover the amount due.');
  }

  const change = subtractMoney(tendered, due);
  return {
    due,
    tendered,
    change,
    changeFrom: change.minor > 0n ? 'cash' : null,
  };
}

export function isSettled(settlement: Settlement): boolean {
  return compareMoney(settlement.tendered, settlement.due) >= 0;
}

export function noChange(currency: Money['currency'] = 'SAR'): Money {
  return zero(currency);
}
