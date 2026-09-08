import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { registerOperationalReadiness } from '../runtime/readiness.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl === undefined ? describe.skip : describe;

live('operational readiness against PostgreSQL', () => {
  it('admits traffic only after a real database round trip', async () => {
    const app = Fastify({ logger: false });
    registerOperationalReadiness(
      app,
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl }),
    );

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    await app.close();
  });
});
