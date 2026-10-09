import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * The 5A permission backfill, rehearsed as an upgrade on a real server.
 *
 * A fresh database has no tenants when this migration runs, so applying every
 * migration in order proves the SQL parses and proves nothing at all about what
 * it does to merchants who already exist. Provisioning a tenant *after* the
 * migration proves the canonical role map — the future-tenant half of the
 * contract — and is likewise silent about the backfill.
 *
 * The backfill is the interesting half, because it is the one that can silently
 * do nothing: `roles` and `role_permissions` are both under FORCE ROW LEVEL
 * SECURITY, the migration runs as the table owner, and with no `app.tenant_id`
 * set every row is invisible. A migration that granted the permission to nobody
 * would report success exactly as loudly as one that worked.
 *
 * So this suite builds the pre-5A schema, seeds a legacy tenant with real
 * roles, proves the permission is absent, applies the actual migration file,
 * and then reads the grants back.
 *
 * A scratch schema rather than a scratch database, because the application role
 * deliberately has no CREATEDB privilege and this suite refuses to escalate to
 * get one. Everything below runs as that same non-superuser, NOBYPASSRLS role,
 * including the migration itself — which is the only way the FORCE-lifted
 * backfill inside it is honestly exercised.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', '..', 'prisma', 'migrations');

/** Everything that existed before Strike 5A, in order. */
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
] as const;

const STOCK_LEDGER = '20260827120000_inventory_stock_ledger';
const SCHEMA = 'korvi_rehearsal_5a';
const PERMISSION = 'inventory.transfer';

const TENANT = '018f5b00-0000-7000-8000-00000000001a';
const ROLES = [
  ['018f5b00-0000-7000-8000-0000000000a1', 'owner', true],
  ['018f5b00-0000-7000-8000-0000000000a2', 'admin', true],
  ['018f5b00-0000-7000-8000-0000000000a3', 'manager', true],
  ['018f5b00-0000-7000-8000-0000000000a4', 'cashier', true],
  // A merchant's own role. Korvi never widens one of these on their behalf.
  ['018f5b00-0000-7000-8000-0000000000a5', 'floor-supervisor', false],
] as const;

function sqlOf(migration: string): string {
  return readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8');
}

/**
 * Split a migration file into the statements a runner would send one at a time.
 *
 * Deliberately not clever, and deliberately not used on the earlier migrations,
 * which contain `$$`-quoted function bodies this would mangle. The 5A migration
 * contains no dollar quoting and no semicolon inside any literal, so stripping
 * line comments and splitting on `;` reproduces exactly what psql or a
 * per-statement runner would do.
 *
 * Executing the file this way is the point rather than an implementation
 * detail: a multi-statement string sent as one simple query gets an implicit
 * transaction from libpq, which would hide whether the file's own BEGIN is
 * doing the work. One statement at a time, the only transaction is the one the
 * migration opens for itself — which is what makes the NO FORCE window inside
 * it a real window rather than a hypothetical one.
 */
function statementsOf(sql: string): readonly string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

