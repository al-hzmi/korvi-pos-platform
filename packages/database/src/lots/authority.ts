import {
  assertLotEntriesReconcile,
  canonicalUuid,
  deriveLotCountPlan,
  lotDateState,
  newId,
  parseCalendarDate,
  selectLotAllocations,
  splitLotCountPlan,
} from '@korvi/domain';
import { DatabaseError, LotPolicyRefusedError } from '../errors.js';
import type { InventoryMovementInput, LotCountExecutionPlan } from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';

export interface ExplicitMovementLotAllocation {
  readonly lotId: string;
  /** Same sign and scaled base quantity as the canonical movement. */
  readonly quantityScaled: string;
}

export interface IncomingMovementLotFact {
  /** Positive base Product quantity after package conversion. */
  readonly quantityScaled: string;
  readonly externalBatchReference: string | null;
  readonly dateKind: 'expiry' | 'best-before' | null;
  readonly dateValue: string | null;
}

/** Backward-compatible name used by the purchasing receiving authority. */
export type ReceivedMovementLotFact = IncomingMovementLotFact;

export type MovementLotDirective =
  | {
      readonly kind: 'explicit';
      readonly allocations: readonly ExplicitMovementLotAllocation[];
    }
  | {
      readonly kind: 'received';
      readonly lots: readonly IncomingMovementLotFact[];
    }
  | {
      /** Restaurant/recipe production creates explicit produced provenance. */
      readonly kind: 'produced';
      readonly lots: readonly IncomingMovementLotFact[];
    }
  | {
      /** Governed positive correction creates explicit manual provenance. */
      readonly kind: 'manual-correction';
      readonly lots: readonly IncomingMovementLotFact[];
    }
  | {
      /**
       * Original sale predates lot snapshots. If the Product is lot-controlled
       * now, restore into a fresh explicit historical-unknown lot rather than
       * fabricating a batch/date or silently choosing a current lot.
       */
      readonly kind: 'historical-return';
    };

export interface PreparedMovementLotAllocation {
  readonly lotId: string;
  readonly quantityScaled: bigint;
  readonly internalCode: string;
  readonly provenance: string;
  readonly externalBatchReference: string | null;
  readonly dateKind: 'expiry' | 'best-before' | null;
  readonly dateValue: string | null;
}

interface LotRow {
  id: string;
  internalCode: string;
  provenance: string;
  externalBatchReference: string | null;
  dateKind: string | null;
  dateValue: Date | null;
  status: string;
  firstObservedAt: Date;
}

interface AvailabilityRow extends LotRow {
  availableQuantityScaled: bigint;
}

function dateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function dateKind(value: string | null): 'expiry' | 'best-before' | null {
  if (value === null || value === 'expiry' || value === 'best-before') return value;
  throw new Error('Inventory lot contains an unsupported date kind.');
}

function businessDateAt(instant: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (year === undefined || month === undefined || day === undefined) {
      throw new Error('missing calendar part');
    }
    return `${year}-${month}-${day}`;
  } catch {
    throw new LotPolicyRefusedError('invalid-business-time-zone');
  }
}

async function trackingPolicy(
  tx: TransactionClient,
  tenant: string,
  productId: string,
): Promise<null | {
  readonly selectionPolicy: 'fefo' | 'fifo';
  readonly dateRequirement: 'optional' | 'required';
}> {
  const policy = await tx.productLotPolicy.findUnique({
    where: { tenantId_productId: { tenantId: tenant, productId } },
    select: { trackingMode: true, selectionPolicy: true, dateRequirement: true },
  });
  if (policy === null || policy.trackingMode !== 'required') return null;
  if (
    (policy.selectionPolicy !== 'fefo' && policy.selectionPolicy !== 'fifo') ||
    (policy.dateRequirement !== 'optional' && policy.dateRequirement !== 'required')
  ) {
    throw new Error('Product lot policy is outside ADR-0039.');
  }
  return {
    selectionPolicy: policy.selectionPolicy,
    dateRequirement: policy.dateRequirement,
  };
}

