import { withTenant } from '../tenant-context.js';
import { InsufficientStockError } from '../errors.js';
import {
  commitMovementCostWithin,
  lockCostBalanceWithin,
  prepareMovementCost,
} from '../costing/ledger.js';
import { minor, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
import type { IncomingCostBasis, MovementCostEvidence } from '../costing/ledger.js';
import type {
  InventoryBalance,
  InventoryMovementInput,
  InventoryRepository,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

interface BalanceRow {
  tenantId: string;
  branchId: string;
  productId: string;
  quantityScaled: bigint;
  revision: bigint;
}

export interface AppliedMovementRow extends BalanceRow {
  readonly cost: MovementCostEvidence;
}

function toDomain(scope: TenantScope, row: BalanceRow): InventoryBalance {
  return {
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    productId: row.productId,
    quantityScaled: minor(row.quantityScaled),
    // Decimal integer string, never a Number: a revision is a counter that a
    // count submits back to us, and 2^53 is not a boundary worth discovering
    // in a merchant's data (ADR-0024 §A).
    revision: row.revision.toString(),
  };
}

/**
 * Materialize the natural balance key at zero and hold it for the remainder of
 * the caller's transaction. Materializing an absent row is not a stock change:
 * quantity and revision both remain zero until the causal movement below.
 */
async function lockBalanceWithin(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
  productId: string,
): Promise<BalanceRow> {
  await tx.$executeRaw`
    INSERT INTO "inventory_balances"
      ("tenantId","branchId","productId","quantityScaled","revision","updatedAt")
    VALUES (${tenant}::uuid, ${branchId}::uuid, ${productId}::uuid, 0, 0, now())
    ON CONFLICT ("tenantId","branchId","productId") DO NOTHING`;

  const rows = await tx.$queryRaw<{ quantityScaled: bigint; revision: bigint }[]>`
    SELECT "quantityScaled", "revision" FROM "inventory_balances"
     WHERE "tenantId" = ${tenant}::uuid
       AND "branchId" = ${branchId}::uuid
       AND "productId" = ${productId}::uuid
     FOR UPDATE`;
  const row = rows.at(0);
  if (row === undefined) {
    throw new Error('Inventory invariant failed: balance row could not be materialized.');
  }
  return {
    tenantId: tenant,
    branchId,
    productId,
    quantityScaled: row.quantityScaled,
    revision: row.revision,
  };
}

/**
 * Apply one stock movement inside an existing transaction.
 *
 * Strike 5C extends the old stock primitive rather than adding a second write
 * path. The stock row is locked first, then its cost row. Quantity, stock
 * revision, exact valuation pool and immutable cost evidence either all commit
 * together or all roll back together (ADR-0024 §1, §8).
 *
 * `incomingCostBasis` is accepted only for positive movements whose caller has
 * independent evidence of value (purchase receiving, original-basis return, or
 * transfer destination). A missing basis means the positive stock is explicit
 * unknown. Negative movements never accept a caller-supplied basis: they consume
 * the locked branch pool unknown-first on the server.
 */
export async function applyMovementWithin(
  tx: TransactionClient,
  tenant: string,
  movement: InventoryMovementInput,
  allowNegative = true,
  sourceLineId: string | null = null,
  incomingCostBasis?: IncomingCostBasis,
): Promise<AppliedMovementRow> {
  const quantity = BigInt(movement.quantityScaled);
  if (quantity === 0n) {
    throw new Error('Inventory invariant failed: zero delta is not a causal movement.');
  }

  const before = await lockBalanceWithin(
    tx,
    tenant,
    movement.branchId,
    movement.productId,
  );
  const currentCost = await lockCostBalanceWithin(
    tx,
    tenant,
    movement.branchId,
    movement.productId,
    before.revision,
  );
  const preparedCost = prepareMovementCost(
    before.quantityScaled,
    quantity,
    currentCost,
    incomingCostBasis,
  );

  await tx.inventoryMovement.create({
    data: {
      id: movement.id,
      tenantId: tenant,
      branchId: movement.branchId,
      productId: movement.productId,
      kind: movement.kind,
      quantityScaled: quantity,
      reason: movement.reason,
      sourceType: movement.sourceType,
      sourceId: movement.sourceId,
      sourceLineId,
      costKnownQuantityScaled: preparedCost.evidence.knownQuantityScaled,
      costUnknownQuantityScaled: preparedCost.evidence.unknownQuantityScaled,
      costValueMinor: preparedCost.evidence.knownValueMinor,
      costProvenance: preparedCost.evidence.provenance,
      actorUserId: movement.actorUserId,
      occurredAt: new Date(movement.occurredAt),
    },
  });

  // The predicate remains on the mutation itself even though this transaction
  // already holds the row. This is the database's independent statement of the
  // merchant's no-negative-stock policy and protects against a future caller
  // that accidentally weakens the lock discipline.
  const updated = await tx.$queryRaw<{ quantityScaled: bigint; revision: bigint }[]>`
    UPDATE "inventory_balances"
       SET "quantityScaled" = "quantityScaled" + ${quantity},
           "revision" = "revision" + 1,
           "updatedAt" = now()
     WHERE "tenantId" = ${tenant}::uuid
       AND "branchId" = ${movement.branchId}::uuid
       AND "productId" = ${movement.productId}::uuid
       AND (${allowNegative} OR "quantityScaled" + ${quantity} >= 0)
    RETURNING "quantityScaled", "revision"`;
  const after = updated.at(0);
  if (after === undefined) {
    throw new InsufficientStockError(
      'The branch does not hold enough of this product to satisfy the movement.',
    );
  }

  await commitMovementCostWithin(tx, tenant, {
    branchId: movement.branchId,
    productId: movement.productId,
    stockRevision: after.revision,
    movementId: movement.id,
    sourceType: movement.sourceType,
    sourceId: movement.sourceId,
    sourceLineId,
    actorUserId: movement.actorUserId,
    occurredAt: new Date(movement.occurredAt),
    prepared: preparedCost,
  });

  return {
    tenantId: tenant,
    branchId: movement.branchId,
    productId: movement.productId,
    quantityScaled: after.quantityScaled,
    revision: after.revision,
    cost: preparedCost.evidence,
  };
}

export function createInventoryRepository(prisma: PrismaClient): InventoryRepository {
  return {
    async balance(
      scope: TenantScope,
      branchId: string,
      productId: string,
    ): Promise<InventoryBalance | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: BalanceRow | null = await tx.inventoryBalance.findFirst({
          where: { branchId, productId, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async listBalances(
      scope: TenantScope,
      branchId: string,
      limit: number,
    ): Promise<readonly InventoryBalance[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: BalanceRow[] = await tx.inventoryBalance.findMany({
          where: { branchId, tenantId: tenantParam(scope) },
          orderBy: { productId: 'asc' },
          take: limit,
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },

    async applyMovement(
      scope: TenantScope,
      movement: InventoryMovementInput,
    ): Promise<InventoryBalance> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await applyMovementWithin(tx, tenantParam(scope), movement);
        return toDomain(scope, row);
      });
    },
  };
}
