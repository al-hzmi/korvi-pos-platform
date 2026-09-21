import { createHash } from 'node:crypto';
import { newId } from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const SET_RECIPE_SCOPE = 'restaurant.recipe.set';
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_INGREDIENTS = 100;

export type RestaurantRecipeRefusal =
  | 'restaurant-mode-required'
  | 'unknown-product'
  | 'product-unavailable'
  | 'invalid-quantity'
  | 'duplicate-ingredient'
  | 'self-ingredient'
  | 'nested-recipe-unsupported'
  | 'recipe-product-used-as-ingredient'
  | 'stale-revision'
  | 'idempotency-conflict'
  | 'operation-in-progress';

export class RestaurantRecipeRefusedError extends DatabaseError {
  public override readonly name = 'RestaurantRecipeRefusedError';
  public constructor(public readonly detail: RestaurantRecipeRefusal) {
    super('Restaurant recipe operation refused: ' + detail);
  }
}

export interface RestaurantRecipeActor {
  readonly userId: string;
}

export interface RestaurantRecipeIngredientRecord {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly productType: 'unit' | 'weighted';
  readonly unitLabel: string;
  readonly quantityScaled: string;
}

export interface RestaurantRecipeRecord {
  readonly id: string;
  readonly productId: string;
  readonly productSku: string;
  readonly productNameAr: string;
  readonly productType: 'unit' | 'weighted';
  readonly yieldQuantityScaled: string;
  readonly revision: string;
  readonly ingredients: readonly RestaurantRecipeIngredientRecord[];
}

export interface SetRestaurantRecipeRequest {
  readonly operationId: string;
  readonly expectedRevision: string | null;
  readonly yieldQuantityScaled: string;
  readonly ingredients: readonly {
    readonly productId: string;
    readonly quantityScaled: string;
  }[];
}

export interface RestaurantRecipeMutationResult {
  readonly recipe: RestaurantRecipeRecord;
  readonly replayed: boolean;
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

function positiveQuantity(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) {
    throw new RestaurantRecipeRefusedError('invalid-quantity');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_INT64) throw new RestaurantRecipeRefusedError('invalid-quantity');
  return parsed;
}

function productType(value: string): 'unit' | 'weighted' {
  if (value === 'unit' || value === 'weighted') return value;
  throw new DatabaseError('Recipe product has unsupported product type.');
}

async function requireRestaurantMode(tx: TransactionClient, tenant: string): Promise<void> {
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId: tenant },
    select: { vertical: true },
  });
  if (settings?.vertical !== 'restaurant') {
    throw new RestaurantRecipeRefusedError('restaurant-mode-required');
  }
}

