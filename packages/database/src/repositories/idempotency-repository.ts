import { withTenant } from '../tenant-context.js';
import { isoOrNull, oneOf, scoped, tenantParam } from './mapping.js';
import type {
  IdempotencyRecord,
  IdempotencyRepository,
  IdempotencyReservation,
  IdempotencyStatus,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const STATUSES: readonly IdempotencyStatus[] = ['reserved', 'completed', 'failed'];

interface KeyRow {
  id: string;
  tenantId: string;
  scope: string;
  operationId: string;
  status: string;
  resultType: string | null;
  resultId: string | null;
  requestHash: string | null;
  completedAt: Date | null;
}

function toDomain(scope: TenantScope, row: KeyRow): IdempotencyRecord {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    scope: row.scope,
    operationId: row.operationId,
    status: oneOf(STATUSES, row.status, 'idempotency_keys.status'),
    resultType: row.resultType,
    resultId: row.resultId,
    requestHash: row.requestHash,
    completedAt: isoOrNull(row.completedAt),
  };
}

/**
 * Reservations for replayable operations.
 *
 * The reservation is created optimistically and lets the unique index decide.
 * A check-then-insert would race: two retries of the same checkout arriving
 * together would both read "not reserved" and both proceed.
 */
export function createIdempotencyRepository(prisma: PrismaClient): IdempotencyRepository {
  return {
    async find(
      scope: TenantScope,
      scopeKey: string,
      operationId: string,
    ): Promise<IdempotencyRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: KeyRow | null = await tx.idempotencyKey.findFirst({
          where: { scope: scopeKey, operationId, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async reserve(
      scope: TenantScope,
      reservation: IdempotencyReservation,
    ): Promise<IdempotencyRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: KeyRow = await tx.idempotencyKey.create({
          data: {
            id: reservation.id,
            tenantId: tenantParam(scope),
            scope: reservation.scope,
            operationId: reservation.operationId,
            status: 'reserved',
            requestHash: reservation.requestHash,
          },
        });
        return toDomain(scope, row);
      });
    },

    async complete(
      scope: TenantScope,
      scopeKey: string,
      operationId: string,
      result: { readonly resultType: string; readonly resultId: string; readonly at: string },
    ): Promise<void> {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        await tx.idempotencyKey.updateMany({
          where: {
            scope: scopeKey,
            operationId,
            tenantId: tenantParam(scope),
            status: 'reserved',
          },
          data: {
            status: 'completed',
            resultType: result.resultType,
            resultId: result.resultId,
            completedAt: new Date(result.at),
          },
        });
      });
    },
  };
}
