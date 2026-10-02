/**
 * The shape every parser in the till returns.
 *
 * A thrown exception is the wrong tool for "the cashier has typed 1.2 so far":
 * that is an ordinary keystroke on the way to a valid number, not an error.
 */
export type ParseFailure = 'empty' | 'format' | 'precision' | 'not-positive' | 'zero';

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: ParseFailure };

export function parsed<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

export function unparsed<T>(reason: ParseFailure): Parsed<T> {
  return { ok: false, reason };
}
