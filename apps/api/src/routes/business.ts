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
