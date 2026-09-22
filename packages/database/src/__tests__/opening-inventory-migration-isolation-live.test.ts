import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { tenantId } from '@korvi/domain';
import {
  commitOpeningInventoryImport,
  createPrismaClient,
  dryRunOpeningInventoryImport,
  readOpeningInventoryImportRows,
} from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '018fbf10-0000-7000-8000-00000000000a',
  user: '018fbf10-0000-7000-8000-0000000000a1',
  branch: '018fbf10-0000-7000-8000-0000000000a2',
  product: '018fbf10-0000-7000-8000-0000000000a3',
  raceProduct: '018fbf10-0000-7000-8000-0000000000a4',
  validJob: '018fbf10-0000-7000-8000-0000000000a5',
  validRow: '018fbf10-0000-7000-8000-0000000000a6',
  validCommit: '018fbf10-0000-7000-8000-0000000000a7',
  branchLeakJob: '018fbf10-0000-7000-8000-0000000000a8',
  branchLeakRow: '018fbf10-0000-7000-8000-0000000000a9',
  skuLeakJob: '018fbf10-0000-7000-8000-0000000000aa',
  skuLeakRow: '018fbf10-0000-7000-8000-0000000000ab',
  raceJob: '018fbf10-0000-7000-8000-0000000000ac',
  raceRow: '018fbf10-0000-7000-8000-0000000000ad',
  raceCommit: '018fbf10-0000-7000-8000-0000000000ae',
} as const;

const B = {
  tenant: '018fbf10-0000-7000-8000-00000000000b',
  user: '018fbf10-0000-7000-8000-0000000000b1',
  branch: '018fbf10-0000-7000-8000-0000000000b2',
  product: '018fbf10-0000-7000-8000-0000000000b3',
} as const;

