import { createHash } from 'node:crypto';
import type { Currency, PriceMode, PricedCart, PromotionEvaluation } from '@korvi/domain';

/**
 * Hash of the exact server-computed price a cashier was shown.
 *
 * This is a precondition only: checkout always recomputes money from current
 * server truth. A mismatch refuses the sale; the client can never use this
 * value to assert a total.
 *
 * Line ids are intentionally excluded because preview and finalized sale line
 * identities differ. Input order is retained because largest-remainder
 * allocation is deterministic in that order when weights tie.
 */
export function checkoutPricingHash(input: {
  readonly priceMode: PriceMode;
  readonly currency: Currency;
  readonly couponCodes: readonly string[];
  readonly priced: PricedCart;
  readonly promotionEvaluation: PromotionEvaluation;
}): string {
  const canonical = JSON.stringify([
    'v1',
    input.priceMode,
    input.currency,
    [...input.couponCodes].sort(),
    input.priced.lines.map((line) => [
      line.productId,
      line.quantity.toString(),
      line.unitPrice.minor.toString(),
      line.vatRate.toString(),
      line.lineDiscount.minor.toString(),
      line.promotionDiscount.minor.toString(),
      line.basketDiscount.minor.toString(),
      line.net.minor.toString(),
      line.vat.minor.toString(),
      line.total.minor.toString(),
    ]),
    input.promotionEvaluation.applications.map((application) => [
      application.promotionId,
      application.revision.toString(),
      application.merchantCode,
      application.name,
      String(application.priority),
      application.stackingMode,
      application.effect.kind,
      application.effect.kind === 'fixed'
        ? application.effect.amountMinor.toString()
        : application.effect.basisPoints.toString(),
      application.eligibleBaseMinor.toString(),
      application.amountMinor.toString(),
      application.coupon?.couponId ?? '',
      application.coupon?.normalizedCode ?? '',
    ]),
    input.priced.gross.minor.toString(),
    input.priced.lineDiscountTotal.minor.toString(),
    input.priced.promotionDiscountTotal.minor.toString(),
    input.priced.basketDiscountTotal.minor.toString(),
    input.priced.net.minor.toString(),
    input.priced.vat.minor.toString(),
    input.priced.total.minor.toString(),
  ]);

  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}
