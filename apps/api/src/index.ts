import { createPrismaClient } from '@korvi/database';
import { loadConfig } from './config.js';
import { registerOperationalReadiness } from './runtime/readiness.js';
import { installGracefulShutdown } from './runtime/shutdown.js';
import { buildServer } from './server.js';
import { verifyDeploymentDatabase } from './staging/preflight.js';

async function start(): Promise<void> {
  const config = loadConfig();

  // Production must never advertise a listener merely because PostgreSQL is
  // reachable. Before accepting traffic, prove that the configured runtime role
  // is restricted, the exact checked-in migration ledger/schema is present,
  // tenant context is clean and every tenant table is FORCE-RLS protected.
  // Migration application remains a separate controlled deployment concern.
  if (config.isProduction) {
    const databaseUrl = config.DATABASE_URL;
    if (databaseUrl === undefined) {
      throw new Error('Production database preflight requires DATABASE_URL.');
    }
    const prisma = createPrismaClient(databaseUrl);
    try {
      await verifyDeploymentDatabase(prisma);
    } finally {
      await prisma.$disconnect();
    }
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
