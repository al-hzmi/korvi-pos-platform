import {
  PURCHASING_AUDIT_EVENTS,
  PURCHASING_IDEMPOTENCY_SCOPES,
  assertPurchasingQuantityShape,
  derivePurchaseOrderStatus,
  newId,
  validatePurchaseOrderRequest,
} from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { PurchasingRefusedError } from '../errors.js';
import { claimOperation, lockBranches, lockProducts } from '../inventory/stock-ledger.js';
import { appendPurchasingAudit, inPurchasingVocabulary } from './shared.js';
import {
  readOperationSnapshot,
  snapshotNullableString,
  snapshotObject,
  snapshotRows,
  snapshotString,
  writeOperationSnapshot,
} from './snapshot.js';
import type { PurchaseOrderRequest, PurchaseOrderStatus } from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

/**
 * Purchase orders: what the merchant asked for.
 *
 * This file writes no movement and touches no balance, and that is its whole
 * contract. Ordering a hundred cases of something changes nothing on the
 * shelf — the shelf changes when the van arrives, which is `receiving.ts`.
 * A live proof asserts the counts before and after a creation are identical,
 * because "we did not mean to move stock" is not the same as "stock did not
 * move" (Strike 5B §8).
 *
 * ## Lock order
 *
 *   1. idempotency reservation
 *   2. the supplier row, `FOR SHARE`
 *   3. every branch row, `FOR SHARE`, in lexical id order
 *   4. every product row, `FOR SHARE`, in lexical id order
 *   5. predicates, against the locked rows
 *   6. writes
 *
 * A prefix of the same global class order Strike 5A established — suppliers,
 * then branches, then products, then (for receiving) balances — so no actor
 * ever reaches backwards for an earlier class and no cycle is constructible.
 * Creation stops at products because it has no business with a balance row.
 *
 * `FOR SHARE` rather than a plain read, for the reason 5A gives: a supplier
 * deactivated, a branch stood down or a product's `trackInventory` turned off
 * between the read and the insert would leave an order committed against a
 * world that no longer agrees with it. Every one of those facts is *held*
 * until this transaction commits.
 */

export interface PurchasingActor {
  readonly tenantId: string;
  readonly userId: string;
}

export interface PurchaseOrderLineRecord {
  readonly id: string;
  readonly productId: string;
  readonly orderedQuantityScaled: string;
  readonly receivedQuantityScaled: string;
  readonly remainingQuantityScaled: string;
}

export interface PurchaseOrderRecord {
  readonly id: string;
  readonly supplierId: string;
  readonly branchId: string;
  readonly reference: string | null;
  readonly status: PurchaseOrderStatus;
  readonly orderedAt: string;
  readonly lines: readonly PurchaseOrderLineRecord[];
}

export interface PurchaseOrderResult {
  readonly order: PurchaseOrderRecord;
  readonly replayed: boolean;
}

interface OrderHeaderRow {
  id: string;
  supplierId: string;
  branchId: string;
  reference: string | null;
  status: string;
  orderedAt: Date;
}

interface OrderLineRow {
  id: string;
  productId: string;
  orderedQuantityScaled: bigint;
  receivedQuantityScaled: bigint;
}

/**
 * The stored status, narrowed rather than cast.
 *
 * A CHECK constraint already confines the column to these three values, so an
 * unrecognised one means the database contains something no version of this
 * code wrote. Throwing is the only honest reading; widening the type with an
 * assertion would let that corruption travel outwards as a valid status.
 */
function statusOf(value: string): PurchaseOrderStatus {
  if (value === 'open' || value === 'partially_received' || value === 'received') return value;
  throw new Error(`Unrecognised purchase order status: "${value}".`);
}

