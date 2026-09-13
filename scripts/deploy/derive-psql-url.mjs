import { pathToFileURL } from 'node:url';

const prismaOnlySearchParameters = new Set([
  'schema',
  'connection_limit',
  'pool_timeout',
  'socket_timeout',
  'pgbouncer',
  'statement_cache_size',
]);

export function derivePsqlUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('migration database URL is not a valid URL');
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('migration database URL must use the postgresql protocol');
  }

  for (const parameter of prismaOnlySearchParameters) {
    url.searchParams.delete(parameter);
  }

  return url.toString();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = process.env.MIGRATION_DATABASE_URL;
  if (!value) {
    process.stderr.write('[x] migration database URL is missing\n');
    process.exit(64);
  }

  try {
    process.stdout.write(derivePsqlUrl(value));
  } catch (error) {
    process.stderr.write(`[x] ${error instanceof Error ? error.message : 'invalid migration database URL'}\n`);
    process.exit(65);
  }
}
