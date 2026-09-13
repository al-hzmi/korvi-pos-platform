import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { derivePsqlUrl } from './deploy/derive-psql-url.mjs';

const migrationScriptUrl = new URL('./deploy/production-migrate.sh', import.meta.url);
const postgresWorkflowUrl = new URL(
  '../.github/workflows/strike-5c-postgres-live.yml',
  import.meta.url,
);
const runtimeConfigUrl = new URL('../apps/api/src/config.ts', import.meta.url);

const [migrationScript, postgresWorkflow, runtimeConfig] = await Promise.all([
  readFile(migrationScriptUrl, 'utf8'),
  readFile(postgresWorkflowUrl, 'utf8'),
  readFile(runtimeConfigUrl, 'utf8'),
]);

assert.ok(
  migrationScript.includes('[ "${NODE_ENV:-}" = \'production\' ]'),
  'production migration must refuse non-production NODE_ENV',
);
assert.ok(
  migrationScript.includes('[ "${KORVI_ENVIRONMENT:-}" = \'production\' ]'),
  'production migration must require the explicit production deployment marker',
);
assert.ok(
  migrationScript.includes('MIGRATION_DATABASE_URL is required'),
  'production migration must require a migration-only database credential',
);
assert.ok(
  migrationScript.includes('PRODUCTION_RUNTIME_DB_ROLE is required'),
  'production migration must bind grants to an explicit runtime role',
);
assert.match(
  migrationScript,
  /\^\[a-z_\]\[a-z0-9_\]\{0,62\}\$/,
  'runtime role interpolation must be restricted to canonical PostgreSQL identifiers',
);
assert.ok(
  migrationScript.includes('[ "$migration_user" != "$runtime_role" ]'),
  'migration authority and runtime authority must be distinct roles',
);
assert.ok(
  migrationScript.includes('migration role must be a dedicated non-superuser'),
  'migration authority itself must be restricted rather than using a provider administrator',
);
assert.ok(
  migrationScript.includes('f|f|f|f|f|f|0'),
  'migration and runtime roles must prove no privileged flags or inherited memberships',
);
assert.ok(
  migrationScript.includes('node scripts/deploy/derive-psql-url.mjs'),
  'production migration must derive the psql URL without weakening transport parameters',
);
assert.doesNotMatch(
  migrationScript,
  /MIGRATION_DATABASE_URL%%.*\\\?/, 
  'production migration must never drop the entire query string because it can contain TLS policy',
);

const derivedPsqlUrl = derivePsqlUrl(
  'postgresql://korvi_migrator:p%40ss@db.example:5432/korvi?schema=merchant&connection_limit=5&sslmode=verify-full&sslrootcert=%2Fcerts%2Fca.pem&application_name=korvi-migrate',
);
const parsedPsqlUrl = new URL(derivedPsqlUrl);
assert.equal(
  parsedPsqlUrl.searchParams.has('schema'),
  false,
  'psql URL derivation must remove Prisma-only schema selection',
);
assert.equal(
  parsedPsqlUrl.searchParams.has('connection_limit'),
  false,
  'psql URL derivation must remove Prisma-only pool controls',
);
assert.equal(
  parsedPsqlUrl.searchParams.get('sslmode'),
  'verify-full',
  'psql URL derivation must preserve sslmode rather than silently weakening TLS',
);
assert.equal(
  parsedPsqlUrl.searchParams.get('sslrootcert'),
  '/certs/ca.pem',
  'psql URL derivation must preserve certificate trust configuration',
);
assert.equal(
  parsedPsqlUrl.searchParams.get('application_name'),
  'korvi-migrate',
  'psql URL derivation must preserve libpq-compatible observability parameters',
);
assert.match(
  derivedPsqlUrl,
  /^postgresql:\/\/korvi_migrator:p%40ss@db\.example:5432\/korvi\?/,
  'psql URL derivation must preserve endpoint and encoded credentials',
);
assert.throws(
  () => derivePsqlUrl('https://db.example/korvi?sslmode=verify-full'),
  /must use the postgresql protocol/,
  'psql URL derivation must reject non-PostgreSQL protocols',
);

