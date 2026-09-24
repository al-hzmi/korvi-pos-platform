import {
  CostingCapacityError,
  DuplicateReturnLineError,
  InvalidRefundError,
  InvalidReturnQuantityError,
  NothingReturnableError,
  OverReturnError,
  ProrationError,
  ProrationMismatchError,
  UnknownSaleLineError,
  newId as defaultNewId,
  planReturn,
  tenantId as brandTenantId,
} from '@korvi/domain';
import {
  OperationAlreadyRecordedError,
  ReturnNotAllowedError,
  ShiftUnusableError,
} from '@korvi/database';
import { fingerprintReturnIntent } from './fingerprint.js';
import type {
  AuditRepository,
  AuthenticatedPrincipal,
  IdempotencyRepository,
  RecordReturnPlan,
  ReturnRecord,
  ReturnRepository,
  ReturnableLine,
  ReturnableSale,
  SaleLookupRow,
  TenantScope,
  TenderScheme,
  TerminalRepository,
  ShiftRepository,
} from '@korvi/domain';

/**
 * Returns, from the server's side of the counter.
 *
 * The engine is deliberately shaped like the checkout service beside it: the
 * same idempotency discipline, the same refusal to believe anything the
 * browser says about money, the same habit of letting the database settle
 * every race a read cannot. What differs is where the numbers come from. A
 * checkout prices a basket against the catalogue; a return prices nothing at
 * all — every halala is prorated from the sale that was already written, and
 * a price change since then is none of its business (ADR-0016).
 *
 * The UI this serves does not exist yet. That is the point: by the time it
 * does, everything that could go wrong at a counter has already been decided
 * here, where it can be tested.
 */

export type ReturnFailureReason =
  | 'sale-not-found'
  | 'return-not-allowed'
  | 'nothing-returnable'
  | 'over-return'
  | 'invalid-return-quantity'
  | 'duplicate-return-line'
  | 'unknown-sale-line'
  | 'refund-invalid'
  | 'idempotency-conflict'
  | 'no-open-shift'
  | 'shift-invalid'
  | 'unknown-terminal'
  | 'branch-required';

export interface ReturnFailure {
  readonly outcome: 'failure';
  readonly reason: ReturnFailureReason;
  readonly detail?: string;
}

