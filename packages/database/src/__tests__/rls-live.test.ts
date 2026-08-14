import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Live tenant isolation, against a real PostgreSQL server.
 *
 * The rest of the suite verifies that the migration *says* the right thing.
 * This file verifies that PostgreSQL *does* the right thing, which is a
 * different claim and the only one that matters in production. A policy can be
 * present and still not apply — the owner bypasses it without FORCE, and a
 * missing WITH CHECK leaves UPDATE free to hand a row to another tenant.
 *
 * Two boundaries are exercised here, and they are not the same boundary:
 *
 *   RLS decides which rows a tenant can see and write.
 *   Tenant-consistent foreign keys decide which rows a tenant may *point at*.
 *
 * A sale owned by A, visible only to A, could still name a branch owned by B
 * if the key pointed at branches(id) alone — RLS would never notice, because
 * the sale row itself is perfectly in order.
 *
 * It is opt-in. Set KORVI_TEST_DATABASE_URL to a throwaway database that has
 * had both migrations applied, and connect as the role the application uses —
 * not as a superuser, which bypasses RLS entirely and would make half of this
 * file pass for the wrong reason:
 *
 *   KORVI_TEST_DATABASE_URL=postgresql://korvi@localhost:5432/korvi_pos \
 *     npx vitest run packages/database/src/__tests__/rls-live.test.ts
 *
 * Without that variable the file skips, and says so, rather than pretending a
 * structural check proved runtime behaviour.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const here = dirname(fileURLToPath(import.meta.url));

/** Distinctive ids, so a stray row is recognisable and cleanup is targeted. */
const A = {
  tenant: '018f0000-0000-7000-8000-00000000000a',
  branch: '018f0000-0000-7000-8000-0000000000a1',
  user: '018f0000-0000-7000-8000-0000000000a2',
  terminal: '018f0000-0000-7000-8000-0000000000a3',
  shift: '018f0000-0000-7000-8000-0000000000a4',
  customer: '018f0000-0000-7000-8000-0000000000a5',
  category: '018f0000-0000-7000-8000-0000000000a6',
  product: '018f0000-0000-7000-8000-0000000000a7',
  sale: '018f0000-0000-7000-8000-0000000000a8',
  saleLine: '018f0000-0000-7000-8000-0000000000a9',
} as const;

const B = {
  tenant: '018f0000-0000-7000-8000-00000000000b',
  branch: '018f0000-0000-7000-8000-0000000000b1',
  user: '018f0000-0000-7000-8000-0000000000b2',
  terminal: '018f0000-0000-7000-8000-0000000000b3',
  shift: '018f0000-0000-7000-8000-0000000000b4',
  customer: '018f0000-0000-7000-8000-0000000000b5',
  category: '018f0000-0000-7000-8000-0000000000b6',
  product: '018f0000-0000-7000-8000-0000000000b7',
  sale: '018f0000-0000-7000-8000-0000000000b8',
  saleLine: '018f0000-0000-7000-8000-0000000000b9',
} as const;

/** Scratch ids for rows a test tries, and expects, to fail to create. */
const SCRATCH = {
  sale: '018f0000-0000-7000-8000-0000000000c1',
  saleLine: '018f0000-0000-7000-8000-0000000000c2',
  movement: '018f0000-0000-7000-8000-0000000000c3',
  barcode: '018f0000-0000-7000-8000-0000000000c4',
  price: '018f0000-0000-7000-8000-0000000000c5',
} as const;

/** Tables that are global by design (ADR-0004), plus Prisma's own ledger. */
const NOT_TENANT_OWNED = ['permissions', 'global_catalog_items', '_prisma_migrations'];

