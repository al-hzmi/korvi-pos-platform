import { createHash } from 'node:crypto';
import { newId } from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const CREATE_SCOPE = 'restaurant.order.create';
const CANCEL_SCOPE = 'restaurant.order.cancel';
const TRANSFER_TABLE_SCOPE = 'restaurant.order.transfer-table';
const MAX_BIGINT = 9_223_372_036_854_775_807n;

export type RestaurantOrderRefusal =
  | 'restaurant-mode-required'
  | 'branch-required'
  | 'unknown-terminal'
  | 'unknown-table'
  | 'table-occupied'
  | 'table-not-applicable'
  | 'unknown-product'
  | 'product-unavailable'
  | 'invalid-quantity'
  | 'unknown-order'
  | 'order-not-open'
  | 'stale-revision'
  | 'idempotency-conflict'
  | 'operation-in-progress';

export class RestaurantOrderRefusedError extends DatabaseError {
  public override readonly name = 'RestaurantOrderRefusedError';

  public constructor(public readonly detail: RestaurantOrderRefusal) {
    super('Restaurant order operation refused: ' + detail);
  }
}

export interface RestaurantOrderActor {
  readonly userId: string;
  readonly branchId: string;
  readonly boundTerminalId: string | null;
}

export interface RestaurantOrderCreateLine {
  readonly productId: string;
  readonly quantityScaled: string;
  readonly preparationNote: string | null;
  readonly preparationOptions: string | null;
}

export interface RestaurantOrderCreateRequest {
  readonly operationId: string;
  readonly terminalId: string;
  readonly orderType: 'dine-in' | 'takeaway' | 'delivery';
  readonly tableId: string | null;
  readonly lines: readonly RestaurantOrderCreateLine[];
}

export interface RestaurantOrderCancelRequest {
  readonly operationId: string;
  readonly expectedRevision: string;
  readonly reason: string;
}

export interface RestaurantOrderTransferTableRequest {
  readonly operationId: string;
  readonly expectedRevision: string;
  readonly tableId: string;
}

export interface RestaurantOrderLine {
  readonly id: string;
  readonly lineNumber: number;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly unitPriceMinor: string;
  readonly vatBasisPoints: number;
  readonly quantityScaled: string;
  readonly preparationNote: string | null;
  readonly preparationOptions: string | null;
  /** Server-authored snapshot; null only for pre-settlement-authority historical rows. */
  readonly trackInventory: boolean | null;
}

export interface RestaurantOrderSummary {
  readonly id: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly tableId: string | null;
  readonly tableCode: string | null;
  readonly tableNameAr: string | null;
  readonly orderType: 'dine-in' | 'takeaway' | 'delivery';
  readonly status: 'open' | 'cancelled' | 'settled';
  readonly revision: string;
  readonly priceMode: string;
  readonly currency: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closedReason: string | null;
  readonly lineCount: number;
}

export interface RestaurantOrderDetail extends RestaurantOrderSummary {
  readonly lines: readonly RestaurantOrderLine[];
}

export interface RestaurantOrderMutationResult {
  readonly order: RestaurantOrderDetail;
  readonly replayed: boolean;
}

interface LineRow {
  id: string;
  lineNumber: number;
  productId: string;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  productType: string;
  unitPriceMinor: bigint;
  vatBasisPoints: number;
  quantityScaled: bigint;
  preparationNote: string | null;
  preparationOptions: string | null;
  trackInventory: boolean | null;
}

interface OrderRow {
  id: string;
  branchId: string;
  terminalId: string;
  userId: string;
  tableId: string | null;
  orderType: string;
  status: string;
  revision: bigint;
  priceMode: string;
  currency: string;
  openedAt: Date;
  closedAt: Date | null;
  closedReason: string | null;
  table: { code: string; nameAr: string } | null;
  lines: readonly LineRow[];
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeOptionalText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function quantity(value: string, productType: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new RestaurantOrderRefusedError('invalid-quantity');
  }
  if (parsed <= 0n || parsed > MAX_BIGINT) {
    throw new RestaurantOrderRefusedError('invalid-quantity');
  }
  if (productType === 'unit' && parsed % 1_000n !== 0n) {
    throw new RestaurantOrderRefusedError('invalid-quantity');
  }
  return parsed;
}

