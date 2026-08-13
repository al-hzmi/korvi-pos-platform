import { createHash } from 'node:crypto';

/**
 * What a drawer request says it wants to happen.
 *
 * Only the material intent, plus the two facts that say *whose* intent it is.
 *
 * Nothing the server *derives from the request* is in here — not the signed
 * amount, not the expected cash, not the variance, not the closing time —
 * because those are consequences of the request rather than part of it, and
 * including one would make a lawful retry hash differently.
 *
 * The actor and the branch are different: they are not derived from the
 * request at all, they are the context the request arrived in, and they come
 * from the session and the terminal lookup rather than from the body. Binding
 * them is what stops one operation id being shared across identities. Without
 * them, a second cashier replaying a colleague's close would be handed that
 * colleague's reconciliation, and a manager reusing another manager's
 * operation id would silently inherit their movement — an identity swap
 * wearing a retry's clothes (ADR-0017).
 *
 * The reason *is* intent on a manual movement: "petty cash for the van" and
 * "float top-up" are two different facts about the same drawer, and a retry
 * that changed the reason is a different movement wearing the first one's
 * name. It is compared after trimming, so whitespace a client added is not
 * treated as a new transaction.
 */
export interface ManualMovementIntent {
  /** From the session. Never from the request body. */
  readonly actorUserId: string;
  /** From the terminal lookup, which is itself pinned to the session's branch. */
  readonly branchId: string;
  readonly shiftId: string;
  readonly terminalId: string;
  readonly kind: string;
  /** The public magnitude, exactly as sent. */
  readonly amountMinor: string;
  readonly reason: string;
}

export interface ShiftCloseIntent {
  /** From the session. Never from the request body. */
  readonly actorUserId: string;
  /** From the terminal lookup, which is itself pinned to the session's branch. */
  readonly branchId: string;
  readonly shiftId: string;
  readonly terminalId: string;
  readonly declaredCashMinor: string;
}

function digest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/**
 * `v2` because the actor and the branch joined the canonical form. A key
 * minted under v1 hashes differently and is therefore treated as a different
 * intent, which is the safe direction: a conflict is visible, a false replay
 * is not.
 *
 * Structured JSON rather than a joined string, for the reason the checkout
 * fingerprint spells out: a reason is free text and may contain any separator
 * a hand-rolled encoding might pick, so the separators must come from the
 * encoding and never from field content.
 */
export function fingerprintManualMovement(intent: ManualMovementIntent): string {
  return digest(
    JSON.stringify([
      'drawer.movement.v2',
      intent.actorUserId,
      intent.branchId,
      intent.shiftId,
      intent.terminalId,
      intent.kind,
      intent.amountMinor,
      intent.reason,
    ]),
  );
}

export function fingerprintShiftClose(intent: ShiftCloseIntent): string {
  return digest(
    JSON.stringify([
      'drawer.close.v2',
      intent.actorUserId,
      intent.branchId,
      intent.shiftId,
      intent.terminalId,
      intent.declaredCashMinor,
    ]),
  );
}
