import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config.js';
import { createGracefulShutdown } from '../runtime/shutdown.js';
import { buildServer } from '../server.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('operational health boundaries', () => {
  it('keeps liveness green while readiness is unavailable', async () => {
    const app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
      bootstrap: null,
      readiness: async () => false,
    });
    try {
      const liveness = await app.inject({ method: 'GET', url: '/health' });
      const readiness = await app.inject({ method: 'GET', url: '/ready' });
      expect(liveness.statusCode).toBe(200);
      expect(liveness.json()).toEqual({ status: 'ok' });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toEqual({ status: 'unavailable' });
    } finally {
      await app.close();
    }
  });

  it('reports ready only after a successful dependency probe', async () => {
    const app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
      bootstrap: null,
      readiness: async () => true,
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ready' });
    } finally {
      await app.close();
    }
  });

  it('fails readiness closed when the dependency probe throws', async () => {
    const app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
      bootstrap: null,
      readiness: async () => {
        throw new Error('synthetic database detail that must not escape');
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('synthetic database detail');
      expect(response.json()).toEqual({ status: 'unavailable' });
    } finally {
      await app.close();
    }
  });
});

describe('production configuration fail-closed rules', () => {
  const baseProduction = {
    NODE_ENV: 'production',
    APP_ORIGINS: 'https://pos.korvi.example',
    BOOTSTRAP_SIGNING_KEY: 'k'.repeat(64),
  } as const;

  it('refuses production without a runtime database', () => {
    expect(() => loadConfig(baseProduction)).toThrow(/DATABASE_URL/);
  });

  it('accepts production only when the required runtime authorities are present', () => {
    const config = loadConfig({
      ...baseProduction,
      DATABASE_URL: 'postgresql://korvi.example.invalid/korvi',
    });
    expect(config.isProduction).toBe(true);
    expect(config.DATABASE_URL).toContain('korvi.example.invalid');
  });

  it('refuses a port outside the TCP range before listen', () => {
    expect(() => loadConfig({ API_PORT: '65536' })).toThrow(/API_PORT/);
  });

  it('still permits a liveness-only development configuration', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).DATABASE_URL).toBeUndefined();
  });
});

describe('graceful shutdown', () => {
  it('drains Fastify once and exits zero on a clean close', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const app = { close } as unknown as FastifyInstance;
    const stop = createGracefulShutdown(app, exit, 60_000);

    stop();
    stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits one when Fastify close fails', async () => {
    const close = vi.fn().mockRejectedValue(new Error('close failed'));
    const exit = vi.fn();
    const app = { close } as unknown as FastifyInstance;
    createGracefulShutdown(app, exit, 60_000)();

    await Promise.resolve();
    await Promise.resolve();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('has a bounded hard deadline for a wedged close hook', async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const exit = vi.fn();
    const app = { close } as unknown as FastifyInstance;
    createGracefulShutdown(app, exit, 25_000)();

    await vi.advanceTimersByTimeAsync(25_000);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
