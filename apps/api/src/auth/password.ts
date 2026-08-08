import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/**
 * scrypt as a promise, written out rather than promisified.
 *
 * `promisify` resolves to the three-argument overload, which silently drops the
 * options object — and the options object is where N, r, p and maxmem live. A
 * hash derived without them would be scrypt at Node's defaults, which is not
 * the profile this file documents.
 */
function derive(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error !== null) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing with scrypt from the Node standard library.
 *
 * scrypt rather than a plain digest because a password is low-entropy: SHA-256
 * over a whole leaked table is minutes of GPU time, and the only defence is to
 * make each guess expensive in memory as well as in cycles. scrypt rather than
 * argon2 because argon2 means a native module in every build, deploy and CI
 * image, and Node 24 ships scrypt with parameters OWASP considers equivalent
 * for this purpose (ADR-0012).
 *
 * Parameters travel *with* the hash. Raising the cost later then re-hashes on
 * next login instead of invalidating every password in the database.
 */
export interface ScryptProfile {
  /** CPU/memory cost. Must be a power of two. */
  readonly N: number;
  /** Block size. */
  readonly r: number;
  /** Parallelisation. */
  readonly p: number;
  readonly keyLength: number;
  readonly saltLength: number;
}

/**
 * OWASP's second listed configuration: N=2^16, r=8, p=2.
 *
 * The first (N=2^17, r=8, p=1) needs 128 MiB per concurrent login. On a small
 * VPS running the API and Postgres together, a dozen simultaneous logins would
 * be 1.5 GiB of transient allocation; this one halves that for equivalent
 * work. Both are on the same OWASP line, so this is a deployment choice rather
 * than a weakening.
 */
export const PRODUCTION_SCRYPT: ScryptProfile = {
  N: 65_536,
  r: 8,
  p: 2,
  keyLength: 32,
  saltLength: 16,
};

/** scrypt requires maxmem above 128 * N * r; Node's default 32 MiB is below it. */
function maxmemFor(profile: ScryptProfile): number {
  return 256 * profile.N * profile.r;
}

const PREFIX = 'scrypt';
const VERSION = '1';

export class MalformedHashError extends Error {
  public override readonly name = 'MalformedHashError';
}

/**
 * `scrypt$1$N=65536,r=8,p=2$<salt>$<key>`, both fields base64url.
 *
 * Self-describing on purpose: a hash lifted out of a backup can be identified
 * and audited without reference to the code that wrote it, and a future
 * parameter change is a new field value rather than a migration.
 */
export function encodeHash(profile: ScryptProfile, salt: Buffer, derived: Buffer): string {
  const params = `N=${String(profile.N)},r=${String(profile.r)},p=${String(profile.p)}`;
  return [PREFIX, VERSION, params, salt.toString('base64url'), derived.toString('base64url')].join(
    '$',
  );
}

interface ParsedHash {
  readonly profile: ScryptProfile;
  readonly salt: Buffer;
  readonly derived: Buffer;
}

export function parseHash(encoded: string): ParsedHash {
  const parts = encoded.split('$');
  if (parts.length !== 5) throw new MalformedHashError('Wrong number of fields.');
  const [prefix, version, params, saltPart, keyPart] = parts;
  if (prefix !== PREFIX) throw new MalformedHashError('Not a scrypt hash.');
  if (version !== VERSION) throw new MalformedHashError('Unknown hash version.');

  const numbers = new Map<string, number>();
  for (const pair of (params ?? '').split(',')) {
    const [name, value] = pair.split('=');
    if (name === undefined || value === undefined || !/^[0-9]+$/.test(value)) {
      throw new MalformedHashError('Unreadable parameters.');
    }
    numbers.set(name, Number(value));
  }

  const N = numbers.get('N');
  const r = numbers.get('r');
  const p = numbers.get('p');
  if (N === undefined || r === undefined || p === undefined) {
    throw new MalformedHashError('Missing parameters.');
  }
  // A hash claiming N=2 would verify instantly. Refusing to honour parameters
  // below the floor means a tampered row fails rather than becoming a fast
  // path into the account.
  if (N < 16_384 || r < 8 || p < 1 || (N & (N - 1)) !== 0) {
    throw new MalformedHashError('Parameters below the accepted floor.');
  }

  const salt = Buffer.from(saltPart ?? '', 'base64url');
  const derived = Buffer.from(keyPart ?? '', 'base64url');
  if (salt.length < 16 || derived.length < 32) {
    throw new MalformedHashError('Salt or key too short.');
  }

  return {
    profile: { N, r, p, keyLength: derived.length, saltLength: salt.length },
    salt,
    derived,
  };
}

export async function hashPassword(
  password: string,
  profile: ScryptProfile = PRODUCTION_SCRYPT,
): Promise<string> {
  const salt = randomBytes(profile.saltLength);
  const derived = await derive(password.normalize('NFKC'), salt, profile.keyLength, {
    N: profile.N,
    r: profile.r,
    p: profile.p,
    maxmem: maxmemFor(profile),
  });
  return encodeHash(profile, salt, derived);
}

/**
 * Verify, returning a boolean and never an explanation.
 *
 * A malformed stored hash returns false rather than throwing: the caller is an
 * authentication path, and an exception there becomes a 500 that tells an
 * attacker their guess reached a real account with a broken row.
 *
 * The comparison is timing-safe. It is over derived keys, not the password, so
 * the usual objection — that the attacker controls one side — does not make it
 * pointless: a non-constant-time compare over a *derived* key still leaks a
 * per-byte oracle to anyone who can also submit chosen input.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  let parsed: ParsedHash;
  try {
    parsed = parseHash(encoded);
  } catch {
    return false;
  }

  try {
    const derived = await derive(password.normalize('NFKC'), parsed.salt, parsed.derived.length, {
      N: parsed.profile.N,
      r: parsed.profile.r,
      p: parsed.profile.p,
      maxmem: maxmemFor(parsed.profile),
    });
    return derived.length === parsed.derived.length && timingSafeEqual(derived, parsed.derived);
  } catch {
    return false;
  }
}

/**
 * A real hash of a value nobody knows, per profile.
 *
 * The login path verifies against this when the account does not exist, so the
 * unknown-email branch costs the same scrypt work as the wrong-password branch.
 * Without it, "user not found" returns in a millisecond and "wrong password" in
 * two hundred, and the difference enumerates the customer's staff list.
 *
 * Computed once and cached: a constant baked into the source would drift from
 * the profile the moment the parameters change.
 */
const dummies = new Map<string, Promise<string>>();

export function dummyHashFor(profile: ScryptProfile = PRODUCTION_SCRYPT): Promise<string> {
  const key = `${String(profile.N)}:${String(profile.r)}:${String(profile.p)}`;
  const existing = dummies.get(key);
  if (existing !== undefined) return existing;
  const created = hashPassword(randomBytes(32).toString('base64url'), profile);
  dummies.set(key, created);
  return created;
}

/** Burn the same work as a real verification, and always fail. */
export async function verifyAgainstDummy(
  password: string,
  profile: ScryptProfile = PRODUCTION_SCRYPT,
): Promise<false> {
  await verifyPassword(password, await dummyHashFor(profile));
  return false;
}
