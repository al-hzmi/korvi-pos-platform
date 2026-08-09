import { describe, expect, it } from 'vitest';
import { InvalidTenderError } from '../../errors.js';
import { money } from '../../money/money.js';
import { assertTenderComposition, looksLikeCardNumber } from '../tender.js';

/**
 * Synthetic test numbers only. These are the industry's published
 * never-issued values; none of them belongs to anybody.
 */
const TEST_PANS = [
  '4111111111111111',
  '5555555555554444',
  '378282246310005',
  '4111 1111 1111 1111',
  '4111-1111-1111-1111',
];

const APPROVALS = ['004512', 'AUTH-77', 'A1B2C3', '123456', '00000000', '4111111111111112'];

describe('looksLikeCardNumber', () => {
  it.each(TEST_PANS)('recognises %s', (value) => {
    expect(looksLikeCardNumber(value)).toBe(true);
  });

  it.each(APPROVALS)('leaves the ordinary approval code %s alone', (value) => {
    // The last one is a 16-digit value that fails Luhn: length alone is not
    // the test, or half the reference codes in the world become unusable.
    expect(looksLikeCardNumber(value)).toBe(false);
  });

  it('is not fooled by separators', () => {
    expect(looksLikeCardNumber(' 4111  1111-1111 1111 ')).toBe(true);
  });
});

describe('the tender guard', () => {
  it('refuses a card number hiding in the approval reference', () => {
    // A broken integration will put one here long before it puts one in a
    // field called `pan`, and Korvi would otherwise persist it.
    expect(() => {
      assertTenderComposition([
        {
          kind: 'electronic',
          scheme: 'visa',
          reference: '4111111111111111',
          amount: money(1_000n),
        },
      ]);
    }).toThrow(InvalidTenderError);
  });

  it('says nothing about the value it refused', () => {
    try {
      assertTenderComposition([
        {
          kind: 'electronic',
          scheme: 'visa',
          reference: '4111111111111111',
          amount: money(1_000n),
        },
      ]);
      throw new Error('expected a refusal');
    } catch (error) {
      // The message is read by a developer fixing an integration. It must not
      // become the place the number gets written down.
      expect((error as Error).message).not.toContain('4111');
    }
  });

  it('still accepts a real approval code', () => {
    expect(() => {
      assertTenderComposition([
        { kind: 'electronic', scheme: 'mada', reference: '004512', amount: money(1_000n) },
      ]);
    }).not.toThrow();
  });
});
