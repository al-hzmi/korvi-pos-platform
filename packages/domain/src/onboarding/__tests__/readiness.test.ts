import { describe, expect, it } from 'vitest';
import { evaluateOnboardingReadiness } from '../readiness.js';
import type { OnboardingReadinessFacts } from '../readiness.js';

const READY: OnboardingReadinessFacts = {
  tenantStatus: 'active',
  settingsPresent: true,
  activeBranchPresent: true,
  activeTerminalPresent: true,
  viableAdministratorPresent: true,
  activeProductPresent: true,
};

describe('onboarding readiness', () => {
  it('is ready only when every current fact is ready', () => {
    const result = evaluateOnboardingReadiness(READY);

    expect(result.ready).toBe(true);
    expect(result.checks.every((check) => check.ready)).toBe(true);
    expect(result.checks.every((check) => check.blocker === null)).toBe(true);
  });

  const blockers = [
    ['tenantStatus', 'provisioning', 'tenant-not-active'],
    ['settingsPresent', false, 'settings-missing'],
    ['activeBranchPresent', false, 'no-active-branch'],
    ['activeTerminalPresent', false, 'no-active-terminal'],
    ['viableAdministratorPresent', false, 'no-viable-administrator'],
    ['activeProductPresent', false, 'no-active-product'],
  ] as const;

  for (const [field, value, blocker] of blockers) {
    it(`fails closed for ${blocker}`, () => {
      const result = evaluateOnboardingReadiness({
        ...READY,
        [field]: value,
      });

      expect(result.ready).toBe(false);
      expect(result.checks.some((check) => check.blocker === blocker)).toBe(true);
    });
  }
});
