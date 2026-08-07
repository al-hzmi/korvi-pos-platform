import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY, nextRetryDelayMs } from '../offline.js';
import { codeReverse } from '../search.js';

describe('retry policy', () => {
  it('starts at five minutes and backs off', () => {
    expect(nextRetryDelayMs(DEFAULT_RETRY_POLICY, 1)).toBe(300_000);
    expect(nextRetryDelayMs(DEFAULT_RETRY_POLICY, 2)).toBe(600_000);
    expect(nextRetryDelayMs(DEFAULT_RETRY_POLICY, 3)).toBe(1_200_000);
  });

  it('never exceeds the ceiling', () => {
    expect(nextRetryDelayMs(DEFAULT_RETRY_POLICY, 50)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it('treats attempt zero as the first attempt', () => {
    expect(nextRetryDelayMs(DEFAULT_RETRY_POLICY, 0)).toBe(300_000);
  });
});

describe('codeReverse', () => {
  it('reverses so a suffix query becomes a prefix query', () => {
    expect(codeReverse('6281007041016')).toBe('6101407001826');
    expect(codeReverse('')).toBe('');
  });

  it('is its own inverse', () => {
    expect(codeReverse(codeReverse('ABC123'))).toBe('ABC123');
  });
});
