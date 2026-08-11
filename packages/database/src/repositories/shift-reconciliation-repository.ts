import { cashBreakdown, signedManualCashAmount } from '@korvi/domain';
import { ShiftReconciliationRefusedError } from '../errors.js';
import { withTenant } from '../tenant-context.js';
import { tenantParam } from './mapping.js';
import type {
  CashMovementRecord,
  ManualCashMovementInput,
  ReconcileShiftInput,
  ShiftReconciliationRecord,
  ShiftReconciliationRepository,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const movementFingerprint = (input: ManualCashMovementInput): string =>
  JSON.stringify([input.shiftId, input.terminalId, input.kind, input.amountMinor, input.reason]);
const closeFingerprint = (input: ReconcileShiftInput): string =>
  JSON.stringify([input.shiftId, input.terminalId, input.declaredCashMinor]);

async function reserve(
  tx: TransactionClient,
  tenant: string,
  id: string,
  scope: string,
  operationId: string,
  fingerprint: string,
  resultType: string,
  resultId: string,
): Promise<{ readonly replay: false } | { readonly replay: true; readonly resultId: string }> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "idempotency_keys"
      ("id","tenantId","scope","operationId","status","resultType","resultId","requestHash")
    VALUES (${id}::uuid, ${tenant}::uuid, ${scope}, ${operationId}, 'reserved',
            ${resultType}, ${resultId}::uuid, ${fingerprint})
    ON CONFLICT ("tenantId","scope","operationId") DO NOTHING RETURNING "id"`;
  if (inserted.length === 1) return { replay: false };
  const rows = await tx.$queryRaw<{ requestHash: string | null; resultId: string | null }[]>`
    SELECT "requestHash", "resultId" FROM "idempotency_keys"
     WHERE "tenantId"=${tenant}::uuid AND "scope"=${scope} AND "operationId"=${operationId}`;
  const prior = rows.at(0);
  if (
    prior?.requestHash !== fingerprint ||
    prior.resultId === null ||
    prior.resultId === undefined
  ) {
    throw new ShiftReconciliationRefusedError('idempotency-conflict');
  }
  return { replay: true, resultId: prior.resultId };
}

async function lockShift(
  tx: TransactionClient,
  tenant: string,
  input: { shiftId: string; terminalId: string; branchId: string; actorUserId: string },
): Promise<{ openingFloatMinor: bigint; status: string }> {
  const rows = await tx.$queryRaw<
    {
      openingFloatMinor: bigint;
      status: string;
      terminalId: string;
      branchId: string;
      userId: string;
    }[]
  >`SELECT "openingFloatMinor", "status", "terminalId", "branchId", "userId" FROM "shifts"
      WHERE "tenantId"=${tenant}::uuid AND "id"=${input.shiftId}::uuid FOR UPDATE`;
  const shift = rows.at(0);
  if (
    shift === undefined ||
    shift.status !== 'open' ||
    shift.terminalId !== input.terminalId ||
    shift.branchId !== input.branchId ||
    shift.userId !== input.actorUserId
  )
    throw new ShiftReconciliationRefusedError('shift-invalid');
  return shift;
}

export function createShiftReconciliationRepository(
  prisma: PrismaClient,
): ShiftReconciliationRepository {
  return {
    async recordManualMovement(
      scope: TenantScope,
      input: ManualCashMovementInput,
    ): Promise<CashMovementRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const reservation = await reserve(
          tx,
          tenant,
          input.idempotencyId,
          'shift-cash-movement',
          input.operationId,
          movementFingerprint(input),
          'cash-movement',
          input.movementId,
        );
        if (reservation.replay) {
          const existing = await tx.cashMovement.findFirst({
            where: { tenantId: tenant, id: reservation.resultId },
          });
          if (existing === null) throw new ShiftReconciliationRefusedError('shift-invalid');
          return {
            id: existing.id,
            shiftId: existing.shiftId,
            kind: input.kind,
            amountMinor: existing.amountMinor.toString(),
            reason: existing.reason,
            actorUserId: existing.actorUserId,
            occurredAt: existing.occurredAt.toISOString(),
          };
        }
        await lockShift(tx, tenant, input);
        const amountMinor = signedManualCashAmount(input.kind, BigInt(input.amountMinor));
        const movement = await tx.cashMovement.create({
          data: {
            id: input.movementId,
            tenantId: tenant,
            shiftId: input.shiftId,
            kind: input.kind,
            amountMinor,
            reason: input.reason,
            actorUserId: input.actorUserId,
            occurredAt: new Date(input.occurredAt),
          },
        });
        await tx.idempotencyKey.updateMany({
          where: { tenantId: tenant, scope: 'shift-cash-movement', operationId: input.operationId },
          data: { status: 'completed', completedAt: new Date(input.occurredAt) },
        });
        return {
          id: movement.id,
          shiftId: movement.shiftId,
          kind: input.kind,
          amountMinor: movement.amountMinor.toString(),
          reason: movement.reason,
          actorUserId: movement.actorUserId,
          occurredAt: movement.occurredAt.toISOString(),
        };
      });
    },

    async reconcile(
      scope: TenantScope,
      input: ReconcileShiftInput,
    ): Promise<ShiftReconciliationRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const reservation = await reserve(
          tx,
          tenant,
          input.idempotencyId,
          'shift-close',
          input.operationId,
          closeFingerprint(input),
          'shift',
          input.shiftId,
        );
        if (reservation.replay) return loadClosed(tx, tenant, reservation.resultId);
        const shift = await lockShift(tx, tenant, input);
        const movements = await tx.cashMovement.findMany({
          where: { tenantId: tenant, shiftId: input.shiftId },
        });
        const breakdown = cashBreakdown(
          shift.openingFloatMinor,
          movements.map((movement) => ({
            kind: movement.kind as 'sale' | 'refund' | 'pay-in' | 'pay-out' | 'opening-float',
            amountMinor: movement.amountMinor,
          })),
        );
        const declared = BigInt(input.declaredCashMinor);
        const variance = declared - breakdown.expectedCashMinor;
        await tx.shift.update({
          where: { id: input.shiftId },
          data: {
            status: 'closed',
            declaredCashMinor: declared,
            expectedCashMinor: breakdown.expectedCashMinor,
            varianceMinor: variance,
            cashSalesMinor: breakdown.cashSalesMinor,
            cashRefundsMinor: breakdown.cashRefundsMinor,
            paidInMinor: breakdown.paidInMinor,
            paidOutMinor: breakdown.paidOutMinor,
            closedByUserId: input.actorUserId,
            closedAt: new Date(input.closedAt),
          },
        });
        await tx.idempotencyKey.updateMany({
          where: { tenantId: tenant, scope: 'shift-close', operationId: input.operationId },
          data: { status: 'completed', completedAt: new Date(input.closedAt) },
        });
        return loadClosed(tx, tenant, input.shiftId);
      });
    },
  };
}

async function loadClosed(
  tx: TransactionClient,
  tenant: string,
  shiftId: string,
): Promise<ShiftReconciliationRecord> {
  const row = await tx.shift.findFirst({ where: { tenantId: tenant, id: shiftId } });
  if (
    row === null ||
    row.closedByUserId === null ||
    row.closedAt === null ||
    row.cashSalesMinor === null ||
    row.cashRefundsMinor === null ||
    row.paidInMinor === null ||
    row.paidOutMinor === null ||
    row.expectedCashMinor === null ||
    row.declaredCashMinor === null ||
    row.varianceMinor === null
  )
    throw new ShiftReconciliationRefusedError('shift-invalid');
  return {
    shiftId: row.id,
    openingFloatMinor: row.openingFloatMinor.toString(),
    cashSalesMinor: row.cashSalesMinor.toString(),
    cashRefundsMinor: row.cashRefundsMinor.toString(),
    paidInMinor: row.paidInMinor.toString(),
    paidOutMinor: row.paidOutMinor.toString(),
    expectedCashMinor: row.expectedCashMinor.toString(),
    declaredCashMinor: row.declaredCashMinor.toString(),
    varianceMinor: row.varianceMinor.toString(),
    closedAt: row.closedAt.toISOString(),
    closedByUserId: row.closedByUserId,
  };
}
