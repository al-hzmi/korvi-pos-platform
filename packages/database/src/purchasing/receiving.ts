import {
  PURCHASING_AUDIT_EVENTS,
  PURCHASING_IDEMPOTENCY_SCOPES,
  PURCHASING_MOVEMENT_KIND,
  PURCHASING_SOURCE_TYPES,
  assertPurchasingQuantityShape,
  derivePurchaseOrderStatus,
  newId,
  validatePurchaseReceiptRequest,
} from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { PurchasingRefusedError } from '../errors.js';
import {
  claimOperation,
  lockBalances,
  lockBranches,
  lockProducts,
  lockedOrThrow,
} from '../inventory/stock-ledger.js';
import { applyMovementWithin } from '../repositories/inventory-repository.js';
import { appendPurchasingAudit, inPurchasingVocabulary } from './shared.js';
import {
  readOperationSnapshot,
  snapshotNullableString,
  snapshotObject,
  snapshotRows,
  snapshotString,
  writeOperationSnapshot,
} from './snapshot.js';
import type { PurchaseOrderStatus, PurchaseReceiptRequest } from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

/**
 * Receiving: the only purchasing act that moves stock.
 *
 * A purchase order says what was asked for. This file records what physically
 * arrived and was accepted, and it is the single point where a purchasing
 * document reaches `inventory_movements` and `inventory_balances` — through
 * the shared stock primitive, never through a second implementation of stock
 * arithmetic (ADR-0024 §1, §7).
 *
 * Four things must be true of every commit here, and each has a live proof:
 *
 *   - a receipt row exists if and only if the stock it explains moved;
 *   - the PO-line accumulator moved by exactly the accepted quantity;
 *   - `0 <= received <= ordered` held throughout, under concurrency;
 *   - the order's status agrees with its lines, in the same transaction.
 *
 * ## Lock order
 *
 *   1. idempotency reservation
 *   2. the purchase order row, `FOR UPDATE`
 *   3. every line of that order, `FOR UPDATE`, in lexical id order
 *   4. the destination branch, `FOR SHARE`
 *   5. every product being received, `FOR SHARE`, in lexical id order
 *   6. materialize the required balance rows at zero
 *   7. lock those balance rows `FOR UPDATE` in canonical (branchId, productId)
 *      order — the same canonical order Strike 5A established
 *   8. evaluate every predicate against the *locked* rows
 *   9. write receipt, lines, accumulators, status, movements, balances, audit
 *
 * Steps 4 through 7 are Strike 5A's own helpers, called rather than copied: a
 * second implementation of the lock discipline would be a second lock order,
 * and two lock orders is how a deadlock gets designed in.
 *
 * ## Why this cannot deadlock
 *
 * The global class order is suppliers → purchase orders → purchase order lines
 * → branches → products → tenant settings → balances, and every actor in Korvi
 * takes a *subsequence* of it:
 *
 *   - checkout and returns take one branch row `FOR UPDATE`, then balances;
 *   - adjustments, counts and transfers take branches, products, settings,
 *     balances;
 *   - purchase-order creation takes suppliers, branches, products;
 *   - receiving takes purchase orders, purchase order lines, branches,
 *     products, balances.
 *
 * Nobody reaches backwards. The purchasing classes are additionally the
 * narrowest case: only receiving ever locks a purchase-order row, so the only
 * transaction that can wait for one is another receiving transaction — and it
 * waits at step 2, while holding nothing but its own idempotency row, which no
 * other operation id contends for. A transaction blocked there cannot be an
 * interior node of a wait cycle.
 *
 * ## Why the branch is `FOR SHARE` and the order is `FOR UPDATE`
 *
 * The order row is genuinely being written — its status changes — and two
 * receipts against one order must serialize completely, because each needs to
 * see what the other spent. The branch is only being *read as an authority*:
 * `FOR SHARE` conflicts with the `FOR NO KEY UPDATE` a deactivation takes, so
 * a branch stood down mid-receipt blocks rather than slipping underneath,
 * while two receipts into the same branch still meet at the balance rows
 * rather than at the branch.
 */

