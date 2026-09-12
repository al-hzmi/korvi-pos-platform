import { loadConfig } from '../config.js';
import type { ApiConfig } from '../config.js';

/** A test deployment keeps production cookies and origin checks. */
export function loadStagingConfig(env: NodeJS.ProcessEnv): ApiConfig {
  if (env['KORVI_ENVIRONMENT'] !== 'staging' || env['NODE_ENV'] !== 'production') {
    throw new Error('Staging requires KORVI_ENVIRONMENT=staging and NODE_ENV=production.');
  }
  const config = loadConfig({ ...env, API_PORT: env['PORT'] ?? env['API_PORT'] ?? '3001' });
  if (config.DATABASE_URL === undefined) throw new Error('Staging requires DATABASE_URL.');
  if (config.API_PORT > 65535) throw new Error('Staging port is out of range.');
  for (const origin of config.APP_ORIGINS) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('Staging APP_ORIGINS must contain exact HTTPS origins.');
    }
    if (url.protocol !== 'https:' || url.origin !== origin) {
      throw new Error('Staging APP_ORIGINS must contain exact HTTPS origins.');
    }
  }
  return config;
}
