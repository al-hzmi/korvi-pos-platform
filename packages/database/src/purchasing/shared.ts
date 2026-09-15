import { newId } from '@korvi/domain';
import { StockOperationRefusedError, PurchasingRefusedError } from '../errors.js';
import type { PurchasingRefusal } from '../errors.js';
import type { TransactionClient } from '../tenant-context.js';

/**
 * The two things every purchasing authority needs and neither owns.
 *
 * Purchasing reuses Strike 5A's locking and idempotency primitives rather than
 * restating them — one lock order, one idempotency doctrine, one place where
 * either could be got wrong. What it does not reuse is the *refusal
 * vocabulary*: a caller of the purchasing surface should be able to switch
 * exhaustively over `PurchasingRefusal` without also knowing that receiving
 * happens to lock a product row underneath.
 *
 * So the errors are translated here, at the boundary, and nowhere else.
 */

/**
 * Every stock refusal that receiving can provoke has an exact purchasing
 * counterpart, because it names the same fact about the same row. The mapping
 * is spelled out rather than inferred from the string so that adding a stock
 * refusal later fails the type check here instead of silently arriving on the
 * purchasing surface under a name its consumers do not handle.
 */
const REFUSAL_TRANSLATION: Readonly<
  Record<StockOperationRefusedError['detail'], PurchasingRefusal>
> = {
  'unknown-branch': 'unknown-branch',
  'inactive-branch': 'inactive-branch',
  'unknown-product': 'unknown-product',
  'inactive-product': 'inactive-product',
  'untracked-product': 'untracked-product',
  'idempotency-conflict': 'idempotency-conflict',
  // Neither can arise from a purchasing path: receiving only ever adds stock,
  // and nothing in purchasing submits a balance revision. They are mapped
  // rather than left out so the record stays total — an unmapped key would be
  // a compile error, which is the point.
  'insufficient-stock': 'over-receipt',
  'stock-changed': 'idempotency-conflict',
};

export function inPurchasingVocabulary<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    if (error instanceof StockOperationRefusedError) {
      throw new PurchasingRefusedError(REFUSAL_TRANSLATION[error.detail], error.productId);
    }
    throw error;
  });
}

/**
 * One audit event per finalized purchasing document, in the transaction that
 * finalized it.
 *
 * Metadata carries counts, references and document identities — enough for an
 * administrator to see what happened and go and look at it — and never the
 * whole request body, which would duplicate merchant data into a table with a
 * different retention story (ADR-0024 §10).
 */
export async function appendPurchasingAudit(
  tx: TransactionClient,
  tenant: string,
  actorUserId: string,
  branchId: string | null,
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
      metadata: { ...metadata },
      occurredAt: at,
    },
  });
}
