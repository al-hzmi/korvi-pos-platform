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
  /** Empty string for non-restaurant checkout; otherwise the recorded operational service mode. */
  readonly orderType: string;
  /** Empty except for a dine-in sale bound to a table. */
  readonly tableId: string;
  /** Empty for direct sales; otherwise the open operational order being settled. */
  readonly restaurantOrderId: string;
  /** Empty for direct sales; optimistic lifecycle precondition for an open order. */
  readonly restaurantOrderRevision: string;
  readonly lines: readonly CheckoutIntentLine[];
  readonly tenders: readonly CheckoutIntentTender[];
  /** Canonical normalized coupon codes. Order is not material. */
  readonly couponCodes?: readonly string[];
  /** True only when this intent was captured offline; it can only tighten authority. */
  readonly offlineCaptured?: boolean;
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
 * `v7` because the offline-captured boundary joined the canonical form. A
 * delayed sale cannot replay as an ordinary online sale under the same key.
 *
 * `v6` because coupon activation intent joined the canonical form. Server-owned
 * automatic promotion policy is deliberately absent: policy is authority, not
 * client intent.
 *
 * `v5` because open-order identity + revision joined the canonical form. An
 * order settlement cannot replay as a direct sale, or against a later revision.
 *
 * `v4` introduced dine-in table identity after service mode.
 *
 * `v3` introduced restaurant service mode after payment
 * composition. A key minted under an earlier version hashes differently and is
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

  const couponCodes = [...(intent.couponCodes ?? [])].sort();

  const canonical = JSON.stringify([
    'v7',
    intent.branchId,
    intent.terminalId,
    intent.orderType,
    intent.tableId,
    intent.restaurantOrderId,
    intent.restaurantOrderRevision,
    intent.basketDiscount,
    couponCodes,
    intent.offlineCaptured === true,
    tenders,
    lines,
  ]);

  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}
