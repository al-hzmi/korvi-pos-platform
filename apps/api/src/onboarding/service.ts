import { tenantId as brandTenantId } from '@korvi/domain';
import type { AuthenticatedPrincipal, OnboardingReadiness, TenantScope } from '@korvi/domain';

/**
 * Merchant onboarding API authority.
 *
 * There is intentionally no tenant-id argument on the public method.
 * Tenant identity comes only from the authenticated principal.
 */
export interface MerchantOnboardingService {
  readReadiness(principal: AuthenticatedPrincipal): Promise<OnboardingReadiness | null>;
}

export interface MerchantOnboardingDeps {
  readonly readReadiness: (scope: TenantScope) => Promise<OnboardingReadiness | null>;
}

export function createMerchantOnboardingService(
  deps: MerchantOnboardingDeps,
): MerchantOnboardingService {
  return {
    readReadiness(principal) {
      return deps.readReadiness({
        tenantId: brandTenantId(principal.tenantId),
      });
    },
  };
}
