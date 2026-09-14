import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { PlatformSupportNoteRefusedError } from '@korvi/database';
import { loadConfig } from '../config.js';
import { createPlatformAuth } from '../platform/auth.js';
import { registerPlatformSupportRoutes } from '../platform/support-routes.js';
import type { PlatformSupportActor, PlatformSupportService } from '../platform/support-service.js';
import type { FastifyInstance } from 'fastify';

const ACCESS_KEY = 'a'.repeat(40);
const SIGNING_KEY = 'b'.repeat(40);
const ACTOR = 'platform:test-support';
const TENANT_ID = '018fb000-0000-7000-8000-00000000000a';
const NOTE_ID = '018fb000-0000-7000-8000-00000000000b';
const OPERATION_ID = '018fb000-0000-7000-8000-00000000000c';

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

function sessionCookie() {
  const auth = createPlatformAuth(config());
  const principal = auth.authenticateAccessKey(ACCESS_KEY);
  if (principal === null) throw new Error('test platform credential was rejected');
  return {
    auth,
    cookie: `korvi_platform_session=${auth.issueSession(principal)}`,
  };
}

function note(body = 'تمت متابعة التاجر مع فريق الدعم') {
  return {
    id: NOTE_ID,
    tenantId: TENANT_ID,
    operationId: OPERATION_ID,
    actorRef: ACTOR,
    body,
    createdAt: new Date('2026-09-14T12:00:00.000Z'),
  };
}

function service(overrides: Partial<PlatformSupportService> = {}): PlatformSupportService {
  return {
    async list() {
      return { items: [note()], nextCursor: null };
    },
    async create(_actor, _tenantId, input) {
      return { note: note(input.body), replayed: false };
    },
    ...overrides,
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
});

describe('platform support routes', () => {
  it('requires the independent platform session and derives the actor from it', async () => {
    const { auth, cookie } = sessionCookie();
    let seenActor: PlatformSupportActor | undefined;
    app = Fastify({ logger: false });
    registerPlatformSupportRoutes(app, {
      auth,
      service: service({
        async list(actor) {
          seenActor = actor;
          return { items: [note()], nextCursor: null };
        },
      }),
    });
    await app.ready();

    const unauthenticated = await app.inject({
      method: 'GET',
      url: `/v1/platform/tenants/${TENANT_ID}/support-notes`,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/platform/tenants/${TENANT_ID}/support-notes?limit=50`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          ...note(),
          createdAt: '2026-09-14T12:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(seenActor).toEqual({ controlPlaneActorRef: ACTOR });
  });

  it('rejects caller-supplied actor authority and creates with an idempotency operation', async () => {
    const { auth, cookie } = sessionCookie();
    let seenActor: PlatformSupportActor | undefined;
    app = Fastify({ logger: false });
    registerPlatformSupportRoutes(app, {
      auth,
      service: service({
        async create(actor, tenantId, input) {
          seenActor = actor;
          expect(tenantId).toBe(TENANT_ID);
          expect(input).toEqual({ operationId: OPERATION_ID, body: 'متابعة داخلية' });
          return { note: note(input.body), replayed: false };
        },
      }),
    });
    await app.ready();

    const injected = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/support-notes`,
      headers: { cookie },
      payload: {
        operationId: OPERATION_ID,
        body: 'متابعة داخلية',
        controlPlaneActorRef: 'platform:attacker',
      },
    });
    expect(injected.statusCode).toBe(400);
    expect(injected.json()).toEqual({ error: 'invalid_body' });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/support-notes`,
      headers: { cookie },
      payload: { operationId: OPERATION_ID, body: 'متابعة داخلية' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      replayed: false,
      note: { body: 'متابعة داخلية', actorRef: ACTOR },
    });
    expect(seenActor).toEqual({ controlPlaneActorRef: ACTOR });
  });

  it('uses 200 for an exact replay and 409 for conflicting idempotency intent', async () => {
    const { auth, cookie } = sessionCookie();
    let conflict = false;
    app = Fastify({ logger: false });
    registerPlatformSupportRoutes(app, {
      auth,
      service: service({
        async create(_actor, _tenantId, input) {
          if (conflict) throw new PlatformSupportNoteRefusedError('idempotency-conflict');
          return { note: note(input.body), replayed: true };
        },
      }),
    });
    await app.ready();

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/support-notes`,
      headers: { cookie },
      payload: { operationId: OPERATION_ID, body: 'متابعة داخلية' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true });

    conflict = true;
    const collision = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/support-notes`,
      headers: { cookie },
      payload: { operationId: OPERATION_ID, body: 'محتوى مختلف' },
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toEqual({ error: 'idempotency_conflict' });
  });

  it('fails closed for unknown tenants and malformed paging or note bodies', async () => {
    const { auth, cookie } = sessionCookie();
    app = Fastify({ logger: false });
    registerPlatformSupportRoutes(app, {
      auth,
      service: service({
        async list() {
          throw new PlatformSupportNoteRefusedError('unknown-tenant');
        },
      }),
    });
    await app.ready();

    const unknown = await app.inject({
      method: 'GET',
      url: `/v1/platform/tenants/${TENANT_ID}/support-notes`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'unknown_tenant' });

    const badPaging = await app.inject({
      method: 'GET',
      url: `/v1/platform/tenants/${TENANT_ID}/support-notes?limit=101`,
      headers: { cookie },
    });
    expect(badPaging.statusCode).toBe(400);
    expect(badPaging.json()).toEqual({ error: 'invalid_query' });

    const empty = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/support-notes`,
      headers: { cookie },
      payload: { operationId: OPERATION_ID, body: '   ' },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: 'invalid_body' });
  });
});
