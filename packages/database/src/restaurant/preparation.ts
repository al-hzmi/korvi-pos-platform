import { createHash } from 'node:crypto';
import { newId } from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import {
  pendingPreparationLines,
  pendingUnroutedPreparationLines,
} from './preparation-policy.js';
import type { TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const CREATE_STATION_SCOPE = 'restaurant.preparation-station.create';
const SET_ROUTES_SCOPE = 'restaurant.preparation-route.set';
const FIRE_SCOPE = 'restaurant.preparation.fire';
const TASK_STATUS_SCOPE = 'restaurant.preparation-task.status';

export type RestaurantPreparationRefusal =
  | 'restaurant-mode-required'
  | 'unknown-branch'
  | 'unknown-station'
  | 'station-code-taken'
  | 'unknown-product'
  | 'invalid-input'
  | 'idempotency-conflict'
  | 'operation-in-progress'
  | 'unknown-order'
  | 'order-not-open'
  | 'stale-order'
  | 'unrouted-lines'
  | 'unknown-task'
  | 'stale-task'
  | 'invalid-transition';

export class RestaurantPreparationRefusedError extends DatabaseError {
  public override readonly name = 'RestaurantPreparationRefusedError';
  public constructor(public readonly detail: RestaurantPreparationRefusal) {
    super('Restaurant preparation operation refused: ' + detail);
  }
}

export interface RestaurantPreparationActor {
  readonly userId: string;
}

export interface PreparationStation {
  readonly id: string;
  readonly branchId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface PreparationRoute {
  readonly id: string;
  readonly branchId: string;
  readonly productId: string;
  readonly stationId: string;
}

export interface CreatePreparationStationRequest {
  readonly operationId: string;
  readonly branchId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly sortOrder: number;
}

export interface SetProductPreparationRoutesRequest {
  readonly operationId: string;
  readonly branchId: string;
  readonly productId: string;
  readonly stationIds: readonly string[];
}

export interface PreparationMutationResult<T> {
  readonly value: T;
  readonly replayed: boolean;
}

export interface PreparationRoutingLine {
  readonly lineId: string;
  readonly lineNumber: number;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly quantityScaled: string;
  readonly preparationNote: string | null;
  readonly preparationOptions: string | null;
}

export interface PreparationRoutingGroup {
  readonly station: PreparationStation;
  readonly lines: readonly PreparationRoutingLine[];
}

export interface PreparationRoutingPlan {
  readonly orderId: string;
  readonly revision: string;
  readonly orderType: 'dine-in' | 'takeaway' | 'delivery';
  readonly tableId: string | null;
  readonly groups: readonly PreparationRoutingGroup[];
  readonly unroutedLines: readonly PreparationRoutingLine[];
}

export type PreparationTaskStatus = 'queued' | 'preparing' | 'ready' | 'served';

export interface PreparationTask {
  readonly id: string;
  readonly branchId: string;
  readonly stationId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly productId: string;
  readonly orderRevision: string;
  readonly lineNumber: number;
  readonly sku: string;
  readonly nameAr: string;
  readonly quantityScaled: string;
  readonly preparationNote: string | null;
  readonly preparationOptions: string | null;
  readonly status: PreparationTaskStatus;
  readonly revision: string;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly servedAt: string | null;
}

export interface FirePreparationRequest {
  readonly operationId: string;
  readonly expectedOrderRevision: string;
}

export interface PreparationFireResult {
  readonly orderId: string;
  readonly orderRevision: string;
  readonly alreadyFired: boolean;
  readonly tasks: readonly PreparationTask[];
}

export interface UpdatePreparationTaskStatusRequest {
  readonly operationId: string;
  readonly expectedRevision: string;
  readonly status: Exclude<PreparationTaskStatus, 'queued'>;
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeCode(value: string): string {
  const normalized = value.normalize('NFKC').trim().toUpperCase();
  if (normalized === '' || normalized.length > 40 || /\s/u.test(normalized)) {
    throw new RestaurantPreparationRefusedError('invalid-input');
  }
  return normalized;
}

function normalizeName(value: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (normalized === '' || normalized.length > 80) {
    throw new RestaurantPreparationRefusedError('invalid-input');
  }
  return normalized;
}

async function requireRestaurantMode(tx: TransactionClient, tenant: string): Promise<void> {
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId: tenant },
    select: { vertical: true },
  });
  if (settings?.vertical !== 'restaurant') {
    throw new RestaurantPreparationRefusedError('restaurant-mode-required');
  }
}

