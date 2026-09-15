import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { registerOperationalObservability } from '../runtime/observability.js';

const METRICS_TOKEN = `observability-${'x'.repeat(48)}`;
const BOOTSTRAP_KEY = `bootstrap-${'y'.repeat(48)}`;
const REQUEST_COUNTER =
  'korvi_http_requests_total{method="GET",route="/v1/items/:itemId",status_class="2xx"} 1';
const DURATION_COUNT =
  'korvi_http_request_duration_seconds_count{method="GET",route="/v1/items/:itemId"} 1';
const NOT_READY_COUNTER = 'korvi_readiness_responses_total{result="not_ready"} 1';
const PRODUCTION_BASE = {
  NODE_ENV: 'production',
  APP_ORIGINS: 'https://pos.example',
  DATABASE_URL: 'postgresql://korvi_test@localhost:5432/korvi_test',
  BOOTSTRAP_SIGNING_KEY: BOOTSTRAP_KEY,
  OFFLINE_LEASE_SIGNING_SEED_B64: 'A'.repeat(43),
  OFFLINE_LEASE_KEY_ID: 'observability-test-v1',
} as const;

describe('production observability boundary', () => {
  it('requires a protected metrics credential in production configuration', () => {
    expect(() => loadConfig(PRODUCTION_BASE)).toThrow(/METRICS_AUTH_TOKEN/);
    expect(() => loadConfig({ ...PRODUCTION_BASE, METRICS_AUTH_TOKEN: 'too-short' })).toThrow(
      /METRICS_AUTH_TOKEN/,
    );

    const config = loadConfig({
      ...PRODUCTION_BASE,
      METRICS_AUTH_TOKEN: METRICS_TOKEN,
    });
    expect(config.METRICS_AUTH_TOKEN).toBe(METRICS_TOKEN);
  });

  it('does not echo a rejected metrics credential in configuration errors', () => {
    const rejected = 'recognizable-secret';
    expect(() => loadConfig({ ...PRODUCTION_BASE, METRICS_AUTH_TOKEN: rejected })).toThrow(
      /METRICS_AUTH_TOKEN/,
    );
    try {
      loadConfig({ ...PRODUCTION_BASE, METRICS_AUTH_TOKEN: rejected });
    } catch (error) {
      expect(String(error)).not.toContain(rejected);
    }
  });

  it('authenticates the scrape surface and emits no raw merchant URL values', async () => {
    const app = Fastify({ logger: false });
    registerOperationalObservability(
      app,
      loadConfig({ NODE_ENV: 'test', METRICS_AUTH_TOKEN: METRICS_TOKEN }),
    );
    app.get('/v1/items/:itemId', async () => ({ ok: true }));
    app.get('/ready', async (_request, reply) => reply.code(503).send({ status: 'not_ready' }));

    const business = await app.inject({ method: 'GET', url: '/v1/items/secret-merchant-row' });
    expect(business.statusCode).toBe(200);
    const readiness = await app.inject({ method: 'GET', url: '/ready' });
    expect(readiness.statusCode).toBe(503);

    const anonymous = await app.inject({ method: 'GET', url: '/metrics' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body).not.toContain(METRICS_TOKEN);

    const wrong = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer definitely-wrong' },
    });
    expect(wrong.statusCode).toBe(401);

    const metrics = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain(REQUEST_COUNTER);
    expect(metrics.body).toContain(DURATION_COUNT);
    expect(metrics.body).toContain(NOT_READY_COUNTER);
    expect(metrics.body).not.toContain('secret-merchant-row');
    expect(metrics.body).not.toContain(METRICS_TOKEN);

    await app.close();
  });

  it('omits the scrape route without observability credentials', async () => {
    const app = Fastify({ logger: false });
    registerOperationalObservability(app, loadConfig({ NODE_ENV: 'test' }));
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
