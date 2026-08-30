import { z } from 'zod';
import {
  MAX_PURCHASING_LINES,
  MAX_PURCHASING_REFERENCE,
  MAX_SUPPLIER_NAME,
  PURCHASE_ORDER_STATUSES,
  canonicalUuid,
} from '@korvi/domain';
import { MAX_PURCHASE_ORDER_PAGE, MAX_RECEIPT_PAGE, MAX_SUPPLIER_PAGE } from '@korvi/database';
import type { MerchantPurchasingService, PurchasingFailureReason } from '../purchasing/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The purchasing authority, over HTTP.
 *
 * Eight routes, three permissions, and one rule that governs all of them: the
 * browser may state *what it wants to happen*, never *what already happened*
 * and never *who is asking*. The tenant and the actor come from the session;
 * the supplier, branch, product and remaining quantity a receipt is measured
 * against all come from the locked purchase-order rows.
 *
 * The asymmetry between an order and a receipt is the point of this file. An
 * ordered quantity is a merchant's instruction and is legitimate input. A
 * *received* quantity is a consequence of a receipt and an accumulator, and
 * accepting one would let a client mark goods delivered that never arrived —
 * and, through the accumulator, mint stock (Strike 5B §9).
 *
 * There are no DELETE routes here, and that is a decision rather than an
 * omission. Purchase orders and receipts are historical evidence; a mistake is
 * corrected by a compensating operation that leaves both records standing
 * (ADR-0024 §10).
 */

/**
 * A UUID identity, canonicalized at the door.
 *
 * `z.string().uuid()` accepts `018F…A8` and `018f…a8` alike and hands both
 * through unchanged — but they are one row to PostgreSQL, so leaving the
 * casing alone would let one physical product arrive twice under two spellings
 * and defeat every downstream comparison that is about identity rather than
 * text. The rule itself lives in `@korvi/domain` and is applied by the
 * authority too; this is the same doctrine enforced at the earliest boundary,
 * not a second one.
 */
const UUID = z.string().transform((value, ctx) => {
  try {
    return canonicalUuid(value, 'id');
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be a UUID' });
    return z.NEVER;
  }
});

/** Unsigned scaled integer text. Never a JSON number: 2^53 is reachable. */
const UNSIGNED_SCALED = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,17})$/, 'must be a non-negative integer string');

/**
 * Opaque merchant text, deliberately not UUID-normalized.
 *
 * An operation id is whatever the client's retry mechanism chose to call this
 * submission. Normalizing it would change the key two retries agree on (§16).
 */
const OPERATION_ID = z.string().trim().min(1).max(120);

const REFERENCE = z.string().trim().min(1).max(MAX_PURCHASING_REFERENCE);
const SUPPLIER_NAME = z.string().trim().min(1).max(MAX_SUPPLIER_NAME);

const supplierCreateBody = z.object({ operationId: OPERATION_ID, name: SUPPLIER_NAME }).strict();

const supplierUpdateBody = z
  .object({
    operationId: OPERATION_ID,
    name: SUPPLIER_NAME.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const supplierQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_SUPPLIER_PAGE).optional(),
    cursor: UUID.optional(),
    activeOnly: z.enum(['true', 'false']).optional(),
  })
  .strict();

const purchaseOrderBody = z
  .object({
    operationId: OPERATION_ID,
    supplierId: UUID,
    branchId: UUID,
    reference: REFERENCE.nullable().optional(),
    lines: z
      .array(z.object({ productId: UUID, orderedQuantityScaled: UNSIGNED_SCALED }).strict())
      .min(1)
      .max(MAX_PURCHASING_LINES),
  })
  .strict();

const purchaseOrderQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PURCHASE_ORDER_PAGE).optional(),
    cursor: UUID.optional(),
    status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
    supplierId: UUID.optional(),
    branchId: UUID.optional(),
  })
  .strict();

const receiptBody = z
  .object({
    operationId: OPERATION_ID,
    purchaseOrderId: UUID,
    reference: REFERENCE.nullable().optional(),
    lines: z
      .array(
        z.object({ purchaseOrderLineId: UUID, acceptedQuantityScaled: UNSIGNED_SCALED }).strict(),
      )
      .min(1)
      .max(MAX_PURCHASING_LINES),
  })
  .strict();

const receiptQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(MAX_RECEIPT_PAGE).optional() })
  .strict();

