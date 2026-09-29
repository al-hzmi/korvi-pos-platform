import { canonicalUuid, newId } from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import { withTenant } from '../tenant-context.js';
import { tenantParam } from '../repositories/mapping.js';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';

export type LotAdminRefusal =
  | 'product-not-found'
  | 'untracked-product'
  | 'already-enabled'
  | 'not-enabled'
  | 'negative-stock'
  | 'stale-revision'
  | 'lot-not-found'
  | 'invalid-state'
  | 'invalid-input'
  | 'stock-changed'
  | 'lot-unavailable'
  | 'idempotency-conflict';

export class LotAdminRefusedError extends DatabaseError {
  public override readonly name = 'LotAdminRefusedError';
  public constructor(public readonly detail: LotAdminRefusal) {
    super(`Lot administration refused: ${detail}`);
  }
}

export interface LotAdminActor {
  readonly userId: string;
}

export interface LotAvailabilityByBranch {
  readonly branchId: string;
  readonly quantityScaled: string;
}

export interface LotAdminLot {
  readonly id: string;
  readonly internalCode: string;
  readonly provenance: 'received' | 'produced' | 'historical-unknown' | 'manual-correction';
  readonly externalBatchReference: string | null;
  readonly dateKind: 'expiry' | 'best-before' | null;
  readonly dateValue: string | null;
  readonly status: 'active' | 'blocked' | 'closed';
  readonly revision: string;
  readonly firstObservedAt: string;
  readonly availabilityByBranch: readonly LotAvailabilityByBranch[];
}

export interface ProductLotAdminConfig {
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly trackingMode: 'none' | 'required';
  readonly selectionPolicy: 'fefo' | 'fifo';
  readonly dateRequirement: 'optional' | 'required';
  readonly revision: string;
  readonly businessTimeZone: string;
  readonly lots: readonly LotAdminLot[];
}

export interface EnableLotTrackingRequest {
  readonly selectionPolicy: 'fefo' | 'fifo';
  readonly dateRequirement: 'optional' | 'required';
  readonly occurredAt: string;
}

export interface UpdateLotPolicyRequest {
  readonly expectedRevision: string;
  readonly selectionPolicy?: 'fefo' | 'fifo' | undefined;
  readonly dateRequirement?: 'optional' | 'required' | undefined;
  readonly occurredAt: string;
}

export interface UpdateLotStatusRequest {
  readonly expectedRevision: string;
  readonly status: 'active' | 'blocked' | 'closed';
  readonly occurredAt: string;
}

export interface LotReclassificationLine {
  readonly lotId: string;
  readonly quantityScaled: string;
}

export interface RecordLotReclassificationRequest {
  readonly operationId: string;
  readonly requestHash: string;
  readonly productId: string;
  readonly branchId: string;
  readonly expectedBalanceRevision: string;
  readonly reason: string;
  readonly lines: readonly LotReclassificationLine[];
  readonly occurredAt: string;
}

interface ProductLockRow {
  id: string;
  sku: string;
  nameAr: string;
  trackInventory: boolean;
}

interface BalanceLockRow {
  branchId: string;
  quantityScaled: bigint;
  revision: bigint;
}

function instant(value: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new LotAdminRefusedError('invalid-input');
  return result;
}

function revision(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new LotAdminRefusedError('invalid-input');
  return BigInt(value);
}

function signedQuantity(value: string): bigint {
  if (!/^-?[1-9][0-9]{0,18}$/.test(value)) {
    throw new LotAdminRefusedError('invalid-input');
  }
  return BigInt(value);
}

function lotUuid(value: string): string {
  try {
    return canonicalUuid(value, 'lotId');
  } catch {
    throw new LotAdminRefusedError('invalid-input');
  }
}

function clean(value: string, max: number): string {
  const result = value.trim();
  if (result.length === 0 || result.length > max) throw new LotAdminRefusedError('invalid-input');
  return result;
}

function lotStatus(value: string): LotAdminLot['status'] {
  if (value === 'active' || value === 'blocked' || value === 'closed') return value;
  throw new DatabaseError('Lot status is outside ADR-0039.');
}

