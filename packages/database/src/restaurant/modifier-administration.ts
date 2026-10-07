import { newId } from '@korvi/domain';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

export type RestaurantModifierAdminRefusal =
  | 'restaurant-mode-required'
  | 'unknown-group'
  | 'unknown-option'
  | 'unknown-product'
  | 'stale-revision'
  | 'invalid-definition'
  | 'code-conflict'
  | 'stale-attachments';

export class RestaurantModifierAdminRefusedError extends Error {
  public override readonly name = 'RestaurantModifierAdminRefusedError';
  public constructor(public readonly detail: RestaurantModifierAdminRefusal) {
    super(detail);
  }
}

export interface RestaurantModifierAdminActor {
  readonly userId: string;
  readonly branchId: string | null;
}

export interface RestaurantModifierAdminOption {
  readonly id: string;
  readonly groupId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly priceDeltaMinor: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly revision: string;
}

export interface RestaurantModifierAdminGroup {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly revision: string;
  readonly options: readonly RestaurantModifierAdminOption[];
}

export interface CreateModifierGroupInput {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly sortOrder: number;
}

export interface UpdateModifierGroupInput {
  readonly expectedRevision: string;
  readonly nameAr?: string | undefined;
  readonly nameEn?: string | null | undefined;
  readonly minSelections?: number | undefined;
  readonly maxSelections?: number | undefined;
  readonly sortOrder?: number | undefined;
  readonly isActive?: boolean | undefined;
}

export interface CreateModifierOptionInput {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly priceDeltaMinor: string;
  readonly sortOrder: number;
}

export interface UpdateModifierOptionInput {
  readonly expectedRevision: string;
  readonly nameAr?: string | undefined;
  readonly nameEn?: string | null | undefined;
  readonly priceDeltaMinor?: string | undefined;
  readonly sortOrder?: number | undefined;
  readonly isActive?: boolean | undefined;
}

export interface SetProductModifierGroupsInput {
  readonly expectedGroupIds: readonly string[];
  readonly groupIds: readonly string[];
}

function normalizeCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (code.length < 1 || code.length > 40 || /\s/u.test(code)) {
    throw new RestaurantModifierAdminRefusedError('invalid-definition');
  }
  return code;
}

function cleanName(value: string): string {
  const result = value.trim();
  if (result.length < 1 || result.length > 120) {
    throw new RestaurantModifierAdminRefusedError('invalid-definition');
  }
  return result;
}

function optionalName(value: string | null): string | null {
  return value === null ? null : cleanName(value);
}

function safeOrder(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RestaurantModifierAdminRefusedError('invalid-definition');
  }
  return value;
}

function assertBounds(minSelections: number, maxSelections: number): void {
  if (
    !Number.isSafeInteger(minSelections) ||
    !Number.isSafeInteger(maxSelections) ||
    minSelections < 0 ||
    maxSelections < 1 ||
    maxSelections > 32 ||
    minSelections > maxSelections
  ) {
    throw new RestaurantModifierAdminRefusedError('invalid-definition');
  }
}

function minor(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/u.test(value)) {
    throw new RestaurantModifierAdminRefusedError('invalid-definition');
  }
  const amount = BigInt(value);
  if (amount > 9_223_372_036_854_775_807n) {
    throw new RestaurantModifierAdminRefusedError('invalid-definition');
  }
  return amount;
}

function expectedRevision(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) {
    throw new RestaurantModifierAdminRefusedError('stale-revision');
  }
  return BigInt(value);
}

function canonicalIds(values: readonly string[]): string[] {
  if (new Set(values).size !== values.length) {
    throw new RestaurantModifierAdminRefusedError('invalid-definition');
  }
  return [...values].sort();
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

async function requireRestaurantMode(tx: TransactionClient, tenant: string): Promise<void> {
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId: tenant },
    select: { vertical: true },
  });
  if (settings?.vertical !== 'restaurant') {
    throw new RestaurantModifierAdminRefusedError('restaurant-mode-required');
  }
}

async function lockExclusive(tx: TransactionClient, tenant: string): Promise<void> {
  await tx.$queryRawUnsafe<{ locked: number }[]>(
    "SELECT 1::int4 AS \"locked\" FROM (SELECT pg_advisory_xact_lock(hashtextextended('korvi:restaurant-menu-policy:' || $1, 0))) AS menu_lock",
    tenant,
  );
}

async function writeAudit(
  tx: TransactionClient,
  tenant: string,
  actor: RestaurantModifierAdminActor,
  eventType: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, string | number | boolean | null>,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      actorUserId: actor.userId,
      branchId: actor.branchId,
      terminalId: null,
      eventType,
      entityType,
      entityId,
      metadata,
      occurredAt: new Date(),
    },
  });
}