function asLine(row: LineRow): RestaurantOrderLine {
  if (row.productType !== 'unit' && row.productType !== 'weighted') {
    throw new DatabaseError('Restaurant order line carries an unknown product type.');
  }
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    productId: row.productId,
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    productType: row.productType,
    unitPriceMinor: row.unitPriceMinor.toString(),
    vatBasisPoints: row.vatBasisPoints,
    quantityScaled: row.quantityScaled.toString(),
    preparationNote: row.preparationNote,
    preparationOptions: row.preparationOptions,
    trackInventory: row.trackInventory,
  };
}

function asOrder(row: OrderRow): RestaurantOrderDetail {
  if (
    (row.orderType !== 'dine-in' && row.orderType !== 'takeaway' && row.orderType !== 'delivery') ||
    (row.status !== 'open' && row.status !== 'cancelled' && row.status !== 'settled')
  ) {
    throw new DatabaseError('Restaurant order carries an unknown lifecycle value.');
  }
  return {
    id: row.id,
    branchId: row.branchId,
    terminalId: row.terminalId,
    userId: row.userId,
    tableId: row.tableId,
    tableCode: row.table?.code ?? null,
    tableNameAr: row.table?.nameAr ?? null,
    orderType: row.orderType,
    status: row.status,
    revision: row.revision.toString(),
    priceMode: row.priceMode,
    currency: row.currency,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    closedReason: row.closedReason,
    lineCount: row.lines.length,
    lines: row.lines.map(asLine),
  };
}

function summaryOf(order: RestaurantOrderDetail): RestaurantOrderSummary {
  return {
    id: order.id,
    branchId: order.branchId,
    terminalId: order.terminalId,
    userId: order.userId,
    tableId: order.tableId,
    tableCode: order.tableCode,
    tableNameAr: order.tableNameAr,
    orderType: order.orderType,
    status: order.status,
    revision: order.revision,
    priceMode: order.priceMode,
    currency: order.currency,
    openedAt: order.openedAt,
    closedAt: order.closedAt,
    closedReason: order.closedReason,
    lineCount: order.lineCount,
  };
}

async function readOrderWithin(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
  orderId: string,
): Promise<RestaurantOrderDetail | null> {
  const row = (await tx.restaurantOrder.findFirst({
    where: { tenantId: tenant, branchId, id: orderId },
    include: {
      table: { select: { code: true, nameAr: true } },
      lines: { orderBy: { lineNumber: 'asc' } },
    },
  })) as OrderRow | null;
  return row === null ? null : asOrder(row);
}

async function reserveOperation(
  tx: TransactionClient,
  tenant: string,
  scope: string,
  operationId: string,
  requestHash: string,
  nextId: () => string,
): Promise<RestaurantOrderDetail | null> {
  try {
    await tx.idempotencyKey.create({
      data: {
        id: nextId(),
        tenantId: tenant,
        scope,
        operationId,
        status: 'reserved',
        requestHash,
      },
    });
    return null;
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
  }

  const row = await tx.idempotencyKey.findFirst({
    where: { tenantId: tenant, scope, operationId },
    select: {
      status: true,
      requestHash: true,
      resultType: true,
      resultSnapshot: true,
    },
  });
  if (row === null) {
    throw new DatabaseError('Restaurant order idempotency collision did not name this operation.');
  }
  if (row.requestHash !== requestHash) {
    throw new RestaurantOrderRefusedError('idempotency-conflict');
  }
  if (row.status === 'completed') {
    if (row.resultType !== 'restaurant-order' || row.resultSnapshot === null) {
      throw new DatabaseError(
        'Completed restaurant order operation has no authoritative snapshot.',
      );
    }
    return row.resultSnapshot as unknown as RestaurantOrderDetail;
  }
  throw new RestaurantOrderRefusedError('operation-in-progress');
}

async function completeOperation(
  tx: TransactionClient,
  tenant: string,
  scope: string,
  operationId: string,
  order: RestaurantOrderDetail,
  at: Date,
): Promise<void> {
  const changed = await tx.idempotencyKey.updateMany({
    where: { tenantId: tenant, scope, operationId, status: 'reserved' },
    data: {
      status: 'completed',
      resultType: 'restaurant-order',
      resultId: order.id,
      resultSnapshot: { ...order, lines: order.lines.map((line) => ({ ...line })) },
      completedAt: at,
    },
  });
  if (changed.count !== 1) {
    throw new DatabaseError('Restaurant order idempotency row could not be completed.');
  }
}