function lotProvenance(value: string): LotAdminLot['provenance'] {
  if (
    value === 'received' ||
    value === 'produced' ||
    value === 'historical-unknown' ||
    value === 'manual-correction'
  ) {
    return value;
  }
  throw new DatabaseError('Lot provenance is outside ADR-0039.');
}

function lotDateKind(value: string | null): LotAdminLot['dateKind'] {
  if (value === null || value === 'expiry' || value === 'best-before') return value;
  throw new DatabaseError('Lot date kind is outside ADR-0039.');
}

async function appendAudit(
  tx: TransactionClient,
  tenant: string,
  actor: LotAdminActor,
  eventType: string,
  entityType: string,
  entityId: string,
  metadata: Readonly<Record<string, string | number | boolean | null>>,
  occurredAt: Date,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      actorUserId: actor.userId,
      branchId: null,
      terminalId: null,
      eventType,
      entityType,
      entityId,
      metadata: { ...metadata },
      occurredAt,
    },
  });
}

async function loadConfig(
  tx: TransactionClient,
  tenant: string,
  productId: string,
): Promise<ProductLotAdminConfig | null> {
  const product = await tx.product.findFirst({
    where: { tenantId: tenant, id: productId },
    select: { id: true, sku: true, nameAr: true },
  });
  if (product === null) return null;

  const [policy, settings, lots, availability] = await Promise.all([
    tx.productLotPolicy.findUnique({
      where: { tenantId_productId: { tenantId: tenant, productId } },
    }),
    tx.tenantSettings.findUnique({
      where: { tenantId: tenant },
      select: { businessTimeZone: true },
    }),
    tx.inventoryLot.findMany({
      where: { tenantId: tenant, productId },
      orderBy: [{ status: 'asc' }, { dateValue: 'asc' }, { internalCode: 'asc' }],
    }),
    tx.$queryRawUnsafe<{ lotId: string; branchId: string; quantityScaled: bigint }[]>(
      'SELECT "lotId","branchId",SUM("quantityScaled")::bigint AS "quantityScaled" FROM "inventory_lot_entries" WHERE "tenantId"=$1::uuid AND "productId"=$2::uuid GROUP BY "lotId","branchId" ORDER BY "lotId","branchId"',
      tenant,
      productId,
    ),
  ]);

  const byLot = new Map<string, LotAvailabilityByBranch[]>();
  for (const row of availability) {
    const rows = byLot.get(row.lotId) ?? [];
    rows.push({ branchId: row.branchId, quantityScaled: row.quantityScaled.toString() });
    byLot.set(row.lotId, rows);
  }

  return {
    productId: product.id,
    sku: product.sku,
    nameAr: product.nameAr,
    trackingMode: policy?.trackingMode === 'required' ? 'required' : 'none',
    selectionPolicy: policy?.selectionPolicy === 'fifo' ? 'fifo' : 'fefo',
    dateRequirement: policy?.dateRequirement === 'required' ? 'required' : 'optional',
    revision: (policy?.revision ?? 0n).toString(),
    businessTimeZone: settings?.businessTimeZone ?? 'Asia/Riyadh',
    lots: lots.map((lot) => ({
      id: lot.id,
      internalCode: lot.internalCode,
      provenance: lotProvenance(lot.provenance),
      externalBatchReference: lot.externalBatchReference,
      dateKind: lotDateKind(lot.dateKind),
      dateValue: lot.dateValue?.toISOString().slice(0, 10) ?? null,
      status: lotStatus(lot.status),
      revision: lot.revision.toString(),
      firstObservedAt: lot.firstObservedAt.toISOString(),
      availabilityByBranch: byLot.get(lot.id) ?? [],
    })),
  };
}

async function lockProduct(
  tx: TransactionClient,
  tenant: string,
  productId: string,
): Promise<ProductLockRow> {
  const rows = await tx.$queryRawUnsafe<ProductLockRow[]>(
    'SELECT "id","sku","nameAr","trackInventory" FROM "products" WHERE "tenantId"=$1::uuid AND "id"=$2::uuid FOR UPDATE',
    tenant,
    productId,
  );
  const row = rows.at(0);
  if (row === undefined) throw new LotAdminRefusedError('product-not-found');
  if (!row.trackInventory) throw new LotAdminRefusedError('untracked-product');
  return row;
}