function option(row: {
  id: string;
  groupId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  priceDeltaMinor: bigint;
  sortOrder: number;
  isActive: boolean;
  revision: bigint;
}): RestaurantModifierAdminOption {
  return {
    id: row.id,
    groupId: row.groupId,
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    priceDeltaMinor: row.priceDeltaMinor.toString(),
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    revision: row.revision.toString(),
  };
}

function group(row: {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  minSelections: number;
  maxSelections: number;
  sortOrder: number;
  isActive: boolean;
  revision: bigint;
  options: readonly {
    id: string;
    groupId: string;
    code: string;
    nameAr: string;
    nameEn: string | null;
    priceDeltaMinor: bigint;
    sortOrder: number;
    isActive: boolean;
    revision: bigint;
  }[];
}): RestaurantModifierAdminGroup {
  return {
    id: row.id,
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    minSelections: row.minSelections,
    maxSelections: row.maxSelections,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    revision: row.revision.toString(),
    options: row.options.map(option),
  };
}

const GROUP_INCLUDE = {
  options: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
};

async function readGroup(
  tx: TransactionClient,
  tenant: string,
  groupId: string,
): Promise<RestaurantModifierAdminGroup | null> {
  const row = await tx.restaurantModifierGroup.findFirst({
    where: { tenantId: tenant, id: groupId },
    include: GROUP_INCLUDE,
  });
  return row === null ? null : group(row);
}

export async function listRestaurantModifierGroups(
  prisma: PrismaClient,
  scope: TenantScope,
): Promise<readonly RestaurantModifierAdminGroup[]> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    await requireRestaurantMode(tx, tenant);
    const rows = await tx.restaurantModifierGroup.findMany({
      where: { tenantId: tenant },
      include: GROUP_INCLUDE,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map(group);
  });
}

export async function createRestaurantModifierGroup(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantModifierAdminActor,
  input: CreateModifierGroupInput,
): Promise<RestaurantModifierAdminGroup> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    await requireRestaurantMode(tx, tenant);
    await lockExclusive(tx, tenant);
    assertBounds(input.minSelections, input.maxSelections);
    try {
      const created = await tx.restaurantModifierGroup.create({
        data: {
          id: newId(),
          tenantId: tenant,
          code: normalizeCode(input.code),
          nameAr: cleanName(input.nameAr),
          nameEn: optionalName(input.nameEn),
          minSelections: input.minSelections,
          maxSelections: input.maxSelections,
          sortOrder: safeOrder(input.sortOrder),
          isActive: true,
          revision: 1n,
        },
      });
      await writeAudit(
        tx,
        tenant,
        actor,
        'restaurant.modifier-group.created',
        'modifier-group',
        created.id,
        { code: created.code },
      );
      const result = await readGroup(tx, tenant, created.id);
      if (result === null) throw new Error('created modifier group disappeared');
      return result;
    } catch (error) {
      if (uniqueViolation(error)) throw new RestaurantModifierAdminRefusedError('code-conflict');
      throw error;
    }
  });
}

export async function updateRestaurantModifierGroup(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantModifierAdminActor,
  groupId: string,
  input: UpdateModifierGroupInput,
): Promise<RestaurantModifierAdminGroup> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    await requireRestaurantMode(tx, tenant);
    await lockExclusive(tx, tenant);
    const current = await tx.restaurantModifierGroup.findFirst({
      where: { tenantId: tenant, id: groupId },
    });
    if (current === null) throw new RestaurantModifierAdminRefusedError('unknown-group');

    const nextMin = input.minSelections ?? current.minSelections;
    const nextMax = input.maxSelections ?? current.maxSelections;
    assertBounds(nextMin, nextMax);

    const updated = await tx.restaurantModifierGroup.updateMany({
      where: { tenantId: tenant, id: groupId, revision: expectedRevision(input.expectedRevision) },
      data: {
        ...(input.nameAr === undefined ? {} : { nameAr: cleanName(input.nameAr) }),
        ...(input.nameEn === undefined ? {} : { nameEn: optionalName(input.nameEn) }),
        minSelections: nextMin,
        maxSelections: nextMax,
        ...(input.sortOrder === undefined ? {} : { sortOrder: safeOrder(input.sortOrder) }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        revision: { increment: 1n },
      },
    });
    if (updated.count !== 1) throw new RestaurantModifierAdminRefusedError('stale-revision');
    await writeAudit(
      tx,
      tenant,
      actor,
      'restaurant.modifier-group.updated',
      'modifier-group',
      groupId,
      { expectedRevision: input.expectedRevision },
    );
    const result = await readGroup(tx, tenant, groupId);
    if (result === null) throw new RestaurantModifierAdminRefusedError('unknown-group');
    return result;
  });
}

