import { z } from 'zod';
import {
  PlanEntitlementRefusedError,
  TenantLifecycleRefusedError,
  TenantProvisioningError,
} from '@korvi/database';
import { CommercialEntitlementError, MAX_ENTITLEMENT_LIMIT } from '@korvi/domain';
import { createLoginAdmissionController } from '../auth/login-admission.js';
import type { PlatformAuth, PlatformPrincipal } from './auth.js';
import type { PlatformService } from './service.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

const accessBody = z.object({ accessKey: z.string().min(1).max(512) }).strict();
const tenantParams = z.object({ tenantId: z.string().uuid() }).strict();
const operationBody = z.object({ operationId: z.string().trim().min(1).max(160) }).strict();
const suspensionBody = operationBody.extend({ reason: z.string().trim().min(1).max(500) }).strict();
const tenantListQuery = z
  .object({
    search: z.string().max(120).optional(),
    status: z.enum(['provisioning', 'active', 'suspended']).optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const auditQuery = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const createTenantBody = z
  .object({
    operationId: z.string().trim().min(1).max(160),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    name: z.string().trim().min(1).max(200),
    vatNumber: z.string().trim().min(1).max(64).nullable().default(null),
    vertical: z.enum(['retail', 'grocery', 'restaurant', 'pharmacy']),
  })
  .strict();
const entitlementWire = z.discriminatedUnion('kind', [
  z
    .object({
      key: z.string().trim().min(1).max(96),
      kind: z.literal('flag'),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      key: z.string().trim().min(1).max(96),
      kind: z.literal('limit'),
      limit: z.string().regex(/^\d{1,19}$/),
    })
    .strict(),
]);
const planBody = z
  .object({
    operationId: z.string().trim().min(1).max(160),
    planKey: z.string().trim().min(1).max(64),
    planRevision: z.number().int().min(1).max(2_147_483_647),
    accountState: z.enum(['active', 'restricted']),
    entitlements: z.array(entitlementWire).max(256),
  })
  .strict();

const loginAdmission = createLoginAdmissionController({
  globalLimit: 20,
  identityLimit: 8,
  windowMs: 60_000,
  maxConcurrent: 1,
  maxTrackedIdentities: 64,
});

export interface PlatformRouteOptions {
  readonly auth: PlatformAuth;
  readonly service: PlatformService;
}

function subject(request: { platformAuth?: PlatformPrincipal }): PlatformPrincipal {
  if (request.platformAuth === undefined) {
    throw new Error('Platform route executed without authenticated principal.');
  }
  return request.platformAuth;
}

function safeSession(principal: PlatformPrincipal) {
  return {
    authenticated: true,
    expiresAt: new Date(principal.expiresAt * 1000).toISOString(),
    permissions: principal.permissions,
  };
}

function wireEntitlements(
  entitlements: readonly (
    | { readonly key: string; readonly kind: 'flag'; readonly enabled: boolean }
    | { readonly key: string; readonly kind: 'limit'; readonly limit: bigint }
  )[],
) {
  return entitlements.map((grant) =>
    grant.kind === 'flag'
      ? { key: grant.key, kind: grant.kind, enabled: grant.enabled }
      : { key: grant.key, kind: grant.kind, limit: grant.limit.toString() },
  );
}

function wireCommercial<T extends { readonly entitlements: readonly unknown[] }>(value: T) {
  return {
    ...value,
    entitlements: wireEntitlements(
      value.entitlements as readonly (
        | { readonly key: string; readonly kind: 'flag'; readonly enabled: boolean }
        | { readonly key: string; readonly kind: 'limit'; readonly limit: bigint }
      )[],
    ),
  };
}

function handlePlatformError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof TenantProvisioningError) {
    const status = error.detail === 'invalid-slug' || error.detail === 'invalid-name' ? 422 : 409;
    return reply.code(status).send({ error: error.detail.replace(/-/g, '_') });
  }
  if (error instanceof TenantLifecycleRefusedError) {
    const status = error.detail === 'unknown-tenant' ? 404 : 409;
    return reply.code(status).send({ error: error.detail.replace(/-/g, '_') });
  }
  if (error instanceof PlanEntitlementRefusedError) {
    const status = error.detail === 'unknown-tenant' ? 404 : 409;
    return reply.code(status).send({ error: error.detail.replace(/-/g, '_') });
  }
  if (error instanceof CommercialEntitlementError || error instanceof RangeError) {
    return reply.code(422).send({ error: 'invalid_platform_request' });
  }
  return null;
}

async function safely(reply: FastifyReply, work: () => Promise<unknown>): Promise<FastifyReply> {
  try {
    const value = await work();
    return reply.code(200).send(value);
  } catch (error) {
    const handled = handlePlatformError(reply, error);
    if (handled !== null) return handled;
    throw error;
  }
}

