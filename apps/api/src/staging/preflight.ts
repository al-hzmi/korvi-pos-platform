import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { PrismaClient, TransactionClient } from '@korvi/database';

export interface MigrationEvidence {
  readonly name: string;
  readonly checksum: string;
}

export interface DeploymentManifest {
  readonly migrations: readonly MigrationEvidence[];
  readonly tables: readonly string[];
}

export interface DatabaseEvidence {
  readonly major: number;
  readonly unsafeRole: boolean;
  readonly inheritedRoles: number;
  readonly tenantContext: string;
  readonly loginContext: string;
  readonly tables: readonly {
    readonly name: string;
    readonly enabled: boolean;
    readonly forced: boolean;
    readonly policies: number;
  }[];
  readonly migrations: readonly (MigrationEvidence & { readonly complete: boolean })[];
}

const GLOBAL_TABLES = new Set(['global_catalog_items', 'permissions', '_prisma_migrations']);

/**
 * Control-plane-owned tables intentionally kept outside the merchant Prisma
 * model. They remain part of the exact deployment contract and are still
 * required to carry FORCE RLS and at least one policy.
 */
const CONTROL_PLANE_TABLES = ['platform_support_notes'] as const;

/**
 * Tenant tables whose authority intentionally lives in SQL migrations and raw
 * transactional repositories instead of the generated Prisma model. They are
 * still first-class deployment tables and must pass the same exact-table and
 * FORCE-RLS admission checks as Prisma-mapped tenant tables.
 */
const MIGRATION_OWNED_TENANT_TABLES = [
  'zatca_seller_fiscal_profiles',
  'zatca_terminal_fiscal_chains',
  'zatca_invoice_fiscalizations',
] as const;

/** Read-only deployment guard; this never repairs, migrates, grants or seeds. */
export function assertDatabaseEvidence(
  actual: DatabaseEvidence,
  expected: DeploymentManifest,
): void {
  if (actual.major !== 17) throw new Error('Deployment requires the verified PostgreSQL major 17.');
  if (actual.unsafeRole || actual.inheritedRoles !== 0) {
    throw new Error('Deployment requires a restricted application role without role memberships.');
  }
  if (actual.tenantContext !== '' || actual.loginContext !== '') {
    throw new Error('Deployment refuses a connection with a persistent tenant or login context.');
  }
  if (expected.migrations.length === 0 || expected.tables.length === 0) {
    throw new Error('Deployment manifest is empty.');
  }
  const migrationMap = new Map(actual.migrations.map((row) => [row.name, row]));
  if (
    actual.migrations.length !== expected.migrations.length ||
    migrationMap.size !== actual.migrations.length ||
    expected.migrations.some((row) => {
      const found = migrationMap.get(row.name);
      return !found?.complete || found.checksum !== row.checksum;
    })
  ) {
    throw new Error('Database migrations do not match this deployment.');
  }
  const tables = new Map(actual.tables.map((table) => [table.name, table]));
  const expectedTables = [...expected.tables, '_prisma_migrations'];
  if (tables.size !== expectedTables.length || expectedTables.some((name) => !tables.has(name))) {
    throw new Error('Database tables do not match this deployment.');
  }
  for (const table of actual.tables) {
    if (!GLOBAL_TABLES.has(table.name) && (!table.enabled || !table.forced || table.policies < 1)) {
      throw new Error('A tenant table lacks ENABLE/FORCE RLS or an isolation policy.');
    }
  }
}

/** Source and compiled entrypoints keep the same directory depth. */
export async function readDeploymentManifest(): Promise<DeploymentManifest> {
  const root = new URL('../../../../packages/database/prisma/', import.meta.url);
  const migrationRoot = new URL('migrations/', root);
  const directories = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migrations = await Promise.all(
    directories.map(async (name) => ({
      name,
      checksum: createHash('sha256')
        .update(await readFile(new URL(`${name}/migration.sql`, migrationRoot)))
        .digest('hex'),
    })),
  );
  const schema = await readFile(new URL('schema.prisma', root), 'utf8');
  const merchantTables = [...schema.matchAll(/@@map\("([a-z_]+)"\)/g)].map(
    (match) => match[1] ?? '',
  );
  const tables = [
    ...merchantTables,
    ...CONTROL_PLANE_TABLES,
    ...MIGRATION_OWNED_TENANT_TABLES,
  ];
  return { migrations, tables };
}

async function inspectDatabase(tx: TransactionClient): Promise<DatabaseEvidence> {
  const roles = await tx.$queryRaw<
    {
      major: number;
      unsafeRole: boolean;
      inheritedRoles: number;
      tenantContext: string;
      loginContext: string;
    }[]
  >`
    SELECT current_setting('server_version_num')::integer / 10000 AS major,
      (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole
        OR r.rolreplication OR r.rolinherit) AS "unsafeRole",
      (SELECT count(*)::integer FROM pg_auth_members WHERE member = r.oid) AS "inheritedRoles",
      coalesce(current_setting('app.tenant_id', true), '') AS "tenantContext",
      coalesce(current_setting('app.login_tenant_slug', true), '') AS "loginContext"
    FROM pg_roles r WHERE r.rolname = current_user
  `;
  const role = roles[0];
  if (role === undefined) throw new Error('Cannot verify database role.');
  const tables = await tx.$queryRaw<DatabaseEvidence['tables']>`
    SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
      (SELECT count(*)::integer FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  `;
  const migrations = await tx.$queryRaw<DatabaseEvidence['migrations']>`
    SELECT migration_name AS name, checksum,
      (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS complete
    FROM public._prisma_migrations
  `;
  return { ...role, tables, migrations };
}

/**
 * Exact-release database admission guard for every deployed runtime.
 *
 * The guard is deliberately read-only. Migration application belongs to the
 * controlled deployment step; this function only proves that the runtime is
 * about to serve against the exact checked-in ledger/schema, a restricted
 * application role, clean tenant context and FORCE-RLS protected tenant tables.
 */
export async function verifyDeploymentDatabase(prisma: PrismaClient): Promise<void> {
  const expected = await readDeploymentManifest();
  await prisma.$transaction(
    async (tx) => assertDatabaseEvidence(await inspectDatabase(tx), expected),
    { isolationLevel: 'RepeatableRead', maxWait: 10_000, timeout: 15_000 },
  );
}

/** Compatibility name retained for the isolated staging entrypoint. */
export const verifyStagingDatabase = verifyDeploymentDatabase;
