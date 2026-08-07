import { describe, expect, it } from 'vitest';
import { canGiveChange, settle } from '../tender.js';
import { money } from '../../money/money.js';
import { NonCashChangeError, UnderpaidError } from '../../errors.js';

describe('tender rules', () => {
  it('knows only cash returns change', () => {
    expect(canGiveChange('cash')).toBe(true);
    expect(canGiveChange('card')).toBe(false);
    expect(canGiveChange('mada')).toBe(false);
    expect(canGiveChange('transfer')).toBe(false);
  });
});

describe('settle', () => {
  it('settles an exact cash payment with no change', () => {
    const result = settle(money(5_000n), [{ kind: 'cash', amount: money(5_000n) }]);
    expect(result.change.minor).toBe(0n);
    expect(result.changeFrom).toBeNull();
  });

  it('returns change from cash on an overpayment', () => {
    const result = settle(money(4_750n), [{ kind: 'cash', amount: money(5_000n) }]);
    expect(result.change.minor).toBe(250n);
    expect(result.changeFrom).toBe('cash');
  });

  it('splits card and cash, giving change from the cash portion', () => {
    const result = settle(money(10_000n), [
      { kind: 'mada', amount: money(6_000n) },
      { kind: 'cash', amount: money(5_000n) },
    ]);
    expect(result.change.minor).toBe(1_000n);
    expect(result.changeFrom).toBe('cash');
  });

  it('refuses a card tender larger than the amount due', () => {
    expect(() => settle(money(10_000n), [{ kind: 'card', amount: money(10_001n) }])).toThrow(
      NonCashChangeError,
    );
  });

  it('refuses card plus mada exceeding the amount due even when each is under it', () => {
    expect(() =>
      settle(money(10_000n), [
        { kind: 'card', amount: money(6_000n) },
        { kind: 'mada', amount: money(6_000n) },
      ]),
    ).toThrow(NonCashChangeError);
  });

  it('accepts a card tender for exactly the amount due', () => {
    const result = settle(money(10_000n), [{ kind: 'card', amount: money(10_000n) }]);
    expect(result.change.minor).toBe(0n);
  });

  it('refuses an underpayment', () => {
    expect(() => settle(money(10_000n), [{ kind: 'cash', amount: money(9_999n) }])).toThrow(
      UnderpaidError,
    );
  });

  it('refuses negative amounts', () => {
    expect(() => settle(money(-1n), [{ kind: 'cash', amount: money(0n) }])).toThrow(UnderpaidError);
    expect(() => settle(money(10n), [{ kind: 'cash', amount: money(-10n) }])).toThrow(
      UnderpaidError,
    );
  });
});
