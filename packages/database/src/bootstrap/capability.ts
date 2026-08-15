import { createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_OWNER_BOOTSTRAP_TOKEN, OWNER_BOOTSTRAP_CAPABILITY_VERSION } from '@korvi/domain';
import type { OwnerBootstrapClaims } from '@korvi/domain';

/**
 * The bootstrap capability: a signed statement, not a stored secret.
 *
 *     v1.<base64url canonical payload>.<base64url HMAC-SHA256>
 *
 * HMAC-SHA256 from `node:crypto` rather than a JWT library, because the only
 * thing needed here is "did this server mint these three claims", and a JWT
 * dependency would bring an algorithm-negotiation field — the header that has
 * produced more token vulnerabilities than any other design decision in the
 * format. There is exactly one algorithm here and it is not negotiable by the
 * token.
 *
 * The version prefix is *inside* the signed bytes. A verifier that read the
 * version from an unsigned prefix could be handed a v1 payload wearing a v2
 * label, which is the downgrade every versioned token eventually meets.
 *
 * The raw token is never persisted. Everything in the payload comes from the
 * invitation row, so an idempotent re-issue re-derives the identical token from
 * the row and the key — storing the token to support replay would mean keeping
 * a live credential in a table for no gain (ADR-0021).
 */

/** Signed as an array, so field order is the encoding's and not an object's. */
function canonical(claims: OwnerBootstrapClaims): string {
  return JSON.stringify([
    OWNER_BOOTSTRAP_CAPABILITY_VERSION,
    claims.invitationId,
    claims.tenantId,
    claims.expiresAt,
  ]);
}

function sign(key: string, signedPart: string): Buffer {
  return createHmac('sha256', key).update(signedPart, 'utf8').digest();
}

export function signOwnerBootstrapCapability(key: string, claims: OwnerBootstrapClaims): string {
  const payload = Buffer.from(canonical(claims), 'utf8').toString('base64url');
  const signedPart = `${OWNER_BOOTSTRAP_CAPABILITY_VERSION}.${payload}`;
  return `${signedPart}.${sign(key, signedPart).toString('base64url')}`;
}

/**
 * Verify, then read. Never the other way round.
 *
 * Every early return is the same `null`: a caller of this function cannot tell
 * a wrong version from a bad signature from a stale expiry, because the public
 * surface above it must not be able to either (ADR-0021).
 *
 * The comparison is `timingSafeEqual` on equal-length buffers. A `===` on two
 * base64 strings leaks, one byte at a time, how much of a forged signature was
 * right — which over enough requests is a signature.
 */
export function verifyOwnerBootstrapCapability(
  key: string,
  token: string,
  now: Date,
): OwnerBootstrapClaims | null {
  // Bounded before anything is parsed: a token is a fixed shape, and an
  // unbounded one is an unbounded base64 decode and an unbounded HMAC.
  if (token.length === 0 || token.length > MAX_OWNER_BOOTSTRAP_TOKEN) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, payload, signature] = parts;
  if (version !== OWNER_BOOTSTRAP_CAPABILITY_VERSION) return null;
  if (payload === undefined || payload === '' || signature === undefined || signature === '') {
    return null;
  }

  const expected = sign(key, `${version}.${payload}`);
  let presented: Buffer;
  try {
    presented = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  // Length is checked first because timingSafeEqual throws on a mismatch, and
  // a thrown exception is itself a signal. Lengths are public: the digest is a
  // fixed 32 bytes and an attacker already knows that.
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;

  // Only now is anything in the payload treated as a fact.
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== 4) return null;
  const [signedVersion, invitationId, tenantId, expiresAt] = decoded as unknown[];
  if (
    signedVersion !== OWNER_BOOTSTRAP_CAPABILITY_VERSION ||
    typeof invitationId !== 'string' ||
    typeof tenantId !== 'string' ||
    typeof expiresAt !== 'string'
  ) {
    return null;
  }

  const deadline = new Date(expiresAt).getTime();
  if (Number.isNaN(deadline) || deadline <= now.getTime()) return null;

  return { invitationId, tenantId, expiresAt };
}
