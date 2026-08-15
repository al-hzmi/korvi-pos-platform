import { describe, expect, it } from 'vitest';
import { fingerprintCommercialPlanAssignment } from '../commercial/plan-entitlements.js';

const BASE = {
  tenantId: '018f5000-0000-7000-8000-000000000001',
  planKey: 'growth',
  planRevision: 2,
  accountState: 'active' as const,
  controlPlaneActorRef: 'ops:platform/nada',
  entitlements: [
    { key: 'core.pos', kind: 'flag' as const, enabled: true },
    { key: 'limits.branches', kind: 'limit' as const, limit: 5n },
  ],
};

describe('commercial plan fingerprint', () => {
  it('is stable and independent of entitlement input order', () => {
    expect(fingerprintCommercialPlanAssignment(BASE)).toBe(
      fingerprintCommercialPlanAssignment({
        ...BASE,
        entitlements: [...BASE.entitlements].reverse(),
      }),
    );
  });

  it('binds tenant, plan, revision, state, actor and grant values', () => {
    const base = fingerprintCommercialPlanAssignment(BASE);
    const variants = [
      { ...BASE, tenantId: '018f5000-0000-7000-8000-000000000002' },
      { ...BASE, planKey: 'enterprise' },
      { ...BASE, planRevision: 3 },
      { ...BASE, accountState: 'restricted' as const },
      { ...BASE, controlPlaneActorRef: 'ops:platform/omar' },
      {
        ...BASE,
        entitlements: [
          { key: 'core.pos', kind: 'flag' as const, enabled: false },
          BASE.entitlements[1]!,
        ],
      },
    ];
    for (const variant of variants) {
      expect(fingerprintCommercialPlanAssignment(variant)).not.toBe(base);
    }
  });

  it('is a fixed-width digest rather than readable commercial data', () => {
    const digest = fingerprintCommercialPlanAssignment(BASE);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digest).not.toContain(BASE.planKey);
  });
});
