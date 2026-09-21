import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { tenantId } from '@korvi/domain';
import {
  commitProductImport,
  createPrismaClient,
  dryRunProductImport,
  readProductImportRows,
} from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '018fba00-0000-7000-8000-00000000000a',
  user: '018fba00-0000-7000-8000-0000000000a1',
  category: '018fba00-0000-7000-8000-0000000000a2',
  job: '018fba00-0000-7000-8000-0000000000a3',
  row: '018fba00-0000-7000-8000-0000000000a4',
  commit: '018fba00-0000-7000-8000-0000000000a5',
} as const;

const B = {
  tenant: '018fba00-0000-7000-8000-00000000000b',
  user: '018fba00-0000-7000-8000-0000000000b1',
  job: '018fba00-0000-7000-8000-0000000000b3',
  row: '018fba00-0000-7000-8000-0000000000b4',
} as const;

const CATEGORY_NAME = 'مشروبات';
const HASH_A = '1'.repeat(64);
const HASH_B = '2'.repeat(64);
const REQUEST_A = '3'.repeat(64);
const REQUEST_B = '4'.repeat(64);
const ROW_A = '5'.repeat(64);
const ROW_B = '6'.repeat(64);

describe.skipIf(url === '')('product category-name migration authority, PostgreSQL live', () => {
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
      await client.query(
        `INSERT INTO "tenant_settings"
          ("tenantId","requireBarcode","allowWeightedItems","trackInventory","updatedAt")
         VALUES ($1,false,false,true,now())`,
        [id],
      );
    });
  }

  async function seedProductJob(input: {
    tenant: string;
    user: string;
    job: string;
    row: string;
    sourceHash: string;
    requestHash: string;
    rowHash: string;
    sku: string;
    categoryNameAr: string;
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
            categoryNameAr: input.categoryNameAr,
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
    await seedTenant(A.tenant, A.user, 'product-category-proof-a');
    await seedTenant(B.tenant, B.user, 'product-category-proof-b');

    await asTenant(A.tenant, async () => {
      await client.query(
        `INSERT INTO "categories"
          ("id","tenantId","nameAr","nameEn","sortOrder","isActive","updatedAt")
         VALUES ($1,$2,$3,NULL,0,true,now())`,
        [A.category, A.tenant, CATEGORY_NAME],
      );
    });

    await seedProductJob({
      tenant: A.tenant,
      user: A.user,
      job: A.job,
      row: A.row,
      sourceHash: HASH_A,
      requestHash: REQUEST_A,
      rowHash: ROW_A,
      sku: 'A-CATEGORY-PRODUCT',
      categoryNameAr: CATEGORY_NAME,
    });
    await seedProductJob({
      tenant: B.tenant,
      user: B.user,
      job: B.job,
      row: B.row,
      sourceHash: HASH_B,
      requestHash: REQUEST_B,
      rowHash: ROW_B,
      sku: 'B-CATEGORY-PRODUCT',
      categoryNameAr: CATEGORY_NAME,
    });
  });

  afterAll(async () => {
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await prisma.$disconnect();
    await client.end();
  });

  it('resolves categoryNameAr only inside the current tenant during dry-run', async () => {
    const a = await dryRunProductImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      A.job,
    );
    expect(a.status).toBe('dry-run');
    expect(a.errorRows).toBe(0);

    const b = await dryRunProductImport(
      prisma,
      { tenantId: tenantId(B.tenant) },
      { userId: B.user },
      B.job,
    );
    expect(b.status).toBe('dry-run');
    expect(b.errorRows).toBe(1);

    const bRows = await readProductImportRows(
      prisma,
      { tenantId: tenantId(B.tenant) },
      B.job,
      { limit: 20, afterSourceRow: null, problemsOnly: true },
    );
    expect(bRows?.rows).toEqual([
      expect.objectContaining({
        sourceIdentifier: 'B-CATEGORY-PRODUCT',
        classification: 'ERROR',
        plannedAction: 'reject',
        status: 'rejected',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'category-not-found',
            targetField: 'categoryNameAr',
          }),
        ]),
      }),
    ]);
  });

  it('re-resolves on commit, binds only Tenant A category, and replays idempotently', async () => {
    const scope = { tenantId: tenantId(A.tenant) };
    const first = await commitProductImport(prisma, scope, { userId: A.user }, A.job, A.commit);
    const replay = await commitProductImport(prisma, scope, { userId: A.user }, A.job, A.commit);

    expect(first.status).toBe('completed');
    expect(first.created).toBe(1);
    expect(replay).toEqual(first);

    const product = await asTenant(A.tenant, async () =>
      client.query<{ categoryId: string | null }>(
        'SELECT "categoryId" FROM "products" WHERE "tenantId" = $1 AND "sku" = $2',
        [A.tenant, 'A-CATEGORY-PRODUCT'],
      ),
    );
    expect(product.rows).toEqual([{ categoryId: A.category }]);

    const foreign = await asTenant(B.tenant, async () =>
      client.query<{ id: string }>(
        'SELECT "id" FROM "products" WHERE "tenantId" = $1 AND "sku" = $2',
        [B.tenant, 'A-CATEGORY-PRODUCT'],
      ),
    );
    expect(foreign.rows).toEqual([]);
  });

  it('rechecks category authority at commit after a successful dry-run', async () => {
    const category = '018fba00-0000-7000-8000-0000000000c1';
    const job = '018fba00-0000-7000-8000-0000000000c2';
    const row = '018fba00-0000-7000-8000-0000000000c3';
    const operation = '018fba00-0000-7000-8000-0000000000c4';
    const name = 'فئة تتغير بعد الفحص';

    await asTenant(A.tenant, async () => {
      await client.query(
        `INSERT INTO "categories"
          ("id","tenantId","nameAr","nameEn","sortOrder","isActive","updatedAt")
         VALUES ($1,$2,$3,NULL,0,true,now())`,
        [category, A.tenant, name],
      );
    });
    await seedProductJob({
      tenant: A.tenant,
      user: A.user,
      job,
      row,
      sourceHash: 'd'.repeat(64),
      requestHash: 'e'.repeat(64),
      rowHash: 'f'.repeat(64),
      sku: 'A-CATEGORY-RACE',
      categoryNameAr: name,
    });

    const dryRun = await dryRunProductImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      job,
    );
    expect(dryRun.errorRows).toBe(0);

    await asTenant(A.tenant, async () => {
      await client.query(
        'UPDATE "categories" SET "isActive" = false, "updatedAt" = now() WHERE "id" = $1',
        [category],
      );
    });

    const committed = await commitProductImport(
      prisma,
      { tenantId: tenantId(A.tenant) },
      { userId: A.user },
      job,
      operation,
    );
    expect(committed.status).toBe('completed');
    expect(committed.created).toBe(0);
    expect(committed.failed).toBe(1);

    const rows = await readProductImportRows(
      prisma,
      { tenantId: tenantId(A.tenant) },
      job,
      { limit: 20, afterSourceRow: null, problemsOnly: true },
    );
    expect(rows?.rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'category-inactive',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'commit-category-inactive' }),
      ]),
    });
  });

});
