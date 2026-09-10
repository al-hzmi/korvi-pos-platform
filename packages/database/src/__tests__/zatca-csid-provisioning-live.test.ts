import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  prepareZatcaCsidProvisioning,
  tenantId,
} from '@korvi/domain';
import { createPrismaClient } from '../client.js';
import { createZatcaCsidProvisioningRepository } from '../zatca/csid-provisioning-repository.js';
import type { PrismaClient } from '../client.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const D = {
  tenantA: '018f5c00-0000-7000-8000-0000000003a1',
  tenantB: '018f5c00-0000-7000-8000-0000000003b1',
  branchA: '018f5c00-0000-7000-8000-0000000003a2',
  branchB: '018f5c00-0000-7000-8000-0000000003b2',
  terminalA: '018f5c00-0000-7000-8000-0000000003a3',
  terminalB: '018f5c00-0000-7000-8000-0000000003b3',
  attemptA: '018f5c00-0000-7000-8000-0000000003a4',
  attemptB: '018f5c00-0000-7000-8000-0000000003b4',
  raceAttempt: '018f5c00-0000-7000-8000-0000000003a5',
  finalRaceAttempt: '018f5c00-0000-7000-8000-0000000003a6',
} as const;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CSR_HASH = 'c'.repeat(64);
const PREPARED = '2026-09-10T10:30:00Z';
const STARTED = '2026-09-10T10:30:01Z';
const RESOLVED = '2026-09-10T10:30:02Z';

function prepared(
  tenant: string,
  terminal: string,
  attemptId: string,
  operationId: string,
  requestHash = HASH_A,
) {
  return prepareZatcaCsidProvisioning({
    attemptId,
    scope: { tenantId: tenantId(tenant) },
    terminalId: terminal,
    operationId,
    requestHash,
    environment: 'sandbox',
    key: {
      provider: 'test-hsm',
      keyId: `key-${attemptId}`,
      curve: ZATCA_SIGNING_CURVE,
      algorithm: ZATCA_SIGNING_ALGORITHM,
      exportable: false,
    },
    csrSha256Hex: CSR_HASH,
    preparedAt: PREPARED,
  });
}

