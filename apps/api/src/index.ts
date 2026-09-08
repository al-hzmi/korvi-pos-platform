import { loadConfig } from './config.js';
import { createGracefulShutdown } from './runtime/shutdown.js';
import { buildServer } from './server.js';

async function start(): Promise<void> {
  const config = loadConfig();
  const app = buildServer(config);
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });

  const stop = createGracefulShutdown(app);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

void start().catch(() => {
  // Startup errors may contain provider or connection details. Keep the public
  // process message generic; deployment logs around the failing precondition
  // identify the stage without echoing credentials.
  console.error('Korvi API startup refused. Check configuration and runtime dependencies.');
  process.exitCode = 1;
});
