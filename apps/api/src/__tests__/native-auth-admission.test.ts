import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createLoginAdmissionController } from '../auth/login-admission.js';
import { registerNativeAuthRoutes } from '../routes/native-auth.js';
import type {
  NativeAuthService,
  NativeChallengeResult,
  NativeLoginInput,
  NativeLoginResult,
} from '../native-auth/service.js';

const TENANT_ID = '018f7000-0000-7000-8000-000000000001';
const DEVICE_ID = '018f7000-0000-7000-8000-000000000002';
const CHALLENGE_ID = '018f7000-0000-7000-8000-000000000003';

function challengeSuccess(): NativeChallengeResult {
  return {
    outcome: 'success',
    challengeId: CHALLENGE_ID,
    tenantId: TENANT_ID,
    deviceEnrollmentId: DEVICE_ID,
    terminalId: '018f7000-0000-7000-8000-000000000004',
    branchId: '018f7000-0000-7000-8000-000000000005',
    expiresAt: '2026-09-19T00:05:00.000Z',
    signingPayload: 'korvi.native-auth.v1',
  };
}

function service(overrides: Partial<NativeAuthService> = {}): NativeAuthService {
  return {
    issueChallenge: async () => challengeSuccess(),
    login: async () => ({ outcome: 'failure', reason: 'invalid-credentials' }),
    authenticate: async () => ({ outcome: 'failure', reason: 'unknown-session' }),
    logout: async () => false,
    ...overrides,
  };
}

function challengeRequest() {
  return {
    method: 'POST' as const,
    url: '/v1/native-auth/challenge',
    payload: { tenantId: TENANT_ID, deviceEnrollmentId: DEVICE_ID },
  };
}

function loginRequest() {
  return {
    method: 'POST' as const,
    url: '/v1/native-auth/login',
    payload: {
      tenantId: TENANT_ID,
      deviceEnrollmentId: DEVICE_ID,
      challengeId: CHALLENGE_ID,
      tenantSlug: 'korvi',
      email: 'cashier@korvi.test',
      password: 'wrong-password',
      signature: 'c2lnbmF0dXJl',
    },
  };
}

describe('native authentication admission control', () => {
  it('bounds challenge writes before the native auth service is called', async () => {
    let calls = 0;
    const app = Fastify({ logger: false });
    registerNativeAuthRoutes(app, {
      service: service({
        issueChallenge: async () => {
          calls += 1;
          return challengeSuccess();
        },
      }),
      challengeAdmission: createLoginAdmissionController({
        globalLimit: 2,
        identityLimit: 2,
        windowMs: 60_000,
        maxConcurrent: 2,
        maxTrackedIdentities: 8,
      }),
    });
    await app.ready();

    expect((await app.inject(challengeRequest())).statusCode).toBe(200);
    expect((await app.inject(challengeRequest())).statusCode).toBe(200);

    const refused = await app.inject(challengeRequest());
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: 'too_many_requests' });
    expect(refused.headers['retry-after']).toBeDefined();
    expect(calls).toBe(2);

    await app.close();
  });

  it('bounds concurrent native login work before challenge/KDF verification begins', async () => {
    let calls = 0;
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const login = async (_input: NativeLoginInput): Promise<NativeLoginResult> => {
      calls += 1;
      entered();
      await blocked;
      return { outcome: 'failure', reason: 'invalid-credentials' };
    };

    const app = Fastify({ logger: false });
    registerNativeAuthRoutes(app, {
      service: service({ login }),
      loginAdmission: createLoginAdmissionController({
        globalLimit: 10,
        identityLimit: 10,
        windowMs: 60_000,
        maxConcurrent: 1,
        maxTrackedIdentities: 8,
      }),
    });
    await app.ready();

    const first = app.inject(loginRequest());
    await firstEntered;

    const refused = await app.inject(loginRequest());
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: 'too_many_requests' });
    expect(refused.headers['retry-after']).toBe('1');
    expect(calls).toBe(1);

    release();
    expect((await first).statusCode).toBe(401);

    await app.close();
  });
});
