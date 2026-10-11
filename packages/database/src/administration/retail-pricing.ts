import { newId } from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import { withTenant } from '../tenant-context.js';
import { tenantParam } from '../repositories/mapping.js';
import { lockRetailPricingPolicyExclusiveWithin } from '../repositories/retail-pricing-settlement.js';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';

export type RetailAdminRefusal =
  | 'product-not-found'
  | 'unit-product-required'
  | 'package-not-found'
  | 'package-code-taken'
  | 'barcode-taken'
  | 'price-list-not-found'
  | 'price-list-code-taken'
  | 'price-list-entry-not-found'
  | 'price-list-entry-taken'
  | 'active-context-taken'
  | 'stale-revision'
  | 'invalid-state'
  | 'invalid-input';

export class RetailAdminRefusedError extends DatabaseError {
  public override readonly name = 'RetailAdminRefusedError';
  public readonly detail: RetailAdminRefusal;

  public constructor(detail: RetailAdminRefusal) {
    super('Retail administration refused: ' + detail);
    this.detail = detail;
  }
}

export interface RetailAdminActor {
  readonly userId: string;
}

export interface RetailAdminBarcode {
  readonly id: string;
  readonly barcode: string;
  readonly packageId: string | null;
  readonly isPrimary: boolean;
}

export interface RetailAdminPackage {
  readonly id: string;
  readonly productId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly unitLabel: string;
  readonly baseQuantityScaled: string;
  readonly isActive: boolean;
  readonly revision: string;
  readonly barcodes: readonly RetailAdminBarcode[];
}

export interface RetailProductCommercialConfig {
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly productType: 'unit' | 'weighted';
  readonly unitLabel: string;
  readonly priceMinor: string;
  readonly baseBarcodes: readonly RetailAdminBarcode[];
  readonly packages: readonly RetailAdminPackage[];
}

export interface RetailPriceListEntry {
  readonly id: string;
  readonly productId: string;
  readonly packageId: string | null;
  readonly priceMinor: string;
  readonly revision: string;
}

export interface RetailPriceList {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly context: 'retail' | 'wholesale';
  readonly status: 'draft' | 'active' | 'paused' | 'archived';
  readonly revision: string;
  readonly entries: readonly RetailPriceListEntry[];
}

export interface CreatePackageRequest {
  readonly productId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly unitLabel: string;
  readonly baseQuantityScaled: string;
  readonly barcode: string | null;
  readonly occurredAt: string;
}

export interface UpdatePackageRequest {
  readonly expectedRevision: string;
  readonly code?: string | undefined;
  readonly nameAr?: string | undefined;
  readonly nameEn?: string | null | undefined;
  readonly unitLabel?: string | undefined;
  readonly isActive?: boolean | undefined;
  readonly occurredAt: string;
}

export interface AddBarcodeRequest {
  readonly productId: string;
  readonly packageId: string | null;
  readonly barcode: string;
  readonly occurredAt: string;
}

export interface UpdateBasePriceRequest {
  readonly expectedPriceMinor: string;
  readonly priceMinor: string;
  readonly occurredAt: string;
}

export interface CreatePriceListRequest {
  readonly code: string;
  readonly name: string;
  readonly context: 'retail' | 'wholesale';
  readonly occurredAt: string;
}

export interface UpdatePriceListRequest {
  readonly expectedRevision: string;
  readonly name?: string | undefined;
  readonly status?: 'draft' | 'active' | 'paused' | 'archived' | undefined;
  readonly occurredAt: string;
}

export interface CreatePriceListEntryRequest {
  readonly productId: string;
  readonly packageId: string | null;
  readonly priceMinor: string;
  readonly occurredAt: string;
}

export interface UpdatePriceListEntryRequest {
  readonly expectedRevision: string;
  readonly priceMinor: string;
  readonly occurredAt: string;
}

function clean(value: string, max: number): string {
  const result = value.trim();
  if (result.length === 0 || result.length > max) {
    throw new RetailAdminRefusedError('invalid-input');
  }
  return result;
}

function optionalClean(value: string | null, max: number): string | null {
  return value === null ? null : clean(value, max);
}

function parseRevision(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new RetailAdminRefusedError('invalid-input');
  return BigInt(value);
}

function parseMinor(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new RetailAdminRefusedError('invalid-input');
  }
  return BigInt(value);
}

