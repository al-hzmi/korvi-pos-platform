import { z } from 'zod';
import { MAX_STOCK_LINES, MAX_STOCK_REASON, canonicalUuid } from '@korvi/domain';
import { MAX_BALANCE_PAGE, MAX_INVENTORY_BRANCH_PAGE } from '@korvi/database';
import type { MerchantInventoryService, StockFailureReason } from '../inventory/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The merchant stock authority, over HTTP.
 *
 * Six routes, four permissions and one rule that governs all of them: the
 * browser may state *what it wants to happen*, never *what already happened*
 * and never *who is asking*. The tenant and the actor come from the session;
 * balances, revisions and derived deltas come from the locked rows.
 *
 * The asymmetry between an adjustment and a count is the point of this file.
 * An adjustment delta is a merchant's instruction and is legitimate input. A
 * count delta is a *consequence* of an observation and the current balance, and
 * accepting one would let a client overwrite a sale it never saw (§H).
 */

/**
 * A UUID identity, canonicalized at the door.
 *
 * `z.string().uuid()` accepts `018F…A8` and `018f…a8` alike and hands both
 * through unchanged — but they are one row to PostgreSQL, so leaving the casing
 * alone would let one physical product arrive twice under two spellings and
 * defeat every downstream comparison that is about identity rather than text.
 *
 * The rule itself lives in `@korvi/domain` and is applied by the authority too;
 * this is the same doctrine enforced at the earliest boundary, not a second
 * one. Doing it here is what makes the *balances* query canonical as well,
 * since that path reads rows directly and never passes through a validator.
 */
const UUID = z.string().transform((value, ctx) => {
  try {
    return canonicalUuid(value, 'id');
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be a UUID' });
    return z.NEVER;
  }
});

/** Scaled integer text, signed. Never a JSON number: 2^53 is reachable here. */
const SIGNED_SCALED = z
  .string()
  .regex(/^(0|-?[1-9][0-9]{0,17})$/, 'must be a scaled integer string');

/** Unsigned scaled integer text, for observations and revisions. */
const UNSIGNED_SCALED = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,17})$/, 'must be a non-negative integer string');

const OPERATION_ID = z.string().trim().min(1).max(120);
const REASON = z.string().trim().min(1).max(MAX_STOCK_REASON);

const adjustmentBody = z
  .object({
    operationId: OPERATION_ID,
    branchId: UUID,
    reason: REASON,
    lines: z
      .array(z.object({ productId: UUID, deltaQuantityScaled: SIGNED_SCALED }).strict())
      .min(1)
      .max(MAX_STOCK_LINES),
  })
  .strict();

const countBody = z
  .object({
    operationId: OPERATION_ID,
    branchId: UUID,
    reason: REASON.nullable().optional(),
    lines: z
      .array(
        z
          .object({
            productId: UUID,
            countedQuantityScaled: UNSIGNED_SCALED,
            expectedRevision: UNSIGNED_SCALED,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_STOCK_LINES),
  })
  .strict();

const transferBody = z
  .object({
    operationId: OPERATION_ID,
    fromBranchId: UUID,
    toBranchId: UUID,
    reason: REASON.nullable().optional(),
    lines: z
      .array(z.object({ productId: UUID, quantityScaled: UNSIGNED_SCALED }).strict())
      .min(1)
      .max(MAX_STOCK_LINES),
  })
  .strict();

const costBootstrapBody = z
  .object({
    operationId: OPERATION_ID,
    branchId: UUID,
    productId: UUID,
    totalValueMinor: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  })
  .strict();

const balancesQuery = z
  .object({
    branchId: UUID,
    limit: z.coerce.number().int().min(1).max(MAX_BALANCE_PAGE).optional(),
    cursor: UUID.optional(),
  })
  .strict();

const branchesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_INVENTORY_BRANCH_PAGE).optional(),
    cursor: UUID.optional(),
  })
  .strict();

/**
 * Authority the client does not get to assert, refused by name.
 *
 * `.strict()` above already rejects an unknown key, but a bare "invalid body"
 * for `tenantId` teaches an integrator nothing and hides an attempt. Naming the
 * field makes a probe legible in the logs and a mistake obvious to a developer.
 *
 * `deltaQuantityScaled` is on this list for counts *only*: it is the one field
 * whose legitimacy depends on which door it arrives at.
 */