/**
 * Authority the client does not get to assert, refused by name.
 *
 * `.strict()` above already rejects an unknown key, but a bare "invalid body"
 * for `tenantId` teaches an integrator nothing and hides an attempt. Naming
 * the field makes a probe legible in the logs and a mistake obvious to a
 * developer.
 *
 * `receivedQuantityScaled`, `status` and everything about the resulting stock
 * are on this list because each of them is something the server *derives*. A
 * client that sends one is trying to write a number this API exists to compute
 * from evidence.
 */
const FORBIDDEN_PURCHASING_FIELDS = [
  'tenantId',
  'tenant',
  'actorUserId',
  'userId',
  'sessionId',
  'status',
  'purchaseOrderStatus',
  'receivedQuantityScaled',
  'remainingQuantityScaled',
  'beforeReceivedQuantityScaled',
  'afterReceivedQuantityScaled',
  'beforeQuantityScaled',
  'afterQuantityScaled',
  'quantityScaled',
  'movementKind',
  'kind',
  'resultRevision',
  'currentRevision',
  'revision',
  'isFinalized',
  'occurredAt',
  'receivedAt',
  'orderedAt',
  'createdAt',
  'updatedAt',
  'auditEventId',
  'balance',
  'balances',
  'unitCostMinor',
  'costMinor',
] as const;

/**
 * A receipt may not name the supplier, the branch or the product either.
 *
 * Those three are derived from the locked purchase-order row, and a client
 * that supplies them is asking for goods to be booked somewhere other than
 * where they were ordered to. On an *order* they are legitimate input, which
 * is why this list is receipt-specific (§9).
 */
const FORBIDDEN_RECEIPT_FIELDS = [
  'supplierId',
  'branchId',
  'productId',
  ...FORBIDDEN_PURCHASING_FIELDS,
] as const;

/**
 * A supplier update may not name a second supplier.
 *
 * The path owns the identity. A body that also carried `supplierId` would be
 * two sources of truth for which supplier is being changed, and the handler
 * would have to pick one — so it is refused by name rather than left to
 * `.strict()` to reject as a generic unknown key. On an *order* body
 * `supplierId` is legitimate input, which is why this list is update-specific.
 */
const FORBIDDEN_SUPPLIER_UPDATE_FIELDS = ['supplierId', ...FORBIDDEN_PURCHASING_FIELDS] as const;

/**
 * What a *read* may not carry, which is a different question entirely.
 *
 * The list above exists to stop a client asserting authority it does not have:
 * a `status` in a mutation body is an attempt to declare an order finished, and
 * a `receivedQuantityScaled` is an attempt to mint stock. None of that applies
 * to a query string, where `status=open` is a filter over rows the caller is
 * already allowed to see and asserts nothing at all.
 *
 * Conflating the two made a legitimate filter unreachable:
 * `GET /orders?status=open` was rejected before its schema could parse it. The
 * fix is to name what a query must still never carry — identity — and nothing
 * else. Tenancy comes from the session and is enforced by RLS underneath; a
 * `tenantId` in the query string is a probe, and naming it keeps that probe
 * legible in the logs.
 *
 * Everything else a query may carry is bounded by the strict Zod schemas above,
 * which reject an unknown key, an out-of-range limit and a status outside the
 * three the lifecycle defines.
 */
