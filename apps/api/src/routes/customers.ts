import { z } from 'zod';
import { CustomerAdminRefusedError, MAX_CUSTOMER_PAGE } from '@korvi/database';
import { UUID } from './validation.js';
import type { MerchantCustomerService } from '../customers/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const OPERATION_ID = z.string().trim().min(1).max(120);
const NAME_AR = z.string().trim().min(1).max(160);
const NAME_EN = z.string().trim().min(1).max(160).nullable();
const PHONE = z.string().trim().min(3).max(40).nullable();
const EMAIL = z.string().trim().email().max(320).nullable();
const VAT_NUMBER = z
  .string()
  .regex(/^[0-9]{15}$/, 'must be a 15 digit VAT number')
  .nullable();

const customerParams = z.object({ customerId: UUID }).strict();
const customerListQuery = z
  .object({
    search: z.string().trim().max(120).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    cursor: z.string().max(768).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_CUSTOMER_PAGE).optional(),
  })
  .strict();

const customerCreateBody = z
  .object({
    operationId: OPERATION_ID,
    nameAr: NAME_AR,
    nameEn: NAME_EN.optional().default(null),
    phone: PHONE.optional().default(null),
    email: EMAIL.optional().default(null),
    vatNumber: VAT_NUMBER.optional().default(null),
  })
  .strict();

const customerUpdateBody = z
  .object({
    operationId: OPERATION_ID,
    nameAr: NAME_AR.optional(),
    nameEn: NAME_EN.optional(),
    phone: PHONE.optional(),
    email: EMAIL.optional(),
    vatNumber: VAT_NUMBER.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.nameAr !== undefined ||
      value.nameEn !== undefined ||
      value.phone !== undefined ||
      value.email !== undefined ||
      value.vatNumber !== undefined ||
      value.isActive !== undefined,
    { message: 'at least one customer field must change' },
  );

export interface CustomerRouteOptions {
  readonly service: MerchantCustomerService;
  readonly guards: Guards;
}

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function refusal(reply: FastifyReply, reason: string) {
  switch (reason) {
    case 'unknown-customer':
      return reply.code(404).send({ error: 'customer_not_found' });
    case 'phone-taken':
      return reply.code(409).send({ error: 'customer_phone_taken' });
    case 'invalid-cursor':
      return reply.code(400).send({ error: 'invalid_cursor' });
    case 'idempotency-conflict':
      return reply.code(409).send({ error: 'idempotency_conflict' });
    case 'operation-in-progress':
      return reply.code(409).send({ error: 'operation_in_progress' });
    default:
      return reply.code(400).send({ error: 'customer_operation_refused' });
  }
}

export function registerCustomerRoutes(app: FastifyInstance, options: CustomerRouteOptions): void {
  const { service, guards } = options;
  const canRead = [guards.requireSession, guards.requirePermission('customer.read')];
  const canWrite = [guards.requireSession, guards.requirePermission('customer.write')];

  app.get('/v1/admin/customers', { preHandler: canRead }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

    const parsed = customerListQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

    try {
      const page = await service.list(principal, parsed.data);
      return reply.code(200).send(page);
    } catch (error) {
      if (error instanceof CustomerAdminRefusedError) return refusal(reply, error.detail);
      throw error;
    }
  });

  app.get('/v1/admin/customers/:customerId', { preHandler: canRead }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

    const parsed = customerParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_params' });

    const customer = await service.detail(principal, parsed.data.customerId);
    if (customer === null) return reply.code(404).send({ error: 'customer_not_found' });
    return reply.code(200).send(customer);
  });

  app.post('/v1/admin/customers', { preHandler: canWrite }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

    const parsed = customerCreateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await service.create(principal, parsed.data);
    if (result.outcome === 'failure') return refusal(reply, result.reason);
    return reply.code(result.value.replayed ? 200 : 201).send(result.value);
  });

  app.patch('/v1/admin/customers/:customerId', { preHandler: canWrite }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

    const params = customerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });

    const body = customerUpdateBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await service.update(principal, params.data.customerId, body.data);
    if (result.outcome === 'failure') return refusal(reply, result.reason);
    return reply.code(200).send(result.value);
  });
}