export function registerPlatformRoutes(app: FastifyInstance, options: PlatformRouteOptions): void {
  const { auth, service } = options;
  const canReadTenants = [auth.requireSession, auth.requirePermission('platform.tenants.read')];
  const canManageTenants = [auth.requireSession, auth.requirePermission('platform.tenants.manage')];
  const canManageCommercial = [
    auth.requireSession,
    auth.requirePermission('platform.commercial.manage'),
  ];
  const canReadAudit = [auth.requireSession, auth.requirePermission('platform.audit.read')];

  app.post('/v1/platform/session', async (request, reply) => {
    if (!auth.configured) {
      return reply.code(503).send({ error: 'platform_admin_not_configured' });
    }
    const parsed = accessBody.safeParse(request.body);
    if (!parsed.success) return reply.code(401).send({ error: 'invalid_platform_credentials' });

    const permit = loginAdmission.admit('korvi-platform', 'platform-admin');
    if (!permit.allowed) {
      reply.header('retry-after', String(permit.retryAfterSeconds));
      return reply.code(429).send({ error: 'too_many_requests' });
    }

    try {
      const principal = auth.authenticateAccessKey(parsed.data.accessKey);
      if (principal === null) {
        request.log.warn('platform login refused');
        return reply.code(401).send({ error: 'invalid_platform_credentials' });
      }
      auth.setSessionCookie(reply, auth.issueSession(principal));
      return reply.code(200).send(safeSession(principal));
    } finally {
      permit.release();
    }
  });

  app.get('/v1/platform/session', { preHandler: auth.requireSession }, async (request, reply) => {
    return reply.code(200).send(safeSession(subject(request)));
  });

  app.post('/v1/platform/logout', async (_request, reply) => {
    auth.clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/v1/platform/tenants', { preHandler: canReadTenants }, async (request, reply) => {
    const parsed = tenantListQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    return safely(reply, () => service.listTenants(subject(request), parsed.data));
  });

  app.get(
    '/v1/platform/tenants/:tenantId',
    { preHandler: canReadTenants },
    async (request, reply) => {
      const parsed = tenantParams.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_params' });
      const detail = await service.getTenant(subject(request), parsed.data.tenantId);
      if (detail === null) return reply.code(404).send({ error: 'unknown_tenant' });
      return reply.code(200).send({
        ...detail,
        commercial: detail.commercial === null ? null : wireCommercial(detail.commercial),
      });
    },
  );

  app.post('/v1/platform/tenants', { preHandler: canManageTenants }, async (request, reply) => {
    const parsed = createTenantBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const result = await service.createTenant(subject(request), parsed.data);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      const handled = handlePlatformError(reply, error);
      if (handled !== null) return handled;
      throw error;
    }
  });

  app.post(
    '/v1/platform/tenants/:tenantId/activate',
    { preHandler: canManageTenants },
    async (request, reply) => {
      const params = tenantParams.safeParse(request.params);
      const body = operationBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return safely(reply, () =>
        service.activateTenant(subject(request), params.data.tenantId, body.data.operationId),
      );
    },
  );

  app.post(
    '/v1/platform/tenants/:tenantId/suspend',
    { preHandler: canManageTenants },
    async (request, reply) => {
      const params = tenantParams.safeParse(request.params);
      const body = suspensionBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return safely(reply, () =>
        service.suspendTenant(
          subject(request),
          params.data.tenantId,
          body.data.operationId,
          body.data.reason,
        ),
      );
    },
  );

  app.post(
    '/v1/platform/tenants/:tenantId/reactivate',
    { preHandler: canManageTenants },
    async (request, reply) => {
      const params = tenantParams.safeParse(request.params);
      const body = operationBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return safely(reply, () =>
        service.reactivateTenant(subject(request), params.data.tenantId, body.data.operationId),
      );
    },
  );

  app.post(
    '/v1/platform/tenants/:tenantId/plan',
    { preHandler: canManageCommercial },
    async (request, reply) => {
      const params = tenantParams.safeParse(request.params);
      const body = planBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      const entitlements = body.data.entitlements.map((grant) => {
        if (grant.kind === 'flag') return grant;
        const limit = BigInt(grant.limit);
        if (limit > MAX_ENTITLEMENT_LIMIT) throw new RangeError('entitlement limit exceeds BIGINT');
        return { key: grant.key, kind: grant.kind, limit } as const;
      });

      try {
        const result = await service.assignPlan(subject(request), params.data.tenantId, {
          operationId: body.data.operationId,
          planKey: body.data.planKey,
          planRevision: body.data.planRevision,
          accountState: body.data.accountState,
          entitlements,
        });
        return reply.code(200).send(wireCommercial(result));
      } catch (error) {
        const handled = handlePlatformError(reply, error);
        if (handled !== null) return handled;
        throw error;
      }
    },
  );

  app.get(
    '/v1/platform/tenants/:tenantId/audit',
    { preHandler: canReadAudit },
    async (request, reply) => {
      const params = tenantParams.safeParse(request.params);
      const query = auditQuery.safeParse(request.query);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
      const page = await service.listAudit(subject(request), params.data.tenantId, query.data);
      if (page === null) return reply.code(404).send({ error: 'unknown_tenant' });
      return reply.code(200).send(page);
    },
  );
}