export interface ReturnSummaryLine {
  readonly lineNumber: number;
  readonly saleLineId: string;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly quantityScaled: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface ReturnSummaryRefund {
  readonly kind: string;
  readonly scheme: string | null;
  readonly amountMinor: string;
  readonly reference: string | null;
}

export interface ReturnSummary {
  readonly returnId: string;
  readonly returnNumber: string;
  readonly saleId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly currency: string;
  readonly reason: string | null;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly issuedAt: string;
  readonly lines: readonly ReturnSummaryLine[];
  readonly refund: ReturnSummaryRefund | null;
}

export interface ReturnSuccess {
  readonly outcome: 'success';
  readonly replayed: boolean;
  readonly document: ReturnSummary;
}

export type ReturnResult = ReturnSuccess | ReturnFailure;

export type RefundInput =
  | { readonly kind: 'cash' }
  | { readonly kind: 'electronic'; readonly scheme: TenderScheme; readonly reference: string };

export interface ReturnLineInput {
  readonly saleLineId: string;
  readonly quantityScaled: string;
}

export interface CreateReturnInput {
  readonly principal: AuthenticatedPrincipal;
  readonly operationId: string;
  readonly terminalId: string;
  readonly saleId: string;
  readonly reason?: string | undefined;
  readonly lines: readonly ReturnLineInput[];
  readonly refund: RefundInput;
}

export interface ReturnDeps {
  readonly returns: ReturnRepository;
  readonly terminals: TerminalRepository;
  readonly shifts: ShiftRepository;
  readonly idempotency: IdempotencyRepository;
  readonly audit: AuditRepository;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly onAuditError?: (error: unknown) => void;
}

const IDEMPOTENCY_SCOPE = 'return';

function fail(reason: ReturnFailureReason, detail?: string): ReturnFailure {
  return detail === undefined
    ? { outcome: 'failure', reason }
    : { outcome: 'failure', reason, detail };
}

function summarise(record: ReturnRecord): ReturnSummary {
  return {
    returnId: record.id,
    returnNumber: record.returnNumber,
    saleId: record.saleId,
    operationId: record.operationId,
    sequence: record.sequence,
    branchId: record.branchId,
    terminalId: record.terminalId,
    shiftId: record.shiftId,
    currency: record.currency,
    reason: record.reason,
    grossMinor: record.grossMinor,
    lineDiscountMinor: record.lineDiscountMinor,
    basketDiscountMinor: record.basketDiscountMinor,
    netMinor: record.netMinor,
    vatMinor: record.vatMinor,
    totalMinor: record.totalMinor,
    issuedAt: record.issuedAt,
    lines: record.lines.map((line) => ({
      lineNumber: line.lineNumber,
      saleLineId: line.saleLineId,
      productId: line.productId,
      sku: line.sku,
      nameAr: line.nameAr,
      quantityScaled: line.quantityScaled,
      grossMinor: line.grossMinor,
      lineDiscountMinor: line.lineDiscountMinor,
      basketDiscountMinor: line.basketDiscountMinor,
      netMinor: line.netMinor,
      vatMinor: line.vatMinor,
      totalMinor: line.totalMinor,
    })),
    refund:
      record.refund === null
        ? null
        : {
            kind: record.refund.kind,
            scheme: record.refund.scheme,
            amountMinor: record.refund.amountMinor,
            // The pointer at somebody else's approval, which is what makes a
            // refund traceable. Never a card number: the API refuses one by
            // name and by value, and so does the domain.
            reference: record.refund.reference,
          },
  };
}

/** The persisted state, in the vocabulary the domain prices with. */
function toReturnableLines(state: ReturnableSale): readonly ReturnableLine[] {
  return state.lines.map((line) => ({
    saleLineId: line.saleLineId,
    lineNumber: line.lineNumber,
    productId: line.productId,
    sku: line.sku,
    nameAr: line.nameAr,
    nameEn: line.nameEn,
    productType: line.productType,
    vatBasisPoints: line.vatBasisPoints,
    soldQuantityScaled: BigInt(line.soldQuantityScaled),
    returnedQuantityScaled: BigInt(line.returnedQuantityScaled),
    original: {
      grossMinor: BigInt(line.grossMinor),
      lineDiscountMinor: BigInt(line.lineDiscountMinor),
      basketDiscountMinor: BigInt(line.basketDiscountMinor),
      netMinor: BigInt(line.netMinor),
      vatMinor: BigInt(line.vatMinor),
      totalMinor: BigInt(line.totalMinor),
    },
    refunded: {
      grossMinor: BigInt(line.refundedGrossMinor),
      netMinor: BigInt(line.refundedNetMinor),
      lineDiscountMinor: BigInt(line.refundedLineDiscountMinor),
      basketDiscountMinor: BigInt(line.refundedBasketDiscountMinor),
      vatMinor: BigInt(line.refundedVatMinor),
    },
  }));
}

export interface ReturnService {
  create(input: CreateReturnInput): Promise<ReturnResult>;
  lookup(
    principal: AuthenticatedPrincipal,
    term: string,
    limit: number,
  ): Promise<readonly SaleLookupRow[] | ReturnFailure>;
  returnable(
    principal: AuthenticatedPrincipal,
    saleId: string,
  ): Promise<ReturnableSale | ReturnFailure>;
}

export function createReturnService(deps: ReturnDeps): ReturnService {
  const { now = () => new Date(), newId = defaultNewId, onAuditError = () => undefined } = deps;

  const scopeOf = (principal: AuthenticatedPrincipal): TenantScope => ({
    tenantId: brandTenantId(principal.tenantId),
  });

  /**
   * The till this principal may act through, or nothing.
   *
   * Exists, active, and in the session's own branch. A failure of any one of
   * them is the same answer, so a cashier pinned to one branch cannot probe
   * for tills in another.
   */
  async function ownBranchTerminal(
    principal: AuthenticatedPrincipal,
    terminalId: string,
  ): Promise<{ id: string; branchId: string } | null> {
    const terminal = await deps.terminals.findById(scopeOf(principal), terminalId);
    if (terminal === null || !terminal.isActive) return null;
    if (terminal.branchId !== principal.branchId) return null;
    return { id: terminal.id, branchId: terminal.branchId };
  }

  /** Answer a request whose operation id belongs to a committed transaction. */
  async function resolveCompeting(
    scope: TenantScope,
    operationId: string,
    intentHash: string,
  ): Promise<ReturnResult> {
    const reserved = await deps.idempotency.find(scope, IDEMPOTENCY_SCOPE, operationId);
    if (reserved !== null && reserved.requestHash !== intentHash) {
      return fail('idempotency-conflict');
    }
    const existing = await deps.returns.findByOperationId(scope, operationId);
    if (existing === null) {
      // Reserved, but nothing to show for it. Retrying could refund twice, so
      // the honest answer is a conflict.
      return fail('idempotency-conflict');
    }
    return { outcome: 'success', replayed: true, document: summarise(existing) };
  }

  return {
    async lookup(principal, term, limit) {
      if (principal.branchId === null) return fail('branch-required');
      const rows = await deps.returns.lookupSales(scopeOf(principal), {
        branchId: principal.branchId,
        term,
        limit,
      });
      return rows;
    },

    async returnable(principal, saleId) {
      if (principal.branchId === null) return fail('branch-required');
      const state = await deps.returns.returnableForSale(
        scopeOf(principal),
        principal.branchId,
        saleId,
      );
      // Another branch's sale and a sale that does not exist get the same
      // answer, deliberately.
      if (state === null) return fail('sale-not-found');
      if (state.status !== 'finalized') return fail('return-not-allowed');
      return state;
    },

    async create(input: CreateReturnInput): Promise<ReturnResult> {
      const scope = scopeOf(input.principal);

      if (input.principal.branchId === null) return fail('branch-required');
      if (input.lines.length === 0) return fail('invalid-return-quantity');

      const seen = new Set<string>();
      for (const line of input.lines) {
        if (seen.has(line.saleLineId)) return fail('duplicate-return-line');
        seen.add(line.saleLineId);
      }

      const terminal = await ownBranchTerminal(input.principal, input.terminalId);
      if (terminal === null) return fail('unknown-terminal');

      // A refund has to come out of somewhere. The shift also supplies nothing
      // the client could have named — the branch is the session's and the
      // drawer is the one open on this till.
      const shift = await deps.shifts.findOpenForTerminal(scope, terminal.id);
      if (shift === null) return fail('no-open-shift');
      if (shift.userId !== input.principal.userId) return fail('shift-invalid');
      if (shift.branchId !== terminal.branchId) return fail('shift-invalid');

      const intentHash = fingerprintReturnIntent({
        saleId: input.saleId,
        terminalId: input.terminalId,
        lines: input.lines.map((line) => ({
          saleLineId: line.saleLineId,
          quantityScaled: line.quantityScaled,
        })),
        refundKind: input.refund.kind,
        refundScheme: input.refund.kind === 'electronic' ? input.refund.scheme : '',
        refundReference: input.refund.kind === 'electronic' ? input.refund.reference : '',
      });

      // Replay, before anything is computed or written.
      const reserved = await deps.idempotency.find(scope, IDEMPOTENCY_SCOPE, input.operationId);
      if (reserved !== null) {
        if (reserved.requestHash !== intentHash) return fail('idempotency-conflict');
        const existing = await deps.returns.findByOperationId(scope, input.operationId);
        if (existing !== null) {
          return { outcome: 'success', replayed: true, document: summarise(existing) };
        }
      }

      // A courtesy read, so a request that was never going to work is refused
      // without opening a transaction. It is not authority: the same numbers
      // are read again under the sale's lock, and that read is the one that
      // decides.
      const preflight = await deps.returns.returnableForSale(
        scope,
        input.principal.branchId,
        input.saleId,
      );
      if (preflight === null) return fail('sale-not-found');
      if (preflight.status !== 'finalized') return fail('return-not-allowed');

      const returnId = newId();
      const issuedAt = now().toISOString();
      const requested = input.lines.map((line) => ({
        saleLineId: line.saleLineId,
        quantityScaled: line.quantityScaled,
      }));

      let recorded: ReturnRecord;
      try {
        recorded = await deps.returns.record(scope, {
          returnId,
          saleId: input.saleId,
          operationId: input.operationId,
          branchId: terminal.branchId,
          terminalId: terminal.id,
          shiftId: shift.id,
          actorUserId: input.principal.userId,
          reason: input.reason ?? null,
          currency: preflight.currency,
          issuedAt,
          requested,
          refund: {
            id: newId(),
            kind: input.refund.kind,
            scheme: input.refund.kind === 'electronic' ? input.refund.scheme : null,
            reference: input.refund.kind === 'electronic' ? input.refund.reference : null,
          },
          lineIds: input.lines.map(() => newId()),
          inventoryIds: input.lines.map(() => newId()),
          cashMovementId: newId(),
          idempotency: {
            id: newId(),
            scope: IDEMPOTENCY_SCOPE,
            operationId: input.operationId,
            requestHash: intentHash,
          },
          /*
           * The arithmetic, run inside the transaction against rows read under
           * the sale's lock. Everything it refuses rolls the transaction back
           * before a number is issued or a halala moves.
           */
          plan: (state): RecordReturnPlan => {
            const draft = planReturn({
              available: toReturnableLines(state),
              requested: requested.map((line) => ({
                saleLineId: line.saleLineId,
                quantityScaled: BigInt(line.quantityScaled),
              })),
              refund: input.refund,
            });
            return {
              lines: draft.lines.map((line) => ({
                saleLineId: line.saleLineId,
                lineNumber: line.lineNumber,
                productId: line.productId,
                sku: line.sku,
                nameAr: line.nameAr,
                nameEn: line.nameEn,
                productType: line.productType,
                vatBasisPoints: line.vatBasisPoints,
                quantityScaled: line.quantityScaled.toString(),
                grossMinor: line.components.grossMinor.toString(),
                lineDiscountMinor: line.components.lineDiscountMinor.toString(),
                basketDiscountMinor: line.components.basketDiscountMinor.toString(),
                netMinor: line.components.netMinor.toString(),
                vatMinor: line.components.vatMinor.toString(),
                totalMinor: line.components.totalMinor.toString(),
              })),
              grossMinor: draft.grossMinor.toString(),
              lineDiscountMinor: draft.lineDiscountMinor.toString(),
              basketDiscountMinor: draft.basketDiscountMinor.toString(),
              netMinor: draft.netMinor.toString(),
              vatMinor: draft.vatMinor.toString(),
              totalMinor: draft.totalMinor.toString(),
            };
          },
        });
      } catch (error) {
        // Every one of these is a deliberate refusal. None of them reaches the
        // client as a driver error, and none of them leaves a partial return
        // behind: they are all thrown inside the transaction.
        if (error instanceof OverReturnError) return fail('over-return');
        if (error instanceof NothingReturnableError) return fail('nothing-returnable');
        if (error instanceof DuplicateReturnLineError) return fail('duplicate-return-line');
        if (error instanceof UnknownSaleLineError) return fail('unknown-sale-line');
        if (error instanceof InvalidReturnQuantityError) return fail('invalid-return-quantity');
        if (error instanceof InvalidRefundError) return fail('refund-invalid');
        if (error instanceof ProrationError || error instanceof ProrationMismatchError) {
          return fail('return-not-allowed');
        }
        if (error instanceof CostingCapacityError) return fail('return-not-allowed');
        if (error instanceof ReturnNotAllowedError) {
          return fail(error.detail === 'unknown-sale' ? 'sale-not-found' : 'return-not-allowed');
        }
        if (error instanceof ShiftUnusableError) return fail('shift-invalid');
        if (error instanceof OperationAlreadyRecordedError) {
          return resolveCompeting(scope, input.operationId, intentHash);
        }
        throw error;
      }

      // Outside the transaction, and its failure does not undo the refund: the
      // money has gone back and the customer has left by the time this runs.
      try {
        await deps.audit.append(scope, {
          id: newId(),
          actorUserId: input.principal.userId,
          branchId: recorded.branchId,
          terminalId: recorded.terminalId,
          eventType: 'sale.returned',
          entityType: 'return',
          entityId: recorded.id,
          metadata: {
            returnNumber: recorded.returnNumber,
            saleId: recorded.saleId,
            totalMinor: recorded.totalMinor,
            refundKind: recorded.refund?.kind ?? '',
            // The scheme, because a manager reviewing refunds needs the shape
            // of them. Never the reference: it belongs to somebody else's
            // system and an audit row is the most widely read table there is.
            refundScheme: recorded.refund?.scheme ?? '',
            lines: recorded.lines.length,
          },
          occurredAt: recorded.issuedAt,
        });
      } catch (error) {
        onAuditError(error);
      }

      return { outcome: 'success', replayed: false, document: summarise(recorded) };
    },
  };
}