async function requireBranch(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
): Promise<void> {
  const branch = await tx.branch.findFirst({
    where: { tenantId: tenant, id: branchId },
    select: { id: true },
  });
  if (branch === null) throw new RestaurantPreparationRefusedError('unknown-branch');
}

async function reserve<T>(
  tx: TransactionClient,
  tenant: string,
  scope: string,
  operationId: string,
  requestHash: string,
  resultType: string,
  nextId: () => string,
): Promise<T | null> {
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
    if (!uniqueViolation(error)) throw error;
  }
  const existing = await tx.idempotencyKey.findFirst({
    where: { tenantId: tenant, scope, operationId },
    select: { status: true, requestHash: true, resultType: true, resultSnapshot: true },
  });
  if (existing === null)
    throw new DatabaseError('Preparation idempotency collision is unreadable.');
  if (existing.requestHash !== requestHash) {
    throw new RestaurantPreparationRefusedError('idempotency-conflict');
  }
  if (existing.status !== 'completed') {
    throw new RestaurantPreparationRefusedError('operation-in-progress');
  }
  if (existing.resultType !== resultType || existing.resultSnapshot === null) {
    throw new DatabaseError('Completed preparation operation has no authoritative snapshot.');
  }
  return existing.resultSnapshot as unknown as T;
}

async function complete(
  tx: TransactionClient,
  tenant: string,
  scope: string,
  operationId: string,
  resultType: string,
  resultId: string | null,
  snapshot: unknown,
  at: Date,
): Promise<void> {
  const changed = await tx.idempotencyKey.updateMany({
    where: { tenantId: tenant, scope, operationId, status: 'reserved' },
    data: {
      status: 'completed',
      resultType,
      resultId,
      resultSnapshot: snapshot as object,
      completedAt: at,
    },
  });
  if (changed.count !== 1) throw new DatabaseError('Preparation idempotency completion failed.');
}

async function audit(
  tx: TransactionClient,
  tenant: string,
  actor: RestaurantPreparationActor,
  branchId: string,
  eventType: string,
  entityType: string,
  entityId: string | null,
  metadata: Readonly<Record<string, string | number | boolean | null>>,
  at: Date,
  nextId: () => string,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: nextId(),
      tenantId: tenant,
      actorUserId: actor.userId,
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

function asStation(row: {
  id: string;
  branchId: string;
  code: string;
  nameAr: string;
  sortOrder: number;
  isActive: boolean;
}): PreparationStation {
  return { ...row };
}

export async function listPreparationStations(
  prisma: PrismaClient,
  scope: TenantScope,
  branchId: string,
  activeOnly: boolean,
): Promise<readonly PreparationStation[]> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    await requireRestaurantMode(tx, tenant);
    await requireBranch(tx, tenant, branchId);
    const rows = await tx.restaurantPreparationStation.findMany({
      where: { tenantId: tenant, branchId, ...(activeOnly ? { isActive: true } : {}) },
      select: {
        id: true,
        branchId: true,
        code: true,
        nameAr: true,
        sortOrder: true,
        isActive: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }, { id: 'asc' }],
    });
    return rows.map(asStation);
  });
}

export async function createPreparationStation(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantPreparationActor,
  request: CreatePreparationStationRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<PreparationMutationResult<PreparationStation>> {
  if (!Number.isInteger(request.sortOrder) || request.sortOrder < 0) {
    throw new RestaurantPreparationRefusedError('invalid-input');
  }
  const code = normalizeCode(request.code);
  const nameAr = normalizeName(request.nameAr);
  const tenant = tenantParam(scope);
  const requestHash = fingerprint({
    branchId: request.branchId,
    code,
    nameAr,
    sortOrder: request.sortOrder,
  });

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const replay = await reserve<PreparationStation>(
      tx,
      tenant,
      CREATE_STATION_SCOPE,
      request.operationId,
      requestHash,
      'restaurant-preparation-station',
      nextId,
    );
    if (replay !== null) return { value: replay, replayed: true };
    await requireRestaurantMode(tx, tenant);
    await requireBranch(tx, tenant, request.branchId);
    const at = clock();
    const id = nextId();
    try {
      await tx.restaurantPreparationStation.create({
        data: {
          id,
          tenantId: tenant,
          branchId: request.branchId,
          code,
          nameAr,
          sortOrder: request.sortOrder,
          isActive: true,
          createdAt: at,
          updatedAt: at,
        },
      });
    } catch (error) {
      if (uniqueViolation(error)) throw new RestaurantPreparationRefusedError('station-code-taken');
      throw error;
    }
    const station: PreparationStation = {
      id,
      branchId: request.branchId,
      code,
      nameAr,
      sortOrder: request.sortOrder,
      isActive: true,
    };
    await audit(
      tx,
      tenant,
      actor,
      request.branchId,
      'restaurant.preparation-station.created',
      'restaurant-preparation-station',
      id,
      { code },
      at,
      nextId,
    );
    await complete(
      tx,
      tenant,
      CREATE_STATION_SCOPE,
      request.operationId,
      'restaurant-preparation-station',
      id,
      station,
      at,
    );
    return { value: station, replayed: false };
  });
}