export async function createRestaurantModifierOption(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantModifierAdminActor,
  groupId: string,
  input: CreateModifierOptionInput,
): Promise<RestaurantModifierAdminGroup> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    await requireRestaurantMode(tx, tenant);
    await lockExclusive(tx, tenant);
    const exists = await tx.restaurantModifierGroup.findFirst({
      where: { tenantId: tenant, id: groupId },
      select: { id: true },
    });
    if (exists === null) throw new RestaurantModifierAdminRefusedError('unknown-group');
    try {
      const created = await tx.restaurantModifierOption.create({
        data: {
          id: newId(),
          tenantId: tenant,
          groupId,
          code: normalizeCode(input.code),
          nameAr: cleanName(input.nameAr),
          nameEn: optionalName(input.nameEn),
          priceDeltaMinor: minor(input.priceDeltaMinor),
          sortOrder: safeOrder(input.sortOrder),
          isActive: true,
          revision: 1n,
        },
      });
      await writeAudit(
        tx,
        tenant,
        actor,
        'restaurant.modifier-option.created',
        'modifier-option',
        created.id,
        { groupId, priceDeltaMinor: created.priceDeltaMinor.toString() },
      );
    } catch (error) {
      if (uniqueViolation(error)) throw new RestaurantModifierAdminRefusedError('code-conflict');
      throw error;
    }
    const result = await readGroup(tx, tenant, groupId);
    if (result === null) throw new RestaurantModifierAdminRefusedError('unknown-group');
    return result;
  });
}

export async function updateRestaurantModifierOption(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantModifierAdminActor,
  optionId: string,
  input: UpdateModifierOptionInput,
): Promise<RestaurantModifierAdminGroup> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    await requireRestaurantMode(tx, tenant);
    await lockExclusive(tx, tenant);
    const current = await tx.restaurantModifierOption.findFirst({
      where: { tenantId: tenant, id: optionId },
      select: { groupId: true },
    });
    if (current === null) throw new RestaurantModifierAdminRefusedError('unknown-option');
    const updated = await tx.restaurantModifierOption.updateMany({
      where: { tenantId: tenant, id: optionId, revision: expectedRevision(input.expectedRevision) },
      data: {
        ...(input.nameAr === undefined ? {} : { nameAr: cleanName(input.nameAr) }),
        ...(input.nameEn === undefined ? {} : { nameEn: optionalName(input.nameEn) }),
        ...(input.priceDeltaMinor === undefined
          ? {}
          : { priceDeltaMinor: minor(input.priceDeltaMinor) }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: safeOrder(input.sortOrder) }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        revision: { increment: 1n },
      },
    });
    if (updated.count !== 1) throw new RestaurantModifierAdminRefusedError('stale-revision');
    await writeAudit(
      tx,
      tenant,
      actor,
      'restaurant.modifier-option.updated',
      'modifier-option',
      optionId,
      { expectedRevision: input.expectedRevision },
    );
    const result = await readGroup(tx, tenant, current.groupId);
    if (result === null) throw new RestaurantModifierAdminRefusedError('unknown-group');
    return result;
  });
}

export async function setRestaurantProductModifierGroups(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantModifierAdminActor,
  productId: string,
  input: SetProductModifierGroupsInput,
): Promise<readonly string[]> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    await requireRestaurantMode(tx, tenant);
    await lockExclusive(tx, tenant);

    const product = await tx.product.findFirst({
      where: { tenantId: tenant, id: productId },
      select: { id: true },
    });
    if (product === null) throw new RestaurantModifierAdminRefusedError('unknown-product');

    const expected = canonicalIds(input.expectedGroupIds);
    const desired = canonicalIds(input.groupIds);
    const current = await tx.restaurantProductModifierGroup.findMany({
      where: { tenantId: tenant, productId },
      select: { groupId: true },
      orderBy: [{ sortOrder: 'asc' }, { groupId: 'asc' }],
    });
    if (!sameIds(current.map((row) => row.groupId), expected)) {
      throw new RestaurantModifierAdminRefusedError('stale-attachments');
    }

    if (desired.length > 0) {
      const count = await tx.restaurantModifierGroup.count({
        where: { tenantId: tenant, id: { in: desired } },
      });
      if (count !== desired.length) throw new RestaurantModifierAdminRefusedError('unknown-group');
    }

    await tx.restaurantProductModifierGroup.deleteMany({ where: { tenantId: tenant, productId } });
    for (let index = 0; index < desired.length; index += 1) {
      const groupId = desired[index];
      if (groupId === undefined) continue;
      await tx.restaurantProductModifierGroup.create({
        data: {
          id: newId(),
          tenantId: tenant,
          productId,
          groupId,
          sortOrder: index,
        },
      });
    }

    await writeAudit(
      tx,
      tenant,
      actor,
      'restaurant.product-modifiers.updated',
      'product',
      productId,
      { previousCount: current.length, nextCount: desired.length },
    );
    return desired;
  });
}