async function lockAllProductLots(
  tx: TransactionClient,
  tenant: string,
  productId: string,
): Promise<void> {
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "inventory_lots" WHERE "tenantId" = $1::uuid AND "productId" = $2::uuid ORDER BY "id" FOR UPDATE',
    tenant,
    productId,
  );
}

async function availabilityRows(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
  productId: string,
): Promise<readonly AvailabilityRow[]> {
  return tx.$queryRawUnsafe<AvailabilityRow[]>(
    'SELECT l."id",l."internalCode",l."provenance",l."externalBatchReference",l."dateKind",l."dateValue",l."status",l."firstObservedAt",COALESCE(SUM(e."quantityScaled"),0)::bigint AS "availableQuantityScaled" FROM "inventory_lots" l LEFT JOIN "inventory_lot_entries" e ON e."tenantId"=l."tenantId" AND e."productId"=l."productId" AND e."lotId"=l."id" AND e."branchId"=$2::uuid WHERE l."tenantId"=$1::uuid AND l."productId"=$3::uuid GROUP BY l."id",l."internalCode",l."provenance",l."externalBatchReference",l."dateKind",l."dateValue",l."status",l."firstObservedAt" ORDER BY l."id"',
    tenant,
    branchId,
    productId,
  );
}

async function settingsTimeZone(tx: TransactionClient, tenant: string): Promise<string> {
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId: tenant },
    select: { businessTimeZone: true },
  });
  return settings?.businessTimeZone ?? 'Asia/Riyadh';
}

function snapshot(row: LotRow, quantityScaled: bigint): PreparedMovementLotAllocation {
  return {
    lotId: row.id,
    quantityScaled,
    internalCode: row.internalCode,
    provenance: row.provenance,
    externalBatchReference: row.externalBatchReference,
    dateKind: dateKind(row.dateKind),
    dateValue: dateOnly(row.dateValue),
  };
}

function cleanBatch(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.trim();
  if (cleaned.length === 0 || cleaned.length > 120) {
    throw new LotPolicyRefusedError('invalid-lot-fact');
  }
  return cleaned;
}

function receivedDate(
  kind: 'expiry' | 'best-before' | null,
  value: string | null,
  required: boolean,
): { readonly kind: 'expiry' | 'best-before' | null; readonly value: string | null } {
  if ((kind === null) !== (value === null)) {
    throw new LotPolicyRefusedError('invalid-lot-fact');
  }
  if (required && value === null) {
    throw new LotPolicyRefusedError('lot-date-required');
  }
  if (value !== null) {
    try {
      parseCalendarDate(value, 'dateValue');
    } catch {
      throw new LotPolicyRefusedError('invalid-lot-fact');
    }
  }
  return { kind, value };
}

function lotCode(id: string): string {
  return `LOT-${id.replaceAll('-', '').slice(-16).toUpperCase()}`;
}

async function createHistoricalReturnLotWithin(
  tx: TransactionClient,
  tenant: string,
  productId: string,
  occurredAt: Date,
): Promise<LotRow> {
  const id = newId();
  return tx.inventoryLot.create({
    data: {
      id,
      tenantId: tenant,
      productId,
      internalCode: `HRET-${id.replaceAll('-', '').slice(-16).toUpperCase()}`,
      provenance: 'historical-unknown',
      externalBatchReference: null,
      dateKind: null,
      dateValue: null,
      status: 'active',
      revision: 1n,
      firstObservedAt: occurredAt,
      updatedAt: occurredAt,
    },
  });
}

