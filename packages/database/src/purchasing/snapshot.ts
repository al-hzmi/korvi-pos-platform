import type { TransactionClient } from '../tenant-context.js';

/**
 * The committed answer, stored rather than recomputed.
 *
 * Korvi's idempotency doctrine promises that the same operation id carrying the
 * same intent replays *the committed result*. Reconstructing that result by
 * reading the documents back keeps the promise only for as long as nothing else
 * changes — and in purchasing, later change is the normal case:
 *
 *   - a receipt that moved an order from `open` to `partially_received`, read
 *     back after a second receipt completed the order, would report `received`;
 *   - a purchase order read back after goods arrived would report accumulators
 *     and a status its creation never produced;
 *   - a supplier read back after a rename or a deactivation would report the
 *     new name and the new state.
 *
 * None of those is the answer the operation gave. So the answer is frozen at
 * commit time and read from there afterwards.
 *
 * ## Why this is evidence and not a cache
 *
 * The snapshot is written by the same transaction that performs the mutation,
 * against the reservation row that transaction created. There is no window in
 * which a committed purchasing operation has no snapshot, and no way for a
 * rolled-back one to leave a stale one behind: both roll back together, exactly
 * as the reservation and the document already do.
 *
 * A cache would be allowed to be absent or stale and would need invalidating.
 * This is neither — it is the record of what was said, and nothing may rewrite
 * it.
 *
 * ## Scope
 *
 * The four Strike 5B purchasing scopes and Strike 5C's prospective cost
 * bootstrap write here. The 5A stock-document scopes are untouched: their
 * replays reconstruct from documents whose lines are immutable evidence.
 *
 * `resultSnapshot` is nullable because operations that committed before the
 * column existed have no recorded answer, and inventing one would be worse than
 * admitting it. For a purchasing scope a null is unreachable — every commit
 * writes one — so the readers below treat it as a fault rather than guessing.
 */

/**
 * Freeze the answer, in the transaction that produced it.
 *
 * Targeted by `(tenantId, scope, operationId)` — the reservation's own unique
 * identity — rather than by row id, so this cannot be pointed at a different
 * operation's row by a later refactor.
 *
 * The update is asserted to have touched exactly the one row it should, and it
 * only targets a reservation whose snapshot is still null. That makes the
 * evidence mechanically write-once: a second attempt cannot rewrite history.
 * A silent zero means either the reservation is missing or somebody tried to
 * freeze an answer twice; both are broken invariants rather than recoverable
 * merchant conditions.
 */
export async function writeOperationSnapshot(
  tx: TransactionClient,
  tenant: string,
  scope: string,
  operationId: string,
  payload: unknown,
): Promise<void> {
  const updated = await tx.$executeRaw`
    UPDATE "idempotency_keys"
       SET "resultSnapshot" = ${JSON.stringify(payload)}::jsonb
     WHERE "tenantId" = ${tenant}::uuid
       AND "scope" = ${scope}
       AND "operationId" = ${operationId}
       AND "resultSnapshot" IS NULL`;
  if (updated !== 1) {
    throw new Error(
      `Expected exactly one idempotency reservation to snapshot for scope "${scope}", updated ${String(updated)}.`,
    );
  }
}

/**
 * Read the frozen answer back.
 *
 * A missing row or a null snapshot on a purchasing scope is an internal
 * invariant failure: claimOperation already proved the operation id and request
 * hash matched, so this cannot truthfully be reported as a merchant conflict.
 * Returning today's document state is also forbidden; that is the behaviour
 * this whole mechanism replaces.
 */
export async function readOperationSnapshot(
  tx: TransactionClient,
  tenant: string,
  scope: string,
  operationId: string,
): Promise<unknown> {
  const rows = await tx.$queryRaw<{ resultSnapshot: unknown }[]>`
    SELECT "resultSnapshot" FROM "idempotency_keys"
     WHERE "tenantId" = ${tenant}::uuid
       AND "scope" = ${scope}
       AND "operationId" = ${operationId}`;
  const row = rows.at(0);
  if (row === undefined || row.resultSnapshot === null || row.resultSnapshot === undefined) {
    throw new Error(
      `Purchasing snapshot invariant failure for scope "${scope}": committed operation snapshot is missing.`,
    );
  }
  return row.resultSnapshot;
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/**
 * Turning `unknown` back into a typed result, one field at a time.
 *
 * JSONB comes back as `unknown` and there is no honest shortcut from there to a
 * typed result: `as` would assert a shape nobody checked, and a malformed
 * snapshot would then travel outwards as a valid answer. These helpers cost a
 * few lines each and make a corrupt snapshot fail loudly at the boundary
 * instead of quietly downstream.
 *
 * They throw a plain `Error` rather than a typed refusal, because a snapshot
 * this transaction wrote itself being the wrong shape is a defect in Korvi, not
 * something a merchant did.
 */
function malformed(field: string): never {
  throw new Error(`Malformed operation snapshot: "${field}".`);
}

export function snapshotObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) malformed(field);
  return value as Record<string, unknown>;
}

export function snapshotString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string') malformed(field);
  return value;
}

export function snapshotNullableString(
  source: Record<string, unknown>,
  field: string,
): string | null {
  const value = source[field];
  if (value === null) return null;
  if (typeof value !== 'string') malformed(field);
  return value;
}

export function snapshotBoolean(source: Record<string, unknown>, field: string): boolean {
  const value = source[field];
  if (typeof value !== 'boolean') malformed(field);
  return value;
}

export function snapshotRows(
  source: Record<string, unknown>,
  field: string,
): readonly Record<string, unknown>[] {
  const value = source[field];
  if (!Array.isArray(value)) malformed(field);
  return value.map((entry, index) => snapshotObject(entry, `${field}[${String(index)}]`));
}
