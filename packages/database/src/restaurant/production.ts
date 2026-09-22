import { createHash } from 'node:crypto';
import {
  StockRequestError,
  addKnownCostValue,
  assertQuantityShape,
  newId,
} from '@korvi/domain';
import { InsufficientStockError, StockOperationRefusedError } from '../errors.js';
import {
  lockBalances,
  lockBranches,
  lockProducts,
  lockedOrThrow,
} from '../inventory/stock-ledger.js';
import { applyMovementWithin } from '../repositories/inventory-repository.js';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const PRODUCTION_SCOPE = 'restaurant.recipe.production';
const SOURCE_TYPE = 'restaurant-recipe-production';
const MAX_INT64 = 9_223_372_036_854_775_807n;

export type RestaurantProductionRefusal =
  | 'restaurant-mode-required'
  | 'recipe-not-found'
  | 'stale-revision'
  | 'unknown-branch'
  | 'inactive-branch'
  | 'unknown-product'
  | 'inactive-product'
  | 'untracked-product'
  | 'invalid-quantity'
  | 'insufficient-stock'
  | 'idempotency-conflict'
  | 'operation-in-progress';

export class RestaurantProductionRefusedError extends Error {
  public override readonly name = 'RestaurantProductionRefusedError';
  public constructor(public readonly detail: RestaurantProductionRefusal) {
    super('Restaurant production refused: ' + detail);
  }
}

export interface RestaurantProductionActor {
  readonly userId: string;
}

export interface RestaurantRecipeProductionRequest {
  readonly operationId: string;
  readonly branchId: string;
  readonly recipeRevision: string;
  readonly batchCount: string;
}

export interface RestaurantRecipeProductionLineResult {
  readonly id: string;
  readonly role: 'ingredient' | 'output';
  readonly productId: string;
  readonly deltaQuantityScaled: string;
  readonly beforeQuantityScaled: string;
  readonly afterQuantityScaled: string;
  readonly resultRevision: string;
  readonly costKnownQuantityScaled: string;
  readonly costUnknownQuantityScaled: string;
  readonly costValueMinor: string;
  readonly costProvenance: 'unknown' | 'recorded' | 'mixed';
}

export interface RestaurantRecipeProductionResult {
  readonly id: string;
  readonly branchId: string;
  readonly recipeId: string;
  readonly productId: string;
  readonly recipeRevision: string;
  readonly batchCount: string;
  readonly producedAt: string;
  readonly replayed: boolean;
  readonly outputCostStatus: 'known' | 'unknown';
  readonly lines: readonly RestaurantRecipeProductionLineResult[];
}

interface LockedRecipe {
  readonly id: string;
  readonly productId: string;
  readonly yieldQuantityScaled: bigint;
  readonly revision: bigint;
  readonly ingredients: readonly {
    readonly productId: string;
    readonly quantityScaled: bigint;
  }[];
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function positiveInteger(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) {
    throw new RestaurantProductionRefusedError('invalid-quantity');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_INT64) throw new RestaurantProductionRefusedError('invalid-quantity');
  return parsed;
}

function multiplyQuantity(quantity: bigint, batches: bigint): bigint {
  if (quantity <= 0n || batches <= 0n || quantity > MAX_INT64 / batches) {
    throw new RestaurantProductionRefusedError('invalid-quantity');
  }
  return quantity * batches;
}

function fingerprint(
  actorUserId: string,
  productId: string,
  request: RestaurantRecipeProductionRequest,
  recipeRevision: bigint,
  batchCount: bigint,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'restaurant-recipe-production.v1',
        actorUserId,
        productId.toLowerCase(),
        request.branchId.toLowerCase(),
        recipeRevision.toString(),
        batchCount.toString(),
      ]),
      'utf8',
    )
    .digest('base64url');
}

async function requireRestaurantMode(tx: TransactionClient, tenant: string): Promise<void> {
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId: tenant },
    select: { vertical: true },
  });
  if (settings?.vertical !== 'restaurant') {
    throw new RestaurantProductionRefusedError('restaurant-mode-required');
  }
}

