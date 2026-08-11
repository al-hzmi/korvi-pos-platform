import { tenantId as brandTenantId } from '@korvi/domain';
import { ShiftOpenRefusedError, ShiftReconciliationRefusedError } from '@korvi/database';
import {
  checkoutBody,
  closeShiftBody,
  currentShiftQuery,
  carriesCardNumber,
  namesCardField,
  namesForbiddenField,
  openShiftBody,
  manualCashMovementBody,
  productQuery,
  returnBody,
  saleIdParams,
  saleLookupQuery,
} from './validation.js';
import type { CheckoutFailureReason, CheckoutService } from '../checkout/service.js';
import type { ReturnFailureReason, ReturnService } from '../returns/service.js';
import type { Guards } from '../auth/guards.js';
import type {
  AuthenticatedPrincipal,
  DashboardRepository,
  ProductRepository,
  ShiftRepository,
  ShiftReconciliationRepository,
  TenantRepository,
  TenantScope,
  Terminal,
  TerminalRepository,
} from '@korvi/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The cashier's server surface. Five routes, and nothing a till does not need.
 *
 * Every one of them derives the tenant from `request.auth`, which the session
 * guard filled in from the database. There is no route on which a tenant id,
 * a user id, a role or a price can arrive from the client and be believed.
 */

export interface BusinessDeps {
  /** Read-only, and only for the settings the till has to render correctly. */
  readonly tenants: TenantRepository;
  readonly dashboard: DashboardRepository;
  readonly products: ProductRepository;
  readonly shifts: ShiftRepository;
  readonly shiftReconciliation?: ShiftReconciliationRepository;
  readonly terminals: TerminalRepository;
  readonly checkout: CheckoutService;
  readonly returns: ReturnService;
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
  'invalid-tender': 'بيانات الدفع غير صالحة. راجع طريقة الدفع والمبلغ.',
  'electronic-overpay': 'مبلغ الدفع الإلكتروني يتجاوز المطلوب، والباقي لا يُعاد إلا نقداً.',
  'ambiguous-payment': 'أرسل نقداً أو قائمة دفعات، لا الاثنين معاً.',
  'invalid-discount': 'الخصم غير صالح لهذه السلة.',
  'discount-not-authorized': 'الخصم المطلوب يتجاوز الحد المسموح لهذا المستخدم.',
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
  'invalid-tender': 422,
  'electronic-overpay': 422,
  'ambiguous-payment': 400,
  'invalid-discount': 422,
  // 403: the request is well-formed and the server understood it. This user
  // may not grant that much.
  'discount-not-authorized': 403,
  'idempotency-conflict': 409,
  'duplicate-line': 422,
  'shift-invalid': 409,
  'tenant-misconfigured': 409,
};

/**
 * The same discipline as a checkout's messages: what to do next, and nothing
 * about why the server thinks so. `sale-not-found` is deliberately the answer
 * for a sale in another branch as well as for one that does not exist — a
 * cashier learns nothing about the rest of the merchant from a refusal.
 */
const RETURN_MESSAGES: Readonly<Record<ReturnFailureReason, string>> = {
  'sale-not-found': 'لا توجد فاتورة بهذا الرقم في هذا الفرع.',
  'return-not-allowed': 'لا يمكن إرجاع هذه الفاتورة.',
  'nothing-returnable': 'لا يوجد ما يمكن إرجاعه من هذه الفاتورة.',
  'over-return': 'الكمية المطلوبة أكبر من المتبقي للإرجاع.',
  'invalid-return-quantity': 'كمية الإرجاع غير صالحة لهذا الصنف.',
  'duplicate-return-line': 'الصنف مكرر في طلب الإرجاع. ادمج الكمية في سطر واحد.',
  'unknown-sale-line': 'أحد الأسطر ليس ضمن هذه الفاتورة.',
  'refund-invalid': 'بيانات الاسترداد غير صالحة. راجع طريقة الاسترداد ومرجعها.',
  'idempotency-conflict': 'طلب سابق بنفس المعرّف يحمل محتوى مختلفاً.',
  'no-open-shift': 'لا توجد وردية مفتوحة على هذا الصندوق. افتح وردية أولاً.',
  'shift-invalid': 'الوردية لم تعد صالحة لهذا الصندوق. تحقّق من الوردية.',
  'unknown-terminal': 'الصندوق غير معروف.',
  'branch-required': 'لا يوجد فرع مرتبط بهذا المستخدم. راجع إعدادات المنشأة.',
};

