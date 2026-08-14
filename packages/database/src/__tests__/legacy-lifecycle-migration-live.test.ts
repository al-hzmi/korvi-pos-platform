import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * The upgrade path, rehearsed on a real PostgreSQL server.
 *
 * A fresh database has no tenants when the lifecycle migration runs, so
 * applying every migration in order proves the migration parses and proves
 * nothing whatever about what it does to existing merchants. The interesting
 * questions are the two a fresh database cannot ask: what happens to rows that
 * were already there, and what happens if the migration fails half-way.
 *
 * The second matters more than it looks. Between `NO FORCE ROW LEVEL SECURITY`
 * and the statement that restores it, `tenants` is a table whose row-level
 * security does not apply to its owner. The migration owns an explicit
 * transaction so that state can never be committed — and the failure rehearsal
 * below is what turns that sentence from a comment into a fact.
 *
 * A scratch schema rather than a scratch database, because the application role
 * deliberately has no CREATEDB privilege and this suite refuses to escalate to
 * get one. Everything below runs as that same non-superuser, NOBYPASSRLS role,
 * including the migration itself — which is the only way the FORCE-lifted
 * backfill inside it is being honestly exercised.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', '..', 'prisma', 'migrations');

/** Everything that existed before Strike 4A, in order. */
const BEFORE = [
  '00000000000000_rls_foundation',
  '20260808120000_saas_foundation',
  '20260810120000_auth_security',
  '20260816120000_commercial_settlement',
  '20260822120000_returns_refunds',
  '20260823120000_shift_reconciliation',
] as const;

const LIFECYCLE = '20260824120000_tenant_lifecycle';

/** The successful upgrade, and the one that fails half-way. Never shared. */
const UPGRADE_SCHEMA = 'korvi_rehearsal_4a';
const FAILURE_SCHEMA = 'korvi_rehearsal_4a_fault';

/** One id per legacy shape, so a surprising row is recognisable. */
const TRADING = '018f4a00-0000-7000-8000-00000000001a';
const STOPPED = '018f4a00-0000-7000-8000-00000000002a';
const UNKNOWN = '018f4a00-0000-7000-8000-00000000003a';

const LEGACY_SEED = [
  [TRADING, 'rehearsal-trading', 'active'],
  [STOPPED, 'rehearsal-stopped', 'suspended'],
  [UNKNOWN, 'rehearsal-unknown', 'closed'],
] as const;

interface LegacyRow {
  status: string;
  lifecycleProvenance: string;
  activatedAt: Date | null;
  suspendedAt: Date | null;
  suspensionReason: string | null;
}

function sqlOf(migration: string): string {
  return readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8');
}

