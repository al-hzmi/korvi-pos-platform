import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  prepareZatcaCsidProvisioning,
  tenantId,
  type TenantScope,
  type ZatcaCsidBinding,
} from '@korvi/domain';
import { createPrismaClient } from '../client.js';
import { createZatcaCsidBindingRepository } from '../zatca/csid-binding-repository.js';
import { createZatcaCsidProvisioningRepository } from '../zatca/csid-provisioning-repository.js';
import type { PrismaClient } from '../client.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const PREPARED = '2026-09-16T10:00:00Z';
const STARTED = '2026-09-16T10:00:01Z';
const ISSUED = '2026-09-16T10:00:02Z';
const ACTIVATED = '2026-09-16T10:00:03Z';
const SUPERSEDED = '2026-09-16T10:10:03Z';
const LEAF_DER = Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x01]);
const OTHER_LEAF_DER = Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x02]);
const ROOT_DER = Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x7f]);
const SPKI_DER = Uint8Array.from([0x30, 0x03, 0x01, 0x01, 0x01]);
const KEY = {
  provider: 'test-hsm',
  keyId: 'terminal-key',
  curve: ZATCA_SIGNING_CURVE,
  algorithm: ZATCA_SIGNING_ALGORITHM,
  exportable: false as const,
};

function sha256Base64(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('base64');
}

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

describe.skipIf(url === '')('ZATCA active CSID binding repository, PostgreSQL live', () => {
  let prisma: PrismaClient;
  let admin: pg.Client;
  let tenant: string;
  let branch: string;
  let terminal: string;
  let scope: TenantScope;
  let provisioning: ReturnType<typeof createZatcaCsidProvisioningRepository>;
  let bindings: ReturnType<typeof createZatcaCsidBindingRepository>;

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    tenant = randomUUID();
    branch = randomUUID();
    terminal = randomUUID();
    scope = { tenantId: tenantId(tenant) };
    provisioning = createZatcaCsidProvisioningRepository(prisma);
    bindings = createZatcaCsidBindingRepository(prisma);

    await inTenant(admin, tenant, async () => {
      await admin.query(
        `INSERT INTO "tenants" ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt")
         VALUES ($1,'ZATCA binding tenant',$2,'active','recorded',now(),now())`,
        [tenant, `zatca-binding-${tenant}`],
      );
      await admin.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
         VALUES ($1,$2,'ZB','فرع زاتكا',now())`,
        [branch, tenant],
      );
      await admin.query(
        `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
         VALUES ($1,$2,$3,'ZT-BIND','ZATCA binding terminal',now())`,
        [terminal, tenant, branch],
      );
    });
  });

  afterAll(async () => {
    await admin.end();
    await prisma.$disconnect();
  });

  async function issueProductionAttempt(credentialId: string, secretId: string): Promise<string> {
    const attemptId = randomUUID();
    const operationId = randomUUID();
    const prepared = prepareZatcaCsidProvisioning({
      attemptId,
      scope,
      terminalId: terminal,
      operationId,
      requestHash: createHash('sha256').update(operationId).digest('hex'),
      environment: 'production',
      key: KEY,
      csrSha256Hex: createHash('sha256').update(`csr:${operationId}`).digest('hex'),
      preparedAt: PREPARED,
    });
    await provisioning.reservePrepared(scope, prepared);
    await provisioning.markRequestStarted(scope, attemptId, STARTED);
    await provisioning.markIssued(scope, attemptId, {
      resolvedAt: ISSUED,
      remoteRequestId: `remote-${attemptId}`,
      credentialId,
      certificateDer: Uint8Array.from(LEAF_DER),
      fatooraSecret: { provider: 'test-vault', secretId },
    });
    return attemptId;
  }

  function binding(credentialId: string, secretId: string): ZatcaCsidBinding {
    return {
      credentialId,
      scope,
      terminalId: terminal,
      state: 'active',
      key: KEY,
      certificatePath: [
        {
          certificateDer: Uint8Array.from(LEAF_DER),
          issuerName: 'CN=Korvi Test Root',
          serialNumber: '1',
        },
        {
          certificateDer: Uint8Array.from(ROOT_DER),
          issuerName: 'CN=Korvi Test Root',
          serialNumber: '2',
        },
      ],
      certificateStatus: [
        {
          certificateSha256: sha256Base64(LEAF_DER),
          status: 'good',
          source: 'ocsp',
          checkedAt: '2026-09-16T09:59:00Z',
          validUntil: '2026-09-17T09:59:00Z',
        },
      ],
      signingPublicKeySpkiDer: Uint8Array.from(SPKI_DER),
      notBefore: '2026-09-01T00:00:00Z',
      notAfter: '2027-09-01T00:00:00Z',
      fatooraSecret: { provider: 'test-vault', secretId },
    };
  }

  it('activates only issued production provenance and resolves it as terminal authority', async () => {
    const credentialId = `sha256:${'11'.repeat(32)}`;
    const secretId = 'production-secret-1';
    const sourceAttemptId = await issueProductionAttempt(credentialId, secretId);
    const expected = binding(credentialId, secretId);

    const activated = await bindings.activate(scope, {
      sourceAttemptId,
      binding: expected,
      activatedAt: ACTIVATED,
    });
    expect(activated).toEqual(expected);
    expect(await bindings.findActiveForTerminal(scope, terminal)).toEqual(expected);

    const replay = await bindings.activate(scope, {
      sourceAttemptId,
      binding: expected,
      activatedAt: ACTIVATED,
    });
    expect(replay).toEqual(expected);

    const otherScope = { tenantId: tenantId(randomUUID()) };
    expect(await bindings.findActiveForTerminal(otherScope, terminal)).toBeNull();
  });

  it('atomically supersedes prior authority and rolls back if new provenance is invalid', async () => {
    const credentialId = `sha256:${'22'.repeat(32)}`;
    const secretId = 'production-secret-2';
    const sourceAttemptId = await issueProductionAttempt(credentialId, secretId);
    const second = binding(credentialId, secretId);

    await bindings.activate(scope, {
      sourceAttemptId,
      binding: second,
      activatedAt: SUPERSEDED,
    });
    expect(await bindings.findActiveForTerminal(scope, terminal)).toEqual(second);

    const badCredentialId = `sha256:${'33'.repeat(32)}`;
    const badSecretId = 'production-secret-3';
    const badAttemptId = await issueProductionAttempt(badCredentialId, badSecretId);
    const bad = binding(badCredentialId, badSecretId);
    bad.certificatePath[0] = {
      certificateDer: Uint8Array.from(OTHER_LEAF_DER),
      issuerName: 'CN=Korvi Test Root',
      serialNumber: '3',
    };

    await expect(
      bindings.activate(scope, {
        sourceAttemptId: badAttemptId,
        binding: bad,
        activatedAt: '2026-09-16T10:20:03Z',
      }),
    ).rejects.toThrow();

    expect(await bindings.findActiveForTerminal(scope, terminal)).toEqual(second);
    const states = await inTenant(admin, tenant, async () =>
      admin.query<{ state: string; credentialId: string }>(
        `SELECT "state", "credentialId"
           FROM "zatca_csid_bindings"
          WHERE "tenantId"=$1 AND "terminalId"=$2
          ORDER BY "activatedAt"`,
        [tenant, terminal],
      ),
    );
    expect(states.rows.map((row) => row.state)).toEqual(['superseded', 'active']);
    expect(states.rows.at(-1)?.credentialId).toBe(credentialId);
  });
});
