/** Base class for printing failures Korvi raises deliberately. */
export class PrintingError extends Error {
  public override readonly name: string = 'PrintingError';

  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A character cannot be represented in the selected code page.
 *
 * Raised instead of substituting: a receipt that quietly prints the wrong
 * glyph is worse than one that refuses, because nobody notices the first.
 */
export class UnsupportedCharacterError extends PrintingError {
  public override readonly name = 'UnsupportedCharacterError';
}

/**
 * The profile needs a capability nothing has supplied.
 *
 * Typically a raster-only device with no RasterRenderer injected. Failing here
 * is the whole point of the profile model: the alternative is emitting bytes
 * the device will print as garbage.
 */
export class MissingCapabilityError extends PrintingError {
  public override readonly name = 'MissingCapabilityError';
}