const RETURN_STATUS: Readonly<Record<ReturnFailureReason, number>> = {
  'sale-not-found': 404,
  'return-not-allowed': 409,
  'nothing-returnable': 409,
  'over-return': 409,
  'invalid-return-quantity': 422,
  'duplicate-return-line': 422,
  'unknown-sale-line': 422,
  'refund-invalid': 422,
  'idempotency-conflict': 409,
  'no-open-shift': 409,
  'shift-invalid': 409,
  // The same 404 a till in another branch gets from every other route.
  'unknown-terminal': 404,
  'branch-required': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

/**
 * The two answers a till-addressed route may give before it does any work.
 *
 * `branch_required` is a configuration problem the merchant can fix.
 * `unknown_terminal` is deliberately the same answer for a till that does not
 * exist, a till that has been deactivated, and a till in another branch — a
 * principal pinned to branch A learns nothing about branch B from either the
 * status code or the body.
 */
const BRANCH_REQUIRED = {
  error: 'branch_required',
  message: 'لا يوجد فرع مرتبط بهذا المستخدم. راجع إعدادات المنشأة.',
} as const;

const UNKNOWN_TERMINAL = { error: 'unknown_terminal', message: 'الصندوق غير معروف.' } as const;

/**
 * Prove a terminal id is one this principal may name at all.
 *
 * The tenant scope is not enough. RLS keeps one merchant out of another
 * merchant's rows, but every branch of one merchant shares a tenant, so a
 * cashier pinned to branch A who guesses or is given a terminal id from
 * branch B is inside the scope already. Listing only their own branch's tills
 * in GET /v1/terminals shapes the interface; it does not authorise anything,
 * and an interface is not where authorisation lives.
 *
 * So every route that takes a `terminalId` proves three things here first:
 * the till exists in this tenant, it is active, and it belongs to the branch
 * the session is pinned to. A failure of any of them is indistinguishable
 * from the others.
 */
async function ownBranchTerminal(
  terminals: TerminalRepository,
  principal: AuthenticatedPrincipal,
  terminalId: string,
): Promise<Terminal | null> {
  const terminal = await terminals.findById(scopeOf(principal), terminalId);
  if (terminal === null || !terminal.isActive) return null;
  return terminal.branchId === principal.branchId ? terminal : null;
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

  /**
   * The tills of the branch this session belongs to.
   *
   * Strike 3A-1 requires a terminal id on every shift and sale route, and was
   * right to: a sale has to be attributable to a physical till. But that left
   * the browser with no lawful way to learn one, and the alternatives are all
   * worse than an endpoint — a hardcoded UUID, a constant in the frontend, or
   * a cashier typing one in.
   *
   * The branch is read from `request.auth`, never from the query. A client
   * that could name a branch could enumerate every till in the tenant, and the
   * whole point of pinning a principal to a branch is that it cannot.
   *
   * `shift.open` rather than a new permission: discovering the till is the
   * first half of opening a shift on it, and the vocabulary in
   * packages/domain/src/rbac is not something a UI strike gets to extend.
   */
  /**
   * The owner's dashboard.
   *
   * `report.read` rather than a new permission: this is the smallest read of
   * the numbers a report would show, and the vocabulary in
   * packages/domain/src/rbac is not something a UI strike gets to extend. A
   * cashier does not hold it; a manager does.
   *
   * The window is 24 rolling hours, decided here and not by the client. A
   * calendar day would need a tenant timezone Korvi does not persist, and the
   * first screen an owner sees is the wrong place to invent one.
   */
  app.get(
    '/v1/dashboard/summary',
    { preHandler: [guards.requireSession, guards.requirePermission('report.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const summary = await deps.dashboard.summary(scopeOf(principal), since);
      return reply.code(200).send(summary);
    },
  );

  app.get(
    '/v1/terminals',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.open')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      // A principal with no branch has no till to be at. Deterministic and
      // named, so the browser can render an operational message rather than
      // guessing from an empty list.
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const scope = scopeOf(principal);

      // The price mode travels with the till, and only from here. A browser
      // that guessed it would show a total the server disagrees with on every
      // tax-exclusive tenant; a browser that could *send* it would be deciding
      // how much VAT a sale carries. Read under the scope, like everything
      // else, and never accepted from a request.
      const settings = await deps.tenants.settings(scope);
      if (settings === null) {
        return reply.code(409).send({
          error: 'tenant-misconfigured',
          message: 'إعدادات المنشأة غير مكتملة.',
        });
      }

      const terminals = await deps.terminals.listForBranch(scope, principal.branchId);
      // A deactivated till is not offered. Selecting one would only produce a
      // 404 from the shift route a moment later.
      return reply.code(200).send({
        branchId: principal.branchId,
        settings: { priceMode: settings.priceMode, currency: settings.currency },
        terminals: terminals
          .filter((terminal) => terminal.isActive)
          .map((terminal) => ({
            id: terminal.id,
            code: terminal.code,
            label: terminal.label,
            branchId: terminal.branchId,
          })),
      });
    },
  );

  app.get(
    '/v1/shifts/current',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.open')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      // Branch context is mandatory for the cashier vertical. Without it there
      // is no set of tills this principal may ask about, and answering for an
      // arbitrary one is the defect this refuses.
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const parsed = currentShiftQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      // Before any shift is read. A shift row carries the branch, the cashier,
      // the opening float and the time it started — none of which a cashier in
      // another branch should be able to see.
      const terminal = await ownBranchTerminal(deps.terminals, principal, parsed.data.terminalId);
      if (terminal === null) return reply.code(404).send(UNKNOWN_TERMINAL);

      const shift = await deps.shifts.findOpenForTerminal(scopeOf(principal), terminal.id);
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

      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      const parsed = openShiftBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const scope = scopeOf(principal);
      // The branch comes from the terminal, not from the request: a till is
      // physically in one branch and the client has no standing to say which.
      // But which tills this principal may name is a separate question, and
      // opening a real shift on another branch's till is a write, not a peek.
      const terminal = await ownBranchTerminal(deps.terminals, principal, parsed.data.terminalId);
      if (terminal === null) return reply.code(404).send(UNKNOWN_TERMINAL);

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
    '/v1/shifts/cash-movements',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.cash-movement')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);
      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null)
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      const parsed = manualCashMovementBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const terminal = await ownBranchTerminal(deps.terminals, principal, parsed.data.terminalId);
      if (terminal === null) return reply.code(404).send(UNKNOWN_TERMINAL);
      if (deps.shiftReconciliation === undefined)
        return reply.code(503).send({ error: 'unavailable' });
      try {
        const movement = await deps.shiftReconciliation.recordManualMovement(scopeOf(principal), {
          idempotencyId: newId(),
          operationId: parsed.data.operationId,
          movementId: newId(),
          shiftId: parsed.data.shiftId,
          terminalId: terminal.id,
          branchId: principal.branchId,
          actorUserId: principal.userId,
          kind: parsed.data.kind,
          amountMinor: parsed.data.amountMinor,
          reason: parsed.data.reason,
          occurredAt: new Date().toISOString(),
        });
        return reply.code(201).send({ movement });
      } catch (error) {
        if (error instanceof ShiftReconciliationRefusedError) {
          return reply.code(409).send({ error: error.detail });
        }
        throw error;
      }
    },
  );

  app.post(
    '/v1/shifts/close',
    { preHandler: [guards.requireSession, guards.requirePermission('shift.close')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);
      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null)
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      const parsed = closeShiftBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const terminal = await ownBranchTerminal(deps.terminals, principal, parsed.data.terminalId);
      if (terminal === null) return reply.code(404).send(UNKNOWN_TERMINAL);
      if (deps.shiftReconciliation === undefined)
        return reply.code(503).send({ error: 'unavailable' });
      try {
        const reconciliation = await deps.shiftReconciliation.reconcile(scopeOf(principal), {
          idempotencyId: newId(),
          operationId: parsed.data.operationId,
          shiftId: parsed.data.shiftId,
          terminalId: terminal.id,
          branchId: principal.branchId,
          actorUserId: principal.userId,
          declaredCashMinor: parsed.data.declaredCashMinor,
          closedAt: new Date().toISOString(),
        });
        return reply.code(200).send({ reconciliation });
      } catch (error) {
        if (error instanceof ShiftReconciliationRefusedError) {
          return reply.code(409).send({ error: error.detail });
        }
        throw error;
      }
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
      // Cardholder data is refused by name, at any depth. Korvi records that a
      // payment was approved elsewhere; it is not in the business of holding
      // the instrument that approved it (ADR-0015).
      const cardField = namesCardField(request.body);
      if (cardField !== null) {
        return reply.code(400).send({ error: 'card_data_refused', field: cardField });
      }
      // And by value, not only by field name: a card number arrives in a field
      // called `reference` far more plausibly than in one called `pan`. The
      // response names no field and echoes nothing — a refusal that quotes the
      // number is a refusal that writes it down.
      if (carriesCardNumber(request.body)) {
        return reply.code(400).send({ error: 'card_data_refused' });
      }
      const parsed = checkoutBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await deps.checkout.checkout({
        principal,
        operationId: parsed.data.operationId,
        terminalId: parsed.data.terminalId,
        lines: parsed.data.lines,
        ...(parsed.data.cashReceivedMinor === undefined
          ? {}
          : { cashReceivedMinor: parsed.data.cashReceivedMinor }),
        ...(parsed.data.tenders === undefined ? {} : { tenders: parsed.data.tenders }),
        ...(parsed.data.basketDiscount === undefined
          ? {}
          : { basketDiscount: parsed.data.basketDiscount }),
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
  /**
   * Find the sale a customer is standing there with.
   *
   * `sale.refund` rather than a new permission: looking a sale up in order to
   * return it is the first half of returning it, and the vocabulary in
   * packages/domain/src/rbac is not something a route gets to extend.
   *
   * Branch-scoped from the session, bounded, and indexed on all three of the
   * things a cashier can read off a receipt. There is no query that lists a
   * merchant's history.
   */
  app.get(
    '/v1/sales/lookup',
    { preHandler: [guards.requireSession, guards.requirePermission('sale.refund')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const parsed = saleLookupQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const found = await deps.returns.lookup(principal, parsed.data.q, parsed.data.limit);
      if (!Array.isArray(found)) {
        const failure = found as { reason: ReturnFailureReason };
        return reply
          .code(RETURN_STATUS[failure.reason])
          .send({ error: failure.reason, message: RETURN_MESSAGES[failure.reason] });
      }

      return reply.code(200).send({ sales: found, limit: parsed.data.limit });
    },
  );

  /**
   * What is left to return on one sale.
   *
   * Read-only and truthful: a sale everything has already come back from is
   * reported as such rather than hidden, because a cashier holding the receipt
   * needs to know which of those two situations they are in. A sale in another
   * branch is answered exactly as a sale that does not exist.
   */
  app.get(
    '/v1/sales/:saleId/returnable',
    { preHandler: [guards.requireSession, guards.requirePermission('sale.refund')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      if (principal.branchId === null) return reply.code(409).send(BRANCH_REQUIRED);

      const parsed = saleIdParams.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_params' });

      const state = await deps.returns.returnable(principal, parsed.data.saleId);
      if ('outcome' in state) {
        return reply
          .code(RETURN_STATUS[state.reason])
          .send({ error: state.reason, message: RETURN_MESSAGES[state.reason] });
      }

      // Shaped here rather than sent through: a repository record is not a
      // response, and basis points cross the wire as an integer the way every
      // other Korvi route sends them.
      return reply.code(200).send({
        sale: {
          saleId: state.saleId,
          invoiceNumber: state.invoiceNumber,
          issuedAt: state.issuedAt,
          currency: state.currency,
          netMinor: state.netMinor,
          vatMinor: state.vatMinor,
          totalMinor: state.totalMinor,
          refundedTotalMinor: state.refundedTotalMinor,
          lines: state.lines.map((line) => ({
            saleLineId: line.saleLineId,
            lineNumber: line.lineNumber,
            productId: line.productId,
            sku: line.sku,
            nameAr: line.nameAr,
            nameEn: line.nameEn,
            productType: line.productType,
            vatBasisPoints: Number(line.vatBasisPoints),
            unitPriceMinor: line.unitPriceMinor,
            soldQuantityScaled: line.soldQuantityScaled,
            returnedQuantityScaled: line.returnedQuantityScaled,
            remainingQuantityScaled: line.remainingQuantityScaled,
            grossMinor: line.grossMinor,
            lineDiscountMinor: line.lineDiscountMinor,
            basketDiscountMinor: line.basketDiscountMinor,
            netMinor: line.netMinor,
            vatMinor: line.vatMinor,
            totalMinor: line.totalMinor,
          })),
        },
      });
    },
  );

  /**
   * Send goods back and put the money where it came from.
   *
   * The request carries a till and a list of lines. It does not carry a
   * branch, a shift, a cashier, a price, a VAT figure or a refund total —
   * every one of those is derived from the session and the sale that was
   * already written, and a client that tries to send one is refused by name
   * rather than quietly ignored.
   */
  app.post(
    '/v1/returns',
    { preHandler: [guards.requireSession, guards.requirePermission('sale.refund')] },
    async (request, reply: FastifyReply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const forbidden = namesForbiddenField(request.body);
      if (forbidden !== null) {
        return reply.code(400).send({ error: 'forbidden_field', field: forbidden });
      }
      // Cardholder data is refused by name and by value, at any depth, exactly
      // as it is on a checkout. A refund reference is free text, which is
      // precisely where a broken integration puts a card number (ADR-0015).
      const cardField = namesCardField(request.body);
      if (cardField !== null) {
        return reply.code(400).send({ error: 'card_data_refused', field: cardField });
      }
      if (carriesCardNumber(request.body)) {
        return reply.code(400).send({ error: 'card_data_refused' });
      }

      const parsed = returnBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await deps.returns.create({
        principal,
        operationId: parsed.data.operationId,
        terminalId: parsed.data.terminalId,
        saleId: parsed.data.saleId,
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
        lines: parsed.data.lines,
        refund: parsed.data.refund,
      });

      if (result.outcome === 'failure') {
        request.log.info({ reason: result.reason }, 'return refused');
        return reply
          .code(RETURN_STATUS[result.reason])
          .send({ error: result.reason, message: result.detail ?? RETURN_MESSAGES[result.reason] });
      }

      // 200 rather than 201 on a replay: nothing was created this time.
      return reply
        .code(result.replayed ? 200 : 201)
        .send({ return: result.document, replayed: result.replayed });
    },
  );
}