async function lockRecipe(
  tx: TransactionClient,
  tenant: string,
  productId: string,
): Promise<LockedRecipe> {
  const rows = await tx.$queryRaw<
    { id: string; productId: string; yieldQuantityScaled: bigint; revision: bigint }[]
  >`
    SELECT "id", "productId", "yieldQuantityScaled", "revision"
      FROM "restaurant_recipes"
     WHERE "tenantId" = ${tenant}::uuid
       AND "productId" = ${productId}::uuid
     FOR SHARE`;
  const row = rows.at(0);
  if (row === undefined) throw new RestaurantProductionRefusedError('recipe-not-found');

  const ingredients = await tx.restaurantRecipeIngredient.findMany({
    where: { tenantId: tenant, recipeId: row.id },
    select: { ingredientProductId: true, quantityScaled: true },
    orderBy: { ingredientProductId: 'asc' },
  });
  if (ingredients.length === 0) {
    throw new RestaurantProductionRefusedError('recipe-not-found');
  }
  return {
    id: row.id,
    productId: row.productId,
    yieldQuantityScaled: row.yieldQuantityScaled,
    revision: row.revision,
    ingredients: ingredients.map((ingredient) => ({
      productId: ingredient.ingredientProductId,
      quantityScaled: ingredient.quantityScaled,
    })),
  };
}