async function resolveIncomingLotWithin(
  tx: TransactionClient,
  tenant: string,
  productId: string,
  fact: IncomingMovementLotFact,
  occurredAt: Date,
  dateRequired: boolean,
  provenance: 'received' | 'produced' | 'manual-correction',
): Promise<LotRow> {
  let quantity: bigint;
  try {
    quantity = BigInt(fact.quantityScaled);
  } catch {
    throw new LotPolicyRefusedError('invalid-lot-fact');
  }
  if (quantity <= 0n) throw new LotPolicyRefusedError('invalid-lot-fact');

  const externalBatchReference = cleanBatch(fact.externalBatchReference);
  const received = receivedDate(fact.dateKind, fact.dateValue, dateRequired);
  const dateValue = received.value === null ? null : new Date(`${received.value}T00:00:00.000Z`);

  if (externalBatchReference === null) {
    const id = newId();
    return tx.inventoryLot.create({
      data: {
        id,
        tenantId: tenant,
        productId,
        internalCode: lotCode(id),
        provenance,
        externalBatchReference: null,
        dateKind: received.kind,
        dateValue,
        status: 'active',
        revision: 1n,
        firstObservedAt: occurredAt,
        updatedAt: occurredAt,
      },
    });
  }

  const candidateId = newId();
  await tx.$executeRawUnsafe(
    'INSERT INTO "inventory_lots" ("id","tenantId","productId","internalCode","provenance","externalBatchReference","dateKind","dateValue","status","revision","firstObservedAt","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::date,\'active\',1,$9,$9,$9) ON CONFLICT ("tenantId","productId","externalBatchReference") DO NOTHING',
    candidateId,
    tenant,
    productId,
    lotCode(candidateId),
    provenance,
    externalBatchReference,
    received.kind,
    received.value,
    occurredAt,
  );

  const row = await tx.inventoryLot.findFirst({
    where: { tenantId: tenant, productId, externalBatchReference },
  });
  if (row === null) throw new LotPolicyRefusedError('lot-identity-conflict');

  const existingDate = dateOnly(row.dateValue);
  if (
    row.provenance !== provenance ||
    row.dateKind !== received.kind ||
    existingDate !== received.value
  ) {
    throw new LotPolicyRefusedError('lot-identity-conflict');
  }
  return row;
}

/**
 * Called only after the canonical InventoryBalance and cost rows are locked.
 * It then locks lot identities in deterministic id order and derives the
 * movement's lot distribution from immutable entries.
 */
export async function prepareLotCountReconciliationWithin(
  tx: TransactionClient,
  tenant: string,
  input: {
    readonly branchId: string;
    readonly productId: string;
    readonly currentBalanceQuantityScaled: bigint;
    readonly countedQuantityScaled: bigint;
    readonly observations: readonly {
      readonly lotId: string;
      readonly countedQuantityScaled: bigint;
    }[];
  },
): Promise<LotCountExecutionPlan> {
  const policy = await trackingPolicy(tx, tenant, input.productId);
  if (policy === null) throw new LotPolicyRefusedError('lot-product-mismatch');

  await lockAllProductLots(tx, tenant, input.productId);
  const available = await availabilityRows(tx, tenant, input.branchId, input.productId);
  const currentTotal = available.reduce((sum, lot) => sum + lot.availableQuantityScaled, 0n);
  if (currentTotal !== input.currentBalanceQuantityScaled) {
    throw new DatabaseError(
      'Lot distribution does not reconcile to the canonical InventoryBalance before count.',
    );
  }

  const known = new Set(available.map((lot) => lot.id));
  if (input.observations.some((lot) => !known.has(canonicalUuid(lot.lotId, 'lotId')))) {
    throw new LotPolicyRefusedError('unknown-lot');
  }

  const plan = deriveLotCountPlan({
    current: available.map((lot) => ({
      lotId: lot.id,
      quantityScaled: lot.availableQuantityScaled,
    })),
    counted: input.observations.map((lot) => ({
      lotId: lot.lotId,
      quantityScaled: lot.countedQuantityScaled,
    })),
  });
  if (plan.totalCountedQuantityScaled !== input.countedQuantityScaled) {
    throw new LotPolicyRefusedError('invalid-lot-fact');
  }
  if (
    plan.totalBeforeQuantityScaled !== input.currentBalanceQuantityScaled ||
    plan.totalDeltaQuantityScaled !==
      input.countedQuantityScaled - input.currentBalanceQuantityScaled
  ) {
    throw new DatabaseError('Lot count plan diverged from canonical Product count.');
  }
  return splitLotCountPlan(plan);
}

