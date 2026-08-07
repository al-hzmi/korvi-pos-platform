import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved the connection URL out of schema.prisma. It lives here and is
 * read from the environment, so no credential is ever committed.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
});
