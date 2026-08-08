import { tenantId as brandTenantId } from '@korvi/domain';
import { ShiftOpenRefusedError } from '@korvi/database';
import {
  checkoutBody,
  currentShiftQuery,
  namesForbiddenField,
  openShiftBody,
  productQuery,
} from './validation.js';
import type { CheckoutFailureReason, CheckoutService } from '../checkout/service.js';
import type { Guards } from '../auth/guards.js';
import type {
  AuthenticatedPrincipal,
  ProductRepository,
  ShiftRepository,
  TenantScope,
  TerminalRepository,
} from '@korvi/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The cashier's server surface. Four routes, and nothing a till does not need.
 *
 * Every one of them derives the tenant from `request.auth`, which the session
 * guard filled in from the database. There is no route on which a tenant id,
 * a user id, a role or a price can arrive from the client and be believed.
 */

export interface BusinessDeps {
  readonly products: ProductRepository;
  readonly shifts: ShiftRepository;
  readonly terminals: TerminalRepository;
  readonly checkout: CheckoutService;
}

export interface BusinessRouteOptions {
  readonly deps: BusinessDeps;
  readonly guards: Guards;
  readonly newId: () => string;
}

/**
 * Arabic, because the person reading it is standing at a till.
 *
 * Each one says what to do next and nothing about why the server thinks so:
 * "المنتج غير متوفر" is actionable, and the stock figure that produced it is
 * not the customer's business.
 */
const MESSAGES: Readonly<Record<CheckoutFailureReason, string>> = {
  'empty-cart': 'لا توجد أصناف في السلة.',
  'no-open-shift': 'لا توجد وردية مفتوحة على هذا الصندوق. افتح وردية أولاً.',
  'unknown-product': 'أحد الأصناف غير موجود.',
  'product-unavailable': 'أحد الأصناف لم يعد متاحاً للبيع.',
  'invalid-quantity': 'الكمية غير صالحة لهذا الصنف.',
  'insufficient-stock': 'الكمية المطلوبة غير متوفرة في المخزون.',
  'insufficient-cash': 'المبلغ المستلم أقل من المطلوب.',
  'idempotency-conflict': 'طلب سابق بنفس المعرّف يحمل محتوى مختلفاً.',
  'duplicate-line': 'الصنف مكرر في السلة. ادمج الكمية في سطر واحد.',
  'shift-invalid': 'الوردية لم تعد صالحة لهذا الصندوق. تحقّق من الوردية.',
  'tenant-misconfigured': 'إعدادات المنشأة غير مكتملة.',
};

/** 409 for the two states a retry can resolve; 422 for a request that cannot. */
const STATUS: Readonly<Record<CheckoutFailureReason, number>> = {
  'empty-cart': 422,
  'no-open-shift': 409,
  'unknown-product': 422,
  'product-unavailable': 409,
  'invalid-quantity': 422,
  'insufficient-stock': 409,
  'insufficient-cash': 422,
  'idempotency-conflict': 409,
  'duplicate-line': 422,
  'shift-invalid': 409,
  'tenant-misconfigured': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

export function registerBusinessRoutes(app: FastifyInstance, options: BusinessRouteOptions): void {
  const { deps, guards, newId } = options;

  app.get(
    '/v1/products',
    { preHandler: [guards.requireSession, guards.requirePermission('product.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const parsed = productQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const scope = scopeOf(principal);
      const term = (parsed.data.q ?? '').trim();
      const products =
        term === ''
          ? await deps.products.list(scope, parsed.data.limit)
          : await deps.products.search(scope, { term, limit: parsed.data.limit });

      // Listing is not filtered by the repository, so an inactive product that
      // is no longer sellable is dropped here rather than offered to a cashier.
      const sellable = products.filter((product) => product.isActive);
      return reply.code(200).send({
        products: sellable.map((product) => ({
          id: product.id,
          sku: product.sku,
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          productType: product.productType,
          unitLabel: product.unitLabel,
          priceMinor: product.priceMinor,
          vatBasisPoints: Number(product.vatBasisPoints),
          primaryBarcode: product.primaryBarcode,
          trackInventory: product.trackInventory,
        })),
        limit: parsed.data.limit,
      });
    },
  );

  app.get(
    '/v1/shifts/current',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.open')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const parsed = currentShiftQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const shift = await deps.shifts.findOpenForTerminal(
        scopeOf(principal),
        parsed.data.terminalId,
      );
      if (shift === null) return reply.code(200).send({ shift: null });

      return reply.code(200).send({
        shift: {
          id: shift.id,
          branchId: shift.branchId,
          terminalId: shift.terminalId,
          userId: shift.userId,
          status: shift.status,
          openingFloatMinor: shift.openingFloatMinor,
          openedAt: shift.openedAt,
        },
      });
    },
  );

  app.post(
    '/v1/shifts/open',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.open')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      const parsed = openShiftBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const scope = scopeOf(principal);
      // The branch comes from the terminal, not from the request: a till is
      // physically in one branch and the client has no standing to say which.
      const terminal = await deps.terminals.findById(scope, parsed.data.terminalId);
      if (terminal === null || !terminal.isActive) {
        return reply.code(404).send({ error: 'unknown_terminal', message: 'الصندوق غير معروف.' });
      }

      const openedAt = new Date().toISOString();
      let shift;
      try {
        // The repository takes the terminal row's lock and re-checks for an
        // open shift while holding it, so two cashiers pressing this at the
        // same moment serialise rather than both succeeding.
        shift = await deps.shifts.open(scope, {
          id: newId(),
          branchId: terminal.branchId,
          terminalId: terminal.id,
          // The person opening the shift is whoever the session says it is.
          userId: principal.userId,
          openingFloatMinor: parsed.data.openingFloatMinor,
          openedAt,
          openingMovementId: newId(),
        });
      } catch (error) {
        if (error instanceof ShiftOpenRefusedError) {
          if (error.detail === 'already-open') {
            return reply.code(409).send({
              error: 'shift_already_open',
              message: 'توجد وردية مفتوحة على هذا الصندوق.',
            });
          }
          return reply.code(404).send({ error: 'unknown_terminal', message: 'الصندوق غير معروف.' });
        }
        throw error;
      }

      return reply.code(201).send({
        shift: {
          id: shift.id,
          branchId: shift.branchId,
          terminalId: shift.terminalId,
          userId: shift.userId,
          status: shift.status,
          openingFloatMinor: shift.openingFloatMinor,
          openedAt: shift.openedAt,
        },
      });
    },
  );

  app.post(
    '/v1/sales',
    { preHandler: [guards.requireSession, guards.requirePermission('sale.create')] },
    async (request, reply: FastifyReply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      // Rejected rather than ignored. A client that thinks it set the price
      // should be told it cannot, not left to discover it from an auditor.
      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      const parsed = checkoutBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await deps.checkout.checkout({
        principal,
        operationId: parsed.data.operationId,
        terminalId: parsed.data.terminalId,
        cashReceivedMinor: parsed.data.cashReceivedMinor,
        lines: parsed.data.lines,
      });

      if (result.outcome === 'failure') {
        request.log.info({ reason: result.reason }, 'checkout refused');
        return reply
          .code(STATUS[result.reason])
          .send({ error: result.reason, message: result.detail ?? MESSAGES[result.reason] });
      }

      // 200 rather than 201 on a replay: nothing was created this time.
      return reply
        .code(result.replayed ? 200 : 201)
        .send({ sale: result.sale, replayed: result.replayed });
    },
  );
}
