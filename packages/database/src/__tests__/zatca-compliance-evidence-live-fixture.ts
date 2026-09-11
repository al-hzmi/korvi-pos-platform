import pg from 'pg';
import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  newId,
  prepareZatcaCsidProvisioning,
  tenantId,
} from '@korvi/domain';
import { createPrismaClient } from '../client.js';
import { createZatcaComplianceEvidenceRepository } from '../zatca/compliance-evidence-repository.js';
import { createZatcaCsidProvisioningRepository } from '../zatca/csid-provisioning-repository.js';
import type { PrismaClient } from '../client.js';

export const D = {
  tenantA: newId(),
  tenantB: newId(),
  branchA: newId(),
  branchB: newId(),
  terminalA: newId(),
  terminalA2: newId(),
  terminalB: newId(),
  issuedAttempt: newId(),
  preparedAttempt: newId(),
  earlyAttempt: newId(),
  evidence: newId(),
} as const;

const PREPARED = '2026-09-10T22:50:00Z';
const STARTED = '2026-09-10T22:50:01Z';
const RESOLVED = '2026-09-10T22:50:02Z';
export const ACCEPTED = '2026-09-10T22:50:03Z';
const REQUEST_HASH = 'a'.repeat(64);
const CSR_HASH = 'b'.repeat(64);
export const CHECK_HASH = 'c'.repeat(64);
export const CREDENTIAL_ID = `sha256:${'d'.repeat(64)}`;
export const SECRET_ID = `sha256:${'e'.repeat(64)}`;

type CsidRepository = ReturnType<typeof createZatcaCsidProvisioningRepository>;
type EvidenceRepository = ReturnType<typeof createZatcaComplianceEvidenceRepository>;

export interface EvidenceLiveFixture {
  readonly prisma: PrismaClient;
  readonly admin: pg.Client;
  readonly app: pg.Client;
  readonly csid: CsidRepository;
  readonly evidence: EvidenceRepository;
}

function prepared(attemptId: string, terminal: string, operationId: string) {
  return prepareZatcaCsidProvisioning({
    attemptId,
    scope: { tenantId: tenantId(D.tenantA) },
    terminalId: terminal,
    operationId,
    requestHash: REQUEST_HASH,
    environment: 'production',
    key: {
      provider: 'test-non-exportable-key-provider',
      keyId: `key-${attemptId}`,
      curve: ZATCA_SIGNING_CURVE,
      algorithm: ZATCA_SIGNING_ALGORITHM,
      exportable: false,
    },
    csrSha256Hex: CSR_HASH,
    preparedAt: PREPARED,
  });
}

async function issue(
  repository: CsidRepository,
  attemptId: string,
  terminal: string,
  operationId: string,
  credentialId = CREDENTIAL_ID,
) {
  const scope = { tenantId: tenantId(D.tenantA) };
  await repository.reservePrepared(scope, prepared(attemptId, terminal, operationId));
  await repository.markRequestStarted(scope, attemptId, STARTED);
  return repository.markIssued(scope, attemptId, {
    resolvedAt: RESOLVED,
    remoteRequestId: `request-${attemptId}`,
    credentialId,
    certificateDer: Uint8Array.from([0x30, 0x01, 0x00]),
    fatooraSecret: { provider: 'korvi-test-fatoora-vault', secretId: SECRET_ID },
  });
}

async function seedHierarchy(admin: pg.Client): Promise<void> {
  await admin.query(
    `INSERT INTO "tenants" ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt")
     VALUES ($1,'Evidence tenant A',$2,'active','recorded',now(),now()),
            ($3,'Evidence tenant B',$4,'active','recorded',now(),now())`,
    [D.tenantA, `evidence-a-${D.tenantA}`, D.tenantB, `evidence-b-${D.tenantB}`],
  );
  await admin.query(
    `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
     VALUES ($1,$2,'EA','فرع الدليل أ',now()),($3,$4,'EB','فرع الدليل ب',now())`,
    [D.branchA, D.tenantA, D.branchB, D.tenantB],
  );
  await admin.query(
    `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
     VALUES ($1,$2,$3,'E-A1','Evidence A1',now()),
            ($4,$2,$3,'E-A2','Evidence A2',now()),
            ($5,$6,$7,'E-B1','Evidence B1',now())`,
    [D.terminalA, D.tenantA, D.branchA, D.terminalA2, D.terminalB, D.tenantB, D.branchB],
  );
}

export async function setupEvidenceFixture(
  appUrl: string,
  adminUrl: string,
): Promise<EvidenceLiveFixture> {
  const prisma = createPrismaClient(appUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  const app = new pg.Client({ connectionString: appUrl });
  await admin.connect();
  await app.connect();
  const csid = createZatcaCsidProvisioningRepository(prisma);
  const evidence = createZatcaComplianceEvidenceRepository(prisma);
  await seedHierarchy(admin);
  await issue(csid, D.issuedAttempt, D.terminalA, 'issued-source');
  await csid.reservePrepared(
    { tenantId: tenantId(D.tenantA) },
    prepared(D.preparedAttempt, D.terminalA, 'prepared-source'),
  );
  await issue(csid, D.earlyAttempt, D.terminalA2, 'early-source', `sha256:${'f'.repeat(64)}`);
  return { prisma, admin, app, csid, evidence };
}

export async function cleanupEvidenceFixture(fixture: EvidenceLiveFixture): Promise<void> {
  await fixture.prisma.$disconnect();
  await fixture.app.end();
  const ids = [[D.tenantA, D.tenantB]];
  await fixture.admin.query("SET session_replication_role = 'replica'");
  await fixture.admin.query(
    'DELETE FROM "zatca_compliance_evidence" WHERE "tenantId" = ANY($1::uuid[])',
    ids,
  );
  await fixture.admin.query(
    'DELETE FROM "zatca_csid_provisioning_attempts" WHERE "tenantId" = ANY($1::uuid[])',
    ids,
  );
  await fixture.admin.query('DELETE FROM "terminals" WHERE "tenantId" = ANY($1::uuid[])', ids);
  await fixture.admin.query('DELETE FROM "branches" WHERE "tenantId" = ANY($1::uuid[])', ids);
  await fixture.admin.query('DELETE FROM "tenants" WHERE "id" = ANY($1::uuid[])', ids);
  await fixture.admin.query("SET session_replication_role = 'origin'");
  await fixture.admin.end();
}

export async function inTenant<T>(
  client: pg.Client,
  tenant: string,
  work: () => Promise<T>,
): Promise<T> {
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