async function appendAudit(
  tx: TransactionClient,
  tenant: string,
  actor: RestaurantOrderActor,
  terminalId: string,
  eventType:
    'restaurant.order.opened' | 'restaurant.order.cancelled' | 'restaurant.order.table-transferred',
  orderId: string,
  metadata: Readonly<Record<string, string | number | boolean | null>>,
  at: Date,
  nextId: () => string,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: nextId(),
      tenantId: tenant,
      actorUserId: actor.userId,
      branchId: actor.branchId,
      terminalId,
      eventType,
      entityType: 'restaurant-order',
      entityId: orderId,
      metadata: { ...metadata },
      occurredAt: at,
    },
  });
}

async function requireRestaurantSettings(
  tx: TransactionClient,
  tenant: string,
): Promise<{ priceMode: string; currency: string }> {
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId: tenant },
    select: { vertical: true, priceMode: true, currency: true },
  });
  if (settings === null || settings.vertical !== 'restaurant') {
    throw new RestaurantOrderRefusedError('restaurant-mode-required');
  }
  return { priceMode: settings.priceMode, currency: settings.currency };
}

async function requireTerminal(
  tx: TransactionClient,
  tenant: string,
  actor: RestaurantOrderActor,
  terminalId: string,
): Promise<void> {
  if (actor.boundTerminalId !== null && actor.boundTerminalId !== terminalId) {
    throw new RestaurantOrderRefusedError('unknown-terminal');
  }
  const terminal = await tx.terminal.findFirst({
    where: { tenantId: tenant, id: terminalId, branchId: actor.branchId, isActive: true },
    select: { id: true },
  });
  if (terminal === null) throw new RestaurantOrderRefusedError('unknown-terminal');
}

async function requireTable(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
  orderType: RestaurantOrderCreateRequest['orderType'],
  tableId: string | null,
): Promise<void> {
  if (orderType !== 'dine-in') {
    if (tableId !== null) throw new RestaurantOrderRefusedError('unknown-table');
    return;
  }
  if (tableId === null) throw new RestaurantOrderRefusedError('unknown-table');

  const table = await tx.restaurantTable.findFirst({
    where: { tenantId: tenant, branchId, id: tableId, isActive: true },
    select: { id: true },
  });
  if (table === null) throw new RestaurantOrderRefusedError('unknown-table');

  const occupied = await tx.restaurantOrder.findFirst({
    where: { tenantId: tenant, tableId, status: 'open' },
    select: { id: true },
  });
  if (occupied !== null) throw new RestaurantOrderRefusedError('table-occupied');
}

export async function listOpenRestaurantOrders(
  prisma: PrismaClient,
  scope: TenantScope,
  branchId: string,
): Promise<readonly RestaurantOrderSummary[]> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const rows = (await tx.restaurantOrder.findMany({
      where: { tenantId: tenant, branchId, status: 'open' },
      include: {
        table: { select: { code: true, nameAr: true } },
        lines: { orderBy: { lineNumber: 'asc' } },
      },
      orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    })) as OrderRow[];
    return rows.map((row) => summaryOf(asOrder(row)));
  });
}

export async function readRestaurantOrder(
  prisma: PrismaClient,
  scope: TenantScope,
  branchId: string,
  orderId: string,
): Promise<RestaurantOrderDetail | null> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, (tx) => readOrderWithin(tx, tenant, branchId, orderId));
}