export async function listPreparationRoutes(
  prisma: PrismaClient,
  scope: TenantScope,
  branchId: string,
): Promise<readonly PreparationRoute[]> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    await requireRestaurantMode(tx, tenant);
    await requireBranch(tx, tenant, branchId);
    return tx.restaurantPreparationRoute.findMany({
      where: { tenantId: tenant, branchId },
      select: { id: true, branchId: true, productId: true, stationId: true },
      orderBy: [{ productId: 'asc' }, { stationId: 'asc' }, { id: 'asc' }],
    });
  });
}

export async function setProductPreparationRoutes(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantPreparationActor,
  request: SetProductPreparationRoutesRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<PreparationMutationResult<readonly PreparationRoute[]>> {
  const stationIds = [...request.stationIds];
  if (new Set(stationIds).size !== stationIds.length || stationIds.length > 32) {
    throw new RestaurantPreparationRefusedError('invalid-input');
  }
  stationIds.sort();
  const tenant = tenantParam(scope);
  const requestHash = fingerprint({
    branchId: request.branchId,
    productId: request.productId,
    stationIds,
  });

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const replay = await reserve<readonly PreparationRoute[]>(
      tx,
      tenant,
      SET_ROUTES_SCOPE,
      request.operationId,
      requestHash,
      'restaurant-preparation-routes',
      nextId,
    );
    if (replay !== null) return { value: replay, replayed: true };

    await requireRestaurantMode(tx, tenant);
    await requireBranch(tx, tenant, request.branchId);
    const product = await tx.product.findFirst({
      where: { tenantId: tenant, id: request.productId },
      select: { id: true },
    });
    if (product === null) throw new RestaurantPreparationRefusedError('unknown-product');

    if (stationIds.length > 0) {
      const stations = await tx.restaurantPreparationStation.findMany({
        where: {
          tenantId: tenant,
          branchId: request.branchId,
          id: { in: stationIds },
          isActive: true,
        },
        select: { id: true },
      });
      if (stations.length !== stationIds.length) {
        throw new RestaurantPreparationRefusedError('unknown-station');
      }
    }

    await tx.restaurantPreparationRoute.deleteMany({
      where: { tenantId: tenant, branchId: request.branchId, productId: request.productId },
    });
    const at = clock();
    const routes: PreparationRoute[] = stationIds.map((stationId) => ({
      id: nextId(),
      branchId: request.branchId,
      productId: request.productId,
      stationId,
    }));
    if (routes.length > 0) {
      await tx.restaurantPreparationRoute.createMany({
        data: routes.map((route) => ({
          id: route.id,
          tenantId: tenant,
          branchId: route.branchId,
          productId: route.productId,
          stationId: route.stationId,
          createdAt: at,
        })),
      });
    }
    await audit(
      tx,
      tenant,
      actor,
      request.branchId,
      'restaurant.preparation-route.set',
      'product',
      request.productId,
      { stationCount: routes.length },
      at,
      nextId,
    );
    await complete(
      tx,
      tenant,
      SET_ROUTES_SCOPE,
      request.operationId,
      'restaurant-preparation-routes',
      request.productId,
      routes,
      at,
    );
    return { value: routes, replayed: false };
  });
}

