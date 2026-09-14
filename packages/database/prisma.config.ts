import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved connection settings out of schema.prisma. The migration path
 * is explicit because checked-in migrations contain reviewed database objects
 * that are intentionally absent from the merchant Prisma Client (for example,
 * control-plane-only raw tables). A dedicated shadow database is supplied by
 * migration proof/deployment environments when migration history must be
 * replayed for drift detection.
 */
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL?.trim();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: env('DATABASE_URL'),
    ...(shadowDatabaseUrl === undefined || shadowDatabaseUrl === ''
      ? {}
      : { shadowDatabaseUrl }),
  },
});
