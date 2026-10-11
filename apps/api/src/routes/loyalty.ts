import { z } from 'zod';
import { UUID } from './validation.js';
import type { MerchantLoyaltyService } from '../loyalty/service.js';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

const RATE = z.string().regex(/^[1-9][0-9]{0,18}$/);
const policyFields = {
  nameAr: z.string().trim().min(1).max(120),
  earnNumerator: RATE,
  earnDenominator: RATE,
  redeemValueMinorPerPoint: RATE,
};
const createBody = z.object(policyFields).strict();
const reviseBody = z
  .object({
    expectedRevision: RATE,
    nameAr: policyFields.nameAr.optional(),
    earnNumerator: RATE.optional(),
    earnDenominator: RATE.optional(),
    redeemValueMinorPerPoint: RATE.optional(),
    status: z.enum(['draft', 'active', 'paused']).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.nameAr !== undefined ||
      value.earnNumerator !== undefined ||
      value.earnDenominator !== undefined ||
      value.redeemValueMinorPerPoint !== undefined ||
      value.status !== undefined,
    { message: 'at least one policy field required' },
  );
const enrollBody = z.object({ customerId: UUID, consentConfirmed: z.literal(true) }).strict();
const customerParams = z.object({ customerId: UUID }).strict();

function refusal(reply: FastifyReply, reason: string) {
  const notFound = reason === 'customer-unavailable' || reason === 'program-missing';
  const invalid = reason === 'invalid-policy' || reason === 'not-consented';
  return reply.code(notFound ? 404 : invalid ? 400 : 409).send({ error: reason });
}

export function registerLoyaltyRoutes(
  app: FastifyInstance,
  service: MerchantLoyaltyService,
  guards: Guards,
): void {
  const manage = [guards.requireSession, guards.requirePermission('loyalty.manage')];
  const enroll = [
    guards.requireSession,
    guards.requirePermission('loyalty.manage'),
    guards.requirePermission('customer.write'),
  ];
  const view = [guards.requireSession, guards.requirePermission('customer.read')];

  app.get('/v1/admin/loyalty/policy', { preHandler: manage }, async (request, reply) => {
    if (request.auth === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.code(200).send(await service.policy(request.auth));
  });

  app.post('/v1/admin/loyalty/policy', { preHandler: manage }, async (request, reply) => {
    if (request.auth === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const body = createBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const result = await service.create(request.auth, body.data);
    if (result.outcome === 'failure') return refusal(reply, result.reason);
    return reply.code(201).send(result.value);
  });

  app.patch('/v1/admin/loyalty/policy', { preHandler: manage }, async (request, reply) => {
    if (request.auth === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const body = reviseBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const { expectedRevision, ...update } = body.data;
    const result = await service.revise(request.auth, expectedRevision, update);
    if (result.outcome === 'failure') return refusal(reply, result.reason);
    return reply.code(200).send(result.value);
  });

  app.post('/v1/admin/loyalty/enrollments', { preHandler: enroll }, async (request, reply) => {
    if (request.auth === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const body = enrollBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const result = await service.enroll(
      request.auth,
      body.data.customerId,
      body.data.consentConfirmed,
    );
    if (result.outcome === 'failure') return refusal(reply, result.reason);
    return reply.code(201).send(result.value);
  });

  app.get(
    '/v1/admin/loyalty/customers/:customerId',
    { preHandler: view },
    async (request, reply) => {
      if (request.auth === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = customerParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      return reply.code(200).send(await service.ledger(request.auth, params.data.customerId));
    },
  );
}