async function reserve(
  tx: TransactionClient,
  tenant: string,
  operationId: string,
  requestHash: string,
): Promise<RestaurantRecipeProductionResult | null> {
  try {
    await tx.idempotencyKey.create({
      data: {
        id: newId(),
        tenantId: tenant,
        scope: PRODUCTION_SCOPE,
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
    where: { tenantId: tenant, scope: PRODUCTION_SCOPE, operationId },
    select: { status: true, requestHash: true, resultType: true, resultSnapshot: true },
  });
  if (existing === null) throw new RestaurantProductionRefusedError('idempotency-conflict');
  if (existing.requestHash !== requestHash) {
    throw new RestaurantProductionRefusedError('idempotency-conflict');
  }
  if (existing.status !== 'completed') {
    throw new RestaurantProductionRefusedError('operation-in-progress');
  }
  if (existing.resultType !== 'restaurant-recipe-production' || existing.resultSnapshot === null) {
    throw new RestaurantProductionRefusedError('idempotency-conflict');
  }
  const snapshot = existing.resultSnapshot as unknown as RestaurantRecipeProductionResult;
  return { ...snapshot, replayed: true };
}

async function complete(
  tx: TransactionClient,
  tenant: string,
  operationId: string,
  result: RestaurantRecipeProductionResult,
  at: Date,
): Promise<void> {
  const changed = await tx.idempotencyKey.updateMany({
    where: { tenantId: tenant, scope: PRODUCTION_SCOPE, operationId, status: 'reserved' },
    data: {
      status: 'completed',
      resultType: 'restaurant-recipe-production',
      resultId: result.id,
      resultSnapshot: result as unknown as object,
      completedAt: at,
    },
  });
  if (changed.count !== 1) {
    throw new RestaurantProductionRefusedError('idempotency-conflict');
  }
}

function translateStock(error: unknown): never {
  if (error instanceof InsufficientStockError) {
    throw new RestaurantProductionRefusedError('insufficient-stock');
  }
  if (error instanceof StockRequestError) {
    throw new RestaurantProductionRefusedError('invalid-quantity');
  }
  if (error instanceof StockOperationRefusedError) {
    switch (error.detail) {
      case 'unknown-branch':
      case 'inactive-branch':
      case 'unknown-product':
      case 'inactive-product':
      case 'untracked-product':
      case 'insufficient-stock':
      case 'idempotency-conflict':
        throw new RestaurantProductionRefusedError(error.detail);
      case 'stock-changed':
        throw new RestaurantProductionRefusedError('idempotency-conflict');
    }
  }
  throw error;
}

export async function recordRestaurantRecipeProduction(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: RestaurantProductionActor,
  productId: string,
  request: RestaurantRecipeProductionRequest,
  clock: () => Date = () => new Date(),
): Promise<RestaurantRecipeProductionResult> {
  const recipeRevision = positiveInteger(request.recipeRevision);
  const batchCount = positiveInteger(request.batchCount);
  const tenant = tenantParam(scope);
  const product = productId.trim().toLowerCase();
  const branch = request.branchId.trim().toLowerCase();
  const requestHash = fingerprint(actor.userId, product, request, recipeRevision, batchCount);

  try {
    return await withTenant(prisma, scope.tenantId, async (tx) => {
      const replay = await reserve(tx, tenant, request.operationId, requestHash);
      if (replay !== null) return replay;

      await requireRestaurantMode(tx, tenant);
      const recipe = await lockRecipe(tx, tenant, product);
      if (recipe.revision !== recipeRevision) {
        throw new RestaurantProductionRefusedError('stale-revision');
      }

      await lockBranches(tx, tenant, [branch]);
      const productIds = [recipe.productId, ...recipe.ingredients.map((item) => item.productId)];
      const products = await lockProducts(tx, tenant, productIds);
      const outputQuantity = multiplyQuantity(recipe.yieldQuantityScaled, batchCount);
      const outputFact = products.get(recipe.productId);
      if (outputFact === undefined) {
        throw new RestaurantProductionRefusedError('unknown-product');
      }
      assertQuantityShape(outputQuantity, outputFact.productType, 'outputQuantityScaled');

      const ingredientPlans = recipe.ingredients.map((ingredient) => {
        const quantity = multiplyQuantity(ingredient.quantityScaled, batchCount);
        const fact = products.get(ingredient.productId);
        if (fact === undefined) {
          throw new RestaurantProductionRefusedError('unknown-product');
        }
        assertQuantityShape(-quantity, fact.productType, 'ingredientQuantityScaled');
        return { ...ingredient, quantity };
      });

      const balances = await lockBalances(
        tx,
        tenant,
        productIds.map((id) => ({ branchId: branch, productId: id })),
      );
      for (const ingredient of ingredientPlans) {
        const before = lockedOrThrow(balances, {
          branchId: branch,
          productId: ingredient.productId,
        });
        if (before.quantityScaled < ingredient.quantity) {
          throw new RestaurantProductionRefusedError('insufficient-stock');
        }
      }

      const at = clock();
      const productionId = newId();
      await tx.restaurantRecipeProduction.create({
        data: {
          id: productionId,
          tenantId: tenant,
          branchId: branch,
          recipeId: recipe.id,
          recipeRevision,
          batchCount,
          operationId: request.operationId,
          requestHash,
          actorUserId: actor.userId,
          producedAt: at,
        },
      });

      const results: RestaurantRecipeProductionLineResult[] = [];
      let allIngredientCostKnown = true;
      let totalIngredientValue = 0n;

      for (const ingredient of ingredientPlans) {
        const before = lockedOrThrow(balances, {
          branchId: branch,
          productId: ingredient.productId,
        });
        const lineId = newId();
        const applied = await applyMovementWithin(
          tx,
          tenant,
          {
            id: newId(),
            branchId: branch,
            productId: ingredient.productId,
            kind: 'production-consumption',
            quantityScaled: (-ingredient.quantity).toString(),
            reason: null,
            sourceType: SOURCE_TYPE,
            sourceId: productionId,
            actorUserId: actor.userId,
            occurredAt: at.toISOString(),
          },
          false,
          lineId,
        );
        if (applied.cost.unknownQuantityScaled !== 0n) {
          allIngredientCostKnown = false;
        } else {
          totalIngredientValue = addKnownCostValue(
            totalIngredientValue,
            applied.cost.knownValueMinor,
          );
        }
        await tx.restaurantRecipeProductionLine.create({
          data: {
            id: lineId,
            tenantId: tenant,
            productionId,
            productId: ingredient.productId,
            role: 'ingredient',
            deltaQuantityScaled: -ingredient.quantity,
            beforeQuantityScaled: before.quantityScaled,
            afterQuantityScaled: applied.quantityScaled,
            resultRevision: applied.revision,
            costKnownQuantityScaled: applied.cost.knownQuantityScaled,
            costUnknownQuantityScaled: applied.cost.unknownQuantityScaled,
            costValueMinor: applied.cost.knownValueMinor,
            costProvenance: applied.cost.provenance,
          },
        });
        results.push({
          id: lineId,
          role: 'ingredient',
          productId: ingredient.productId,
          deltaQuantityScaled: (-ingredient.quantity).toString(),
          beforeQuantityScaled: before.quantityScaled.toString(),
          afterQuantityScaled: applied.quantityScaled.toString(),
          resultRevision: applied.revision.toString(),
          costKnownQuantityScaled: applied.cost.knownQuantityScaled.toString(),
          costUnknownQuantityScaled: applied.cost.unknownQuantityScaled.toString(),
          costValueMinor: applied.cost.knownValueMinor.toString(),
          costProvenance: applied.cost.provenance,
        });
      }

      const outputBefore = lockedOrThrow(balances, {
        branchId: branch,
        productId: recipe.productId,
      });
      const outputLineId = newId();
      const outputBasis = allIngredientCostKnown
        ? {
            knownQuantityScaled: outputQuantity,
            unknownQuantityScaled: 0n,
            knownValueMinor: totalIngredientValue,
          }
        : {
            knownQuantityScaled: 0n,
            unknownQuantityScaled: outputQuantity,
            knownValueMinor: 0n,
          };
      const output = await applyMovementWithin(
        tx,
        tenant,
        {
          id: newId(),
          branchId: branch,
          productId: recipe.productId,
          kind: 'production-output',
          quantityScaled: outputQuantity.toString(),
          reason: null,
          sourceType: SOURCE_TYPE,
          sourceId: productionId,
          actorUserId: actor.userId,
          occurredAt: at.toISOString(),
        },
        true,
        outputLineId,
        outputBasis,
      );
      await tx.restaurantRecipeProductionLine.create({
        data: {
          id: outputLineId,
          tenantId: tenant,
          productionId,
          productId: recipe.productId,
          role: 'output',
          deltaQuantityScaled: outputQuantity,
          beforeQuantityScaled: outputBefore.quantityScaled,
          afterQuantityScaled: output.quantityScaled,
          resultRevision: output.revision,
          costKnownQuantityScaled: output.cost.knownQuantityScaled,
          costUnknownQuantityScaled: output.cost.unknownQuantityScaled,
          costValueMinor: output.cost.knownValueMinor,
          costProvenance: output.cost.provenance,
        },
      });
      results.push({
        id: outputLineId,
        role: 'output',
        productId: recipe.productId,
        deltaQuantityScaled: outputQuantity.toString(),
        beforeQuantityScaled: outputBefore.quantityScaled.toString(),
        afterQuantityScaled: output.quantityScaled.toString(),
        resultRevision: output.revision.toString(),
        costKnownQuantityScaled: output.cost.knownQuantityScaled.toString(),
        costUnknownQuantityScaled: output.cost.unknownQuantityScaled.toString(),
        costValueMinor: output.cost.knownValueMinor.toString(),
        costProvenance: output.cost.provenance,
      });

      const result: RestaurantRecipeProductionResult = {
        id: productionId,
        branchId: branch,
        recipeId: recipe.id,
        productId: recipe.productId,
        recipeRevision: recipeRevision.toString(),
        batchCount: batchCount.toString(),
        producedAt: at.toISOString(),
        replayed: false,
        outputCostStatus: allIngredientCostKnown ? 'known' : 'unknown',
        lines: results,
      };

      await tx.auditEvent.create({
        data: {
          id: newId(),
          tenantId: tenant,
          actorUserId: actor.userId,
          branchId: branch,
          terminalId: null,
          eventType: 'restaurant.recipe.production.recorded',
          entityType: 'restaurant-recipe-production',
          entityId: productionId,
          metadata: {
            productId: recipe.productId,
            recipeRevision: recipeRevision.toString(),
            batchCount: batchCount.toString(),
            ingredientCount: ingredientPlans.length,
            outputCostStatus: result.outputCostStatus,
          },
          occurredAt: at,
        },
      });
      await complete(tx, tenant, request.operationId, result, at);
      return result;
    });
  } catch (error) {
    if (error instanceof RestaurantProductionRefusedError) throw error;
    return translateStock(error);
  }
}