function parseFactor(value: string): bigint {
  const parsed = parseRevision(value);
  if (parsed <= 1_000n || parsed % 1_000n !== 0n) {
    throw new RetailAdminRefusedError('invalid-input');
  }
  return parsed;
}

function instant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new RetailAdminRefusedError('invalid-input');
  return parsed;
}

async function audit(
  tx: TransactionClient,
  tenant: string,
  actor: RetailAdminActor,
  input: {
    readonly eventType: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly metadata: Readonly<Record<string, string | boolean | null>>;
    readonly occurredAt: string;
  },
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      actorUserId: actor.userId,
      branchId: null,
      terminalId: null,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: { ...input.metadata },
      occurredAt: instant(input.occurredAt),
    },
  });
}

function toPackage(row: {
  id: string;
  productId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  unitLabel: string;
  baseQuantityScaled: bigint;
  isActive: boolean;
  revision: bigint;
  barcodes: { id: string; barcode: string; packageId: string | null; isPrimary: boolean }[];
}): RetailAdminPackage {
  return {
    id: row.id,
    productId: row.productId,
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    unitLabel: row.unitLabel,
    baseQuantityScaled: row.baseQuantityScaled.toString(),
    isActive: row.isActive,
    revision: row.revision.toString(),
    barcodes: row.barcodes.map((barcode) => ({ ...barcode })),
  };
}

async function loadCommercialConfig(
  tx: TransactionClient,
  tenant: string,
  productId: string,
): Promise<RetailProductCommercialConfig | null> {
  const product = await tx.product.findFirst({
    where: { tenantId: tenant, id: productId },
    include: {
      barcodes: {
        select: { id: true, barcode: true, packageId: true, isPrimary: true },
        orderBy: [{ packageId: 'asc' }, { barcode: 'asc' }],
      },
      packages: {
        include: {
          barcodes: {
            select: { id: true, barcode: true, packageId: true, isPrimary: true },
            orderBy: { barcode: 'asc' },
          },
        },
        orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
      },
    },
  });
  if (product === null) return null;
  if (product.productType !== 'unit' && product.productType !== 'weighted') {
    throw new DatabaseError('Product type is outside the retail administration contract.');
  }
  return {
    productId: product.id,
    sku: product.sku,
    nameAr: product.nameAr,
    productType: product.productType,
    unitLabel: product.unitLabel,
    priceMinor: product.priceMinor.toString(),
    baseBarcodes: product.barcodes
      .filter((barcode) => barcode.packageId === null)
      .map((barcode) => ({ ...barcode })),
    packages: product.packages.map(toPackage),
  };
}

function toPriceList(row: {
  id: string;
  code: string;
  name: string;
  context: string;
  status: string;
  revision: bigint;
  entries: {
    id: string;
    productId: string;
    packageId: string | null;
    priceMinor: bigint;
    revision: bigint;
  }[];
}): RetailPriceList {
  if (row.context !== 'retail' && row.context !== 'wholesale') {
    throw new DatabaseError('Price-list context is outside the retail administration contract.');
  }
  if (!['draft', 'active', 'paused', 'archived'].includes(row.status)) {
    throw new DatabaseError('Price-list status is outside the retail administration contract.');
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    context: row.context,
    status: row.status as RetailPriceList['status'],
    revision: row.revision.toString(),
    entries: row.entries.map((entry) => ({
      id: entry.id,
      productId: entry.productId,
      packageId: entry.packageId,
      priceMinor: entry.priceMinor.toString(),
      revision: entry.revision.toString(),
    })),
  };
}

async function loadPriceList(
  tx: TransactionClient,
  tenant: string,
  priceListId: string,
): Promise<RetailPriceList | null> {
  const row = await tx.priceList.findFirst({
    where: { tenantId: tenant, id: priceListId },
    include: {
      entries: {
        select: {
          id: true,
          productId: true,
          packageId: true,
          priceMinor: true,
          revision: true,
        },
        orderBy: [{ productId: 'asc' }, { packageId: 'asc' }],
      },
    },
  });
  return row === null ? null : toPriceList(row);
}

async function proveUnitProduct(
  tx: TransactionClient,
  tenant: string,
  productId: string,
): Promise<void> {
  const product = await tx.product.findFirst({
    where: { tenantId: tenant, id: productId },
    select: { productType: true },
  });
  if (product === null) throw new RetailAdminRefusedError('product-not-found');
  if (product.productType !== 'unit') throw new RetailAdminRefusedError('unit-product-required');
}

