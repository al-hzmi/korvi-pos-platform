import { describe, expect, it } from 'vitest';
import { fingerprintLifecycle, fingerprintProvisioning } from '../provisioning/fingerprint.js';
import type { LifecycleIntent, ProvisioningIntent } from '../provisioning/fingerprint.js';

const BASE: ProvisioningIntent = {
  slug: 'korvi-riyadh',
  name: 'متجر كورفي',
  vatNumber: '300000000000003',
  vertical: 'retail',
  controlPlaneActorRef: 'ops:platform/nada',
};

const MOVE: LifecycleIntent = {
  transition: 'suspend',
  tenantId: '018f9000-0000-7000-8000-00000000000a',
  controlPlaneActorRef: 'ops:platform/nada',
  reason: 'unpaid subscription',
};

describe('provisioning fingerprint', () => {
  it('is stable for the same intent', () => {
    expect(fingerprintProvisioning(BASE)).toBe(fingerprintProvisioning({ ...BASE }));
  });

  it('changes when any material field changes', () => {
    const base = fingerprintProvisioning(BASE);
    const variants: readonly ProvisioningIntent[] = [
      { ...BASE, slug: 'korvi-jeddah' },
      { ...BASE, name: 'اسم آخر' },
      { ...BASE, vatNumber: null },
      { ...BASE, vertical: 'grocery' },
      // The actor is material: without it an operation id is a bearer token
      // for somebody else's decision.
      { ...BASE, controlPlaneActorRef: 'ops:platform/omar' },
    ];
    for (const variant of variants) expect(fingerprintProvisioning(variant)).not.toBe(base);
    expect(new Set(variants.map(fingerprintProvisioning)).size).toBe(variants.length);
  });

  /**
   * The reason a hand-rolled `a|b|c` encoding is wrong.
   *
   * A merchant name is free text and may contain any separator such an
   * encoding might pick. Two intents that differ in where a field boundary
   * falls must not collide, or a retry could be accepted for a different
   * merchant.
   */
  it('does not let field content forge a field boundary', () => {
    const left = fingerprintProvisioning({ ...BASE, slug: 'a', name: 'b|c' });
    const right = fingerprintProvisioning({ ...BASE, slug: 'a|b', name: 'c' });
    expect(left).not.toBe(right);
  });

  it('is a fixed-width digest that reveals nothing of its input', () => {
    const digest = fingerprintProvisioning(BASE);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digest).not.toContain(BASE.slug);
    expect(fingerprintProvisioning({ ...BASE, name: 'x'.repeat(500) })).toHaveLength(digest.length);
  });
});

describe('lifecycle fingerprint', () => {
  it('is stable for the same intent', () => {
    expect(fingerprintLifecycle(MOVE)).toBe(fingerprintLifecycle({ ...MOVE }));
  });

  it('separates the transition, the target, the actor and the reason', () => {
    const base = fingerprintLifecycle(MOVE);
    const variants: readonly LifecycleIntent[] = [
      // Reusing one operation id across two different moves must not replay.
      { ...MOVE, transition: 'reactivate' },
      { ...MOVE, tenantId: '018f9000-0000-7000-8000-00000000000b' },
      { ...MOVE, controlPlaneActorRef: 'ops:platform/omar' },
      { ...MOVE, reason: 'a different reason' },
      { ...MOVE, reason: null },
    ];
    for (const variant of variants) expect(fingerprintLifecycle(variant)).not.toBe(base);
    expect(new Set(variants.map(fingerprintLifecycle)).size).toBe(variants.length);
  });

  it('tells an absent reason apart from an empty one', () => {
    expect(fingerprintLifecycle({ ...MOVE, reason: null })).not.toBe(
      fingerprintLifecycle({ ...MOVE, reason: '' }),
    );
  });
});
