/** Base class for every failure the domain raises deliberately. */
export class DomainError extends Error {
  public override readonly name: string = 'DomainError';

  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A money operation mixed two currencies. */
export class CurrencyMismatchError extends DomainError {
  public override readonly name = 'CurrencyMismatchError';
}

/** An amount or weight was outside the range the operation accepts. */
export class InvalidAmountError extends DomainError {
  public override readonly name = 'InvalidAmountError';
}

/**
 * A non-cash tender was offered for more than the amount due.
 *
 * Named for the rule it protects: a card or Mada terminal cannot hand back
 * change, so an overpayment on those rails has nowhere to go (ADR-0002).
 */
export class NonCashChangeError extends DomainError {
  public override readonly name = 'NonCashChangeError';
}

/** The tendered total did not cover the amount due. */
export class UnderpaidError extends DomainError {
  public override readonly name = 'UnderpaidError';
}

/** A value could not be encoded into the ZATCA TLV envelope. */
export class TlvEncodingError extends DomainError {
  public override readonly name = 'TlvEncodingError';
}

/**
 * An identifier could not be issued without breaking ordering.
 *
 * Raised rather than returning a plausible-looking id, because an identifier
 * that sorts before one already written corrupts the sale sequence silently
 * and permanently (ADR-0003).
 */
export class IdGenerationError extends DomainError {
  public override readonly name = 'IdGenerationError';
}

/** A rate was outside the range its unit permits. */
export class InvalidRateError extends DomainError {
  public override readonly name = 'InvalidRateError';
}

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