/**
 * Split a migration file into the statements a runner would send one at a
 * time.
 *
 * Deliberately not clever, and deliberately not used on the pre-4A migrations,
 * which contain `$$`-quoted function bodies this would mangle. The lifecycle
 * migration contains no dollar quoting and no semicolon inside any literal, so
 * stripping line comments and splitting on `;` reproduces exactly what psql or
 * a per-statement runner would do.
 *
 * Executing the file this way is the point rather than an implementation
 * detail: a multi-statement string sent as one simple query gets an implicit
 * transaction from libpq, which would hide whether the file's own BEGIN is
 * doing the work. One statement at a time, the only transaction is the one the
 * migration opens for itself.
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

async function seedLegacy(client: pg.Client): Promise<void> {
  for (const [id, slug, status] of LEGACY_SEED) {
    // Under its own RLS context, because `tenants` has carried FORCE ROW LEVEL
    // SECURITY since the very first migration and the owner is not exempt.
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
    await client.query(
      `INSERT INTO "tenants" ("id","name","slug","status","updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [id, `Legacy ${slug}`, slug, status],
    );
    await client.query('COMMIT');
  }
}

async function buildPre4a(client: pg.Client, schema: string): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  // Every unqualified name in every migration now resolves here, including the
  // tenant-context functions the policies bind to.
  await client.query(`SET search_path TO ${schema}`);
  for (const migration of BEFORE) await client.query(sqlOf(migration));
  await seedLegacy(client);
}

async function forceState(
  client: pg.Client,
  schema: string,
): Promise<{ enabled: boolean; forced: boolean }> {
  const { rows } = await client.query<{ enabled: boolean; forced: boolean }>(
    `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'tenants' AND n.nspname = $1`,
    [schema],
  );
  const state = rows[0];
  if (state === undefined) throw new Error(`no tenants table in ${schema}`);
  return state;
}

describe.skipIf(url === '')('pre-4A lifecycle migration rehearsal, live', () => {
  let client: pg.Client;

  async function read(id: string): Promise<LegacyRow> {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
    const { rows } = await client.query<LegacyRow>(
      `SELECT "status","lifecycleProvenance","activatedAt","suspendedAt","suspensionReason"
         FROM "tenants" WHERE "id" = $1`,
      [id],
    );
    await client.query('COMMIT');
    const row = rows[0];
    if (row === undefined) throw new Error(`tenant ${id} vanished during the rehearsal`);
    return row;
  }

  async function refused(work: () => Promise<unknown>): Promise<string> {
    try {
      await work();
    } catch (error) {
      await client.query('ROLLBACK');
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected the database to refuse that, and it did not');
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await buildPre4a(client, UPGRADE_SCHEMA);
    // One statement at a time, so the transaction under test is the one the
    // migration file opens for itself.
    for (const statement of statementsOf(sqlOf(LIFECYCLE))) await client.query(statement);
  }, 180_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${UPGRADE_SCHEMA} CASCADE`);
    await client.end();
  });

  it('leaves a trading merchant trading, and admits nothing about when', async () => {
    const row = await read(TRADING);
    expect(row.status).toBe('active');
    expect(row.lifecycleProvenance).toBe('legacy');
    // `createdAt` is when the row was made, not when anybody decided to admit
    // this merchant. The honest value is nothing at all.
    expect(row.activatedAt).toBeNull();
    expect(row.suspendedAt).toBeNull();
    expect(row.suspensionReason).toBeNull();
  });

  it('leaves an already-stopped merchant stopped, and invents no reason', async () => {
    const row = await read(STOPPED);
    expect(row.status).toBe('suspended');
    expect(row.lifecycleProvenance).toBe('legacy');
    // The two facts a suspension is made of are unknown for this row, and
    // `updatedAt` — the tempting substitute — is when the row last changed for
    // any reason at all.
    expect(row.suspendedAt).toBeNull();
    expect(row.suspensionReason).toBeNull();
    expect(row.activatedAt).toBeNull();
  });

  it('fails an uninterpretable status closed, and records only what it did', async () => {
    const row = await read(UNKNOWN);
    // Not active. A row whose state cannot be read must not be one that trades.
    expect(row.status).toBe('suspended');
    expect(row.lifecycleProvenance).toBe('legacy');
    // This suspension *did* happen, now, and the migration is the thing that
    // did it — so the time and the reason are true statements about a Korvi
    // action rather than guesses about the merchant's past.
    expect(row.suspendedAt).not.toBeNull();
    expect(row.suspensionReason).toContain('4A lifecycle migration');
    expect(row.suspensionReason).toContain('closed');
    expect((row.suspensionReason ?? '').length).toBeLessThanOrEqual(200);
    // And it still claims nothing about admission.
    expect(row.activatedAt).toBeNull();
  });

  it('restores FORCE row level security after its own backfill', async () => {
    expect(await forceState(client, UPGRADE_SCHEMA)).toEqual({ enabled: true, forced: true });

    // And the role that ran the migration is one the policies actually apply
    // to. Without this the assertion above would be describing a table nobody
    // is subject to.
    const { rows: role } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    // The isolation policy survived untouched: with no context, nothing.
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', '', true)");
    const { rows: invisible } = await client.query('SELECT "id" FROM "tenants"');
    await client.query('COMMIT');
    expect(invisible).toEqual([]);
  });

  it('leaves the new invariants enforced against the legacy rows', async () => {
    // A legacy row is permitted to say "unknown". It is not permitted to say
    // half of a suspension.
    const half = await refused(async () => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [STOPPED]);
      await client.query(`UPDATE "tenants" SET "suspendedAt" = now() WHERE "id" = $1`, [STOPPED]);
      await client.query('COMMIT');
    });
    expect(half).toMatch(/tenants_suspension_evidence_paired/);

    // And no legacy row may be moved to a status this code cannot read.
    const unknown = await refused(async () => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [TRADING]);
      await client.query(`UPDATE "tenants" SET "status" = 'dormant' WHERE "id" = $1`, [TRADING]);
      await client.query('COMMIT');
    });
    expect(unknown).toMatch(/tenants_status_known/);

    // A tenant provisioned from here on gets the strict rules in full: this one
    // claims to be admitted without saying when, and is refused — the exemption
    // is for inherited history, not for new carelessness.
    const strict = await refused(async () => {
      const scratch = '018f4a00-0000-7000-8000-00000000004a';
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scratch]);
      await client.query(
        `INSERT INTO "tenants" ("id","name","slug","status","updatedAt")
         VALUES ($1, 'Fresh', 'rehearsal-fresh', 'active', now())`,
        [scratch],
      );
      await client.query('COMMIT');
    });
    expect(strict).toMatch(/tenants_recorded_lifecycle_complete/);
  });

  it('changes the default for new rows only', async () => {
    const scratch = '018f4a00-0000-7000-8000-00000000005a';
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scratch]);
    const { rows } = await client.query<{ status: string; lifecycleProvenance: string }>(
      `INSERT INTO "tenants" ("id","name","slug","updatedAt")
       VALUES ($1, 'Fresh', 'rehearsal-default', now())
       RETURNING "status", "lifecycleProvenance"`,
      [scratch],
    );
    await client.query('ROLLBACK');
    expect(rows[0]).toEqual({ status: 'provisioning', lifecycleProvenance: 'recorded' });

    // Which is the whole compatibility argument: the default moved, and the
    // merchant who was trading before it moved is still trading.
    expect((await read(TRADING)).status).toBe('active');
  });
});

/**
 * The same migration, interrupted at its most dangerous moment.
 *
 * The fault is injected between `NO FORCE ROW LEVEL SECURITY` and the statement
 * that restores it, after the legacy backfill has already written rows — the
 * one window in which the table's security boundary is weakened and there is
 * work in flight to lose. Nothing in the migration or in production code is
 * edited to make this happen: the file's own statements are executed in order
 * and one extra failing statement is spliced in by the test.
 *
 * What must survive the failure is not the migration. It is the boundary.
 */
