import { withTenant } from '../tenant-context.js';
import { minor, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
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
}

function toDomain(scope: TenantScope, row: BalanceRow): InventoryBalance {
  return {
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    productId: row.productId,
    quantityScaled: minor(row.quantityScaled),
  };
}

/**
 * Apply one stock movement inside an existing transaction.
 *
 * Exported because a checkout must record its stock movements in the same
 * transaction as the sale: stock decremented for a sale that then failed to
 * commit is how a shelf count stops matching the shop floor.
 *
 * The balance moves by `increment`, not by read-modify-write. Two terminals
 * selling the last unit of the same product at the same moment would both read
 * 1 and both write 0; `increment` makes the arithmetic happen in the database,
 * under its row lock, so the second sees 0 and can be refused.
 */
export async function applyMovementWithin(
  tx: TransactionClient,
  tenant: string,
  movement: InventoryMovementInput,
): Promise<BalanceRow> {
  const quantity = BigInt(movement.quantityScaled);

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
      actorUserId: movement.actorUserId,
      occurredAt: new Date(movement.occurredAt),
    },
  });

  return tx.inventoryBalance.upsert({
    where: {
      tenantId_branchId_productId: {
        tenantId: tenant,
        branchId: movement.branchId,
        productId: movement.productId,
      },
    },
    create: {
      tenantId: tenant,
      branchId: movement.branchId,
      productId: movement.productId,
      quantityScaled: quantity,
    },
    update: { quantityScaled: { increment: quantity } },
  });
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
