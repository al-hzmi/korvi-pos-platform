import { DomainError } from '../errors.js';

export class InvalidCouponCodeError extends DomainError {
  public override readonly name = 'InvalidCouponCodeError';
}

export function normalizeCouponCode(input: string): string {
  const normalized = input.normalize('NFKC').trim().toUpperCase();
  if (
    normalized.length < 3 ||
    normalized.length > 32 ||
    !/^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])$/.test(normalized)
  ) {
    throw new InvalidCouponCodeError(
      'Coupon code must be 3-32 ASCII letters/digits with optional internal hyphens.',
    );
  }
  return normalized;
}