export interface ReceivingActor {
  readonly tenantId: string;
  readonly userId: string;
}

export interface PurchaseReceiptLineResult {
  readonly id: string;
  readonly purchaseOrderLineId: string;
  readonly productId: string;
  readonly acceptedQuantityScaled: string;
  readonly orderedQuantityScaled: string;
  readonly beforeReceivedQuantityScaled: string;
  readonly afterReceivedQuantityScaled: string;
  readonly beforeQuantityScaled: string;
  readonly afterQuantityScaled: string;
  readonly resultRevision: string;
}

export interface PurchaseReceiptResult {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly branchId: string;
  readonly supplierId: string;
  readonly reference: string | null;
  /** The order's status after this receipt, derived from its own lines. */
  readonly purchaseOrderStatus: PurchaseOrderStatus;
  readonly receivedAt: string;
  readonly replayed: boolean;
  readonly lines: readonly PurchaseReceiptLineResult[];
}

interface LockedOrder {
  readonly supplierId: string;
  readonly branchId: string;
  readonly status: string;
}

interface LockedOrderLine {
  readonly id: string;
  readonly productId: string;
  readonly orderedQuantityScaled: bigint;
  readonly receivedQuantityScaled: bigint;
}

/**
 * Hold the order.
 *
 * `FOR UPDATE`, and everything else in this transaction happens behind it.
 * Two vans arriving at once against one order is not a hypothetical: a partial
 * delivery on Monday and the balance on Tuesday is the ordinary case, and two
 * clerks entering them simultaneously is the case that decides whether the
 * over-receipt rule is real.
 */
async function lockOrder(
  tx: TransactionClient,
  tenant: string,
  orderId: string,
): Promise<LockedOrder> {
  const rows = await tx.$queryRaw<{ supplierId: string; branchId: string; status: string }[]>`
    SELECT "supplierId", "branchId", "status" FROM "purchase_orders"
     WHERE "tenantId" = ${tenant}::uuid AND "id" = ${orderId}::uuid
     FOR UPDATE`;
  const row = rows.at(0);
  // Under RLS another merchant's order is not there, so this answers the same
  // way for a missing id and a foreign one — which is what stops the endpoint
  // being a probe for which orders exist.
  if (row === undefined) throw new PurchasingRefusedError('unknown-purchase-order', orderId);
  return { supplierId: row.supplierId, branchId: row.branchId, status: row.status };
}

/**
 * Hold *every* line of the order, not only the ones being received.
 *
 * The status is a function of all of them, so deriving it from lines this
 * transaction does not hold would be reading a fact it has not secured. One
 * row at a time in lexical id order, for the same reason 5A locks balances one
 * at a time: a single statement with an `ORDER BY` usually locks in that
 * order, and "usually" is a plan-shape assumption this is the wrong file to
 * pay for.
 */
