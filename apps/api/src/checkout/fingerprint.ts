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