export async function createRestaurantOrder(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantOrderActor,
  request: RestaurantOrderCreateRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<RestaurantOrderMutationResult> {
  const tenant = tenantParam(scope);
  const normalizedLines = request.lines.map((line) => ({
    productId: line.productId,
    quantityScaled: line.quantityScaled,
    preparationNote: normalizeOptionalText(line.preparationNote),
    preparationOptions: normalizeOptionalText(line.preparationOptions),
  }));
  const requestHash = fingerprint({
    terminalId: request.terminalId,
    orderType: request.orderType,
    tableId: request.tableId,
    lines: normalizedLines,
  });

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const replay = await reserveOperation(
      tx,
      tenant,
      CREATE_SCOPE,
      request.operationId,
      requestHash,
      nextId,
    );
    if (replay !== null) return { order: replay, replayed: true };

    const settings = await requireRestaurantSettings(tx, tenant);
    await requireTerminal(tx, tenant, actor, request.terminalId);
    await requireTable(tx, tenant, actor.branchId, request.orderType, request.tableId);

    const snapshots = [];
    for (const [index, line] of normalizedLines.entries()) {
      const product = await tx.product.findFirst({
        where: { tenantId: tenant, id: line.productId },
        select: {
          id: true,
          sku: true,
          nameAr: true,
          nameEn: true,
          productType: true,
          priceMinor: true,
          vatBasisPoints: true,
          trackInventory: true,
          isActive: true,
        },
      });
      if (product === null) throw new RestaurantOrderRefusedError('unknown-product');
      if (!product.isActive) throw new RestaurantOrderRefusedError('product-unavailable');
      const scaled = quantity(line.quantityScaled, product.productType);
      snapshots.push({
        id: nextId(),
        tenantId: tenant,
        lineNumber: index + 1,
        productId: product.id,
        sku: product.sku,
        nameAr: product.nameAr,
        nameEn: product.nameEn,
        productType: product.productType,
        unitPriceMinor: product.priceMinor,
        vatBasisPoints: product.vatBasisPoints,
        quantityScaled: scaled,
        preparationNote: line.preparationNote,
        preparationOptions: line.preparationOptions,
        trackInventory: product.trackInventory,
      });
    }

    const at = clock();
    const orderId = nextId();
    try {
      await tx.restaurantOrder.create({
        data: {
          id: orderId,
          tenantId: tenant,
          branchId: actor.branchId,
          terminalId: request.terminalId,
          userId: actor.userId,
          tableId: request.tableId,
          orderType: request.orderType,
          status: 'open',
          revision: 1n,
          priceMode: settings.priceMode,
          currency: settings.currency,
          openedAt: at,
          closedAt: null,
          closedReason: null,
          createdAt: at,
          updatedAt: at,
          lines: {
            create: snapshots.map((line) => ({
              id: line.id,
              tenantId: line.tenantId,
              lineNumber: line.lineNumber,
              productId: line.productId,
              sku: line.sku,
              nameAr: line.nameAr,
              nameEn: line.nameEn,
              productType: line.productType,
              unitPriceMinor: line.unitPriceMinor,
              vatBasisPoints: line.vatBasisPoints,
              quantityScaled: line.quantityScaled,
              preparationNote: line.preparationNote,
              preparationOptions: line.preparationOptions,
              trackInventory: line.trackInventory,
              createdAt: at,
            })),
          },
        },
      });
    } catch (error) {
      if (request.tableId !== null && isUniqueConstraint(error)) {
        const occupied = await tx.restaurantOrder.findFirst({
          where: { tenantId: tenant, tableId: request.tableId, status: 'open' },
          select: { id: true },
        });
        if (occupied !== null) throw new RestaurantOrderRefusedError('table-occupied');
      }
      throw error;
    }

    const order = await readOrderWithin(tx, tenant, actor.branchId, orderId);
    if (order === null) throw new DatabaseError('Restaurant order could not be read after create.');

    await appendAudit(
      tx,
      tenant,
      actor,
      request.terminalId,
      'restaurant.order.opened',
      orderId,
      {
        orderType: request.orderType,
        tableId: request.tableId,
        lineCount: snapshots.length,
        revision: 1,
      },
      at,
      nextId,
    );
    await completeOperation(tx, tenant, CREATE_SCOPE, request.operationId, order, at);
    return { order, replayed: false };
  });
}

export async function cancelRestaurantOrder(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantOrderActor,
  orderId: string,
  request: RestaurantOrderCancelRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<RestaurantOrderMutationResult> {
  const tenant = tenantParam(scope);
  const requestHash = fingerprint({
    orderId,
    expectedRevision: request.expectedRevision,
    reason: request.reason,
  });

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const replay = await reserveOperation(
      tx,
      tenant,
      CANCEL_SCOPE,
      request.operationId,
      requestHash,
      nextId,
    );
    if (replay !== null) return { order: replay, replayed: true };

    await requireRestaurantSettings(tx, tenant);
    const existing = await tx.restaurantOrder.findFirst({
      where: { tenantId: tenant, branchId: actor.branchId, id: orderId },
      select: { id: true, terminalId: true, status: true, revision: true },
    });
    if (existing === null) throw new RestaurantOrderRefusedError('unknown-order');
    if (existing.status !== 'open') throw new RestaurantOrderRefusedError('order-not-open');

    let expected: bigint;
    try {
      expected = BigInt(request.expectedRevision);
    } catch {
      throw new RestaurantOrderRefusedError('stale-revision');
    }
    if (expected !== existing.revision) {
      throw new RestaurantOrderRefusedError('stale-revision');
    }

    const at = clock();
    const changed = await tx.restaurantOrder.updateMany({
      where: {
        tenantId: tenant,
        id: orderId,
        branchId: actor.branchId,
        status: 'open',
        revision: existing.revision,
      },
      data: {
        status: 'cancelled',
        revision: { increment: 1n },
        closedAt: at,
        closedReason: request.reason,
        updatedAt: at,
      },
    });
    if (changed.count !== 1) throw new RestaurantOrderRefusedError('stale-revision');

    const order = await readOrderWithin(tx, tenant, actor.branchId, orderId);
    if (order === null) throw new DatabaseError('Restaurant order could not be read after cancel.');

    await appendAudit(
      tx,
      tenant,
      actor,
      existing.terminalId,
      'restaurant.order.cancelled',
      orderId,
      { reason: request.reason, revision: order.revision },
      at,
      nextId,
    );
    await completeOperation(tx, tenant, CANCEL_SCOPE, request.operationId, order, at);
    return { order, replayed: false };
  });
}

