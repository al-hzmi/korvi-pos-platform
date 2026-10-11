import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { tenantId } from '@korvi/domain';
import {
  CategoryImportRefusedError,
  commitCategoryImport,
  createPrismaClient,
  dryRunCategoryImport,
  readCategoryImportJob,
  readCategoryImportRows,
} from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '018fbb00-0000-7000-8000-00000000000a',
  user: '018fbb00-0000-7000-8000-0000000000a1',
  job: '018fbb00-0000-7000-8000-0000000000a2',
  row: '018fbb00-0000-7000-8000-0000000000a3',
  commit: '018fbb00-0000-7000-8000-0000000000a4',
} as const;

const B = {
  tenant: '018fbb00-0000-7000-8000-00000000000b',
  user: '018fbb00-0000-7000-8000-0000000000b1',
  category: '018fbb00-0000-7000-8000-0000000000b2',
  job: '018fbb00-0000-7000-8000-0000000000b3',
  row: '018fbb00-0000-7000-8000-0000000000b4',
} as const;

const NAME = 'مشروبات';
const HASH_A = '7'.repeat(64);
const HASH_B = '8'.repeat(64);
const REQUEST_A = '9'.repeat(64);
const REQUEST_B = 'a'.repeat(64);
const ROW_A = 'b'.repeat(64);
const ROW_B = 'c'.repeat(64);

describe.skipIf(url === '')('category migration tenant isolation, PostgreSQL live', () => {
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
        [id, 'Category ' + slug, slug],
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
  }): Promise<void> {
    await asTenant(input.tenant, async () => {
      await client.query(
        `INSERT INTO "migration_import_jobs"
          ("id","tenantId","actorUserId","domain","format","sourceSha256",
           "createOperationId","createRequestHash","status","mappingVersion","mapping",
           "conflictPolicy","totalRows","validRows","warningRows","errorRows","blockedRows","updatedAt")
         VALUES ($1,$2,$3,'categories','csv',$4,$5,$6,'reviewed',1,'[]'::jsonb,
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
          NAME,
          JSON.stringify({ nameAr: NAME, nameEn: 'Drinks', sortOrder: 10 }),
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
    await seedTenant(A.tenant, A.user, 'category-proof-a');
    await seedTenant(B.tenant, B.user, 'category-proof-b');

    await asTenant(B.tenant, async () => {
      await client.query(
        `INSERT INTO "categories"
          ("id","tenantId","nameAr","nameEn","sortOrder","isActive","updatedAt")
         VALUES ($1,$2,$3,'Private B',0,true,now())`,
        [B.category, B.tenant, NAME],
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
    });
    await seedJob({
      tenant: B.tenant,
      user: B.user,
      job: B.job,
      row: B.row,
      sourceHash: HASH_B,
      requestHash: REQUEST_B,
      rowHash: ROW_B,
    });
  });

  afterAll(async () => {
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await prisma.$disconnect();
    await client.end();
  });

  it('runs with forced RLS on categories and the shared migration ledger', async () => {
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
        WHERE relname IN ('categories','migration_import_jobs','migration_import_rows')
        ORDER BY relname`,
    );
    expect(tables.rows).toHaveLength(3);
    for (const table of tables.rows) {
      expect(table.relrowsecurity, table.relname).toBe(true);
      expect(table.relforcerowsecurity, table.relname).toBe(true);
    }
  });

  it('does not leak Tenant B category conflicts into Tenant A dry-run', async () => {
    const a = await dryRunCategoryImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      A.job,
    );
    expect(a.status).toBe('dry-run');
    expect(a.errorRows).toBe(0);

    const b = await dryRunCategoryImport(
      prisma,
      { tenantId: tenantId(B.tenant) },
      { userId: B.user },
      B.job,
    );
    expect(b.errorRows).toBe(1);
    const bRows = await readCategoryImportRows(prisma, { tenantId: tenantId(B.tenant) }, B.job, {
      limit: 20,
      afterSourceRow: null,
      problemsOnly: true,
    });
    expect(bRows?.rows[0]).toMatchObject({
      sourceIdentifier: NAME,
      classification: 'ERROR',
      plannedAction: 'reject',
    });
  });

  it('keeps foreign jobs indistinguishable from unknown jobs', async () => {
    const scopeA = { tenantId: tenantId(A.tenant) };
    await expect(readCategoryImportJob(prisma, scopeA, B.job)).resolves.toBeNull();

    for (const action of [
      () => dryRunCategoryImport(prisma, scopeA, { userId: A.user }, B.job),
      () => commitCategoryImport(prisma, scopeA, { userId: A.user }, B.job, A.commit),
    ]) {
      try {
        await action();
        throw new Error('foreign category job unexpectedly succeeded');
      } catch (error) {
        expect(error).toBeInstanceOf(CategoryImportRefusedError);
        expect((error as CategoryImportRefusedError).detail).toBe('unknown-job');
      }
    }
  });

  it('commits an independent same-name category in Tenant A and replays idempotently', async () => {
    const scope = { tenantId: tenantId(A.tenant) };
    const first = await commitCategoryImport(prisma, scope, { userId: A.user }, A.job, A.commit);
    const replay = await commitCategoryImport(prisma, scope, { userId: A.user }, A.job, A.commit);
    expect(first.status).toBe('completed');
    expect(first.created).toBe(1);
    expect(replay).toEqual(first);

    const aRows = await asTenant(A.tenant, async () =>
      client.query<{ id: string }>(
        'SELECT "id" FROM "categories" WHERE "tenantId" = $1 AND "nameAr" = $2',
        [A.tenant, NAME],
      ),
    );
    expect(aRows.rows).toHaveLength(1);
    expect(aRows.rows[0]!.id).not.toBe(B.category);

    const bRows = await asTenant(B.tenant, async () =>
      client.query<{ id: string }>(
        'SELECT "id" FROM "categories" WHERE "tenantId" = $1 AND "nameAr" = $2',
        [B.tenant, NAME],
      ),
    );
    expect(bRows.rows).toEqual([{ id: B.category }]);
  });
});