assert.ok(
  migrationScript.includes('bash scripts/prove-migration-state.sh'),
  'production migration must use the source-driven exact migration proof',
);
assert.ok(
  migrationScript.indexOf('bash scripts/prove-migration-state.sh') <
    migrationScript.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES'),
  'migration/schema proof must finish before runtime privileges are refreshed',
);
assert.ok(
  migrationScript.includes('REVOKE TEMPORARY ON DATABASE :"database_name" FROM PUBLIC'),
  'PUBLIC must not silently restore temporary-table authority to runtime',
);
assert.ok(
  migrationScript.includes('REVOKE CREATE ON SCHEMA public FROM PUBLIC'),
  'PUBLIC must not silently restore schema-creation authority to runtime',
);
assert.ok(
  migrationScript.includes('REVOKE CREATE ON SCHEMA public'),
  'runtime must not retain schema-creation authority',
);
assert.ok(
  migrationScript.includes('REVOKE TEMPORARY ON DATABASE'),
  'runtime must not retain temporary-table authority without a demonstrated requirement',
);
assert.match(
  migrationScript,
  /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]*_prisma_migrations/,
  'runtime must be unable to mutate the Prisma migration ledger',
);
assert.ok(
  migrationScript.includes('runtime role must not own public tables'),
  'production migration must prove runtime is not a table owner',
);
assert.ok(
  migrationScript.includes('t|f|t|f|t|f|f|f'),
  'production migration must re-prove its runtime privilege boundary after grants',
);

assert.ok(
  postgresWorkflow.includes('MIGRATION_DATABASE_URL: postgresql://korvi_migrator:'),
  'PostgreSQL live proof must use a dedicated restricted migration identity',
);
assert.ok(
  postgresWorkflow.includes('KORVI_TEST_DATABASE_URL: postgresql://korvi_runtime:'),
  'PostgreSQL live proof must execute application tests with a restricted runtime identity',
);
assert.ok(
  postgresWorkflow.includes('CREATE ROLE korvi_migrator'),
  'PostgreSQL live proof must create a restricted migration identity',
);
assert.ok(
  postgresWorkflow.includes('ALTER DATABASE korvi_5c OWNER TO korvi_migrator'),
  'PostgreSQL live proof must bind database ownership to the migration identity',
);
assert.ok(
  postgresWorkflow.includes('PRODUCTION_RUNTIME_DB_ROLE: korvi_runtime'),
  'PostgreSQL live proof must bind grants to its runtime identity',
);
assert.ok(
  postgresWorkflow.includes('bash scripts/deploy/production-migrate.sh'),
  'PostgreSQL live proof must exercise the real production migration authority script',
);
assert.ok(
  postgresWorkflow.includes('Run every live proof as the restricted runtime role'),
  'all live application proofs must execute after dropping to runtime authority',
);
assert.ok(
  postgresWorkflow.includes('migration_runtime_identity_separation=PASS'),
  'proof log must record successful authority separation',
);
assert.ok(
  postgresWorkflow.includes('restricted_migration_authority=PASS'),
  'proof log must record that migration authority is itself restricted',
);
assert.ok(
  postgresWorkflow.includes('runtime_migration_ledger_write=DENIED'),
  'proof log must record migration-ledger write denial',
);

assert.doesNotMatch(
  runtimeConfig,
  /MIGRATION_DATABASE_URL|PRODUCTION_RUNTIME_DB_ROLE/,
  'API runtime configuration must never accept migration-plane credentials or role authority',
);

console.log(
  '[ok] production migration contract: restricted migrator, TLS-safe URL derivation, isolated authority, non-owner runtime, immutable migration ledger',
);
