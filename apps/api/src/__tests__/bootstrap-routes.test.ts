import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerBootstrapRoutes } from '../routes/bootstrap.js';
import { loadConfig } from '../config.js';
import type { BootstrapResult, OwnerBootstrapService } from '../bootstrap/service.js';
import type { FastifyInstance } from 'fastify';

/**
 * The public bootstrap route, over a real Fastify instance.
 *
 * What is proved here is the shape of the door: that it accepts two fields and
 * refuses everything else by name, that every capability refusal is the same
 * bytes, and that a success hands back no session. Whether the capability is
 * genuinely single-use and transactional is a claim about PostgreSQL and is
 * proved in `owner-bootstrap-live.test.ts`.
 */

const ORIGIN = 'http://localhost:3000';
const TOKEN = 'v1.cGF5bG9hZA.c2lnbmF0dXJl';
const PASSWORD = 'a-real-password-9!';

let app: FastifyInstance;
let seen: { token: string; password: string }[];

function build(answer: BootstrapResult | null): FastifyInstance {
  seen = [];
  const service: OwnerBootstrapService | null =
    answer === null
      ? null
      : {
          accept: (token, password) => {
            seen.push({ token, password });
            return Promise.resolve(answer);
          },
        };

  const instance = Fastify({ logger: false });
  registerBootstrapRoutes(instance, { service });
  app = instance;
  return instance;
}

const post = (payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/bootstrap/owner',
    headers: { origin: ORIGIN },
    payload: payload as never,
  });

afterEach(async () => {
  await app.close();
});

describe('the public bootstrap door', () => {
  it('accepts a token and a password, and returns no session', async () => {
    build({ outcome: 'success' });
    const response = await post({ token: TOKEN, password: PASSWORD });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    // No cookie, no principal, no token echoed back. The new Owner logs in
    // through the normal path like everybody else.
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(seen).toEqual([{ token: TOKEN, password: PASSWORD }]);
  });

  it('refuses a body that names authority, and says which field', async () => {
    build({ outcome: 'success' });
    const attempts = [
      'tenantId',
      'tenantSlug',
      'userId',
      'roleId',
      'membershipId',
      'invitationId',
      'email',
      'displayName',
      'permissions',
      'controlPlaneActorRef',
      'expiresAt',
    ];

    for (const field of attempts) {
      const response = await post({ token: TOKEN, password: PASSWORD, [field]: 'anything' });
      expect(response.statusCode, field).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden_field', field });
    }
    // Not one of them reached the authority layer.
    expect(seen).toHaveLength(0);
  });

  it('refuses a body that is not two fields', async () => {
    build({ outcome: 'success' });
    for (const bad of [
      {},
      { token: TOKEN },
      { password: PASSWORD },
      { token: '', password: PASSWORD },
      { token: TOKEN, password: '' },
      { token: TOKEN, password: PASSWORD, surprise: true },
      { token: 'a'.repeat(2000), password: PASSWORD },
    ]) {
      expect((await post(bad)).statusCode).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it('gives one answer to every capability it will not honour', async () => {
    build({ outcome: 'failure', reason: 'invalid-capability' });
    const first = await post({ token: TOKEN, password: PASSWORD });
    const second = await post({ token: 'v1.b3RoZXI.c2ln', password: PASSWORD });

    expect(first.statusCode).toBe(403);
    expect(JSON.parse(first.body)).toEqual({ error: 'invalid_capability' });
    // Unknown, wrong tenant, consumed, expired, forged and already-established
    // all arrive here as the same reason and leave as the same bytes, so the
    // endpoint is not an oracle for which merchants exist.
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body);
    // And nothing about the merchant, the invitee or the tenant leaks out.
    expect(first.body).not.toMatch(/tenant|email|invitation|expired|consumed/i);
  });

  it('answers a weak password separately, because it is about the caller', async () => {
    build({ outcome: 'failure', reason: 'weak-password' });
    const response = await post({ token: TOKEN, password: 'short' });

    // 400 rather than the generic 403: this is a fact about the caller's own
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
      loadConfig({ NODE_ENV: 'production', APP_ORIGINS: ORIGIN, BOOTSTRAP_SIGNING_KEY: key }),
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