async function reserve<T>(
  tx: TransactionClient,
  tenant: string,
  operationId: string,
  requestHash: string,
  nextId: () => string,
): Promise<T | null> {
  try {
    await tx.idempotencyKey.create({
      data: {
        id: nextId(),
        tenantId: tenant,
        scope: SET_RECIPE_SCOPE,
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
    where: { tenantId: tenant, scope: SET_RECIPE_SCOPE, operationId },
    select: { status: true, requestHash: true, resultType: true, resultSnapshot: true },
  });
  if (existing === null) throw new DatabaseError('Recipe idempotency collision is unreadable.');
  if (existing.requestHash !== requestHash) {
    throw new RestaurantRecipeRefusedError('idempotency-conflict');
  }
  if (existing.status !== 'completed') {
    throw new RestaurantRecipeRefusedError('operation-in-progress');
  }
  if (existing.resultType !== 'restaurant-recipe' || existing.resultSnapshot === null) {
    throw new DatabaseError('Completed recipe operation has no authoritative snapshot.');
  }
  return existing.resultSnapshot as unknown as T;
}

async function complete(
  tx: TransactionClient,
  tenant: string,
  operationId: string,
  recipe: RestaurantRecipeRecord,
  at: Date,
): Promise<void> {
  const changed = await tx.idempotencyKey.updateMany({
    where: { tenantId: tenant, scope: SET_RECIPE_SCOPE, operationId, status: 'reserved' },
    data: {
      status: 'completed',
      resultType: 'restaurant-recipe',
      resultId: recipe.id,
      resultSnapshot: recipe as unknown as object,
      completedAt: at,
    },
  });
  if (changed.count !== 1) throw new DatabaseError('Recipe idempotency completion failed.');
}

async function readWithin(
  tx: TransactionClient,
  tenant: string,
  productId: string,
): Promise<RestaurantRecipeRecord | null> {
  const row = await tx.restaurantRecipe.findFirst({
    where: { tenantId: tenant, productId },
    select: {
      id: true,
      productId: true,
      yieldQuantityScaled: true,
      revision: true,
      product: { select: { sku: true, nameAr: true, productType: true } },
      ingredients: {
        select: {
          id: true,
          ingredientProductId: true,
          quantityScaled: true,
          ingredientProduct: {
            select: { sku: true, nameAr: true, productType: true, unitLabel: true },
          },
        },
        orderBy: [{ ingredientProduct: { sku: 'asc' } }, { id: 'asc' }],
      },
    },
  });
  if (row === null) return null;
  return {
    id: row.id,
    productId: row.productId,
    productSku: row.product.sku,
    productNameAr: row.product.nameAr,
    productType: productType(row.product.productType),
    yieldQuantityScaled: row.yieldQuantityScaled.toString(),
    revision: row.revision.toString(),
    ingredients: row.ingredients.map((ingredient) => ({
      id: ingredient.id,
      productId: ingredient.ingredientProductId,
      sku: ingredient.ingredientProduct.sku,
      nameAr: ingredient.ingredientProduct.nameAr,
      productType: productType(ingredient.ingredientProduct.productType),
      unitLabel: ingredient.ingredientProduct.unitLabel,
      quantityScaled: ingredient.quantityScaled.toString(),
    })),
  };
}

export async function readRestaurantRecipe(
  prisma: PrismaClient,
  scope: TenantScope,
  productId: string,
): Promise<RestaurantRecipeRecord | null> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    await requireRestaurantMode(tx, tenant);
    return readWithin(tx, tenant, productId);
  });
}

