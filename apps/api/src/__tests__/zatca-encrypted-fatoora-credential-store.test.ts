import { describe, expect, it } from 'vitest';
import { tenantId } from '@korvi/domain';
import {
  KORVI_FATOORA_SECRET_PROVIDER,
  createEncryptedZatcaFatooraCredentialStore,
} from '../zatca/encrypted-fatoora-credential-store.js';
import type {
  ZatcaFatooraCiphertextRecord,
  ZatcaFatooraCredentialRepository,
} from '@korvi/database';

const SCOPE = { tenantId: tenantId('tenant-a') };
const OTHER_SCOPE = { tenantId: tenantId('tenant-b') };
const TERMINAL = '018f2e20-7b7a-7c00-8000-000000000012';
const OTHER_TERMINAL = '018f2e20-7b7a-7c00-8000-000000000099';
const CREDENTIAL = `sha256:${'1a'.repeat(32)}`;
const TOKEN = 'public-certificate-token-but-auth-username';
const SECRET = 'fatoora-secret-must-stay-encrypted';

class MemoryRepository implements ZatcaFatooraCredentialRepository {
  public readonly rows = new Map<string, ZatcaFatooraCiphertextRecord>();

  async reserve(
    scope: typeof SCOPE,
    record: ZatcaFatooraCiphertextRecord,
  ): Promise<ZatcaFatooraCiphertextRecord> {
    const key = `${scope.tenantId as string}:${record.credentialId}`;
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      if (existing.terminalId !== record.terminalId) {
        throw new Error('credential already belongs to another terminal');
      }
      return clone(existing);
    }
    this.rows.set(key, clone(record));
    return clone(record);
  }

  async find(
    scope: typeof SCOPE,
    terminalId: string,
    credentialId: string,
  ): Promise<ZatcaFatooraCiphertextRecord | null> {
    const row = this.rows.get(`${scope.tenantId as string}:${credentialId}`);
    if (row === undefined || row.terminalId !== terminalId) return null;
    return clone(row);
  }
}

function clone(record: ZatcaFatooraCiphertextRecord): ZatcaFatooraCiphertextRecord {
  return {
    ...record,
    nonce: Uint8Array.from(record.nonce),
    ciphertext: Uint8Array.from(record.ciphertext),
    authTag: Uint8Array.from(record.authTag),
  };
}

function key(fill = 7): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function store(repository = new MemoryRepository()) {
  let nonceCounter = 0;
  return {
    repository,
    vault: createEncryptedZatcaFatooraCredentialStore({
      repository,
      activeKeyId: 'key-2026-09',
      keys: [{ id: 'key-2026-09', key: key() }],
      randomBytesImpl(size) {
        nonceCounter += 1;
        return new Uint8Array(size).fill(nonceCounter);
      },
    }),
  };
}