async function lockOrderLines(
  tx: TransactionClient,
  tenant: string,
  orderId: string,
): Promise<Map<string, LockedOrderLine>> {
  const ids = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "purchase_order_lines"
     WHERE "tenantId" = ${tenant}::uuid AND "purchaseOrderId" = ${orderId}::uuid
     ORDER BY "id" ASC`;

  const locked = new Map<string, LockedOrderLine>();
  for (const { id } of ids) {
    const rows = await tx.$queryRaw<
      { productId: string; orderedQuantityScaled: bigint; receivedQuantityScaled: bigint }[]
    >`
      SELECT "productId", "orderedQuantityScaled", "receivedQuantityScaled"
        FROM "purchase_order_lines"
       WHERE "tenantId" = ${tenant}::uuid AND "id" = ${id}::uuid
       FOR UPDATE`;
    const row = rows.at(0);
    // The id came from this transaction's own read a moment ago and lines are
    // never deleted, so absence here is unreachable rather than merely
    // unlikely. Refusing is still the only safe reading.
    if (row === undefined) {
      throw new PurchasingRefusedError('unknown-purchase-order-line', id);
    }
    locked.set(id, {
      id,
      productId: row.productId,
      orderedQuantityScaled: row.orderedQuantityScaled,
      receivedQuantityScaled: row.receivedQuantityScaled,
    });
  }
  return locked;
}

/**
 * The committed answer, read back from where it was frozen.
 *
 * This is the sharpest case for the snapshot, and the one that made it
 * necessary. Receipt A takes an order from `open` to `partially_received`.
 * Receipt B later completes it, and the order now reads `received`. Replaying
 * A by reading the order back would report `received` — a status receipt A
 * never produced, on a document A did not finish.
 *
 * The receipt's own lines happen to be immutable, so those could have been
 * read back safely. The order status could not, and a result that is half
 * historical and half current is worse than either: nothing in it tells the
 * caller which half is which. So the whole answer comes from the snapshot.
 */
function receiptFromSnapshot(value: unknown): PurchaseReceiptResult {
  const root = snapshotObject(value, 'purchase-receipt-result');
  return {
    id: snapshotString(root, 'id'),
    purchaseOrderId: snapshotString(root, 'purchaseOrderId'),
    branchId: snapshotString(root, 'branchId'),
    supplierId: snapshotString(root, 'supplierId'),
    reference: snapshotNullableString(root, 'reference'),
    // The status *this receipt produced*, not the order's status now.
    purchaseOrderStatus: statusOf(snapshotString(root, 'purchaseOrderStatus')),
    receivedAt: snapshotString(root, 'receivedAt'),
    replayed: true,
    lines: snapshotRows(root, 'lines').map((line) => ({
      id: snapshotString(line, 'id'),
      purchaseOrderLineId: snapshotString(line, 'purchaseOrderLineId'),
      productId: snapshotString(line, 'productId'),
      acceptedQuantityScaled: snapshotString(line, 'acceptedQuantityScaled'),
      orderedQuantityScaled: snapshotString(line, 'orderedQuantityScaled'),
      beforeReceivedQuantityScaled: snapshotString(line, 'beforeReceivedQuantityScaled'),
      afterReceivedQuantityScaled: snapshotString(line, 'afterReceivedQuantityScaled'),
      beforeQuantityScaled: snapshotString(line, 'beforeQuantityScaled'),
      afterQuantityScaled: snapshotString(line, 'afterQuantityScaled'),
      resultRevision: snapshotString(line, 'resultRevision'),
    })),
  };
}

function statusOf(value: string): PurchaseOrderStatus {
  if (value === 'open' || value === 'partially_received' || value === 'received') return value;
  throw new Error(`Unrecognised purchase order status: "${value}".`);
}

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

export async function recordPurchaseReceipt(
  prisma: PrismaClient,
  actor: ReceivingActor,
  request: PurchaseReceiptRequest,
  requestHash: string,
  clock: () => Date = () => new Date(),
): Promise<PurchaseReceiptResult> {
  const plan = validatePurchaseReceiptRequest(request);
  const tenant = actor.tenantId;

  return withTenant(prisma, tenant, async (tx) =>
    inPurchasingVocabulary(async () => {
      const at = clock();
      const receiptId = newId();

      const claim = await claimOperation(
        tx,
        tenant,
        PURCHASING_IDEMPOTENCY_SCOPES.purchaseReceipt,
        request.operationId,
        requestHash,
        'purchasing-receipt',
        receiptId,
        at,
      );
      // The whole of "stock must not move twice". A retry that reaches here
      // reads the frozen answer and returns it; it does not accumulate a
      // second time, post a second movement, or step a revision (§16).
      if (claim.kind === 'replay') {
        return receiptFromSnapshot(
          await readOperationSnapshot(
            tx,
            tenant,
            PURCHASING_IDEMPOTENCY_SCOPES.purchaseReceipt,
            request.operationId,
          ),
        );
      }

      const order = await lockOrder(tx, tenant, plan.purchaseOrderId);
      const orderLines = await lockOrderLines(tx, tenant, plan.purchaseOrderId);

      // An order with nothing outstanding is finished. Distinct from
      // `over-receipt` because the remedy differs: this one means "you are
      // receiving against the wrong order", not "this line has less room than
      // you asked for".
      if (order.status === 'received') {
        throw new PurchasingRefusedError('purchase-order-closed', plan.purchaseOrderId);
      }

      // Every requested line must belong to *this* order. A line id from
      // another order — or another tenant, which RLS has already made absent —
      // is refused rather than silently ignored.
      const requested = plan.lines.map((line) => {
        const held = orderLines.get(line.purchaseOrderLineId);
        if (held === undefined) {
          throw new PurchasingRefusedError('unknown-purchase-order-line', line.purchaseOrderLineId);
        }
        return {
          accepted: line.acceptedQuantityScaled,
          inventoryValueMinor: line.inventoryValueMinor,
          line: held,
        };
      });

      // The branch and the products come from the *locked order*, never from
      // the request. A client cannot choose where the goods land, which is
      // what stops a receipt being used to move stock into a branch nobody
      // ordered for (§9).
      await lockBranches(tx, tenant, [order.branchId]);
      const products = await lockProducts(
        tx,
        tenant,
        requested.map((entry) => entry.line.productId),
      );

      for (const entry of requested) {
        const fact = products.get(entry.line.productId);
        if (fact === undefined) {
          throw new PurchasingRefusedError('unknown-product', entry.line.productId);
        }
        assertPurchasingQuantityShape(entry.accepted, fact.productType, 'acceptedQuantityScaled');

        /*
         * The over-receipt rule, decided here and nowhere else.
         *
         * `receivedQuantityScaled` was read under this line's own `FOR UPDATE`
         * a few statements ago, so it is what the line holds *now*, not what a
         * preflight read saw. Two concurrent receipts serialize at the order
         * lock above, and the second one therefore sees the first one's
         * accumulation and refuses — which is the difference between a rule
         * and a hope (§11).
         *
         * No tolerance, no rounding, no "close enough". ADR-0024 defers any
         * over-receipt policy until one is separately designed and approved.
         */
        const remaining = entry.line.orderedQuantityScaled - entry.line.receivedQuantityScaled;
        if (entry.accepted > remaining) {
          throw new PurchasingRefusedError('over-receipt', entry.line.id);
        }
      }

      // Balances materialized and locked in Strike 5A's canonical order. Every
      // line of one receipt lands in the same branch — the order's — and PO
      // lines are unique per product, so these keys are distinct by
      // construction.
      const balances = await lockBalances(
        tx,
        tenant,
        requested.map((entry) => ({
          branchId: order.branchId,
          productId: entry.line.productId,
        })),
      );

      await tx.purchaseReceipt.create({
        data: {
          id: receiptId,
          tenantId: tenant,
          purchaseOrderId: plan.purchaseOrderId,
          // Copied from the locked order, so the receipt records where the
          // goods actually went and who actually delivered them as of the
          // moment somebody signed.
          branchId: order.branchId,
          supplierId: order.supplierId,
          operationId: request.operationId,
          requestHash,
          reference: plan.reference,
          actorUserId: actor.userId,
          receivedAt: at,
        },
      });

      const results: PurchaseReceiptLineResult[] = [];
      for (const entry of requested) {
        const beforeReceived = entry.line.receivedQuantityScaled;
        const afterReceived = beforeReceived + entry.accepted;
        const balance = lockedOrThrow(balances, {
          branchId: order.branchId,
          productId: entry.line.productId,
        });

        // The accumulator moves under the lock this transaction holds. The
        // table's CHECK asserts `0 <= received <= ordered` independently, so a
        // future code path that forgot the lock would be refused by the
        // database rather than quietly recording goods nobody ordered.
        await tx.purchaseOrderLine.update({
          where: { tenantId_id: { tenantId: tenant, id: entry.line.id } },
          data: { receivedQuantityScaled: afterReceived },
        });

        const receiptLineId = newId();

        // The one stock effect, through the shared primitive. `kind` is the
        // ledger's existing `receipt` value and `sourceType` is what says a
        // *purchase* receipt caused it; `sourceLineId` is what makes a
        // multi-line receipt's movements individually attributable (§13).
        const incomingCostBasis =
          entry.inventoryValueMinor === null
            ? undefined
            : {
                knownQuantityScaled: entry.accepted,
                unknownQuantityScaled: 0n,
                knownValueMinor: entry.inventoryValueMinor,
              };
        const applied = await applyMovementWithin(
          tx,
          tenant,
          {
            id: newId(),
            branchId: order.branchId,
            productId: entry.line.productId,
            kind: PURCHASING_MOVEMENT_KIND,
            quantityScaled: entry.accepted.toString(),
            reason: null,
            sourceType: PURCHASING_SOURCE_TYPES.purchaseReceipt,
            sourceId: receiptId,
            actorUserId: actor.userId,
            occurredAt: at.toISOString(),
          },
          // Receiving only ever adds, so no floor can be crossed and the
          // primitive is not asked to evaluate one.
          true,
          receiptLineId,
          incomingCostBasis,
        );

        await tx.purchaseReceiptLine.create({
          data: {
            id: receiptLineId,
            tenantId: tenant,
            purchaseReceiptId: receiptId,
            purchaseOrderLineId: entry.line.id,
            productId: entry.line.productId,
            acceptedQuantityScaled: entry.accepted,
            orderedQuantityScaled: entry.line.orderedQuantityScaled,
            beforeReceivedQuantityScaled: beforeReceived,
            afterReceivedQuantityScaled: afterReceived,
            beforeQuantityScaled: balance.quantityScaled,
            afterQuantityScaled: applied.quantityScaled,
            resultRevision: applied.revision,
            inventoryValueMinor: entry.inventoryValueMinor,
            costKnownQuantityScaled: applied.cost.knownQuantityScaled,
            costUnknownQuantityScaled: applied.cost.unknownQuantityScaled,
            costValueMinor: applied.cost.knownValueMinor,
            costProvenance: applied.cost.provenance,
          },
        });

        results.push({
          id: receiptLineId,
          purchaseOrderLineId: entry.line.id,
          productId: entry.line.productId,
          acceptedQuantityScaled: entry.accepted.toString(),
          orderedQuantityScaled: entry.line.orderedQuantityScaled.toString(),
          beforeReceivedQuantityScaled: beforeReceived.toString(),
          afterReceivedQuantityScaled: afterReceived.toString(),
          beforeQuantityScaled: balance.quantityScaled.toString(),
          afterQuantityScaled: applied.quantityScaled.toString(),
          resultRevision: applied.revision.toString(),
        });
      }

      // Status from the lines this transaction holds, all of them, including
      // the ones it did not receive against. Computed rather than stored
      // independently, so an order can never claim to be finished while a line
      // is still outstanding (§7).
      const received = new Map(results.map((line) => [line.purchaseOrderLineId, line]));
      const status = derivePurchaseOrderStatus(
        [...orderLines.values()].map((line) => {
          const touched = received.get(line.id);
          return {
            orderedQuantityScaled: line.orderedQuantityScaled,
            receivedQuantityScaled:
              touched === undefined
                ? line.receivedQuantityScaled
                : BigInt(touched.afterReceivedQuantityScaled),
          };
        }),
      );

      await tx.purchaseOrder.update({
        where: { tenantId_id: { tenantId: tenant, id: plan.purchaseOrderId } },
        data: { status, updatedAt: at },
      });

      await appendPurchasingAudit(
        tx,
        tenant,
        actor.userId,
        order.branchId,
        PURCHASING_AUDIT_EVENTS.purchaseReceiptFinalized,
        'purchase_receipt',
        receiptId,
        {
          operationId: request.operationId,
          purchaseOrderId: plan.purchaseOrderId,
          supplierId: order.supplierId,
          branchId: order.branchId,
          lineCount: results.length,
          purchaseOrderStatus: status,
          reference: plan.reference,
        },
        at,
      );

      const result: PurchaseReceiptResult = {
        id: receiptId,
        purchaseOrderId: plan.purchaseOrderId,
        branchId: order.branchId,
        supplierId: order.supplierId,
        reference: plan.reference,
        // The status this receipt produced. Frozen below, because a later
        // receipt will move the order on and this answer must not move with it.
        purchaseOrderStatus: status,
        receivedAt: at.toISOString(),
        replayed: false,
        lines: results,
      };

      await writeOperationSnapshot(
        tx,
        tenant,
        PURCHASING_IDEMPOTENCY_SCOPES.purchaseReceipt,
        request.operationId,
        result,
      );

      // The audit insert above is the last write before the snapshot, which is
      // what makes it the right place to inject a fault from: a trigger that
      // refuses it fails the operation at the one point where the receipt, the
      // accumulators, the status, the movements and the balances have all
      // already been written. The atomicity proof does exactly that, from the
      // database rather than from a test-only branch in here (§15).
      return result;
    }),
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const MAX_RECEIPT_PAGE = 100;

export interface PurchaseReceiptSummary {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly branchId: string;
  readonly supplierId: string;
  readonly reference: string | null;
  readonly receivedAt: string;
  readonly lines: readonly PurchaseReceiptLineResult[];
}

/**
 * Every receipt against one order, oldest first.
 *
 * Bounded rather than paginated: a purchase order with more than a hundred
 * separate deliveries against it is not a case this strike needs to serve
 * well, and the bound is what stops one order's history becoming an unbounded
 * response. Lines are included because a receipt without its lines is not
 * evidence of anything.
 */
export async function listPurchaseReceipts(
  prisma: PrismaClient,
  tenantId: string,
  purchaseOrderId: string,
  limit: number,
): Promise<readonly PurchaseReceiptSummary[]> {
  const bounded = Math.max(1, Math.min(limit, MAX_RECEIPT_PAGE));

  return withTenant(prisma, tenantId, async (tx) => {
    const headers = await tx.purchaseReceipt.findMany({
      where: { tenantId, purchaseOrderId },
      orderBy: { id: 'asc' },
      take: bounded,
      select: {
        id: true,
        purchaseOrderId: true,
        branchId: true,
        supplierId: true,
        reference: true,
        receivedAt: true,
      },
    });
    if (headers.length === 0) return [];

    const lines = await tx.purchaseReceiptLine.findMany({
      where: { tenantId, purchaseReceiptId: { in: headers.map((header) => header.id) } },
      orderBy: [{ purchaseReceiptId: 'asc' }, { purchaseOrderLineId: 'asc' }],
    });

    const byReceipt = new Map<string, PurchaseReceiptLineResult[]>();
    for (const line of lines) {
      const bucket = byReceipt.get(line.purchaseReceiptId) ?? [];
      bucket.push({
        id: line.id,
        purchaseOrderLineId: line.purchaseOrderLineId,
        productId: line.productId,
        acceptedQuantityScaled: line.acceptedQuantityScaled.toString(),
        orderedQuantityScaled: line.orderedQuantityScaled.toString(),
        beforeReceivedQuantityScaled: line.beforeReceivedQuantityScaled.toString(),
        afterReceivedQuantityScaled: line.afterReceivedQuantityScaled.toString(),
        beforeQuantityScaled: line.beforeQuantityScaled.toString(),
        afterQuantityScaled: line.afterQuantityScaled.toString(),
        resultRevision: line.resultRevision.toString(),
      });
      byReceipt.set(line.purchaseReceiptId, bucket);
    }

    return headers.map((header) => ({
      id: header.id,
      purchaseOrderId: header.purchaseOrderId,
      branchId: header.branchId,
      supplierId: header.supplierId,
      reference: header.reference,
      receivedAt: header.receivedAt.toISOString(),
      lines: byReceipt.get(header.id) ?? [],
    }));
  });
}
