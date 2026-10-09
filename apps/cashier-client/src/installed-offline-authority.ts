import type { OfflineWorkspaceSnapshot } from '@korvi/pos-web/offline-workspace';

const KOL_VERSION = 'kol1';
const MAX_OFFLINE_LEASE_MS = 7 * 24 * 60 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InstalledDeviceStatus {
  readonly platform: string;
  readonly installationId: string;
  readonly keyAlgorithm: string;
  readonly publicKeySpki: string;
  readonly publicKeySha256: string;
  readonly custody: string;
  readonly hardwareBacked: boolean;
  readonly strongboxBacked: boolean;
  readonly binding: { readonly tenantId: string; readonly deviceEnrollmentId: string } | null;
}

export interface NativeOfflineAuthorityMaterial {
  readonly version: 1;
  readonly lease: string;
  readonly verificationKeySpki: string;
  readonly deviceEnvelope: string;
  readonly deviceSignature: string;
}

export interface InstalledOfflineAuthority {
  readonly leaseId: string;
  readonly deviceEnrollmentId: string;
  readonly expiresAt: string;
}

interface LeaseEntitlement {
  readonly key: string;
  readonly kind: string;
  readonly flagValue: boolean | null;
  readonly limitValue: string | null;
}

interface LeaseClaims {
  readonly version: number;
  readonly issuer: string;
  readonly leaseId: string;
  readonly keyId: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly deviceEnrollmentId: string;
  readonly devicePublicKeySha256: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly userDisplayName: string;
  readonly sessionId: string;
  readonly roles: readonly string[];
  readonly maxDiscountBasisPoints: string;
  readonly assignmentId: string;
  readonly planKey: string;
  readonly planRevision: number;
  readonly entitlementRevision: string;
  readonly entitlements: readonly LeaseEntitlement[];
  readonly capabilities: readonly string[];
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly issuedAtUnixMs: number;
  readonly notBeforeUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly leaseRevision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error('invalid base64');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** WebCrypto requires an ArrayBuffer-backed BufferSource under modern TS DOM typings. */
function cryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function parseDerLength(
  bytes: Uint8Array,
  offset: number,
): { readonly length: number; readonly next: number } {
  const first = bytes[offset];
  if (first === undefined) throw new Error('invalid DER length');
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count < 1 || count > 2 || offset + count >= bytes.length)
    throw new Error('invalid DER length');
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    const byte = bytes[offset + 1 + index];
    if (byte === undefined) throw new Error('invalid DER length');
    length = length * 256 + byte;
  }
  return { length, next: offset + 1 + count };
}

function derInteger(
  bytes: Uint8Array,
  offset: number,
): { readonly value: Uint8Array; readonly next: number } {
  if (bytes[offset] !== 0x02) throw new Error('invalid ECDSA DER integer');
  const parsed = parseDerLength(bytes, offset + 1);
  const end = parsed.next + parsed.length;
  if (end > bytes.length || parsed.length === 0) throw new Error('invalid ECDSA DER integer');
  let value = bytes.slice(parsed.next, end);
  while (value.length > 1 && value[0] === 0) value = value.slice(1);
  if (value.length > 32) throw new Error('invalid P-256 ECDSA integer');
  const padded = new Uint8Array(32);
  padded.set(value, 32 - value.length);
  return { value: padded, next: end };
}