describe.skipIf(url === '')('pre-5A inventory permission migration rehearsal, live', () => {
  let client: pg.Client;

  /** Inside the tenant's own RLS context, because these tables FORCE it. */
  async function inTenant<T>(work: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT]);
    try {
      const value = await work();
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async function grantedRoleKeys(): Promise<readonly string[]> {
    return inTenant(async () => {
      const { rows } = await client.query<{ key: string }>(
        `SELECT r."key"
           FROM "role_permissions" rp
           JOIN "roles" r ON r."tenantId" = rp."tenantId" AND r."id" = rp."roleId"
          WHERE rp."permissionKey" = $1
          ORDER BY r."key"`,
        [PERMISSION],
      );
      return rows.map((row) => row.key);
    });
  }

  async function forceStateOf(table: string): Promise<{ enabled: boolean; forced: boolean }> {
    const { rows } = await client.query<{ enabled: boolean; forced: boolean }>(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND n.nspname = $2`,
      [table, SCHEMA],
    );
    const state = rows[0];
    if (state === undefined) throw new Error(`no ${table} table in ${SCHEMA}`);
    return state;
  }

  let beforeKeys: readonly string[] = [];
  let beforeCatalogue = 0;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();

    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    // Every unqualified name in every migration now resolves here, including
    // the tenant-context functions the policies bind to.
    await client.query(`SET search_path TO ${SCHEMA}`);
    for (const migration of BEFORE) await client.query(sqlOf(migration));

    // A merchant who already existed when 5A shipped, with the roles
    // provisioning would have given them and one of their own.
    await inTenant(async () => {
      // `activatedAt` is required of a `recorded` active tenant by the 4A
      // lifecycle constraint, so this merchant is admitted properly rather
      // than inserted into a state the schema already refuses.
      await client.query(
        `INSERT INTO "tenants" ("id","name","slug","status","lifecycleProvenance","activatedAt","updatedAt")
         VALUES ($1, $2, $3, 'active', 'recorded', now(), now())`,
        [TENANT, 'متجر قديم', 'rehearsal-5a-legacy'],
      );
      for (const [id, key, isSystem] of ROLES) {
        await client.query(
          `INSERT INTO "roles" ("id","tenantId","key","nameAr","maxDiscountBasisPoints","isSystem","updatedAt")
           VALUES ($1, $2, $3, $4, 0, $5, now())`,
          [id, TENANT, key, key, isSystem],
        );
      }
    });

    const { rows: catalogue } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "permissions" WHERE "key" = $1`,
      [PERMISSION],
    );
    beforeCatalogue = Number(catalogue[0]?.count ?? '0');
    beforeKeys = await grantedRoleKeys();

    // One statement at a time, so the transaction under test is the one the
    // migration file opens for itself.
    for (const statement of statementsOf(sqlOf(STOCK_LEDGER))) await client.query(statement);
  }, 180_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it('had neither the permission nor any grant of it before the migration', () => {
    // Measured before the migration ran, so the assertions below are about
    // something the migration did rather than something that was always true.
    expect(beforeCatalogue).toBe(0);
    expect(beforeKeys).toEqual([]);
  });

  it('grants it to exactly the system manager, admin and owner roles', async () => {
    expect(await grantedRoleKeys()).toEqual(['admin', 'manager', 'owner']);
  });

  it('grants it to no cashier and to no custom role', async () => {
    const keys = await grantedRoleKeys();
    // Cashier is excluded because the canonical map excludes it; the custom
    // role is excluded because it is the merchant's label, not Korvi's
    // authority, and widening it is an administrator's decision.
    expect(keys).not.toContain('cashier');
    expect(keys).not.toContain('floor-supervisor');

    const grantedToNonSystem = await inTenant(async () => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM "role_permissions" rp
           JOIN "roles" r ON r."tenantId" = rp."tenantId" AND r."id" = rp."roleId"
          WHERE rp."permissionKey" = $1 AND r."isSystem" = FALSE`,
        [PERMISSION],
      );
      return Number(rows[0]?.count ?? '0');
    });
    expect(grantedToNonSystem).toBe(0);
  });

  it('installs the catalogue row exactly once', async () => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "permissions" WHERE "key" = $1`,
      [PERMISSION],
    );
    expect(Number(rows[0]?.count ?? '0')).toBe(1);
  });

  it('mints UUIDv7 ids for the rows it backfilled', async () => {
    const ids = await inTenant(async () => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT rp."id"::text AS id FROM "role_permissions" rp WHERE rp."permissionKey" = $1`,
        [PERMISSION],
      );
      return rows.map((row) => row.id);
    });
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      // Version nibble is the first character of the third group, and the
      // variant nibble the first of the fourth. UUIDv7 per ADR-0003, built
      // from core functions with no extension and no permanent function.
      expect(id[14], id).toBe('7');
      expect(['8', '9', 'a', 'b'], id).toContain(id[19]);
    }
    // Distinct, and therefore not a constant somebody hard-coded.
    expect(new Set(ids).size).toBe(3);
  });

  it('leaves FORCE row level security restored on both tables it lifted', async () => {
    // The migration turns FORCE off to reach rows its own RLS would hide, and
    // turns it back on before COMMIT. If it ever failed to, every later tenant
    // read of these tables would be unprotected against the owner role.
    for (const table of ['roles', 'role_permissions']) {
      const state = await forceStateOf(table);
      expect(state.enabled, table).toBe(true);
      expect(state.forced, table).toBe(true);
    }
  });

  it('restored isolation in practice, not merely in the catalogue', async () => {
    // With no tenant context the policies must hide everything, which is the
    // behaviour FORCE exists to produce for the table's owner.
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', '', true)");
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "role_permissions"`,
    );
    await client.query('COMMIT');
    expect(Number(rows[0]?.count ?? '-1')).toBe(0);
  });
});

describe.skipIf(url !== '')('pre-5A inventory permission migration rehearsal, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
