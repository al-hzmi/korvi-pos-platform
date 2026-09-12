import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { registerOperationalReadiness, type ReadinessProbe } from '../runtime/readiness.js';

function probe(check: ReadinessProbe['check']): ReadinessProbe {
  return { check, close: vi.fn(async () => undefined) };
}

describe('operational readiness', () => {
  it('fails closed when database configuration is missing', async () => {
    const app = Fastify({ logger: false });
    registerOperationalReadiness(app, loadConfig({ NODE_ENV: 'test' }));

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready' });
    await app.close();
  });

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
      throw new Error('driver failure: password=top-secret host=db.internal');
    });
    registerOperationalReadiness(app, loadConfig({ NODE_ENV: 'test' }), { probe: readiness });

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"status":"not_ready"}');
    expect(response.body).not.toContain('top-secret');
    expect(response.body).not.toContain('db.internal');

    await app.close();
  });

  it('fails closed within the configured deadline when the dependency probe stalls', async () => {
    const app = Fastify({ logger: false });
    const readiness = probe(() => new Promise<boolean>(() => undefined));
    registerOperationalReadiness(app, loadConfig({ NODE_ENV: 'test' }), {
      probe: readiness,
      timeoutMs: 15,
    });

    const startedAt = Date.now();
    const response = await app.inject({ method: 'GET', url: '/ready' });
    const elapsedMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready' });
    expect(elapsedMs).toBeLessThan(500);
    await app.close();
  });

  it('single-flights concurrent readiness requests through one dependency check', async () => {
    const app = Fastify({ logger: false });
    let release: ((value: boolean) => void) | undefined;
    const check = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const readiness = probe(check);
    registerOperationalReadiness(app, loadConfig({ NODE_ENV: 'test' }), {
      probe: readiness,
      timeoutMs: 500,
    });

    const first = app.inject({ method: 'GET', url: '/ready' });
    const second = app.inject({ method: 'GET', url: '/ready' });
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    release?.(true);

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(check).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('does not pile up new dependency work while a timed-out probe remains unresolved', async () => {
    const app = Fastify({ logger: false });
    let release: ((value: boolean) => void) | undefined;
    const check = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const readiness = probe(check);
    registerOperationalReadiness(app, loadConfig({ NODE_ENV: 'test' }), {
      probe: readiness,
      timeoutMs: 10,
    });

    const first = await app.inject({ method: 'GET', url: '/ready' });
    const second = await app.inject({ method: 'GET', url: '/ready' });
    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(503);
    expect(check).toHaveBeenCalledTimes(1);

    release?.(true);
    await Promise.resolve();
    await app.close();
  });

  it('rejects an invalid readiness deadline at registration time', async () => {
    const app = Fastify({ logger: false });
    expect(() =>
      registerOperationalReadiness(app, loadConfig({ NODE_ENV: 'test' }), {
        probe: probe(async () => true),
        timeoutMs: 0,
      }),
    ).toThrow('readiness timeoutMs must be a positive safe integer');
    await app.close();
  });
});
