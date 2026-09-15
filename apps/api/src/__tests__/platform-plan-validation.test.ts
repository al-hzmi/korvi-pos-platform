import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createPlatformAuth } from '../platform/auth.js';
import { registerPlatformRoutes } from '../platform/routes.js';
import type { PlatformService } from '../platform/service.js';
import type { FastifyInstance } from 'fastify';

const ACCESS_KEY = 'a'.repeat(40);
const SIGNING_KEY = 'b'.repeat(40);
const ACTOR = 'platform:test-operator';
const TENANT_ID = '018fb000-0000-7000-8000-00000000000a';

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

function unused(): Promise<never> {
  return Promise.reject(new Error('unexpected platform service call'));
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
});

describe('platform plan validation', () => {
  it('rejects a syntactically valid limit above PostgreSQL BIGINT without a 500', async () => {
    let assignCalls = 0;
    const service: PlatformService = {
      listTenants: unused,
      getTenant: unused,
      createTenant: unused,
      activateTenant: unused,
      suspendTenant: unused,
      reactivateTenant: unused,
      async assignPlan() {
        assignCalls += 1;
        return unused();
      },
      listAudit: unused,
    };
    const auth = createPlatformAuth(config());
    const principal = auth.authenticateAccessKey(ACCESS_KEY);
    if (principal === null) throw new Error('test platform credential was rejected');
    const cookie = `korvi_platform_session=${auth.issueSession(principal)}`;

    app = Fastify({ logger: false });
    registerPlatformRoutes(app, { auth, service });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${TENANT_ID}/plan`,
      headers: { cookie },
      payload: {
        operationId: '018fb000-0000-7000-8000-000000000010',
        planKey: 'commercial',
        planRevision: 1,
        accountState: 'active',
        entitlements: [
          {
            key: 'users.max',
            kind: 'limit',
            limit: '9223372036854775808',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'invalid_platform_request' });
    expect(assignCalls).toBe(0);
  });
});
