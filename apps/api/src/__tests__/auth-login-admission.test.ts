import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  createLoginAdmissionController,
  type LoginAdmissionPolicy,
} from '../auth/login-admission.js';
import { createGuards } from '../auth/guards.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { loadConfig } from '../config.js';
import type { AuthService, LoginInput, LoginResult } from '../auth/service.js';

const ORIGIN = 'http://localhost:3000';
const BASE_POLICY: LoginAdmissionPolicy = {
  globalLimit: 10,
  identityLimit: 10,
  windowMs: 60_000,
  maxConcurrent: 2,
  maxTrackedIdentities: 32,
};

function request(email = 'ghost@korvi.test') {
  return {
    method: 'POST' as const,
    url: '/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { tenantSlug: 'korvi', email, password: 'wrong-password' },
  };
}

function serviceWithLogin(login: (input: LoginInput) => Promise<LoginResult>): AuthService {
  return {
    login,
    authenticate: async () => ({ outcome: 'failure', reason: 'unknown-session' }),
    logout: async () => false,
    logoutAll: async () => 0,
  };
}

describe('unauthenticated login admission', () => {
  it('rejects excess concurrent work before the auth service/KDF can run', async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let twoEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      twoEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const service = serviceWithLogin(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 2) twoEntered();
      await blocked;
      active -= 1;
      return { outcome: 'failure', reason: 'unknown-user' };
    });

    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
    const app = Fastify({ logger: false });
    const guards = createGuards(service, config);
    registerAuthRoutes(app, {
      service,
      guards,
      config,
      loginAdmission: createLoginAdmissionController(BASE_POLICY),
    });
    await app.ready();

    const first = app.inject(request('one@korvi.test'));
    const second = app.inject(request('two@korvi.test'));
    await entered;

    const refused = await app.inject(request('three@korvi.test'));
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: 'too_many_requests' });
    expect(refused.headers['retry-after']).toBe('1');
    expect(calls).toBe(2);
    expect(maxActive).toBe(2);

    release();
    expect((await first).statusCode).toBe(401);
    expect((await second).statusCode).toBe(401);
    await app.close();
  });

  it('rate-limits a canonical tenant/email identity before calling auth', async () => {
    let calls = 0;
    const service = serviceWithLogin(async () => {
      calls += 1;
      return { outcome: 'failure', reason: 'unknown-user' };
    });
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
    const app = Fastify({ logger: false });
    const guards = createGuards(service, config);
    registerAuthRoutes(app, {
      service,
      guards,
      config,
      loginAdmission: createLoginAdmissionController({
        ...BASE_POLICY,
        identityLimit: 2,
      }),
    });
    await app.ready();

    expect((await app.inject(request('Ghost@Korvi.Test'))).statusCode).toBe(401);
    expect((await app.inject(request(' ghost@korvi.test '))).statusCode).toBe(401);
    const refused = await app.inject(request('ghost@korvi.test'));

    expect(refused.statusCode).toBe(429);
    expect(calls).toBe(2);
    await app.close();
  });

  it('bounds rotating fake identities with a process-wide budget', async () => {
    let calls = 0;
    const service = serviceWithLogin(async () => {
      calls += 1;
      return { outcome: 'failure', reason: 'unknown-user' };
    });
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
    const app = Fastify({ logger: false });
    const guards = createGuards(service, config);
    registerAuthRoutes(app, {
      service,
      guards,
      config,
      loginAdmission: createLoginAdmissionController({
        ...BASE_POLICY,
        globalLimit: 3,
        identityLimit: 3,
      }),
    });
    await app.ready();

    for (const email of ['a@korvi.test', 'b@korvi.test', 'c@korvi.test']) {
      expect((await app.inject(request(email))).statusCode).toBe(401);
    }
    const refused = await app.inject(request('d@korvi.test'));

    expect(refused.statusCode).toBe(429);
    expect(calls).toBe(3);
    await app.close();
  });

  it('resets fixed-window budgets without leaking or accumulating stale capacity', () => {
    let clock = 1_000;
    const admission = createLoginAdmissionController(
      { ...BASE_POLICY, globalLimit: 1, identityLimit: 1, maxConcurrent: 1 },
      () => clock,
    );

    const first = admission.admit('korvi', 'ghost@korvi.test');
    expect(first.allowed).toBe(true);
    if (first.allowed) first.release();
    expect(admission.admit('korvi', 'ghost@korvi.test').allowed).toBe(false);

    clock += BASE_POLICY.windowMs;
    const afterWindow = admission.admit('korvi', 'ghost@korvi.test');
    expect(afterWindow.allowed).toBe(true);
    if (afterWindow.allowed) afterWindow.release();
  });
});
