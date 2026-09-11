import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { prepareZatcaInvoiceSubmission, tenantId } from '@korvi/domain';
import { createPrismaClient, type PrismaClient } from '../client.js';
import { createZatcaInvoiceSubmissionRepository } from '../zatca/invoice-submission-repository.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const D = {
  tenantA: '018f6a00-0000-7000-8000-0000000001a1',
  tenantB: '018f6a00-0000-7000-8000-0000000001b1',
  branchA: '018f6a00-0000-7000-8000-0000000001a2',
  branchB: '018f6a00-0000-7000-8000-0000000001b2',
  terminalA: '018f6a00-0000-7000-8000-0000000001a3',
  terminalB: '018f6a00-0000-7000-8000-0000000001b3',
  userA: '018f6a00-0000-7000-8000-0000000001a4',
  userB: '018f6a00-0000-7000-8000-0000000001b4',
  shiftA: '018f6a00-0000-7000-8000-0000000001a5',
  shiftB: '018f6a00-0000-7000-8000-0000000001b5',
  saleA: '018f6a00-0000-7000-8000-0000000001a6',
  saleB: '018f6a00-0000-7000-8000-0000000001b6',
  invoiceA: '018f6a00-0000-7000-8000-0000000001a7',
  invoiceB: '018f6a00-0000-7000-8000-0000000001b7',
  submissionA: '018f6a00-0000-7000-8000-0000000001a8',
  submissionB: '018f6a00-0000-7000-8000-0000000001b8',
} as const;
const QUEUED = '2026-09-11T22:50:00Z';
const STARTED = '2026-09-11T22:50:01Z';
const RESOLVED = '2026-09-11T22:50:02Z';
const XML = new TextEncoder().encode('<?xml version="1.0"?><Invoice><ID>immutable</ID></Invoice>');
const HASH = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

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

function pending(tenant: string, invoice: string, terminal: string, id: string) {
  return prepareZatcaInvoiceSubmission({
    submissionId: id,
    scope: { tenantId: tenantId(tenant) },
    invoiceId: invoice,
    terminalId: terminal,
    environment: 'production',
    mode: 'reporting',
    invoiceUuid: id,
    invoiceHash: HASH,
    sealedInvoiceXml: XML,
    productionSecret: {
      provider: 'korvi-postgres-aes256gcm-v1',
      secretId: `sha256:${'a'.repeat(64)}`,
    },
    queuedAt: QUEUED,
  });
}