async function routingWithin(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
  orderId: string,
): Promise<PreparationRoutingPlan | null> {
  await requireRestaurantMode(tx, tenant);
  const order = await tx.restaurantOrder.findFirst({
    where: { tenantId: tenant, branchId, id: orderId },
    select: {
      id: true,
      revision: true,
      orderType: true,
      tableId: true,
      status: true,
      lines: {
        select: {
          id: true,
          lineNumber: true,
          productId: true,
          sku: true,
          nameAr: true,
          quantityScaled: true,
          preparationNote: true,
          preparationOptions: true,
        },
        orderBy: { lineNumber: 'asc' },
      },
    },
  });
  if (order === null) return null;
  if (order.status !== 'open') throw new RestaurantPreparationRefusedError('order-not-open');
  if (
    order.orderType !== 'dine-in' &&
    order.orderType !== 'takeaway' &&
    order.orderType !== 'delivery'
  ) {
    throw new DatabaseError('Restaurant order has unknown order type.');
  }

  const productIds = [...new Set(order.lines.map((line) => line.productId))];
  const routes = await tx.restaurantPreparationRoute.findMany({
    where: {
      tenantId: tenant,
      branchId,
      productId: { in: productIds },
      station: { isActive: true },
    },
    select: {
      productId: true,
      station: {
        select: {
          id: true,
          branchId: true,
          code: true,
          nameAr: true,
          sortOrder: true,
          isActive: true,
        },
      },
    },
    orderBy: [{ station: { sortOrder: 'asc' } }, { stationId: 'asc' }],
  });

  const stationMap = new Map<string, PreparationRoutingGroup>();
  const routesByProduct = new Map<string, string[]>();
  for (const route of routes) {
    if (!stationMap.has(route.station.id)) {
      stationMap.set(route.station.id, { station: asStation(route.station), lines: [] });
    }
    const current = routesByProduct.get(route.productId) ?? [];
    current.push(route.station.id);
    routesByProduct.set(route.productId, current);
  }

  const unroutedLines: PreparationRoutingLine[] = [];
  for (const source of order.lines) {
    const line: PreparationRoutingLine = {
      lineId: source.id,
      lineNumber: source.lineNumber,
      productId: source.productId,
      sku: source.sku,
      nameAr: source.nameAr,
      quantityScaled: source.quantityScaled.toString(),
      preparationNote: source.preparationNote,
      preparationOptions: source.preparationOptions,
    };
    const stationIds = routesByProduct.get(source.productId) ?? [];
    if (stationIds.length === 0) {
      unroutedLines.push(line);
      continue;
    }
    for (const stationId of stationIds) {
      const group = stationMap.get(stationId);
      if (group !== undefined) {
        (group.lines as PreparationRoutingLine[]).push(line);
      }
    }
  }

  return {
    orderId: order.id,
    revision: order.revision.toString(),
    orderType: order.orderType,
    tableId: order.tableId,
    groups: [...stationMap.values()].filter((group) => group.lines.length > 0),
    unroutedLines,
  };
}

function asTask(row: {
  id: string;
  branchId: string;
  stationId: string;
  orderId: string;
  orderLineId: string;
  productId: string;
  orderRevision: bigint;
  lineNumber: number;
  sku: string;
  nameAr: string;
  quantityScaled: bigint;
  preparationNote: string | null;
  preparationOptions: string | null;
  status: string;
  revision: bigint;
  queuedAt: Date;
  startedAt: Date | null;
  readyAt: Date | null;
  servedAt: Date | null;
}): PreparationTask {
  if (
    row.status !== 'queued' &&
    row.status !== 'preparing' &&
    row.status !== 'ready' &&
    row.status !== 'served'
  ) {
    throw new DatabaseError('Preparation task has unknown status.');
  }
  return {
    id: row.id,
    branchId: row.branchId,
    stationId: row.stationId,
    orderId: row.orderId,
    orderLineId: row.orderLineId,
    productId: row.productId,
    orderRevision: row.orderRevision.toString(),
    lineNumber: row.lineNumber,
    sku: row.sku,
    nameAr: row.nameAr,
    quantityScaled: row.quantityScaled.toString(),
    preparationNote: row.preparationNote,
    preparationOptions: row.preparationOptions,
    status: row.status,
    revision: row.revision.toString(),
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    readyAt: row.readyAt?.toISOString() ?? null,
    servedAt: row.servedAt?.toISOString() ?? null,
  };
}