describe('encrypted ZATCA Fatoora credential store', () => {
  it('persists only authenticated ciphertext and resolves the exact credential later', async () => {
    const { repository, vault } = store();

    const handle = await vault.put({
      scope: SCOPE,
      terminalId: TERMINAL,
      credentialId: CREDENTIAL,
      binarySecurityToken: TOKEN,
      secret: SECRET,
    });

    expect(handle).toEqual({
      provider: KORVI_FATOORA_SECRET_PROVIDER,
      secretId: CREDENTIAL,
    });
    const row = [...repository.rows.values()][0];
    expect(row).toBeDefined();
    expect(row?.nonce).toHaveLength(12);
    expect(row?.authTag).toHaveLength(16);
    expect(new TextDecoder().decode(row?.ciphertext)).not.toContain(TOKEN);
    expect(new TextDecoder().decode(row?.ciphertext)).not.toContain(SECRET);

    await expect(vault.resolve({ scope: SCOPE, terminalId: TERMINAL, handle })).resolves.toEqual({
      binarySecurityToken: TOKEN,
      secret: SECRET,
    });
  });

  it('converges repeated identical writes without replacing the first ciphertext', async () => {
    const { repository, vault } = store();
    const input = {
      scope: SCOPE,
      terminalId: TERMINAL,
      credentialId: CREDENTIAL,
      binarySecurityToken: TOKEN,
      secret: SECRET,
    } as const;

    await vault.put(input);
    const first = clone([...repository.rows.values()][0] as ZatcaFatooraCiphertextRecord);
    await vault.put(input);
    const second = [...repository.rows.values()][0];

    expect(second?.nonce).toEqual(first.nonce);
    expect(second?.ciphertext).toEqual(first.ciphertext);
    expect(second?.authTag).toEqual(first.authTag);
  });

  it('refuses same credential identity with different secret material instead of overwriting', async () => {
    const { vault } = store();
    await vault.put({
      scope: SCOPE,
      terminalId: TERMINAL,
      credentialId: CREDENTIAL,
      binarySecurityToken: TOKEN,
      secret: SECRET,
    });

    await expect(
      vault.put({
        scope: SCOPE,
        terminalId: TERMINAL,
        credentialId: CREDENTIAL,
        binarySecurityToken: TOKEN,
        secret: 'different-secret',
      }),
    ).rejects.toThrow(/different secret material/);
  });

  it('cryptographically binds ciphertext to tenant and terminal through AAD', async () => {
    const { repository, vault } = store();
    const handle = await vault.put({
      scope: SCOPE,
      terminalId: TERMINAL,
      credentialId: CREDENTIAL,
      binarySecurityToken: TOKEN,
      secret: SECRET,
    });
    const row = [...repository.rows.values()][0];
    expect(row).toBeDefined();

    if (row === undefined) throw new Error('missing encrypted fixture');
    repository.rows.set(`${OTHER_SCOPE.tenantId as string}:${CREDENTIAL}`, clone(row));
    await expect(
      vault.resolve({ scope: OTHER_SCOPE, terminalId: TERMINAL, handle }),
    ).rejects.toThrow(/authentication failed/);

    repository.rows.set(
      `${SCOPE.tenantId as string}:${CREDENTIAL}`,
      clone({ ...row, terminalId: OTHER_TERMINAL }),
    );
    await expect(
      vault.resolve({ scope: SCOPE, terminalId: OTHER_TERMINAL, handle }),
    ).rejects.toThrow(/authentication failed/);
  });

  it('refuses tampering, unknown key ids and untrusted handle providers', async () => {
    const { repository, vault } = store();
    const handle = await vault.put({
      scope: SCOPE,
      terminalId: TERMINAL,
      credentialId: CREDENTIAL,
      binarySecurityToken: TOKEN,
      secret: SECRET,
    });
    const original = [...repository.rows.values()][0];
    if (original === undefined) throw new Error('missing encrypted fixture');

    const tampered = clone(original);
    const first = tampered.ciphertext[0];
    if (first === undefined) throw new Error('missing ciphertext byte');
    tampered.ciphertext[0] = first ^ 1;
    repository.rows.set(`${SCOPE.tenantId as string}:${CREDENTIAL}`, tampered);
    await expect(vault.resolve({ scope: SCOPE, terminalId: TERMINAL, handle })).rejects.toThrow(
      /authentication failed/,
    );

    repository.rows.set(
      `${SCOPE.tenantId as string}:${CREDENTIAL}`,
      clone({ ...original, keyId: 'retired-key-not-loaded' }),
    );
    await expect(vault.resolve({ scope: SCOPE, terminalId: TERMINAL, handle })).rejects.toThrow(
      /encryption key is unavailable/,
    );

    await expect(
      vault.resolve({
        scope: SCOPE,
        terminalId: TERMINAL,
        handle: { provider: 'attacker-store', secretId: CREDENTIAL },
      }),
    ).rejects.toThrow(/not trusted/);
  });

  it('rejects invalid keyrings and malformed credential identities before persistence', async () => {
    const repository = new MemoryRepository();
    expect(() =>
      createEncryptedZatcaFatooraCredentialStore({
        repository,
        activeKeyId: 'active',
        keys: [{ id: 'active', key: new Uint8Array(31) }],
      }),
    ).toThrow(/32 bytes/);
    expect(() =>
      createEncryptedZatcaFatooraCredentialStore({
        repository,
        activeKeyId: 'missing',
        keys: [{ id: 'actual', key: key() }],
      }),
    ).toThrow(/not present/);

    const { vault } = store(repository);
    await expect(
      vault.put({
        scope: SCOPE,
        terminalId: TERMINAL,
        credentialId: 'not-a-certificate-hash',
        binarySecurityToken: TOKEN,
        secret: SECRET,
      }),
    ).rejects.toThrow(/SHA-256 certificate identity/);
  });
});
