import { describe, expect, it } from 'vitest';
import { InvalidTenderError, NonCashChangeError, UnderpaidError } from '../../errors.js';
import { money } from '../../money/money.js';
import { assertTenderComposition, settle } from '../tender.js';
import type { TenderLine } from '../tender.js';

const cash = (minor: bigint): TenderLine => ({ kind: 'cash', amount: money(minor) });
const card = (minor: bigint, reference = 'AUTH-1'): TenderLine => ({
  kind: 'electronic',
  scheme: 'mada',
  reference,
  amount: money(minor),
});

describe('tender composition', () => {
  it('accepts a cash tender and an electronic one together', () => {
    expect(() => {
      assertTenderComposition([card(1_000n), cash(1_300n)]);
    }).not.toThrow();
  });

  it('refuses an empty payment', () => {
    expect(() => {
      assertTenderComposition([]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses a tender of nothing', () => {
    // A zero line records a method that was not used, and it reaches a receipt.
    expect(() => {
      assertTenderComposition([cash(0n)]);
    }).toThrow(InvalidTenderError);
    expect(() => {
      assertTenderComposition([card(1_000n), cash(0n)]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses a negative tender', () => {
    expect(() => {
      assertTenderComposition([cash(-100n)]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses a second cash tender', () => {
    // Two cash lines is a drawer nobody can reconcile: the change has to come
    // out of one of them and no fact says which.
    expect(() => {
      assertTenderComposition([cash(500n), cash(500n)]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses an electronic tender with no scheme or no reference', () => {
    expect(() => {
      assertTenderComposition([{ kind: 'electronic', amount: money(500n), reference: 'A' }]);
    }).toThrow(InvalidTenderError);
    expect(() => {
      assertTenderComposition([{ kind: 'electronic', amount: money(500n), scheme: 'visa' }]);
    }).toThrow(InvalidTenderError);
    expect(() => {
      assertTenderComposition([
        { kind: 'electronic', amount: money(500n), scheme: 'visa', reference: '   ' },
      ]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses an unbounded reference', () => {
    expect(() => {
      assertTenderComposition([card(500n, 'x'.repeat(65))]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses a cash tender wearing an approval code', () => {
    expect(() => {
      assertTenderComposition([{ kind: 'cash', amount: money(500n), reference: 'AUTH-1' }]);
    }).toThrow(InvalidTenderError);
  });

  it('refuses the same approval counted twice', () => {
    expect(() => {
      assertTenderComposition([card(500n, 'AUTH-9'), card(500n, 'AUTH-9')]);
    }).toThrow(InvalidTenderError);
  });

  it('allows one scheme twice under different approvals', () => {
    // A customer with two cards is ordinary.
    expect(() => {
      assertTenderComposition([card(500n, 'AUTH-1'), card(500n, 'AUTH-2')]);
    }).not.toThrow();
  });

  it('refuses the legacy kinds as new payments', () => {
    // Readable, because rows written before this vocabulary still exist. Not
    // writable, because a kind with no scheme beside it cannot be reported on.
    expect(() => {
      assertTenderComposition([{ kind: 'mada', amount: money(500n) }]);
    }).toThrow(InvalidTenderError);
  });
});

describe('split settlement', () => {
  it('gives change from cash when a card covers part of the total', () => {
    // 23.00 due, 10.00 on Mada, 20.00 cash: 7.00 back, and 13.00 stays in the
    // drawer.
    const settlement = settle(money(2_300n), [card(1_000n), cash(2_000n)]);
    expect(settlement.tendered.minor).toBe(3_000n);
    expect(settlement.change.minor).toBe(700n);
    expect(settlement.changeFrom).toBe('cash');
    expect(settlement.tendered.minor - settlement.change.minor).toBe(2_300n);
  });

  it('refuses an electronic tender larger than the amount due', () => {
    // 24.00 on a card against a 23.00 sale is a customer overcharged by a
    // pound, and no amount of cash in the drawer can give it back.
    expect(() => settle(money(2_300n), [card(2_400n)])).toThrow(NonCashChangeError);
  });

  it('refuses electronic tenders that together exceed the total', () => {
    expect(() => settle(money(2_300n), [card(1_500n, 'AUTH-1'), card(1_500n, 'AUTH-2')])).toThrow(
      NonCashChangeError,
    );
  });

  it('settles three tenders exactly, with no change', () => {
    const settlement = settle(money(10_000n), [
      card(2_000n, 'AUTH-1'),
      card(3_000n, 'AUTH-2'),
      cash(5_000n),
    ]);
    expect(settlement.change.minor).toBe(0n);
    expect(settlement.changeFrom).toBeNull();
  });

  it('refuses a payment that does not cover the total', () => {
    expect(() => settle(money(2_300n), [card(1_000n), cash(1_000n)])).toThrow(UnderpaidError);
  });

  it('lets cash alone overpay', () => {
    const settlement = settle(money(2_300n), [cash(5_000n)]);
    expect(settlement.change.minor).toBe(2_700n);
  });
});
