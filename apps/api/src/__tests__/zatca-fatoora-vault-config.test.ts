import { describe, expect, it } from 'vitest';
import { loadZatcaFatooraVaultConfig } from '../zatca/fatoora-vault-config.js';

const KEY_A = Buffer.alloc(32, 0x11).toString('base64');
const KEY_B = Buffer.alloc(32, 0x22).toString('base64');

function env(active = 'key-current', keys = `key-current=${KEY_A}`): NodeJS.ProcessEnv {
  return {
    ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID: active,
    ZATCA_FATOORA_VAULT_KEYS: keys,
  };
}

describe('Fatoora vault configuration', () => {
  it('is disabled only when the complete keyring pair is absent', () => {
    expect(loadZatcaFatooraVaultConfig({})).toBeNull();
    expect(() =>
      loadZatcaFatooraVaultConfig({ ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID: 'key-current' }),
    ).toThrow(/incomplete/);
    expect(() =>
      loadZatcaFatooraVaultConfig({ ZATCA_FATOORA_VAULT_KEYS: `key-current=${KEY_A}` }),
    ).toThrow(/incomplete/);
  });

  it('parses an active key and retained rotation key without exposing the encoded source', () => {
    const config = loadZatcaFatooraVaultConfig(
      env('key-current', `key-current=${KEY_A},key-previous=${KEY_B}`),
    );
    expect(config?.activeKeyId).toBe('key-current');
    expect(config?.keys.map((entry) => entry.id)).toEqual(['key-current', 'key-previous']);
    expect(config?.keys[0]?.key).toEqual(Uint8Array.from(Buffer.alloc(32, 0x11)));
    expect(config?.keys[1]?.key).toEqual(Uint8Array.from(Buffer.alloc(32, 0x22)));
  });

  it.each([
    ['', `key-current=${KEY_A}`],
    [' key-current', `key-current=${KEY_A}`],
    ['key current', `key current=${KEY_A}`],
    ['key/current', `key/current=${KEY_A}`],
  ])('rejects an invalid active key id %#', (active, keys) => {
    expect(() => loadZatcaFatooraVaultConfig(env(active, keys))).toThrow(/active key id/);
  });

  it('rejects duplicate key ids and an active key absent from the keyring', () => {
    expect(() =>
      loadZatcaFatooraVaultConfig(env('key-current', `key-current=${KEY_A},key-current=${KEY_B}`)),
    ).toThrow(/duplicated/);
    expect(() => loadZatcaFatooraVaultConfig(env('key-missing', `key-current=${KEY_A}`))).toThrow(
      /absent/,
    );
  });

  it.each([
    'key-current=',
    'key-current',
    `key-current=${KEY_A} `,
    `key-current=${KEY_A},`,
    `key-current=${Buffer.alloc(31, 0x11).toString('base64')}`,
    'key-current=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-',
  ])('rejects malformed or non-AES-256 key material %#', (keys) => {
    expect(() => loadZatcaFatooraVaultConfig(env('key-current', keys))).toThrow();
  });

  it('caps retained keys so configuration cannot allocate an unbounded keyring', () => {
    const keys = Array.from({ length: 17 }, (_, index) => `key-${index}=${KEY_A}`).join(',');
    expect(() => loadZatcaFatooraVaultConfig(env('key-0', keys))).toThrow(/size/);
  });
});
