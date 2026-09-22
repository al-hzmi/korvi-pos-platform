import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { tenantId } from '@korvi/domain';
import {
  CustomerImportRefusedError,
  commitCustomerImport,
  createPrismaClient,
  dryRunCustomerImport,
  readCustomerImportJob,
  readCustomerImportRows,
} from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '018fbc00-0000-7000-8000-00000000000a',
  user: '018fbc00-0000-7000-8000-0000000000a1',
  job: '018fbc00-0000-7000-8000-0000000000a2',
  row: '018fbc00-0000-7000-8000-0000000000a3',
  commit: '018fbc00-0000-7000-8000-0000000000a4',
} as const;

const B = {
  tenant: '018fbc00-0000-7000-8000-00000000000b',
  user: '018fbc00-0000-7000-8000-0000000000b1',
  customer: '018fbc00-0000-7000-8000-0000000000b2',
  job: '018fbc00-0000-7000-8000-0000000000b3',
  row: '018fbc00-0000-7000-8000-0000000000b4',
} as const;

const PHONE = '0501234567';
const HASH_A = '1'.repeat(64);
const HASH_B = '2'.repeat(64);
const REQUEST_A = '3'.repeat(64);
const REQUEST_B = '4'.repeat(64);
const ROW_A = '5'.repeat(64);
const ROW_B = '6'.repeat(64);