describe.skipIf(url === '')('tenant isolation, live', () => {
  let client: pg.Client;

  /** Run work with the tenant context set exactly as withTenant() does. */
  async function asTenant<T>(tenant: string, work: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, TRUE)", [tenant]);
    try {
      return await work();
    } finally {
      await client.query('COMMIT');
    }
  }

  /**
   * A statement expected to fail, run in its own transaction.
   *
   * A failed statement aborts the surrounding transaction, so each attempt is
   * isolated — otherwise the first expected rejection would poison every
   * assertion after it.
   */
  async function rejected(tenant: string, sql: string, values: unknown[] = []): Promise<string> {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, TRUE)", [tenant]);
    try {
      await client.query(sql, values);
      await client.query('ROLLBACK');
      return '';
    } catch (error) {
      await client.query('ROLLBACK');
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function removeTenant(tenant: string): Promise<void> {
    await asTenant(tenant, async () => {
      await client.query('DELETE FROM "tenants" WHERE "id" = $1', [tenant]);
    });
  }

  /** Everything one tenant needs before a sale can exist. */
  async function seed(t: Readonly<Record<keyof typeof A, string>>, slug: string): Promise<void> {
    await asTenant(t.tenant, async () => {
      await client.query(
        `INSERT INTO "tenants" ("id","name","slug","status","activatedAt","updatedAt")
         VALUES ($1,$2,$3,'active', now(), now())`,
        [t.tenant, `Tenant ${slug}`, slug],
      );
      await client.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
         VALUES ($1,$2,'01','الفرع', now())`,
        [t.branch, t.tenant],
      );
      await client.query(
        `INSERT INTO "users" ("id","tenantId","email","displayName","updatedAt")
         VALUES ($1,$2,$3,'كاشير', now())`,
        [t.user, t.tenant, `cashier@${slug}.test`],
      );
      await client.query(
        `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
         VALUES ($1,$2,$3,'T1','صندوق', now())`,
        [t.terminal, t.tenant, t.branch],
      );
      await client.query(
        `INSERT INTO "shifts" ("id","tenantId","branchId","terminalId","userId","openingFloatMinor","openedAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,20000, now(), now())`,
        [t.shift, t.tenant, t.branch, t.terminal, t.user],
      );
      await client.query(
        `INSERT INTO "customers" ("id","tenantId","nameAr","updatedAt")
         VALUES ($1,$2,'عميل', now())`,
        [t.customer, t.tenant],
      );
      await client.query(
        `INSERT INTO "categories" ("id","tenantId","nameAr","updatedAt")
         VALUES ($1,$2,'ألبان', now())`,
        [t.category, t.tenant],
      );
      await client.query(
        `INSERT INTO "products" ("id","tenantId","categoryId","sku","nameAr","priceMinor","vatBasisPoints","updatedAt")
         VALUES ($1,$2,$3,$4,'حليب',1150,1500, now())`,
        [t.product, t.tenant, t.category, `SKU-${slug}`],
      );
    });
  }

  /**
   * A sale whose figures satisfy every reconciliation constraint.
   *
   * The receipt sequence is a parameter because it is unique per branch: two
   * attempts sharing one would collide on that key first, and the assertion
   * would then be reading the wrong rejection.
   */
  function saleSql(): string {
    return `INSERT INTO "sales"
      ("id","tenantId","branchId","terminalId","shiftId","userId","customerId","operationId",
       "sequence","priceMode","grossMinor","lineDiscountMinor","basketDiscountMinor",
       "netMinor","vatMinor","totalMinor","tenderedMinor","changeMinor","issuedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'tax-inclusive',1150,0,0,1000,150,1150,1150,0, now())`;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();

    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await seed(A, 'rls-live-a');
    await seed(B, 'rls-live-b');

    // The positive path, created once and asserted by its own test below.
    await asTenant(A.tenant, async () => {
      await client.query(saleSql(), [
        A.sale,
        A.tenant,
        A.branch,
        A.terminal,
        A.shift,
        A.user,
        A.customer,
        'op-live-a',
        1,
      ]);
      await client.query(
        `INSERT INTO "sale_lines"
          ("id","tenantId","saleId","productId","lineNumber","sku","nameAr",
           "unitPriceMinor","vatBasisPoints","quantityScaled",
           "grossMinor","lineDiscountMinor","basketDiscountMinor","netMinor","vatMinor","totalMinor")
         VALUES ($1,$2,$3,$4,1,'SKU-rls-live-a','حليب',1150,1500,1000,1150,0,0,1000,150,1150)`,
        [A.saleLine, A.tenant, A.sale, A.product],
      );
    });
  });

  afterAll(async () => {
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await client.end();
  });

  // -------------------------------------------------------------------------
  // Row-level security
  // -------------------------------------------------------------------------

  it('is not running as a superuser, which would bypass every policy', async () => {
    const result = await client.query<{ usesuper: boolean }>(
      'SELECT usesuper FROM pg_user WHERE usename = current_user',
    );
    expect(result.rows[0]?.usesuper).toBe(false);
  });

  it('enables and forces RLS on every tenant-owned table', async () => {
    const result = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );

    const tenantOwned = result.rows.filter((row) => !NOT_TENANT_OWNED.includes(row.relname));
    expect(tenantOwned.length).toBeGreaterThanOrEqual(30);

    for (const row of tenantOwned) {
      expect(row.relrowsecurity, `${row.relname} has RLS disabled`).toBe(true);
      // Without FORCE the owner ignores every policy, and the application role
      // owns these tables.
      expect(row.relforcerowsecurity, `${row.relname} does not force RLS`).toBe(true);
    }
  });

  it('gives every tenant-owned table a policy with both USING and WITH CHECK', async () => {
    const result = await client.query<{
      tablename: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(`SELECT tablename, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public'`);

    const covered = new Set(result.rows.map((row) => row.tablename));
    expect(covered.size).toBeGreaterThanOrEqual(30);

    for (const row of result.rows) {
      expect(row.qual, `${row.tablename} policy has no USING`).not.toBeNull();
      // A FOR SELECT policy cannot carry WITH CHECK, and does not need one:
      // PostgreSQL never consults it for a write. Everything else must.
      if (row.cmd === 'SELECT') continue;
      expect(row.with_check, `${row.tablename} policy has no WITH CHECK`).not.toBeNull();
    }

    for (const table of NOT_TENANT_OWNED) {
      expect(covered.has(table)).toBe(false);
    }
  });

  it('shows a tenant only its own rows', async () => {
    const seen = await asTenant(A.tenant, async () => {
      const result = await client.query<{ id: string }>('SELECT "id" FROM "products"');
      return result.rows.map((row) => row.id);
    });
    expect(seen).toContain(A.product);
    expect(seen).not.toContain(B.product);
  });

  it('returns nothing for another tenant’s row, even asked for by primary key', async () => {
    const rows = await asTenant(A.tenant, async () => {
      const result = await client.query('SELECT "id" FROM "products" WHERE "id" = $1', [B.product]);
      return result.rowCount;
    });
    expect(rows).toBe(0);
  });

  it('shows nothing at all with no tenant context', async () => {
    // A request that forgot to establish context sees an empty database, not
    // everybody's data. Deny by default.
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', '', TRUE)");
    const result = await client.query('SELECT "id" FROM "products"');
    await client.query('COMMIT');
    expect(result.rowCount).toBe(0);
  });

  it('refuses an insert that names another tenant', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "products" ("id","tenantId","sku","nameAr","priceMinor","vatBasisPoints","updatedAt")
       VALUES ($1,$2,'X-1','منتج',100,1500, now())`,
      [SCRATCH.sale, B.tenant],
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses to reassign a visible row to another tenant', async () => {
    // This is the one USING alone would allow: the row is visible, so the
    // UPDATE matches, and without WITH CHECK the new tenantId is accepted.
    const message = await rejected(
      A.tenant,
      'UPDATE "products" SET "tenantId" = $1 WHERE "id" = $2',
      [B.tenant, A.product],
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('cannot delete another tenant’s row', async () => {
    const deleted = await asTenant(A.tenant, async () => {
      const result = await client.query('DELETE FROM "products" WHERE "id" = $1', [B.product]);
      return result.rowCount;
    });
    expect(deleted).toBe(0);

    const survived = await asTenant(B.tenant, async () => {
      const result = await client.query('SELECT "id" FROM "products" WHERE "id" = $1', [B.product]);
      return result.rowCount;
    });
    expect(survived).toBe(1);
  });

  it('applies the same rule to the tenants table itself', async () => {
    const rows = await asTenant(A.tenant, async () => {
      const result = await client.query<{ id: string }>('SELECT "id" FROM "tenants"');
      return result.rows.map((row) => row.id);
    });
    expect(rows).toEqual([A.tenant]);
  });

  it('leaves the global catalogue readable without a tenant', async () => {
    // Shared reference data. Readable with no context is the intended
    // behaviour, not an oversight (ADR-0004).
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', '', TRUE)");
    const result = await client.query('SELECT count(*)::int AS n FROM "global_catalog_items"');
    await client.query('COMMIT');
    expect(result.rowCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Tenant-consistent foreign keys
  // -------------------------------------------------------------------------
  //
  // Every attempt below is a row that RLS is perfectly happy with: correct
  // tenantId, visible to the tenant making it, passing every policy. The only
  // thing wrong is what it points at. If a plain foreign key to parent(id)
  // were still in place, every one of these would succeed.

  it('accepts a sale whose every reference belongs to the same tenant', async () => {
    const sale = await asTenant(A.tenant, async () => {
      const result = await client.query<{
        branchId: string;
        terminalId: string;
        shiftId: string;
        userId: string;
        customerId: string;
      }>(
        'SELECT "branchId","terminalId","shiftId","userId","customerId" FROM "sales" WHERE "id" = $1',
        [A.sale],
      );
      return result.rows[0];
    });

    expect(sale).toEqual({
      branchId: A.branch,
      terminalId: A.terminal,
      shiftId: A.shift,
      userId: A.user,
      customerId: A.customer,
    });

    const line = await asTenant(A.tenant, async () => {
      const result = await client.query<{ productId: string }>(
        'SELECT "productId" FROM "sale_lines" WHERE "id" = $1',
        [A.saleLine],
      );
      return result.rows[0]?.productId;
    });
    expect(line).toBe(A.product);
  });

  it('refuses a sale that names another tenant’s branch', async () => {
    const message = await rejected(A.tenant, saleSql(), [
      SCRATCH.sale,
      A.tenant,
      B.branch,
      A.terminal,
      A.shift,
      A.user,
      null,
      'op-cross-branch',
      2,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_branchId_fkey"/);
  });

  it('refuses a sale that names another tenant’s terminal', async () => {
    const message = await rejected(A.tenant, saleSql(), [
      SCRATCH.sale,
      A.tenant,
      A.branch,
      B.terminal,
      A.shift,
      A.user,
      null,
      'op-cross-terminal',
      3,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_terminalId_fkey"/);
  });

  it('refuses a sale that names another tenant’s shift', async () => {
    const message = await rejected(A.tenant, saleSql(), [
      SCRATCH.sale,
      A.tenant,
      A.branch,
      A.terminal,
      B.shift,
      A.user,
      null,
      'op-cross-shift',
      4,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_shiftId_fkey"/);
  });

  it('refuses a sale that names another tenant’s user', async () => {
    const message = await rejected(A.tenant, saleSql(), [
      SCRATCH.sale,
      A.tenant,
      A.branch,
      A.terminal,
      A.shift,
      B.user,
      null,
      'op-cross-user',
      5,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_userId_fkey"/);
  });

  it('refuses a sale that names another tenant’s customer', async () => {
    const message = await rejected(A.tenant, saleSql(), [
      SCRATCH.sale,
      A.tenant,
      A.branch,
      A.terminal,
      A.shift,
      A.user,
      B.customer,
      'op-cross-customer',
      6,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_customerId_fkey"/);
  });

  it('refuses a sale line that names another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "sale_lines"
        ("id","tenantId","saleId","productId","lineNumber","sku","nameAr",
         "unitPriceMinor","vatBasisPoints","quantityScaled",
         "grossMinor","lineDiscountMinor","basketDiscountMinor","netMinor","vatMinor","totalMinor")
       VALUES ($1,$2,$3,$4,2,'X','منتج',1150,1500,1000,1150,0,0,1000,150,1150)`,
      [SCRATCH.saleLine, A.tenant, A.sale, B.product],
    );
    expect(message).toMatch(/foreign key constraint "sale_lines_tenantId_productId_fkey"/);
  });

  it('refuses a sale line attached to another tenant’s sale', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "sale_lines"
        ("id","tenantId","saleId","productId","lineNumber","sku","nameAr",
         "unitPriceMinor","vatBasisPoints","quantityScaled",
         "grossMinor","lineDiscountMinor","basketDiscountMinor","netMinor","vatMinor","totalMinor")
       VALUES ($1,$2,$3,$4,3,'X','منتج',1150,1500,1000,1150,0,0,1000,150,1150)`,
      [SCRATCH.saleLine, A.tenant, B.sale, A.product],
    );
    expect(message).toMatch(/foreign key constraint "sale_lines_tenantId_saleId_fkey"/);
  });

  it('refuses an inventory balance on another tenant’s branch', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "inventory_balances" ("tenantId","branchId","productId","quantityScaled","updatedAt")
       VALUES ($1,$2,$3,1000, now())`,
      [A.tenant, B.branch, A.product],
    );
    expect(message).toMatch(/foreign key constraint "inventory_balances_tenantId_branchId_fkey"/);
  });

  it('refuses an inventory balance on another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "inventory_balances" ("tenantId","branchId","productId","quantityScaled","updatedAt")
       VALUES ($1,$2,$3,1000, now())`,
      [A.tenant, A.branch, B.product],
    );
    expect(message).toMatch(/foreign key constraint "inventory_balances_tenantId_productId_fkey"/);
  });

  it('refuses an inventory movement on another tenant’s branch', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "inventory_movements" ("id","tenantId","branchId","productId","kind","quantityScaled","occurredAt")
       VALUES ($1,$2,$3,$4,'adjustment',-1000, now())`,
      [SCRATCH.movement, A.tenant, B.branch, A.product],
    );
    expect(message).toMatch(/foreign key constraint "inventory_movements_tenantId_branchId_fkey"/);
  });

  it('refuses an inventory movement on another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "inventory_movements" ("id","tenantId","branchId","productId","kind","quantityScaled","occurredAt")
       VALUES ($1,$2,$3,$4,'adjustment',-1000, now())`,
      [SCRATCH.movement, A.tenant, A.branch, B.product],
    );
    expect(message).toMatch(/foreign key constraint "inventory_movements_tenantId_productId_fkey"/);
  });

  it('refuses a barcode attached to another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "product_barcodes" ("id","tenantId","productId","barcode")
       VALUES ($1,$2,$3,'6281000000009')`,
      [SCRATCH.barcode, A.tenant, B.product],
    );
    expect(message).toMatch(/foreign key constraint "product_barcodes_tenantId_productId_fkey"/);
  });

  it('refuses a price row attached to another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "product_prices" ("id","tenantId","productId","priceMinor","vatBasisPoints","effectiveFrom")
       VALUES ($1,$2,$3,1200,1500, now())`,
      [SCRATCH.price, A.tenant, B.product],
    );
    expect(message).toMatch(/foreign key constraint "product_prices_tenantId_productId_fkey"/);
  });

  it('refuses a terminal placed in another tenant’s branch', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
       VALUES ($1,$2,$3,'T9','صندوق', now())`,
      [SCRATCH.movement, A.tenant, B.branch],
    );
    expect(message).toMatch(/foreign key constraint "terminals_tenantId_branchId_fkey"/);
  });

  it('refuses a product filed under another tenant’s category', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "products" ("id","tenantId","categoryId","sku","nameAr","priceMinor","vatBasisPoints","updatedAt")
       VALUES ($1,$2,$3,'SKU-X','منتج',1150,1500, now())`,
      [SCRATCH.price, A.tenant, B.category],
    );
    expect(message).toMatch(/foreign key constraint "products_tenantId_categoryId_fkey"/);
  });

  it('refuses an UPDATE that repoints a valid reference at another tenant', async () => {
    // The insert-time check is the obvious half. Without the same key on
    // UPDATE, a row could be created correctly and then walked across the
    // boundary afterwards.
    const message = await rejected(A.tenant, 'UPDATE "sales" SET "branchId" = $1 WHERE "id" = $2', [
      B.branch,
      A.sale,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_branchId_fkey"/);

    const unchanged = await asTenant(A.tenant, async () => {
      const result = await client.query<{ branchId: string }>(
        'SELECT "branchId" FROM "sales" WHERE "id" = $1',
        [A.sale],
      );
      return result.rows[0]?.branchId;
    });
    expect(unchanged).toBe(A.branch);
  });

  it('refuses an UPDATE that repoints a sale line at another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      'UPDATE "sale_lines" SET "productId" = $1 WHERE "id" = $2',
      [B.product, A.saleLine],
    );
    expect(message).toMatch(/foreign key constraint "sale_lines_tenantId_productId_fkey"/);
  });

  it('carries a composite key on every reference between tenant-owned tables', async () => {
    // Read from the catalogue rather than the migration file: this is what the
    // server actually has, whatever any file says.
    const result = await client.query<{
      conname: string;
      child: string;
      parent: string;
      cols: number;
    }>(
      `SELECT c.conname,
              ch.relname AS child,
              pa.relname AS parent,
              array_length(c.conkey, 1) AS cols
         FROM pg_constraint c
         JOIN pg_class ch ON ch.oid = c.conrelid
         JOIN pg_class pa ON pa.oid = c.confrelid
         JOIN pg_namespace n ON n.oid = ch.relnamespace
        WHERE c.contype = 'f' AND n.nspname = 'public'`,
    );

    const global = ['tenants', 'permissions', 'global_catalog_items'];
    const betweenTenantTables = result.rows.filter((row) => !global.includes(row.parent));
    expect(betweenTenantTables.length).toBeGreaterThanOrEqual(30);

    for (const row of betweenTenantTables) {
      expect(row.cols, `${row.conname} references ${row.parent} by one column`).toBe(2);
    }
  });

  it('still lets a tenant be deleted whole, cascading through every table', async () => {
    // The refusing action is NO ACTION rather than RESTRICT precisely so this
    // works: the referencing rows disappear in the same statement, so the
    // check at end of statement finds nothing dangling.
    const scratch = '018f0000-0000-7000-8000-0000000000d0';
    const scratchBranch = '018f0000-0000-7000-8000-0000000000d1';
    await asTenant(scratch, async () => {
      await client.query(
        `INSERT INTO "tenants" ("id","name","slug","status","activatedAt","updatedAt")
         VALUES ($1,'Scratch','rls-live-scratch','active', now(), now())`,
        [scratch],
      );
      await client.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
         VALUES ($1,$2,'01','فرع', now())`,
        [scratchBranch, scratch],
      );
      await client.query(
        `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
         VALUES ($1,$2,$3,'T1','صندوق', now())`,
        ['018f0000-0000-7000-8000-0000000000d2', scratch, scratchBranch],
      );
    });

    const removed = await asTenant(scratch, async () => {
      const result = await client.query('DELETE FROM "tenants" WHERE "id" = $1', [scratch]);
      return result.rowCount;
    });
    expect(removed).toBe(1);
  });

  it('has no drift between the migration and the Prisma schema', async () => {
    // The composite keys are hand-written SQL. If Prisma's model of them ever
    // disagrees with the database, the next `prisma migrate dev` silently
    // proposes to undo them.
    const databaseDir = join(here, '../..');
    const output = execFileSync(
      'npx',
      [
        '--no-install',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
      ],
      { cwd: databaseDir, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
    );
    expect(output).toContain('No difference detected');
  }, 120_000);
});

describe.skipIf(url !== '')('tenant isolation, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    // Stated rather than silent: a suite that quietly runs nothing looks
    // exactly like a suite that passed.
    expect(url).toBe('');
  });
});
