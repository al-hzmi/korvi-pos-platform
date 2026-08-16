import {
  STOCK_AUDIT_EVENTS,
  STOCK_IDEMPOTENCY_SCOPES,
  STOCK_SOURCE_TYPES,
  assertQuantityShape,
  newId,
  validateAdjustmentRequest,
  validateCountRequest,
  validateTransferRequest,
} from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { StockOperationRefusedError } from '../errors.js';
import { applyMovementWithin } from '../repositories/inventory-repository.js';
import type {
  AdjustmentRequest,
  CountRequest,
  StockProductType,
  TransferRequest,
} from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

/**
 * The merchant-facing stock authority.
 *
 * Three operations — adjustment, count, transfer — over the one stock truth
 * Korvi already had. `inventory_movements` remains the causal ledger and
 * `inventory_balances` its materialized quantity; nothing here keeps a second
 * count of anything (ADR-0024 §1).
 *
 * Every function in this file obeys the same shape, and the order is the
 * integrity argument:
 *
 *   1. reserve the operation id, so a duplicate submission cannot do the work
 *      twice and a changed intent under a reused id is refused outright;
 *   2. lock every involved **branch** row `FOR SHARE`, in lexical branch order;
 *   3. lock every involved **product** row `FOR SHARE`, in lexical product order;
 *   4. lock `tenant_settings` `FOR SHARE` where the operation depends on it;
 *   5. materialize every balance row the operation needs, at zero;
 *   6. lock those balance rows `FOR UPDATE` in canonical `(branchId, productId)`
 *      order;
 *   7. evaluate every predicate — existence, active, tracked, product type,
 *      revision, stock floor — against the *locked* rows, never an earlier read;
 *   8. write the document, its lines, the movements, the balances, the audit
 *      row and the reservation, all in the one transaction.
 *
 * A failure at any point leaves none of it. That is not a nicety: half a
 * transfer is stock that exists in neither branch.
 *
 * ## Why steps 2–4 exist at all
 *
 * Reading a fact and then acting on it is not the same as holding it. A branch
 * read as active can be deactivated, a product's `trackInventory` can be turned
 * off, and `allowNegativeStock` can be turned from true to false, all between
 * the read and the balance mutation — and the operation would then commit
 * against a world that no longer agrees with it. Every one of those facts is
 * therefore *held* for the rest of the transaction rather than sampled.
 *
 * `FOR SHARE` is the right strength and not merely a cheap one. It conflicts
 * with `FOR NO KEY UPDATE`, which is what a plain `UPDATE branches SET
 * "isActive" = false` acquires, so a concurrent deactivation blocks instead of
 * slipping underneath. It does *not* conflict with itself, so two Stage-5
 * operations in the same branch do not serialise on the branch and instead meet
 * — deterministically — at the balance rows in step 6.
 *
 * ## Why this cannot deadlock with checkout or returns
 *
 * Checkout and returns both take the branch row `FOR UPDATE` before they post
 * any stock movement (`allocateReceipt`, and the same in the return path). This
 * module takes the same row `FOR SHARE`, and the two conflict — so a checkout
 * and a Stage-5 mutation touching one branch serialise at the branch, before
 * either reaches a balance row. That is the point: it joins the existing
 * serialization boundary rather than inventing a second one beside it.
 *
 * No cycle is possible:
 *
 *   - every actor takes locks in the same class order, branches → products →
 *     settings → balances, and never reaches backwards for an earlier class;
 *   - within the branch and product classes the order is lexical by id, so two
 *     multi-branch or multi-product operations request the same row first;
 *   - checkout and returns take exactly **one** branch lock each, and a
 *     single-lock actor cannot be an interior node of a wait cycle;
 *   - balances are ordered canonically in step 6, which is the property the
 *     opposite-direction transfer proof rests on.
 */

// ---------------------------------------------------------------------------
// Canonical locking
// ---------------------------------------------------------------------------

export interface BalanceKey {
  readonly branchId: string;
  readonly productId: string;
}

export interface LockedBalance {
  readonly branchId: string;
  readonly productId: string;
  readonly quantityScaled: bigint;
  readonly revision: bigint;
}

function keyOf(key: BalanceKey): string {
  return `${key.branchId}/${key.productId}`;
}

