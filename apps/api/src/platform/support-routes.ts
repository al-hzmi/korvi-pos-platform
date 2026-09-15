import { z } from 'zod';
import { PlatformSupportNoteRefusedError } from '@korvi/database';
import type { PlatformAuth, PlatformPrincipal } from './auth.js';
import type { PlatformSupportService } from './support-service.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

const tenantParams = z.object({ tenantId: z.string().uuid() }).strict();
const listQuery = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const createBody = z
  .object({
    operationId: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();

export interface PlatformSupportRouteOptions {
  readonly auth: PlatformAuth;
  readonly service: PlatformSupportService;
}

function subject(request: { platformAuth?: PlatformPrincipal }): PlatformPrincipal {
  if (request.platformAuth === undefined) {
    throw new Error('Platform support route executed without authenticated principal.');
  }
  return request.platformAuth;
}

function wireNote(note: {
  readonly id: string;
  readonly tenantId: string;
  readonly operationId: string;
  readonly actorRef: string;
  readonly body: string;
  readonly createdAt: Date;
}) {
  return {
    id: note.id,
    tenantId: note.tenantId,
    operationId: note.operationId,
    actorRef: note.actorRef,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
  };
}

function handleSupportError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (!(error instanceof PlatformSupportNoteRefusedError)) return null;
  if (error.detail === 'unknown-tenant') {
    return reply.code(404).send({ error: 'unknown_tenant' });
  }
  if (error.detail === 'idempotency-conflict') {
    return reply.code(409).send({ error: 'idempotency_conflict' });
  }
  return reply.code(400).send({ error: error.detail.replace(/-/g, '_') });
}

export function registerPlatformSupportRoutes(
  app: FastifyInstance,
  options: PlatformSupportRouteOptions,
): void {
  const { auth, service } = options;
  const canReadSupport = [auth.requireSession, auth.requirePermission('platform.support.read')];
  const canManageSupport = [auth.requireSession, auth.requirePermission('platform.support.manage')];

  app.get(
    '/v1/platform/tenants/:tenantId/support-notes',
    { preHandler: canReadSupport },
    async (request, reply) => {
      const params = tenantParams.safeParse(request.params);
      const query = listQuery.safeParse(request.query);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

      try {
        const page = await service.list(subject(request), params.data.tenantId, {
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
          ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
        });
        return reply.code(200).send({
          items: page.items.map(wireNote),
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        const handled = handleSupportError(reply, error);
        if (handled !== null) return handled;
        throw error;
      }
    },
  );

  app.post(
    '/v1/platform/tenants/:tenantId/support-notes',
    { preHandler: canManageSupport },
    async (request, reply) => {
      const params = tenantParams.safeParse(request.params);
      const body = createBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      try {
        const result = await service.create(subject(request), params.data.tenantId, body.data);
        return reply.code(result.replayed ? 200 : 201).send({
          note: wireNote(result.note),
          replayed: result.replayed,
        });
      } catch (error) {
        const handled = handleSupportError(reply, error);
        if (handled !== null) return handled;
        throw error;
      }
    },
  );
}
