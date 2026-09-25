import {
  InvalidCouponCodeError,
  basisPoints,
  evaluatePromotions,
  extendedPrice,
  money,
  normalizeCouponCode,
  priceCart,
  quantity,
  tenantId as brandTenantId,
} from '@korvi/domain';
import type {
  AuthenticatedPrincipal,
  Currency,
  PriceMode,
  ProductRepository,
  PromotionCheckoutPolicy,
  PromotionRepository,
  TenantRepository,
  TenantScope,
} from '@korvi/domain';

export type CheckoutPreviewFailureReason =
  | 'empty-cart'
  | 'duplicate-line'
  | 'unknown-product'
  | 'product-unavailable'
  | 'invalid-quantity'
  | 'invalid-coupon'
  | 'coupon-unavailable'
  | 'coupon-ineligible'
  | 'tenant-misconfigured'
  | 'promotions-not-applicable';

export interface CheckoutPreviewInput {
  readonly principal: AuthenticatedPrincipal;
  readonly lines: readonly {
    readonly productId: string;
    readonly quantityScaled: string;
  }[];
  readonly couponCodes?: readonly string[] | undefined;
}

export interface CheckoutPreviewSuccess {
  readonly outcome: 'success';
  readonly pricing: {
    readonly priceMode: PriceMode;
    readonly currency: Currency;
    readonly grossMinor: string;
    readonly promotionDiscountMinor: string;
    readonly netMinor: string;
    readonly vatMinor: string;
    readonly totalMinor: string;
    readonly applications: readonly {
      readonly promotionId: string;
      readonly merchantCode: string;
      readonly name: string;
      readonly amountMinor: string;
      readonly couponCode: string | null;
    }[];
  };
}

export interface CheckoutPreviewFailure {
  readonly outcome: 'failure';
  readonly reason: CheckoutPreviewFailureReason;
}

export type CheckoutPreviewResult = CheckoutPreviewSuccess | CheckoutPreviewFailure;

export interface CheckoutPreviewDeps {
  readonly tenants: TenantRepository;
  readonly products: ProductRepository;
  readonly promotions?: PromotionRepository;
  readonly now?: () => Date;
}

function normalizeCodes(input: readonly string[] | undefined): readonly string[] {
  if (input === undefined || input.length === 0) return [];
  const normalized = input.map((code) => normalizeCouponCode(code));
  return [...new Set(normalized)].sort();
}

function promotionCandidateFromPolicy(policy: PromotionCheckoutPolicy) {
  const promotion = policy.promotion;
  return {
    promotionId: promotion.id,
    revision: BigInt(promotion.revision),
    merchantCode: promotion.merchantCode,
    name: promotion.name,
    status: promotion.status,
    priority: promotion.priority,
    stackingMode: promotion.stackingMode,
    startsAtMs: promotion.startsAt === null ? null : new Date(promotion.startsAt).getTime(),
    endsAtMs: promotion.endsAt === null ? null : new Date(promotion.endsAt).getTime(),
    effect:
      promotion.effectKind === 'fixed'
        ? { kind: 'fixed' as const, amountMinor: BigInt(promotion.effectValue) }
        : { kind: 'percentage' as const, basisPoints: BigInt(promotion.effectValue) },
    minimumEligibleSubtotalMinor: BigInt(promotion.minimumEligibleSubtotalMinor),
    target:
      promotion.targetKind === 'basket'
        ? ({ kind: 'basket' } as const)
        : ({ kind: 'products', productIds: promotion.productIds } as const),
    coupon:
      policy.coupon === null
        ? null
        : { couponId: policy.coupon.id, normalizedCode: policy.coupon.normalizedCode },
  };
}

export interface CheckoutPreviewService {
  preview(input: CheckoutPreviewInput): Promise<CheckoutPreviewResult>;
}