/**
 * The canonical order: lexical by `(branchId, productId)`, tenant already
 * scoped by RLS.
 *
 * This is the whole deadlock argument. A transfer from A to B and a
 * simultaneous transfer from B to A touch the same two rows in opposite
 * business directions; if each locked "its own source first" they would hold
 * one row apiece and wait forever for the other. Sorting by a property of the
 * *rows* rather than of the operation means both transactions ask for the same
 * row first, so one simply waits and then proceeds (Strike 5A §E).
 */
function canonicalOrder(keys: readonly BalanceKey[]): readonly BalanceKey[] {
  return [...keys].sort((a, b) =>
    a.branchId === b.branchId
      ? a.productId < b.productId
        ? -1
        : a.productId > b.productId
          ? 1
          : 0
      : a.branchId < b.branchId
        ? -1
        : 1,
  );
}

/**
 * Materialize the rows, then lock them, both in canonical order.
 *
 * Materializing first matters as much as the ordering does. A balance row that
 * does not exist cannot be locked, so two transactions could each find nothing
 * to lock, both proceed, and both insert — and the row-absence would have
 * bypassed the lock order entirely. `ON CONFLICT DO NOTHING` at zero turns
 * "missing" into "present and lockable" without inventing any stock.
 *
 * The lock is taken one row at a time. A single `SELECT ... FOR UPDATE` with an
 * `ORDER BY` would usually lock in that order, but "usually" is a plan-shape
 * assumption, and this is the file where that assumption would be paid for in
 * production deadlocks.
 */
async function lockBalances(
  tx: TransactionClient,
  tenant: string,
  keys: readonly BalanceKey[],
): Promise<Map<string, LockedBalance>> {
  const ordered = canonicalOrder(keys);

  for (const key of ordered) {
    await tx.$executeRaw`
      INSERT INTO "inventory_balances"
        ("tenantId","branchId","productId","quantityScaled","revision","updatedAt")
      VALUES (${tenant}::uuid, ${key.branchId}::uuid, ${key.productId}::uuid, 0, 0, now())
      ON CONFLICT ("tenantId","branchId","productId") DO NOTHING`;
  }

  const locked = new Map<string, LockedBalance>();
  for (const key of ordered) {
    const rows = await tx.$queryRaw<{ quantityScaled: bigint; revision: bigint }[]>`
      SELECT "quantityScaled", "revision"
        FROM "inventory_balances"
       WHERE "tenantId" = ${tenant}::uuid
         AND "branchId" = ${key.branchId}::uuid
         AND "productId" = ${key.productId}::uuid
       FOR UPDATE`;
    const row = rows.at(0);
    if (row === undefined) {
      // The insert above guarantees a row, and the lock is held from here, so
      // this is unreachable rather than merely unlikely.
      throw new StockOperationRefusedError('unknown-product', key.productId);
    }
    locked.set(keyOf(key), {
      branchId: key.branchId,
      productId: key.productId,
      quantityScaled: row.quantityScaled,
      revision: row.revision,
    });
  }
  return locked;
}