async function proveTarget(
  tx: TransactionClient,
  tenant: string,
  productId: string,
  packageId: string | null,
): Promise<void> {
  const product = await tx.product.findFirst({
    where: { tenantId: tenant, id: productId },
    select: { id: true },
  });
  if (product === null) throw new RetailAdminRefusedError('product-not-found');
  if (packageId === null) return;
  const found = await tx.productPackage.findFirst({
    where: { tenantId: tenant, id: packageId, productId, isActive: true },
    select: { id: true },
  });
  if (found === null) throw new RetailAdminRefusedError('package-not-found');
}

export async function readRetailProductCommercialConfig(
  prisma: PrismaClient,
  scope: TenantScope,
  productId: string,
): Promise<RetailProductCommercialConfig | null> {
  return withTenant(prisma, scope.tenantId, (tx) =>
    loadCommercialConfig(tx, tenantParam(scope), productId),
  );
}

export async function createRetailProductPackage(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RetailAdminActor,
  input: CreatePackageRequest,
): Promise<RetailProductCommercialConfig> {
  const factor = parseFactor(input.baseQuantityScaled);
  const code = clean(input.code, 64);
  const nameAr = clean(input.nameAr, 200);
  const nameEn = optionalClean(input.nameEn, 200);
  const unitLabel = clean(input.unitLabel, 32);
  const barcode = input.barcode === null ? null : clean(input.barcode, 64);

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockRetailPricingPolicyExclusiveWithin(tx, tenant);
    await proveUnitProduct(tx, tenant, input.productId);
    if (
      (await tx.productPackage.count({
        where: { tenantId: tenant, productId: input.productId, code },
      })) !== 0
    ) {
      throw new RetailAdminRefusedError('package-code-taken');
    }
    if (
      barcode !== null &&
      (await tx.productBarcode.count({ where: { tenantId: tenant, barcode } })) !== 0
    ) {
      throw new RetailAdminRefusedError('barcode-taken');
    }

    const packageId = newId();
    await tx.productPackage.create({
      data: {
        id: packageId,
        tenantId: tenant,
        productId: input.productId,
        code,
        nameAr,
        nameEn,
        unitLabel,
        baseQuantityScaled: factor,
        isActive: true,
        revision: 1n,
        updatedAt: instant(input.occurredAt),
      },
    });
    if (barcode !== null) {
      await tx.productBarcode.create({
        data: {
          id: newId(),
          tenantId: tenant,
          productId: input.productId,
          packageId,
          barcode,
          isPrimary: false,
        },
      });
    }
    await audit(tx, tenant, actor, {
      eventType: 'product-package.created',
      entityType: 'product-package',
      entityId: packageId,
      metadata: {
        productId: input.productId,
        code,
        baseQuantityScaled: factor.toString(),
        barcode,
      },
      occurredAt: input.occurredAt,
    });
    const config = await loadCommercialConfig(tx, tenant, input.productId);
    if (config === null) throw new DatabaseError('Package product disappeared after creation.');
    return config;
  });
}

export async function updateRetailProductPackage(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RetailAdminActor,
  packageId: string,
  input: UpdatePackageRequest,
): Promise<RetailProductCommercialConfig> {
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockRetailPricingPolicyExclusiveWithin(tx, tenant);
    const current = await tx.productPackage.findFirst({
      where: { tenantId: tenant, id: packageId },
    });
    if (current === null) throw new RetailAdminRefusedError('package-not-found');
    const expected = parseRevision(input.expectedRevision);
    if (current.revision !== expected) throw new RetailAdminRefusedError('stale-revision');
    const nextCode = input.code === undefined ? current.code : clean(input.code, 64);
    if (
      nextCode !== current.code &&
      (await tx.productPackage.count({
        where: {
          tenantId: tenant,
          productId: current.productId,
          code: nextCode,
          NOT: { id: packageId },
        },
      })) !== 0
    ) {
      throw new RetailAdminRefusedError('package-code-taken');
    }
    const updated = await tx.productPackage.updateMany({
      where: { tenantId: tenant, id: packageId, revision: expected },
      data: {
        ...(input.code === undefined ? {} : { code: nextCode }),
        ...(input.nameAr === undefined ? {} : { nameAr: clean(input.nameAr, 200) }),
        ...(input.nameEn === undefined ? {} : { nameEn: optionalClean(input.nameEn, 200) }),
        ...(input.unitLabel === undefined ? {} : { unitLabel: clean(input.unitLabel, 32) }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        revision: { increment: 1n },
        updatedAt: instant(input.occurredAt),
      },
    });
    if (updated.count !== 1) throw new RetailAdminRefusedError('stale-revision');
    await audit(tx, tenant, actor, {
      eventType:
        input.isActive === undefined ? 'product-package.updated' : 'product-package.status-changed',
      entityType: 'product-package',
      entityId: packageId,
      metadata: {
        productId: current.productId,
        previousActive: current.isActive,
        currentActive: input.isActive ?? current.isActive,
      },
      occurredAt: input.occurredAt,
    });
    const config = await loadCommercialConfig(tx, tenant, current.productId);
    if (config === null) throw new DatabaseError('Package product disappeared after update.');
    return config;
  });
}

