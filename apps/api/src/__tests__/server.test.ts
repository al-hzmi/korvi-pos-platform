import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';

describe('api', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the liveness probe', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports the phase', async () => {
    const response = await app.inject({ method: 'GET', url: '/version' });
    expect(response.json()).toMatchObject({ phase: 'foundation' });
  });
});

describe('config', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(3001);
  });

  it('rejects a nonsense port rather than booting on a guess', () => {
    expect(() => loadConfig({ API_PORT: 'not-a-port' })).toThrow(/Invalid environment/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(/Invalid environment/);
  });
});
