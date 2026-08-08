import { withTenant } from '../tenant-context.js';
import { DatabaseError } from '../errors.js';
import { iso, isoOrNull, minor, minorOrNull, oneOf, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
import type {
  CashMovementKindRecord,
  CashMovementRecord,
  CloseShiftInput,
  OpenShiftInput,
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
  openedAt: Date;
  closedAt: Date | null;
  cashMovements: MovementRow[];
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
    openedAt: iso(row.openedAt),
    closedAt: isoOrNull(row.closedAt),
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

    async open(scope: TenantScope, input: OpenShiftInput): Promise<ShiftRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);

        // A till with two open shifts has no answerable cash position, so the
        // second open is refused rather than allowed to produce one.
        const existing = await tx.shift.findFirst({
          where: { terminalId: input.terminalId, status: 'open', tenantId: tenant },
        });
        if (existing !== null) {
          throw new DatabaseError(
            `Terminal ${input.terminalId} already has an open shift (${existing.id}).`,
          );
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

    async recordCashMovement(scope: TenantScope, movement: CashMovementRecord): Promise<void> {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const shift = await tx.shift.findFirst({
          where: { id: movement.shiftId, tenantId: tenant },
        });
        if (shift === null) {
          throw new DatabaseError(`No shift ${movement.shiftId} in this tenant.`);
        }
        if (shift.status !== 'open') {
          throw new DatabaseError('Cannot record a cash movement against a closed shift.');
        }
        await tx.cashMovement.create({
          data: {
            id: movement.id,
            tenantId: tenant,
            shiftId: movement.shiftId,
            kind: movement.kind,
            amountMinor: BigInt(movement.amountMinor),
            reason: movement.reason,
            actorUserId: movement.actorUserId,
            occurredAt: new Date(movement.occurredAt),
          },
        });
      });
    },

    async close(scope: TenantScope, input: CloseShiftInput): Promise<ShiftRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);

        // updateMany with status in the filter, so closing a shift twice
        // affects zero rows instead of overwriting the first declaration.
        const changed = await tx.shift.updateMany({
          where: { id: input.shiftId, tenantId: tenant, status: 'open' },
          data: {
            status: 'closed',
            declaredCashMinor: BigInt(input.declaredCashMinor),
            expectedCashMinor: BigInt(input.expectedCashMinor),
            varianceMinor: BigInt(input.varianceMinor),
            closedAt: new Date(input.closedAt),
          },
        });
        if (changed.count !== 1) {
          throw new DatabaseError(
            `Shift ${input.shiftId} is not open in this tenant; nothing was closed.`,
          );
        }

        const row = await loadShift(tx, tenant, input.shiftId);
        if (row === null) {
          throw new DatabaseError('The shift just closed could not be read back.');
        }
        return toDomain(scope, row);
      });
    },
  };
}