const FORBIDDEN_STOCK_FIELDS = [
  'tenantId',
  'tenant',
  'actorUserId',
  'userId',
  'sessionId',
  'movementKind',
  'kind',
  'beforeQuantityScaled',
  'afterQuantityScaled',
  'quantity',
  'resultRevision',
  'currentRevision',
  'revision',
  'isFinalized',
  'status',
  'occurredAt',
  'createdAt',
  'auditEventId',
  'balance',
  'balances',
] as const;

const FORBIDDEN_COUNT_FIELDS = ['deltaQuantityScaled', ...FORBIDDEN_STOCK_FIELDS] as const;

const FORBIDDEN_COST_BOOTSTRAP_FIELDS = [
  'quantityScaled',
  'valuedQuantityScaled',
  'knownQuantityScaled',
  'unknownQuantityScaled',
  'unknownPositiveQuantity',
  'knownValueMinor',
  'costValueMinor',
  'stockRevision',
  'costRevision',
  ...FORBIDDEN_STOCK_FIELDS,
] as const;

function forbiddenField(body: unknown, fields: readonly string[]): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const field of fields) {
    if (Object.hasOwn(body, field)) return field;
  }
  const lines = (body as { lines?: unknown }).lines;
  if (Array.isArray(lines)) {
    for (const line of lines) {
      if (line === null || typeof line !== 'object' || Array.isArray(line)) continue;
      for (const field of fields) {
        if (Object.hasOwn(line, field)) return field;
      }
    }
  }
  return null;
}

/**
 * Arabic, actionable, and identical for every "not in this tenant" case.
 *
 * An unknown branch and another merchant's branch answer the same way. Telling
 * them apart would make the endpoint a probe for which shops exist, and the
 * honest caller needs the same correction either way.
 */
const MESSAGES: Readonly<Record<StockFailureReason, string>> = {
  'invalid-uuid': 'معرّف غير صالح.',
  'invalid-money': 'قيمة التكلفة غير صالحة.',
  'invalid-operation-id': 'رقم العملية غير صالح.',
  'nothing-to-value': 'لا توجد كمية موجبة مجهولة التكلفة لتقييمها.',
  'invalid-quantity': 'الكمية غير صالحة.',
  'invalid-revision': 'رقم المراجعة غير صالح.',
  'zero-delta': 'لا يمكن تسجيل تسوية بكمية صفرية.',
  'negative-count': 'الكمية المجرودة لا يمكن أن تكون بالسالب.',
  'non-positive-quantity': 'كمية التحويل يجب أن تكون أكبر من صفر.',
  'fractional-unit-quantity': 'هذا الصنف يُباع بالعدد، والكمية يجب أن تكون رقمًا صحيحًا.',
  'duplicate-product': 'لا يمكن تكرار الصنف نفسه في نفس العملية.',
  'no-lines': 'يجب إدخال صنف واحد على الأقل.',
  'too-many-lines': 'عدد الأصناف في العملية تجاوز الحد المسموح.',
  'same-branch': 'لا يمكن التحويل إلى نفس الفرع.',
  'invalid-reason': 'يجب إدخال سبب صالح للعملية.',
  'unknown-branch': 'الفرع غير موجود.',
  'inactive-branch': 'الفرع غير مفعل.',
  'unknown-product': 'الصنف غير موجود.',
  'inactive-product': 'الصنف غير مفعل.',
  'untracked-product': 'هذا الصنف لا يخضع لتتبع المخزون.',
  'insufficient-stock': 'الكمية المتوفرة في الفرع لا تكفي لإتمام العملية.',
  'stock-changed': 'تغيّر رصيد المخزون أثناء الجرد. يرجى تحديث الأرصدة وإعادة الجرد.',
  'idempotency-conflict': 'رقم العملية مستخدم لطلب مختلف.',
};

/**
 * 422 for a request that is well-formed but says something impossible.
 * 409 for a request that was lawful and lost to the state of the world —
 * a concurrent movement, an empty shelf, a reused operation id. The client
 * handles those two classes differently: one needs an edit, the other a
 * refresh and a retry.
 */