export async function addRetailProductBarcode(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RetailAdminActor,
  input: AddBarcodeRequest,
): Promise<RetailProductCommercialConfig> {
  const barcode = clean(input.barcode, 64);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockRetailPricingPolicyExclusiveWithin(tx, tenant);
    await proveTarget(tx, tenant, input.productId, input.packageId);
    if ((await tx.productBarcode.count({ where: { tenantId: tenant, barcode } })) !== 0) {
      throw new RetailAdminRefusedError('barcode-taken');
    }
    const id = newId();
    await tx.productBarcode.create({
      data: {
        id,
        tenantId: tenant,
        productId: input.productId,
        packageId: input.packageId,
        barcode,
        isPrimary: false,
      },
    });
    await audit(tx, tenant, actor, {
      eventType: 'product-barcode.created',
      entityType: 'product-barcode',
      entityId: id,
      metadata: { productId: input.productId, packageId: input.packageId, barcode },
      occurredAt: input.occurredAt,
    });
    const config = await loadCommercialConfig(tx, tenant, input.productId);
    if (config === null) throw new DatabaseError('Barcode product disappeared after creation.');
    return config;
  });
}

export async function updateRetailBasePrice(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RetailAdminActor,
  productId: string,
  input: UpdateBasePriceRequest,
): Promise<RetailProductCommercialConfig> {
  const expected = parseMinor(input.expectedPriceMinor);
  const next = parseMinor(input.priceMinor);
  if (next === expected) throw new RetailAdminRefusedError('invalid-input');

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockRetailPricingPolicyExclusiveWithin(tx, tenant);
    const product = await tx.product.findFirst({
      where: { tenantId: tenant, id: productId },
      select: { id: true, priceMinor: true, vatBasisPoints: true },
    });
    if (product === null) throw new RetailAdminRefusedError('product-not-found');
    if (product.priceMinor !== expected) throw new RetailAdminRefusedError('stale-revision');

    const currentRows = await tx.productPrice.findMany({
      where: { tenantId: tenant, productId, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (currentRows.length > 1) {
      throw new DatabaseError('More than one open base-price history row exists.');
    }
    const current = currentRows.at(0);
    if (current !== undefined && current.priceMinor !== expected) {
      throw new RetailAdminRefusedError('stale-revision');
    }
    const changedAt = instant(input.occurredAt);
    if (current !== undefined) {
      await tx.productPrice.update({
        where: { id: current.id },
        data: { effectiveTo: changedAt },
      });
    }
    await tx.productPrice.create({
      data: {
        id: newId(),
        tenantId: tenant,
        productId,
        priceMinor: next,
        vatBasisPoints: product.vatBasisPoints,
        effectiveFrom: changedAt,
        effectiveTo: null,
        provenance: 'recorded',
      },
    });
    await tx.product.update({
      where: { tenantId_id: { tenantId: tenant, id: productId } },
      data: { priceMinor: next, updatedAt: changedAt },
    });
    await audit(tx, tenant, actor, {
      eventType: 'product.base-price.updated',
      entityType: 'product',
      entityId: productId,
      metadata: {
        previousPriceMinor: expected.toString(),
        currentPriceMinor: next.toString(),
      },
      occurredAt: input.occurredAt,
    });
    const config = await loadCommercialConfig(tx, tenant, productId);
    if (config === null) throw new DatabaseError('Product disappeared after price update.');
    return config;
  });
}

export async function listRetailPriceLists(
  prisma: PrismaClient,
  scope: TenantScope,
): Promise<readonly RetailPriceList[]> {
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const rows = await tx.priceList.findMany({
      where: { tenantId: tenantParam(scope) },
      include: {
        entries: {
          select: {
            id: true,
            productId: true,
            packageId: true,
            priceMinor: true,
            revision: true,
          },
          orderBy: [{ productId: 'asc' }, { packageId: 'asc' }],
        },
      },
      orderBy: [{ context: 'asc' }, { status: 'asc' }, { code: 'asc' }],
    });
    return rows.map(toPriceList);
  });
}

