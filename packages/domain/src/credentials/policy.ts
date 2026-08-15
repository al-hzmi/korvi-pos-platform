import { DomainError } from '../errors.js';

/**
 * What Korvi will accept as a *newly created* password.
 *
 * Deliberately a credential-creation policy rather than a bootstrap rule. The
 * question "is this an acceptable new password" is the same question at owner
 * bootstrap, at a future staff invitation and at a future password change, and
 * a rule that lives inside one of those is a rule the next two will re-invent
 * slightly differently.
 *
 * Equally deliberately, this is **not** applied at login. Login compares a
 * presented secret against a stored hash; running a strength check there would
 * lock out every account whose password predates the policy, which is a
 * self-inflicted outage rather than a security improvement. Strength is a
 * question about a password being *set*, and it is asked exactly there.
 *
 * ## The policy judges the string that actually gets hashed
 *
 * Korvi's hasher and verifier both derive from `password.normalize('NFKC')`
 * (ADR-0012), so NFKC is not an implementation detail this policy may ignore —
 * it is the credential. A rule applied to the raw input would be measuring a
 * string that no stored hash corresponds to, and the gap between the two is
 * exploitable in both directions:
 *
 *   - `a` alternating with `ａ` (U+FF41, fullwidth) looks like two distinct
 *     characters and folds to one repeated character;
 *   - `e` + U+0301 is two code points that compose to one, so a "twelve
 *     character" passphrase can be six.
 *
 * Both would pass a raw check and then collapse. So the strength rules below
 * run against the **effective** value, and the caller still hands the original
 * string to `hashPassword`, which normalises it identically.
 */

export class WeakCredentialError extends DomainError {
  public override readonly name = 'WeakCredentialError';
}

/**
 * Twelve, counted in code points.
 *
 * `.length` counts UTF-16 units, so an emoji or a rare CJK character would
 * count as two and a twelve-character passphrase in those scripts would be
 * accepted at what is really six. Counting code points measures what a person
 * typed.
 */
export const MIN_NEW_PASSWORD_CODE_POINTS = 12;

/**
 * The same ceiling the login route already applies, and for the same reason:
 * scrypt over an unbounded input is a denial of service with a free tier.
 */
export const MAX_NEW_PASSWORD_LENGTH = 1024;

function codePoints(value: string): number {
  return [...value].length;
}

/**
 * The string the hasher will actually derive from.
 *
 * Exported because a caller that wants to explain a refusal, or to reason about
 * what it is storing, should be able to ask rather than re-derive — and because
 * a second `.normalize('NFKC')` written out somewhere else is a second thing
 * that can drift from `hashPassword`.
 */
export function effectiveNewPassword(password: string): string {
  return password.normalize('NFKC');
}

/**
 * Refuse a new password Korvi should not be storing a hash of.
 *
 * Three strength rules, and no dictionary: length, not-only-whitespace, and not
 * one character repeated. A blocklist would be a data file to maintain, a
 * network call, or both, and none of the three is in scope here — what is in
 * scope is that a merchant's first Owner credential cannot be `1234` or a
 * held-down space bar.
 *
 * Bounded twice, before and after normalising. Before, because `normalize` over
 * an unbounded string is itself unbounded work on a public endpoint; after,
 * because NFKC can *expand* — U+FDFA is one code point that becomes eighteen —
 * so a raw-only ceiling is not a ceiling on what reaches scrypt.
 */
export function assertNewPasswordAcceptable(password: string): void {
  if (password.length > MAX_NEW_PASSWORD_LENGTH) {
    throw new WeakCredentialError('That password is too long.');
  }

  const effective = effectiveNewPassword(password);
  if (effective.length > MAX_NEW_PASSWORD_LENGTH) {
    throw new WeakCredentialError('That password is too long.');
  }

  if (codePoints(effective) < MIN_NEW_PASSWORD_CODE_POINTS) {
    throw new WeakCredentialError(
      `A new password must be at least ${MIN_NEW_PASSWORD_CODE_POINTS} characters.`,
    );
  }
  if (effective.trim() === '') {
    throw new WeakCredentialError('A password cannot be only whitespace.');
  }
  const distinct = new Set([...effective]);
  if (distinct.size === 1) {
    throw new WeakCredentialError('A password cannot be one character repeated.');
  }
}

/** The boolean form, for a caller that is choosing rather than enforcing. */
export function isNewPasswordAcceptable(password: string): boolean {
  try {
    assertNewPasswordAcceptable(password);
    return true;
  } catch {
    return false;
  }
}