async function lockProductBalances(
  tx: TransactionClient,
  tenant: string,
  productId: string,
): Promise<readonly BalanceLockRow[]> {
  return tx.$queryRawUnsafe<BalanceLockRow[]>(
    'SELECT "branchId","quantityScaled","revision" FROM "inventory_balances" WHERE "tenantId"=$1::uuid AND "productId"=$2::uuid ORDER BY "branchId" FOR UPDATE',
    tenant,
    productId,
  );
}

function historicalCode(branchId: string, lotId: string): string {
  const branch = branchId.replaceAll('-', '').slice(-8).toUpperCase();
  const lot = lotId.replaceAll('-', '').slice(-12).toUpperCase();
  return `HIST-${branch}-${lot}`;
}

export async function readProductLotConfig(
  prisma: PrismaClient,
  scope: TenantScope,
  productId: string,
): Promise<ProductLotAdminConfig | null> {
  return withTenant(prisma, scope.tenantId, (tx) => loadConfig(tx, tenantParam(scope), productId));
}

export async function enableProductLotTracking(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: LotAdminActor,
  productId: string,
  input: EnableLotTrackingRequest,
): Promise<ProductLotAdminConfig> {
  const occurredAt = instant(input.occurredAt);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockProduct(tx, tenant, productId);
    const current = await tx.productLotPolicy.findUnique({
      where: { tenantId_productId: { tenantId: tenant, productId } },
    });
    if (current?.trackingMode === 'required') {
      throw new LotAdminRefusedError('already-enabled');
    }

    const balances = await lockProductBalances(tx, tenant, productId);
    if (balances.some((balance) => balance.quantityScaled < 0n)) {
      throw new LotAdminRefusedError('negative-stock');
    }
    if ((await tx.inventoryLotEntry.count({ where: { tenantId: tenant, productId } })) !== 0) {
      throw new DatabaseError('Lot entries exist before lot tracking activation.');
    }

    if (current === null) {
      await tx.productLotPolicy.create({
        data: {
          tenantId: tenant,
          productId,
          trackingMode: 'required',
          selectionPolicy: input.selectionPolicy,
          dateRequirement: input.dateRequirement,
          revision: 1n,
          updatedAt: occurredAt,
        },
      });
    } else {
      await tx.productLotPolicy.update({
        where: { tenantId_productId: { tenantId: tenant, productId } },
        data: {
          trackingMode: 'required',
          selectionPolicy: input.selectionPolicy,
          dateRequirement: input.dateRequirement,
          revision: current.revision + 1n,
          updatedAt: occurredAt,
        },
      });
    }

    let seededBranches = 0;
    for (const balance of balances) {
      if (balance.quantityScaled === 0n) continue;
      const lotId = newId();
      await tx.inventoryLot.create({
        data: {
          id: lotId,
          tenantId: tenant,
          productId,
          internalCode: historicalCode(balance.branchId, lotId),
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
      await tx.inventoryLotEntry.create({
        data: {
          id: newId(),
          tenantId: tenant,
          branchId: balance.branchId,
          productId,
          lotId,
          quantityScaled: balance.quantityScaled,
          causeKind: 'tracking-baseline',
          inventoryMovementId: null,
          reclassificationId: null,
          actorUserId: actor.userId,
          occurredAt,
        },
      });
      seededBranches += 1;
    }

    await appendAudit(
      tx,
      tenant,
      actor,
      'lot-policy.enabled',
      'product-lot-policy',
      productId,
      {
        selectionPolicy: input.selectionPolicy,
        dateRequirement: input.dateRequirement,
        seededBranches,
      },
      occurredAt,
    );

    const result = await loadConfig(tx, tenant, productId);
    if (result === null) throw new DatabaseError('Product disappeared after lot activation.');
    return result;
  });
}

export async function updateProductLotPolicy(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: LotAdminActor,
  productId: string,
  input: UpdateLotPolicyRequest,
): Promise<ProductLotAdminConfig> {
  const occurredAt = instant(input.occurredAt);
  const expected = revision(input.expectedRevision);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockProduct(tx, tenant, productId);
    const policy = await tx.productLotPolicy.findUnique({
      where: { tenantId_productId: { tenantId: tenant, productId } },
    });
    if (policy === null || policy.trackingMode !== 'required') {
      throw new LotAdminRefusedError('not-enabled');
    }
    if (policy.revision !== expected) throw new LotAdminRefusedError('stale-revision');

    const changed = await tx.productLotPolicy.updateMany({
      where: { tenantId: tenant, productId, revision: expected, trackingMode: 'required' },
      data: {
        ...(input.selectionPolicy === undefined ? {} : { selectionPolicy: input.selectionPolicy }),
        ...(input.dateRequirement === undefined ? {} : { dateRequirement: input.dateRequirement }),
        revision: { increment: 1n },
        updatedAt: occurredAt,
      },
    });
    if (changed.count !== 1) throw new LotAdminRefusedError('stale-revision');

    await appendAudit(
      tx,
      tenant,
      actor,
      'lot-policy.updated',
      'product-lot-policy',
      productId,
      {
        selectionPolicy: input.selectionPolicy ?? policy.selectionPolicy,
        dateRequirement: input.dateRequirement ?? policy.dateRequirement,
      },
      occurredAt,
    );
    const result = await loadConfig(tx, tenant, productId);
    if (result === null) throw new DatabaseError('Product disappeared after lot policy update.');
    return result;
  });
}

