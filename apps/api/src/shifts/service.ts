import {
  CashMovementSignError,
  ManualAmountError,
  newId as defaultNewId,
  signedManualAmount,
  tenantId as brandTenantId,
} from '@korvi/domain';
import { DrawerRefusedError, OperationAlreadyRecordedError } from '@korvi/database';
import { fingerprintManualMovement, fingerprintShiftClose } from './fingerprint.js';
import type {
  AuditRepository,
  AuthenticatedPrincipal,
  CashMovementRecord,
  IdempotencyRepository,
  ManualMovementKind,
  ShiftReconciliationRecord,
  ShiftRecord,
  ShiftRepository,
  TenantScope,
  TerminalRepository,
} from '@korvi/domain';

/**
 * The drawer, from the server's side of the counter.
 *
 * Two operations, one rule: the server decides every figure that has financial
 * meaning. A manual movement arrives as a positive magnitude and the sign is
 * applied here; a close arrives with a physical count and nothing else, and
 * the expected cash and the variance are derived inside the transaction that
 * writes them (ADR-0017).
 *
 * The two operations differ in who may perform them, and deliberately so. A
 * close is the drawer owner reconciling their own till. A manual movement is a
 * supervisor's capability — `shift.cash-movement` belongs to manager roles —
 * so requiring the actor to be the shift's cashier would make the permission
 * useless to the only people who hold it. Accountability is preserved by
 * recording the actor separately from the owner.
 */

export type DrawerFailureReason =
  | 'branch-required'
  | 'unknown-terminal'
  | 'unknown-shift'
  | 'shift-closed'
  | 'not-shift-owner'
  | 'invalid-amount'
  | 'idempotency-conflict';

export interface DrawerFailure {
  readonly outcome: 'failure';
  readonly reason: DrawerFailureReason;
}

export interface MovementSummary {
  readonly movementId: string;
  readonly shiftId: string;
  readonly kind: string;
  /** Signed, as persisted: a pay-out is negative. */
  readonly amountMinor: string;
  readonly reason: string | null;
  readonly actorUserId: string | null;
  readonly occurredAt: string;
}

export interface MovementSuccess {
  readonly outcome: 'success';
  readonly replayed: boolean;
  readonly movement: MovementSummary;
}

export type MovementResult = MovementSuccess | DrawerFailure;

export interface CloseSummary {
  readonly shiftId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly openedByUserId: string;
  readonly closedByUserId: string | null;
  readonly status: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly reconciliation: ShiftReconciliationRecord;
}

export interface CloseSuccess {
  readonly outcome: 'success';
  readonly replayed: boolean;
  readonly shift: CloseSummary;
}

export type CloseResult = CloseSuccess | DrawerFailure;

export interface ManualMovementInput {
  readonly principal: AuthenticatedPrincipal;
  readonly operationId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly kind: ManualMovementKind;
  /** A positive magnitude. The server applies the sign. */
  readonly amountMinor: string;
  readonly reason: string;
}

export interface CloseShiftInput {
  readonly principal: AuthenticatedPrincipal;
  readonly operationId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly declaredCashMinor: string;
}

export interface DrawerDeps {
  readonly shifts: ShiftRepository;
  readonly terminals: TerminalRepository;
  readonly idempotency: IdempotencyRepository;
  readonly audit: AuditRepository;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly onAuditError?: (error: unknown) => void;
}

const MOVEMENT_SCOPE = 'cash-movement';
const CLOSE_SCOPE = 'shift-close';

function fail(reason: DrawerFailureReason): DrawerFailure {
  return { outcome: 'failure', reason };
}

function movementSummary(record: CashMovementRecord): MovementSummary {
  return {
    movementId: record.id,
    shiftId: record.shiftId,
    kind: record.kind,
    amountMinor: record.amountMinor,
    reason: record.reason,
    actorUserId: record.actorUserId,
    occurredAt: record.occurredAt,
  };
}

/**
 * The public answer, which is deliberately coarser than the internal one.
 *
 * `unknown-shift`, `branch-mismatch` and `terminal-mismatch` are three
 * different things to a developer reading a log and exactly one thing to a
 * caller: the drawer you named is not one you can address. Telling them apart
 * over HTTP would turn a guessed UUID into a probe — "this id exists somewhere
 * else in your merchant" — which is precisely the branch boundary Korvi keeps
 * everywhere else (ADR-0016, ADR-0017).
 *
 * `shift-closed` and `not-shift-owner` survive because both are only ever
 * reached for a drawer the caller *can* address: the repository proves branch
 * and terminal before it looks at status or ownership. Both are actionable —
 * one says count it again tomorrow, the other says fetch the cashier.
 */
