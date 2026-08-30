import {
  PURCHASING_AUDIT_EVENTS,
  PURCHASING_IDEMPOTENCY_SCOPES,
  newId,
  validateSupplierCreate,
  validateSupplierUpdate,
} from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { PurchasingRefusedError } from '../errors.js';
import { claimOperation } from '../inventory/stock-ledger.js';
import { appendPurchasingAudit, inPurchasingVocabulary } from './shared.js';
import {
  readOperationSnapshot,
  snapshotBoolean,
  snapshotObject,
  snapshotString,
  writeOperationSnapshot,
} from './snapshot.js';
import type { SupplierCreateRequest, SupplierUpdateRequest } from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

/**
 * Suppliers: who a merchant buys from.
 *
 * Two mutations and two reads, and the shape of the model is the interesting
 * part. A supplier here carries a name and an active flag and nothing else —
 * no contact, no tax number, no payment terms — because every one of those is
 * a real need that belongs to a strike with somewhere to put it, and a column
 * added speculatively is a column that has to be migrated when the real
 * requirement disagrees with the guess (Strike 5B §5).
 *
 * ## There is no delete
 *
 * Not "no delete route yet": no delete, as a decision. A supplier is named by
 * purchase orders and by receipts, and those are the evidence a merchant
 * reconciles a delivery and an invoice against. Removing the row would either
 * cascade that evidence away or leave it pointing at nothing, and both are
 * worse than a list with an inactive entry in it. Deactivation is the
 * administrative act; the foreign keys are `NO ACTION` so the database agrees
 * (ADR-0024 §10).
 */

export interface SupplierActor {
  readonly tenantId: string;
  readonly userId: string;
}