export async function commitLotCountReclassificationWithin(
  tx: TransactionClient,
  tenant: string,
  input: {
    readonly countId: string;
    readonly branchId: string;
    readonly productId: string;
    readonly expectedBalanceRevision: bigint;
    readonly requestHash: string;
    readonly reason: string | null;
    readonly actorUserId: string;
    readonly occurredAt: Date;
    readonly lines: readonly {
      readonly lotId: string;
      readonly quantityScaled: bigint;
    }[];
  },
): Promise<string | null> {
  if (input.lines.length === 0) return null;
  if (
    input.lines.some((line) => line.quantityScaled === 0n) ||
    input.lines.reduce((sum, line) => sum + line.quantityScaled, 0n) !== 0n
  ) {
    throw new DatabaseError('Count lot reclassification must be non-empty and zero-net.');
  }

  const id = newId();
  await tx.inventoryLotReclassification.create({
    data: {
      id,
      tenantId: tenant,
      branchId: input.branchId,
      productId: input.productId,
      operationId: `count:${input.countId}:${input.productId}`,
      requestHash: input.requestHash,
      expectedBalanceRevision: input.expectedBalanceRevision,
      reason: input.reason ?? 'physical-count-lot-reconciliation',
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
    },
  });
  await tx.inventoryLotEntry.createMany({
    data: input.lines.map((line) => ({
      id: newId(),
      tenantId: tenant,
      branchId: input.branchId,
      productId: input.productId,
      lotId: line.lotId,
      quantityScaled: line.quantityScaled,
      causeKind: 'reclassification',
      inventoryMovementId: null,
      reclassificationId: id,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
    })),
  });
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      actorUserId: input.actorUserId,
      branchId: input.branchId,
      terminalId: null,
      eventType: 'inventory-lot.reclassified',
      entityType: 'inventory-lot-reclassification',
      entityId: id,
      metadata: {
        source: 'physical-count',
        countId: input.countId,
        productId: input.productId,
        lineCount: input.lines.length,
      },
      occurredAt: input.occurredAt,
    },
  });
  return id;
}

