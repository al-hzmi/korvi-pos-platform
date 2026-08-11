import { describe, expect, it } from 'vitest';
import {
  closeShiftBody,
  manualCashMovementBody,
  MAX_CASH_MOVEMENT_REASON,
  namesForbiddenField,
} from './validation.js';

const OPERATION_ID = '018f0000-0000-7000-8000-000000000001';
const TERMINAL_ID = '018f0000-0000-7000-8000-000000000002';
const SHIFT_ID = '018f0000-0000-7000-8000-000000000003';
const close = (declaredCashMinor: unknown) => ({
  operationId: OPERATION_ID,
  terminalId: TERMINAL_ID,
  shiftId: SHIFT_ID,
  declaredCashMinor,
});

describe('shift close authority validation', () => {
  it.each(['0', '1', '9007199254740993'])('accepts exact string amount %s', (amount) => {
    expect(closeShiftBody.safeParse(close(amount)).success).toBe(true);
  });
  it.each([1, '-1', '1.1', '1e3', '', ' ', '+1', 'halala'])(
    'rejects invalid amount %j',
    (amount) => {
      expect(closeShiftBody.safeParse(close(amount)).success).toBe(false);
    },
  );
  it.each([
    'expectedCashMinor',
    'varianceMinor',
    'cashSalesMinor',
    'cashRefundsMinor',
    'paidInMinor',
    'paidOutMinor',
    'closedByUserId',
    'tenantId',
    'branchId',
    'userId',
    'status',
  ])('explicitly identifies forbidden authority field %s', (field) => {
    expect(namesForbiddenField({ ...close('1'), [field]: 'assertion' })).toBe(field);
  });
});

describe('manual cash movement validation', () => {
  const body = (kind: 'pay-in' | 'pay-out', amountMinor: unknown, reason: string) => ({
    operationId: OPERATION_ID,
    terminalId: TERMINAL_ID,
    shiftId: SHIFT_ID,
    kind,
    amountMinor,
    reason,
  });
  it.each(['pay-in', 'pay-out'] as const)('accepts %s positive magnitude', (kind) => {
    expect(
      manualCashMovementBody.safeParse(body(kind, '9007199254740993', '  till correction  ')).data
        ?.reason,
    ).toBe('till correction');
  });
  it.each([0, '0', '-1', '1.1', '1e3', '', ' ', '+1', 'cash'])(
    'rejects invalid amount %j',
    (amount) => {
      expect(manualCashMovementBody.safeParse(body('pay-in', amount, 'reason')).success).toBe(
        false,
      );
    },
  );
  it('enforces reason bounds after trimming', () => {
    expect(manualCashMovementBody.safeParse(body('pay-in', '1', ' '.repeat(3))).success).toBe(
      false,
    );
    expect(
      manualCashMovementBody.safeParse(body('pay-in', '1', 'x'.repeat(MAX_CASH_MOVEMENT_REASON)))
        .success,
    ).toBe(true);
    expect(
      manualCashMovementBody.safeParse(
        body('pay-in', '1', 'x'.repeat(MAX_CASH_MOVEMENT_REASON + 1)),
      ).success,
    ).toBe(false);
  });
});