export async function createRetailPriceList(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RetailAdminActor,
  input: CreatePriceListRequest,
): Promise<RetailPriceList> {
  const code = clean(input.code, 64);
  const name = clean(input.name, 160);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockRetailPricingPolicyExclusiveWithin(tx, tenant);
    if ((await tx.priceList.count({ where: { tenantId: tenant, code } })) !== 0) {
      throw new RetailAdminRefusedError('price-list-code-taken');
    }
    const id = newId();
    await tx.priceList.create({
      data: {
        id,
        tenantId: tenant,
        code,
        name,
        context: input.context,
        status: 'draft',
        revision: 1n,
        updatedAt: instant(input.occurredAt),
      },
    });
    await audit(tx, tenant, actor, {
      eventType: 'price-list.created',
      entityType: 'price-list',
      entityId: id,
      metadata: { code, context: input.context },
      occurredAt: input.occurredAt,
    });
    const result = await loadPriceList(tx, tenant, id);
    if (result === null) throw new DatabaseError('Price list disappeared after creation.');
    return result;
  });
}

export async function updateRetailPriceList(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RetailAdminActor,
  priceListId: string,
  input: UpdatePriceListRequest,
): Promise<RetailPriceList> {
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockRetailPricingPolicyExclusiveWithin(tx, tenant);
    const current = await tx.priceList.findFirst({
      where: { tenantId: tenant, id: priceListId },
    });
    if (current === null) throw new RetailAdminRefusedError('price-list-not-found');
    if (current.status === 'archived') throw new RetailAdminRefusedError('invalid-state');
    const expected = parseRevision(input.expectedRevision);
    if (current.revision !== expected) throw new RetailAdminRefusedError('stale-revision');
    const nextStatus = input.status ?? current.status;
    if (
      nextStatus === 'active' &&
      (await tx.priceList.count({
        where: {
          tenantId: tenant,
          context: current.context,
          status: 'active',
          NOT: { id: priceListId },
        },
      })) !== 0
    ) {
      throw new RetailAdminRefusedError('active-context-taken');
    }
    const updated = await tx.priceList.updateMany({
      where: { tenantId: tenant, id: priceListId, revision: expected },
      data: {
        ...(input.name === undefined ? {} : { name: clean(input.name, 160) }),
        ...(input.status === undefined ? {} : { status: input.status }),
        revision: { increment: 1n },
        updatedAt: instant(input.occurredAt),
      },
    });
    if (updated.count !== 1) throw new RetailAdminRefusedError('stale-revision');
    await audit(tx, tenant, actor, {
      eventType: input.status === undefined ? 'price-list.updated' : 'price-list.status-changed',
      entityType: 'price-list',
      entityId: priceListId,
      metadata: {
        context: current.context,
        previousStatus: current.status,
        currentStatus: nextStatus,
      },
      occurredAt: input.occurredAt,
    });
    const result = await loadPriceList(tx, tenant, priceListId);
    if (result === null) throw new DatabaseError('Price list disappeared after update.');
    return result;
  });
}

