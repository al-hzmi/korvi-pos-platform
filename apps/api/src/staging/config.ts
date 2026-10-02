import { loadConfig } from '../config.js';
import type { ApiConfig } from '../config.js';

/** A test deployment keeps production cookies and all production boot invariants. */
export function loadStagingConfig(env: NodeJS.ProcessEnv): ApiConfig {
  if (env['KORVI_ENVIRONMENT'] !== 'staging' || env['NODE_ENV'] !== 'production') {
    throw new Error('Staging requires KORVI_ENVIRONMENT=staging and NODE_ENV=production.');
  }
  const config = loadConfig({ ...env, API_PORT: env['PORT'] ?? env['API_PORT'] ?? '3001' });
  if (config.API_PORT > 65535) throw new Error('Staging port is out of range.');
  return { ...config, checkoutFiscalizationMode: 'simulation' };
}
