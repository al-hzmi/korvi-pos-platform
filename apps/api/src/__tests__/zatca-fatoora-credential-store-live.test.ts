import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { tenantId } from '@korvi/domain';
import {
  createPrismaClient,
  createZatcaFatooraCredentialRepository,
  type PrismaClient,
} from '@korvi/database';
import {
  KORVI_FATOORA_SECRET_PROVIDER,
  createEncryptedZatcaFatooraCredentialStore,
  type EncryptedZatcaFatooraCredentialStore,
} from '../zatca/encrypted-fatoora-credential-store.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const D = {
  tenantA: '018f5c00-0000-7000-8000-0000000004a1',
  tenantB: '018f5c00-0000-7000-8000-0000000004b1',
  branchA: '018f5c00-0000-7000-8000-0000000004a2',
  branchB: '018f5c00-0000-7000-8000-0000000004b2',
  terminalA: '018f5c00-0000-7000-8000-0000000004a3',
  terminalB: '018f5c00-0000-7000-8000-0000000004b3',
} as const;

const CREDENTIAL_ID = `sha256:${'a'.repeat(64)}`;
const TOKEN = 'sandbox-binary-security-token';
const SECRET = 'sandbox-fatoora-secret';
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

async function inTenant<T>(client: pg.Client, tenant: string, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

interface CipherRow {
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

describe.skipIf(url === '')('encrypted Fatoora credential vault, PostgreSQL live', () => {
  let prisma: PrismaClient;
  let admin: pg.Client;
  let store: EncryptedZatcaFatooraCredentialStore;

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    store = createEncryptedZatcaFatooraCredentialStore({
      repository: createZatcaFatooraCredentialRepository(prisma),
      activeKeyId: 'gate39-live-v1',
      keys: [{ id: 'gate39-live-v1', key: KEY }],
    });

    for (const tenant of [D.tenantA, D.tenantB]) {
      await inTenant(admin, tenant, async () => {
        await admin.query('DELETE FROM "tenants" WHERE "id" = $1', [tenant]);
      });
    }

    await inTenant(admin, D.tenantA, async () => {
      await admin.query(
        `INSERT INTO "tenants" ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt")
         VALUES ($1,'Fatoora tenant A','zatca-fatoora-live-a','active','recorded',now(),now())`,
        [D.tenantA],
      );
      await admin.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
         VALUES ($1,$2,'FA','فرع فاتورة أ',now())`,
        [D.branchA, D.tenantA],
      );
      await admin.query(
        `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
         VALUES ($1,$2,$3,'FT-A','Fatoora terminal A',now())`,
        [D.terminalA, D.tenantA, D.branchA],
      );
    });

    await inTenant(admin, D.tenantB, async () => {
      await admin.query(
        `INSERT INTO "tenants" ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt")
         VALUES ($1,'Fatoora tenant B','zatca-fatoora-live-b','active','recorded',now(),now())`,
        [D.tenantB],
      );
      await admin.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
         VALUES ($1,$2,'FB','فرع فاتورة ب',now())`,
        [D.branchB, D.tenantB],
      );
      await admin.query(
        `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
         VALUES ($1,$2,$3,'FT-B','Fatoora terminal B',now())`,
        [D.terminalB, D.tenantB, D.branchB],
      );
    });
  });

  afterAll(async () => {
    for (const tenant of [D.tenantA, D.tenantB]) {
      await inTenant(admin, tenant, async () => {
        await admin.query('DELETE FROM "tenants" WHERE "id" = $1', [tenant]);
      });
    }
    await admin.end();
    await prisma.$disconnect();
  });

  it('round-trips through PostgreSQL while persisting ciphertext only and converging replays', async () => {
    const scope = { tenantId: tenantId(D.tenantA) };
    const input = {
      scope,
      terminalId: D.terminalA,
      credentialId: CREDENTIAL_ID,
      binarySecurityToken: TOKEN,
      secret: SECRET,
    };

    const handle = await store.put(input);
    const replay = await store.put(input);
    expect(handle).toEqual({ provider: KORVI_FATOORA_SECRET_PROVIDER, secretId: CREDENTIAL_ID });
    expect(replay).toEqual(handle);
    await expect(store.resolve({ scope, terminalId: D.terminalA, handle })).resolves.toEqual({
      binarySecurityToken: TOKEN,
      secret: SECRET,
    });

    const rows = await inTenant(admin, D.tenantA, async () =>
      admin.query<CipherRow>(
        `SELECT "keyId","nonce","ciphertext","authTag"
           FROM "zatca_fatoora_credentials"
          WHERE "tenantId"=$1 AND "credentialId"=$2`,
        [D.tenantA, CREDENTIAL_ID],
      ),
    );
    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) throw new Error('Fatoora ciphertext row disappeared during live proof.');
    expect(row.keyId).toBe('gate39-live-v1');
    expect(row.nonce).toHaveLength(12);
    expect(row.authTag).toHaveLength(16);
    expect(row.ciphertext.includes(Buffer.from(TOKEN, 'utf8'))).toBe(false);
    expect(row.ciphertext.includes(Buffer.from(SECRET, 'utf8'))).toBe(false);
  });

  it('keeps the same credential unavailable across tenant authority boundaries', async () => {
    const foreignScope = { tenantId: tenantId(D.tenantB) };
    await expect(
      store.resolve({
        scope: foreignScope,
        terminalId: D.terminalB,
        handle: { provider: KORVI_FATOORA_SECRET_PROVIDER, secretId: CREDENTIAL_ID },
      }),
    ).rejects.toThrow(/unavailable/);
  });

  it('refuses a same-certificate replay carrying different secret material', async () => {
    await expect(
      store.put({
        scope: { tenantId: tenantId(D.tenantA) },
        terminalId: D.terminalA,
        credentialId: CREDENTIAL_ID,
        binarySecurityToken: TOKEN,
        secret: `${SECRET}-different`,
      }),
    ).rejects.toThrow(/different secret material/);
  });

  it('detects ciphertext tampering performed below the application layer', async () => {
    await inTenant(admin, D.tenantA, async () => {
      await admin.query(
        `UPDATE "zatca_fatoora_credentials"
            SET "ciphertext"=set_byte("ciphertext",0,(get_byte("ciphertext",0) # 1)),
                "updatedAt"=now()
          WHERE "tenantId"=$1 AND "credentialId"=$2`,
        [D.tenantA, CREDENTIAL_ID],
      );
    });

    await expect(
      store.resolve({
        scope: { tenantId: tenantId(D.tenantA) },
        terminalId: D.terminalA,
        handle: { provider: KORVI_FATOORA_SECRET_PROVIDER, secretId: CREDENTIAL_ID },
      }),
    ).rejects.toThrow();
  });
});