export function createCheckoutPreviewService(deps: CheckoutPreviewDeps): CheckoutPreviewService {
  const now = deps.now ?? (() => new Date());

  return {
    async preview(input) {
      if (input.lines.length === 0) return { outcome: 'failure', reason: 'empty-cart' };

      const seen = new Set<string>();
      for (const line of input.lines) {
        if (seen.has(line.productId)) return { outcome: 'failure', reason: 'duplicate-line' };
        seen.add(line.productId);
      }

      let couponCodes: readonly string[];
      try {
        couponCodes = normalizeCodes(input.couponCodes);
      } catch (error) {
        if (error instanceof InvalidCouponCodeError) {
          return { outcome: 'failure', reason: 'invalid-coupon' };
        }
        throw error;
      }

      const scope: TenantScope = { tenantId: brandTenantId(input.principal.tenantId) };
      const settings = await deps.tenants.settings(scope);
      if (settings === null || settings.currency !== 'SAR') {
        return { outcome: 'failure', reason: 'tenant-misconfigured' };
      }
      if (settings.vertical === 'restaurant') {
        return couponCodes.length > 0
          ? { outcome: 'failure', reason: 'promotions-not-applicable' }
          : { outcome: 'failure', reason: 'promotions-not-applicable' };
      }

      const loaded: {
        readonly product: {
          readonly id: string;
          readonly sku: string;
          readonly nameAr: string;
          readonly nameEn: string | null;
          readonly priceMinor: string;
          readonly vatBasisPoints: number;
          readonly productType: 'unit' | 'weighted';
        };
        readonly scaled: bigint;
      }[] = [];

      for (const line of input.lines) {
        const product = await deps.products.findById(scope, line.productId);
        if (product === null) return { outcome: 'failure', reason: 'unknown-product' };
        if (!product.isActive) return { outcome: 'failure', reason: 'product-unavailable' };

        let scaled: bigint;
        try {
          scaled = quantity(BigInt(line.quantityScaled));
        } catch {
          return { outcome: 'failure', reason: 'invalid-quantity' };
        }
        if (scaled <= 0n || (product.productType === 'unit' && scaled % 1_000n !== 0n)) {
          return { outcome: 'failure', reason: 'invalid-quantity' };
        }

        loaded.push({
          product: {
            id: product.id,
            sku: product.sku,
            nameAr: product.nameAr,
            nameEn: product.nameEn,
            priceMinor: product.priceMinor,
            vatBasisPoints: Number(product.vatBasisPoints),
            productType: product.productType,
          },
          scaled,
        });
      }

      const currency: Currency = 'SAR';
      const evaluatedAt = now().toISOString();
      const promotionLines = loaded.map(({ product, scaled }) => ({
        lineId: product.id,
        productId: product.id,
        grossMinor: extendedPrice(money(BigInt(product.priceMinor), currency), quantity(scaled)).minor,
      }));

      let policies: readonly PromotionCheckoutPolicy[] = [];
      if (deps.promotions === undefined) {
        if (couponCodes.length > 0) return { outcome: 'failure', reason: 'coupon-unavailable' };
      } else {
        const resolution = await deps.promotions.resolveForCheckout(scope, {
          evaluatedAt,
          productIds: loaded.map(({ product }) => product.id),
          normalizedCouponCodes: couponCodes,
        });
        if (resolution.unavailableCouponCodes.length > 0) {
          return { outcome: 'failure', reason: 'coupon-unavailable' };
        }
        policies = resolution.policies;
      }

      const evaluation = evaluatePromotions({
        evaluatedAtMs: new Date(evaluatedAt).getTime(),
        lines: promotionLines,
        candidates: policies.map(promotionCandidateFromPolicy),
      });

      if (
        couponCodes.some(
          (code) =>
            !evaluation.applications.some(
              (application) => application.coupon?.normalizedCode === code,
            ),
        )
      ) {
        return { outcome: 'failure', reason: 'coupon-ineligible' };
      }

      const promotionByLine = new Map(
        evaluation.lineDiscounts.map((line) => [line.lineId, line.amountMinor] as const),
      );
      const priced = priceCart({
        priceMode: settings.priceMode,
        currency,
        lines: loaded.map(({ product, scaled }) => ({
          lineId: product.id,
          productId: product.id,
          sku: product.sku,
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          unitPrice: money(BigInt(product.priceMinor), currency),
          quantity: quantity(scaled),
          vatRate: basisPoints(product.vatBasisPoints),
          isWeighted: product.productType === 'weighted',
          ...((promotionByLine.get(product.id) ?? 0n) === 0n
            ? {}
            : { promotionDiscountMinor: promotionByLine.get(product.id) ?? 0n }),
        })),
      });

      return {
        outcome: 'success',
        pricing: {
          priceMode: settings.priceMode,
          currency,
          grossMinor: priced.gross.minor.toString(),
          promotionDiscountMinor: priced.promotionDiscountTotal.minor.toString(),
          netMinor: priced.net.minor.toString(),
          vatMinor: priced.vat.minor.toString(),
          totalMinor: priced.total.minor.toString(),
          applications: evaluation.applications.map((application) => ({
            promotionId: application.promotionId,
            merchantCode: application.merchantCode,
            name: application.name,
            amountMinor: application.amountMinor.toString(),
            couponCode: application.coupon?.normalizedCode ?? null,
          })),
        },
      };
    },
  };
}
