import { describe, expect, it } from 'vitest';
import {
  MalformedHashError,
  PRODUCTION_SCRYPT,
  dummyHashFor,
  encodeHash,
  hashPassword,
  parseHash,
  verifyAgainstDummy,
  verifyPassword,
} from '../auth/password.js';

/** Cheap enough for a test run, still above the parser's accepted floor. */
const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;

describe('password hashing', () => {
  it('verifies a password it hashed', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    await expect(verifyPassword('Correct horse battery staple', hash)).resolves.toBe(false);
  });

  it('gives two identical passwords different hashes', async () => {
    // A per-password salt is what stops one rainbow table covering the table,
    // and what stops "these two cashiers use the same password" being visible
    // to anyone who reads the column.
    const [first, second] = await Promise.all([
      hashPassword('same', FAST),
      hashPassword('same', FAST),
    ]);
    expect(first).not.toBe(second);
    await expect(verifyPassword('same', first)).resolves.toBe(true);
    await expect(verifyPassword('same', second)).resolves.toBe(true);
  });

  it('carries its parameters, so the cost can be raised later', async () => {
    const hash = await hashPassword('x', FAST);
    expect(hash.startsWith('scrypt$1$N=16384,r=8,p=1$')).toBe(true);
    expect(parseHash(hash).profile.N).toBe(16_384);
  });

  it('normalises the password before hashing', async () => {
    // The same characters typed on two keyboards can arrive as different byte
    // sequences. NFKC on both sides means the user is not locked out by their
    // input method.
    const composed = 'passwórd';
    const precomposed = 'passwórd'.normalize('NFKC');
    const hash = await hashPassword(composed, FAST);
    await expect(verifyPassword(precomposed, hash)).resolves.toBe(true);
  });

  it.each([
    ['empty', ''],
    ['not scrypt', 'argon2$1$N=1$aaaa$bbbb'],
    ['wrong field count', 'scrypt$1$N=16384,r=8,p=1$onlyfour'],
    ['unknown version', 'scrypt$9$N=16384,r=8,p=1$aaaa$bbbb'],
    ['unreadable parameters', 'scrypt$1$N=abc,r=8,p=1$aaaa$bbbb'],
  ])('rejects a %s hash without throwing', async (_label, encoded) => {
    // The caller is a login path. An exception there is a 500 that tells an
    // attacker their guess landed on a real account with a broken row.
    await expect(verifyPassword('anything', encoded)).resolves.toBe(false);
  });

  it('refuses parameters below the floor rather than verifying fast', () => {
    // A tampered row claiming N=2 would verify in microseconds and would be a
    // fast path straight into the account.
    const weak = encodeHash(
      { N: 2, r: 8, p: 1, keyLength: 32, saltLength: 16 },
      Buffer.alloc(16, 1),
      Buffer.alloc(32, 2),
    );
    expect(() => parseHash(weak)).toThrow(MalformedHashError);
  });

  it('refuses a truncated salt or key', () => {
    const short = 'scrypt$1$N=16384,r=8,p=1$YWJj$YWJj';
    expect(() => parseHash(short)).toThrow(MalformedHashError);
  });

  it('is a memory-hard KDF, not a bare digest', async () => {
    // The production profile has to cost something. If this ever drops to a
    // millisecond, someone has quietly replaced scrypt with a hash.
    expect(PRODUCTION_SCRYPT.N).toBeGreaterThanOrEqual(65_536);
    expect(PRODUCTION_SCRYPT.r).toBeGreaterThanOrEqual(8);

    const started = process.hrtime.bigint();
    await hashPassword('measure me', PRODUCTION_SCRYPT);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeGreaterThan(25);
  }, 30_000);

  it('burns real work on the unknown-user path', async () => {
    // Without this, "no such user" returns in a millisecond and "wrong
    // password" in two hundred, and the difference enumerates the staff list.
    const dummy = await dummyHashFor(FAST);
    expect(dummy.startsWith('scrypt$1$')).toBe(true);
    await expect(verifyPassword('anything at all', dummy)).resolves.toBe(false);
    await expect(verifyAgainstDummy('anything at all', FAST)).resolves.toBe(false);
  });
});