describe.skipIf(url === '')('opening inventory migration isolation, PostgreSQL live', () => {
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

  async function seedTenant(id: string, user: string, slug: string): Promise<void> {
    await asTenant(id, async () => {
      await client.query(
        `INSERT INTO "tenants"
          ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt")
         VALUES ($1,$2,$3,'active','recorded',now(),now())`,
        [id, 'Opening ' + slug, slug],
      );
      await client.query(
        `INSERT INTO "users" ("id","tenantId","email","displayName","updatedAt")
         VALUES ($1,$2,$3,'Migration operator',now())`,
        [user, id, slug + '@migration.test'],
      );
    });
  }

  async function seedBranchProduct(
    tenant: string,
    branch: string,
    code: string,
    product: string,
    sku: string,
  ): Promise<void> {
    await asTenant(tenant, async () => {
      await client.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","isActive","updatedAt")
         VALUES ($1,$2,$3,$4,true,now())`,
        [branch, tenant, code, 'فرع ' + code],
      );
      await client.query(
        `INSERT INTO "products"
          ("id","tenantId","sku","nameAr","productType","unitLabel",
           "priceMinor","vatBasisPoints","trackInventory","isActive","updatedAt")
         VALUES ($1,$2,$3,$4,'unit','each',1000,1500,true,true,now())`,
        [product, tenant, sku, 'صنف ' + sku],
      );
    });
  }

  async function seedJob(
    job: string,
    row: string,
    branchCode: string,
    sku: string,
    quantityScaled: string,
    hash: string,
  ): Promise<void> {
    await asTenant(A.tenant, async () => {
      await client.query(
        `INSERT INTO "migration_import_jobs"
          ("id","tenantId","actorUserId","domain","format","sourceSha256",
           "createOperationId","createRequestHash","status","mappingVersion","mapping",
           "conflictPolicy","totalRows","validRows","warningRows","errorRows","blockedRows","updatedAt")
         VALUES ($1,$2,$3,'opening-inventory','csv',$4,$1,$5,'reviewed',1,'[]'::jsonb,
                 'reject',1,1,0,0,0,now())`,
        [job, A.tenant, A.user, hash.repeat(64), hash.repeat(64)],
      );
      await client.query(
        `INSERT INTO "migration_import_rows"
          ("id","tenantId","jobId","sourceRow","rowFingerprint","sourceIdentifier",
           "sourceData","canonicalData","issues","classification","plannedAction","status","updatedAt")
         VALUES ($1,$2,$3,2,$4,$5,'[]'::jsonb,$6::jsonb,'[]'::jsonb,
                 'VALID','create','pending',now())`,
        [
          row,
          A.tenant,
          job,
          hash.repeat(64),
          branchCode + ' / ' + sku,
          JSON.stringify({ branchCode, sku, quantityScaled }),
        ],
      );
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    client = new pg.Client({ connectionString: url });
    await client.connect();
    for (const tenant of [A.tenant, B.tenant]) {
      await asTenant(tenant, async () => {
        await client.query('DELETE FROM "tenants" WHERE "id" = $1', [tenant]);
      });
    }
    await seedTenant(A.tenant, A.user, 'opening-proof-a');
    await seedTenant(B.tenant, B.user, 'opening-proof-b');
    await seedBranchProduct(A.tenant, A.branch, 'MAIN', A.product, 'OPEN-A');
    await asTenant(A.tenant, async () => {
      await client.query(
        `INSERT INTO "products"
          ("id","tenantId","sku","nameAr","productType","unitLabel",
           "priceMinor","vatBasisPoints","trackInventory","isActive","updatedAt")
         VALUES ($1,$2,'OPEN-RACE','صنف سباق','unit','each',1000,1500,true,true,now())`,
        [A.raceProduct, A.tenant],
      );
    });
    await seedBranchProduct(B.tenant, B.branch, 'B-ONLY', B.product, 'B-ONLY-SKU');

    await seedJob(A.validJob, A.validRow, 'MAIN', 'OPEN-A', '12000', '1');
    await seedJob(A.branchLeakJob, A.branchLeakRow, 'B-ONLY', 'OPEN-A', '1000', '2');
    await seedJob(A.skuLeakJob, A.skuLeakRow, 'MAIN', 'B-ONLY-SKU', '1000', '3');
    await seedJob(A.raceJob, A.raceRow, 'MAIN', 'OPEN-RACE', '5000', '4');
  });

  afterAll(async () => {
    for (const tenant of [A.tenant, B.tenant]) {
      await asTenant(tenant, async () => {
        await client.query('DELETE FROM "tenants" WHERE "id" = $1', [tenant]);
      });
    }
    await prisma.$disconnect();
    await client.end();
  });

  it('runs under non-superuser non-bypass RLS runtime', async () => {
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
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname IN (
            'migration_import_jobs',
            'migration_import_rows',
            'inventory_balances',
            'inventory_movements'
          )
        ORDER BY c.relname`,
    );
    expect(tables.rows).toHaveLength(4);
    for (const table of tables.rows) {
      expect(table.relrowsecurity, table.relname).toBe(true);
      expect(table.relforcerowsecurity, table.relname).toBe(true);
    }
  });

  it('does not resolve foreign-tenant branch codes or SKUs', async () => {
    const scope = { tenantId: tenantId(A.tenant) };
    const branch = await dryRunOpeningInventoryImport(
      prisma,
      scope,
      { userId: A.user },
      A.branchLeakJob,
    );
    const sku = await dryRunOpeningInventoryImport(prisma, scope, { userId: A.user }, A.skuLeakJob);
    expect(branch.errorRows).toBe(1);
    expect(sku.errorRows).toBe(1);

    const branchRows = await readOpeningInventoryImportRows(prisma, scope, A.branchLeakJob, {
      limit: 20,
      afterSourceRow: null,
      problemsOnly: true,
    });
    const skuRows = await readOpeningInventoryImportRows(prisma, scope, A.skuLeakJob, {
      limit: 20,
      afterSourceRow: null,
      problemsOnly: true,
    });
    expect(branchRows?.rows[0]?.errorCode).toBe('unknown-branch');
    expect(skuRows?.rows[0]?.errorCode).toBe('unknown-product');
  });

  it('writes one causal movement with UNKNOWN cost and replays idempotently', async () => {
    const scope = { tenantId: tenantId(A.tenant) };
    expect(
      (await dryRunOpeningInventoryImport(prisma, scope, { userId: A.user }, A.validJob)).errorRows,
    ).toBe(0);

    const first = await commitOpeningInventoryImport(
      prisma,
      scope,
      { userId: A.user },
      A.validJob,
      A.validCommit,
    );
    const replay = await commitOpeningInventoryImport(
      prisma,
      scope,
      { userId: A.user },
      A.validJob,
      A.validCommit,
    );
    expect(first.created).toBe(1);
    expect(replay).toEqual(first);

    const evidence = await asTenant(A.tenant, async () => {
      const movement = await client.query(
        `SELECT "kind","quantityScaled"::text AS quantity,"sourceType","sourceId","sourceLineId",
                "costKnownQuantityScaled"::text AS known,
                "costUnknownQuantityScaled"::text AS unknown,
                "costValueMinor"::text AS value,"costProvenance" AS provenance
           FROM "inventory_movements"
          WHERE "sourceType" = 'migration-opening-stock' AND "sourceId" = $1`,
        [A.validJob],
      );
      const balance = await client.query(
        `SELECT "quantityScaled"::text AS quantity,"revision"::text AS revision
           FROM "inventory_balances"
          WHERE "branchId" = $1 AND "productId" = $2`,
        [A.branch, A.product],
      );
      const cost = await client.query(
        `SELECT "knownQuantityScaled"::text AS known,"knownValueMinor"::text AS value,
                "stockRevision"::text AS "stockRevision"
           FROM "inventory_cost_balances"
          WHERE "branchId" = $1 AND "productId" = $2`,
        [A.branch, A.product],
      );
      return { movement: movement.rows, balance: balance.rows, cost: cost.rows };
    });

    expect(evidence.movement).toEqual([
      expect.objectContaining({
        kind: 'adjustment',
        quantity: '12000',
        sourceType: 'migration-opening-stock',
        sourceId: A.validJob,
        sourceLineId: A.validRow,
        known: '0',
        unknown: '12000',
        value: '0',
        provenance: 'unknown',
      }),
    ]);
    expect(evidence.balance).toEqual([{ quantity: '12000', revision: '1' }]);
    expect(evidence.cost).toEqual([{ known: '0', value: '0', stockRevision: '1' }]);
  });

  it('rechecks pristine stock at commit after a successful dry-run', async () => {
    const scope = { tenantId: tenantId(A.tenant) };
    expect(
      (await dryRunOpeningInventoryImport(prisma, scope, { userId: A.user }, A.raceJob)).errorRows,
    ).toBe(0);

    await asTenant(A.tenant, async () => {
      await client.query(
        `INSERT INTO "inventory_balances"
          ("tenantId","branchId","productId","quantityScaled","revision","updatedAt")
         VALUES ($1,$2,$3,1000,1,now())`,
        [A.tenant, A.branch, A.raceProduct],
      );
    });

    const committed = await commitOpeningInventoryImport(
      prisma,
      scope,
      { userId: A.user },
      A.raceJob,
      A.raceCommit,
    );
    expect(committed.created).toBe(0);
    expect(committed.failed).toBe(1);

    const rows = await readOpeningInventoryImportRows(prisma, scope, A.raceJob, {
      limit: 20,
      afterSourceRow: null,
      problemsOnly: true,
    });
    expect(rows?.rows[0]).toMatchObject({
      status: 'failed',
      errorCode: 'opening-stock-not-pristine',
      plannedAction: 'reject',
    });
  });
});
