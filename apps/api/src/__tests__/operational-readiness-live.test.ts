import { expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildServer } from '../server.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

it.skipIf(url === '')('proves /ready through the restricted PostgreSQL application role', async () => {
  const app = buildServer(
    loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', DATABASE_URL: url }),
    { bootstrap: null },
  );
  try {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  } finally {
    await app.close();
  }
});