const TASK_SELECT = {
  id: true,
  branchId: true,
  stationId: true,
  orderId: true,
  orderLineId: true,
  productId: true,
  orderRevision: true,
  lineNumber: true,
  sku: true,
  nameAr: true,
  quantityScaled: true,
  preparationNote: true,
  preparationOptions: true,
  status: true,
  revision: true,
  queuedAt: true,
  startedAt: true,
  readyAt: true,
  servedAt: true,
} as const;

export async function routeRestaurantOrderForPreparation(
  prisma: PrismaClient,
  scope: TenantScope,
  branchId: string,
  orderId: string,
): Promise<PreparationRoutingPlan | null> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, (tx) => routingWithin(tx, tenant, branchId, orderId));
}

export async function fireRestaurantOrderForPreparation(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantPreparationActor,
  branchId: string,
  orderId: string,
  request: FirePreparationRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<PreparationMutationResult<PreparationFireResult>> {
  const tenant = tenantParam(scope);
  const requestHash = fingerprint({
    branchId,
    orderId,
    expectedOrderRevision: request.expectedOrderRevision,
  });

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const replay = await reserve<PreparationFireResult>(
      tx,
      tenant,
      FIRE_SCOPE,
      request.operationId,
      requestHash,
      'restaurant-preparation-fire',
      nextId,
    );
    if (replay !== null) return { value: replay, replayed: true };

    const plan = await routingWithin(tx, tenant, branchId, orderId);
    if (plan === null) throw new RestaurantPreparationRefusedError('unknown-order');
    if (plan.revision !== request.expectedOrderRevision) {
      throw new RestaurantPreparationRefusedError('stale-order');
    }
    const existing = await tx.restaurantPreparationTask.findMany({
      where: { tenantId: tenant, branchId, orderId },
      select: TASK_SELECT,
      orderBy: [
        { queuedAt: 'asc' },
        { orderRevision: 'asc' },
        { stationId: 'asc' },
        { lineNumber: 'asc' },
        { id: 'asc' },
      ],
    });
    const firedLineIds = new Set(existing.map((task) => task.orderLineId));
    const pendingUnrouted = pendingUnroutedPreparationLines(
      plan.unroutedLines,
      firedLineIds,
    );
    if (pendingUnrouted.length > 0) {
      throw new RestaurantPreparationRefusedError('unrouted-lines');
    }

    const revision = BigInt(plan.revision);
    const pendingLineIds = new Set(
      pendingPreparationLines(plan.groups, firedLineIds).map((line) => line.lineId),
    );
    const at = clock();
    const rows = plan.groups.flatMap((group) =>
      group.lines
        .filter((line) => pendingLineIds.has(line.lineId))
        .map((line) => ({
          id: nextId(),
          tenantId: tenant,
          branchId,
          stationId: group.station.id,
          orderId,
          orderLineId: line.lineId,
          productId: line.productId,
          orderRevision: revision,
          lineNumber: line.lineNumber,
          sku: line.sku,
          nameAr: line.nameAr,
          quantityScaled: BigInt(line.quantityScaled),
          preparationNote: line.preparationNote,
          preparationOptions: line.preparationOptions,
          status: 'queued',
          revision: 1n,
          queuedAt: at,
          startedAt: null,
          readyAt: null,
          servedAt: null,
          createdAt: at,
          updatedAt: at,
        })),
    );
    if (rows.length === 0) {
      const result: PreparationFireResult = {
        orderId,
        orderRevision: plan.revision,
        alreadyFired: true,
        tasks: existing.map(asTask),
      };
      await complete(
        tx,
        tenant,
        FIRE_SCOPE,
        request.operationId,
        'restaurant-preparation-fire',
        orderId,
        result,
        at,
      );
      return { value: result, replayed: false };
    }
    await tx.restaurantPreparationTask.createMany({ data: rows, skipDuplicates: true });

    const created = await tx.restaurantPreparationTask.findMany({
      where: { tenantId: tenant, branchId, orderId, orderRevision: revision },
      select: TASK_SELECT,
      orderBy: [{ stationId: 'asc' }, { lineNumber: 'asc' }, { id: 'asc' }],
    });
    const result: PreparationFireResult = {
      orderId,
      orderRevision: plan.revision,
      alreadyFired: false,
      tasks: created.map(asTask),
    };
    await audit(
      tx,
      tenant,
      actor,
      branchId,
      'restaurant.preparation.fired',
      'restaurant-order',
      orderId,
      {
        orderRevision: plan.revision,
        taskCount: created.length,
        stationCount: new Set(created.map((task) => task.stationId)).size,
        deltaLineCount: new Set(created.map((task) => task.orderLineId)).size,
        previouslyFiredLineCount: firedLineIds.size,
      },
      at,
      nextId,
    );
    await complete(
      tx,
      tenant,
      FIRE_SCOPE,
      request.operationId,
      'restaurant-preparation-fire',
      orderId,
      result,
      at,
    );
    return { value: result, replayed: false };
  });
}

