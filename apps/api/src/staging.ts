import { createPrismaClient } from '@korvi/database';
import { createGracefulShutdown } from './runtime/shutdown.js';
import { buildServer } from './server.js';
import { loadStagingConfig } from './staging/config.js';
import { verifyStagingDatabase } from './staging/preflight.js';

/** Separate entrypoint: ordinary development startup is unaffected. */
async function start(): Promise<void> {
  const config = loadStagingConfig(process.env);
  const prisma = createPrismaClient(config.DATABASE_URL ?? '');
  try {
    await verifyStagingDatabase(prisma);
  } finally {
    await prisma.$disconnect();
  }

  const app = buildServer(config);
  await app.listen({ host: '0.0.0.0', port: config.API_PORT });

  const stop = createGracefulShutdown(app);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

void start().catch(() => {
  // Driver errors can contain connection details. Never print the raw error.
  console.error('Staging startup refused. Check configuration, database role, migrations and RLS.');
  process.exitCode = 1;
});
