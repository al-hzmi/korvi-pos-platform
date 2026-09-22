import { createHash } from 'node:crypto';
import { StockRequestError, assertQuantityShape, newId } from '@korvi/domain';
import { InsufficientStockError, StockOperationRefusedError } from '../errors.js';
import {
  lockBalances,
  lockBranches,
  lockProducts,
  lockedOrThrow,
} from '../inventory/stock-ledger.js';
import { applyMovementWithin } from '../repositories/inventory-repository.js';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const WASTE_SCOPE = 'restaurant.waste';
const SOURCE_TYPE = 'restaurant-waste';
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_LINES = 100;
const MAX_NOTE_LENGTH = 200;

export type RestaurantWasteReason = 'waste' | 'spoilage';

export type RestaurantWasteRefusal =
  | 'restaurant-mode-required'
  | 'unknown-branch'
  | 'inactive-branch'
  | 'unknown-product'
  | 'inactive-product'
  | 'untracked-product'
  | 'invalid-quantity'
  | 'invalid-lines'
  | 'duplicate-product'
  | 'invalid-note'
  | 'insufficient-stock'
  | 'idempotency-conflict'
  | 'operation-in-progress';

export class RestaurantWasteRefusedError extends Error {
  public override readonly name = 'RestaurantWasteRefusedError';

  public constructor(public readonly detail: RestaurantWasteRefusal) {
    super('Restaurant waste refused: ' + detail);
  }
}

export interface RestaurantWasteActor {
  readonly userId: string;
}

export interface RestaurantWasteLineRequest {
  readonly productId: string;
  readonly quantityScaled: string;
}

export interface RestaurantWasteRequest {
  readonly operationId: string;
  readonly branchId: string;
  readonly reasonType: RestaurantWasteReason;
  readonly note: string | null;
  readonly lines: readonly RestaurantWasteLineRequest[];
}

export interface RestaurantWasteLineResult {
  readonly id: string;
  readonly productId: string;
  readonly quantityScaled: string;
  readonly beforeQuantityScaled: string;
  readonly afterQuantityScaled: string;
  readonly resultRevision: string;
  readonly costKnownQuantityScaled: string;
  readonly costUnknownQuantityScaled: string;
  readonly costValueMinor: string;
  readonly costProvenance: 'unknown' | 'recorded' | 'mixed';
}

export interface RestaurantWasteResult {
  readonly id: string;
  readonly branchId: string;
  readonly reasonType: RestaurantWasteReason;
  readonly note: string | null;
  readonly occurredAt: string;
  readonly replayed: boolean;
  readonly lines: readonly RestaurantWasteLineResult[];
}

interface ValidatedWasteLine {
  readonly productId: string;
  readonly quantityScaled: bigint;
}

function positiveQuantity(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) {
    throw new RestaurantWasteRefusedError('invalid-quantity');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_INT64) throw new RestaurantWasteRefusedError('invalid-quantity');
  return parsed;
}

function normalizeNote(note: string | null): string | null {
  if (note === null) return null;
  const value = note.trim();
  if (value.length === 0 || value.length > MAX_NOTE_LENGTH) {
    throw new RestaurantWasteRefusedError('invalid-note');
  }
  return value;
}

function validateLines(
  lines: readonly RestaurantWasteLineRequest[],
): readonly ValidatedWasteLine[] {
  if (lines.length === 0 || lines.length > MAX_LINES) {
    throw new RestaurantWasteRefusedError('invalid-lines');
  }
  const normalized = lines
    .map((line) => ({
      productId: line.productId.trim().toLowerCase(),
      quantityScaled: positiveQuantity(line.quantityScaled),
    }))
    .sort((left, right) =>
      left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0,
    );
  if (new Set(normalized.map((line) => line.productId)).size !== normalized.length) {
    throw new RestaurantWasteRefusedError('duplicate-product');
  }
  return normalized;
}

