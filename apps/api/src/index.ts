import { loadConfig } from './config.js';
import { registerOperationalReadiness } from './runtime/readiness.js';
import { installGracefulShutdown } from './runtime/shutdown.js';
import { buildServer } from './server.js';

const config = loadConfig();
const app = buildServer(config);
registerOperationalReadiness(app, config);

void app
  .listen({ port: config.API_PORT, host: '0.0.0.0' })
  .then(() => {
    installGracefulShutdown(app);
  })
  .catch(() => {
    // Listener errors are operator diagnostics. Keep raw adapter/socket detail
    // out of logs because future transports can carry credential-bearing URLs.
    app.log.error('API startup refused. Check configuration and listener availability.');
    process.exit(1);
  });
