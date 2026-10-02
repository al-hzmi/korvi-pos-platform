import { z } from 'zod';
import { MAX_SUPPLIER_IMPORT_BYTES } from '../migration/supplier-import-service.js';
import type {
  MerchantSupplierMigrationService,
  SupplierMigrationFailureReason,
} from '../migration/supplier-import-service.js';
import type { Guards } from '../auth/guards.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const UUID = z.string().uuid();
const TARGET_FIELD = z.enum(['name']);
const DELIMITER = z.enum([',', ';', '\t']);
const SOURCE = z
  .object({
    csvText: z.string().min(1).max(MAX_SUPPLIER_IMPORT_BYTES),
    fileName: z.string().trim().min(1).max(255).nullable().optional().default(null),
    sourceSystem: z.string().trim().min(1).max(120).nullable().optional().default(null),
    delimiter: DELIMITER.optional().default(','),
  })
  .strict();
const XLSX_SOURCE = z
  .object({
    xlsxBase64: z.string().min(4).max(7_000_000),
    fileName: z.string().trim().min(1).max(255).nullable().optional().default(null),
    sourceSystem: z.string().trim().min(1).max(120).nullable().optional().default(null),
  })
  .strict();
const CREATE_JOB = SOURCE.extend({
  operationId: UUID,
  mapping: z
    .array(
      z
        .object({
          sourceColumn: z.number().int().min(0).max(199),
          targetField: TARGET_FIELD.nullable(),
        })
        .strict(),
    )
    .max(200),
}).strict();
const CREATE_XLSX_JOB = XLSX_SOURCE.extend({
  operationId: UUID,
  mapping: z
    .array(
      z
        .object({
          sourceColumn: z.number().int().min(0).max(199),
          targetField: TARGET_FIELD.nullable(),
        })
        .strict(),
    )
    .max(200),
}).strict();
const JOB_PARAMS = z.object({ jobId: UUID }).strict();
const ROW_QUERY = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional().default(200),
    afterSourceRow: z.coerce.number().int().min(1).nullable().optional().default(null),
    problemsOnly: z.enum(['true', 'false']).optional().default('false'),
  })
  .strict();
const COMMIT = z.object({ operationId: UUID }).strict();

const STATUS: Readonly<Record<SupplierMigrationFailureReason, number>> = {
  'file-too-large': 413,
  'invalid-csv': 422,
  'invalid-xlsx': 422,
  'empty-file': 422,
  'unknown-job': 404,
  'invalid-source-hash': 422,
  'invalid-operation': 422,
  'idempotency-conflict': 409,
  'job-not-ready': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function respond<T>(
  reply: FastifyReply,
  result:
    | { readonly outcome: 'success'; readonly value: T }
    | { readonly outcome: 'failure'; readonly reason: SupplierMigrationFailureReason },
  successCode = 200,
): FastifyReply {
  if (result.outcome === 'failure') {
    return reply.code(STATUS[result.reason]).send({ error: result.reason.replace(/-/g, '_') });
  }
  return reply.code(successCode).send(result.value);
}

export function registerSupplierMigrationRoutes(
  app: FastifyInstance,
  options: { readonly service: MerchantSupplierMigrationService; readonly guards: Guards },
): void {
  const { service, guards } = options;
  const manage = [guards.requireSession, guards.requirePermission('settings.manage')];

  app.post(
    '/v1/admin/migrations/suppliers/inspect-csv',
    { preHandler: manage, bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const body = SOURCE.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(reply, await service.inspectCsv(principal, body.data));
    },
  );

  app.post(
    '/v1/admin/migrations/suppliers/inspect-xlsx',
    { preHandler: manage, bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const body = XLSX_SOURCE.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(reply, await service.inspectXlsx(principal, body.data));
    },
  );

  app.post(
    '/v1/admin/migrations/suppliers/jobs/xlsx',
    { preHandler: manage, bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const body = CREATE_XLSX_JOB.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(reply, await service.createXlsxJob(principal, body.data), 201);
    },
  );

  app.post(
    '/v1/admin/migrations/suppliers/jobs',
    { preHandler: manage, bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const body = CREATE_JOB.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(reply, await service.createCsvJob(principal, body.data), 201);
    },
  );

  app.get(
    '/v1/admin/migrations/suppliers/jobs/:jobId',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = JOB_PARAMS.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const result = await service.readJob(principal, params.data.jobId);
      if (result.outcome === 'success' && result.value === null) {
        return reply.code(404).send({ error: 'unknown_job' });
      }
      return respond(reply, result);
    },
  );

  app.get(
    '/v1/admin/migrations/suppliers/jobs/:jobId/rows',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = JOB_PARAMS.safeParse(request.params);
      const query = ROW_QUERY.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send({ error: 'invalid_query' });
      }
      const result = await service.rows(principal, params.data.jobId, {
        limit: query.data.limit,
        afterSourceRow: query.data.afterSourceRow,
        problemsOnly: query.data.problemsOnly === 'true',
      });
      if (result.outcome === 'success' && result.value === null) {
        return reply.code(404).send({ error: 'unknown_job' });
      }
      return respond(reply, result);
    },
  );

  app.post(
    '/v1/admin/migrations/suppliers/jobs/:jobId/dry-run',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = JOB_PARAMS.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (
        request.body !== undefined &&
        request.body !== null &&
        (typeof request.body !== 'object' ||
          Array.isArray(request.body) ||
          Object.keys(request.body as object).length !== 0)
      ) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      return respond(reply, await service.dryRun(principal, params.data.jobId));
    },
  );

  app.post(
    '/v1/admin/migrations/suppliers/jobs/:jobId/commit',
    {
      preHandler: [
        guards.requireSession,
        guards.requirePermission('settings.manage'),
        guards.requirePermission('purchasing.manage'),
      ],
    },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = JOB_PARAMS.safeParse(request.params);
      const body = COMMIT.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      return respond(
        reply,
        await service.commit(principal, params.data.jobId, body.data.operationId),
      );
    },
  );
}
