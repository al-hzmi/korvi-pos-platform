/**
 * Origin checking for cookie-authenticated writes.
 *
 * SameSite=Lax already blocks a cross-site POST from carrying the cookie in
 * every browser that implements it. This is the second lock: an exact-match
 * check on the Origin header for every unsafe method, so a browser that is
 * lenient, old, or being driven by something that is not a browser still gets
 * refused.
 *
 * Exact string equality against a configured list. No wildcards, no suffix
 * matching — "https://korvi.sa.evil.example" ends with the right characters,
 * and a suffix check is how that becomes a valid origin.
 *
 * X-Forwarded-* is deliberately ignored. Those headers are set by whoever
 * spoke to the server last, which in a misconfiguration is the attacker; this
 * server does not establish trusted-proxy semantics, so it does not pretend to.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export interface OriginDecision {
  readonly allowed: boolean;
  readonly reason: 'safe-method' | 'match' | 'missing-origin' | 'foreign-origin';
}

export function checkOrigin(
  method: string,
  origin: string | undefined,
  allowed: readonly string[],
): OriginDecision {
  if (isSafeMethod(method)) return { allowed: true, reason: 'safe-method' };
  if (origin === undefined || origin === '') {
    // Fail closed. A state-changing request with no Origin is either an old
    // client or something that is not a browser at all, and neither is worth
    // a session cookie.
    return { allowed: false, reason: 'missing-origin' };
  }
  return allowed.includes(origin)
    ? { allowed: true, reason: 'match' }
    : { allowed: false, reason: 'foreign-origin' };
}
