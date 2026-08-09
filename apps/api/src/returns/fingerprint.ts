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
