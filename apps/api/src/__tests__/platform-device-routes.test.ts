import { Buffer } from 'node:buffer';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformAuth } from '../platform/auth.js';
import { registerPlatformDeviceRoutes } from '../platform/device-routes.js';
import { loadConfig } from '../config.js';
import type { PlatformActor } from '../platform/service.js';
import type {
  PlatformDeviceEnrollmentInput,
  PlatformDeviceRevocationInput,
} from '../platform/device-enrollment-issuer.js';
import type { FastifyInstance } from 'fastify';

const ACCESS_KEY = 'a'.repeat(40);
const SIGNING_KEY = 'b'.repeat(40);
const ACTOR = 'platform:device-test';
const TENANT_ID = '018fb000-0000-7000-8000-00000000000a';
const TERMINAL_ID = '018fb000-0000-7000-8000-00000000000b';
const INSTALLATION_ID = '018fb000-0000-7000-8000-00000000000c';
const ENROLLMENT_ID = '018fb000-0000-7000-8000-00000000000d';
const PUBLIC_KEY = Buffer.alloc(44, 7);

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PLATFORM_ADMIN_ACCESS_KEY: ACCESS_KEY,
    PLATFORM_SESSION_SIGNING_KEY: SIGNING_KEY,
    PLATFORM_ADMIN_ACTOR_REF: ACTOR,
    PLATFORM_SESSION_TTL_HOURS: '1',
  });
}

function enrollment() {
  return {
    id: ENROLLMENT_ID,
    tenantId: TENANT_ID,
    terminalId: TERMINAL_ID,
    installationId: INSTALLATION_ID,
    platform: 'windows' as const,
    normalizedFingerprintDigest: '1'.repeat(64),
    publicKeySha256: '2'.repeat(64),
    keyAlgorithm: 'ed25519' as const,
    appVersion: '1.0.0',
    state: 'active' as const,
    enrolledAt: new Date('2026-09-15T12:00:00.000Z'),
    lastSeenAt: new Date('2026-09-15T12:00:00.000Z'),
    revokedAt: null,
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
});