const STATUS: Readonly<Record<StockFailureReason, number>> = {
  'invalid-uuid': 422,
  'invalid-money': 422,
  'invalid-operation-id': 422,
  'nothing-to-value': 409,
  'invalid-quantity': 422,
  'invalid-revision': 422,
  'zero-delta': 422,
  'negative-count': 422,
  'non-positive-quantity': 422,
  'fractional-unit-quantity': 422,
  'duplicate-product': 422,
  'no-lines': 422,
  'too-many-lines': 422,
  'same-branch': 422,
  'invalid-reason': 422,
  'unknown-branch': 404,
  'inactive-branch': 409,
  'unknown-product': 404,
  'inactive-product': 409,
  'untracked-product': 409,
  'insufficient-stock': 409,
  'stock-changed': 409,
  'idempotency-conflict': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

export function registerInventoryAdminRoutes(
  app: FastifyInstance,
  options: { readonly service: MerchantInventoryService; readonly guards: Guards },
): void {
  const { service, guards } = options;

  function failure(
    reply: FastifyReply,
    reason: StockFailureReason,
    productId: string | null,
  ): unknown {
    return reply.code(STATUS[reason]).send({
      error: reason.replace(/-/g, '_'),
      message: MESSAGES[reason],
      ...(productId === null ? {} : { productId }),
    });
  }

  app.get(
    '/v1/admin/inventory/branches',
    { preHandler: [guards.requireSession, guards.requirePermission('inventory.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.query, FORBIDDEN_STOCK_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = branchesQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const page = await service.branches(principal, {
        limit: parsed.data.limit ?? 50,
        cursor: parsed.data.cursor ?? null,
      });
      return reply.code(200).send(page);
    },
  );

  app.get(
    '/v1/admin/inventory/balances',
    { preHandler: [guards.requireSession, guards.requirePermission('inventory.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.query, FORBIDDEN_STOCK_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = balancesQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const page = await service.balances(principal, {
        branchId: parsed.data.branchId,
        limit: parsed.data.limit ?? 50,
        cursor: parsed.data.cursor ?? null,
      });
      return reply.code(200).send(page);
    },
  );

  app.post(
    '/v1/admin/inventory/cost-bootstrap',
    { preHandler: [guards.requireSession, guards.requirePermission('inventory.cost.manage')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.body, FORBIDDEN_COST_BOOTSTRAP_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });
      const parsed = costBootstrapBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await service.bootstrapCost(principal, parsed.data);
      if (result.outcome === 'failure') {
        return failure(reply, result.reason, result.productId);
      }
      return reply.code(result.value.replayed ? 200 : 201).send(result.value);
    },
  );

  app.post(
    '/v1/admin/inventory/adjustments',
    { preHandler: [guards.requireSession, guards.requirePermission('inventory.adjust')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.body, FORBIDDEN_STOCK_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = adjustmentBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await service.adjust(principal, parsed.data);
      if (result.outcome === 'failure') {
        return failure(reply, result.reason, result.productId);
      }
      // 200 rather than 201 on a replay, because the document already existed
      // and the caller is being shown it rather than being told it was created.
      return reply.code(result.value.replayed ? 200 : 201).send(result.value);
    },
  );

  app.post(
    '/v1/admin/inventory/counts',
    { preHandler: [guards.requireSession, guards.requirePermission('inventory.adjust')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      // The count-specific list: a client that sends its own delta here is
      // trying to write the number the server exists to derive.
      const field = forbiddenField(request.body, FORBIDDEN_COUNT_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = countBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await service.count(principal, {
        operationId: parsed.data.operationId,
        branchId: parsed.data.branchId,
        reason: parsed.data.reason ?? null,
        lines: parsed.data.lines,
      });
      if (result.outcome === 'failure') {
        return failure(reply, result.reason, result.productId);
      }
      return reply.code(result.value.replayed ? 200 : 201).send(result.value);
    },
  );

  app.post(
    '/v1/admin/inventory/transfers',
    // A separate permission, not a role name. A merchant may grant moving stock
    // between branches without granting the ability to write it off (§G).
    { preHandler: [guards.requireSession, guards.requirePermission('inventory.transfer')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.body, FORBIDDEN_STOCK_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = transferBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await service.transfer(principal, {
        operationId: parsed.data.operationId,
        fromBranchId: parsed.data.fromBranchId,
        toBranchId: parsed.data.toBranchId,
        reason: parsed.data.reason ?? null,
        lines: parsed.data.lines,
      });
      if (result.outcome === 'failure') {
        return failure(reply, result.reason, result.productId);
      }
      return reply.code(result.value.replayed ? 200 : 201).send(result.value);
    },
  );
}