describe.skipIf(url === '')('ZATCA invoice submission repository, PostgreSQL live', () => {
  let prisma: PrismaClient;
  let admin: pg.Client;
  let repository: ReturnType<typeof createZatcaInvoiceSubmissionRepository>;

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    repository = createZatcaInvoiceSubmissionRepository(prisma);

    for (const tenant of [D.tenantA, D.tenantB]) {
      await inTenant(admin, tenant, async () => {
        await admin.query('DELETE FROM "tenants" WHERE "id"=$1', [tenant]);
      });
    }
    await fixture(
      admin,
      D.tenantA,
      D.branchA,
      D.terminalA,
      D.userA,
      D.shiftA,
      D.saleA,
      D.invoiceA,
      'a',
    );
    await fixture(
      admin,
      D.tenantB,
      D.branchB,
      D.terminalB,
      D.userB,
      D.shiftB,
      D.saleB,
      D.invoiceB,
      'b',
    );
  });

  afterAll(async () => {
    for (const tenant of [D.tenantA, D.tenantB]) {
      await inTenant(admin, tenant, async () => {
        await admin.query('DELETE FROM "tenants" WHERE "id"=$1', [tenant]);
      });
    }
    await admin.end();
    await prisma.$disconnect();
  });

  it('reserves exact immutable payload idempotently and rejects conflicting replay', async () => {
    const scope = { tenantId: tenantId(D.tenantA) };
    const first = pending(D.tenantA, D.invoiceA, D.terminalA, D.submissionA);
    await expect(repository.reservePending(scope, first)).resolves.toEqual(first);
    await expect(repository.reservePending(scope, first)).resolves.toEqual(first);

    const conflicting = prepareZatcaInvoiceSubmission({
      ...first,
      sealedInvoiceXml: new TextEncoder().encode('<Invoice><ID>changed payload</ID></Invoice>'),
    });
    await expect(repository.reservePending(scope, conflicting)).rejects.toThrow(
      /different durable submission identity/,
    );
  });

  it('isolates tenants and allows exactly one concurrent outbound claimant', async () => {
    const scopeA = { tenantId: tenantId(D.tenantA) };
    const scopeB = { tenantId: tenantId(D.tenantB) };
    const itemB = pending(D.tenantB, D.invoiceB, D.terminalB, D.submissionB);
    await repository.reservePending(scopeB, itemB);
    expect((await repository.findByInvoice(scopeA, D.invoiceA, 'reporting'))?.submissionId).toBe(
      D.submissionA,
    );
    expect((await repository.findByInvoice(scopeB, D.invoiceB, 'reporting'))?.submissionId).toBe(
      D.submissionB,
    );

    const results = await Promise.allSettled([
      repository.markRequestStarted(scopeA, D.submissionA, STARTED),
      repository.markRequestStarted(scopeA, D.submissionA, STARTED),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('persists ambiguity without permitting a blind second send and allows terminal reconciliation', async () => {
    const scope = { tenantId: tenantId(D.tenantA) };
    const uncertain = await repository.markUncertain(scope, D.submissionA, {
      resolvedAt: RESOLVED,
      uncertaintyReason: 'transport',
      httpStatus: 503,
    });
    expect(uncertain.state).toBe('uncertain');
    await expect(repository.markRequestStarted(scope, D.submissionA, STARTED)).rejects.toThrow(
      /stale state refused/,
    );

    const accepted = await repository.markAccepted(scope, D.submissionA, {
      resolvedAt: '2026-09-11T22:50:03Z',
      httpStatus: 200,
      authorityStatus: 'REPORTED',
    });
    expect(accepted.state).toBe('accepted');
    expect(accepted.attemptCount).toBe(1);
  });

  it('database guard rejects mode mismatch and immutable payload mutation', async () => {
    const scopeB = { tenantId: tenantId(D.tenantB) };
    const wrongMode = prepareZatcaInvoiceSubmission({
      ...pending(D.tenantB, D.invoiceB, D.terminalB, '018f6a00-0000-7000-8000-0000000001b9'),
      mode: 'clearance',
    });
    await expect(repository.reservePending(scopeB, wrongMode)).rejects.toThrow(
      /mode contradicts immutable invoice type/,
    );

    await expect(
      inTenant(admin, D.tenantB, async () => {
        await admin.query(
          'UPDATE "zatca_invoice_submissions" SET "invoiceUuid"=$2, "updatedAt"=now() WHERE "id"=$1',
          [D.submissionB, '018f6a00-0000-7000-8000-0000000001ff'],
        );
      }),
    ).rejects.toThrow(/immutable request identity/);
  });
});

async function fixture(
  client: pg.Client,
  tenant: string,
  branch: string,
  terminal: string,
  user: string,
  shift: string,
  sale: string,
  invoice: string,
  suffix: string,
): Promise<void> {
  await inTenant(client, tenant, async () => {
    await client.query(
      `INSERT INTO "tenants" ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt") VALUES ($1,$2,$3,'active','recorded',now(),now())`,
      [tenant, `ZATCA submit ${suffix}`, `zatca-submit-${suffix}`],
    );
    await client.query(
      `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [branch, tenant, `ZS-${suffix}`, `فرع ${suffix}`],
    );
    await client.query(
      `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt") VALUES ($1,$2,$3,$4,$5,now())`,
      [terminal, tenant, branch, `ZT-${suffix}`, `ZATCA terminal ${suffix}`],
    );
    await client.query(
      `INSERT INTO "users" ("id","tenantId","email","displayName","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [user, tenant, `${suffix}@example.test`, `User ${suffix}`],
    );
    await client.query(
      `INSERT INTO "shifts" ("id","tenantId","branchId","terminalId","userId","status","openingFloatMinor","openedAt","updatedAt") VALUES ($1,$2,$3,$4,$5,'open',0,now(),now())`,
      [shift, tenant, branch, terminal, user],
    );
    await client.query(
      `INSERT INTO "sales" ("id","tenantId","branchId","terminalId","shiftId","userId","operationId","status","sequence","priceMode","currency","grossMinor","lineDiscountMinor","basketDiscountMinor","netMinor","vatMinor","totalMinor","tenderedMinor","changeMinor","issuedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,'finalized',1,'tax-inclusive','SAR',100,0,0,87,13,100,100,0,now())`,
      [sale, tenant, branch, terminal, shift, user, `zatca-submit-${suffix}`],
    );
    await client.query(
      `INSERT INTO "invoices" ("id","tenantId","saleId","invoiceNumber","invoiceType","sellerName","sellerVatNumber","netMinor","vatMinor","totalMinor","currency","issuedAt") VALUES ($1,$2,$3,$4,'simplified',$5,'300000000000003',87,13,100,'SAR',now())`,
      [invoice, tenant, sale, `INV-ZS-${suffix}`, `Seller ${suffix}`],
    );
  });
}
