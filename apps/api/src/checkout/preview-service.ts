import { checkoutPricingHash } from './pricing-hash.js';
import {
  ContextPriceError,
  InvalidAmountError,
  InvalidCouponCodeError,
  InvalidRestaurantModifierDefinitionError,
  InvalidRestaurantModifierSelectionError,
  baseInventoryQuantityScaled,
  basisPoints,
  evaluatePromotions,
  extendedPrice,
  money,
  normalizeCouponCode,
  packageInventoryQuantityScaled,
  priceCart,
  quantity,
  tenantId as brandTenantId,
} from '@korvi/domain';
import type {
  AuthenticatedPrincipal,
  Currency,
  PriceContext,
  PriceMode,
  ProductRepository,
  PromotionCheckoutPolicy,
  PromotionRepository,
  RetailPriceAuthority,
  RetailPricingRepository,
  RestaurantModifierResolution,
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
  | 'unknown-package'
  | 'package-unavailable'
  | 'wholesale-price-incomplete'
  | 'price-context-not-authorized'
  | 'retail-pricing-policy-stale'
  | 'tenant-misconfigured'
  | 'promotions-not-applicable'
  | 'invalid-modifier-selection'
  | 'modifier-policy-invalid'
  | 'modifiers-not-applicable';

export interface CheckoutPreviewInput {
  readonly principal: AuthenticatedPrincipal;
  readonly lines: readonly {
    readonly productId: string;
    readonly packageId?: string | null | undefined;
    readonly quantityScaled: string;
    readonly selectedModifierOptionIds?: readonly string[] | undefined;
  }[];
  readonly priceContext?: PriceContext | undefined;
  readonly couponCodes?: readonly string[] | undefined;
}

export interface CheckoutPreviewSuccess {
  readonly outcome: 'success';
  readonly pricing: {
    readonly priceMode: PriceMode;
    readonly currency: Currency;
    readonly pricingHash: string;
    readonly grossMinor: string;
    readonly promotionDiscountMinor: string;
    readonly netMinor: string;
    readonly vatMinor: string;
    readonly totalMinor: string;
    readonly lines: readonly {
      readonly productId: string;
      readonly packageId: string | null;
      readonly unitPriceMinor: string;
      readonly quantityScaled: string;
      readonly inventoryQuantityScaled: string;
      readonly grossMinor: string;
      readonly promotionDiscountMinor: string;
      readonly netMinor: string;
      readonly vatMinor: string;
      readonly totalMinor: string;
    }[];
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
  readonly retailPricing?: RetailPricingRepository;
  readonly promotions?: PromotionRepository;
  readonly restaurantModifiers?: {
    resolve(
      scope: TenantScope,
      productId: string,
      baseUnitPriceMinor: bigint,
      selectedOptionIds: readonly string[],
    ): Promise<RestaurantModifierResolution>;
  };
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

      const priceContext: PriceContext = input.priceContext ?? 'retail';
      if (
        priceContext !== 'retail' &&
        !input.principal.permissions.includes('sale.price-context')
      ) {
        return { outcome: 'failure', reason: 'price-context-not-authorized' };
      }

      const seen = new Set<string>();
      for (const line of input.lines) {
        const modifierIdentity = [...(line.selectedModifierOptionIds ?? [])].sort().join(',');
        const identity =
          line.productId + '\u0000' + (line.packageId ?? '') + '\u0000' + modifierIdentity;
        if (seen.has(identity)) return { outcome: 'failure', reason: 'duplicate-line' };
        seen.add(identity);
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
      if (
        settings.vertical === 'restaurant' &&
        (couponCodes.length > 0 || priceContext !== 'retail')
      ) {
        return { outcome: 'failure', reason: 'promotions-not-applicable' };
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
        readonly inventoryScaled: bigint;
        readonly authority: RetailPriceAuthority | null;
        readonly modifierAuthority: RestaurantModifierResolution | null;
        readonly lineId: string;
      }[] = [];

      for (const [index, line] of input.lines.entries()) {
        const product = await deps.products.findById(scope, line.productId);
        if (product === null) return { outcome: 'failure', reason: 'unknown-product' };
        if (!product.isActive) return { outcome: 'failure', reason: 'product-unavailable' };

        let authority: RetailPriceAuthority | null = null;
        let modifierAuthority: RestaurantModifierResolution | null = null;
        const selectedModifierOptionIds = [...(line.selectedModifierOptionIds ?? [])].sort();

        if (settings.vertical === 'restaurant') {
          if (line.packageId !== null && line.packageId !== undefined) {
            return { outcome: 'failure', reason: 'modifiers-not-applicable' };
          }
          if (deps.restaurantModifiers === undefined) {
            return { outcome: 'failure', reason: 'modifier-policy-invalid' };
          }
          try {
            modifierAuthority = await deps.restaurantModifiers.resolve(
              scope,
              product.id,
              BigInt(product.priceMinor),
              selectedModifierOptionIds,
            );
          } catch (error) {
            if (error instanceof InvalidRestaurantModifierSelectionError) {
              return { outcome: 'failure', reason: 'invalid-modifier-selection' };
            }
            if (
              error instanceof InvalidRestaurantModifierDefinitionError ||
              error instanceof InvalidAmountError
            ) {
              return { outcome: 'failure', reason: 'modifier-policy-invalid' };
            }
            throw error;
          }
        } else if (deps.retailPricing !== undefined) {
          try {
            authority = await deps.retailPricing.resolve(scope, {
              productId: line.productId,
              packageId: line.packageId ?? null,
              context: priceContext,
            });
          } catch (error) {
            if (
              error instanceof ContextPriceError &&
              error.detail === 'wholesale-price-incomplete'
            ) {
              return { outcome: 'failure', reason: 'wholesale-price-incomplete' };
            }
            if (error instanceof ContextPriceError) {
              return { outcome: 'failure', reason: 'retail-pricing-policy-stale' };
            }
            throw error;
          }
          if (authority === null) {
            return {
              outcome: 'failure',
              reason:
                line.packageId === null || line.packageId === undefined
                  ? 'product-unavailable'
                  : 'package-unavailable',
            };
          }
        } else if (
          (line.packageId !== null && line.packageId !== undefined) ||
          priceContext !== 'retail'
        ) {
          return {
            outcome: 'failure',
            reason:
              line.packageId !== null && line.packageId !== undefined
                ? 'package-unavailable'
                : 'wholesale-price-incomplete',
          };
        }

        let scaled: bigint;
        try {
          scaled = quantity(BigInt(line.quantityScaled));
        } catch {
          return { outcome: 'failure', reason: 'invalid-quantity' };
        }
        if (
          scaled <= 0n ||
          ((authority?.package === null || authority === null) &&
            product.productType === 'unit' &&
            scaled % 1_000n !== 0n)
        ) {
          return { outcome: 'failure', reason: 'invalid-quantity' };
        }

        let inventoryScaled: bigint;
        try {
          inventoryScaled =
            authority?.package === undefined || authority.package === null
              ? baseInventoryQuantityScaled(scaled)
              : packageInventoryQuantityScaled({
                  commercialQuantityScaled: scaled,
                  packageBaseQuantityScaled: BigInt(authority.package.baseQuantityScaled),
                });
        } catch {
          return { outcome: 'failure', reason: 'invalid-quantity' };
        }

        loaded.push({
          product: {
            id: product.id,
            sku: product.sku,
            nameAr: product.nameAr,
            nameEn: product.nameEn,
            priceMinor:
              modifierAuthority?.unitPriceMinor.toString() ??
              authority?.unitPriceMinor ??
              product.priceMinor,
            vatBasisPoints: Number(product.vatBasisPoints),
            productType: product.productType,
          },
          scaled,
          inventoryScaled,
          authority,
          modifierAuthority,
          lineId: 'preview-' + String(index + 1),
        });
      }

      const currency: Currency = 'SAR';
      const evaluatedAt = now().toISOString();
      const promotionLines = loaded.map(({ product, scaled, lineId }) => ({
        lineId,
        productId: product.id,
        grossMinor: extendedPrice(money(BigInt(product.priceMinor), currency), quantity(scaled))
          .minor,
      }));

      let policies: readonly PromotionCheckoutPolicy[] = [];
      if (settings.vertical !== 'restaurant') {
        if (deps.promotions === undefined) {
          if (couponCodes.length > 0) {
            return { outcome: 'failure', reason: 'coupon-unavailable' };
          }
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
        lines: loaded.map(({ product, scaled, lineId }) => ({
          lineId,
          productId: product.id,
          sku: product.sku,
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          unitPrice: money(BigInt(product.priceMinor), currency),
          quantity: quantity(scaled),
          vatRate: basisPoints(product.vatBasisPoints),
          isWeighted: product.productType === 'weighted',
          ...((promotionByLine.get(lineId) ?? 0n) === 0n
            ? {}
            : { promotionDiscountMinor: promotionByLine.get(lineId) ?? 0n }),
        })),
      });

      return {
        outcome: 'success',
        pricing: {
          priceMode: settings.priceMode,
          currency,
          pricingHash: checkoutPricingHash({
            priceMode: settings.priceMode,
            currency,
            couponCodes,
            priced,
            promotionEvaluation: evaluation,
            retailAuthorities: loaded
              .map((entry) => entry.authority)
              .filter((authority): authority is RetailPriceAuthority => authority !== null),
          }),
          grossMinor: priced.gross.minor.toString(),
          promotionDiscountMinor: priced.promotionDiscountTotal.minor.toString(),
          netMinor: priced.net.minor.toString(),
          vatMinor: priced.vat.minor.toString(),
          totalMinor: priced.total.minor.toString(),
          lines: priced.lines.map((line, index) => {
            const source = loaded[index];
            if (source === undefined) {
              throw new Error('Checkout preview line/source cardinality mismatch.');
            }
            return {
              productId: line.productId,
              packageId: source.authority?.package?.id ?? null,
              unitPriceMinor: line.unitPrice.minor.toString(),
              quantityScaled: source.scaled.toString(),
              inventoryQuantityScaled: source.inventoryScaled.toString(),
              grossMinor: line.gross.minor.toString(),
              promotionDiscountMinor: line.promotionDiscount.minor.toString(),
              netMinor: line.net.minor.toString(),
              vatMinor: line.vat.minor.toString(),
              totalMinor: line.total.minor.toString(),
            };
          }),
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
