import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const app = buildServer(config);

app.listen({ port: config.API_PORT, host: '0.0.0.0' }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