function lockedOrThrow(locked: Map<string, LockedBalance>, key: BalanceKey): LockedBalance {
  const found = locked.get(keyOf(key));
  if (found === undefined) {
    throw new StockOperationRefusedError('unknown-product', key.productId);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Tenant facts
// ---------------------------------------------------------------------------

/**
 * Hold every involved branch, then judge it.
 *
 * `FOR SHARE`, in lexical id order, and the validation happens *after* the lock
 * — so "this branch is active" is a fact this transaction owns until it commits
 * rather than one it observed a moment ago. A deactivation arriving in between
 * now waits for us, and one that had already committed is seen here.
 *
 * The lock also conflicts with the `FOR UPDATE` checkout and returns take on
 * the same row, which is how a Stage-5 mutation joins their serialization
 * boundary instead of running alongside it.
 *
 * Under RLS a cross-tenant id simply is not there, so "missing" and "somebody
 * else's" are the same answer — which is the answer the caller should get in
 * both cases anyway.
 */
async function lockBranches(
  tx: TransactionClient,
  tenant: string,
  branchIds: readonly string[],
): Promise<void> {
  const ordered = [...new Set(branchIds)].sort();
  for (const branchId of ordered) {
    const rows = await tx.$queryRaw<{ isActive: boolean }[]>`
      SELECT "isActive" FROM "branches"
       WHERE "tenantId" = ${tenant}::uuid AND "id" = ${branchId}::uuid
       FOR SHARE`;
    const row = rows.at(0);
    if (row === undefined) throw new StockOperationRefusedError('unknown-branch');
    if (!row.isActive) throw new StockOperationRefusedError('inactive-branch');
  }
}

interface ProductFact {
  readonly productType: StockProductType;
}

/**
 * Hold every involved product, then judge it.
 *
 * Same discipline as the branches, and for a sharper reason: `isActive`,
 * `trackInventory` and `productType` each decide whether this operation is
 * allowed and what shape its quantities must take. Sampling them and then
 * mutating would let a merchant turn tracking off while an adjustment is in
 * flight and still have the adjustment land.
 *
 * `trackInventory = false` is a merchant saying "do not keep a count of this".
 * Adjusting it would start keeping one behind their back, and the balance
 * would then disagree with every report that respects the flag.
 */
async function lockProducts(
  tx: TransactionClient,
  tenant: string,
  productIds: readonly string[],
): Promise<Map<string, ProductFact>> {
  const facts = new Map<string, ProductFact>();
  for (const productId of [...new Set(productIds)].sort()) {
    const rows = await tx.$queryRaw<
      { isActive: boolean; trackInventory: boolean; productType: string }[]
    >`
      SELECT "isActive", "trackInventory", "productType" FROM "products"
       WHERE "tenantId" = ${tenant}::uuid AND "id" = ${productId}::uuid
       FOR SHARE`;
    const row = rows.at(0);
    if (row === undefined) throw new StockOperationRefusedError('unknown-product', productId);
    if (!row.isActive) throw new StockOperationRefusedError('inactive-product', productId);
    if (!row.trackInventory) {
      throw new StockOperationRefusedError('untracked-product', productId);
    }
    facts.set(productId, {
      productType: row.productType === 'weighted' ? 'weighted' : 'unit',
    });
  }
  return facts;
}

/**
 * Hold the overselling policy for the rest of the transaction.
 *
 * The same `FOR SHARE` the product bootstrap already uses on this row, for the
 * same reason: a request must not validate against one configuration and commit
 * under another. Here the stakes are a stock floor — a merchant switching
 * `allowNegativeStock` off mid-operation must not have a negative adjustment
 * land on the strength of the value it read first.
 *
 * Only the adjustment path calls this. A count derives its delta from a
 * non-negative observation, and a transfer's source floor is absolute, so
 * neither depends on the setting and neither reads it.
 */
async function lockNegativeStockPolicy(tx: TransactionClient, tenant: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ allowNegativeStock: boolean }[]>`
    SELECT "allowNegativeStock" FROM "tenant_settings"
     WHERE "tenantId" = ${tenant}::uuid
     FOR SHARE`;
  return rows.at(0)?.allowNegativeStock ?? false;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

type ReservationOutcome =
  { readonly kind: 'reserved' } | { readonly kind: 'replay'; readonly resultId: string };

/**
 * Claim the operation id, or find out who already did.
 *
 * The same doctrine the sale path uses, for the same reason: a check-then-write
 * would let two retries of one submission both read "not reserved" and both
 * commit. `ON CONFLICT DO NOTHING` blocks on an *uncommitted* conflicting row,
 * so when it returns nothing the competitor has definitely committed and its
 * result is safe to read.
 *
 * The reservation is written as `completed` pointing at a document id that this
 * transaction is about to create. If anything below fails, both the reservation
 * and the document roll back together — there is no window in which the key
 * says "done" and the document does not exist.
 */
async function claimOperation(
  tx: TransactionClient,
  tenant: string,
  scope: string,
  operationId: string,
  requestHash: string,
  resultType: string,
  resultId: string,
  at: Date,
): Promise<ReservationOutcome> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "idempotency_keys"
      ("id","tenantId","scope","operationId","status","resultType","resultId","requestHash","completedAt")
    VALUES (${newId()}::uuid, ${tenant}::uuid, ${scope}, ${operationId},
            'completed', ${resultType}, ${resultId}::uuid, ${requestHash}, ${at})
    ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
    RETURNING "id"`;
  if (inserted.length > 0) return { kind: 'reserved' };

  const existing = await tx.$queryRaw<{ requestHash: string | null; resultId: string | null }[]>`
    SELECT "requestHash", "resultId" FROM "idempotency_keys"
     WHERE "tenantId" = ${tenant}::uuid AND "scope" = ${scope} AND "operationId" = ${operationId}`;
  const row = existing.at(0);
  if (row === undefined || row.resultId === null) {
    // The conflict said a row exists; not finding it means something outside
    // this doctrine wrote the table. Refusing is the only safe reading.
    throw new StockOperationRefusedError('idempotency-conflict');
  }
  // Same id, different intent. This is never a retry — it is a second decision
  // wearing the first one's name.
  if (row.requestHash !== requestHash) {
    throw new StockOperationRefusedError('idempotency-conflict');
  }
  return { kind: 'replay', resultId: row.resultId };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface StockLineResult {
  readonly productId: string;
  readonly beforeQuantityScaled: string;
  readonly afterQuantityScaled: string;
  readonly deltaQuantityScaled: string;
  readonly resultRevision: string;
}

export interface AdjustmentResult {
  readonly id: string;
  readonly branchId: string;
  readonly occurredAt: string;
  readonly replayed: boolean;
  readonly lines: readonly StockLineResult[];
}

export interface CountLineResult extends StockLineResult {
  readonly countedQuantityScaled: string;
  readonly expectedRevision: string;
}

export interface CountResult {
  readonly id: string;
  readonly branchId: string;
  readonly occurredAt: string;
  readonly replayed: boolean;
  readonly lines: readonly CountLineResult[];
}

export interface TransferLineResult {
  readonly productId: string;
  readonly quantityScaled: string;
  readonly sourceBeforeQuantityScaled: string;
  readonly sourceAfterQuantityScaled: string;
  readonly destinationBeforeQuantityScaled: string;
  readonly destinationAfterQuantityScaled: string;
  readonly sourceResultRevision: string;
  readonly destinationResultRevision: string;
}

export interface TransferResult {
  readonly id: string;
  readonly fromBranchId: string;
  readonly toBranchId: string;
  readonly occurredAt: string;
  readonly replayed: boolean;
  readonly lines: readonly TransferLineResult[];
}

export interface StockActor {
  readonly tenantId: string;
  readonly userId: string;
}

async function appendAudit(
  tx: TransactionClient,
  tenant: string,
  actorUserId: string,
  branchId: string,
  eventType: string,
  entityType: string,
  entityId: string,
  metadata: Readonly<Record<string, string | number | boolean | null>>,
  at: Date,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      actorUserId,
      branchId,
      terminalId: null,
      eventType,
      entityType,
      entityId,
      // Counts, references and the merchant's own reason. Never the whole
      // request body, and never anything secret (Strike 5A §J).
      metadata: { ...metadata },
      occurredAt: at,
    },
  });
}

// ---------------------------------------------------------------------------
// Adjustment
// ---------------------------------------------------------------------------

export async function recordInventoryAdjustment(
  prisma: PrismaClient,
  actor: StockActor,
  request: AdjustmentRequest,
  requestHash: string,
  clock: () => Date = () => new Date(),
): Promise<AdjustmentResult> {
  const plan = validateAdjustmentRequest(request);
  const lines = plan.lines;
  const tenant = actor.tenantId;

  return withTenant(prisma, tenant, async (tx) => {
    const at = clock();
    const documentId = newId();

    const claim = await claimOperation(
      tx,
      tenant,
      STOCK_IDEMPOTENCY_SCOPES.adjustment,
      request.operationId,
      requestHash,
      'inventory-adjustment',
      documentId,
      at,
    );
    if (claim.kind === 'replay') return replayAdjustment(tx, tenant, claim.resultId);

    await lockBranches(tx, tenant, [plan.branchId]);
    const products = await lockProducts(
      tx,
      tenant,
      lines.map((line) => line.productId),
    );
    for (const line of lines) {
      const fact = products.get(line.productId);
      if (fact === undefined) {
        throw new StockOperationRefusedError('unknown-product', line.productId);
      }
      assertQuantityShape(line.deltaQuantityScaled, fact.productType, 'deltaQuantityScaled');
    }

    const allowNegative = await lockNegativeStockPolicy(tx, tenant);
    const locked = await lockBalances(
      tx,
      tenant,
      lines.map((line) => ({ branchId: plan.branchId, productId: line.productId })),
    );

    await tx.inventoryAdjustment.create({
      data: {
        id: documentId,
        tenantId: tenant,
        branchId: plan.branchId,
        operationId: request.operationId,
        requestHash,
        reason: plan.reason,
        actorUserId: actor.userId,
        occurredAt: at,
      },
    });

    const results: StockLineResult[] = [];
    for (const line of lines) {
      const before = lockedOrThrow(locked, {
        branchId: plan.branchId,
        productId: line.productId,
      });
      const after = before.quantityScaled + line.deltaQuantityScaled;

      // The floor, decided under the lock this transaction already holds. A
      // preflight read could not answer this: the row it read might have moved
      // before the write, which is exactly the race this design removes.
      if (!allowNegative && after < 0n) {
        throw new StockOperationRefusedError('insufficient-stock', line.productId);
      }

      const lineId = newId();
      const applied = await applyMovementWithin(
        tx,
        tenant,
        {
          id: newId(),
          branchId: plan.branchId,
          productId: line.productId,
          kind: 'adjustment',
          quantityScaled: line.deltaQuantityScaled.toString(),
          reason: plan.reason,
          sourceType: STOCK_SOURCE_TYPES.adjustment,
          sourceId: documentId,
          actorUserId: actor.userId,
          occurredAt: at.toISOString(),
        },
        // The row is held, and the floor is already decided above, so the
        // primitive is not asked to re-decide it with its own predicate.
        true,
        lineId,
      );

      await tx.inventoryAdjustmentLine.create({
        data: {
          id: lineId,
          tenantId: tenant,
          adjustmentId: documentId,
          productId: line.productId,
          deltaQuantityScaled: line.deltaQuantityScaled,
          beforeQuantityScaled: before.quantityScaled,
          afterQuantityScaled: applied.quantityScaled,
          resultRevision: applied.revision,
        },
      });

      results.push({
        productId: line.productId,
        beforeQuantityScaled: before.quantityScaled.toString(),
        afterQuantityScaled: applied.quantityScaled.toString(),
        deltaQuantityScaled: line.deltaQuantityScaled.toString(),
        resultRevision: applied.revision.toString(),
      });
    }

    await appendAudit(
      tx,
      tenant,
      actor.userId,
      plan.branchId,
      STOCK_AUDIT_EVENTS.adjustment,
      'inventory_adjustment',
      documentId,
      {
        operationId: request.operationId,
        branchId: plan.branchId,
        lineCount: results.length,
        reason: plan.reason,
      },
      at,
    );

    return {
      id: documentId,
      branchId: plan.branchId,
      occurredAt: at.toISOString(),
      replayed: false,
      lines: results,
    };
  });
}

async function replayAdjustment(
  tx: TransactionClient,
  tenant: string,
  documentId: string,
): Promise<AdjustmentResult> {
  const header = await tx.inventoryAdjustment.findFirst({
    where: { tenantId: tenant, id: documentId },
    select: { id: true, branchId: true, occurredAt: true },
  });
  if (header === null) throw new StockOperationRefusedError('idempotency-conflict');
  const lines = await tx.inventoryAdjustmentLine.findMany({
    where: { tenantId: tenant, adjustmentId: documentId },
    orderBy: { productId: 'asc' },
  });
  return {
    id: header.id,
    branchId: header.branchId,
    occurredAt: header.occurredAt.toISOString(),
    replayed: true,
    lines: lines.map((line) => ({
      productId: line.productId,
      beforeQuantityScaled: line.beforeQuantityScaled.toString(),
      afterQuantityScaled: line.afterQuantityScaled.toString(),
      deltaQuantityScaled: line.deltaQuantityScaled.toString(),
      resultRevision: line.resultRevision.toString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

export async function recordInventoryCount(
  prisma: PrismaClient,
  actor: StockActor,
  request: CountRequest,
  requestHash: string,
  clock: () => Date = () => new Date(),
): Promise<CountResult> {
  const plan = validateCountRequest(request);
  const lines = plan.lines;
  const tenant = actor.tenantId;

  return withTenant(prisma, tenant, async (tx) => {
    const at = clock();
    const documentId = newId();

    const claim = await claimOperation(
      tx,
      tenant,
      STOCK_IDEMPOTENCY_SCOPES.count,
      request.operationId,
      requestHash,
      'inventory-count',
      documentId,
      at,
    );
    if (claim.kind === 'replay') return replayCount(tx, tenant, claim.resultId);

    await lockBranches(tx, tenant, [plan.branchId]);
    const products = await lockProducts(
      tx,
      tenant,
      lines.map((line) => line.productId),
    );
    for (const line of lines) {
      const fact = products.get(line.productId);
      if (fact === undefined) {
        throw new StockOperationRefusedError('unknown-product', line.productId);
      }
      assertQuantityShape(line.countedQuantityScaled, fact.productType, 'countedQuantityScaled');
    }

    // No `allowNegativeStock` read here, deliberately. A counted quantity is
    // structurally non-negative and the delta is derived from it, so the result
    // cannot be negative and the setting cannot change the answer. Reading it
    // would be a lock taken for a decision nobody makes.
    const locked = await lockBalances(
      tx,
      tenant,
      lines.map((line) => ({ branchId: plan.branchId, productId: line.productId })),
    );

    await tx.inventoryCount.create({
      data: {
        id: documentId,
        tenantId: tenant,
        branchId: plan.branchId,
        operationId: request.operationId,
        requestHash,
        reason: plan.reason,
        actorUserId: actor.userId,
        occurredAt: at,
      },
    });

    const results: CountLineResult[] = [];
    for (const line of lines) {
      const before = lockedOrThrow(locked, {
        branchId: plan.branchId,
        productId: line.productId,
      });

      /*
       * The concurrency contract, decided here and nowhere else.
       *
       * The submitted revision is the one the person was looking at when they
       * counted the shelf. If the balance has moved since — a sale, a return, a
       * transfer, another adjustment — then the absolute number they wrote down
       * describes a shelf that no longer exists, and applying it would silently
       * erase whatever happened in between. Korvi refuses and asks for a
       * recount rather than overwriting a real movement (ADR-0024 §5).
       *
       * An absent balance is revision zero, and the materialization above did
       * not change that: a first movement that landed mid-count moved it to 1,
       * and this comparison sees that.
       */
      if (before.revision !== line.expectedRevision) {
        throw new StockOperationRefusedError('stock-changed', line.productId);
      }

      // Derived by the server, from the locked row. The client stated an
      // observation; it never stated this.
      const delta = line.countedQuantityScaled - before.quantityScaled;

      if (delta === 0n) {
        // Evidence, and nothing else. No movement, so no revision step: there
        // is no causal event to explain one (Strike 5A §A, §C).
        await tx.inventoryCountLine.create({
          data: {
            id: newId(),
            tenantId: tenant,
            countId: documentId,
            productId: line.productId,
            expectedRevision: line.expectedRevision,
            beforeQuantityScaled: before.quantityScaled,
            countedQuantityScaled: line.countedQuantityScaled,
            deltaQuantityScaled: 0n,
            resultRevision: before.revision,
          },
        });
        results.push({
          productId: line.productId,
          beforeQuantityScaled: before.quantityScaled.toString(),
          afterQuantityScaled: before.quantityScaled.toString(),
          countedQuantityScaled: line.countedQuantityScaled.toString(),
          deltaQuantityScaled: '0',
          expectedRevision: line.expectedRevision.toString(),
          resultRevision: before.revision.toString(),
        });
        continue;
      }

      const lineId = newId();
      const applied = await applyMovementWithin(
        tx,
        tenant,
        {
          id: newId(),
          branchId: plan.branchId,
          productId: line.productId,
          kind: 'adjustment',
          quantityScaled: delta.toString(),
          reason: plan.reason,
          // The stock effect is an adjustment; the source is what says a count
          // produced it rather than somebody typing a delta.
          sourceType: STOCK_SOURCE_TYPES.count,
          sourceId: documentId,
          actorUserId: actor.userId,
          occurredAt: at.toISOString(),
        },
        true,
        lineId,
      );

      await tx.inventoryCountLine.create({
        data: {
          id: lineId,
          tenantId: tenant,
          countId: documentId,
          productId: line.productId,
          expectedRevision: line.expectedRevision,
          beforeQuantityScaled: before.quantityScaled,
          countedQuantityScaled: line.countedQuantityScaled,
          deltaQuantityScaled: delta,
          resultRevision: applied.revision,
        },
      });

      results.push({
        productId: line.productId,
        beforeQuantityScaled: before.quantityScaled.toString(),
        afterQuantityScaled: applied.quantityScaled.toString(),
        countedQuantityScaled: line.countedQuantityScaled.toString(),
        deltaQuantityScaled: delta.toString(),
        expectedRevision: line.expectedRevision.toString(),
        resultRevision: applied.revision.toString(),
      });
    }

    await appendAudit(
      tx,
      tenant,
      actor.userId,
      plan.branchId,
      STOCK_AUDIT_EVENTS.count,
      'inventory_count',
      documentId,
      {
        operationId: request.operationId,
        branchId: plan.branchId,
        lineCount: results.length,
        adjustedLineCount: results.filter((line) => line.deltaQuantityScaled !== '0').length,
        reason: plan.reason,
      },
      at,
    );

    return {
      id: documentId,
      branchId: plan.branchId,
      occurredAt: at.toISOString(),
      replayed: false,
      lines: results,
    };
  });
}

async function replayCount(
  tx: TransactionClient,
  tenant: string,
  documentId: string,
): Promise<CountResult> {
  const header = await tx.inventoryCount.findFirst({
    where: { tenantId: tenant, id: documentId },
    select: { id: true, branchId: true, occurredAt: true },
  });
  if (header === null) throw new StockOperationRefusedError('idempotency-conflict');
  const lines = await tx.inventoryCountLine.findMany({
    where: { tenantId: tenant, countId: documentId },
    orderBy: { productId: 'asc' },
  });
  return {
    id: header.id,
    branchId: header.branchId,
    occurredAt: header.occurredAt.toISOString(),
    replayed: true,
    lines: lines.map((line) => ({
      productId: line.productId,
      beforeQuantityScaled: line.beforeQuantityScaled.toString(),
      afterQuantityScaled: line.countedQuantityScaled.toString(),
      countedQuantityScaled: line.countedQuantityScaled.toString(),
      deltaQuantityScaled: line.deltaQuantityScaled.toString(),
      expectedRevision: line.expectedRevision.toString(),
      resultRevision: line.resultRevision.toString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export async function recordInventoryTransfer(
  prisma: PrismaClient,
  actor: StockActor,
  request: TransferRequest,
  requestHash: string,
  clock: () => Date = () => new Date(),
): Promise<TransferResult> {
  const plan = validateTransferRequest(request);
  const lines = plan.lines;
  const tenant = actor.tenantId;

  return withTenant(prisma, tenant, async (tx) => {
    const at = clock();
    const documentId = newId();

    const claim = await claimOperation(
      tx,
      tenant,
      STOCK_IDEMPOTENCY_SCOPES.transfer,
      request.operationId,
      requestHash,
      'inventory-transfer',
      documentId,
      at,
    );
    if (claim.kind === 'replay') return replayTransfer(tx, tenant, claim.resultId);

    // Both branches in one call, so they are taken in lexical order rather
    // than in the business order source-then-destination. A transfer A→B and a
    // simultaneous B→A would otherwise each hold one branch and wait for the
    // other — the same argument as the balance rows, one level up.
    await lockBranches(tx, tenant, [plan.fromBranchId, plan.toBranchId]);
    const products = await lockProducts(
      tx,
      tenant,
      lines.map((line) => line.productId),
    );
    for (const line of lines) {
      const fact = products.get(line.productId);
      if (fact === undefined) {
        throw new StockOperationRefusedError('unknown-product', line.productId);
      }
      assertQuantityShape(line.quantityScaled, fact.productType, 'quantityScaled');
    }

    // Both legs of every line, in one canonical order. Sorting the union — not
    // "sources then destinations" — is what makes the opposite-direction case
    // safe: A→B and B→A produce the same ordered list of rows.
    const locked = await lockBalances(
      tx,
      tenant,
      lines.flatMap((line) => [
        { branchId: plan.fromBranchId, productId: line.productId },
        { branchId: plan.toBranchId, productId: line.productId },
      ]),
    );

    await tx.inventoryTransfer.create({
      data: {
        id: documentId,
        tenantId: tenant,
        fromBranchId: plan.fromBranchId,
        toBranchId: plan.toBranchId,
        operationId: request.operationId,
        requestHash,
        reason: plan.reason,
        actorUserId: actor.userId,
        occurredAt: at,
      },
    });

    const results: TransferLineResult[] = [];
    for (const line of lines) {
      const source = lockedOrThrow(locked, {
        branchId: plan.fromBranchId,
        productId: line.productId,
      });
      const destination = lockedOrThrow(locked, {
        branchId: plan.toBranchId,
        productId: line.productId,
      });

      /*
       * A branch cannot send stock it does not have.
       *
       * This floor is absolute and does not consult `allowNegativeStock`. That
       * setting is about a till being allowed to sell into the red when the
       * shelf disagrees with the book; it is not permission to invent physical
       * goods and carry them to another branch, which is what a negative
       * transfer source would be (ADR-0024 §6).
       */
      if (source.quantityScaled < line.quantityScaled) {
        throw new StockOperationRefusedError('insufficient-stock', line.productId);
      }

      const lineId = newId();

      const out = await applyMovementWithin(
        tx,
        tenant,
        {
          id: newId(),
          branchId: plan.fromBranchId,
          productId: line.productId,
          kind: 'transfer',
          quantityScaled: (-line.quantityScaled).toString(),
          reason: plan.reason,
          sourceType: STOCK_SOURCE_TYPES.transfer,
          sourceId: documentId,
          actorUserId: actor.userId,
          occurredAt: at.toISOString(),
        },
        true,
        lineId,
      );

      const into = await applyMovementWithin(
        tx,
        tenant,
        {
          id: newId(),
          branchId: plan.toBranchId,
          productId: line.productId,
          kind: 'transfer',
          quantityScaled: line.quantityScaled.toString(),
          reason: plan.reason,
          sourceType: STOCK_SOURCE_TYPES.transfer,
          sourceId: documentId,
          actorUserId: actor.userId,
          occurredAt: at.toISOString(),
        },
        true,
        lineId,
      );

      await tx.inventoryTransferLine.create({
        data: {
          id: lineId,
          tenantId: tenant,
          transferId: documentId,
          productId: line.productId,
          quantityScaled: line.quantityScaled,
          sourceBeforeQuantityScaled: source.quantityScaled,
          sourceAfterQuantityScaled: out.quantityScaled,
          destinationBeforeQuantityScaled: destination.quantityScaled,
          destinationAfterQuantityScaled: into.quantityScaled,
          sourceResultRevision: out.revision,
          destinationResultRevision: into.revision,
        },
      });

      results.push({
        productId: line.productId,
        quantityScaled: line.quantityScaled.toString(),
        sourceBeforeQuantityScaled: source.quantityScaled.toString(),
        sourceAfterQuantityScaled: out.quantityScaled.toString(),
        destinationBeforeQuantityScaled: destination.quantityScaled.toString(),
        destinationAfterQuantityScaled: into.quantityScaled.toString(),
        sourceResultRevision: out.revision.toString(),
        destinationResultRevision: into.revision.toString(),
      });
    }

    await appendAudit(
      tx,
      tenant,
      actor.userId,
      plan.fromBranchId,
      STOCK_AUDIT_EVENTS.transfer,
      'inventory_transfer',
      documentId,
      {
        operationId: request.operationId,
        fromBranchId: plan.fromBranchId,
        toBranchId: plan.toBranchId,
        lineCount: results.length,
        reason: plan.reason,
      },
      at,
    );

    return {
      id: documentId,
      fromBranchId: plan.fromBranchId,
      toBranchId: plan.toBranchId,
      occurredAt: at.toISOString(),
      replayed: false,
      lines: results,
    };
  });
}

async function replayTransfer(
  tx: TransactionClient,
  tenant: string,
  documentId: string,
): Promise<TransferResult> {
  const header = await tx.inventoryTransfer.findFirst({
    where: { tenantId: tenant, id: documentId },
    select: { id: true, fromBranchId: true, toBranchId: true, occurredAt: true },
  });
  if (header === null) throw new StockOperationRefusedError('idempotency-conflict');
  const lines = await tx.inventoryTransferLine.findMany({
    where: { tenantId: tenant, transferId: documentId },
    orderBy: { productId: 'asc' },
  });
  return {
    id: header.id,
    fromBranchId: header.fromBranchId,
    toBranchId: header.toBranchId,
    occurredAt: header.occurredAt.toISOString(),
    replayed: true,
    lines: lines.map((line) => ({
      productId: line.productId,
      quantityScaled: line.quantityScaled.toString(),
      sourceBeforeQuantityScaled: line.sourceBeforeQuantityScaled.toString(),
      sourceAfterQuantityScaled: line.sourceAfterQuantityScaled.toString(),
      destinationBeforeQuantityScaled: line.destinationBeforeQuantityScaled.toString(),
      destinationAfterQuantityScaled: line.destinationAfterQuantityScaled.toString(),
      sourceResultRevision: line.sourceResultRevision.toString(),
      destinationResultRevision: line.destinationResultRevision.toString(),
    })),
  };
}
