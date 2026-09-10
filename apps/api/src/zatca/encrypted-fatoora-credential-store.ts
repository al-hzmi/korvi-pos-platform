import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import type { TenantScope, ZatcaFatooraSecretHandle } from '@korvi/domain';
import type {
  ZatcaFatooraCiphertextRecord,
  ZatcaFatooraCredentialRepository,
} from '@korvi/database';
import type {
  ZatcaFatooraCredentialStore,
  ZatcaFatooraCredentialStoreInput,
} from './compliance-csid-http-issuer.js';

export const KORVI_FATOORA_SECRET_PROVIDER = 'korvi-postgres-aes256gcm-v1';

const CREDENTIAL_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const AES_256_KEY_BYTES = 32;
const MAX_TOKEN_CHARACTERS = 32_768;
const MAX_SECRET_CHARACTERS = 8_192;

const plaintextSchema = z.tuple([
  z.literal('fatoora-v1'),
  z.string().min(1).max(MAX_TOKEN_CHARACTERS),
  z.string().min(1).max(MAX_SECRET_CHARACTERS),
]);

export interface ZatcaCredentialEncryptionKey {
  readonly id: string;
  readonly key: Uint8Array;
}

export interface CreateEncryptedZatcaFatooraCredentialStoreOptions {
  readonly repository: ZatcaFatooraCredentialRepository;
  readonly activeKeyId: string;
  readonly keys: readonly ZatcaCredentialEncryptionKey[];
  readonly randomBytesImpl?: (size: number) => Uint8Array;
}

export interface ResolveZatcaFatooraCredentialInput {
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly handle: ZatcaFatooraSecretHandle;
}

export interface ResolvedZatcaFatooraCredential {
  readonly binarySecurityToken: string;
  readonly secret: string;
}

export interface ZatcaFatooraCredentialResolver {
  resolve(input: ResolveZatcaFatooraCredentialInput): Promise<ResolvedZatcaFatooraCredential>;
}

export type EncryptedZatcaFatooraCredentialStore = ZatcaFatooraCredentialStore &
  ZatcaFatooraCredentialResolver;

/**
 * Encrypt and persist ZATCA Fatoora Basic-Authentication credentials.
 *
 * PostgreSQL sees only AES-256-GCM ciphertext. The encryption key is supplied
 * by the process secret boundary and is never written to the repository. AAD
 * binds the ciphertext to tenant + terminal + credential + key version, so a
 * valid encrypted row cannot be copied into another authority scope.
 *
 * `put` is deliberately idempotent: a race or replay may return the previously
 * stored ciphertext, which is decrypted and timing-safe compared with the
 * candidate plaintext. Same credential material converges; different material
 * fails closed and is never overwritten.
 */
export function createEncryptedZatcaFatooraCredentialStore(
  options: CreateEncryptedZatcaFatooraCredentialStoreOptions,
): EncryptedZatcaFatooraCredentialStore {
  const keys = buildKeyring(options.keys);
  const activeKey = keys.get(options.activeKeyId);
  if (activeKey === undefined) {
    throw new Error('Active ZATCA credential encryption key is not present in the keyring.');
  }
  const random = options.randomBytesImpl ?? ((size: number) => Uint8Array.from(randomBytes(size)));

  return {
    async put(input) {
      validateStoreInput(input);
      const plaintext = serializeCredential(input.binarySecurityToken, input.secret);
      const nonce = Uint8Array.from(random(AES_GCM_NONCE_BYTES));
      if (nonce.length !== AES_GCM_NONCE_BYTES) {
        throw new Error('ZATCA credential nonce source returned an invalid nonce length.');
      }
      const candidate = encrypt({
        plaintext,
        key: activeKey,
        nonce,
        aad: associatedData(input.scope, input.terminalId, input.credentialId, options.activeKeyId),
        terminalId: input.terminalId,
        credentialId: input.credentialId,
        keyId: options.activeKeyId,
      });

      const stored = await options.repository.reserve(input.scope, candidate);
      const storedPlaintext = decryptRecord(input.scope, stored, keys);
      if (!sameBytes(plaintext, storedPlaintext)) {
        throw new Error('ZATCA credential identity already exists with different secret material.');
      }

      return handleFor(input.credentialId);
    },

    async resolve(input) {
      validateTerminalId(input.terminalId);
      validateHandle(input.handle);
      const credentialId = input.handle.secretId;
      const stored = await options.repository.find(input.scope, input.terminalId, credentialId);
      if (stored === null) {
        throw new Error('ZATCA Fatoora credential is unavailable.');
      }
      const plaintext = decryptRecord(input.scope, stored, keys);
      const [version, binarySecurityToken, secret] = parsePlaintext(plaintext);
      if (version !== 'fatoora-v1') {
        throw new Error('ZATCA Fatoora credential version is unsupported.');
      }
      return { binarySecurityToken, secret };
    },
  };
}

