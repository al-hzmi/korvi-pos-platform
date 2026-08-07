import { describe, expect, it } from 'vitest';
import { grossFromNet, netFromGross, taxFromGross, taxFromNet } from '../vat.js';
import { VAT_STANDARD_BP, VAT_ZERO_BP, basisPoints } from '../basis-points.js';
import { money, moneyToMajorString } from '../../money/money.js';

describe('VAT', () => {
  it('adds 15% to a net amount', () => {
    expect(taxFromNet(money(10_000n), VAT_STANDARD_BP).minor).toBe(1_500n);
    expect(grossFromNet(money(10_000n), VAT_STANDARD_BP).minor).toBe(11_500n);
  });

  it('extracts 15% from a gross amount', () => {
    expect(taxFromGross(money(11_500n), VAT_STANDARD_BP).minor).toBe(1_500n);
    expect(netFromGross(money(11_500n), VAT_STANDARD_BP).minor).toBe(10_000n);
  });

  it('keeps net plus tax exactly equal to gross on awkward amounts', () => {
    for (const netMinor of [1n, 7n, 33n, 99n, 12_345n, 999_999n]) {
      const gross = grossFromNet(money(netMinor), VAT_STANDARD_BP);
      // Extraction may differ by a halala from the original after rounding;
      // what must hold is that the parts always reconstitute the whole.
      expect(
        netFromGross(gross, VAT_STANDARD_BP).minor + taxFromGross(gross, VAT_STANDARD_BP).minor,
      ).toBe(gross.minor);
    }
  });

  it('formats to two decimals', () => {
    expect(moneyToMajorString(taxFromNet(money(3_333n), VAT_STANDARD_BP))).toBe('5.00');
  });

  it('treats a zero rate as a no-op', () => {
    expect(taxFromNet(money(5_000n), VAT_ZERO_BP).minor).toBe(0n);
    expect(grossFromNet(money(5_000n), VAT_ZERO_BP).minor).toBe(5_000n);
  });

  it('handles a non-standard but valid rate', () => {
    // 5% — the rate before the 2020 increase, and still what a historical
    // reprint of an old invoice has to reproduce.
    expect(taxFromNet(money(10_000n), basisPoints(500n)).minor).toBe(500n);
  });

  it('rounds half up rather than truncating', () => {
    // 33 halalas at 15% is 4.95 halalas; the merchant charges 5.
    expect(taxFromNet(money(33n), VAT_STANDARD_BP).minor).toBe(5n);
  });
});
