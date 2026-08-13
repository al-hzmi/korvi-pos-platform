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

/**
 * A drawer operation was refused while its shift row was held.
 *
 * Every detail here is decided under `SELECT ... FOR UPDATE`, which is what
 * makes it an answer rather than a guess: `shift-closed` means the close
 * committed first, not that a stale read thought so (ADR-0017).
 */
export class DrawerRefusedError extends DatabaseError {
  public override readonly name = 'DrawerRefusedError';
  public readonly detail:
    'unknown-shift' | 'shift-closed' | 'branch-mismatch' | 'terminal-mismatch' | 'not-owner';

  public constructor(
    detail:
      'unknown-shift' | 'shift-closed' | 'branch-mismatch' | 'terminal-mismatch' | 'not-owner',
  ) {
    super(`Drawer operation refused: ${detail}`);
    this.detail = detail;
  }
}
