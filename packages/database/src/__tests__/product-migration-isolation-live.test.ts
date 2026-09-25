import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { tenantId } from '@korvi/domain';
import {
  ProductImportRefusedError,
  commitProductImport,
  createPrismaClient,
  dryRunProductImport,
  readProductImportJob,
  readProductImportRows,
} from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '018fb800-0000-7000-8000-00000000000a',
  user: '018fb800-0000-7000-8000-0000000000a1',
  job: '018fb800-0000-7000-8000-0000000000a2',
  row: '018fb800-0000-7000-8000-0000000000a3',
} as const;
const B = {
  tenant: '018fb800-0000-7000-8000-00000000000b',
  user: '018fb800-0000-7000-8000-0000000000b1',
  job: '018fb800-0000-7000-8000-0000000000b2',
  row: '018fb800-0000-7000-8000-0000000000b3',
  product: '018fb800-0000-7000-8000-0000000000b4',
} as const;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const REQUEST_A = 'c'.repeat(64);
const REQUEST_B = 'd'.repeat(64);
const ROW_A = 'e'.repeat(64);
const ROW_B = 'f'.repeat(64);
const SHARED_SKU = 'PRIVATE-B-SKU';

describe.skipIf(url === '')('product migration tenant isolation, PostgreSQL live', () => {
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
        [id, 'Migration ' + slug, slug],
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
    sku: string;
  }): Promise<void> {
    await asTenant(input.tenant, async () => {
      await client.query(
        `INSERT INTO "migration_import_jobs"
          ("id","tenantId","actorUserId","domain","format","sourceSha256",
           "createOperationId","createRequestHash","status","mappingVersion","mapping",
           "conflictPolicy","totalRows","validRows","warningRows","errorRows","blockedRows","updatedAt")
         VALUES ($1,$2,$3,'products','csv',$4,$5,$6,'reviewed',1,'[]'::jsonb,
                 'reject',1,1,0,0,0,now())`,
        [input.job, input.tenant, input.user, input.sourceHash, input.job, input.requestHash],
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
          input.sku,
          JSON.stringify({
            sku: input.sku,
            barcode: null,
            nameAr: 'منتج اختبار',
            nameEn: null,
            productType: 'unit',
            unitLabel: 'each',
            priceMinor: '1000',
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
    await seedTenant(A.tenant, A.user, 'migration-proof-a');
    await seedTenant(B.tenant, B.user, 'migration-proof-b');

    await asTenant(B.tenant, async () => {
      await client.query(
        `INSERT INTO "products"
          ("id","tenantId","sku","nameAr","priceMinor","vatBasisPoints","updatedAt")
         VALUES ($1,$2,$3,'Private B product',1000,1500,now())`,
        [B.product, B.tenant, SHARED_SKU],
      );
    });

    await seedJob({
      tenant: B.tenant,
      user: B.user,
      job: B.job,
      row: B.row,
      sourceHash: HASH_B,
      requestHash: REQUEST_B,
      rowHash: ROW_B,
      sku: 'B-ONLY-IMPORT',
    });
    await seedJob({
      tenant: A.tenant,
      user: A.user,
      job: A.job,
      row: A.row,
      sourceHash: HASH_A,
      requestHash: REQUEST_A,
      rowHash: ROW_A,
      sku: SHARED_SKU,
    });
  });

  afterAll(async () => {
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await prisma.$disconnect();
    await client.end();
  });

  it('runs under a non-superuser, non-bypass runtime role and forces RLS on migration tables', async () => {
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
        WHERE relname IN ('migration_import_jobs','migration_import_rows')
        ORDER BY relname`,
    );
    expect(tables.rows).toHaveLength(2);
    for (const table of tables.rows) {
      expect(table.relrowsecurity, table.relname).toBe(true);
      expect(table.relforcerowsecurity, table.relname).toBe(true);
    }
  });

  it('makes Tenant B jobs and rows invisible to Tenant A even by exact UUID', async () => {
    const counts = await asTenant(A.tenant, async () => {
      const jobs = await client.query('SELECT "id" FROM "migration_import_jobs" WHERE "id" = $1', [
        B.job,
      ]);
      const rows = await client.query(
        'SELECT "id","sourceIdentifier" FROM "migration_import_rows" WHERE "id" = $1',
        [B.row],
      );
      return { jobs: jobs.rowCount, rows: rows.rowCount };
    });
    expect(counts).toEqual({ jobs: 0, rows: 0 });

    const scope = { tenantId: tenantId(A.tenant) };
    await expect(readProductImportJob(prisma, scope, B.job)).resolves.toBeNull();
    await expect(
      readProductImportRows(prisma, scope, B.job, {
        limit: 50,
        afterSourceRow: null,
        problemsOnly: false,
      }),
    ).resolves.toBeNull();
  });

  it('returns the same unknown-job refusal for foreign dry-run and commit attempts', async () => {
    const scope = { tenantId: tenantId(A.tenant) };
    const actor = { userId: A.user };

    for (const action of [
      () => dryRunProductImport(prisma, scope, actor, B.job),
      () => commitProductImport(prisma, scope, actor, B.job, B.job),
    ]) {
      try {
        await action();
        throw new Error('cross-tenant migration action unexpectedly succeeded');
      } catch (error) {
        expect(error).toBeInstanceOf(ProductImportRefusedError);
        expect((error as ProductImportRefusedError).detail).toBe('unknown-job');
      }
    }
  });

  it('does not leak Tenant B catalogue conflicts into Tenant A dry-run diagnostics', async () => {
    const scope = { tenantId: tenantId(A.tenant) };
    const result = await dryRunProductImport(prisma, scope, { userId: A.user }, A.job);
    expect(result.status).toBe('dry-run');
    expect(result.errorRows).toBe(0);
    expect(result.blockedRows).toBe(0);

    const page = await readProductImportRows(prisma, scope, A.job, {
      limit: 50,
      afterSourceRow: null,
      problemsOnly: false,
    });
    expect(page?.rows).toEqual([
      expect.objectContaining({
        sourceIdentifier: SHARED_SKU,
        plannedAction: 'create',
        status: 'pending',
        issues: [],
      }),
    ]);
  });

  it('rejects a Tenant A row that attempts to reference Tenant B import job', async () => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, TRUE)", [A.tenant]);
    let message = '';
    try {
      await client.query(
        `INSERT INTO "migration_import_rows"
          ("id","tenantId","jobId","sourceRow","rowFingerprint","issues",
           "classification","plannedAction","status","updatedAt")
         VALUES ('018fb800-0000-7000-8000-0000000000cc',$1,$2,3,$3,'[]'::jsonb,
                 'VALID','create','pending',now())`,
        [A.tenant, B.job, '1'.repeat(64)],
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      await client.query('ROLLBACK');
    }
    expect(message).toMatch(/foreign key constraint "migration_import_rows_tenantId_jobId_fkey"/i);
  });

  it('cannot update or delete Tenant B migration state and leaves it unchanged', async () => {
    const effect = await asTenant(A.tenant, async () => {
      const updated = await client.query(
        `UPDATE "migration_import_jobs" SET "status" = 'completed' WHERE "id" = $1`,
        [B.job],
      );
      const deleted = await client.query('DELETE FROM "migration_import_rows" WHERE "id" = $1', [
        B.row,
      ]);
      return { updated: updated.rowCount, deleted: deleted.rowCount };
    });
    expect(effect).toEqual({ updated: 0, deleted: 0 });

    const survived = await asTenant(B.tenant, async () => {
      const job = await client.query<{ status: string }>(
        'SELECT "status" FROM "migration_import_jobs" WHERE "id" = $1',
        [B.job],
      );
      const row = await client.query<{ status: string; sourceIdentifier: string }>(
        'SELECT "status","sourceIdentifier" FROM "migration_import_rows" WHERE "id" = $1',
        [B.row],
      );
      return { job: job.rows[0], row: row.rows[0] };
    });
    expect(survived).toEqual({
      job: { status: 'reviewed' },
      row: { status: 'pending', sourceIdentifier: 'B-ONLY-IMPORT' },
    });
  });
});
