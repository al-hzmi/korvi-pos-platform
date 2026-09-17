import { afterAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '@korvi/database';
import { loadConfig } from '../config.js';
import { createZatcaComplianceCsidInfrastructureFromEnvironment } from '../zatca/compliance-csid-infrastructure.js';

// The client is never connected in this unit suite. Keep the syntactically valid
// URL credential-free so repository secret scanners do not need test exceptions.
const DATABASE_URL = 'postgresql://127.0.0.1:1/unused';
const KEY = Buffer.alloc(32, 0x5a).toString('base64');
const prisma = createPrismaClient(DATABASE_URL);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Compliance CSID production composition boundary', () => {
  it('fails closed before constructing credential infrastructure when the vault keyring is absent or incomplete', () => {
    expect(() =>
      createZatcaComplianceCsidInfrastructureFromEnvironment({ prisma, env: {} }),
    ).toThrow(/vault is not configured/i);

    expect(() =>
      createZatcaComplianceCsidInfrastructureFromEnvironment({
        prisma,
        env: { ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID: 'key-current' },
      }),
    ).toThrow(/incomplete/i);
  });

  it('constructs the issuer only from a complete canonical AES-256 keyring', () => {
    const infrastructure = createZatcaComplianceCsidInfrastructureFromEnvironment({
      prisma,
      env: {
        ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID: 'key-current',
        ZATCA_FATOORA_VAULT_KEYS: `key-current=${KEY}`,
      },
      fetchImpl: async () => new Response(null, { status: 503 }),
    });

    expect(infrastructure.issuer.issue).toBeTypeOf('function');
    expect(infrastructure.credentialStore.put).toBeTypeOf('function');
    expect(infrastructure.credentialStore.resolve).toBeTypeOf('function');
  });

  it('does not copy Fatoora vault keys into the general API configuration object', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'development',
      ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID: 'key-current',
      ZATCA_FATOORA_VAULT_KEYS: `key-current=${KEY}`,
    };

    const config = loadConfig(env);
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('ZATCA_FATOORA_VAULT');
    expect(serialized).not.toContain(KEY);
    expect(Object.hasOwn(config, 'ZATCA_FATOORA_VAULT_KEYS')).toBe(false);
    expect(Object.hasOwn(config, 'ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID')).toBe(false);
  });
});
