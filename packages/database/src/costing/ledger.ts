import {
  assertPoolFitsStock,
  consumeOutflowUnknownFirst,
  prefixAllocatedValue,
  newId,
} from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';

export type CostProvenance = 'unknown' | 'recorded' | 'mixed';

export interface IncomingCostBasis {
  readonly knownQuantityScaled: bigint;
  readonly unknownQuantityScaled: bigint;
  readonly knownValueMinor: bigint;
}

export interface MovementCostEvidence extends IncomingCostBasis {
  readonly provenance: CostProvenance;
}

export interface CostBalanceState {
  readonly knownQuantityScaled: bigint;
  readonly knownValueMinor: bigint;
  readonly stockRevision: bigint;
  readonly costRevision: bigint;
}

export interface PreparedMovementCost {
  readonly evidence: MovementCostEvidence;
  readonly nextKnownQuantityScaled: bigint;
  readonly nextKnownValueMinor: bigint;
  readonly nextCostRevision: bigint;
  readonly deficitKnownQuantityScaled: bigint;
  readonly deficitKnownValueMinor: bigint;
}

function magnitude(value: bigint): bigint {
  if (value === -(1n << 63n)) {
    throw new Error('Costing invariant failed: BIGINT_MIN has no BIGINT magnitude.');
  }
  return value < 0n ? -value : value;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function provenance(known: bigint, unknown: bigint): CostProvenance {
  if (known === 0n) return 'unknown';
  if (unknown === 0n) return 'recorded';
  return 'mixed';
}

function assertIncomingBasis(delta: bigint, basis: IncomingCostBasis): void {
  if (delta <= 0n) {
    throw new Error('Costing invariant failed: incoming cost basis requires positive movement.');
  }
  if (
    basis.knownQuantityScaled < 0n ||
    basis.unknownQuantityScaled < 0n ||
    basis.knownValueMinor < 0n
  ) {
    throw new Error('Costing invariant failed: incoming cost basis cannot be negative.');
  }
  if (basis.knownQuantityScaled + basis.unknownQuantityScaled !== delta) {
    throw new Error('Costing invariant failed: incoming cost quantities do not reconcile to movement.');
  }
  if (basis.knownQuantityScaled === 0n && basis.knownValueMinor !== 0n) {
    throw new Error('Costing invariant failed: value cannot exist without known quantity.');
  }
}

/**
 * Materialize and lock the cost row that corresponds to an already-locked stock
 * balance. A revision mismatch is an internal fault: continuing would make
 * valuation and stock describe different histories.
 */
export async function lockCostBalanceWithin(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
  productId: string,
  stockRevision: bigint,
): Promise<CostBalanceState> {
  await tx.$executeRaw`
    INSERT INTO "inventory_cost_balances"
      ("tenantId","branchId","productId","knownQuantityScaled","knownValueMinor","stockRevision","costRevision","updatedAt")
    VALUES (${tenant}::uuid, ${branchId}::uuid, ${productId}::uuid, 0, 0, ${stockRevision}, 0, now())
    ON CONFLICT ("tenantId","branchId","productId") DO NOTHING`;

  const rows = await tx.$queryRaw<CostBalanceState[]>`
    SELECT "knownQuantityScaled", "knownValueMinor", "stockRevision", "costRevision"
      FROM "inventory_cost_balances"
     WHERE "tenantId" = ${tenant}::uuid
       AND "branchId" = ${branchId}::uuid
       AND "productId" = ${productId}::uuid
     FOR UPDATE`;
  const row = rows.at(0);
  if (row === undefined) {
    throw new Error('Costing invariant failed: cost balance could not be materialized.');
  }
  if (row.stockRevision !== stockRevision) {
    throw new Error(
      `Costing invariant failed: stock revision ${stockRevision.toString()} does not match cost revision cursor ${row.stockRevision.toString()}.`,
    );
  }
  return row;
}

/** Pure derivation performed while stock + cost rows are both held. */
export function prepareMovementCost(
  stockBeforeQuantityScaled: bigint,
  deltaQuantityScaled: bigint,
  current: CostBalanceState,
  incomingBasis?: IncomingCostBasis,
): PreparedMovementCost {
  if (deltaQuantityScaled === 0n) {
    throw new Error('Costing invariant failed: a zero stock movement has no valuation event.');
  }
  assertPoolFitsStock(stockBeforeQuantityScaled, current);

  if (deltaQuantityScaled < 0n) {
    if (incomingBasis !== undefined) {
      throw new Error('Costing invariant failed: an outflow cannot carry an incoming cost basis.');
    }
    const consumed = consumeOutflowUnknownFirst(
      stockBeforeQuantityScaled,
      current,
      magnitude(deltaQuantityScaled),
    );
    const knownChanged = consumed.knownQuantityConsumedScaled > 0n;
    return {
      evidence: {
        knownQuantityScaled: consumed.knownQuantityConsumedScaled,
        unknownQuantityScaled: consumed.unknownQuantityConsumedScaled,
        knownValueMinor: consumed.knownValueConsumedMinor,
        provenance: provenance(
          consumed.knownQuantityConsumedScaled,
          consumed.unknownQuantityConsumedScaled,
        ),
      },
      nextKnownQuantityScaled: consumed.knownQuantityScaled,
      nextKnownValueMinor: consumed.knownValueMinor,
      nextCostRevision: current.costRevision + (knownChanged ? 1n : 0n),
      deficitKnownQuantityScaled: 0n,
      deficitKnownValueMinor: 0n,
    };
  }

  const basis: IncomingCostBasis = incomingBasis ?? {
    knownQuantityScaled: 0n,
    unknownQuantityScaled: deltaQuantityScaled,
    knownValueMinor: 0n,
  };
  assertIncomingBasis(deltaQuantityScaled, basis);

  // A negative stock balance represents prior quantity with no current asset.
  // Incoming unknown quantity fills that deficit first. If the deficit remains,
  // it then consumes the known segment and the same prefix allocation assigns
  // the exact known value attributable to that catch-up quantity.
  const deficit = stockBeforeQuantityScaled < 0n ? -stockBeforeQuantityScaled : 0n;
  const unknownDeficit = minimum(deficit, basis.unknownQuantityScaled);
  const remainingDeficit = deficit - unknownDeficit;
  const knownDeficit = minimum(remainingDeficit, basis.knownQuantityScaled);
  const knownDeficitValue =
    knownDeficit === 0n
      ? 0n
      : prefixAllocatedValue(
          basis.knownValueMinor,
          basis.knownQuantityScaled,
          knownDeficit,
        );

  const assetKnownQuantity = basis.knownQuantityScaled - knownDeficit;
  const assetKnownValue = basis.knownValueMinor - knownDeficitValue;
  const hasKnownEffect = basis.knownQuantityScaled > 0n;

  return {
    evidence: {
      ...basis,
      provenance: provenance(basis.knownQuantityScaled, basis.unknownQuantityScaled),
    },
    nextKnownQuantityScaled: current.knownQuantityScaled + assetKnownQuantity,
    nextKnownValueMinor: current.knownValueMinor + assetKnownValue,
    nextCostRevision: current.costRevision + (hasKnownEffect ? 1n : 0n),
    deficitKnownQuantityScaled: knownDeficit,
    deficitKnownValueMinor: knownDeficitValue,
  };
}

export interface CommitMovementCostInput {
  readonly branchId: string;
  readonly productId: string;
  readonly stockRevision: bigint;
  readonly movementId: string;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly sourceLineId: string | null;
  readonly actorUserId: string | null;
  readonly occurredAt: Date;
  readonly prepared: PreparedMovementCost;
}

/** Write the new pool and immutable evidence in the same open transaction. */
export async function commitMovementCostWithin(
  tx: TransactionClient,
  tenant: string,
  input: CommitMovementCostInput,
): Promise<void> {
  const { prepared } = input;
  const updated = await tx.$executeRaw`
    UPDATE "inventory_cost_balances"
       SET "knownQuantityScaled" = ${prepared.nextKnownQuantityScaled},
           "knownValueMinor" = ${prepared.nextKnownValueMinor},
           "stockRevision" = ${input.stockRevision},
           "costRevision" = ${prepared.nextCostRevision},
           "updatedAt" = now()
     WHERE "tenantId" = ${tenant}::uuid
       AND "branchId" = ${input.branchId}::uuid
       AND "productId" = ${input.productId}::uuid`;
  if (updated !== 1) {
    throw new Error('Costing invariant failed: expected one cost balance update.');
  }

  await tx.inventoryValuationEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      branchId: input.branchId,
      productId: input.productId,
      eventKind: 'movement',
      provenance: prepared.evidence.provenance,
      knownQuantityScaled: prepared.evidence.knownQuantityScaled,
      unknownQuantityScaled: prepared.evidence.unknownQuantityScaled,
      knownValueMinor: prepared.evidence.knownValueMinor,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceLineId: input.sourceLineId,
      actorUserId: input.actorUserId,
      stockRevision: input.stockRevision,
      costRevision: prepared.nextCostRevision,
      occurredAt: input.occurredAt,
    },
  });

  if (prepared.deficitKnownQuantityScaled > 0n) {
    await tx.inventoryValuationEvent.create({
      data: {
        id: newId(),
        tenantId: tenant,
        branchId: input.branchId,
        productId: input.productId,
        eventKind: 'deficit-catchup',
        provenance: 'recorded',
        knownQuantityScaled: prepared.deficitKnownQuantityScaled,
        unknownQuantityScaled: 0n,
        knownValueMinor: prepared.deficitKnownValueMinor,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineId: input.sourceLineId,
        actorUserId: input.actorUserId,
        stockRevision: input.stockRevision,
        costRevision: prepared.nextCostRevision,
        occurredAt: input.occurredAt,
      },
    });
  }
}