function toRecord(header: OrderHeaderRow, lines: readonly OrderLineRow[]): PurchaseOrderRecord {
  return {
    id: header.id,
    supplierId: header.supplierId,
    branchId: header.branchId,
    reference: header.reference,
    status: statusOf(header.status),
    orderedAt: header.orderedAt.toISOString(),
    lines: lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      // Strings, never Numbers. A warehouse quantity in grams reaches 2^53,
      // and JSON would round it on the way out (ADR-0024 §3).
      orderedQuantityScaled: line.orderedQuantityScaled.toString(),
      receivedQuantityScaled: line.receivedQuantityScaled.toString(),
      remainingQuantityScaled: (
        line.orderedQuantityScaled - line.receivedQuantityScaled
      ).toString(),
    })),
  };
}

/**
 * Read a whole order, lines in product order.
 *
 * The same order the validator sorted the request into, so a first response
 * and a replay of the same operation present the lines identically. One
 * committed operation must not tell two callers two different things.
 */
async function readOrder(
  tx: TransactionClient,
  tenant: string,
  orderId: string,
): Promise<PurchaseOrderRecord> {
  const header = await tx.purchaseOrder.findFirst({
    where: { tenantId: tenant, id: orderId },
    select: {
      id: true,
      supplierId: true,
      branchId: true,
      reference: true,
      status: true,
      orderedAt: true,
    },
  });
  if (header === null) throw new PurchasingRefusedError('unknown-purchase-order', orderId);
  const lines = await tx.purchaseOrderLine.findMany({
    where: { tenantId: tenant, purchaseOrderId: orderId },
    orderBy: { productId: 'asc' },
    select: {
      id: true,
      productId: true,
      orderedQuantityScaled: true,
      receivedQuantityScaled: true,
    },
  });
  return toRecord(header, lines);
}

/**
 * The creation answer, read back from where it was frozen.
 *
 * A purchase order is created `open`, with every line at zero received and
 * remaining equal to ordered. Those three facts are true of the *creation* and
 * stop being true the moment a delivery arrives — so a replay reconstructs
 * them from the snapshot rather than from the order, which has moved on.
 */
function orderFromSnapshot(value: unknown): PurchaseOrderResult {
  const root = snapshotObject(value, 'purchase-order-result');
  const order = snapshotObject(root['order'], 'order');
  return {
    order: {
      id: snapshotString(order, 'id'),
      supplierId: snapshotString(order, 'supplierId'),
      branchId: snapshotString(order, 'branchId'),
      reference: snapshotNullableString(order, 'reference'),
      status: statusOf(snapshotString(order, 'status')),
      orderedAt: snapshotString(order, 'orderedAt'),
      lines: snapshotRows(order, 'lines').map((line) => ({
        id: snapshotString(line, 'id'),
        productId: snapshotString(line, 'productId'),
        orderedQuantityScaled: snapshotString(line, 'orderedQuantityScaled'),
        receivedQuantityScaled: snapshotString(line, 'receivedQuantityScaled'),
        remainingQuantityScaled: snapshotString(line, 'remainingQuantityScaled'),
      })),
    },
    replayed: true,
  };
}

/**
 * Hold the supplier, then judge it.
 *
 * `FOR SHARE` conflicts with the `FOR NO KEY UPDATE` a plain `UPDATE suppliers
 * SET "isActive" = false` takes, so a deactivation arriving mid-order blocks
 * rather than slipping underneath. Under RLS a cross-tenant id is simply not
 * there, so "missing" and "somebody else's" give the same answer — which is
 * the answer both callers should get.
 */
