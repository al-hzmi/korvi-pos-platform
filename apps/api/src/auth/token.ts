import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The browser-held session token.
 *
 * Shape: `kps1.<tenant-uuid>.<43 base64url characters>`
 *
 * The tenant segment exists for one reason: RLS has to be established *before*
 * the sessions table can be read, and the sessions table is where the session
 * lives. Something has to say which tenant context to open, and the only thing
 * the request carries is the cookie.
 *
 * It is a routing hint and nothing else. Three things make it unusable as
 * authorization:
 *
 *   the stored hash covers the whole token, tenant segment included, so
 *   editing that segment produces a value that hashes to nothing;
 *
 *   the lookup runs inside the hinted tenant's RLS context, so a session row
 *   belonging to another tenant is not visible to be found;
 *
 *   the 256-bit secret is what actually authenticates, and it is unguessable.
 *
 * Changing the hint on a stolen-but-valid token therefore fails twice over
 * rather than crossing into the named tenant. There is a live test for it.
 */

export const TOKEN_PREFIX = 'kps1';
const SECRET_BYTES = 32;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ParsedToken {
  readonly tenantHint: string;
  readonly secret: string;
  readonly raw: string;
}

export interface IssuedToken {
  /** Goes to the browser, once, in a Set-Cookie header. Never persisted. */
  readonly token: string;
  /** Goes to the database. */
  readonly tokenHash: string;
  readonly tenantHint: string;
}

export function issueToken(tenantId: string): IssuedToken {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new Error('issueToken: tenant id must be a UUID.');
  }
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${TOKEN_PREFIX}.${tenantId}.${secret}`;
  return { token, tokenHash: hashToken(token), tenantHint: tenantId };
}

/**
 * SHA-256, not scrypt.
 *
 * A password is low-entropy and needs a slow KDF. This secret is 256 bits from
 * the system CSPRNG: there is nothing to brute force, and a slow hash on every
 * request would cost real latency for no gain.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** Strict parse. Anything that is not exactly the expected shape is rejected. */
export function parseToken(candidate: string): ParsedToken | null {
  if (candidate.length > 200) return null;
  const parts = candidate.split('.');
  if (parts.length !== 3) return null;
  const [prefix, tenantHint, secret] = parts;
  if (prefix !== TOKEN_PREFIX) return null;
  if (tenantHint === undefined || !UUID_PATTERN.test(tenantHint)) return null;
  if (secret === undefined || !SECRET_PATTERN.test(secret)) return null;
  return { tenantHint, secret, raw: candidate };
}

/** Constant-time comparison of two encoded hashes of equal length. */
export function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
