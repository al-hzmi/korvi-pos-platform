import { createPrismaClient } from '@korvi/database';
import { loadConfig } from './config.js';
import { prepareApplicationDatabase } from './runtime/database-startup.js';
import { registerOperationalReadiness } from './runtime/readiness.js';
import { installGracefulShutdown } from './runtime/shutdown.js';
import { buildServer } from './server.js';

async function start(): Promise<void> {
  const config = loadConfig();
  const databaseUrl = config.DATABASE_URL;

  // A configured database is admitted before any network listener exists.
  // Production first proves the exact migrations, restricted runtime role and
  // FORCE-RLS contract, then every database-backed boot idempotently installs
  // Korvi's global permission vocabulary. Tenant provisioning therefore cannot
  // race a fresh deployment whose permission catalogue has not been installed.
  if (databaseUrl !== undefined) {
    const prisma = createPrismaClient(databaseUrl);
    try {
      await prepareApplicationDatabase(prisma, config);
    } finally {
      await prisma.$disconnect();
    }
  } else if (config.isProduction) {
    // `loadConfig` already rejects this shape. Keep the executable boundary
    // defensive so a hand-built production config can never skip DB admission.
    throw new Error('Production database preflight requires DATABASE_URL.');
  }

  const app = buildServer(config);
  registerOperationalReadiness(app, config);
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  installGracefulShutdown(app);
}

void start().catch(() => {
  // Startup/database/driver errors can contain infrastructure details and raw
  // connection strings. Keep them out of logs; operators get a stable refusal
  // and inspect provider-side configuration/evidence separately.
  console.error(
    'API startup refused. Check production configuration, database role, migrations, RLS and listener availability.',
  );
  process.exitCode = 1;
});
