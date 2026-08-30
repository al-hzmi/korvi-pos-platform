import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Strike 5C forward migration, rehearsed against an occupied 11-migration schema.
 *
 * A fresh deploy proves that the SQL parses. It cannot prove what the migration
 * does to historical stock, sale, return and receipt evidence, nor whether the
 * permission backfill can see existing roles through FORCE RLS. This suite
 * creates that exact predecessor state and then executes the real twelfth
 * migration, one statement at a time, as the non-superuser application role.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', '..', 'prisma', 'migrations');

const BEFORE = [
  '00000000000000_rls_foundation',
  '20260808120000_saas_foundation',
  '20260810120000_auth_security',
  '20260816120000_commercial_settlement',
  '20260822120000_returns_refunds',
  '20260823120000_shift_reconciliation',
  '20260824120000_tenant_lifecycle',
  '20260825120000_plan_entitlements',
  '20260826120000_owner_bootstrap',
  '20260827120000_inventory_stock_ledger',
  '20260828120000_purchasing_receiving',
] as const;

const COSTING = '20260830210000_costing_authority';
const SCHEMA = 'korvi_rehearsal_5c';

const D = {
  tenant: '018f5c00-0000-7000-8000-00000000001a',
  branch: '018f5c00-0000-7000-8000-0000000000a1',
  user: '018f5c00-0000-7000-8000-0000000000a2',
  terminal: '018f5c00-0000-7000-8000-0000000000a3',
  shift: '018f5c00-0000-7000-8000-0000000000a4',
  product: '018f5c00-0000-7000-8000-0000000000a5',
  negativeProduct: '018f5c00-0000-7000-8000-0000000000a6',
  sale: '018f5c00-0000-7000-8000-0000000000a7',
  saleLine: '018f5c00-0000-7000-8000-0000000000a8',
  return: '018f5c00-0000-7000-8000-0000000000a9',
  returnLine: '018f5c00-0000-7000-8000-0000000000aa',
  supplier: '018f5c00-0000-7000-8000-0000000000ab',
  order: '018f5c00-0000-7000-8000-0000000000ac',
  orderLine: '018f5c00-0000-7000-8000-0000000000ad',
  receipt: '018f5c00-0000-7000-8000-0000000000ae',
  receiptLine: '018f5c00-0000-7000-8000-0000000000af',
  movementOpening: '018f5c00-0000-7000-8000-0000000000b0',
  movementSale: '018f5c00-0000-7000-8000-0000000000b1',
  movementReturn: '018f5c00-0000-7000-8000-0000000000b2',
  movementReceipt: '018f5c00-0000-7000-8000-0000000000b3',
  movementNegative: '018f5c00-0000-7000-8000-0000000000b4',
} as const;

const ROLES = [
  ['018f5c00-0000-7000-8000-0000000000c1', 'owner', true],
  ['018f5c00-0000-7000-8000-0000000000c2', 'admin', true],
  ['018f5c00-0000-7000-8000-0000000000c3', 'manager', true],
  ['018f5c00-0000-7000-8000-0000000000c4', 'cashier', true],
  ['018f5c00-0000-7000-8000-0000000000c5', 'stock-auditor', false],
] as const;

const HISTORICAL_COUNTS = {
  movements: 5,
  saleLines: 1,
  returnLines: 1,
  receiptLines: 1,
  balances: 2,
} as const;

interface HistoricalCounts {
  readonly movements: number;
  readonly saleLines: number;
  readonly returnLines: number;
  readonly receiptLines: number;
  readonly balances: number;
}

function sqlOf(migration: string): string {
  return readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8');
}

/** The 5C file has no dollar-quoted bodies or semicolons inside literals. */
function statementsOf(sql: string): readonly string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