describe.skipIf(url === '')('customer migration tenant isolation, PostgreSQL live', () => {
  let client: pg.Client;
  let prisma: ReturnType<typeof createPrismaClient>;

  async function asTenant<T>(id: string, work: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, TRUE)", [id]);
    try {
      const value = await work();
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async function removeTenant(id: string): Promise<void> {
    await asTenant(id, async () => {
      await client.query('DELETE FROM "tenants" WHERE "id" = $1', [id]);
    });
  }

  async function seedTenant(id: string, user: string, slug: string): Promise<void> {
    await asTenant(id, async () => {
      await client.query(
        `INSERT INTO "tenants"
          ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt")
         VALUES ($1,$2,$3,'active','recorded',now(),now())`,
        [id, 'Customer ' + slug, slug],
      );
      await client.query(
        `INSERT INTO "users" ("id","tenantId","email","displayName","updatedAt")
         VALUES ($1,$2,$3,'Migration operator',now())`,
        [user, id, slug + '@migration.test'],
      );
    });
  }

  async function seedJob(input: {
    tenant: string;
    user: string;
    job: string;
    row: string;
    sourceHash: string;
    requestHash: string;
    rowHash: string;
    phone: string;
    nameAr: string;
    conflictPolicy?: 'reject' | 'update-existing-by-phone';
  }): Promise<void> {
    await asTenant(input.tenant, async () => {
      await client.query(
        `INSERT INTO "migration_import_jobs"
          ("id","tenantId","actorUserId","domain","format","sourceSha256",
           "createOperationId","createRequestHash","status","mappingVersion","mapping",
           "conflictPolicy","totalRows","validRows","warningRows","errorRows","blockedRows","updatedAt")
         VALUES ($1,$2,$3,'customers','csv',$4,$5,$6,'reviewed',1,'[]'::jsonb,
                 $7,1,1,0,0,0,now())`,
        [
          input.job,
          input.tenant,
          input.user,
          input.sourceHash,
          input.job,
          input.requestHash,
          input.conflictPolicy ?? 'reject',
        ],
      );
      await client.query(
        `INSERT INTO "migration_import_rows"
          ("id","tenantId","jobId","sourceRow","rowFingerprint","sourceIdentifier",
           "sourceData","canonicalData","issues","classification","plannedAction","status","updatedAt")
         VALUES ($1,$2,$3,2,$4,$5,'[]'::jsonb,$6::jsonb,'[]'::jsonb,
                 'VALID','create','pending',now())`,
        [
          input.row,
          input.tenant,
          input.job,
          input.rowHash,
          input.phone,
          JSON.stringify({
            nameAr: input.nameAr,
            nameEn: null,
            phone: input.phone,
            email: null,
            vatNumber: null,
          }),
        ],
      );
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await seedTenant(A.tenant, A.user, 'customer-proof-a');
    await seedTenant(B.tenant, B.user, 'customer-proof-b');

    await asTenant(B.tenant, async () => {
      await client.query(
        `INSERT INTO "customers"
          ("id","tenantId","nameAr","nameEn","phone","email","vatNumber","isActive","updatedAt")
         VALUES ($1,$2,'عميل خاص بباء',NULL,$3,NULL,NULL,true,now())`,
        [B.customer, B.tenant, PHONE],
      );
    });

    await seedJob({
      tenant: A.tenant,
      user: A.user,
      job: A.job,
      row: A.row,
      sourceHash: HASH_A,
      requestHash: REQUEST_A,
      rowHash: ROW_A,
      phone: PHONE,
      nameAr: 'عميل ألف',
    });
    await seedJob({
      tenant: B.tenant,
      user: B.user,
      job: B.job,
      row: B.row,
      sourceHash: HASH_B,
      requestHash: REQUEST_B,
      rowHash: ROW_B,
      phone: PHONE,
      nameAr: 'عميل باء',
    });
  });

  afterAll(async () => {
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await prisma.$disconnect();
    await client.end();
  });

  it('runs with forced RLS on customers and the shared migration ledger', async () => {
    const role = await client.query<{ usesuper: boolean; rolbypassrls: boolean }>(
      `SELECT u.usesuper, r.rolbypassrls
         FROM pg_user u
         JOIN pg_roles r ON r.rolname = u.usename
        WHERE u.usename = current_user`,
    );
    expect(role.rows[0]).toEqual({ usesuper: false, rolbypassrls: false });

    const tables = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname IN ('customers','migration_import_jobs','migration_import_rows')
        ORDER BY relname`,
    );
    expect(tables.rows).toHaveLength(3);
    for (const table of tables.rows) {
      expect(table.relrowsecurity, table.relname).toBe(true);
      expect(table.relforcerowsecurity, table.relname).toBe(true);
    }
  });

  it('does not leak Tenant B phone conflicts into Tenant A dry-run', async () => {
    const a = await dryRunCustomerImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      A.job,
    );
    expect(a.status).toBe('dry-run');
    expect(a.errorRows).toBe(0);

    const b = await dryRunCustomerImport(
      prisma,
      { tenantId: tenantId(B.tenant) },
      { userId: B.user },
      B.job,
    );
    expect(b.errorRows).toBe(1);
    const bRows = await readCustomerImportRows(prisma, { tenantId: tenantId(B.tenant) }, B.job, {
      limit: 20,
      afterSourceRow: null,
      problemsOnly: true,
    });
    expect(bRows?.rows[0]).toMatchObject({
      sourceIdentifier: PHONE,
      classification: 'ERROR',
      plannedAction: 'reject',
      status: 'rejected',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'phone-conflict' })]),
    });
  });

  it('keeps foreign customer jobs indistinguishable from unknown jobs', async () => {
    const scopeA = { tenantId: tenantId(A.tenant) };
    await expect(readCustomerImportJob(prisma, scopeA, B.job)).resolves.toBeNull();

    for (const action of [
      () => dryRunCustomerImport(prisma, scopeA, { userId: A.user }, B.job),
      () => commitCustomerImport(prisma, scopeA, { userId: A.user }, B.job, A.commit),
    ]) {
      try {
        await action();
        throw new Error('foreign customer job unexpectedly succeeded');
      } catch (error) {
        expect(error).toBeInstanceOf(CustomerImportRefusedError);
        expect((error as CustomerImportRefusedError).detail).toBe('unknown-job');
      }
    }
  });

  it('commits the same phone independently in Tenant A and replays idempotently', async () => {
    const scope = { tenantId: tenantId(A.tenant) };
    const first = await commitCustomerImport(prisma, scope, { userId: A.user }, A.job, A.commit);
    const replay = await commitCustomerImport(prisma, scope, { userId: A.user }, A.job, A.commit);
    expect(first.status).toBe('completed');
    expect(first.created).toBe(1);
    expect(replay).toEqual(first);

    const aRows = await asTenant(A.tenant, async () =>
      client.query<{ id: string; phone: string | null }>(
        'SELECT "id","phone" FROM "customers" WHERE "tenantId" = $1 AND "phone" = $2',
        [A.tenant, PHONE],
      ),
    );
    expect(aRows.rows).toHaveLength(1);
    expect(aRows.rows[0]!.id).not.toBe(B.customer);

    const bRows = await asTenant(B.tenant, async () =>
      client.query<{ id: string }>(
        'SELECT "id" FROM "customers" WHERE "tenantId" = $1 AND "phone" = $2',
        [B.tenant, PHONE],
      ),
    );
    expect(bRows.rows).toEqual([{ id: B.customer }]);
  });

  it('rechecks phone uniqueness at commit after a clean dry-run', async () => {
    const job = '018fbc00-0000-7000-8000-0000000000c1';
    const row = '018fbc00-0000-7000-8000-0000000000c2';
    const conflict = '018fbc00-0000-7000-8000-0000000000c3';
    const operation = '018fbc00-0000-7000-8000-0000000000c4';
    const phone = '0507654321';

    await seedJob({
      tenant: A.tenant,
      user: A.user,
      job,
      row,
      sourceHash: '7'.repeat(64),
      requestHash: '8'.repeat(64),
      rowHash: '9'.repeat(64),
      phone,
      nameAr: 'عميل سباق',
    });
    const dry = await dryRunCustomerImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      job,
    );
    expect(dry.errorRows).toBe(0);

    await asTenant(A.tenant, async () => {
      await client.query(
        `INSERT INTO "customers"
          ("id","tenantId","nameAr","nameEn","phone","email","vatNumber","isActive","updatedAt")
         VALUES ($1,$2,'تعارض بعد الفحص',NULL,$3,NULL,NULL,true,now())`,
        [conflict, A.tenant, phone],
      );
    });

    const committed = await commitCustomerImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      job,
      operation,
    );
    expect(committed.created).toBe(0);
    expect(committed.failed).toBe(1);

    const rows = await readCustomerImportRows(prisma, { tenantId: tenantId(A.tenant) }, job, {
      limit: 20,
      afterSourceRow: null,
      problemsOnly: true,
    });
    expect(rows?.rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'phone-taken',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'phone-conflict' })]),
    });
  });

  it('updates the same-tenant customer by phone without accepting an internal id', async () => {
    const customer = '018fbc00-0000-7000-8000-0000000000d1';
    const job = '018fbc00-0000-7000-8000-0000000000d2';
    const row = '018fbc00-0000-7000-8000-0000000000d3';
    const operation = '018fbc00-0000-7000-8000-0000000000d4';
    const phone = '0501112233';

    await asTenant(A.tenant, async () => {
      await client.query(
        `INSERT INTO "customers"
          ("id","tenantId","nameAr","nameEn","phone","email","vatNumber","isActive","updatedAt")
         VALUES ($1,$2,'الاسم القديم',NULL,$3,NULL,NULL,true,now())`,
        [customer, A.tenant, phone],
      );
    });
    await seedJob({
      tenant: A.tenant,
      user: A.user,
      job,
      row,
      sourceHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      rowHash: 'c'.repeat(64),
      phone,
      nameAr: 'الاسم الجديد',
      conflictPolicy: 'update-existing-by-phone',
    });

    const dry = await dryRunCustomerImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      job,
    );
    expect(dry.conflictPolicy).toBe('update-existing-by-phone');
    expect(dry.errorRows).toBe(0);
    expect(dry.warningRows).toBe(1);
    const preview = await readCustomerImportRows(prisma, { tenantId: tenantId(A.tenant) }, job, {
      limit: 20,
      afterSourceRow: null,
      problemsOnly: true,
    });
    expect(preview?.rows[0]).toMatchObject({
      plannedAction: 'update',
      status: 'pending',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'phone-match-update-planned' }),
      ]),
    });

    const scope = { tenantId: tenantId(A.tenant) };
    const first = await commitCustomerImport(prisma, scope, { userId: A.user }, job, operation);
    const replay = await commitCustomerImport(prisma, scope, { userId: A.user }, job, operation);
    expect(first.created).toBe(0);
    expect(first.updated).toBe(1);
    expect(replay).toEqual(first);

    const rows = await asTenant(A.tenant, async () =>
      client.query<{ id: string; nameAr: string }>(
        'SELECT "id","nameAr" FROM "customers" WHERE "tenantId" = $1 AND "phone" = $2',
        [A.tenant, phone],
      ),
    );
    expect(rows.rows).toEqual([{ id: customer, nameAr: 'الاسم الجديد' }]);
  });

  it('re-resolves update-by-phone at commit when a same-tenant phone appears after dry-run', async () => {
    const customer = '018fbc00-0000-7000-8000-0000000000e1';
    const job = '018fbc00-0000-7000-8000-0000000000e2';
    const row = '018fbc00-0000-7000-8000-0000000000e3';
    const operation = '018fbc00-0000-7000-8000-0000000000e4';
    const phone = '0504445566';

    await seedJob({
      tenant: A.tenant,
      user: A.user,
      job,
      row,
      sourceHash: 'd'.repeat(64),
      requestHash: 'e'.repeat(64),
      rowHash: 'f'.repeat(64),
      phone,
      nameAr: 'قيمة الاستيراد',
      conflictPolicy: 'update-existing-by-phone',
    });
    const dry = await dryRunCustomerImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      job,
    );
    expect(dry.errorRows).toBe(0);
    expect(dry.rows[0]).toMatchObject({ plannedAction: 'create' });

    await asTenant(A.tenant, async () => {
      await client.query(
        `INSERT INTO "customers"
          ("id","tenantId","nameAr","nameEn","phone","email","vatNumber","isActive","updatedAt")
         VALUES ($1,$2,'وصل بعد الفحص',NULL,$3,NULL,NULL,true,now())`,
        [customer, A.tenant, phone],
      );
    });

    const committed = await commitCustomerImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      job,
      operation,
    );
    expect(committed.created).toBe(0);
    expect(committed.updated).toBe(1);
    expect(committed.failed).toBe(0);

    const rows = await asTenant(A.tenant, async () =>
      client.query<{ id: string; nameAr: string }>(
        'SELECT "id","nameAr" FROM "customers" WHERE "tenantId" = $1 AND "phone" = $2',
        [A.tenant, phone],
      ),
    );
    expect(rows.rows).toEqual([{ id: customer, nameAr: 'قيمة الاستيراد' }]);
  });
});