async function lockSupplier(
  tx: TransactionClient,
  tenant: string,
  supplierId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ isActive: boolean }[]>`
    SELECT "isActive" FROM "suppliers"
     WHERE "tenantId" = ${tenant}::uuid AND "id" = ${supplierId}::uuid
     FOR SHARE`;
  const row = rows.at(0);
  if (row === undefined) throw new PurchasingRefusedError('unknown-supplier', supplierId);
  // Only a *new* order is refused. Every order and receipt already naming this
  // supplier stays valid: deactivation is an administrative state, not a
  // retroactive claim that the merchant never bought from them (§5).
  if (!row.isActive) throw new PurchasingRefusedError('inactive-supplier', supplierId);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createPurchaseOrder(
  prisma: PrismaClient,
  actor: PurchasingActor,
  request: PurchaseOrderRequest,
  requestHash: string,
  clock: () => Date = () => new Date(),
): Promise<PurchaseOrderResult> {
  const plan = validatePurchaseOrderRequest(request);
  const tenant = actor.tenantId;

  return withTenant(prisma, tenant, async (tx) =>
    inPurchasingVocabulary(async () => {
      const at = clock();
      const orderId = newId();

      const claim = await claimOperation(
        tx,
        tenant,
        PURCHASING_IDEMPOTENCY_SCOPES.purchaseOrder,
        request.operationId,
        requestHash,
        'purchasing-order',
        orderId,
        at,
      );
      // The committed answer, not the order as it reads today. Between the
      // creation and this retry the goods may have arrived: the accumulators
      // would have moved and the status with them, and reconstructing from the
      // document would report a result this operation never produced.
      if (claim.kind === 'replay') {
        return orderFromSnapshot(
          await readOperationSnapshot(
            tx,
            tenant,
            PURCHASING_IDEMPOTENCY_SCOPES.purchaseOrder,
            request.operationId,
          ),
        );
      }

      await lockSupplier(tx, tenant, plan.supplierId);
      await lockBranches(tx, tenant, [plan.branchId]);
      const products = await lockProducts(
        tx,
        tenant,
        plan.lines.map((line) => line.productId),
      );

      for (const line of plan.lines) {
        const fact = products.get(line.productId);
        if (fact === undefined) {
          throw new PurchasingRefusedError('unknown-product', line.productId);
        }
        // Half a tin cannot be ordered, so it cannot be received either. The
        // check happens here as well as at receiving because an order for a
        // fractional quantity of a unit product is an order no delivery could
        // ever satisfy.
        assertPurchasingQuantityShape(
          line.orderedQuantityScaled,
          fact.productType,
          'orderedQuantityScaled',
        );
      }

      await tx.purchaseOrder.create({
        data: {
          id: orderId,
          tenantId: tenant,
          supplierId: plan.supplierId,
          branchId: plan.branchId,
          operationId: request.operationId,
          requestHash,
          reference: plan.reference,
          // Not from the request. A client that could name its own status
          // could name `received` and be believed (§7).
          status: derivePurchaseOrderStatus(
            plan.lines.map((line) => ({
              orderedQuantityScaled: line.orderedQuantityScaled,
              receivedQuantityScaled: 0n,
            })),
          ),
          actorUserId: actor.userId,
          orderedAt: at,
          updatedAt: at,
        },
      });

      for (const line of plan.lines) {
        await tx.purchaseOrderLine.create({
          data: {
            id: newId(),
            tenantId: tenant,
            purchaseOrderId: orderId,
            productId: line.productId,
            orderedQuantityScaled: line.orderedQuantityScaled,
            // Zero, explicitly. Nothing has arrived.
            receivedQuantityScaled: 0n,
          },
        });
      }

      await appendPurchasingAudit(
        tx,
        tenant,
        actor.userId,
        plan.branchId,
        PURCHASING_AUDIT_EVENTS.purchaseOrderCreated,
        'purchase_order',
        orderId,
        {
          operationId: request.operationId,
          supplierId: plan.supplierId,
          branchId: plan.branchId,
          lineCount: plan.lines.length,
          reference: plan.reference,
        },
        at,
      );

      // Nothing above wrote an inventory movement or touched a balance. That
      // is the invariant, not an accident of the current implementation, and
      // a live proof counts both before and after.
      const result: PurchaseOrderResult = {
        order: await readOrder(tx, tenant, orderId),
        replayed: false,
      };
      await writeOperationSnapshot(
        tx,
        tenant,
        PURCHASING_IDEMPOTENCY_SCOPES.purchaseOrder,
        request.operationId,
        result,
      );
      return result;
    }),
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const MAX_PURCHASE_ORDER_PAGE = 100;

export interface PurchaseOrderSummary {
  readonly id: string;
  readonly supplierId: string;
  readonly branchId: string;
  readonly reference: string | null;
  readonly status: PurchaseOrderStatus;
  readonly orderedAt: string;
  readonly lineCount: number;
}

export interface PurchaseOrderPage {
  readonly rows: readonly PurchaseOrderSummary[];
  readonly nextCursor: string | null;
}

/**
 * Keyset pagination again, and the same reasoning: purchase orders are created
 * while a merchant is paging through them, and `OFFSET` against a growing
 * table repeats and skips rows.
 *
 * The list carries a line *count* rather than the lines. A hundred orders with
 * their lines expanded is a response nobody asked for; the single-order read
 * below is where the lines live.
 */
export async function listPurchaseOrders(
  prisma: PrismaClient,
  tenantId: string,
  options: {
    readonly limit: number;
    readonly cursor: string | null;
    readonly status: PurchaseOrderStatus | null;
    readonly supplierId: string | null;
    readonly branchId: string | null;
  },
): Promise<PurchaseOrderPage> {
  const bounded = Math.max(1, Math.min(options.limit, MAX_PURCHASE_ORDER_PAGE));

  return withTenant(prisma, tenantId, async (tx) => {
    const rows = await tx.$queryRaw<(OrderHeaderRow & { lineCount: bigint })[]>`
      SELECT o."id",
             o."supplierId",
             o."branchId",
             o."reference",
             o."status",
             o."orderedAt",
             (
               SELECT count(*) FROM "purchase_order_lines" l
                WHERE l."tenantId" = o."tenantId" AND l."purchaseOrderId" = o."id"
             ) AS "lineCount"
        FROM "purchase_orders" o
       WHERE o."tenantId" = ${tenantId}::uuid
         AND (${options.cursor}::uuid IS NULL OR o."id" > ${options.cursor}::uuid)
         AND (${options.status}::text IS NULL OR o."status" = ${options.status})
         AND (${options.supplierId}::uuid IS NULL OR o."supplierId" = ${options.supplierId}::uuid)
         AND (${options.branchId}::uuid IS NULL OR o."branchId" = ${options.branchId}::uuid)
       ORDER BY o."id" ASC
       LIMIT ${bounded + 1}`;

    const page = rows.slice(0, bounded);
    const last = page.at(-1);
    return {
      rows: page.map((row) => ({
        id: row.id,
        supplierId: row.supplierId,
        branchId: row.branchId,
        reference: row.reference,
        status: statusOf(row.status),
        orderedAt: row.orderedAt.toISOString(),
        lineCount: Number(row.lineCount),
      })),
      nextCursor: rows.length > bounded && last !== undefined ? last.id : null,
    };
  });
}

export async function getPurchaseOrder(
  prisma: PrismaClient,
  tenantId: string,
  orderId: string,
): Promise<PurchaseOrderRecord | null> {
  return withTenant(prisma, tenantId, async (tx) => {
    const header = await tx.purchaseOrder.findFirst({
      where: { tenantId, id: orderId },
      select: {
        id: true,
        supplierId: true,
        branchId: true,
        reference: true,
        status: true,
        orderedAt: true,
      },
    });
    // Null, not a refusal: another merchant's order is absent under RLS, and
    // both cases must answer identically or the endpoint becomes a probe.
    if (header === null) return null;
    const lines = await tx.purchaseOrderLine.findMany({
      where: { tenantId, purchaseOrderId: orderId },
      orderBy: { productId: 'asc' },
      select: {
        id: true,
        productId: true,
        orderedQuantityScaled: true,
        receivedQuantityScaled: true,
      },
    });
    return toRecord(header, lines);
  });
}