describe.skipIf(url === '')('pre-5C costing migration rehearsal, live', () => {
  let client: pg.Client;
  let beforeCostColumns = -1;
  let beforeCostTables = -1;

  async function inTenant<T>(work: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [D.tenant]);
    try {
      const value = await work();
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async function historicalCounts(): Promise<HistoricalCounts> {
    return inTenant(async () => {
      const { rows } = await client.query<{
        movements: string;
        saleLines: string;
        returnLines: string;
        receiptLines: string;
        balances: string;
      }>(`
        SELECT
          (SELECT count(*) FROM "inventory_movements")::text AS "movements",
          (SELECT count(*) FROM "sale_lines")::text AS "saleLines",
          (SELECT count(*) FROM "return_lines")::text AS "returnLines",
          (SELECT count(*) FROM "purchase_receipt_lines")::text AS "receiptLines",
          (SELECT count(*) FROM "inventory_balances")::text AS "balances"`);
      const row = rows[0];
      if (row === undefined) throw new Error('historical row counts were not returned');
      return {
        movements: Number(row.movements),
        saleLines: Number(row.saleLines),
        returnLines: Number(row.returnLines),
        receiptLines: Number(row.receiptLines),
        balances: Number(row.balances),
      };
    });
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();

    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    for (const migration of BEFORE) await client.query(sqlOf(migration));

    const { rows: columns } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.columns
        WHERE table_schema = $1
          AND column_name IN (
            'inventoryValueMinor', 'costKnownQuantityScaled',
            'costUnknownQuantityScaled', 'costValueMinor', 'costProvenance'
          )`,
      [SCHEMA],
    );
    beforeCostColumns = Number(columns[0]?.count ?? '-1');
    const { rows: tables } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name IN ('inventory_cost_balances', 'inventory_valuation_events')`,
      [SCHEMA],
    );
    beforeCostTables = Number(tables[0]?.count ?? '-1');

    await inTenant(async () => {
      await client.query(
        `INSERT INTO "tenants"
          ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt")
         VALUES ($1,'متجر ترحيل التكلفة','rehearsal-5c','active','recorded',now(),now())`,
        [D.tenant],
      );
      await client.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
         VALUES ($1,$2,'01','الفرع',now())`,
        [D.branch, D.tenant],
      );
      await client.query(
        `INSERT INTO "users" ("id","tenantId","email","displayName","updatedAt")
         VALUES ($1,$2,'migration-5c@korvi.test','مسؤول الترحيل',now())`,
        [D.user, D.tenant],
      );
      await client.query(
        `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
         VALUES ($1,$2,$3,'T1','صندوق',now())`,
        [D.terminal, D.tenant, D.branch],
      );
      await client.query(
        `INSERT INTO "shifts"
          ("id","tenantId","branchId","terminalId","userId","openingFloatMinor","openedAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,0,now(),now())`,
        [D.shift, D.tenant, D.branch, D.terminal, D.user],
      );
      for (const [id, sku] of [
        [D.product, 'HISTORICAL-POSITIVE'],
        [D.negativeProduct, 'HISTORICAL-NEGATIVE'],
      ] as const) {
        await client.query(
          `INSERT INTO "products"
            ("id","tenantId","sku","nameAr","priceMinor","vatBasisPoints","updatedAt")
           VALUES ($1,$2,$3,$3,1150,1500,now())`,
          [id, D.tenant, sku],
        );
      }
      for (const [id, key, isSystem] of ROLES) {
        await client.query(
          `INSERT INTO "roles"
            ("id","tenantId","key","nameAr","maxDiscountBasisPoints","isSystem","updatedAt")
           VALUES ($1,$2,$3,$3,0,$4,now())`,
          [id, D.tenant, key, isSystem],
        );
      }

      await client.query(
        `INSERT INTO "sales"
          ("id","tenantId","branchId","terminalId","shiftId","userId","operationId",
           "sequence","priceMode","grossMinor","lineDiscountMinor","basketDiscountMinor",
           "netMinor","vatMinor","totalMinor","tenderedMinor","changeMinor","issuedAt")
         VALUES ($1,$2,$3,$4,$5,$6,'historical-sale',1,'tax-inclusive',3450,0,0,
                 3000,450,3450,3450,0,now())`,
        [D.sale, D.tenant, D.branch, D.terminal, D.shift, D.user],
      );
      await client.query(
        `INSERT INTO "sale_lines"
          ("id","tenantId","saleId","productId","lineNumber","sku","nameAr",
           "unitPriceMinor","vatBasisPoints","quantityScaled","grossMinor","lineDiscountMinor",
           "basketDiscountMinor","netMinor","vatMinor","totalMinor")
         VALUES ($1,$2,$3,$4,1,'HISTORICAL-POSITIVE','صنف',1150,1500,3000,3450,0,0,3000,450,3450)`,
        [D.saleLine, D.tenant, D.sale, D.product],
      );
      await client.query(
        `INSERT INTO "returns"
          ("id","tenantId","saleId","branchId","operationId","netMinor","vatMinor",
           "totalMinor","actorUserId","issuedAt")
         VALUES ($1,$2,$3,$4,'historical-return',1000,150,1150,$5,now())`,
        [D.return, D.tenant, D.sale, D.branch, D.user],
      );
      await client.query(
        `INSERT INTO "return_lines"
          ("id","tenantId","returnId","saleLineId","quantityScaled","netMinor","vatMinor","totalMinor")
         VALUES ($1,$2,$3,$4,1000,1000,150,1150)`,
        [D.returnLine, D.tenant, D.return, D.saleLine],
      );

      await client.query(
        `INSERT INTO "suppliers" ("id","tenantId","name","updatedAt")
         VALUES ($1,$2,'مورد تاريخي',now())`,
        [D.supplier, D.tenant],
      );
      await client.query(
        `INSERT INTO "purchase_orders"
          ("id","tenantId","supplierId","branchId","operationId","requestHash","status",
           "actorUserId","orderedAt","updatedAt")
         VALUES ($1,$2,$3,$4,'historical-order',$5,'received',$6,now(),now())`,
        [D.order, D.tenant, D.supplier, D.branch, 'o'.repeat(43), D.user],
      );
      await client.query(
        `INSERT INTO "purchase_order_lines"
          ("id","tenantId","purchaseOrderId","productId","orderedQuantityScaled","receivedQuantityScaled")
         VALUES ($1,$2,$3,$4,2000,2000)`,
        [D.orderLine, D.tenant, D.order, D.product],
      );
      await client.query(
        `INSERT INTO "purchase_receipts"
          ("id","tenantId","purchaseOrderId","branchId","supplierId","operationId",
           "requestHash","actorUserId","receivedAt")
         VALUES ($1,$2,$3,$4,$5,'historical-receipt',$6,$7,now())`,
        [D.receipt, D.tenant, D.order, D.branch, D.supplier, 'r'.repeat(43), D.user],
      );
      await client.query(
        `INSERT INTO "purchase_receipt_lines"
          ("id","tenantId","purchaseReceiptId","purchaseOrderLineId","productId",
           "acceptedQuantityScaled","orderedQuantityScaled","beforeReceivedQuantityScaled",
           "afterReceivedQuantityScaled","beforeQuantityScaled","afterQuantityScaled","resultRevision")
         VALUES ($1,$2,$3,$4,$5,2000,2000,0,2000,5000,7000,4)`,
        [D.receiptLine, D.tenant, D.receipt, D.orderLine, D.product],
      );

      await client.query(
        `INSERT INTO "inventory_balances"
          ("tenantId","branchId","productId","quantityScaled","revision","updatedAt")
         VALUES ($1,$2,$3,7000,4,now()), ($1,$2,$4,-2000,1,now())`,
        [D.tenant, D.branch, D.product, D.negativeProduct],
      );
      for (const movement of [
        [D.movementOpening, D.product, 'adjustment', 7_000, null, null, null],
        [D.movementSale, D.product, 'sale', -3_000, 'sale', D.sale, null],
        [D.movementReturn, D.product, 'return', 1_000, 'return', D.return, null],
        [
          D.movementReceipt,
          D.product,
          'receipt',
          2_000,
          'purchase-receipt',
          D.receipt,
          D.receiptLine,
        ],
        [D.movementNegative, D.negativeProduct, 'adjustment', -2_000, null, null, null],
      ] as const) {
        await client.query(
          `INSERT INTO "inventory_movements"
            ("id","tenantId","branchId","productId","kind","quantityScaled","sourceType",
             "sourceId","sourceLineId","actorUserId","occurredAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
          [
            movement[0],
            D.tenant,
            D.branch,
            movement[1],
            movement[2],
            movement[3],
            movement[4],
            movement[5],
            movement[6],
            D.user,
          ],
        );
      }
    });

    expect(await historicalCounts()).toEqual(HISTORICAL_COUNTS);

    // One statement at a time: the transaction being proved is the BEGIN /
    // COMMIT inside the migration, including its temporary FORCE-RLS lift.
    for (const statement of statementsOf(sqlOf(COSTING))) await client.query(statement);
  }, 180_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it('started from the actual eleven-migration shape, without 5C artifacts', () => {
    expect(BEFORE).toHaveLength(11);
    expect(beforeCostColumns).toBe(0);
    expect(beforeCostTables).toBe(0);
  });

  it('preserves every historical row and marks all bases unknown without inventing value', async () => {
    expect(await historicalCounts()).toEqual(HISTORICAL_COUNTS);

    const evidence = await inTenant(async () => {
      const movements = await client.query<{
        id: string;
        quantityScaled: string;
        known: string;
        unknown: string;
        value: string;
        provenance: string;
      }>(
        `SELECT "id"::text AS id, "quantityScaled"::text AS "quantityScaled",
                "costKnownQuantityScaled"::text AS known,
                "costUnknownQuantityScaled"::text AS unknown,
                "costValueMinor"::text AS value, "costProvenance" AS provenance
           FROM "inventory_movements" ORDER BY "id"`,
      );
      const sale = await client.query(
        `SELECT "costKnownQuantityScaled"::text AS known,
                "costUnknownQuantityScaled"::text AS unknown,
                "costValueMinor"::text AS value, "costProvenance" AS provenance
           FROM "sale_lines" WHERE "id" = $1`,
        [D.saleLine],
      );
      const returned = await client.query(
        `SELECT "costKnownQuantityScaled"::text AS known,
                "costUnknownQuantityScaled"::text AS unknown,
                "costValueMinor"::text AS value, "costProvenance" AS provenance
           FROM "return_lines" WHERE "id" = $1`,
        [D.returnLine],
      );
      const receipt = await client.query(
        `SELECT "inventoryValueMinor"::text AS "inventoryValueMinor",
                "costKnownQuantityScaled"::text AS known,
                "costUnknownQuantityScaled"::text AS unknown,
                "costValueMinor"::text AS value, "costProvenance" AS provenance
           FROM "purchase_receipt_lines" WHERE "id" = $1`,
        [D.receiptLine],
      );
      return {
        movements: movements.rows,
        sale: sale.rows[0],
        returned: returned.rows[0],
        receipt: receipt.rows[0],
      };
    });

    expect(evidence.movements).toHaveLength(5);
    for (const movement of evidence.movements) {
      expect(movement.known, movement.id).toBe('0');
      expect(movement.unknown, movement.id).toBe(
        (BigInt(movement.quantityScaled) < 0n
          ? -BigInt(movement.quantityScaled)
          : BigInt(movement.quantityScaled)
        ).toString(),
      );
      expect(movement.value, movement.id).toBe('0');
      expect(movement.provenance, movement.id).toBe('historical-unknown');
    }
    expect(evidence.sale).toEqual({
      known: '0',
      unknown: '3000',
      value: '0',
      provenance: 'historical-unknown',
    });
    expect(evidence.returned).toEqual({
      known: '0',
      unknown: '1000',
      value: '0',
      provenance: 'historical-unknown',
    });
    expect(evidence.receipt).toEqual({
      inventoryValueMinor: null,
      known: '0',
      unknown: '2000',
      value: '0',
      provenance: 'historical-unknown',
    });
  });

  it('seeds only zero-known cursors synchronized to the existing stock revisions', async () => {
    const rows = await inTenant(async () => {
      const result = await client.query<{
        productId: string;
        quantity: string;
        revision: string;
        known: string;
        value: string;
        stockRevision: string;
        costRevision: string;
      }>(
        `SELECT b."productId"::text AS "productId", b."quantityScaled"::text AS quantity,
                b."revision"::text AS revision, c."knownQuantityScaled"::text AS known,
                c."knownValueMinor"::text AS value, c."stockRevision"::text AS "stockRevision",
                c."costRevision"::text AS "costRevision"
           FROM "inventory_balances" b
           JOIN "inventory_cost_balances" c
             ON c."tenantId" = b."tenantId"
            AND c."branchId" = b."branchId"
            AND c."productId" = b."productId"
          ORDER BY b."productId"`,
      );
      return result.rows;
    });

    expect(rows).toEqual([
      {
        productId: D.product,
        quantity: '7000',
        revision: '4',
        known: '0',
        value: '0',
        stockRevision: '4',
        costRevision: '0',
      },
      {
        productId: D.negativeProduct,
        quantity: '-2000',
        revision: '1',
        known: '0',
        value: '0',
        stockRevision: '1',
        costRevision: '0',
      },
    ]);

    const events = await inTenant(async () => {
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM "inventory_valuation_events"',
      );
      return Number(rows[0]?.count ?? '-1');
    });
    expect(events, 'migration invented historical valuation events').toBe(0);
  });

  it('backfills both cost permissions only to system manager, admin and owner roles', async () => {
    const { rows: catalogue } = await client.query<{ key: string }>(
      `SELECT "key" FROM "permissions" WHERE "key" LIKE 'inventory.cost.%' ORDER BY "key"`,
    );
    expect(catalogue.map((row) => row.key)).toEqual([
      'inventory.cost.manage',
      'inventory.cost.read',
    ]);

    const grants = await inTenant(async () => {
      const { rows } = await client.query<{
        id: string;
        key: string;
        permissionKey: string;
      }>(
        `SELECT rp."id"::text AS id, r."key", rp."permissionKey"
           FROM "role_permissions" rp
           JOIN "roles" r ON r."tenantId" = rp."tenantId" AND r."id" = rp."roleId"
          WHERE rp."permissionKey" LIKE 'inventory.cost.%'
          ORDER BY r."key", rp."permissionKey"`,
      );
      return rows;
    });
    expect(grants.map(({ key, permissionKey }) => [key, permissionKey])).toEqual([
      ['admin', 'inventory.cost.manage'],
      ['admin', 'inventory.cost.read'],
      ['manager', 'inventory.cost.manage'],
      ['manager', 'inventory.cost.read'],
      ['owner', 'inventory.cost.manage'],
      ['owner', 'inventory.cost.read'],
    ]);
    for (const grant of grants) {
      expect(grant.id[14], grant.id).toBe('7');
      expect(['8', '9', 'a', 'b'], grant.id).toContain(grant.id[19]);
    }
    expect(new Set(grants.map((grant) => grant.id)).size).toBe(6);
  });

  it('forces RLS on new cost tables and restores it on the backfilled role tables', async () => {
    const { rows } = await client.query<{
      relname: string;
      enabled: boolean;
      forced: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname IN (
            'inventory_cost_balances', 'inventory_valuation_events', 'roles', 'role_permissions'
          )
        ORDER BY c.relname`,
      [SCHEMA],
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.enabled, row.relname).toBe(true);
      expect(row.forced, row.relname).toBe(true);
    }

    // No tenant context: the table owner is still subject to FORCE RLS and
    // cannot see either the seeded cursors or the roles it just backfilled.
    const blind = await client.query<{ costs: string; roles: string }>(
      `SELECT
        (SELECT count(*) FROM "inventory_cost_balances")::text AS costs,
        (SELECT count(*) FROM "roles")::text AS roles`,
    );
    expect(blind.rows[0]).toEqual({ costs: '0', roles: '0' });
  });
});
