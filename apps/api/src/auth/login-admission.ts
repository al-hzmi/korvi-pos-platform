import { createHash } from 'node:crypto';

/**
 * Application-side admission control for the unauthenticated login boundary.
 *
 * Account lockout protects a known account. It does not protect the process from
 * an attacker rotating tenant/email guesses, and every syntactically valid guess
 * deliberately pays the same scrypt cost to avoid account enumeration. This
 * controller therefore runs *before* tenant lookup and before any password KDF.
 *
 * It is intentionally dependency-free and process-local. A production edge
 * limiter remains a separate outer layer, but the API must still be able to
 * protect its own CPU/thread-pool if the edge is misconfigured or bypassed.
 */
export interface LoginAdmissionPolicy {
  /** Maximum accepted login attempts in one process during a window. */
  readonly globalLimit: number;
  /** Maximum accepted attempts for one canonical tenant/email pair per window. */
  readonly identityLimit: number;
  /** Fixed-window duration. Concurrency protection covers boundary bursts. */
  readonly windowMs: number;
  /** Maximum login pipelines allowed to reach repository/KDF work concurrently. */
  readonly maxConcurrent: number;
  /** Hard memory bound for identity buckets. */
  readonly maxTrackedIdentities: number;
}

export const DEFAULT_LOGIN_ADMISSION_POLICY: LoginAdmissionPolicy = {
  globalLimit: 60,
  identityLimit: 10,
  windowMs: 60_000,
  maxConcurrent: 2,
  maxTrackedIdentities: 4_096,
};

export interface LoginAdmissionPermit {
  readonly allowed: true;
  /** Must be called exactly once after the login pipeline finishes. Idempotent defensively. */
  release(): void;
}

export interface LoginAdmissionDenied {
  readonly allowed: false;
  readonly retryAfterSeconds: number;
  readonly reason: 'global-rate' | 'identity-rate' | 'concurrency';
}

export type LoginAdmission = LoginAdmissionPermit | LoginAdmissionDenied;

export interface LoginAdmissionController {
  admit(tenantSlug: string, email: string): LoginAdmission;
}

interface Bucket {
  windowStartedAt: number;
  count: number;
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function validatePolicy(policy: LoginAdmissionPolicy): void {
  positiveInteger('globalLimit', policy.globalLimit);
  positiveInteger('identityLimit', policy.identityLimit);
  positiveInteger('windowMs', policy.windowMs);
  positiveInteger('maxConcurrent', policy.maxConcurrent);
  positiveInteger('maxTrackedIdentities', policy.maxTrackedIdentities);
  if (policy.identityLimit > policy.globalLimit) {
    throw new Error('identityLimit cannot exceed globalLimit.');
  }
}

function canonicalIdentity(tenantSlug: string, email: string): string {
  // Hashing bounds attacker-controlled key size and avoids retaining raw login
  // identifiers in a long-lived process map. This is correlation, not secrecy.
  return createHash('sha256')
    .update(`${tenantSlug.trim().toLowerCase()}\u0000${email.trim().toLowerCase()}`, 'utf8')
    .digest('base64url');
}

function retryAfterSeconds(now: number, bucket: Bucket, windowMs: number): number {
  return Math.max(1, Math.ceil((bucket.windowStartedAt + windowMs - now) / 1_000));
}

export function createLoginAdmissionController(
  policy: LoginAdmissionPolicy = DEFAULT_LOGIN_ADMISSION_POLICY,
  now: () => number = Date.now,
): LoginAdmissionController {
  validatePolicy(policy);

  let active = 0;
  let global: Bucket = { windowStartedAt: now(), count: 0 };
  const identities = new Map<string, Bucket>();

  function currentBucket(bucket: Bucket | undefined, at: number): Bucket {
    if (bucket === undefined || at - bucket.windowStartedAt >= policy.windowMs) {
      return { windowStartedAt: at, count: 0 };
    }
    return bucket;
  }

  function evictOneIdentityIfFull(): void {
    if (identities.size < policy.maxTrackedIdentities) return;
    const oldest = identities.keys().next().value as string | undefined;
    if (oldest !== undefined) identities.delete(oldest);
  }

  return {
    admit(tenantSlug: string, email: string): LoginAdmission {
      const at = now();
      global = currentBucket(global, at);

      // Fail closed before allocating/looking up an identity bucket when the
      // process-wide budget is already exhausted.
      if (global.count >= policy.globalLimit) {
        return {
          allowed: false,
          retryAfterSeconds: retryAfterSeconds(at, global, policy.windowMs),
          reason: 'global-rate',
        };
      }

      const key = canonicalIdentity(tenantSlug, email);
      const identity = currentBucket(identities.get(key), at);
      if (identity.count >= policy.identityLimit) {
        identities.delete(key);
        identities.set(key, identity);
        return {
          allowed: false,
          retryAfterSeconds: retryAfterSeconds(at, identity, policy.windowMs),
          reason: 'identity-rate',
        };
      }

      // No queue: an unbounded queue simply moves the denial-of-service from
      // libuv into application memory. Excess work is rejected before KDF.
      if (active >= policy.maxConcurrent) {
        return { allowed: false, retryAfterSeconds: 1, reason: 'concurrency' };
      }

      if (!identities.has(key)) evictOneIdentityIfFull();
      identity.count += 1;
      identities.delete(key);
      identities.set(key, identity);
      global.count += 1;
      active += 1;

      let released = false;
      return {
        allowed: true,
        release(): void {
          if (released) return;
          released = true;
          active = Math.max(0, active - 1);
        },
      };
    },
  };
}