export async function updateInventoryLotStatus(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: LotAdminActor,
  lotId: string,
  input: UpdateLotStatusRequest,
): Promise<ProductLotAdminConfig> {
  const occurredAt = instant(input.occurredAt);
  const expected = revision(input.expectedRevision);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    const rows = await tx.$queryRawUnsafe<
      { id: string; productId: string; status: string; revision: bigint }[]
    >(
      'SELECT "id","productId","status","revision" FROM "inventory_lots" WHERE "tenantId"=$1::uuid AND "id"=$2::uuid FOR UPDATE',
      tenant,
      lotUuid(lotId),
    );
    const lot = rows.at(0);
    if (lot === undefined) throw new LotAdminRefusedError('lot-not-found');
    if (lot.revision !== expected) throw new LotAdminRefusedError('stale-revision');
    if (lot.status === 'closed') throw new LotAdminRefusedError('invalid-state');

    if (input.status === 'closed') {
      const aggregate = await tx.inventoryLotEntry.aggregate({
        where: { tenantId: tenant, lotId: lot.id },
        _sum: { quantityScaled: true },
      });
      if ((aggregate._sum.quantityScaled ?? 0n) !== 0n) {
        throw new LotAdminRefusedError('lot-unavailable');
      }
    }

    const updated = await tx.inventoryLot.updateMany({
      where: { tenantId: tenant, id: lot.id, revision: expected },
      data: {
        status: input.status,
        revision: { increment: 1n },
        updatedAt: occurredAt,
      },
    });
    if (updated.count !== 1) throw new LotAdminRefusedError('stale-revision');

    await appendAudit(
      tx,
      tenant,
      actor,
      'inventory-lot.status-changed',
      'inventory-lot',
      lot.id,
      { previousStatus: lot.status, currentStatus: input.status },
      occurredAt,
    );
    const result = await loadConfig(tx, tenant, lot.productId);
    if (result === null) throw new DatabaseError('Lot product disappeared after status update.');
    return result;
  });
}