export async function listPreparationTasks(
  prisma: PrismaClient,
  scope: TenantScope,
  branchId: string,
  stationId: string,
  includeServed: boolean,
): Promise<readonly PreparationTask[]> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    await requireRestaurantMode(tx, tenant);
    const station = await tx.restaurantPreparationStation.findFirst({
      where: { tenantId: tenant, branchId, id: stationId },
      select: { id: true },
    });
    if (station === null) throw new RestaurantPreparationRefusedError('unknown-station');
    const rows = await tx.restaurantPreparationTask.findMany({
      where: {
        tenantId: tenant,
        branchId,
        stationId,
        ...(includeServed ? {} : { status: { not: 'served' } }),
      },
      select: TASK_SELECT,
      orderBy: [{ queuedAt: 'asc' }, { lineNumber: 'asc' }, { id: 'asc' }],
    });
    return rows.map(asTask);
  });
}

export async function updatePreparationTaskStatus(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantPreparationActor,
  branchId: string,
  taskId: string,
  request: UpdatePreparationTaskStatusRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<PreparationMutationResult<PreparationTask>> {
  const tenant = tenantParam(scope);
  const requestHash = fingerprint({
    branchId,
    taskId,
    expectedRevision: request.expectedRevision,
    status: request.status,
  });

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const replay = await reserve<PreparationTask>(
      tx,
      tenant,
      TASK_STATUS_SCOPE,
      request.operationId,
      requestHash,
      'restaurant-preparation-task',
      nextId,
    );
    if (replay !== null) return { value: replay, replayed: true };

    await requireRestaurantMode(tx, tenant);
    const task = await tx.restaurantPreparationTask.findFirst({
      where: { tenantId: tenant, branchId, id: taskId },
      select: TASK_SELECT,
    });
    if (task === null) throw new RestaurantPreparationRefusedError('unknown-task');

    let expected: bigint;
    try {
      expected = BigInt(request.expectedRevision);
    } catch {
      throw new RestaurantPreparationRefusedError('stale-task');
    }
    if (task.revision !== expected) throw new RestaurantPreparationRefusedError('stale-task');

    const nextByStatus: Readonly<Record<PreparationTaskStatus, PreparationTaskStatus | null>> = {
      queued: 'preparing',
      preparing: 'ready',
      ready: 'served',
      served: null,
    };
    if (nextByStatus[asTask(task).status] !== request.status) {
      throw new RestaurantPreparationRefusedError('invalid-transition');
    }

    const at = clock();
    const changed = await tx.restaurantPreparationTask.updateMany({
      where: {
        tenantId: tenant,
        branchId,
        id: taskId,
        revision: expected,
        status: task.status,
      },
      data: {
        status: request.status,
        revision: { increment: 1n },
        updatedAt: at,
        ...(request.status === 'preparing' ? { startedAt: at } : {}),
        ...(request.status === 'ready' ? { readyAt: at } : {}),
        ...(request.status === 'served' ? { servedAt: at } : {}),
      },
    });
    if (changed.count !== 1) throw new RestaurantPreparationRefusedError('stale-task');

    const updated = await tx.restaurantPreparationTask.findFirst({
      where: { tenantId: tenant, branchId, id: taskId },
      select: TASK_SELECT,
    });
    if (updated === null) throw new DatabaseError('Preparation task disappeared after transition.');
    const value = asTask(updated);
    await audit(
      tx,
      tenant,
      actor,
      branchId,
      'restaurant.preparation-task.status-changed',
      'restaurant-preparation-task',
      taskId,
      {
        fromStatus: task.status,
        toStatus: request.status,
        revision: value.revision,
      },
      at,
      nextId,
    );
    await complete(
      tx,
      tenant,
      TASK_STATUS_SCOPE,
      request.operationId,
      'restaurant-preparation-task',
      taskId,
      value,
      at,
    );
    return { value, replayed: false };
  });
}