export async function setRestaurantRecipe(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantRecipeActor,
  productId: string,
  request: SetRestaurantRecipeRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<RestaurantRecipeMutationResult> {
  if (request.ingredients.length === 0 || request.ingredients.length > MAX_INGREDIENTS) {
    throw new RestaurantRecipeRefusedError('invalid-quantity');
  }
  const yieldQuantity = positiveQuantity(request.yieldQuantityScaled);
  const normalizedIngredients = request.ingredients.map((ingredient) => ({
    productId: ingredient.productId,
    quantityScaled: positiveQuantity(ingredient.quantityScaled),
  }));
  const ids = normalizedIngredients.map((ingredient) => ingredient.productId);
  if (new Set(ids).size !== ids.length) {
    throw new RestaurantRecipeRefusedError('duplicate-ingredient');
  }
  if (ids.includes(productId)) throw new RestaurantRecipeRefusedError('self-ingredient');

  const tenant = tenantParam(scope);
  const requestHash = fingerprint({
    productId,
    expectedRevision: request.expectedRevision,
    yieldQuantityScaled: yieldQuantity.toString(),
    ingredients: normalizedIngredients
      .map((ingredient) => ({
        productId: ingredient.productId,
        quantityScaled: ingredient.quantityScaled.toString(),
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId)),
  });

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const replay = await reserve<RestaurantRecipeRecord>(
      tx,
      tenant,
      request.operationId,
      requestHash,
      nextId,
    );
    if (replay !== null) return { recipe: replay, replayed: true };

    await requireRestaurantMode(tx, tenant);
    const products = await tx.product.findMany({
      where: { tenantId: tenant, id: { in: [productId, ...ids] } },
      select: { id: true, productType: true, isActive: true },
    });
    const byId = new Map(products.map((product) => [product.id, product]));
    const finished = byId.get(productId);
    if (finished === undefined) throw new RestaurantRecipeRefusedError('unknown-product');
    if (!finished.isActive) throw new RestaurantRecipeRefusedError('product-unavailable');
    for (const id of ids) {
      const ingredient = byId.get(id);
      if (ingredient === undefined) throw new RestaurantRecipeRefusedError('unknown-product');
      if (!ingredient.isActive) throw new RestaurantRecipeRefusedError('product-unavailable');
    }

    if (productType(finished.productType) === 'unit' && yieldQuantity % 1000n !== 0n) {
      throw new RestaurantRecipeRefusedError('invalid-quantity');
    }
    for (const ingredient of normalizedIngredients) {
      const product = byId.get(ingredient.productId);
      if (product === undefined) throw new RestaurantRecipeRefusedError('unknown-product');
      if (
        productType(product.productType) === 'unit' &&
        ingredient.quantityScaled % 1000n !== 0n
      ) {
        throw new RestaurantRecipeRefusedError('invalid-quantity');
      }
    }

    const existing = await tx.restaurantRecipe.findFirst({
      where: { tenantId: tenant, productId },
      select: { id: true, revision: true },
    });
    let expected: bigint | null = null;
    if (request.expectedRevision !== null) expected = positiveQuantity(request.expectedRevision);
    if (
      (existing === null && expected !== null) ||
      (existing !== null && (expected === null || existing.revision !== expected))
    ) {
      throw new RestaurantRecipeRefusedError('stale-revision');
    }

    const nestedIngredients = await tx.restaurantRecipe.findMany({
      where: { tenantId: tenant, productId: { in: ids } },
      select: { productId: true },
    });
    if (nestedIngredients.length > 0) {
      throw new RestaurantRecipeRefusedError('nested-recipe-unsupported');
    }

    const usedAsIngredient = await tx.restaurantRecipeIngredient.findFirst({
      where: {
        tenantId: tenant,
        ingredientProductId: productId,
        ...(existing === null ? {} : { recipeId: { not: existing.id } }),
      },
      select: { id: true },
    });
    if (usedAsIngredient !== null) {
      throw new RestaurantRecipeRefusedError('recipe-product-used-as-ingredient');
    }

    const at = clock();
    let recipeId: string;
    let nextRevision: bigint;
    if (existing === null) {
      recipeId = nextId();
      nextRevision = 1n;
      await tx.restaurantRecipe.create({
        data: {
          id: recipeId,
          tenantId: tenant,
          productId,
          yieldQuantityScaled: yieldQuantity,
          revision: nextRevision,
          createdAt: at,
          updatedAt: at,
        },
      });
    } else {
      recipeId = existing.id;
      nextRevision = existing.revision + 1n;
      const changed = await tx.restaurantRecipe.updateMany({
        where: { tenantId: tenant, id: existing.id, revision: existing.revision },
        data: {
          yieldQuantityScaled: yieldQuantity,
          revision: { increment: 1n },
          updatedAt: at,
        },
      });
      if (changed.count !== 1) throw new RestaurantRecipeRefusedError('stale-revision');
      await tx.restaurantRecipeIngredient.deleteMany({
        where: { tenantId: tenant, recipeId: existing.id },
      });
    }

    await tx.restaurantRecipeIngredient.createMany({
      data: normalizedIngredients.map((ingredient) => ({
        id: nextId(),
        tenantId: tenant,
        recipeId,
        ingredientProductId: ingredient.productId,
        quantityScaled: ingredient.quantityScaled,
        createdAt: at,
      })),
    });

    const recipe = await readWithin(tx, tenant, productId);
    if (recipe === null || recipe.revision !== nextRevision.toString()) {
      throw new DatabaseError('Recipe could not be read after mutation.');
    }

    await tx.auditEvent.create({
      data: {
        id: nextId(),
        tenantId: tenant,
        actorUserId: actor.userId,
        branchId: null,
        terminalId: null,
        eventType: existing === null ? 'restaurant.recipe.created' : 'restaurant.recipe.updated',
        entityType: 'restaurant-recipe',
        entityId: recipe.id,
        metadata: {
          productId,
          revision: recipe.revision,
          ingredientCount: recipe.ingredients.length,
        },
        occurredAt: at,
      },
    });
    await complete(tx, tenant, request.operationId, recipe, at);
    return { recipe, replayed: false };
  });
}