export async function prepareMovementLotsWithin(
  tx: TransactionClient,
  tenant: string,
  movement: InventoryMovementInput,
  directive?: MovementLotDirective,
): Promise<readonly PreparedMovementLotAllocation[]> {
  const policy = await trackingPolicy(tx, tenant, movement.productId);
  if (policy === null) {
    if (directive?.kind === 'historical-return') return [];
    if (
      directive !== undefined &&
      (directive.kind === 'explicit' ? directive.allocations.length > 0 : directive.lots.length > 0)
    ) {
      throw new LotPolicyRefusedError('lot-product-mismatch');
    }
    return [];
  }

  const movementQuantity = BigInt(movement.quantityScaled);
  await lockAllProductLots(tx, tenant, movement.productId);

  if (directive?.kind === 'historical-return') {
    if (movementQuantity <= 0n) {
      throw new LotPolicyRefusedError('invalid-lot-fact');
    }
    const row = await createHistoricalReturnLotWithin(
      tx,
      tenant,
      movement.productId,
      new Date(movement.occurredAt),
    );
    return [snapshot(row, movementQuantity)];
  }

  if (
    directive?.kind === 'received' ||
    directive?.kind === 'produced' ||
    directive?.kind === 'manual-correction'
  ) {
    if (movementQuantity <= 0n || directive.lots.length === 0) {
      throw new LotPolicyRefusedError('invalid-lot-fact');
    }
    const occurredAt = new Date(movement.occurredAt);
    const resolved: PreparedMovementLotAllocation[] = [];
    for (const fact of directive.lots) {
      const row = await resolveIncomingLotWithin(
        tx,
        tenant,
        movement.productId,
        fact,
        occurredAt,
        policy.dateRequirement === 'required',
        directive.kind,
      );
      let quantity: bigint;
      try {
        quantity = BigInt(fact.quantityScaled);
      } catch {
        throw new LotPolicyRefusedError('invalid-lot-fact');
      }
      resolved.push(snapshot(row, quantity));
    }
    assertLotEntriesReconcile(
      movementQuantity,
      resolved.map((allocation) => ({
        lotId: allocation.lotId,
        quantityScaled: allocation.quantityScaled,
      })),
    );
    return resolved;
  }

  if (directive?.kind === 'explicit') {
    const requested = directive.allocations.map((allocation) => ({
      lotId: canonicalUuid(allocation.lotId, 'lotId'),
      quantityScaled: BigInt(allocation.quantityScaled),
    }));
    assertLotEntriesReconcile(movementQuantity, requested);

    const lots = await tx.inventoryLot.findMany({
      where: {
        tenantId: tenant,
        productId: movement.productId,
        id: { in: requested.map((allocation) => allocation.lotId) },
      },
    });
    const byId = new Map(lots.map((lot) => [lot.id, lot] as const));
    if (byId.size !== requested.length) {
      throw new LotPolicyRefusedError('unknown-lot');
    }

    // Explicit negative allocations are still ordinary consumption: a caller
    // may choose a specific eligible lot, but it cannot use the explicit path
    // to bypass lifecycle/expiry or derived availability.
    if (movementQuantity < 0n) {
      const at = new Date(movement.occurredAt);
      const businessDate = businessDateAt(at, await settingsTimeZone(tx, tenant));
      const available = new Map(
        (await availabilityRows(tx, tenant, movement.branchId, movement.productId)).map(
          (row) => [row.id, row] as const,
        ),
      );
      for (const allocation of requested) {
        const row = available.get(allocation.lotId);
        if (
          row === undefined ||
          row.status !== 'active' ||
          lotDateState(dateKind(row.dateKind), dateOnly(row.dateValue), businessDate) ===
            'expired' ||
          row.availableQuantityScaled < -allocation.quantityScaled
        ) {
          throw new LotPolicyRefusedError('lot-unavailable');
        }
      }
    }

    return requested.map((allocation) => {
      const row = byId.get(allocation.lotId);
      if (row === undefined) throw new LotPolicyRefusedError('unknown-lot');
      return snapshot(row, allocation.quantityScaled);
    });
  }

  if (movementQuantity > 0n) {
    throw new LotPolicyRefusedError('incoming-lot-required');
  }

  const instant = new Date(movement.occurredAt);
  const businessDate = businessDateAt(instant, await settingsTimeZone(tx, tenant));
  const available = await availabilityRows(tx, tenant, movement.branchId, movement.productId);
  const selected = selectLotAllocations({
    requiredQuantityScaled: -movementQuantity,
    policy: policy.selectionPolicy,
    businessDate,
    candidates: available.map((row) => ({
      lotId: row.id,
      availableQuantityScaled: row.availableQuantityScaled,
      firstObservedAtMs: row.firstObservedAt.getTime(),
      dateKind: dateKind(row.dateKind),
      dateValue: dateOnly(row.dateValue),
      status:
        row.status === 'active' || row.status === 'blocked' || row.status === 'closed'
          ? row.status
          : 'blocked',
    })),
  });

  const byId = new Map(available.map((row) => [row.id, row] as const));
  return selected.map((allocation) => {
    const row = byId.get(allocation.lotId);
    if (row === undefined) throw new LotPolicyRefusedError('unknown-lot');
    return snapshot(row, -allocation.quantityScaled);
  });
}

export async function commitMovementLotsWithin(
  tx: TransactionClient,
  tenant: string,
  movement: InventoryMovementInput,
  allocations: readonly PreparedMovementLotAllocation[],
  nextId: () => string,
): Promise<void> {
  if (allocations.length === 0) return;
  assertLotEntriesReconcile(
    BigInt(movement.quantityScaled),
    allocations.map((allocation) => ({
      lotId: allocation.lotId,
      quantityScaled: allocation.quantityScaled,
    })),
  );

  await tx.inventoryLotEntry.createMany({
    data: allocations.map((allocation) => ({
      id: nextId(),
      tenantId: tenant,
      branchId: movement.branchId,
      productId: movement.productId,
      lotId: allocation.lotId,
      quantityScaled: allocation.quantityScaled,
      causeKind: 'movement',
      inventoryMovementId: movement.id,
      reclassificationId: null,
      actorUserId: movement.actorUserId,
      occurredAt: new Date(movement.occurredAt),
    })),
  });
}