describe.skipIf(url === '')('interrupted lifecycle migration, live', () => {
  let client: pg.Client;

  /** True while the fault was in flight, so the assertions can be believed. */
  let forcedDuringMigration: boolean | null = null;
  let backfilledDuringMigration: number | null = null;
  let failure = '';

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await buildPre4a(client, FAILURE_SCHEMA);

    const statements = statementsOf(sqlOf(LIFECYCLE));
    const restore = statements.findIndex(
      (statement) => statement === 'ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY',
    );
    const lift = statements.findIndex(
      (statement) => statement === 'ALTER TABLE "tenants" NO FORCE ROW LEVEL SECURITY',
    );
    if (lift < 0 || restore < 0 || restore <= lift) {
      throw new Error('the lifecycle migration no longer lifts and restores FORCE in that order');
    }

    try {
      // Everything up to but not including the FORCE restoration.
      for (const statement of statements.slice(0, restore)) await client.query(statement);

      // Proof that the fault below lands in the dangerous window rather than
      // somewhere harmless: right now, inside the migration's own transaction,
      // the table's owner is not subject to its policies and the backfill has
      // already run.
      forcedDuringMigration = (await forceState(client, FAILURE_SCHEMA)).forced;
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "tenants" WHERE "lifecycleProvenance" = 'legacy'`,
      );
      backfilledDuringMigration = Number(rows[0]?.n ?? '0');

      // The fault. A statement the migration does not contain, chosen because
      // it fails for a reason that has nothing to do with the schema.
      await client.query('SELECT 1 / 0');
      throw new Error('the injected fault did not fail');
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    // What a runner does when a migration statement fails.
    await client.query('ROLLBACK');
  }, 180_000);

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${FAILURE_SCHEMA} CASCADE`);
    await client.end();
  });

  it('failed inside the window where FORCE was lifted and rows had been written', () => {
    expect(failure).toMatch(/division by zero/i);
    // Not a claim about the file's ordering — a reading taken from pg_class
    // while the transaction was open.
    expect(forcedDuringMigration).toBe(false);
    expect(backfilledDuringMigration).toBe(LEGACY_SEED.length);
  });

  it('leaves FORCE row level security on, because the weakened state never committed', async () => {
    expect(await forceState(client, FAILURE_SCHEMA)).toEqual({ enabled: true, forced: true });
  });

  it('leaves no lifecycle schema behind to be mistaken for an applied migration', async () => {
    const { rows: columns } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'tenants'`,
      [FAILURE_SCHEMA],
    );
    const names = columns.map((column) => column.column_name);
    for (const added of [
      'lifecycleProvenance',
      'activatedAt',
      'suspendedAt',
      'suspensionReason',
      'provisioningOperationId',
      'provisioningRequestHash',
    ]) {
      expect(names).not.toContain(added);
    }

    const { rows: constraints } = await client.query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'tenants' AND n.nspname = $1`,
      [FAILURE_SCHEMA],
    );
    expect(constraints.map((constraint) => constraint.conname)).not.toContain(
      'tenants_status_known',
    );

    const { rows: indexes } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'tenants'`,
      [FAILURE_SCHEMA],
    );
    expect(indexes.map((index) => index.indexname)).not.toContain(
      'tenants_provisioningOperationId_key',
    );

    // Including the one change that would be invisible in a column list: the
    // new-row default did not move either.
    const { rows: fallback } = await client.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'tenants' AND column_name = 'status'`,
      [FAILURE_SCHEMA],
    );
    expect(fallback[0]?.column_default).toContain('active');
  });

  it('leaves every legacy tenant exactly as it was before the migration ran', async () => {
    for (const [id, slug, status] of LEGACY_SEED) {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      const { rows } = await client.query<{ name: string; slug: string; status: string }>(
        `SELECT "name","slug","status" FROM "tenants" WHERE "id" = $1`,
        [id],
      );
      await client.query('COMMIT');
      // `closed` is still `closed`: the backfill that would have re-stated it
      // went with the transaction that failed.
      expect(rows[0]).toEqual({ name: `Legacy ${slug}`, slug, status });
    }
  });

  it('can then be applied cleanly, the failure having left nothing in the way', async () => {
    for (const statement of statementsOf(sqlOf(LIFECYCLE))) await client.query(statement);

    expect(await forceState(client, FAILURE_SCHEMA)).toEqual({ enabled: true, forced: true });

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [UNKNOWN]);
    const { rows } = await client.query<{ status: string; lifecycleProvenance: string }>(
      `SELECT "status","lifecycleProvenance" FROM "tenants" WHERE "id" = $1`,
      [UNKNOWN],
    );
    await client.query('COMMIT');
    expect(rows[0]).toEqual({ status: 'suspended', lifecycleProvenance: 'legacy' });
  }, 120_000);
});

describe.skipIf(url !== '')('pre-4A lifecycle migration rehearsal, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
