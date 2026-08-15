import { describe, expect, it } from 'vitest';
import { OWNER_BOOTSTRAP_CAPABILITY_VERSION } from '@korvi/domain';
import {
  signOwnerBootstrapCapability,
  verifyOwnerBootstrapCapability,
} from '../bootstrap/capability.js';
import type { OwnerBootstrapClaims } from '@korvi/domain';

const KEY = 'a'.repeat(48);
const OTHER_KEY = 'b'.repeat(48);
const NOW = new Date('2026-08-20T09:00:00.000Z');

const CLAIMS: OwnerBootstrapClaims = {
  invitationId: '018f9d00-0000-7000-8000-00000000000a',
  tenantId: '018f9d00-0000-7000-8000-00000000000b',
  expiresAt: '2026-08-21T09:00:00.000Z',
};

function retamper(token: string, index: 1 | 2, mutate: (part: string) => string): string {
  const parts = token.split('.');
  parts[index] = mutate(parts[index] ?? '');
  return parts.join('.');
}

describe('owner bootstrap capability', () => {
  it('round-trips exactly the three claims it carries', () => {
    const token = signOwnerBootstrapCapability(KEY, CLAIMS);
    expect(token.startsWith(`${OWNER_BOOTSTRAP_CAPABILITY_VERSION}.`)).toBe(true);
    expect(verifyOwnerBootstrapCapability(KEY, token, NOW)).toEqual(CLAIMS);
  });

  it('is deterministic, which is what lets a replay re-derive it', () => {
    // The token is never stored. An idempotent re-issue hands back the same
    // string because the row and the key are the same.
    expect(signOwnerBootstrapCapability(KEY, CLAIMS)).toBe(
      signOwnerBootstrapCapability(KEY, { ...CLAIMS }),
    );
  });

  it('carries no email, display name, role or operator', () => {
    const payload = signOwnerBootstrapCapability(KEY, CLAIMS).split('.')[1] ?? '';
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    for (const absent of ['@', 'owner', 'email', 'role', 'actor', 'password']) {
      expect(decoded.toLowerCase()).not.toContain(absent);
    }
  });

  it('refuses a tampered payload', () => {
    const token = signOwnerBootstrapCapability(KEY, CLAIMS);
    // A different tenant, re-encoded honestly — and unsigned.
    const forged = Buffer.from(
      JSON.stringify([
        OWNER_BOOTSTRAP_CAPABILITY_VERSION,
        CLAIMS.invitationId,
        '018f9d00-0000-7000-8000-0000000000ff',
        CLAIMS.expiresAt,
      ]),
      'utf8',
    ).toString('base64url');
    expect(
      verifyOwnerBootstrapCapability(
        KEY,
        retamper(token, 1, () => forged),
        NOW,
      ),
    ).toBeNull();
  });

  it('refuses a tampered signature, a truncated one and an empty one', () => {
    const token = signOwnerBootstrapCapability(KEY, CLAIMS);
    expect(
      verifyOwnerBootstrapCapability(
        KEY,
        retamper(token, 2, (s) => `${s.slice(0, -1)}A`),
        NOW,
      ),
    ).toBeNull();
    expect(
      verifyOwnerBootstrapCapability(
        KEY,
        retamper(token, 2, (s) => s.slice(0, 10)),
        NOW,
      ),
    ).toBeNull();
    expect(
      verifyOwnerBootstrapCapability(
        KEY,
        retamper(token, 2, () => ''),
        NOW,
      ),
    ).toBeNull();
  });

  it('refuses a token signed with a different key', () => {
    const token = signOwnerBootstrapCapability(OTHER_KEY, CLAIMS);
    expect(verifyOwnerBootstrapCapability(KEY, token, NOW)).toBeNull();
  });

  it('refuses a wrong version, because the version is inside the signature', () => {
    const token = signOwnerBootstrapCapability(KEY, CLAIMS);
    expect(verifyOwnerBootstrapCapability(KEY, token.replace(/^v1\./, 'v2.'), NOW)).toBeNull();
    // And a v1 payload cannot be relabelled: the bytes that were signed
    // included the prefix.
    const parts = token.split('.');
    expect(
      verifyOwnerBootstrapCapability(KEY, `v2.${parts[1] ?? ''}.${parts[2] ?? ''}`, NOW),
    ).toBeNull();
  });

  it('refuses an expired token', () => {
    const token = signOwnerBootstrapCapability(KEY, CLAIMS);
    const later = new Date('2026-08-22T09:00:00.000Z');
    expect(verifyOwnerBootstrapCapability(KEY, token, later)).toBeNull();
  });

  it('refuses shapes that are not tokens at all', () => {
    for (const bad of ['', 'v1', 'v1.', 'v1..', 'not-a-token', 'v1.a.b.c', 'a'.repeat(2000)]) {
      expect(verifyOwnerBootstrapCapability(KEY, bad, NOW), bad).toBeNull();
    }
  });
});