async function inTenant(
  client: pg.Client,
  tenant: string,
  work: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

describe.skipIf(url === '')('ZATCA CSID provisioning repository, PostgreSQL live', () => {
  let prisma: PrismaClient;
  let admin: pg.Client;
  let repository: ReturnType<typeof createZatcaCsidProvisioningRepository>;

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    repository = createZatcaCsidProvisioningRepository(prisma);

    for (const tenant of [D.tenantA, D.tenantB]) {
      await inTenant(admin, tenant, async () => {
        await admin.query('DELETE FROM "tenants" WHERE "id" = $1', [tenant]);
      });
    }

    await inTenant(admin, D.tenantA, async () => {
      await admin.query(
        `INSERT INTO "tenants" ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt")
         VALUES ($1,'ZATCA tenant A','zatca-csid-live-a','active','recorded',now(),now())`,
        [D.tenantA],
      );
      await admin.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
         VALUES ($1,$2,'ZA','فرع زاتكا أ',now())`,
        [D.branchA, D.tenantA],
      );
      await admin.query(
        `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
         VALUES ($1,$2,$3,'ZT-A','ZATCA terminal A',now())`,
        [D.terminalA, D.tenantA, D.branchA],
      );
    });

    await inTenant(admin, D.tenantB, async () => {
      await admin.query(
        `INSERT INTO "tenants" ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt")
         VALUES ($1,'ZATCA tenant B','zatca-csid-live-b','active','recorded',now(),now())`,
        [D.tenantB],
      );
      await admin.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
         VALUES ($1,$2,'ZB','فرع زاتكا ب',now())`,
        [D.branchB, D.tenantB],
      );
      await admin.query(
        `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
         VALUES ($1,$2,$3,'ZT-B','ZATCA terminal B',now())`,
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

  it('reserves idempotently and refuses same operation with different durable identity', async () => {
    const scope = { tenantId: tenantId(D.tenantA) };
    const first = prepared(D.tenantA, D.terminalA, D.attemptA, 'operation-a');
    const reserved = await repository.reservePrepared(scope, first);
    expect(reserved).toEqual(first);

    const replay = await repository.reservePrepared(scope, first);
    expect(replay).toEqual(first);

    const conflicting = prepared(D.tenantA, D.terminalA, D.raceAttempt, 'operation-a', HASH_B);
    await expect(repository.reservePrepared(scope, conflicting)).rejects.toThrow(
      /different durable request identity/,
    );
  });

  it('keeps identical operation ids isolated by tenant RLS', async () => {
    const attemptB = prepared(D.tenantB, D.terminalB, D.attemptB, 'operation-a');
    await repository.reservePrepared({ tenantId: tenantId(D.tenantB) }, attemptB);

    const seenA = await repository.findByOperationId(
      { tenantId: tenantId(D.tenantA) },
      'operation-a',
    );
    const seenB = await repository.findByOperationId(
      { tenantId: tenantId(D.tenantB) },
      'operation-a',
    );
    expect(seenA?.attemptId).toBe(D.attemptA);
    expect(seenB?.attemptId).toBe(D.attemptB);
  });

  it('allows only one concurrent prepared-to-in-flight winner', async () => {
    const scope = { tenantId: tenantId(D.tenantA) };
    const attempt = prepared(D.tenantA, D.terminalA, D.raceAttempt, 'race-start');
    await repository.reservePrepared(scope, attempt);

    const results = await Promise.allSettled([
      repository.markRequestStarted(scope, D.raceAttempt, STARTED),
      repository.markRequestStarted(scope, D.raceAttempt, STARTED),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const stored = await repository.findByOperationId(scope, 'race-start');
    expect(stored?.state).toBe('in-flight');
  });

  it('allows only one terminal outcome and never stores a Fatoora plaintext secret', async () => {
    const scope = { tenantId: tenantId(D.tenantA) };
    const attempt = prepared(D.tenantA, D.terminalA, D.finalRaceAttempt, 'race-final');
    await repository.reservePrepared(scope, attempt);
    await repository.markRequestStarted(scope, D.finalRaceAttempt, STARTED);

    const results = await Promise.allSettled([
      repository.markIssued(scope, D.finalRaceAttempt, {
        resolvedAt: RESOLVED,
        remoteRequestId: 'remote-1',
        credentialId: 'credential-1',
        certificateDer: Uint8Array.from([0x30, 0x01, 0x00]),
        fatooraSecret: { provider: 'test-vault', secretId: 'secret-handle-1' },
      }),
      repository.markRejected(scope, D.finalRaceAttempt, {
        resolvedAt: RESOLVED,
        rejectionCode: 'provider-rejected',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'zatca_csid_provisioning_attempts'`,
    );
    const names = columns.rows.map((row) => row.column_name.toLowerCase());
    expect(names).not.toContain('otp');
    expect(names).not.toContain('fatoorasecret');
    expect(names).not.toContain('secret');
    expect(names).toContain('secretprovider');
    expect(names).toContain('secretid');
  });

  it('database trigger refuses state jumps and mutation of immutable request identity', async () => {
    const scope = { tenantId: tenantId(D.tenantA) };
    const attemptId = '018f5c00-0000-7000-8000-0000000003a7';
    await repository.reservePrepared(
      scope,
      prepared(D.tenantA, D.terminalA, attemptId, 'db-guard'),
    );

    await expect(
      inTenant(admin, D.tenantA, async () => {
        await admin.query(
          `UPDATE "zatca_csid_provisioning_attempts"
              SET "state"='rejected', "requestStartedAt"=$2, "resolvedAt"=$3,
                  "rejectionCode"='x', "updatedAt"=$3
            WHERE "id"=$1`,
          [attemptId, new Date(STARTED), new Date(RESOLVED)],
        );
      }),
    ).rejects.toThrow(/illegal ZATCA CSID provisioning state transition/);

    await expect(
      inTenant(admin, D.tenantA, async () => {
        await admin.query(
          `UPDATE "zatca_csid_provisioning_attempts"
              SET "operationId"='mutated-operation', "updatedAt"=now()
            WHERE "id"=$1`,
          [attemptId],
        );
      }),
    ).rejects.toThrow(/provisioning identity is immutable/);
  });
});