export async function transferRestaurantOrderTable(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantOrderActor,
  orderId: string,
  request: RestaurantOrderTransferTableRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<RestaurantOrderMutationResult> {
  const tenant = tenantParam(scope);
  const requestHash = fingerprint({
    orderId,
    expectedRevision: request.expectedRevision,
    tableId: request.tableId,
  });

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const replay = await reserveOperation(
      tx,
      tenant,
      TRANSFER_TABLE_SCOPE,
      request.operationId,
      requestHash,
      nextId,
    );
    if (replay !== null) return { order: replay, replayed: true };

    await requireRestaurantSettings(tx, tenant);
    const existing = await tx.restaurantOrder.findFirst({
      where: { tenantId: tenant, branchId: actor.branchId, id: orderId },
      select: {
        id: true,
        terminalId: true,
        tableId: true,
        orderType: true,
        status: true,
        revision: true,
      },
    });
    if (existing === null) throw new RestaurantOrderRefusedError('unknown-order');
    if (existing.status !== 'open') throw new RestaurantOrderRefusedError('order-not-open');
    if (existing.orderType !== 'dine-in') {
      throw new RestaurantOrderRefusedError('table-not-applicable');
    }

    let expected: bigint;
    try {
      expected = BigInt(request.expectedRevision);
    } catch {
      throw new RestaurantOrderRefusedError('stale-revision');
    }
    if (expected !== existing.revision) {
      throw new RestaurantOrderRefusedError('stale-revision');
    }

    const table = await tx.restaurantTable.findFirst({
      where: {
        tenantId: tenant,
        branchId: actor.branchId,
        id: request.tableId,
        isActive: true,
      },
      select: { id: true },
    });
    if (table === null) throw new RestaurantOrderRefusedError('unknown-table');

    const occupied = await tx.restaurantOrder.findFirst({
      where: {
        tenantId: tenant,
        tableId: request.tableId,
        status: 'open',
        id: { not: orderId },
      },
      select: { id: true },
    });
    if (occupied !== null) throw new RestaurantOrderRefusedError('table-occupied');

    const at = clock();
    if (existing.tableId !== request.tableId) {
      try {
        const changed = await tx.restaurantOrder.updateMany({
          where: {
            tenantId: tenant,
            id: orderId,
            branchId: actor.branchId,
            status: 'open',
            revision: existing.revision,
          },
          data: {
            tableId: request.tableId,
            revision: { increment: 1n },
            updatedAt: at,
          },
        });
        if (changed.count !== 1) throw new RestaurantOrderRefusedError('stale-revision');
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        throw new RestaurantOrderRefusedError('table-occupied');
      }
    }

    const order = await readOrderWithin(tx, tenant, actor.branchId, orderId);
    if (order === null) {
      throw new DatabaseError('Restaurant order could not be read after table transfer.');
    }

    if (existing.tableId !== request.tableId) {
      await appendAudit(
        tx,
        tenant,
        actor,
        existing.terminalId,
        'restaurant.order.table-transferred',
        orderId,
        {
          fromTableId: existing.tableId,
          toTableId: request.tableId,
          revision: order.revision,
        },
        at,
        nextId,
      );
    }

    await completeOperation(tx, tenant, TRANSFER_TABLE_SCOPE, request.operationId, order, at);
    return { order, replayed: false };
  });
}
