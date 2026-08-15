import type { TenantLifecycleState } from '../tenancy/lifecycle.js';

export const ONBOARDING_CHECK_KEYS = [
  'tenant-active',
  'settings-present',
  'active-branch',
  'active-terminal',
  'viable-administrator',
  'active-product',
] as const;

export type OnboardingCheckKey = (typeof ONBOARDING_CHECK_KEYS)[number];

export type OnboardingBlocker =
  | 'tenant-not-active'
  | 'settings-missing'
  | 'no-active-branch'
  | 'no-active-terminal'
  | 'no-viable-administrator'
  | 'no-active-product';

export type OnboardingRemediation =
  | 'tenant-lifecycle'
  | 'merchant-settings'
  | 'branch-terminal-admin'
  | 'member-role-admin'
  | 'product-catalogue';

export interface OnboardingReadinessFacts {
  readonly tenantStatus: TenantLifecycleState;
  readonly settingsPresent: boolean;
  readonly activeBranchPresent: boolean;
  readonly activeTerminalPresent: boolean;
  readonly viableAdministratorPresent: boolean;
  readonly activeProductPresent: boolean;
}

export interface OnboardingReadinessCheck {
  readonly key: OnboardingCheckKey;
  readonly ready: boolean;
  readonly blocker: OnboardingBlocker | null;
  readonly remediation: OnboardingRemediation | null;
}

export interface OnboardingReadiness {
  readonly ready: boolean;
  readonly checks: readonly OnboardingReadinessCheck[];
}

function check(
  key: OnboardingCheckKey,
  ready: boolean,
  blocker: OnboardingBlocker,
  remediation: OnboardingRemediation,
): OnboardingReadinessCheck {
  return {
    key,
    ready,
    blocker: ready ? null : blocker,
    remediation: ready ? null : remediation,
  };
}

/**
 * Onboarding readiness is evidence-derived current truth.
 *
 * Nothing here is persisted as "completed". If the last till is deactivated
 * tomorrow, readiness becomes false tomorrow without a repair job or stale
 * onboarding flag.
 */
export function evaluateOnboardingReadiness(facts: OnboardingReadinessFacts): OnboardingReadiness {
  const checks: readonly OnboardingReadinessCheck[] = [
    check(
      'tenant-active',
      facts.tenantStatus === 'active',
      'tenant-not-active',
      'tenant-lifecycle',
    ),
    check('settings-present', facts.settingsPresent, 'settings-missing', 'merchant-settings'),
    check('active-branch', facts.activeBranchPresent, 'no-active-branch', 'branch-terminal-admin'),
    check(
      'active-terminal',
      facts.activeTerminalPresent,
      'no-active-terminal',
      'branch-terminal-admin',
    ),
    check(
      'viable-administrator',
      facts.viableAdministratorPresent,
      'no-viable-administrator',
      'member-role-admin',
    ),
    check('active-product', facts.activeProductPresent, 'no-active-product', 'product-catalogue'),
  ];

  return {
    ready: checks.every((item) => item.ready),
    checks,
  };
}
