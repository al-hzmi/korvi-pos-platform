import { describe, expect, it } from 'vitest';
import { planPayment } from '../payment-tenders';

describe('cashier split payment planning', () => {
  it('keeps cash-only settlement backward compatible', () => {
    expect(planPayment('2300', 'cash', '50.00', [])).toMatchObject({
      valid: true,
      cashMinor: '5000',
      electronicMinor: '0',
      tenderedMinor: '5000',
      changeMinor: '2700',
      tenders: [{ kind: 'cash', amountMinor: '5000' }],
    });
  });

  it('builds deterministic mixed tenders in minor units', () => {
    expect(
      planPayment('10000', 'mixed', '30.00', [
        { scheme: 'mada', amount: '40.00', reference: 'A-100' },
        { scheme: 'visa', amount: '30.00', reference: 'B-200' },
      ]),
    ).toMatchObject({
      valid: true,
      cashMinor: '3000',
      electronicMinor: '7000',
      tenderedMinor: '10000',
      remainingMinor: '0',
      changeMinor: '0',
      tenders: [
        { kind: 'electronic', amountMinor: '4000', scheme: 'mada', reference: 'A-100' },
        { kind: 'electronic', amountMinor: '3000', scheme: 'visa', reference: 'B-200' },
        { kind: 'cash', amountMinor: '3000' },
      ],
    });
  });

  it('allows fully electronic exact settlement', () => {
    expect(
      planPayment('5000', 'mixed', '', [
        { scheme: 'apple-pay', amount: '50', reference: 'wallet-approval-1' },
      ]),
    ).toMatchObject({
      valid: true,
      cashMinor: '0',
      electronicMinor: '5000',
      tenderedMinor: '5000',
      tenders: [
        {
          kind: 'electronic',
          amountMinor: '5000',
          scheme: 'apple-pay',
          reference: 'wallet-approval-1',
        },
      ],
    });
  });

  it('refuses electronic overpayment because only cash may return change', () => {
    const result = planPayment('5000', 'mixed', '', [
      { scheme: 'mada', amount: '60', reference: 'approval-1' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.message).toContain('الإلكتروني');
  });

  it('refuses duplicate approval evidence and underpayment', () => {
    const duplicate = planPayment('10000', 'mixed', '', [
      { scheme: 'mada', amount: '30', reference: 'same' },
      { scheme: 'mada', amount: '70', reference: 'same' },
    ]);
    expect(duplicate.valid).toBe(false);
    expect(duplicate.message).toContain('مرجع');

    const short = planPayment('10000', 'mixed', '10', [
      { scheme: 'mada', amount: '50', reference: 'approval' },
    ]);
    expect(short.valid).toBe(false);
    expect(short.remainingMinor).toBe('4000');
  });
});
