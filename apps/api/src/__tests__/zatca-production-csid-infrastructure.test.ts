import { afterAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '@korvi/database';
import { loadConfig } from '../config.js';
import { createZatcaProductionCsidInfrastructureFromEnvironment } from '../zatca/production-csid-infrastructure.js';

const DATABASE_URL = 'postgresql://127.0.0.1:1/unused';
const KEY = Buffer.alloc(32, 0x4b).toString('base64');
const prisma = createPrismaClient(DATABASE_URL);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Production CSID production composition boundary', () => {
  it('fails closed before constructing Production-CSID infrastructure when the vault keyring is absent or incomplete', () => {
    expect(() =>
      createZatcaProductionCsidInfrastructureFromEnvironment({ prisma, env: {} }),
    ).toThrow(/vault is not configured/i);

    expect(() =>
      createZatcaProductionCsidInfrastructureFromEnvironment({
        prisma,
        env: { ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID: 'key-current' },
      }),
    ).toThrow(/incomplete/i);
  });

  it('composes one encrypted store as both current-CSID resolver and new-CSID destination', () => {
    const infrastructure = createZatcaProductionCsidInfrastructureFromEnvironment({
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

  it('keeps Fatoora vault keys outside general API configuration', () => {
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
