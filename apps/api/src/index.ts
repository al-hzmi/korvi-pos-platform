import { installGracefulShutdown } from './runtime/shutdown.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function start(): Promise<void> {
  const config = loadConfig();
  const app = buildServer(config);
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  installGracefulShutdown(app);
}

void start().catch(() => {
  // Startup errors may include host/database details. The operator gets a
  // stable failure signal without serialising raw driver/configuration errors.
  console.error('Korvi API startup failed. Check runtime configuration and dependencies.');
  process.exitCode = 1;
});
