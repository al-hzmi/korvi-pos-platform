import { describe, expect, it } from 'vitest';
import {
  MAX_MOVEMENT_REASON,
  closeShiftBody,
  manualMovementBody,
  namesDrawerAuthorityField,
} from '../routes/validation.js';

/**
 * The edge of the server, where a money figure is still a string.
 *
 * Everything here is about what a client is allowed to say. A JSON number has
 * already lost halalas by the time a handler sees it; a decimal point in a
 * minor-unit field means the client is working in riyals and is about to be
 * out by a factor of a hundred; and a value past the BIGINT range would fail
 * at the end of a transaction rather than at its edge.
 */

const OPERATION = '018f7000-0000-7000-8000-000000000001';
const TERMINAL = '018f7000-0000-7000-8000-000000000002';
const SHIFT = '018f7000-0000-7000-8000-000000000003';

const close = (declaredCashMinor: unknown): ReturnType<typeof closeShiftBody.safeParse> =>
  closeShiftBody.safeParse({
    operationId: OPERATION,
    terminalId: TERMINAL,
    shiftId: SHIFT,
    declaredCashMinor,
  });

const movement = (over: Record<string, unknown>): ReturnType<typeof manualMovementBody.safeParse> =>
  manualMovementBody.safeParse({
    operationId: OPERATION,
    terminalId: TERMINAL,
    shiftId: SHIFT,
    kind: 'pay-in',
    amountMinor: '5000',
    reason: 'إيداع صرافة',
    ...over,
  });

describe('a declared drawer count', () => {
  it('accepts an empty drawer and a single halala', () => {
    expect(close('0').success).toBe(true);
    expect(close('1').success).toBe(true);
  });

  it('accepts an amount larger than a JavaScript number can count', () => {
    const beyond = '9007199254740993';
    const parsed = close(beyond);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Still a string, and still exact.
      expect(parsed.data.declaredCashMinor).toBe(beyond);
      expect(BigInt(parsed.data.declaredCashMinor)).toBe(9_007_199_254_740_993n);
    }
  });

  it('accepts the largest BIGINT and refuses the next one', () => {
    expect(close('9223372036854775807').success).toBe(true);
    expect(close('9223372036854775808').success).toBe(false);
  });

  it('refuses a JSON number, which has already lost the halalas', () => {
    expect(close(31_500).success).toBe(false);
  });

  it('refuses everything that is not an exact non-negative integer string', () => {
    for (const bad of ['-1', '31.5', '1e5', '', '   ', '+1', 'abc', '٣١٥٠٠', '0001', null]) {
      expect(close(bad).success).toBe(false);
    }
  });
});

describe('a manual movement amount', () => {
  it('takes a positive magnitude for both kinds', () => {
    expect(movement({ kind: 'pay-in', amountMinor: '5000' }).success).toBe(true);
    expect(movement({ kind: 'pay-out', amountMinor: '5000' }).success).toBe(true);
  });

  it('refuses zero, a sign, a decimal and a number', () => {
    for (const bad of ['0', '-5000', '+5000', '50.00', '5e3', ' 5000', 5000]) {
      expect(movement({ amountMinor: bad }).success).toBe(false);
    }
  });

  it('refuses a kind it does not know', () => {
    expect(movement({ kind: 'sale' }).success).toBe(false);
    expect(movement({ kind: 'refund' }).success).toBe(false);
  });
});

describe('the reason on a manual movement', () => {
  it('is stored trimmed, not as the client typed it', () => {
    const parsed = movement({ reason: '  مصروف نقل  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.reason).toBe('مصروف نقل');
  });

  it('refuses whitespace pretending to be a reason', () => {
    expect(movement({ reason: '   ' }).success).toBe(false);
    expect(movement({ reason: '' }).success).toBe(false);
  });

  it('accepts the longest reason and refuses one character more', () => {
    expect(movement({ reason: 'ب'.repeat(MAX_MOVEMENT_REASON) }).success).toBe(true);
    // Refused rather than truncated: half an explanation is worse than none.
    expect(movement({ reason: 'ب'.repeat(MAX_MOVEMENT_REASON + 1) }).success).toBe(false);
  });

  it('measures the trimmed reason, so padding cannot buy length', () => {
    expect(movement({ reason: `  ${'ب'.repeat(MAX_MOVEMENT_REASON)}  ` }).success).toBe(true);
  });
});

describe('what a drawer request may not assert', () => {
  it('refuses every server-derived figure by name', () => {
    for (const field of [
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
    ]) {
      expect(namesDrawerAuthorityField({ [field]: 'x' })).toBe(field);
    }
  });

  it('does NOT reject the identifiers a drawer request is required to send', () => {
    // The defect this exists to catch: reusing the sale route's forbidden list,
    // which names shiftId and terminalId because a *sale* must not carry them.
    expect(
      namesDrawerAuthorityField({
        operationId: OPERATION,
        terminalId: TERMINAL,
        shiftId: SHIFT,
        declaredCashMinor: '0',
      }),
    ).toBeNull();
  });
});
