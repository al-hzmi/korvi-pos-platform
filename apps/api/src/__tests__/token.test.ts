import { describe, expect, it } from 'vitest';
import { TOKEN_PREFIX, hashToken, hashesMatch, issueToken, parseToken } from '../auth/token.js';

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const OTHER = '018f3a1c-9b2e-7c4d-8e5f-ffffffffffff';

describe('session tokens', () => {
  it('carries 256 bits of secret in a parseable envelope', () => {
    const issued = issueToken(TENANT);
    const parsed = parseToken(issued.token);

    expect(parsed?.tenantHint).toBe(TENANT);
    // 32 bytes base64url is 43 characters, no padding.
    expect(parsed?.secret).toHaveLength(43);
    expect(issued.token.startsWith(`${TOKEN_PREFIX}.`)).toBe(true);
  });

  it('never issues the same token twice', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) seen.add(issueToken(TENANT).token);
    expect(seen.size).toBe(200);
  });

  it('hands the caller a hash to store and a token to send', () => {
    const issued = issueToken(TENANT);
    expect(issued.tokenHash).not.toContain(issued.token);
    expect(issued.tokenHash).toBe(hashToken(issued.token));
    // The hash is what a database holds. It must not be reversible into the
    // token, which for SHA-256 over 256 random bits it is not.
    expect(issued.tokenHash).toHaveLength(43);
  });

  it('hashes the tenant segment along with the secret', () => {
    // This is what makes the hint unusable as authorization: editing it
    // produces a value that hashes to something no row carries.
    const issued = issueToken(TENANT);
    const parsed = parseToken(issued.token);
    const moved = `${TOKEN_PREFIX}.${OTHER}.${parsed?.secret ?? ''}`;
    expect(hashToken(moved)).not.toBe(issued.tokenHash);
  });

  it.each([
    ['empty', ''],
    ['no prefix', `${TENANT}.abc`],
    ['wrong prefix', `kps0.${TENANT}.${'a'.repeat(43)}`],
    ['too few parts', `kps1.${TENANT}`],
    ['too many parts', `kps1.${TENANT}.${'a'.repeat(43)}.extra`],
    ['tenant not a uuid', `kps1.not-a-uuid.${'a'.repeat(43)}`],
    ['secret too short', `kps1.${TENANT}.${'a'.repeat(42)}`],
    ['secret not base64url', `kps1.${TENANT}.${'!'.repeat(43)}`],
    ['absurdly long', `kps1.${TENANT}.${'a'.repeat(500)}`],
  ])('refuses a %s token', (_label, candidate) => {
    expect(parseToken(candidate)).toBeNull();
  });

  it('compares hashes without leaking their contents through timing', () => {
    expect(hashesMatch('abc', 'abc')).toBe(true);
    expect(hashesMatch('abc', 'abd')).toBe(false);
    expect(hashesMatch('abc', 'abcd')).toBe(false);
  });
});
