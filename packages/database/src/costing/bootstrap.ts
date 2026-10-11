import {
  COST_IDEMPOTENCY_SCOPES,
  bootstrapUnknownCost,
  newId,
  unknownPositiveQuantityScaled,
  validateCostBootstrapRequest,
} from '@korvi/domain';
import { CostBootstrapRefusedError } from '../errors.js';
import { withTenant } from '../tenant-context.js';
import {
  claimOperation,
  lockBalances,
  lockBranches,
  lockedOrThrow,
  lockProducts,
} from '../inventory/stock-ledger.js';
import { lockCostBalanceWithin } from './ledger.js';
import {
  readOperationSnapshot,
  snapshotObject,
  snapshotString,
  writeOperationSnapshot,
} from '../purchasing/snapshot.js';
import type { CostBootstrapRequest } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

export interface CostBootstrapActor {
  readonly tenantId: string;
  readonly userId: string;
}

export interface InventoryCostBootstrapResult {
  readonly id: string;
  readonly branchId: string;
  readonly productId: string;
  readonly valuedQuantityScaled: string;
  readonly stockRevision: string;
  readonly costRevision: string;
  readonly occurredAt: string;
  readonly replayed: boolean;
}

function fromSnapshot(value: unknown): InventoryCostBootstrapResult {
  const root = snapshotObject(value, 'inventory-cost-bootstrap-result');
  return {
    id: snapshotString(root, 'id'),
    branchId: snapshotString(root, 'branchId'),
    productId: snapshotString(root, 'productId'),
    valuedQuantityScaled: snapshotString(root, 'valuedQuantityScaled'),
    stockRevision: snapshotString(root, 'stockRevision'),
    costRevision: snapshotString(root, 'costRevision'),
    occurredAt: snapshotString(root, 'occurredAt'),
    replayed: true,
  };
}

export async function recordInventoryCostBootstrap(
  prisma: PrismaClient,
  actor: CostBootstrapActor,
  request: CostBootstrapRequest,
  requestHash: string,
  clock: () => Date = () => new Date(),
): Promise<InventoryCostBootstrapResult> {
  const plan = validateCostBootstrapRequest(request);
  const tenant = actor.tenantId;

  return withTenant(prisma, tenant, async (tx) => {
    const at = clock();
    const evidenceId = newId();
    const claim = await claimOperation(
      tx,
      tenant,
      COST_IDEMPOTENCY_SCOPES.bootstrap,
      plan.operationId,
      requestHash,
      'inventory-valuation-event',
      evidenceId,
      at,
    );
    if (claim.kind === 'replay') {
      return fromSnapshot(
        await readOperationSnapshot(
          tx,
          tenant,
          COST_IDEMPOTENCY_SCOPES.bootstrap,
          plan.operationId,
        ),
      );
    }

    // Canonical authority order: idempotency -> branch -> product -> stock
    // balance -> cost balance. The quantity to value is derived only after both
    // mutable authorities are held.
    await lockBranches(tx, tenant, [plan.branchId]);
    await lockProducts(tx, tenant, [plan.productId]);
    const balances = await lockBalances(tx, tenant, [
      { branchId: plan.branchId, productId: plan.productId },
    ]);
    const stock = lockedOrThrow(balances, {
      branchId: plan.branchId,
      productId: plan.productId,
    });
    const cost = await lockCostBalanceWithin(
      tx,
      tenant,
      plan.branchId,
      plan.productId,
      stock.revision,
    );
    const currentUnknownPositiveQuantityScaled = unknownPositiveQuantityScaled(
      stock.quantityScaled,
      cost,
    );
    if (
      stock.revision !== plan.expectedStockRevision ||
      cost.costRevision !== plan.expectedCostRevision ||
      currentUnknownPositiveQuantityScaled !== plan.expectedUnknownPositiveQuantityScaled
    ) {
      throw new CostBootstrapRefusedError(plan.productId);
    }
    const valued = bootstrapUnknownCost(stock.quantityScaled, cost, plan.totalValueMinor);
    const nextCostRevision = cost.costRevision + 1n;

    const updated = await tx.$executeRaw`
      UPDATE "inventory_cost_balances"
         SET "knownQuantityScaled" = ${valued.knownQuantityScaled},
             "knownValueMinor" = ${valued.knownValueMinor},
             "costRevision" = ${nextCostRevision},
             "updatedAt" = now()
       WHERE "tenantId" = ${tenant}::uuid
         AND "branchId" = ${plan.branchId}::uuid
         AND "productId" = ${plan.productId}::uuid
         AND "stockRevision" = ${stock.revision}
         AND "costRevision" = ${cost.costRevision}`;
    if (updated !== 1) {
      throw new Error('Cost bootstrap invariant failed: expected one locked cost balance update.');
    }

    await tx.inventoryValuationEvent.create({
      data: {
        id: evidenceId,
        tenantId: tenant,
        branchId: plan.branchId,
        productId: plan.productId,
        eventKind: 'bootstrap',
        provenance: 'recorded',
        knownQuantityScaled: valued.valuedQuantityScaled,
        unknownQuantityScaled: 0n,
        knownValueMinor: valued.addedValueMinor,
        sourceType: 'cost-bootstrap',
        sourceId: evidenceId,
        sourceLineId: null,
        actorUserId: actor.userId,
        stockRevision: stock.revision,
        costRevision: nextCostRevision,
        occurredAt: at,
      },
    });

    await tx.auditEvent.create({
      data: {
        id: newId(),
        tenantId: tenant,
        actorUserId: actor.userId,
        branchId: plan.branchId,
        terminalId: null,
        eventType: 'inventory.cost.bootstrapped',
        entityType: 'inventory-valuation-event',
        entityId: evidenceId,
        metadata: {
          operationId: plan.operationId,
          productId: plan.productId,
          valuedQuantityScaled: valued.valuedQuantityScaled.toString(),
        },
        occurredAt: at,
      },
    });

    const result: InventoryCostBootstrapResult = {
      id: evidenceId,
      branchId: plan.branchId,
      productId: plan.productId,
      valuedQuantityScaled: valued.valuedQuantityScaled.toString(),
      stockRevision: stock.revision.toString(),
      costRevision: nextCostRevision.toString(),
      occurredAt: at.toISOString(),
      replayed: false,
    };
    await writeOperationSnapshot(
      tx,
      tenant,
      COST_IDEMPOTENCY_SCOPES.bootstrap,
      plan.operationId,
      result,
    );
    return result;
  });
}