/** Native Windows/Android ECDSA signatures are ASN.1 DER; WebCrypto verifies P1363 r||s. */
export function ecdsaDerToP1363(signature: Uint8Array): Uint8Array {
  if (signature[0] !== 0x30) throw new Error('invalid ECDSA DER sequence');
  const sequence = parseDerLength(signature, 1);
  if (sequence.next + sequence.length !== signature.length)
    throw new Error('invalid ECDSA DER sequence');
  const r = derInteger(signature, sequence.next);
  const s = derInteger(signature, r.next);
  if (s.next !== signature.length) throw new Error('invalid ECDSA DER sequence');
  const raw = new Uint8Array(64);
  raw.set(r.value, 0);
  raw.set(s.value, 32);
  return raw;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === ''))
    return null;
  return value as readonly string[];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function parseEntitlements(value: unknown): readonly LeaseEntitlement[] | null {
  if (!Array.isArray(value)) return null;
  const result: LeaseEntitlement[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== 'string' ||
      entry.key.trim() === '' ||
      typeof entry.kind !== 'string' ||
      entry.kind.trim() === '' ||
      !(entry.flagValue === null || typeof entry.flagValue === 'boolean') ||
      !(entry.limitValue === null || typeof entry.limitValue === 'string')
    )
      return null;
    result.push({
      key: entry.key,
      kind: entry.kind,
      flagValue: entry.flagValue,
      limitValue: entry.limitValue,
    });
  }
  return result;
}

function parseLeaseClaims(value: unknown): LeaseClaims | null {
  if (!isRecord(value)) return null;
  const roles = stringArray(value.roles);
  const capabilities = stringArray(value.capabilities);
  const entitlements = parseEntitlements(value.entitlements);
  const strings = [
    'issuer',
    'leaseId',
    'keyId',
    'tenantId',
    'tenantSlug',
    'branchId',
    'terminalId',
    'deviceEnrollmentId',
    'devicePublicKeySha256',
    'userId',
    'userEmail',
    'userDisplayName',
    'sessionId',
    'maxDiscountBasisPoints',
    'assignmentId',
    'planKey',
    'entitlementRevision',
    'issuedAt',
    'notBefore',
    'expiresAt',
  ] as const;
  if (strings.some((key) => typeof value[key] !== 'string' || (value[key] as string).trim() === ''))
    return null;
  if (
    value.version !== 1 ||
    value.issuer !== 'korvi-platform' ||
    value.leaseRevision !== 1 ||
    typeof value.planRevision !== 'number' ||
    !Number.isSafeInteger(value.planRevision) ||
    value.planRevision < 0 ||
    typeof value.issuedAtUnixMs !== 'number' ||
    !Number.isSafeInteger(value.issuedAtUnixMs) ||
    typeof value.notBeforeUnixMs !== 'number' ||
    !Number.isSafeInteger(value.notBeforeUnixMs) ||
    typeof value.expiresAtUnixMs !== 'number' ||
    !Number.isSafeInteger(value.expiresAtUnixMs) ||
    roles === null ||
    capabilities === null ||
    entitlements === null
  )
    return null;
  return {
    ...(value as unknown as Omit<LeaseClaims, 'roles' | 'capabilities' | 'entitlements'>),
    roles,
    capabilities,
    entitlements,
  };
}

function validIsoPair(text: string, milliseconds: number): boolean {
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed === milliseconds;
}

function canonicalUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function validateClaims(
  claims: LeaseClaims,
  status: InstalledDeviceStatus,
  snapshot: OfflineWorkspaceSnapshot,
  nowUnixMs: number,
): boolean {
  const binding = status.binding;
  if (binding === null || status.keyAlgorithm !== 'p256') return false;
  if (
    !canonicalUuid(claims.leaseId) ||
    !canonicalUuid(claims.tenantId) ||
    !canonicalUuid(claims.branchId) ||
    !canonicalUuid(claims.terminalId) ||
    !canonicalUuid(claims.deviceEnrollmentId) ||
    !canonicalUuid(claims.userId) ||
    !canonicalUuid(claims.sessionId) ||
    !canonicalUuid(claims.assignmentId)
  )
    return false;
  if (
    claims.tenantId !== binding.tenantId ||
    claims.deviceEnrollmentId !== binding.deviceEnrollmentId ||
    claims.devicePublicKeySha256.toLowerCase() !== status.publicKeySha256.toLowerCase() ||
    claims.tenantId !== snapshot.principal.tenant.id ||
    claims.branchId !== snapshot.terminal.branchId ||
    claims.terminalId !== snapshot.terminal.id ||
    claims.userId !== snapshot.principal.user.id ||
    claims.userEmail !== snapshot.principal.user.email ||
    claims.userDisplayName !== snapshot.principal.user.displayName ||
    claims.sessionId !== snapshot.principal.session.id ||
    (snapshot.principal.tenant.slug !== undefined &&
      claims.tenantSlug !== snapshot.principal.tenant.slug) ||
    !sameStrings(claims.roles, snapshot.principal.roles) ||
    !sameStrings(claims.capabilities, snapshot.principal.permissions)
  )
    return false;
  if (
    !/^\d{1,5}$/.test(claims.maxDiscountBasisPoints) ||
    Number(claims.maxDiscountBasisPoints) > 10_000 ||
    !validIsoPair(claims.issuedAt, claims.issuedAtUnixMs) ||
    !validIsoPair(claims.notBefore, claims.notBeforeUnixMs) ||
    !validIsoPair(claims.expiresAt, claims.expiresAtUnixMs) ||
    claims.issuedAtUnixMs > claims.notBeforeUnixMs ||
    claims.notBeforeUnixMs > claims.expiresAtUnixMs ||
    claims.expiresAtUnixMs - claims.issuedAtUnixMs > MAX_OFFLINE_LEASE_MS ||
    nowUnixMs < claims.notBeforeUnixMs ||
    nowUnixMs >= claims.expiresAtUnixMs
  )
    return false;
  return claims.entitlements.some(
    (entry) => entry.key === 'pos.enabled' && entry.kind === 'flag' && entry.flagValue === true,
  );
}

async function verifyDeviceEnvelope(
  material: NativeOfflineAuthorityMaterial,
  status: InstalledDeviceStatus,
): Promise<boolean> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(material.deviceEnvelope) as unknown;
  } catch {
    return false;
  }
  if (
    !isRecord(envelope) ||
    envelope.version !== 1 ||
    envelope.lease !== material.lease ||
    envelope.verificationKeySpki !== material.verificationKeySpki
  )
    return false;
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      cryptoBuffer(decodeBase64(status.publicKeySpki)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      cryptoBuffer(ecdsaDerToP1363(decodeBase64(material.deviceSignature))),
      cryptoBuffer(new TextEncoder().encode(material.deviceEnvelope)),
    );
  } catch {
    return false;
  }
}

async function verifyKol1(material: NativeOfflineAuthorityMaterial): Promise<LeaseClaims | null> {
  const parts = material.lease.split('.');
  if (parts.length !== 3 || parts[0] !== KOL_VERSION || parts[1] === '' || parts[2] === '')
    return null;
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      cryptoBuffer(decodeBase64(material.verificationKeySpki)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      cryptoBuffer(decodeBase64(parts[2]!)),
      cryptoBuffer(new TextEncoder().encode(`${KOL_VERSION}.${parts[1]}`)),
    );
    if (!valid) return null;
    const payload = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(parts[1]!));
    return parseLeaseClaims(JSON.parse(payload) as unknown);
  } catch {
    return null;
  }
}

/**
 * Installed Cashier offline reopening is allowed only by server-signed authority
 * that was cached by the trusted Native boundary and sealed by this OS-held
 * device identity. No bearer token or private signing material reaches JS.
 */
export async function verifyInstalledOfflineAuthority(
  material: NativeOfflineAuthorityMaterial,
  status: InstalledDeviceStatus,
  snapshot: OfflineWorkspaceSnapshot,
  nowUnixMs = Date.now(),
): Promise<InstalledOfflineAuthority | null> {
  if (material.version !== 1 || status.binding === null) return null;
  if (!(await verifyDeviceEnvelope(material, status))) return null;
  const claims = await verifyKol1(material);
  if (claims === null || !validateClaims(claims, status, snapshot, nowUnixMs)) return null;
  return {
    leaseId: claims.leaseId,
    deviceEnrollmentId: claims.deviceEnrollmentId,
    expiresAt: claims.expiresAt,
  };
}