function fingerprint(
  actorUserId: string,
  branchId: string,
  reasonType: RestaurantWasteReason,
  note: string | null,
  lines: readonly ValidatedWasteLine[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'restaurant-waste.v1',
        actorUserId,
        branchId,
        reasonType,
        note,
        lines.map((line) => [line.productId, line.quantityScaled.toString()]),
      ]),
      'utf8',
    )
    .digest('base64url');
}

async function requireRestaurantMode(tx: TransactionClient, tenant: string): Promise<void> {
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId: tenant },
    select: { vertical: true },
  });
  if (settings?.vertical !== 'restaurant') {
    throw new RestaurantWasteRefusedError('restaurant-mode-required');
  }
}

async function reserve(
  tx: TransactionClient,
  tenant: string,
  operationId: string,
  requestHash: string,
): Promise<RestaurantWasteResult | null> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "idempotency_keys"
      ("id","tenantId","scope","operationId","status","requestHash")
    VALUES (
      ${newId()}::uuid,
      ${tenant}::uuid,
      ${WASTE_SCOPE},
      ${operationId},
      'reserved',
      ${requestHash}
    )
    ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
    RETURNING "id"`;
  if (inserted.length > 0) return null;

  const existing = await tx.idempotencyKey.findFirst({
    where: { tenantId: tenant, scope: WASTE_SCOPE, operationId },
    select: { status: true, requestHash: true, resultType: true, resultSnapshot: true },
  });
  if (existing === null) throw new RestaurantWasteRefusedError('idempotency-conflict');
  if (existing.requestHash !== requestHash) {
    throw new RestaurantWasteRefusedError('idempotency-conflict');
  }
  if (existing.status !== 'completed') {
    throw new RestaurantWasteRefusedError('operation-in-progress');
  }
  if (existing.resultType !== 'restaurant-waste' || existing.resultSnapshot === null) {
    throw new RestaurantWasteRefusedError('idempotency-conflict');
  }
  const snapshot = existing.resultSnapshot as unknown as RestaurantWasteResult;
  return { ...snapshot, replayed: true };
}

async function complete(
  tx: TransactionClient,
  tenant: string,
  operationId: string,
  result: RestaurantWasteResult,
  at: Date,
): Promise<void> {
  const changed = await tx.idempotencyKey.updateMany({
    where: { tenantId: tenant, scope: WASTE_SCOPE, operationId, status: 'reserved' },
    data: {
      status: 'completed',
      resultType: 'restaurant-waste',
      resultId: result.id,
      resultSnapshot: result as unknown as object,
      completedAt: at,
    },
  });
  if (changed.count !== 1) throw new RestaurantWasteRefusedError('idempotency-conflict');
}

function translateStock(error: unknown): never {
  if (error instanceof InsufficientStockError) {
    throw new RestaurantWasteRefusedError('insufficient-stock');
  }
  if (error instanceof StockRequestError) {
    throw new RestaurantWasteRefusedError('invalid-quantity');
  }
  if (error instanceof StockOperationRefusedError) {
    switch (error.detail) {
      case 'unknown-branch':
      case 'inactive-branch':
      case 'unknown-product':
      case 'inactive-product':
      case 'untracked-product':
      case 'insufficient-stock':
      case 'idempotency-conflict':
        throw new RestaurantWasteRefusedError(error.detail);
      case 'stock-changed':
        throw new RestaurantWasteRefusedError('idempotency-conflict');
    }
  }
  throw error;
}

export async function recordRestaurantWaste(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantWasteActor,
  request: RestaurantWasteRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<RestaurantWasteResult> {
  const tenant = tenantParam(scope);
  const branchId = request.branchId.trim().toLowerCase();
  const note = normalizeNote(request.note);
  const lines = validateLines(request.lines);
  const requestHash = fingerprint(actor.userId, branchId, request.reasonType, note, lines);

  try {
    return await withTenant(prisma, scope.tenantId, async (tx) => {
      const replay = await reserve(tx, tenant, request.operationId, requestHash);
      if (replay !== null) return replay;

      await requireRestaurantMode(tx, tenant);
      await lockBranches(tx, tenant, [branchId]);
      const products = await lockProducts(
        tx,
        tenant,
        lines.map((line) => line.productId),
      );
      for (const line of lines) {
        const fact = products.get(line.productId);
        if (fact === undefined) throw new RestaurantWasteRefusedError('unknown-product');
        assertQuantityShape(line.quantityScaled, fact.productType, 'quantityScaled');
      }

      const balances = await lockBalances(
        tx,
        tenant,
        lines.map((line) => ({ branchId, productId: line.productId })),
      );
      for (const line of lines) {
        const before = lockedOrThrow(balances, { branchId, productId: line.productId });
        if (before.quantityScaled < line.quantityScaled) {
          throw new RestaurantWasteRefusedError('insufficient-stock');
        }
      }

      const at = clock();
      const wasteId = nextId();
      await tx.restaurantWaste.create({
        data: {
          id: wasteId,
          tenantId: tenant,
          branchId,
          reasonType: request.reasonType,
          note,
          operationId: request.operationId,
          requestHash,
          actorUserId: actor.userId,
          occurredAt: at,
        },
      });

      const results: RestaurantWasteLineResult[] = [];
      for (const line of lines) {
        const before = lockedOrThrow(balances, { branchId, productId: line.productId });
        const lineId = nextId();
        const movementId = nextId();
        const applied = await applyMovementWithin(
          tx,
          tenant,
          {
            id: movementId,
            branchId,
            productId: line.productId,
            kind: 'adjustment',
            quantityScaled: (-line.quantityScaled).toString(),
            reason: request.reasonType,
            sourceType: SOURCE_TYPE,
            sourceId: wasteId,
            actorUserId: actor.userId,
            occurredAt: at.toISOString(),
          },
          false,
          lineId,
        );

        await tx.restaurantWasteLine.create({
          data: {
            id: lineId,
            tenantId: tenant,
            wasteId,
            productId: line.productId,
            quantityScaled: line.quantityScaled,
            beforeQuantityScaled: before.quantityScaled,
            afterQuantityScaled: applied.quantityScaled,
            resultRevision: applied.revision,
            costKnownQuantityScaled: applied.cost.knownQuantityScaled,
            costUnknownQuantityScaled: applied.cost.unknownQuantityScaled,
            costValueMinor: applied.cost.knownValueMinor,
            costProvenance: applied.cost.provenance,
          },
        });

        results.push({
          id: lineId,
          productId: line.productId,
          quantityScaled: line.quantityScaled.toString(),
          beforeQuantityScaled: before.quantityScaled.toString(),
          afterQuantityScaled: applied.quantityScaled.toString(),
          resultRevision: applied.revision.toString(),
          costKnownQuantityScaled: applied.cost.knownQuantityScaled.toString(),
          costUnknownQuantityScaled: applied.cost.unknownQuantityScaled.toString(),
          costValueMinor: applied.cost.knownValueMinor.toString(),
          costProvenance: applied.cost.provenance,
        });
      }

      const result: RestaurantWasteResult = {
        id: wasteId,
        branchId,
        reasonType: request.reasonType,
        note,
        occurredAt: at.toISOString(),
        replayed: false,
        lines: results,
      };

      await tx.auditEvent.create({
        data: {
          id: nextId(),
          tenantId: tenant,
          actorUserId: actor.userId,
          branchId,
          terminalId: null,
          eventType: 'restaurant.waste.recorded',
          entityType: 'restaurant-waste',
          entityId: wasteId,
          metadata: {
            reasonType: request.reasonType,
            lineCount: lines.length,
            notePresent: note !== null,
          },
          occurredAt: at,
        },
      });
      await complete(tx, tenant, request.operationId, result, at);
      return result;
    });
  } catch (error) {
    if (error instanceof RestaurantWasteRefusedError) throw error;
    return translateStock(error);
  }
}
