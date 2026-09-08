import { loadConfig } from './config.js';
import { installGracefulShutdown } from './runtime/shutdown.js';
import { buildServer } from './server.js';

const config = loadConfig();
const app = buildServer(config);

void app
  .listen({ port: config.API_PORT, host: '0.0.0.0' })
  .then(() => {
    installGracefulShutdown(app);
  })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