function refusalOf(detail: DrawerRefusedError['detail']): DrawerFailureReason {
  switch (detail) {
    case 'shift-closed':
      return 'shift-closed';
    case 'not-owner':
      return 'not-shift-owner';
    default:
      return 'unknown-shift';
  }
}

export interface DrawerService {
  recordMovement(input: ManualMovementInput): Promise<MovementResult>;
  close(input: CloseShiftInput): Promise<CloseResult>;
}

export function createDrawerService(deps: DrawerDeps): DrawerService {
  const { now = () => new Date(), newId = defaultNewId, onAuditError = () => undefined } = deps;

  const scopeOf = (principal: AuthenticatedPrincipal): TenantScope => ({
    tenantId: brandTenantId(principal.tenantId),
  });

  /** Exists, active, and in the session's own branch. One answer for all three. */
  async function ownBranchTerminal(
    principal: AuthenticatedPrincipal,
    terminalId: string,
  ): Promise<{ id: string; branchId: string } | null> {
    const terminal = await deps.terminals.findById(scopeOf(principal), terminalId);
    if (terminal === null || !terminal.isActive) return null;
    if (terminal.branchId !== principal.branchId) return null;
    return { id: terminal.id, branchId: terminal.branchId };
  }

  function closeSummary(shift: ShiftRecord): CloseSummary | null {
    if (shift.reconciliation === null) return null;
    return {
      shiftId: shift.id,
      branchId: shift.branchId,
      terminalId: shift.terminalId,
      openedByUserId: shift.userId,
      closedByUserId: shift.closedByUserId,
      status: shift.status,
      openedAt: shift.openedAt,
      closedAt: shift.closedAt,
      reconciliation: shift.reconciliation,
    };
  }

  return {
    async recordMovement(input: ManualMovementInput): Promise<MovementResult> {
      const scope = scopeOf(input.principal);
      if (input.principal.branchId === null) return fail('branch-required');

      let signed: bigint;
      try {
        signed = signedManualAmount(input.kind, BigInt(input.amountMinor));
      } catch (error) {
        if (error instanceof ManualAmountError || error instanceof CashMovementSignError) {
          return fail('invalid-amount');
        }
        throw error;
      }

      const terminal = await ownBranchTerminal(input.principal, input.terminalId);
      if (terminal === null) return fail('unknown-terminal');

      const reason = input.reason.trim();
      const intentHash = fingerprintManualMovement({
        // Both server-owned: the session's user, and the branch the terminal
        // lookup proved. Neither can be sent by a client.
        actorUserId: input.principal.userId,
        branchId: terminal.branchId,
        shiftId: input.shiftId,
        terminalId: input.terminalId,
        kind: input.kind,
        amountMinor: input.amountMinor,
        reason,
      });

      const replay = await replayMovement(scope, input.operationId, intentHash);
      if (replay !== null) return replay;

      const occurredAt = now().toISOString();
      const movementId = newId();
      let recorded: CashMovementRecord;
      try {
        recorded = await deps.shifts.recordManualMovement(scope, {
          id: movementId,
          shiftId: input.shiftId,
          terminalId: terminal.id,
          // From the session's terminal, never from the request body.
          branchId: terminal.branchId,
          kind: input.kind,
          amountMinor: signed.toString(),
          reason,
          // The person performing it. Under `shift.cash-movement` this may be
          // a supervisor rather than the drawer's own cashier.
          actorUserId: input.principal.userId,
          occurredAt,
          idempotency: {
            id: newId(),
            scope: MOVEMENT_SCOPE,
            operationId: input.operationId,
            requestHash: intentHash,
          },
        });
      } catch (error) {
        if (error instanceof DrawerRefusedError) {
          // A drawer that closed while this was in flight may have closed
          // *after* committing this very movement, or a competing retry of it.
          // Reading the reservation is what tells a lawful replay apart from a
          // movement that genuinely arrived too late.
          const competing = await replayMovement(scope, input.operationId, intentHash);
          return competing ?? fail(refusalOf(error.detail));
        }
        if (error instanceof OperationAlreadyRecordedError) {
          const competing = await replayMovement(scope, input.operationId, intentHash);
          return competing ?? fail('idempotency-conflict');
        }
        throw error;
      }

      try {
        await deps.audit.append(scope, {
          id: newId(),
          actorUserId: input.principal.userId,
          branchId: terminal.branchId,
          terminalId: terminal.id,
          eventType: 'shift.cash-movement',
          entityType: 'cash_movement',
          entityId: recorded.id,
          metadata: {
            shiftId: input.shiftId,
            kind: input.kind,
            amountMinor: recorded.amountMinor,
            reason,
          },
          occurredAt,
        });
      } catch (error) {
        onAuditError(error);
      }

      return { outcome: 'success', replayed: false, movement: movementSummary(recorded) };
    },

    async close(input: CloseShiftInput): Promise<CloseResult> {
      const scope = scopeOf(input.principal);
      if (input.principal.branchId === null) return fail('branch-required');

      const terminal = await ownBranchTerminal(input.principal, input.terminalId);
      if (terminal === null) return fail('unknown-terminal');

      const intentHash = fingerprintShiftClose({
        actorUserId: input.principal.userId,
        branchId: terminal.branchId,
        shiftId: input.shiftId,
        terminalId: input.terminalId,
        declaredCashMinor: input.declaredCashMinor,
      });

      const replay = await replayClose(scope, input.operationId, intentHash);
      if (replay !== null) return replay;

      const closedAt = now().toISOString();
      let closed: ShiftRecord;
      try {
        closed = await deps.shifts.close(scope, {
          shiftId: input.shiftId,
          terminalId: terminal.id,
          branchId: terminal.branchId,
          closedByUserId: input.principal.userId,
          declaredCashMinor: input.declaredCashMinor,
          closedAt,
          idempotency: {
            id: newId(),
            scope: CLOSE_SCOPE,
            operationId: input.operationId,
            requestHash: intentHash,
          },
        });
      } catch (error) {
        if (error instanceof DrawerRefusedError) {
          // The drawer is closed — which may be because *this* operation closed
          // it a moment ago on another connection. An identical retry must
          // replay the snapshot rather than be told it arrived too late.
          const competing = await replayClose(scope, input.operationId, intentHash);
          return competing ?? fail(refusalOf(error.detail));
        }
        if (error instanceof OperationAlreadyRecordedError) {
          const competing = await replayClose(scope, input.operationId, intentHash);
          return competing ?? fail('idempotency-conflict');
        }
        throw error;
      }

      const summary = closeSummary(closed);
      if (summary === null) {
        throw new Error('A close committed without a reconciliation. Refusing to report it.');
      }

      try {
        await deps.audit.append(scope, {
          id: newId(),
          actorUserId: input.principal.userId,
          branchId: closed.branchId,
          terminalId: closed.terminalId,
          eventType: 'shift.closed',
          entityType: 'shift',
          entityId: closed.id,
          metadata: {
            openedByUserId: closed.userId,
            openingFloatMinor: summary.reconciliation.openingFloatMinor,
            cashSalesMinor: summary.reconciliation.cashSalesMinor,
            cashRefundsMinor: summary.reconciliation.cashRefundsMinor,
            paidInMinor: summary.reconciliation.paidInMinor,
            paidOutMinor: summary.reconciliation.paidOutMinor,
            expectedCashMinor: summary.reconciliation.expectedCashMinor,
            declaredCashMinor: summary.reconciliation.declaredCashMinor,
            varianceMinor: summary.reconciliation.varianceMinor,
          },
          occurredAt: closedAt,
        });
      } catch (error) {
        onAuditError(error);
      }

      return { outcome: 'success', replayed: false, shift: summary };
    },
  };

  /**
   * Answer a request whose operation id already belongs to a committed
   * transaction, or report that nothing does.
   *
   * Reached from two directions — the pre-flight read and losing the
   * ON CONFLICT race — and both need the same answer.
   */
  async function replayMovement(
    scope: TenantScope,
    operationId: string,
    intentHash: string,
  ): Promise<MovementResult | null> {
    const reserved = await deps.idempotency.find(scope, MOVEMENT_SCOPE, operationId);
    if (reserved === null) return null;
    // The same key with a different amount, kind or reason is not a retry.
    if (reserved.requestHash !== intentHash) return fail('idempotency-conflict');
    if (reserved.resultId === null) return fail('idempotency-conflict');

    const movement = await deps.shifts.findMovementById(scope, reserved.resultId);
    // Reserved but nothing to show for it: the competitor rolled back after
    // all. Retrying could write a second movement, so the honest answer is a
    // conflict.
    if (movement === null) return fail('idempotency-conflict');
    return { outcome: 'success', replayed: true, movement: movementSummary(movement) };
  }

  async function replayClose(
    scope: TenantScope,
    operationId: string,
    intentHash: string,
  ): Promise<CloseResult | null> {
    const reserved = await deps.idempotency.find(scope, CLOSE_SCOPE, operationId);
    if (reserved === null) return null;
    // A different declared count under the same key is a different close.
    if (reserved.requestHash !== intentHash) return fail('idempotency-conflict');
    if (reserved.resultId === null) return fail('idempotency-conflict');

    const shift = await deps.shifts.findById(scope, reserved.resultId);
    if (shift === null) return fail('idempotency-conflict');
    const summary = closeSummary(shift);
    // The original snapshot, unchanged and not recomputed.
    if (summary === null) return fail('idempotency-conflict');
    return { outcome: 'success', replayed: true, shift: summary };
  }
}