export async function recordInventoryLotReclassification(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: LotAdminActor,
  input: RecordLotReclassificationRequest,
): Promise<ProductLotAdminConfig> {
  const occurredAt = instant(input.occurredAt);
  const expected = revision(input.expectedBalanceRevision);
  const operationId = clean(input.operationId, 120);
  const reason = clean(input.reason, 200);
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.requestHash) || input.lines.length < 2) {
    throw new LotAdminRefusedError('invalid-input');
  }

  const lines = input.lines.map((line) => ({
    lotId: lotUuid(line.lotId),
    quantityScaled: signedQuantity(line.quantityScaled),
  }));
  if (
    lines.some((line) => line.quantityScaled === 0n) ||
    new Set(lines.map((line) => line.lotId)).size !== lines.length ||
    lines.reduce((sum, line) => sum + line.quantityScaled, 0n) !== 0n
  ) {
    throw new LotAdminRefusedError('invalid-input');
  }

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    const previous = await tx.inventoryLotReclassification.findFirst({
      where: { tenantId: tenant, operationId },
      select: { id: true, requestHash: true, productId: true },
    });
    if (previous !== null) {
      if (previous.requestHash !== input.requestHash) {
        throw new LotAdminRefusedError('idempotency-conflict');
      }
      const replay = await loadConfig(tx, tenant, previous.productId);
      if (replay === null) throw new DatabaseError('Reclassification product disappeared.');
      return replay;
    }

    await lockProduct(tx, tenant, input.productId);
    const policy = await tx.productLotPolicy.findUnique({
      where: { tenantId_productId: { tenantId: tenant, productId: input.productId } },
      select: { trackingMode: true },
    });
    if (policy?.trackingMode !== 'required') throw new LotAdminRefusedError('not-enabled');

    const balances = await tx.$queryRawUnsafe<{ quantityScaled: bigint; revision: bigint }[]>(
      'SELECT "quantityScaled","revision" FROM "inventory_balances" WHERE "tenantId"=$1::uuid AND "branchId"=$2::uuid AND "productId"=$3::uuid FOR UPDATE',
      tenant,
      input.branchId,
      input.productId,
    );
    const balance = balances.at(0);
    if (balance === undefined || balance.revision !== expected) {
      throw new LotAdminRefusedError('stock-changed');
    }

    for (const lotId of [...lines.map((line) => line.lotId)].sort()) {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "inventory_lots" WHERE "tenantId"=$1::uuid AND "productId"=$2::uuid AND "id"=$3::uuid FOR UPDATE',
        tenant,
        input.productId,
        lotId,
      );
    }
    const lots = await tx.inventoryLot.findMany({
      where: {
        tenantId: tenant,
        productId: input.productId,
        id: { in: lines.map((line) => line.lotId) },
      },
      select: { id: true },
    });
    if (lots.length !== lines.length) throw new LotAdminRefusedError('lot-not-found');

    const availability = await tx.$queryRawUnsafe<{ lotId: string; quantityScaled: bigint }[]>(
      'SELECT "lotId",SUM("quantityScaled")::bigint AS "quantityScaled" FROM "inventory_lot_entries" WHERE "tenantId"=$1::uuid AND "branchId"=$2::uuid AND "productId"=$3::uuid GROUP BY "lotId"',
      tenant,
      input.branchId,
      input.productId,
    );
    const available = new Map(availability.map((row) => [row.lotId, row.quantityScaled] as const));
    for (const line of lines) {
      if ((available.get(line.lotId) ?? 0n) + line.quantityScaled < 0n) {
        throw new LotAdminRefusedError('lot-unavailable');
      }
    }

    const id = newId();
    await tx.inventoryLotReclassification.create({
      data: {
        id,
        tenantId: tenant,
        branchId: input.branchId,
        productId: input.productId,
        operationId,
        requestHash: input.requestHash,
        expectedBalanceRevision: expected,
        reason,
        actorUserId: actor.userId,
        occurredAt,
      },
    });
    await tx.inventoryLotEntry.createMany({
      data: lines.map((line) => ({
        id: newId(),
        tenantId: tenant,
        branchId: input.branchId,
        productId: input.productId,
        lotId: line.lotId,
        quantityScaled: line.quantityScaled,
        causeKind: 'reclassification',
        inventoryMovementId: null,
        reclassificationId: id,
        actorUserId: actor.userId,
        occurredAt,
      })),
    });

    await appendAudit(
      tx,
      tenant,
      actor,
      'inventory-lot.reclassified',
      'inventory-lot-reclassification',
      id,
      {
        productId: input.productId,
        branchId: input.branchId,
        expectedBalanceRevision: expected.toString(),
        lineCount: lines.length,
      },
      occurredAt,
    );
    const result = await loadConfig(tx, tenant, input.productId);
    if (result === null) throw new DatabaseError('Reclassification product disappeared.');
    return result;
  });
}
