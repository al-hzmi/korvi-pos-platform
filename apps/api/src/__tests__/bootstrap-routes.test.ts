import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { registerBootstrapRoutes } from '../routes/bootstrap.js';
import type { ProvisionOwner } from '../services/bootstrap.js';

const TOKEN = 'capability.token';
const PASSWORD = 'a password long enough';
const ORIGIN = 'https://pos.example.test';

function ownerService(): ProvisionOwner {
  return vi.fn(async () => ({
    tenantId: '019bd055-99b7-75a3-a25f-634247303298',
    userId: '019bd055-99b7-77c8-83c6-7c9500ba8622',
  }));
}

let app: ReturnType<typeof Fastify> | undefined;

function build(signingKey: string | null = 'k'.repeat(40), provisionOwner = ownerService()) {
  app = Fastify({ logger: false });
  registerBootstrapRoutes(app, { signingKey, provisionOwner });
  return provisionOwner;
}

async function post(body: unknown) {
  if (!app) throw new Error('call build() first');
  return app.inject({ method: 'POST', url: '/v1/bootstrap/owner', payload: body });
}

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe('the public bootstrap door', () => {
  it('accepts a token and a password, and returns no session', async () => {
    const provisionOwner = build();
    const response = await post({ token: TOKEN, password: PASSWORD });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({
      tenantId: '019bd055-99b7-75a3-a25f-634247303298',
      userId: '019bd055-99b7-77c8-83c6-7c9500ba8622',
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(provisionOwner).toHaveBeenCalledWith({ token: TOKEN, password: PASSWORD });
  });

  it('refuses a body that names authority, and says which field', async () => {
    const provisionOwner = build();
    const response = await post({ token: TOKEN, password: PASSWORD, role: 'admin' });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request', field: 'role' });
    expect(provisionOwner).not.toHaveBeenCalled();
  });

  it('refuses a body that is not two fields', async () => {
    const provisionOwner = build();
    const response = await post({ token: TOKEN });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request', field: 'password' });
    expect(provisionOwner).not.toHaveBeenCalled();
  });

  it('gives one answer to every capability it will not honour', async () => {
    for (const failure of [
      new Error('bootstrap_invalid_capability'),
      new Error('bootstrap_expired_capability'),
      new Error('bootstrap_replayed_capability'),
    ]) {
      const provisionOwner = vi.fn(async () => {
        throw failure;
      });
      build('k'.repeat(40), provisionOwner);
      const response = await post({ token: TOKEN, password: PASSWORD });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: 'invalid_capability' });
      expect(provisionOwner).toHaveBeenCalledOnce();
      if (app) await app.close();
      app = undefined;
    }
  });

  it('answers a weak password separately, because it is about the caller', async () => {
    const provisionOwner = vi.fn(async () => {
      throw new Error('weak_password');
    });
    build('k'.repeat(40), provisionOwner);
    const response = await post({ token: TOKEN, password: 'weak' });

    // The route rejects the password before the service sees the capability.
    // That is safe: password weakness is derived solely from caller-controlled
    // input, and the service checks it *before* the capability, so it reveals
    // nothing about whether the token would have been honoured.
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'weak_password' });
  });

  it('answers 503 when the deployment has no signing key', async () => {
    build(null);
    const response = await post({ token: TOKEN, password: PASSWORD });
    // An operator's problem stated as one, rather than a door served without a
    // lock or a refusal that reads like a bad capability.
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'unavailable' });
  });
});

describe('the signing key as configuration', () => {
  it('is optional outside production and demanded in it', () => {
    const key = 'k'.repeat(40);
    const metricsToken = 'm'.repeat(40);
    expect(loadConfig({ NODE_ENV: 'test' }).BOOTSTRAP_SIGNING_KEY).toBeUndefined();
    expect(loadConfig({ NODE_ENV: 'test', BOOTSTRAP_SIGNING_KEY: key }).BOOTSTRAP_SIGNING_KEY).toBe(
      key,
    );

    // Production without one refuses to boot, rather than serving the route
    // unsigned or discovering the gap on the first invitation.
    expect(() => loadConfig({ NODE_ENV: 'production', APP_ORIGINS: ORIGIN })).toThrow(
      /BOOTSTRAP_SIGNING_KEY/,
    );
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        APP_ORIGINS: ORIGIN,
        BOOTSTRAP_SIGNING_KEY: key,
        METRICS_AUTH_TOKEN: metricsToken,
      }),
    ).not.toThrow();
  });

  it('refuses a key short enough to guess', () => {
    // A floor at boot, not a hope at review.
    expect(() => loadConfig({ NODE_ENV: 'test', BOOTSTRAP_SIGNING_KEY: 'short' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test', BOOTSTRAP_SIGNING_KEY: 'k'.repeat(31) })).toThrow();
    expect(() =>
      loadConfig({ NODE_ENV: 'test', BOOTSTRAP_SIGNING_KEY: 'k'.repeat(32) }),
    ).not.toThrow();
  });
});
