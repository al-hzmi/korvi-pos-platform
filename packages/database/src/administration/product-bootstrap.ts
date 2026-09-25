import {
  ProductBootstrapError,
  basisPoints,
  basisPointsToColumn,
  codeReverse,
  newId,
  normalizeProductBootstrap,
} from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { DatabaseError } from '../errors.js';
import { tenantParam } from '../repositories/mapping.js';
import type {
  NormalizedProductBootstrap,
  ProductBootstrapDraft,
  ProductType,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

/**
 * Strike 4D-4: the smallest honest write that can satisfy onboarding's
 * `active-product` evidence.
 *
 * It creates catalogue truth only: Product + optional primary barcode + initial
 * ProductPrice history + audit, atomically. It does not create stock, fake a
 * receipt, mutate onboarding state, or bypass the later inventory/purchasing
 * authority.
 */

export type ProductBootstrapRefusal =
  | 'invalid-input'
  | 'settings-missing'
  | 'barcode-required'
  | 'weighted-disabled'
  | 'category-not-found'
  | 'category-inactive'
  | 'sku-taken'
  | 'barcode-taken';

export class ProductBootstrapRefusedError extends DatabaseError {
  public override readonly name = 'ProductBootstrapRefusedError';
  public readonly detail: ProductBootstrapRefusal;

  public constructor(detail: ProductBootstrapRefusal) {
    super(`Product bootstrap refused: ${detail}`);
    this.detail = detail;
  }
}

export interface ProductBootstrapActor {
  /** Authenticated merchant user. Never accepted from the request body. */
  readonly userId: string;
}

export interface AdminProductBootstrap {
  readonly id: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType;
  readonly unitLabel: string;
  readonly priceMinor: string;
  readonly vatBasisPoints: number;
  readonly primaryBarcode: string | null;
  readonly categoryId: string | null;
  readonly trackInventory: boolean;
  readonly isActive: true;
  readonly createdAt: string;
}

interface SettingsRow {
  defaultVatBasisPoints: number;
  requireBarcode: boolean;
  allowWeightedItems: boolean;
  trackInventory: boolean;
}

interface ProductReadRow {
  id: string;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  productType: string;
  unitLabel: string;
  priceMinor: bigint;
  vatBasisPoints: number;
  barcode: string | null;
  categoryId: string | null;
  trackInventory: boolean;
  isActive: boolean;
  createdAt: Date;
}

function asProduct(row: ProductReadRow): AdminProductBootstrap {
  if (row.productType !== 'unit' && row.productType !== 'weighted') {
    throw new DatabaseError('The product just created has an invalid product type.');
  }
  if (!row.isActive) {
    throw new DatabaseError('The product bootstrap transaction created an inactive product.');
  }
  return {
    id: row.id,
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    productType: row.productType,
    unitLabel: row.unitLabel,
    priceMinor: row.priceMinor.toString(),
    vatBasisPoints: row.vatBasisPoints,
    primaryBarcode: row.barcode,
    categoryId: row.categoryId,
    trackInventory: row.trackInventory,
    isActive: true,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Same catalogue authority as createBootstrapProduct, but inside an already
 * tenant-scoped transaction. Kept out of the package public index: this exists
 * so orchestration such as Migration Engine can atomically bind its own row
 * state to the exact same product writer rather than inventing a second INSERT.
 */
export async function createBootstrapProductWithin(
  tx: TransactionClient,
  tenant: string,
  actor: ProductBootstrapActor,
  draft: ProductBootstrapDraft,
  at: Date,
  nextId: () => string = newId,
): Promise<AdminProductBootstrap> {
  const settingsRows = await tx.$queryRaw<SettingsRow[]>`
    SELECT "defaultVatBasisPoints", "requireBarcode", "allowWeightedItems", "trackInventory"
      FROM "tenant_settings"
     WHERE "tenantId" = ${tenant}::uuid
     FOR SHARE`;
  const settings = settingsRows.at(0);
  if (settings === undefined) throw new ProductBootstrapRefusedError('settings-missing');

  let input: NormalizedProductBootstrap;
  try {
    input = normalizeProductBootstrap(draft, basisPoints(settings.defaultVatBasisPoints));
  } catch (error) {
    if (error instanceof ProductBootstrapError) {
      throw new ProductBootstrapRefusedError('invalid-input');
    }
    throw error;
  }

  if (input.categoryId !== null) {
    const categoryRows = await tx.$queryRaw<{ isActive: boolean }[]>`
      SELECT "isActive"
        FROM "categories"
       WHERE "tenantId" = ${tenant}::uuid
         AND "id" = ${input.categoryId}::uuid
       FOR SHARE`;
    const category = categoryRows.at(0);
    if (category === undefined) {
      throw new ProductBootstrapRefusedError('category-not-found');
    }
    if (!category.isActive) {
      throw new ProductBootstrapRefusedError('category-inactive');
    }
  }

  if (settings.requireBarcode && input.barcode === null) {
    throw new ProductBootstrapRefusedError('barcode-required');
  }
  if (input.productType === 'weighted' && !settings.allowWeightedItems) {
    throw new ProductBootstrapRefusedError('weighted-disabled');
  }

  const productId = nextId();
  const priceId = nextId();
  const barcodeId = input.barcode === null ? null : nextId();
  const auditId = nextId();
  const vatColumn = basisPointsToColumn(input.vatBasisPoints);
  const reversed = input.barcode === null ? null : codeReverse(input.barcode);

  // Race-safe SKU uniqueness. A preflight SELECT would let two requests both
  // observe an unused SKU; the unique index is the authority.
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "products"
      ("id","tenantId","categoryId","sku","nameAr","nameEn","productType","unitLabel",
       "priceMinor","vatBasisPoints","barcode","codeReverse","imageUrl","trackInventory",
       "isActive","createdAt","updatedAt")
    VALUES
      (${productId}::uuid, ${tenant}::uuid, ${input.categoryId}::uuid, ${input.sku}, ${input.nameAr}, ${input.nameEn},
       ${input.productType}, ${input.unitLabel}, ${input.priceMinor}::bigint, ${vatColumn},
       ${input.barcode}, ${reversed}, NULL, ${settings.trackInventory}, true, ${at}, ${at})
    ON CONFLICT ("tenantId","sku") DO NOTHING
    RETURNING "id"`;
  if (inserted.length !== 1) throw new ProductBootstrapRefusedError('sku-taken');

  if (input.barcode !== null && barcodeId !== null) {
    const barcodeInserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "product_barcodes"
        ("id","tenantId","productId","barcode","isPrimary","createdAt")
      VALUES
        (${barcodeId}::uuid, ${tenant}::uuid, ${productId}::uuid, ${input.barcode}, true, ${at})
      ON CONFLICT ("tenantId","barcode") DO NOTHING
      RETURNING "id"`;
    if (barcodeInserted.length !== 1) {
      throw new ProductBootstrapRefusedError('barcode-taken');
    }
  }

  await tx.productPrice.create({
    data: {
      id: priceId,
      tenantId: tenant,
      productId,
      priceMinor: BigInt(input.priceMinor),
      vatBasisPoints: vatColumn,
      effectiveFrom: at,
      effectiveTo: null,
    },
  });

  await tx.auditEvent.create({
    data: {
      id: auditId,
      tenantId: tenant,
      actorUserId: actor.userId,
      branchId: null,
      terminalId: null,
      eventType: 'product.created',
      entityType: 'product',
      entityId: productId,
      metadata: {
        sku: input.sku,
        productType: input.productType,
        priceMinor: input.priceMinor,
        vatBasisPoints: vatColumn,
        trackInventory: settings.trackInventory,
        hasBarcode: input.barcode !== null,
        hasCategory: input.categoryId !== null,
      },
      occurredAt: at,
    },
  });

  const rows = await tx.$queryRaw<ProductReadRow[]>`
    SELECT "id","sku","nameAr","nameEn","productType","unitLabel","priceMinor",
           "vatBasisPoints","barcode","categoryId","trackInventory","isActive","createdAt"
      FROM "products"
     WHERE "tenantId" = ${tenant}::uuid AND "id" = ${productId}::uuid`;
  const row = rows.at(0);
  if (row === undefined) {
    throw new DatabaseError('The product just created could not be read back.');
  }
  return asProduct(row);
}

export async function createBootstrapProduct(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: ProductBootstrapActor,
  draft: ProductBootstrapDraft,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<AdminProductBootstrap> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, (tx) =>
    createBootstrapProductWithin(tx, tenant, actor, draft, clock(), nextId),
  );
}