export async function createRetailPriceListEntry(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RetailAdminActor,
  priceListId: string,
  input: CreatePriceListEntryRequest,
): Promise<RetailPriceList> {
  const price = parseMinor(input.priceMinor);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockRetailPricingPolicyExclusiveWithin(tx, tenant);
    const list = await tx.priceList.findFirst({
      where: { tenantId: tenant, id: priceListId },
      select: { status: true },
    });
    if (list === null) throw new RetailAdminRefusedError('price-list-not-found');
    if (list.status === 'active' || list.status === 'archived') {
      throw new RetailAdminRefusedError('invalid-state');
    }
    await proveTarget(tx, tenant, input.productId, input.packageId);
    if (
      (await tx.priceListEntry.count({
        where: {
          tenantId: tenant,
          priceListId,
          productId: input.productId,
          packageId: input.packageId,
        },
      })) !== 0
    ) {
      throw new RetailAdminRefusedError('price-list-entry-taken');
    }
    const entryId = newId();
    await tx.priceListEntry.create({
      data: {
        id: entryId,
        tenantId: tenant,
        priceListId,
        productId: input.productId,
        packageId: input.packageId,
        priceMinor: price,
        revision: 1n,
        updatedAt: instant(input.occurredAt),
      },
    });
    await audit(tx, tenant, actor, {
      eventType: 'price-list-entry.created',
      entityType: 'price-list-entry',
      entityId: entryId,
      metadata: {
        priceListId,
        productId: input.productId,
        packageId: input.packageId,
        priceMinor: price.toString(),
      },
      occurredAt: input.occurredAt,
    });
    const result = await loadPriceList(tx, tenant, priceListId);
    if (result === null) throw new DatabaseError('Price list disappeared after entry creation.');
    return result;
  });
}

export async function updateRetailPriceListEntry(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RetailAdminActor,
  entryId: string,
  input: UpdatePriceListEntryRequest,
): Promise<RetailPriceList> {
  const price = parseMinor(input.priceMinor);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockRetailPricingPolicyExclusiveWithin(tx, tenant);
    const entry = await tx.priceListEntry.findFirst({
      where: { tenantId: tenant, id: entryId },
      include: { priceList: { select: { status: true } } },
    });
    if (entry === null) throw new RetailAdminRefusedError('price-list-entry-not-found');
    if (entry.priceList.status === 'active' || entry.priceList.status === 'archived') {
      throw new RetailAdminRefusedError('invalid-state');
    }
    const expected = parseRevision(input.expectedRevision);
    if (entry.revision !== expected) throw new RetailAdminRefusedError('stale-revision');
    const updated = await tx.priceListEntry.updateMany({
      where: { tenantId: tenant, id: entryId, revision: expected },
      data: {
        priceMinor: price,
        revision: { increment: 1n },
        updatedAt: instant(input.occurredAt),
      },
    });
    if (updated.count !== 1) throw new RetailAdminRefusedError('stale-revision');
    await audit(tx, tenant, actor, {
      eventType: 'price-list-entry.updated',
      entityType: 'price-list-entry',
      entityId: entryId,
      metadata: {
        priceListId: entry.priceListId,
        previousPriceMinor: entry.priceMinor.toString(),
        currentPriceMinor: price.toString(),
      },
      occurredAt: input.occurredAt,
    });
    const result = await loadPriceList(tx, tenant, entry.priceListId);
    if (result === null) throw new DatabaseError('Price list disappeared after entry update.');
    return result;
  });
}

export async function deleteRetailPriceListEntry(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RetailAdminActor,
  entryId: string,
  expectedRevision: string,
  occurredAt: string,
): Promise<RetailPriceList> {
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockRetailPricingPolicyExclusiveWithin(tx, tenant);
    const entry = await tx.priceListEntry.findFirst({
      where: { tenantId: tenant, id: entryId },
      include: { priceList: { select: { status: true } } },
    });
    if (entry === null) throw new RetailAdminRefusedError('price-list-entry-not-found');
    if (entry.priceList.status === 'active' || entry.priceList.status === 'archived') {
      throw new RetailAdminRefusedError('invalid-state');
    }
    if (entry.revision !== parseRevision(expectedRevision)) {
      throw new RetailAdminRefusedError('stale-revision');
    }
    await tx.priceListEntry.delete({ where: { id: entryId } });
    await audit(tx, tenant, actor, {
      eventType: 'price-list-entry.removed',
      entityType: 'price-list-entry',
      entityId: entryId,
      metadata: {
        priceListId: entry.priceListId,
        productId: entry.productId,
        packageId: entry.packageId,
      },
      occurredAt,
    });
    const result = await loadPriceList(tx, tenant, entry.priceListId);
    if (result === null) throw new DatabaseError('Price list disappeared after entry removal.');
    return result;
  });
}
