import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { describeFailure } from '../failures';
import { outcomeFor } from '../checkout-flight';

describe('describeFailure', () => {
  it.each([
    ['unauthenticated', 401, 'reauthenticate'],
    ['forbidden', 403, 'permission'],
    ['no-open-shift', 409, 'open-shift'],
    ['shift-invalid', 409, 'refresh-shift'],
    ['insufficient-stock', 409, 'amend-cart'],
    ['insufficient-cash', 422, 'amend-cash'],
    ['idempotency-conflict', 409, 'blocking'],
    ['branch_required', 409, 'blocking'],
    ['tenant-misconfigured', 409, 'blocking'],
    ['network', 0, 'retry-same'],
    ['timeout', 0, 'retry-same'],
  ])('routes %s to %s', (code, status, action) => {
    expect(describeFailure(new ApiError(status, code, null)).action).toBe(action);
  });

  it.each([
    ['retry-same', 'ambiguous'],
    ['blocking', 'blocked'],
    ['amend-cash', 'amendable'],
    ['amend-cart', 'amendable'],
    ['open-shift', 'amendable'],
    ['refresh-shift', 'amendable'],
  ])('classifies %s as %s for the flight', (action, outcome) => {
    expect(outcomeFor(action)).toBe(outcome);
  });

  it('prefers the server’s own Arabic where it sent some', () => {
    const failure = describeFailure(
      new ApiError(409, 'insufficient-stock', 'الكمية المطلوبة غير متوفرة في المخزون.'),
    );
    expect(failure.message).toBe('الكمية المطلوبة غير متوفرة في المخزون.');
  });

  it('says a timeout may have succeeded rather than that it failed', () => {
    // Nobody knows. Telling a cashier it failed is how a sale gets rung twice.
    expect(describeFailure(new ApiError(0, 'timeout', null)).message).toContain('قد تكون');
  });

  it('treats an unknown 5xx as worth retrying', () => {
    expect(describeFailure(new ApiError(503, 'unavailable', null)).action).toBe('retry-same');
  });

  it('never surfaces something that is not an API failure', () => {
    // A stack trace on a till screen helps nobody and tells an attacker the
    // shape of the server.
    const failure = describeFailure(new Error('relation "sales" does not exist'));
    expect(failure.message).not.toContain('sales');
    expect(failure.code).toBe('unexpected');
  });
});