function buildKeyring(keys: readonly ZatcaCredentialEncryptionKey[]): Map<string, Uint8Array> {
  if (keys.length < 1 || keys.length > 16) {
    throw new Error('ZATCA credential keyring must contain between 1 and 16 keys.');
  }
  const result = new Map<string, Uint8Array>();
  for (const candidate of keys) {
    validateKeyId(candidate.id);
    if (candidate.key.length !== AES_256_KEY_BYTES) {
      throw new Error('ZATCA credential encryption keys must be exactly 32 bytes.');
    }
    if (result.has(candidate.id)) {
      throw new Error('ZATCA credential encryption key ids must be unique.');
    }
    result.set(candidate.id, Uint8Array.from(candidate.key));
  }
  return result;
}

function encrypt(input: {
  readonly plaintext: Uint8Array;
  readonly key: Uint8Array;
  readonly nonce: Uint8Array;
  readonly aad: Uint8Array;
  readonly terminalId: string;
  readonly credentialId: string;
  readonly keyId: string;
}): ZatcaFatooraCiphertextRecord {
  const cipher = createCipheriv('aes-256-gcm', input.key, input.nonce, {
    authTagLength: AES_GCM_TAG_BYTES,
  });
  cipher.setAAD(input.aad);
  const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
  return {
    terminalId: input.terminalId,
    credentialId: input.credentialId,
    keyId: input.keyId,
    nonce: Uint8Array.from(input.nonce),
    ciphertext: Uint8Array.from(ciphertext),
    authTag: Uint8Array.from(cipher.getAuthTag()),
  };
}

function decryptRecord(
  scope: TenantScope,
  record: ZatcaFatooraCiphertextRecord,
  keys: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  validateTerminalId(record.terminalId);
  validateCredentialId(record.credentialId);
  validateKeyId(record.keyId);
  if (record.nonce.length !== AES_GCM_NONCE_BYTES || record.authTag.length !== AES_GCM_TAG_BYTES) {
    throw new Error('ZATCA Fatoora encrypted credential metadata is invalid.');
  }
  const key = keys.get(record.keyId);
  if (key === undefined) {
    throw new Error('ZATCA Fatoora credential encryption key is unavailable.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, record.nonce, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    decipher.setAAD(associatedData(scope, record.terminalId, record.credentialId, record.keyId));
    decipher.setAuthTag(record.authTag);
    return Uint8Array.from(Buffer.concat([decipher.update(record.ciphertext), decipher.final()]));
  } catch {
    throw new Error('ZATCA Fatoora credential authentication failed.');
  }
}

function associatedData(
  scope: TenantScope,
  terminalId: string,
  credentialId: string,
  keyId: string,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      'korvi-zatca-fatoora-aes256gcm-v1',
      scope.tenantId as string,
      terminalId,
      credentialId,
      keyId,
    ]),
  );
}

function serializeCredential(binarySecurityToken: string, secret: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['fatoora-v1', binarySecurityToken, secret]));
}

function parsePlaintext(bytes: Uint8Array): z.infer<typeof plaintextSchema> {
  try {
    const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const parsed = plaintextSchema.safeParse(json);
    if (!parsed.success) throw new Error('invalid credential plaintext');
    return parsed.data;
  } catch {
    throw new Error('ZATCA Fatoora credential plaintext is invalid.');
  }
}

function validateStoreInput(input: ZatcaFatooraCredentialStoreInput): void {
  validateTerminalId(input.terminalId);
  validateCredentialId(input.credentialId);
  if (
    input.binarySecurityToken.length < 1 ||
    input.binarySecurityToken.length > MAX_TOKEN_CHARACTERS ||
    input.secret.length < 1 ||
    input.secret.length > MAX_SECRET_CHARACTERS
  ) {
    throw new Error('ZATCA Fatoora credential material is outside allowed bounds.');
  }
}

function validateHandle(handle: ZatcaFatooraSecretHandle): void {
  if (handle.provider !== KORVI_FATOORA_SECRET_PROVIDER) {
    throw new Error('ZATCA Fatoora secret handle provider is not trusted by this store.');
  }
  validateCredentialId(handle.secretId);
}

function handleFor(credentialId: string): ZatcaFatooraSecretHandle {
  return { provider: KORVI_FATOORA_SECRET_PROVIDER, secretId: credentialId };
}

function validateCredentialId(value: string): void {
  if (!CREDENTIAL_ID_PATTERN.test(value)) {
    throw new Error('ZATCA credential id must be the SHA-256 certificate identity.');
  }
}

function validateTerminalId(value: string): void {
  if (value.trim() !== value || value.length < 1 || value.length > 500) {
    throw new Error('ZATCA terminal id is invalid.');
  }
}

function validateKeyId(value: string): void {
  if (value.trim() !== value || value.length < 1 || value.length > 100) {
    throw new Error('ZATCA credential encryption key id is invalid.');
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
