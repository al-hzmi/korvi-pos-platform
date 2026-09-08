import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import {
  registerOperationalReadiness,
  type ReadinessProbe,
} from '../runtime/readiness.js';

function probe(check: ReadinessProbe['check']): ReadinessProbe {
  return { check, close: vi.fn(async () => undefined) };
}

describe('operational readiness', () => {
  it(
    'keeps a missing database configuration out of rotation without affecting process liveness',
    async () => {
      const app = Fastify({ logger: false });
      registerOperationalReadiness(app, loadConfig({ NODE_ENV: 'test' }));

      const response = await app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'not_ready' });
      await app.close();
    },
  );

  it('returns ready only after the dependency probe succeeds', async () => {
    const app = Fastify({ logger: false });
    const readiness = probe(async () => true);
    registerOperationalReadiness(app, loadConfig({ NODE_ENV: 'test' }), { probe: readiness });

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });

    await app.close();
    expect(readiness.close).toHaveBeenCalledTimes(1);
  });

  it('fails closed and does not expose a dependency exception', async () => {
    const app = Fastify({ logger: false });
    const readiness = probe(async () => {
      throw new Error('postgres://operator:secret@example.invalid/korvi');
    });
    registerOperationalReadiness(app, loadConfig({ NODE_ENV: 'test' }), { probe: readiness });

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"status":"not_ready"}');
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('postgres://');

    await app.close();
  });
});
