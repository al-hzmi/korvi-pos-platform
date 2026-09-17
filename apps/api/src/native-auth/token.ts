import { createHash, randomBytes } from 'node:crypto';

export const NATIVE_TOKEN_PREFIX = 'kns1';
const SECRET_BYTES = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface NativeIssuedToken {
  readonly token: string;
  readonly tokenHash: string;
  readonly tenantHint: string;
}

export interface ParsedNativeToken {
  readonly tenantHint: string;
  readonly raw: string;
}

export function issueNativeToken(tenantId: string): NativeIssuedToken {
  if (!UUID_PATTERN.test(tenantId)) throw new Error('native token tenant id must be a UUID');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${NATIVE_TOKEN_PREFIX}.${tenantId}.${secret}`;
  return { token, tokenHash: hashNativeToken(token), tenantHint: tenantId };
}

export function parseNativeToken(candidate: string): ParsedNativeToken | null {
  if (candidate.length > 200) return null;
  const parts = candidate.split('.');
  if (parts.length !== 3) return null;
  const [prefix, tenantHint, secret] = parts;
  if (prefix !== NATIVE_TOKEN_PREFIX) return null;
  if (tenantHint === undefined || !UUID_PATTERN.test(tenantHint)) return null;
  if (secret === undefined || !SECRET_PATTERN.test(secret)) return null;
  return { tenantHint, raw: candidate };
}

export function hashNativeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}
