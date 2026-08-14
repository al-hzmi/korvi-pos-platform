import { reconcileDrawer } from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import {
  DatabaseError,
  DrawerRefusedError,
  OperationAlreadyRecordedError,
  ShiftOpenRefusedError,
} from '../errors.js';
import { iso, isoOrNull, minor, minorOrNull, oneOf, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
import type {
  CashMovementKindRecord,
  CashMovementRecord,
  CloseShiftRequest,
  DrawerMovement,
  IdempotencyReservation,
  ManualCashMovementInput,
  OpenShiftInput,
  ShiftReconciliationRecord,
  ShiftRecord,
  ShiftRepository,
  ShiftStatusRecord,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const STATUSES: readonly ShiftStatusRecord[] = ['open', 'closed'];
const KINDS: readonly CashMovementKindRecord[] = [
  'sale',
  'refund',
  'pay-in',
  'pay-out',
  'opening-float',
];

interface MovementRow {
  id: string;
  shiftId: string;
  kind: string;
  amountMinor: bigint;
  reason: string | null;
  actorUserId: string | null;
  occurredAt: Date;
}

interface ShiftRow {
  id: string;
  tenantId: string;
  branchId: string;
  terminalId: string;
  userId: string;
  status: string;
  openingFloatMinor: bigint;
  declaredCashMinor: bigint | null;
  expectedCashMinor: bigint | null;
  varianceMinor: bigint | null;
  cashSalesMinor: bigint | null;
  cashRefundsMinor: bigint | null;
  paidInMinor: bigint | null;
  paidOutMinor: bigint | null;
  closedByUserId: string | null;
  openedAt: Date;
  closedAt: Date | null;
  cashMovements: MovementRow[];
}

/**
 * The snapshot, or nothing.
 *
 * A partial reconciliation is not representable in the database and is not
 * representable here either: either all five figures are present or the shift
 * predates this architecture and carries none.
 */
function reconciliationOf(row: ShiftRow): ShiftReconciliationRecord | null {
  if (
    row.cashSalesMinor === null ||
    row.cashRefundsMinor === null ||
    row.paidInMinor === null ||
    row.paidOutMinor === null ||
    row.declaredCashMinor === null ||
    row.expectedCashMinor === null ||
    row.varianceMinor === null
  ) {
    return null;
  }
  return {
    openingFloatMinor: minor(row.openingFloatMinor),
    cashSalesMinor: minor(row.cashSalesMinor),
    cashRefundsMinor: minor(row.cashRefundsMinor),
    paidInMinor: minor(row.paidInMinor),
    paidOutMinor: minor(row.paidOutMinor),
    expectedCashMinor: minor(row.expectedCashMinor),
    declaredCashMinor: minor(row.declaredCashMinor),
    varianceMinor: minor(row.varianceMinor),
  };
}

function movementToDomain(row: MovementRow): CashMovementRecord {
  return {
    id: row.id,
    shiftId: row.shiftId,
    kind: oneOf(KINDS, row.kind, 'cash_movements.kind'),
    amountMinor: minor(row.amountMinor),
    reason: row.reason,
    actorUserId: row.actorUserId,
    occurredAt: iso(row.occurredAt),
  };
}

function toDomain(scope: TenantScope, row: ShiftRow): ShiftRecord {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    terminalId: row.terminalId,
    userId: row.userId,
    status: oneOf(STATUSES, row.status, 'shifts.status'),
    openingFloatMinor: minor(row.openingFloatMinor),
    declaredCashMinor: minorOrNull(row.declaredCashMinor),
    expectedCashMinor: minorOrNull(row.expectedCashMinor),
    varianceMinor: minorOrNull(row.varianceMinor),
    closedByUserId: row.closedByUserId,
    openedAt: iso(row.openedAt),
    closedAt: isoOrNull(row.closedAt),
    reconciliation: reconciliationOf(row),
    movements: row.cashMovements.map(movementToDomain),
  };
}

const WITH_MOVEMENTS = {
  cashMovements: { orderBy: { occurredAt: 'asc' } },
} as const;

async function loadShift(
  tx: TransactionClient,
  tenant: string,
  id: string,
): Promise<ShiftRow | null> {
  return tx.shift.findFirst({ where: { id, tenantId: tenant }, include: WITH_MOVEMENTS });
}

/**
 * The drawer's serialization boundary.
 *
 * Every transaction that changes what is in this drawer — a cash sale, a cash
 * refund, a manual movement, the close — takes this row first. PostgreSQL then
 * decides the order, and the two possible orders are both correct: a writer
 * that gets there first is counted by the close, and one that arrives after
 * the close sees a closed shift and fails whole (ADR-0017).
 */
async function lockShift(
  tx: TransactionClient,
  tenant: string,
  shiftId: string,
): Promise<{
  status: string;
  branchId: string;
  terminalId: string;
  userId: string;
  openingFloatMinor: bigint;
}> {
  const rows = await tx.$queryRaw<
    {
      status: string;
      branchId: string;
      terminalId: string;
      userId: string;
      openingFloatMinor: bigint;
    }[]
  >`
    SELECT "status", "branchId", "terminalId", "userId", "openingFloatMinor"
      FROM "shifts"
     WHERE "id" = ${shiftId}::uuid AND "tenantId" = ${tenant}::uuid
     FOR UPDATE`;
  const shift = rows.at(0);
  if (shift === undefined) throw new DrawerRefusedError('unknown-shift');
  return shift;
}

/**
 * Reserve the operation id, or discover that somebody else already did.
 *
 * `ON CONFLICT DO NOTHING` blocks on an uncommitted conflicting row, so when
 * it returns nothing the competing transaction has definitely committed —
 * which is what makes it safe for the caller to go and read its result. Inside
 * the same transaction as the financial write, so a rollback takes the
 * reservation with it and leaves no tombstone.
 */
async function reserveOperation(
  tx: TransactionClient,
  tenant: string,
  reservation: IdempotencyReservation,
  resultType: string,
  resultId: string,
  completedAt: Date,
): Promise<void> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "idempotency_keys"
      ("id","tenantId","scope","operationId","status","resultType","resultId","requestHash","completedAt")
    VALUES (${reservation.id}::uuid, ${tenant}::uuid, ${reservation.scope}, ${reservation.operationId},
            'completed', ${resultType}, ${resultId}::uuid, ${reservation.requestHash}, ${completedAt})
    ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
    RETURNING "id"`;
  if (inserted.length === 0) throw new OperationAlreadyRecordedError(reservation.operationId);
}

export function createShiftRepository(prisma: PrismaClient): ShiftRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<ShiftRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadShift(tx, tenantParam(scope), id);
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findOpenForTerminal(scope: TenantScope, terminalId: string): Promise<ShiftRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.shift.findFirst({
          where: { terminalId, status: 'open', tenantId: tenantParam(scope) },
          orderBy: { openedAt: 'desc' },
          include: WITH_MOVEMENTS,
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findMovementById(scope: TenantScope, id: string): Promise<CashMovementRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.cashMovement.findFirst({
          where: { id, tenantId: tenantParam(scope) },
        });
        return row === null ? null : movementToDomain(row);
      });
    },

    async open(scope: TenantScope, input: OpenShiftInput): Promise<ShiftRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);

        // Two rows are taken, in this order, and the order is the whole
        // contract: **branches, then terminals**, then shifts. It is the order
        // ADR-0017 already documents for every financial path (which takes
        // branches before shifts and never touches terminals), so inserting
        // terminals between them introduces no cycle and no new deadlock.
        //
        // The terminal row is what stops two cashiers opening two shifts on one
        // till: neither is refused by a unique index, because a till
        // legitimately has many shifts over time, so the second must wait and
        // then see the first.
        //
        // The branch row is what stops an administrator standing a branch or a
        // till down in the gap between "no open shift" and "shift created".
        // Merchant administration takes the same branch row first (ADR-0019),
        // so a deactivation and an opening serialise, and whichever commits
        // second sees the other's work rather than a stale read.
        const branches = await tx.$queryRaw<{ id: string; isActive: boolean }[]>`
          SELECT "id", "isActive" FROM "branches"
           WHERE "id" = ${input.branchId}::uuid AND "tenantId" = ${tenant}::uuid
           FOR UPDATE`;
        const branch = branches.at(0);
        if (branch === undefined) throw new ShiftOpenRefusedError('unknown-terminal');

        const terminals = await tx.$queryRaw<{ branchId: string; isActive: boolean }[]>`
          SELECT "branchId", "isActive" FROM "terminals"
           WHERE "id" = ${input.terminalId}::uuid AND "tenantId" = ${tenant}::uuid
           FOR UPDATE`;
        const terminal = terminals.at(0);
        if (terminal === undefined || !terminal.isActive) {
          throw new ShiftOpenRefusedError('unknown-terminal');
        }
        if (terminal.branchId !== input.branchId) {
          // The branch comes from the terminal everywhere else; a mismatch here
          // means the caller assembled the input from two different places.
          throw new ShiftOpenRefusedError('unknown-terminal');
        }
        // A till in a branch that has been stood down cannot start trading. Said
        // as its own refusal rather than folded into "unknown terminal": the
        // till is addressable and the remedy is different.
        if (!branch.isActive) throw new ShiftOpenRefusedError('branch-inactive');

        // A till with two open shifts has no answerable cash position.
        const existing = await tx.shift.findFirst({
          where: { terminalId: input.terminalId, status: 'open', tenantId: tenant },
        });
        if (existing !== null) {
          throw new ShiftOpenRefusedError('already-open');
        }

        await tx.shift.create({
          data: {
            id: input.id,
            tenantId: tenant,
            branchId: input.branchId,
            terminalId: input.terminalId,
            userId: input.userId,
            status: 'open',
            openingFloatMinor: BigInt(input.openingFloatMinor),
            openedAt: new Date(input.openedAt),
          },
        });

        // The opening float is recorded as a movement of zero, matching the
        // domain: the float is the starting balance, not money that arrived.
        await tx.cashMovement.create({
          data: {
            id: input.openingMovementId,
            tenantId: tenant,
            shiftId: input.id,
            kind: 'opening-float',
            amountMinor: 0n,
            reason: null,
            actorUserId: input.userId,
            occurredAt: new Date(input.openedAt),
          },
        });

        const row = await loadShift(tx, tenant, input.id);
        if (row === null) {
          throw new DatabaseError('The shift just written could not be read back.');
        }
        return toDomain(scope, row);
      });
    },

    /**
     * Pay-in or pay-out, with the shift row held for the whole transaction.
     *
     * The lock is the point. A writer that read the status and then inserted
     * could be overtaken by a close between the two, and money would land in a
     * drawer that has already been counted and signed off. Holding the row
     * makes the two orders the only two outcomes: this movement commits and
     * the close that follows counts it, or the close commits first and this
     * transaction sees `closed` and fails whole.
     *
     * The reservation is taken after the shift lock, which is the order the
     * sale and return paths already use (branch, then shift, then
     * idempotency), so no two financial transactions can wait on each other.
     */
    async recordManualMovement(
      scope: TenantScope,
      input: ManualCashMovementInput,
    ): Promise<CashMovementRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const shift = await lockShift(tx, tenant, input.shiftId);

        // Addressability first, and state second. A caller who cannot address
        // this drawer must not learn from the answer whether it is open — that
        // is the difference between "no such shift" and "somebody else's shift
        // is closed", and the second is an enumeration oracle (ADR-0017).
        if (shift.branchId !== input.branchId) throw new DrawerRefusedError('branch-mismatch');
        if (shift.terminalId !== input.terminalId) {
          throw new DrawerRefusedError('terminal-mismatch');
        }
        if (shift.status !== 'open') throw new DrawerRefusedError('shift-closed');

        await reserveOperation(
          tx,
          tenant,
          input.idempotency,
          'cash-movement',
          input.id,
          new Date(input.occurredAt),
        );

        await tx.cashMovement.create({
          data: {
            id: input.id,
            tenantId: tenant,
            shiftId: input.shiftId,
            kind: input.kind,
            // Already signed by the domain. The public API took a magnitude.
            amountMinor: BigInt(input.amountMinor),
            reason: input.reason,
            // The person who performed it, which under `shift.cash-movement`
            // may be a supervisor rather than the drawer's owner (ADR-0017).
            actorUserId: input.actorUserId,
            occurredAt: new Date(input.occurredAt),
          },
        });

        const row = await tx.cashMovement.findFirst({
          where: { id: input.id, tenantId: tenant },
        });
        if (row === null) {
          throw new DatabaseError('The cash movement just written could not be read back.');
        }
        return movementToDomain(row);
      });
    },

    /**
     * The only way a shift closes.
     *
     * Everything the reconciliation is made of is read inside this
     * transaction, after the shift row is locked: the opening float from the
     * row, the categories from the movements. Nothing is accepted from the
     * caller except the physical count.
     */
    async close(scope: TenantScope, input: CloseShiftRequest): Promise<ShiftRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const shift = await lockShift(tx, tenant, input.shiftId);

        // Addressability, then state, then ownership. The order is the
        // non-enumeration rule: everything a caller could not address answers
        // identically, whatever its status.
        if (shift.branchId !== input.branchId) throw new DrawerRefusedError('branch-mismatch');
        if (shift.terminalId !== input.terminalId) {
          throw new DrawerRefusedError('terminal-mismatch');
        }
        if (shift.status !== 'open') throw new DrawerRefusedError('shift-closed');
        // One drawer, one cashier. A normal close is performed by the person
        // who owns the shift; manager force-close is a separate capability
        // this strike deliberately does not build (ADR-0017).
        if (shift.userId !== input.closedByUserId) throw new DrawerRefusedError('not-owner');

        // Read under the lock, so a sale committed a millisecond ago is
        // included exactly once and one arriving a millisecond from now waits.
        const movements = await tx.$queryRaw<{ kind: string; amountMinor: bigint }[]>`
          SELECT "kind", "amountMinor" FROM "cash_movements"
           WHERE "tenantId" = ${tenant}::uuid AND "shiftId" = ${input.shiftId}::uuid`;

        const reconciliation = reconcileDrawer(
          shift.openingFloatMinor,
          movements.map((row): DrawerMovement => ({
            kind: oneOf(KINDS, row.kind, 'cash_movements.kind'),
            amountMinor: row.amountMinor,
          })),
          BigInt(input.declaredCashMinor),
        );

        await reserveOperation(
          tx,
          tenant,
          input.idempotency,
          'shift',
          input.shiftId,
          new Date(input.closedAt),
        );

        // `status: 'open'` in the filter as well as the lock: belt and braces
        // against a close that somehow reached here twice.
        const changed = await tx.shift.updateMany({
          where: { id: input.shiftId, tenantId: tenant, status: 'open' },
          data: {
            status: 'closed',
            declaredCashMinor: reconciliation.declaredCashMinor,
            expectedCashMinor: reconciliation.expectedCashMinor,
            varianceMinor: reconciliation.varianceMinor,
            cashSalesMinor: reconciliation.cashSalesMinor,
            cashRefundsMinor: reconciliation.cashRefundsMinor,
            paidInMinor: reconciliation.paidInMinor,
            paidOutMinor: reconciliation.paidOutMinor,
            closedByUserId: input.closedByUserId,
            closedAt: new Date(input.closedAt),
          },
        });
        if (changed.count !== 1) throw new DrawerRefusedError('shift-closed');

        const row = await loadShift(tx, tenant, input.shiftId);
        if (row === null) {
          throw new DatabaseError('The shift just closed could not be read back.');
        }
        return toDomain(scope, row);
      });
    },
  };
}
