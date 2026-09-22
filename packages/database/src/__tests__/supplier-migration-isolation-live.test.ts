import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { tenantId } from '@korvi/domain';
import {
  SupplierImportRefusedError,
  commitSupplierImport,
  createPrismaClient,
  dryRunSupplierImport,
  readSupplierImportJob,
} from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '018fbd00-0000-7000-8000-00000000000a',
  user: '018fbd00-0000-7000-8000-0000000000a1',
  job: '018fbd00-0000-7000-8000-0000000000a2',
  row: '018fbd00-0000-7000-8000-0000000000a3',
  commit: '018fbd00-0000-7000-8000-0000000000a4',
} as const;

const B = {
  tenant: '018fbd00-0000-7000-8000-00000000000b',
  user: '018fbd00-0000-7000-8000-0000000000b1',
  supplier: '018fbd00-0000-7000-8000-0000000000b2',
  job: '018fbd00-0000-7000-8000-0000000000b3',
  row: '018fbd00-0000-7000-8000-0000000000b4',
  commit: '018fbd00-0000-7000-8000-0000000000b5',
} as const;

const NAME = 'شركة المورد الموحد';

describe.skipIf(url === '')('supplier migration tenant isolation, PostgreSQL live', () => {
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
        [id, 'Supplier ' + slug, slug],
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
         VALUES ($1,$2,$3,'suppliers','csv',$4,$5,$6,'reviewed',1,'[]'::jsonb,
                 'reject',1,1,0,0,0,now())`,
        [input.job, input.tenant, input.user, input.sourceHash, input.job, input.requestHash],
      );
      await client.query(
        `INSERT INTO "migration_import_rows"
          ("id","tenantId","jobId","sourceRow","rowFingerprint","sourceIdentifier",
           "sourceData","canonicalData","issues","classification","plannedAction","status","updatedAt")
         VALUES ($1,$2,$3,2,$4,$5,'[]'::jsonb,$6::jsonb,'[]'::jsonb,
                 'VALID','create','pending',now())`,
        [input.row, input.tenant, input.job, input.rowHash, NAME, JSON.stringify({ name: NAME })],
      );
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await seedTenant(A.tenant, A.user, 'supplier-proof-a');
    await seedTenant(B.tenant, B.user, 'supplier-proof-b');

    await asTenant(B.tenant, async () => {
      await client.query(
        `INSERT INTO "suppliers" ("id","tenantId","name","isActive","updatedAt")
         VALUES ($1,$2,$3,true,now())`,
        [B.supplier, B.tenant, NAME],
      );
    });
    await seedJob({
      tenant: A.tenant,
      user: A.user,
      job: A.job,
      row: A.row,
      sourceHash: '1'.repeat(64),
      requestHash: '2'.repeat(64),
      rowHash: '3'.repeat(64),
    });
    await seedJob({
      tenant: B.tenant,
      user: B.user,
      job: B.job,
      row: B.row,
      sourceHash: '4'.repeat(64),
      requestHash: '5'.repeat(64),
      rowHash: '6'.repeat(64),
    });
  });

  afterAll(async () => {
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await prisma.$disconnect();
    await client.end();
  });

  it('runs with forced RLS on suppliers and the shared migration ledger', async () => {
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
        WHERE relname IN ('suppliers','migration_import_jobs','migration_import_rows')
        ORDER BY relname`,
    );
    expect(tables.rows).toHaveLength(3);
    for (const table of tables.rows) {
      expect(table.relrowsecurity, table.relname).toBe(true);
      expect(table.relforcerowsecurity, table.relname).toBe(true);
    }
  });

  it('does not invent a name conflict even when the same tenant already has that name', async () => {
    const a = await dryRunSupplierImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      A.job,
    );
    const b = await dryRunSupplierImport(
      prisma,
      { tenantId: tenantId(B.tenant) },
      { userId: B.user },
      B.job,
    );
    expect(a.errorRows).toBe(0);
    expect(b.errorRows).toBe(0);
  });

  it('keeps foreign supplier jobs indistinguishable from unknown jobs', async () => {
    const scopeA = { tenantId: tenantId(A.tenant) };
    await expect(readSupplierImportJob(prisma, scopeA, B.job)).resolves.toBeNull();
    for (const action of [
      () => dryRunSupplierImport(prisma, scopeA, { userId: A.user }, B.job),
      () => commitSupplierImport(prisma, scopeA, { userId: A.user }, B.job, A.commit),
    ]) {
      try {
        await action();
        throw new Error('foreign supplier job unexpectedly succeeded');
      } catch (error) {
        expect(error).toBeInstanceOf(SupplierImportRefusedError);
        expect((error as SupplierImportRefusedError).detail).toBe('unknown-job');
      }
    }
  });

  it('commits duplicate names under real supplier semantics and replays idempotently', async () => {
    const scopeA = { tenantId: tenantId(A.tenant) };
    const first = await commitSupplierImport(prisma, scopeA, { userId: A.user }, A.job, A.commit);
    const replay = await commitSupplierImport(prisma, scopeA, { userId: A.user }, A.job, A.commit);
    expect(first.status).toBe('completed');
    expect(first.created).toBe(1);
    expect(replay).toEqual(first);

    const scopeB = { tenantId: tenantId(B.tenant) };
    const b = await commitSupplierImport(prisma, scopeB, { userId: B.user }, B.job, B.commit);
    expect(b.created).toBe(1);

    const aRows = await asTenant(A.tenant, async () =>
      client.query<{ id: string }>(
        'SELECT "id" FROM "suppliers" WHERE "tenantId" = $1 AND "name" = $2',
        [A.tenant, NAME],
      ),
    );
    const bRows = await asTenant(B.tenant, async () =>
      client.query<{ id: string }>(
        'SELECT "id" FROM "suppliers" WHERE "tenantId" = $1 AND "name" = $2 ORDER BY "id"',
        [B.tenant, NAME],
      ),
    );
    expect(aRows.rows).toHaveLength(1);
    expect(bRows.rows).toHaveLength(2);
    expect(bRows.rows.map((row) => row.id)).toContain(B.supplier);
  });
});