export interface SupplierRecord {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupplierResult {
  readonly supplier: SupplierRecord;
  readonly replayed: boolean;
}

interface SupplierRow {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: SupplierRow): SupplierRecord {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The committed answer, read back from where it was frozen.
 *
 * Deliberately *not* a fresh read of the supplier row. A supplier renamed or
 * deactivated after this operation committed would otherwise make the replay
 * report today's name and today's state as though the earlier operation had
 * produced them — which is a different answer to the same question, and the
 * defect this snapshot exists to remove.
 */
function supplierFromSnapshot(value: unknown): SupplierResult {
  const root = snapshotObject(value, 'supplier-result');
  const supplier = snapshotObject(root['supplier'], 'supplier');
  return {
    supplier: {
      id: snapshotString(supplier, 'id'),
      name: snapshotString(supplier, 'name'),
      isActive: snapshotBoolean(supplier, 'isActive'),
      createdAt: snapshotString(supplier, 'createdAt'),
      updatedAt: snapshotString(supplier, 'updatedAt'),
    },
    // The one field that legitimately differs between the first answer and its
    // replay: the caller is being shown a record, not being told it was made.
    replayed: true,
  };
}

async function replaySupplier(
  tx: TransactionClient,
  tenant: string,
  scope: string,
  operationId: string,
): Promise<SupplierResult> {
  return supplierFromSnapshot(await readOperationSnapshot(tx, tenant, scope, operationId));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createSupplier(
  prisma: PrismaClient,
  actor: SupplierActor,
  request: SupplierCreateRequest,
  requestHash: string,
  clock: () => Date = () => new Date(),
): Promise<SupplierResult> {
  const plan = validateSupplierCreate(request);
  const tenant = actor.tenantId;

  return withTenant(prisma, tenant, async (tx) =>
    inPurchasingVocabulary(async () => {
      const at = clock();
      const supplierId = newId();

      // The reservation first, as everywhere else in Korvi. A merchant whose
      // browser retried a slow request must end up with one supplier, not two
      // identically named ones they then have to tell apart.
      const claim = await claimOperation(
        tx,
        tenant,
        PURCHASING_IDEMPOTENCY_SCOPES.supplierCreate,
        request.operationId,
        requestHash,
        'purchasing-supplier',
        supplierId,
        at,
      );
      if (claim.kind === 'replay') {
        return replaySupplier(
          tx,
          tenant,
          PURCHASING_IDEMPOTENCY_SCOPES.supplierCreate,
          request.operationId,
        );
      }

      const created = await tx.supplier.create({
        data: {
          id: supplierId,
          tenantId: tenant,
          name: plan.name,
          isActive: true,
          updatedAt: at,
        },
        select: { id: true, name: true, isActive: true, createdAt: true, updatedAt: true },
      });

      await appendPurchasingAudit(
        tx,
        tenant,
        actor.userId,
        null,
        PURCHASING_AUDIT_EVENTS.supplierCreated,
        'supplier',
        supplierId,
        { operationId: request.operationId, name: plan.name },
        at,
      );

      const result: SupplierResult = { supplier: toRecord(created), replayed: false };
      // Frozen in the transaction that produced it, so a later rename cannot
      // change what this operation is remembered as having answered.
      await writeOperationSnapshot(
        tx,
        tenant,
        PURCHASING_IDEMPOTENCY_SCOPES.supplierCreate,
        request.operationId,
        result,
      );
      return result;
    }),
  );
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateSupplier(
  prisma: PrismaClient,
  actor: SupplierActor,
  request: SupplierUpdateRequest,
  requestHash: string,
  clock: () => Date = () => new Date(),
): Promise<SupplierResult> {
  const plan = validateSupplierUpdate(request);
  const tenant = actor.tenantId;

  return withTenant(prisma, tenant, async (tx) =>
    inPurchasingVocabulary(async () => {
      const at = clock();

      const claim = await claimOperation(
        tx,
        tenant,
        PURCHASING_IDEMPOTENCY_SCOPES.supplierUpdate,
        request.operationId,
        requestHash,
        'purchasing-supplier',
        plan.supplierId,
        at,
      );
      if (claim.kind === 'replay') {
        return replaySupplier(
          tx,
          tenant,
          PURCHASING_IDEMPOTENCY_SCOPES.supplierUpdate,
          request.operationId,
        );
      }

      // Held, not sampled. Two administrators renaming and deactivating the
      // same supplier at once would otherwise each read the row, each apply
      // their own field, and the second write would carry the first's stale
      // value for the field it did not touch.
      const held = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "suppliers"
         WHERE "tenantId" = ${tenant}::uuid AND "id" = ${plan.supplierId}::uuid
         FOR UPDATE`;
      if (held.at(0) === undefined) {
        throw new PurchasingRefusedError('unknown-supplier', plan.supplierId);
      }

      const updated = await tx.supplier.update({
        where: {
          tenantId_id: { tenantId: tenant, id: plan.supplierId },
        },
        data: {
          ...(plan.name === undefined ? {} : { name: plan.name }),
          ...(plan.isActive === undefined ? {} : { isActive: plan.isActive }),
          updatedAt: at,
        },
        select: { id: true, name: true, isActive: true, createdAt: true, updatedAt: true },
      });

      await appendPurchasingAudit(
        tx,
        tenant,
        actor.userId,
        null,
        PURCHASING_AUDIT_EVENTS.supplierUpdated,
        'supplier',
        plan.supplierId,
        {
          operationId: request.operationId,
          // The fields that changed, not a before/after of their values: an
          // administrator needs to know a supplier was deactivated, and audit
          // is not the place to keep a second copy of the merchant's data.
          nameChanged: plan.name !== undefined,
          activeChanged: plan.isActive !== undefined,
          isActive: updated.isActive,
        },
        at,
      );

      const result: SupplierResult = { supplier: toRecord(updated), replayed: false };
      // A second update to the same supplier must not rewrite what *this* one
      // answered, so the answer is stored rather than recomputed later.
      await writeOperationSnapshot(
        tx,
        tenant,
        PURCHASING_IDEMPOTENCY_SCOPES.supplierUpdate,
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

export const MAX_SUPPLIER_PAGE = 200;

export interface SupplierPage {
  readonly rows: readonly SupplierRecord[];
  /** The id to pass as the next cursor, or null when the page is the last. */
  readonly nextCursor: string | null;
}

/**
 * Keyset pagination on the id, not offset.
 *
 * A merchant's supplier list changes while they page through it, and `OFFSET`
 * against a moving table silently skips and repeats rows. The cursor is the
 * last id seen, so a page boundary means "after this supplier" and stays true
 * whatever else commits — the same reasoning the balance page already uses.
 *
 * The id is UUIDv7, so ordering by it is chronological: a merchant pages from
 * their oldest supplier towards their newest, which is a stable, meaningful
 * order rather than an arbitrary one.
 */
export async function listSuppliers(
  prisma: PrismaClient,
  tenantId: string,
  options: { readonly limit: number; readonly cursor: string | null; readonly activeOnly: boolean },
): Promise<SupplierPage> {
  const bounded = Math.max(1, Math.min(options.limit, MAX_SUPPLIER_PAGE));

  return withTenant(prisma, tenantId, async (tx) => {
    const rows = await tx.$queryRaw<SupplierRow[]>`
      SELECT "id", "name", "isActive", "createdAt", "updatedAt"
        FROM "suppliers"
       WHERE "tenantId" = ${tenantId}::uuid
         AND (${options.cursor}::uuid IS NULL OR "id" > ${options.cursor}::uuid)
         AND (${options.activeOnly} = FALSE OR "isActive" = TRUE)
       ORDER BY "id" ASC
       LIMIT ${bounded + 1}`;

    const page = rows.slice(0, bounded);
    const last = page.at(-1);
    return {
      rows: page.map(toRecord),
      nextCursor: rows.length > bounded && last !== undefined ? last.id : null,
    };
  });
}

export async function getSupplier(
  prisma: PrismaClient,
  tenantId: string,
  supplierId: string,
): Promise<SupplierRecord | null> {
  return withTenant(prisma, tenantId, async (tx) => {
    const row = await tx.supplier.findFirst({
      where: { tenantId, id: supplierId },
      select: { id: true, name: true, isActive: true, createdAt: true, updatedAt: true },
    });
    // Null rather than a refusal: under RLS another merchant's supplier simply
    // is not there, and a read should answer "no such supplier" identically in
    // both cases so the endpoint cannot be used to probe for which ids exist.
    return row === null ? null : toRecord(row);
  });
}
