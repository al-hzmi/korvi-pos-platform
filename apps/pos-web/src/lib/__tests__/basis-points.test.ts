import { describe, expect, it } from 'vitest';
import { formatBasisPoints } from '../basis-points';

describe('basis point display', () => {
  it('renders the rates a Saudi merchant actually charges', () => {
    expect(formatBasisPoints(1500)).toBe('15%');
    expect(formatBasisPoints(0)).toBe('0%');
    expect(formatBasisPoints(10_000)).toBe('100%');
  });

  it('renders a half and a quarter of a percent exactly', () => {
    expect(formatBasisPoints(750)).toBe('7.5%');
    expect(formatBasisPoints(725)).toBe('7.25%');
    expect(formatBasisPoints(1)).toBe('0.01%');
    expect(formatBasisPoints(10)).toBe('0.1%');
    expect(formatBasisPoints(505)).toBe('5.05%');
  });

  it('never produces the artefacts float division would', () => {
    // The whole point of the exercise: every rate in range renders as a
    // decimal that reads back to the same integer.
    for (let bp = 0; bp <= 10_000; bp += 1) {
      const rendered = formatBasisPoints(bp);
      expect(rendered.endsWith('%')).toBe(true);
      expect(rendered).not.toContain('e');
      const [whole, fraction = ''] = rendered.slice(0, -1).split('.');
      expect(Number(whole) * 100 + Number(fraction.padEnd(2, '0'))).toBe(bp);
    }
  });

  it('refuses anything that is not a rate', () => {
    expect(() => formatBasisPoints(15.5)).toThrow(TypeError);
    expect(() => formatBasisPoints(-1)).toThrow(RangeError);
    expect(() => formatBasisPoints(10_001)).toThrow(RangeError);
  });
});