const FORBIDDEN_QUERY_FIELDS = [
  'tenantId',
  'tenant',
  'actorUserId',
  'userId',
  'sessionId',
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
 * An unknown supplier and another merchant's supplier answer the same way.
 * Telling them apart would make the endpoint a probe for which merchants exist
 * and what they buy, and the honest caller needs the same correction either
 * way.
 */
const MESSAGES: Readonly<Record<PurchasingFailureReason, string>> = {
  'invalid-uuid': 'معرّف غير صالح.',
  'invalid-quantity': 'الكمية غير صالحة.',
  'non-positive-quantity': 'الكمية يجب أن تكون أكبر من صفر.',
  'fractional-unit-quantity': 'هذا الصنف يُباع بالعدد، والكمية يجب أن تكون رقمًا صحيحًا.',
  'duplicate-product': 'لا يمكن تكرار الصنف نفسه في أمر الشراء.',
  'duplicate-order-line': 'لا يمكن تكرار بند أمر الشراء نفسه في نفس الاستلام.',
  'no-lines': 'يجب إدخال بند واحد على الأقل.',
  'too-many-lines': 'عدد البنود في العملية تجاوز الحد المسموح.',
  'invalid-name': 'اسم المورد غير صالح.',
  'invalid-reference': 'الرقم المرجعي غير صالح.',
  'unknown-supplier': 'المورد غير موجود.',
  'inactive-supplier': 'المورد غير مفعل.',
  'unknown-branch': 'الفرع غير موجود.',
  'inactive-branch': 'الفرع غير مفعل.',
  'unknown-product': 'الصنف غير موجود.',
  'inactive-product': 'الصنف غير مفعل.',
  'untracked-product': 'هذا الصنف لا يخضع لتتبع المخزون.',
  'unknown-purchase-order': 'أمر الشراء غير موجود.',
  'unknown-purchase-order-line': 'بند أمر الشراء غير موجود.',
  'purchase-order-closed': 'تم استلام أمر الشراء بالكامل.',
  'over-receipt': 'الكمية المستلمة تتجاوز الكمية المتبقية في أمر الشراء.',
  'idempotency-conflict': 'رقم العملية مستخدم لطلب مختلف.',
};

/**
 * 422 for a request that is well-formed but says something impossible.
 * 404 for a named thing that is not in this tenant.
 * 409 for a request that was lawful and lost to the state of the world — a
 * concurrent receipt that spent the remaining quantity, a supplier deactivated
 * since the form was opened, a reused operation id. The client handles those
 * differently: one needs an edit, the other a refresh and a retry.
 */
const STATUS: Readonly<Record<PurchasingFailureReason, number>> = {
  'invalid-uuid': 422,
  'invalid-quantity': 422,
  'non-positive-quantity': 422,
  'fractional-unit-quantity': 422,
  'duplicate-product': 422,
  'duplicate-order-line': 422,
  'no-lines': 422,
  'too-many-lines': 422,
  'invalid-name': 422,
  'invalid-reference': 422,
  'unknown-supplier': 404,
  'inactive-supplier': 409,
  'unknown-branch': 404,
  'inactive-branch': 409,
  'unknown-product': 404,
  'inactive-product': 409,
  'untracked-product': 409,
  'unknown-purchase-order': 404,
  'unknown-purchase-order-line': 404,
  'purchase-order-closed': 409,
  'over-receipt': 409,
  'idempotency-conflict': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

export function registerPurchasingAdminRoutes(
  app: FastifyInstance,
  options: { readonly service: MerchantPurchasingService; readonly guards: Guards },
): void {
  const { service, guards } = options;

  function failure(
    reply: FastifyReply,
    reason: PurchasingFailureReason,
    subjectId: string | null,
  ): unknown {
    return reply.code(STATUS[reason]).send({
      error: reason.replace(/-/g, '_'),
      message: MESSAGES[reason],
      ...(subjectId === null ? {} : { subjectId }),
    });
  }

  // -------------------------------------------------------------------------
  // Suppliers
  // -------------------------------------------------------------------------

  app.get(
    '/v1/admin/purchasing/suppliers',
    { preHandler: [guards.requireSession, guards.requirePermission('purchasing.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.query, FORBIDDEN_QUERY_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = supplierQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const page = await service.listSuppliers(principal, {
        limit: parsed.data.limit ?? 50,
        cursor: parsed.data.cursor ?? null,
        activeOnly: parsed.data.activeOnly === 'true',
      });
      return reply.code(200).send(page);
    },
  );

  app.get<{ Params: { supplierId: string } }>(
    '/v1/admin/purchasing/suppliers/:supplierId',
    { preHandler: [guards.requireSession, guards.requirePermission('purchasing.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const parsed = z.object({ supplierId: UUID }).strict().safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_params' });

      const supplier = await service.getSupplier(principal, parsed.data.supplierId);
      // 404 for absent and for another merchant's alike: RLS has already made
      // the two indistinguishable, and so must the response.
      if (supplier === null) {
        return failure(reply, 'unknown-supplier', parsed.data.supplierId);
      }
      return reply.code(200).send(supplier);
    },
  );

  app.post(
    '/v1/admin/purchasing/suppliers',
    { preHandler: [guards.requireSession, guards.requirePermission('purchasing.manage')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.body, FORBIDDEN_PURCHASING_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = supplierCreateBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await service.createSupplier(principal, parsed.data);
      if (result.outcome === 'failure') return failure(reply, result.reason, result.subjectId);
      // 200 rather than 201 on a replay, because the supplier already existed
      // and the caller is being shown it rather than being told it was created.
      return reply
        .code(result.value.replayed ? 200 : 201)
        .send({ supplier: result.value.supplier, replayed: result.value.replayed });
    },
  );

  // PATCH, not PUT: an update states only the fields it wants changed, and a
  // full replacement would make "leave the name alone" indistinguishable from
  // "set the name to whatever the client last read".
  app.patch<{ Params: { supplierId: string } }>(
    '/v1/admin/purchasing/suppliers/:supplierId',
    { preHandler: [guards.requireSession, guards.requirePermission('purchasing.manage')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.body, FORBIDDEN_SUPPLIER_UPDATE_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const params = z.object({ supplierId: UUID }).strict().safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });

      const parsed = supplierUpdateBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await service.updateSupplier(principal, {
        operationId: parsed.data.operationId,
        // The path is the identity. Accepting one in the body as well would be
        // two sources of truth for which supplier is being changed.
        supplierId: params.data.supplierId,
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.isActive === undefined ? {} : { isActive: parsed.data.isActive }),
      });
      if (result.outcome === 'failure') return failure(reply, result.reason, result.subjectId);
      return reply
        .code(200)
        .send({ supplier: result.value.supplier, replayed: result.value.replayed });
    },
  );

  // -------------------------------------------------------------------------
  // Purchase orders
  // -------------------------------------------------------------------------

  app.get(
    '/v1/admin/purchasing/orders',
    { preHandler: [guards.requireSession, guards.requirePermission('purchasing.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.query, FORBIDDEN_QUERY_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = purchaseOrderQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const page = await service.listPurchaseOrders(principal, {
        limit: parsed.data.limit ?? 50,
        cursor: parsed.data.cursor ?? null,
        status: parsed.data.status ?? null,
        supplierId: parsed.data.supplierId ?? null,
        branchId: parsed.data.branchId ?? null,
      });
      return reply.code(200).send(page);
    },
  );

  app.get<{ Params: { purchaseOrderId: string } }>(
    '/v1/admin/purchasing/orders/:purchaseOrderId',
    { preHandler: [guards.requireSession, guards.requirePermission('purchasing.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const parsed = z.object({ purchaseOrderId: UUID }).strict().safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_params' });

      const order = await service.getPurchaseOrder(principal, parsed.data.purchaseOrderId);
      if (order === null) {
        return failure(reply, 'unknown-purchase-order', parsed.data.purchaseOrderId);
      }
      return reply.code(200).send(order);
    },
  );

  app.post(
    '/v1/admin/purchasing/orders',
    { preHandler: [guards.requireSession, guards.requirePermission('purchasing.manage')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.body, FORBIDDEN_PURCHASING_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = purchaseOrderBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await service.createPurchaseOrder(principal, {
        operationId: parsed.data.operationId,
        supplierId: parsed.data.supplierId,
        branchId: parsed.data.branchId,
        reference: parsed.data.reference ?? null,
        lines: parsed.data.lines,
      });
      if (result.outcome === 'failure') return failure(reply, result.reason, result.subjectId);
      return reply
        .code(result.value.replayed ? 200 : 201)
        .send({ order: result.value.order, replayed: result.value.replayed });
    },
  );

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  app.get<{ Params: { purchaseOrderId: string } }>(
    '/v1/admin/purchasing/orders/:purchaseOrderId/receipts',
    { preHandler: [guards.requireSession, guards.requirePermission('purchasing.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const params = z.object({ purchaseOrderId: UUID }).strict().safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });

      const query = receiptQuery.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_query' });

      // The order is read first so an unknown one answers 404 rather than an
      // empty list, which would tell a caller "this order exists and has had
      // no deliveries" about an order that is not theirs.
      const order = await service.getPurchaseOrder(principal, params.data.purchaseOrderId);
      if (order === null) {
        return failure(reply, 'unknown-purchase-order', params.data.purchaseOrderId);
      }

      const receipts = await service.listReceipts(
        principal,
        params.data.purchaseOrderId,
        query.data.limit ?? 50,
      );
      return reply.code(200).send({ receipts });
    },
  );

  app.post(
    '/v1/admin/purchasing/receipts',
    // Its own permission. Committing the shop to a purchase and asserting that
    // goods physically arrived are different acts, and only the second one
    // moves stock (§18).
    { preHandler: [guards.requireSession, guards.requirePermission('purchasing.receive')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.body, FORBIDDEN_RECEIPT_FIELDS);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = receiptBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await service.receive(principal, {
        operationId: parsed.data.operationId,
        purchaseOrderId: parsed.data.purchaseOrderId,
        reference: parsed.data.reference ?? null,
        lines: parsed.data.lines,
      });
      if (result.outcome === 'failure') return failure(reply, result.reason, result.subjectId);
      return reply.code(result.value.replayed ? 200 : 201).send(result.value);
    },
  );
}
