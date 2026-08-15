import { describe, expect, it } from 'vitest';
import {
  MAX_NEW_PASSWORD_LENGTH,
  MIN_NEW_PASSWORD_CODE_POINTS,
  WeakCredentialError,
  assertNewPasswordAcceptable,
  effectiveNewPassword,
  isNewPasswordAcceptable,
} from '../policy.js';

/**
 * Every character that matters here is written as an escape.
 *
 * These tests are about the difference between two spellings of the same text,
 * and a literal `é` in a source file is exactly the ambiguity under test:
 * an editor, a formatter or a copy-paste can normalise it and quietly turn the
 * adversarial case into the benign one.
 */
const FULLWIDTH_A = 'ａ'; // NFKC -> 'a'
const COMBINING_ACUTE = '́'; // 'e' + this -> NFKC 'é'
const LIGATURE_FI = 'ﬁ'; // NFKC -> 'fi'
const PBUH = 'ﷺ'; // NFKC -> eighteen code points

describe('credential creation policy', () => {
  it('accepts an ordinary passphrase and refuses a short one', () => {
    expect(() => assertNewPasswordAcceptable('a-real-password-9!')).not.toThrow();
    expect(() => assertNewPasswordAcceptable('short1!')).toThrow(WeakCredentialError);
  });

  it('counts code points, so a non-Latin passphrase is measured as typed', () => {
    // Twelve UTF-16 units but six characters. `.length` would have accepted it.
    expect(isNewPasswordAcceptable('😀😀😀😀😀😁')).toBe(false);
    expect(isNewPasswordAcceptable('كلمة-مرور-طويلة-كفاية')).toBe(true);
  });

  it('refuses whitespace and a single repeated character', () => {
    expect(isNewPasswordAcceptable(' '.repeat(MIN_NEW_PASSWORD_CODE_POINTS + 2))).toBe(false);
    expect(isNewPasswordAcceptable('a'.repeat(MIN_NEW_PASSWORD_CODE_POINTS + 2))).toBe(false);
  });

  it('bounds the input, because scrypt over an unbounded string is a cost', () => {
    expect(isNewPasswordAcceptable(`a${'b'.repeat(MAX_NEW_PASSWORD_LENGTH - 1)}`)).toBe(true);
    expect(isNewPasswordAcceptable(`a${'b'.repeat(MAX_NEW_PASSWORD_LENGTH)}`)).toBe(false);
  });
});

/**
 * The policy must judge the string scrypt will actually see.
 *
 * `hashPassword` and `verifyPassword` both derive from `password.normalize('NFKC')`
 * (ADR-0012), so a rule applied to the raw input is a rule about a string that no
 * stored hash corresponds to. Each case below passes every raw check and then
 * collapses into something the policy exists to refuse.
 */
describe('the policy judges the NFKC value that is actually hashed', () => {
  it('sees through compatibility characters posing as distinct ones', () => {
    // Raw, this is twelve code points drawn from two distinct characters, which
    // satisfies both the length rule and the repeated-character rule. NFKC folds
    // every fullwidth `a` to `a`, so what reaches scrypt is `a` twelve times.
    const disguised = `a${FULLWIDTH_A}`.repeat(6);
    expect([...disguised]).toHaveLength(12);
    expect(new Set([...disguised]).size).toBe(2);

    expect(effectiveNewPassword(disguised)).toBe('a'.repeat(12));
    expect(isNewPasswordAcceptable(disguised)).toBe(false);
    // Refused for the right reason, rather than incidentally by length.
    expect(() => assertNewPasswordAcceptable(disguised)).toThrow(/one character repeated/);
  });

  it('sees through combining marks that compose away', () => {
    // Twelve code points raw; NFKC composes each pair, leaving six.
    const decomposed = `e${COMBINING_ACUTE}`.repeat(6);
    expect([...decomposed]).toHaveLength(12);
    expect([...effectiveNewPassword(decomposed)]).toHaveLength(6);

    expect(isNewPasswordAcceptable(decomposed)).toBe(false);
    expect(() => assertNewPasswordAcceptable(decomposed)).toThrow(/at least/);
  });

  it('bounds the value after normalising, because NFKC can expand', () => {
    // One code point that NFKC expands to eighteen. A raw-only ceiling is not a
    // ceiling on what reaches the key derivation.
    expect([...effectiveNewPassword(PBUH)]).toHaveLength(18);

    const belowRawCeiling = PBUH.repeat(MAX_NEW_PASSWORD_LENGTH - 1);
    expect(belowRawCeiling.length).toBeLessThanOrEqual(MAX_NEW_PASSWORD_LENGTH);
    expect(effectiveNewPassword(belowRawCeiling).length).toBeGreaterThan(MAX_NEW_PASSWORD_LENGTH);
    expect(isNewPasswordAcceptable(belowRawCeiling)).toBe(false);
  });

  it('gives one verdict to every spelling of the same credential', () => {
    // The property underneath all three cases above: two inputs that fold to the
    // same bytes are the same credential, and cannot be answered differently.
    const pairs: readonly (readonly [string, string])[] = [
      [`cafe${COMBINING_ACUTE}-passphrase`, 'café-passphrase'],
      [`${LIGATURE_FI}nal-passphrase`, 'final-passphrase'],
      [`a${FULLWIDTH_A}`.repeat(6), 'a'.repeat(12)],
    ];

    for (const [a, b] of pairs) {
      expect(effectiveNewPassword(a)).toBe(effectiveNewPassword(b));
      expect(isNewPasswordAcceptable(a)).toBe(isNewPasswordAcceptable(b));
    }
  });
});
