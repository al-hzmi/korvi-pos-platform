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

/**
 * A shift could not be opened on this terminal.
 *
 * `branch-inactive` is distinct from `unknown-terminal` because it is a
 * different fact and a different remedy: the till is addressable and the branch
 * it belongs to has been stood down. Reporting it as "unknown" would send a
 * cashier looking for a till that is right in front of them (ADR-0019).
 */
export class ShiftOpenRefusedError extends DatabaseError {
  public override readonly name = 'ShiftOpenRefusedError';
  public readonly detail: 'unknown-terminal' | 'already-open' | 'branch-inactive';

  public constructor(detail: 'unknown-terminal' | 'already-open' | 'branch-inactive') {
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
 * A provisioning request could not create a tenant, and must not be retried
 * unchanged.
 *
 * Every detail is decided after a unique index has already spoken, so none of
 * them is a guess about a race:
 *
 *   slug-taken          another tenant already holds the requested slug, and a
 *                       different operation created it.
 *   operation-id-reused this operation id created a tenant under a different
 *                       slug. Reusing it here would silently hand back that
 *                       other merchant.
 *   request-mismatch    this operation id created *this* tenant, but the
 *                       request now says something materially different. A
 *                       retry that changed its mind is not a retry.
 *
 * `invalid-slug` and `invalid-name` are decided before anything is written:
 * the request was never well-formed enough to race with.
 */
export type TenantProvisioningRefusal =
  'invalid-slug' | 'invalid-name' | 'slug-taken' | 'operation-id-reused' | 'request-mismatch';

export class TenantProvisioningError extends DatabaseError {
  public override readonly name = 'TenantProvisioningError';
  public readonly detail: TenantProvisioningRefusal;

  public constructor(detail: TenantProvisioningRefusal) {
    super(`Tenant provisioning refused: ${detail}`);
    this.detail = detail;
  }
}

/**
 * A lifecycle transition was refused while the tenant row was held.
 *
 * `illegal-transition` is the state machine speaking — the tenant exists, and
 * the move it was asked to make does not start where it is. It is deliberately
 * distinct from `unknown-tenant`, because a control-plane operator is not an
 * untrusted caller and telling them apart costs nothing here (ADR-0018).
 */
export type TenantLifecycleRefusal =
  'unknown-tenant' | 'illegal-transition' | 'idempotency-conflict';

export class TenantLifecycleRefusedError extends DatabaseError {
  public override readonly name = 'TenantLifecycleRefusedError';
  public readonly detail: TenantLifecycleRefusal;

  public constructor(detail: TenantLifecycleRefusal) {
    super(`Tenant lifecycle refused: ${detail}`);
    this.detail = detail;
  }
}

/**
 * A merchant-administration change was refused.
 *
 * Every detail is decided inside the transaction that would have made the
 * change, most of them while the tenant row is held, so none is a guess:
 *
 *   unknown-branch / unknown-terminal / unknown-member / unknown-role
 *                        the thing named does not exist *in this tenant*. A row
 *                        belonging to another merchant answers identically to
 *                        one that does not exist, because telling them apart
 *                        would turn a guessed id into a probe.
 *   code-taken           another branch or till in this tenant already holds
 *                        that code.
 *   email-taken          another user in this tenant already holds that email.
 *   branch-in-use        the branch or till still has an open shift, so
 *                        deactivating it now would strand a drawer nobody has
 *                        counted. Refused rather than silently repaired.
 *   branch-inactive      the parent branch is stood down, so a till under it
 *                        cannot be created or switched on. Deliberately not
 *                        reported as `branch-in-use`: claiming an open shift
 *                        exists when none does sends the merchant hunting for
 *                        a drawer to close.
 *   invalid-cursor       a malformed or over-bounded continuation token.
 *                        Refused rather than treated as "start again", so a
 *                        client paging with a corrupted cursor is told.
 *   last-administrator   the change would leave this merchant with nobody able
 *                        to administer it (ADR-0019).
 */
export type MerchantAdminRefusal =
  | 'unknown-branch'
  | 'unknown-terminal'
  | 'unknown-member'
  | 'unknown-role'
  | 'code-taken'
  | 'email-taken'
  | 'branch-in-use'
  | 'branch-inactive'
  | 'invalid-cursor'
  | 'last-administrator';

export class MerchantAdminRefusedError extends DatabaseError {
  public override readonly name = 'MerchantAdminRefusedError';
  public readonly detail: MerchantAdminRefusal;

  public constructor(detail: MerchantAdminRefusal) {
    super(`Merchant administration refused: ${detail}`);
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

/**
 * A control-plane plan assignment was refused while the tenant row was held.
 *
 * The operation id is scoped to one tenant. Reusing it with different
 * commercial intent is never interpreted as a new request.
 */
export type PlanEntitlementRefusal = 'unknown-tenant' | 'idempotency-conflict';

export class PlanEntitlementRefusedError extends DatabaseError {
  public override readonly name = 'PlanEntitlementRefusedError';
  public readonly detail: PlanEntitlementRefusal;

  public constructor(detail: PlanEntitlementRefusal) {
    super(`Plan entitlement operation refused: ${detail}`);
    this.detail = detail;
  }
}