describe('platform device enrollment routes', () => {
  it('accepts enrollment only from Platform authority and derives the actor from its session', async () => {
    let calls = 0;
    let seenActor: PlatformActor | undefined;
    let seenTenant: string | undefined;
    let seenInput: PlatformDeviceEnrollmentInput | undefined;
    const auth = createPlatformAuth(config());

    app = Fastify({ logger: false });
    registerPlatformDeviceRoutes(app, {
      auth,
      enroll: async (actor, tenantId, input) => {
        calls += 1;
        seenActor = actor;
        seenTenant = tenantId;
        seenInput = input;
        return { enrollment: enrollment(), replayed: false };
      },
      revoke: async () => Promise.reject(new Error('unexpected revoke')),
    });
    await app.ready();

    const payload = {
      operationId: 'enroll-device-1',
      terminalId: TERMINAL_ID,
      installationId: INSTALLATION_ID,
      platform: 'windows',
      normalizedFingerprintDigest: '1'.repeat(64),
      publicKeySpki: PUBLIC_KEY.toString('base64'),
      publicKeySha256: '2'.repeat(64),
      keyAlgorithm: 'ed25519',
      appVersion: '1.0.0',
    };

    const merchantCookie = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/device-enrollments`,
      headers: { cookie: 'korvi_session=merchant-session' },
      payload,
    });
    expect(merchantCookie.statusCode).toBe(401);
    expect(calls).toBe(0);

    const principal = auth.authenticateAccessKey(ACCESS_KEY);
    if (principal === null) throw new Error('test platform credential was rejected');
    const cookie = `korvi_platform_session=${await auth.issueSession(principal)}`;

    const actorInjection = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/device-enrollments`,
      headers: { cookie },
      payload: { ...payload, controlPlaneActorRef: 'platform:attacker' },
    });
    expect(actorInjection.statusCode).toBe(400);
    expect(calls).toBe(0);

    const privateKeyInjection = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/device-enrollments`,
      headers: { cookie },
      payload: { ...payload, privateKey: 'must-never-cross-the-boundary' },
    });
    expect(privateKeyInjection.statusCode).toBe(400);
    expect(calls).toBe(0);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/device-enrollments`,
      headers: { cookie },
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      enrollment: {
        id: ENROLLMENT_ID,
        terminalId: TERMINAL_ID,
        publicKeySha256: '2'.repeat(64),
        state: 'active',
      },
      replayed: false,
    });
    expect(created.body).not.toContain('publicKeySpki');
    expect(created.body).not.toContain('privateKey');
    expect(calls).toBe(1);
    expect(seenActor?.controlPlaneActorRef).toBe(ACTOR);
    expect(seenTenant).toBe(TENANT_ID);
    expect(seenInput?.terminalId).toBe(TERMINAL_ID);
  });

  it('keeps revocation behind the same Platform authority and server-derived actor', async () => {
    let seenActor: PlatformActor | undefined;
    let seenTenant: string | undefined;
    let seenEnrollment: string | undefined;
    let seenInput: PlatformDeviceRevocationInput | undefined;
    const auth = createPlatformAuth(config());

    app = Fastify({ logger: false });
    registerPlatformDeviceRoutes(app, {
      auth,
      enroll: async () => Promise.reject(new Error('unexpected enroll')),
      revoke: async (actor, tenantId, enrollmentId, input) => {
        seenActor = actor;
        seenTenant = tenantId;
        seenEnrollment = enrollmentId;
        seenInput = input;
        return {
          enrollment: {
            ...enrollment(),
            state: 'revoked',
            revokedAt: new Date('2026-09-15T12:30:00.000Z'),
          },
          replayed: false,
        };
      },
    });
    await app.ready();

    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/device-enrollments/${ENROLLMENT_ID}/revoke`,
      payload: { operationId: 'revoke-device-1', reason: 'device retired' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const principal = auth.authenticateAccessKey(ACCESS_KEY);
    if (principal === null) throw new Error('test platform credential was rejected');
    const cookie = `korvi_platform_session=${await auth.issueSession(principal)}`;

    const revoked = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/device-enrollments/${ENROLLMENT_ID}/revoke`,
      headers: { cookie },
      payload: { operationId: 'revoke-device-1', reason: 'device retired' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ enrollment: { state: 'revoked' }, replayed: false });
    expect(seenActor?.controlPlaneActorRef).toBe(ACTOR);
    expect(seenTenant).toBe(TENANT_ID);
    expect(seenEnrollment).toBe(ENROLLMENT_ID);
    expect(seenInput).toEqual({ operationId: 'revoke-device-1', reason: 'device retired' });
  });

  it('rejects non-canonical public key encoding before authority code runs', async () => {
    let calls = 0;
    const auth = createPlatformAuth(config());
    const principal = auth.authenticateAccessKey(ACCESS_KEY);
    if (principal === null) throw new Error('test platform credential was rejected');

    app = Fastify({ logger: false });
    registerPlatformDeviceRoutes(app, {
      auth,
      enroll: async () => {
        calls += 1;
        return { enrollment: enrollment(), replayed: false };
      },
      revoke: async () => Promise.reject(new Error('unexpected revoke')),
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/device-enrollments`,
      headers: { cookie: `korvi_platform_session=${await auth.issueSession(principal)}` },
      payload: {
        operationId: 'enroll-device-2',
        terminalId: TERMINAL_ID,
        installationId: INSTALLATION_ID,
        platform: 'windows',
        normalizedFingerprintDigest: '1'.repeat(64),
        publicKeySpki: 'not canonical base64',
        publicKeySha256: '2'.repeat(64),
        keyAlgorithm: 'ed25519',
        appVersion: '1.0.0',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_body' });
    expect(calls).toBe(0);
  });
});
