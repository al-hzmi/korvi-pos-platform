import type { ZatcaCredentialEncryptionKey } from './encrypted-fatoora-credential-store.js';

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const AES_256_KEY_BYTES = 32;
const AES_256_BASE64_CHARACTERS = 44;
const MAX_KEYS = 16;

export interface ZatcaFatooraVaultConfig {
  readonly activeKeyId: string;
  readonly keys: readonly ZatcaCredentialEncryptionKey[];
}

/**
 * Parse the process-secret boundary for the encrypted Fatoora credential vault.
 *
 * Both variables are optional as a pair because Gate 39 infrastructure may be
 * disabled in a development process. Supplying only one is always a boot-time
 * error. Production composition that enables ZATCA must require the returned
 * value to be non-null before constructing an issuer.
 *
 * `ZATCA_FATOORA_VAULT_KEYS` is a comma-separated keyring:
 *
 *   key-2026-09=<canonical base64 32-byte key>,key-previous=<...>
 *
 * Key material is decoded once at the configuration edge and is never written
 * to PostgreSQL, logs, errors, or returned to HTTP callers. Multiple keys allow
 * old ciphertext to remain decryptable while `activeKeyId` controls new writes.
 */
export function loadZatcaFatooraVaultConfig(
  env: NodeJS.ProcessEnv = process.env,
): ZatcaFatooraVaultConfig | null {
  const activeRaw = env['ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID'];
  const keysRaw = env['ZATCA_FATOORA_VAULT_KEYS'];

  if (activeRaw === undefined && keysRaw === undefined) return null;
  if (activeRaw === undefined || keysRaw === undefined) {
    throw new Error(
      'ZATCA Fatoora vault configuration is incomplete; active key id and keyring must be supplied together.',
    );
  }
  if (activeRaw !== activeRaw.trim() || !KEY_ID_PATTERN.test(activeRaw)) {
    throw new Error('ZATCA Fatoora vault active key id is invalid.');
  }
  if (keysRaw === '' || keysRaw !== keysRaw.trim()) {
    throw new Error('ZATCA Fatoora vault keyring is invalid.');
  }

  const entries = keysRaw.split(',');
  if (entries.length === 0 || entries.length > MAX_KEYS) {
    throw new Error('ZATCA Fatoora vault keyring size is invalid.');
  }

  const seen = new Set<string>();
  const keys: ZatcaCredentialEncryptionKey[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error('ZATCA Fatoora vault keyring entry is invalid.');
    }
    const id = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (!KEY_ID_PATTERN.test(id) || seen.has(id)) {
      throw new Error('ZATCA Fatoora vault key id is invalid or duplicated.');
    }
    if (encoded.length !== AES_256_BASE64_CHARACTERS || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
      throw new Error('ZATCA Fatoora vault key material is not canonical AES-256 base64.');
    }

    const decoded = Buffer.from(encoded, 'base64');
    if (
      decoded.length !== AES_256_KEY_BYTES ||
      decoded.toString('base64') !== encoded
    ) {
      throw new Error('ZATCA Fatoora vault key material is not a 32-byte canonical base64 value.');
    }

    seen.add(id);
    keys.push({ id, key: Uint8Array.from(decoded) });
  }

  if (!seen.has(activeRaw)) {
    throw new Error('ZATCA Fatoora vault active key id is absent from the keyring.');
  }

  return {
    activeKeyId: activeRaw,
    keys,
  };
}
