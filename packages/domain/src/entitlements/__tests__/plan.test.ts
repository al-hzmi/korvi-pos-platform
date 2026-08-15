import { describe, expect, it } from 'vitest';
import {
  CommercialEntitlementError,
  evaluateEntitlement,
  normalizeEntitlements,
  normalizePlanKey,
  normalizePlanRevision,
  permitsEntitlementUsage,
} from '../plan.js';
import type { CommercialAccountSnapshot } from '../plan.js';

const ACCOUNT: CommercialAccountSnapshot = {
  assignmentId: '018f4000-0000-7000-8000-000000000001',
  planKey: 'growth',
  planRevision: 3,
  state: 'active',
  assignedAt: '2026-08-15T12:00:00.000Z',
  entitlements: [
    { key: 'core.pos', kind: 'flag', enabled: true },
    { key: 'offline.sales', kind: 'flag', enabled: false },
    { key: 'limits.branches', kind: 'limit', limit: 5n },
  ],
};

describe('commercial plan identity', () => {
  it('normalizes plan identity deterministically', () => {
    expect(normalizePlanKey('  Growth.2026-A ')).toBe('growth.2026-a');
    expect(normalizePlanRevision(7)).toBe(7);
  });

  it('refuses malformed keys and non-integer revisions', () => {
    expect(() => normalizePlanKey('../enterprise')).toThrow(CommercialEntitlementError);
    expect(() => normalizePlanRevision(1.5)).toThrow(CommercialEntitlementError);
    expect(() => normalizePlanRevision(0)).toThrow(CommercialEntitlementError);
  });
});

describe('entitlement snapshots', () => {
  it('canonicalizes grant order and keys', () => {
    expect(
      normalizeEntitlements([
        { key: 'Z.Feature', kind: 'flag', enabled: true },
        { key: 'a.limit', kind: 'limit', limit: 2n },
      ]),
    ).toEqual([
      { key: 'a.limit', kind: 'limit', limit: 2n },
      { key: 'z.feature', kind: 'flag', enabled: true },
    ]);
  });

  it('uses deterministic code-unit ordering rather than host locale collation', () => {
    expect(
      normalizeEntitlements([
        { key: 'a_1', kind: 'flag', enabled: true },
        { key: 'a.1', kind: 'flag', enabled: true },
        { key: 'a-1', kind: 'flag', enabled: true },
      ]).map((grant) => grant.key),
    ).toEqual(['a-1', 'a.1', 'a_1']);
  });

  it('refuses duplicate normalized keys', () => {
    expect(() =>
      normalizeEntitlements([
        { key: 'core.pos', kind: 'flag', enabled: true },
        { key: 'CORE.POS', kind: 'flag', enabled: false },
      ]),
    ).toThrow(CommercialEntitlementError);
  });

  it('refuses negative limits', () => {
    expect(() =>
      normalizeEntitlements([{ key: 'limits.users', kind: 'limit', limit: -1n }]),
    ).toThrow(CommercialEntitlementError);
  });
});

describe('entitlement evaluation', () => {
  it('fails closed before a commercial account exists', () => {
    expect(evaluateEntitlement(null, 'core.pos')).toEqual({
      outcome: 'deny',
      reason: 'unconfigured',
    });
  });

  it('fails closed when the commercial account is restricted', () => {
    expect(evaluateEntitlement({ ...ACCOUNT, state: 'restricted' }, 'core.pos')).toEqual({
      outcome: 'deny',
      reason: 'account-restricted',
    });
  });

  it('distinguishes missing and explicitly disabled capabilities', () => {
    expect(evaluateEntitlement(ACCOUNT, 'restaurant.kds')).toEqual({
      outcome: 'deny',
      reason: 'not-entitled',
    });
    expect(evaluateEntitlement(ACCOUNT, 'offline.sales')).toEqual({
      outcome: 'deny',
      reason: 'disabled',
    });
  });

  it('returns the exact enabled grant', () => {
    expect(evaluateEntitlement(ACCOUNT, 'core.pos')).toEqual({
      outcome: 'allow',
      grant: { key: 'core.pos', kind: 'flag', enabled: true },
    });
  });

  it('evaluates integer limits without floats', () => {
    const decision = evaluateEntitlement(ACCOUNT, 'limits.branches');
    expect(permitsEntitlementUsage(decision, 5n)).toBe(true);
    expect(permitsEntitlementUsage(decision, 6n)).toBe(false);
  });
});
