import {
  ContextPriceError,
  baseInventoryQuantityScaled,
  packageInventoryQuantityScaled,
  resolveContextPrice,
} from '@korvi/domain';
import { DatabaseError, RetailPricingPolicyRefusedError } from '../errors.js';
import type {
  ContextPriceList,
  PriceContext,
  RecordSaleInput,
  RetailPricingSettlementLineInput,
} from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';

interface ProductPolicyRow {
  id: string;
  productType: string;
  priceMinor: bigint;
  isActive: boolean;
}

interface PackagePolicyRow {
  id: string;
  productId: string;
  code: string;
  nameAr: string;
  unitLabel: string;
  baseQuantityScaled: bigint;
  isActive: boolean;
  revision: bigint;
}

interface PriceListPolicyRow {
  id: string;
  code: string;
  context: string;
  status: string;
  revision: bigint;
}

interface PriceEntryPolicyRow {
  id: string;
  productId: string;
  packageId: string | null;
  priceMinor: bigint;
  revision: bigint;
}

async function lockRetailPricingPolicyShared(tx: TransactionClient, tenant: string): Promise<void> {
  await tx.$queryRaw<{ locked: number }[]>`
    SELECT 1::int4 AS "locked"
      FROM (
        SELECT pg_advisory_xact_lock_shared(
          hashtextextended('korvi:retail-pricing-policy:' || ${tenant}, 0)
        )
      ) AS policy_lock`;
}

async function lockProduct(
  tx: TransactionClient,
  tenant: string,
  productId: string,
): Promise<ProductPolicyRow | null> {
  const rows = await tx.$queryRaw<ProductPolicyRow[]>`
    SELECT "id","productType","priceMinor","isActive"
      FROM "products"
     WHERE "tenantId" = ${tenant}::uuid
       AND "id" = ${productId}::uuid
     FOR SHARE`;
  return rows.at(0) ?? null;
}

async function lockPackage(
  tx: TransactionClient,
  tenant: string,
  productId: string,
  packageId: string,
): Promise<PackagePolicyRow | null> {
  const rows = await tx.$queryRaw<PackagePolicyRow[]>`
    SELECT "id","productId","code","nameAr","unitLabel","baseQuantityScaled","isActive","revision"
      FROM "product_packages"
     WHERE "tenantId" = ${tenant}::uuid
       AND "productId" = ${productId}::uuid
       AND "id" = ${packageId}::uuid
     FOR SHARE`;
  return rows.at(0) ?? null;
}

async function lockActiveLists(
  tx: TransactionClient,
  tenant: string,
  context: PriceContext,
): Promise<PriceListPolicyRow[]> {
  return tx.$queryRaw<PriceListPolicyRow[]>`
    SELECT "id","code","context","status","revision"
      FROM "price_lists"
     WHERE "tenantId" = ${tenant}::uuid
       AND "context" = ${context}
       AND "status" = 'active'
     ORDER BY "id"
     FOR SHARE`;
}

async function lockEntries(
  tx: TransactionClient,
  tenant: string,
  priceListId: string,
  productId: string,
): Promise<PriceEntryPolicyRow[]> {
  return tx.$queryRaw<PriceEntryPolicyRow[]>`
    SELECT "id","productId","packageId","priceMinor","revision"
      FROM "price_list_entries"
     WHERE "tenantId" = ${tenant}::uuid
       AND "priceListId" = ${priceListId}::uuid
       AND "productId" = ${productId}::uuid
     ORDER BY "packageId" NULLS FIRST, "id"
     FOR SHARE`;
}

function selectedEntry(
  rows: readonly PriceEntryPolicyRow[],
  provenance: RetailPricingSettlementLineInput['provenance'],
  packageId: string | null,
): PriceEntryPolicyRow | null {
  if (provenance === 'product-base') return null;
  const selectedPackageId = provenance === 'price-list-package' ? packageId : null;
  return rows.find((row) => row.packageId === selectedPackageId) ?? null;
}

function sameNullable(actual: string | null | undefined, expected: string | null): boolean {
  return (actual ?? null) === expected;
}

function assertSaleSnapshot(
  saleLine: RecordSaleInput['sale']['lines'][number],
  settlement: RetailPricingSettlementLineInput,
  packageRow: PackagePolicyRow | null,
): void {
  if (
    saleLine.id !== settlement.saleLineId ||
    saleLine.productId !== settlement.productId ||
    !sameNullable(saleLine.packageId, settlement.packageId) ||
    saleLine.quantityScaled !== settlement.commercialQuantityScaled ||
    (saleLine.inventoryQuantityScaled ?? saleLine.quantityScaled) !==
      settlement.inventoryQuantityScaled ||
    saleLine.unitPriceMinor !== settlement.unitPriceMinor ||
    (saleLine.priceContext ?? null) !== settlement.context ||
    (saleLine.pricingProvenance ?? null) !== settlement.provenance ||
    !sameNullable(saleLine.priceListId, settlement.priceListId) ||
    !sameNullable(saleLine.priceListCode, settlement.priceListCode) ||
    !sameNullable(saleLine.priceListRevision, settlement.priceListRevision)
  ) {
    throw new RetailPricingPolicyRefusedError('policy-stale');
  }

  if (packageRow === null) {
    if (
      (saleLine.packageCode ?? null) !== null ||
      (saleLine.packageNameAr ?? null) !== null ||
      (saleLine.packageUnitLabel ?? null) !== null ||
      (saleLine.packageBaseQuantityScaled ?? null) !== null
    ) {
      throw new RetailPricingPolicyRefusedError('policy-stale');
    }
    return;
  }

  if (
    (saleLine.packageCode ?? null) !== packageRow.code ||
    (saleLine.packageNameAr ?? null) !== packageRow.nameAr ||
    (saleLine.packageUnitLabel ?? null) !== packageRow.unitLabel ||
    (saleLine.packageBaseQuantityScaled ?? null) !== packageRow.baseQuantityScaled.toString()
  ) {
    throw new RetailPricingPolicyRefusedError('policy-stale');
  }
}

/**
 * Re-proves V2-3 package conversion and contextual pricing inside the sale
 * transaction before any financial row is written.
 */
export async function proveRetailPricingSettlementWithin(
  tx: TransactionClient,
  tenant: string,
  input: RecordSaleInput,
): Promise<void> {
  const settlement = input.retailPricingSettlement;
  const hasRetailSnapshot = input.sale.lines.some(
    (line) =>
      (line.inventoryQuantityScaled ?? null) !== null ||
      (line.packageId ?? null) !== null ||
      (line.priceContext ?? null) !== null ||
      (line.pricingProvenance ?? null) !== null ||
      (line.priceListId ?? null) !== null,
  );

  if (settlement === undefined) {
    if (hasRetailSnapshot) {
      throw new DatabaseError(
        'V2-3 sale snapshots require an atomic retail pricing settlement authority.',
      );
    }
    return;
  }

  if (input.restaurantOrderSettlement !== undefined) {
    throw new RetailPricingPolicyRefusedError('policy-stale');
  }
  if (settlement.lines.length !== input.sale.lines.length) {
    throw new RetailPricingPolicyRefusedError('policy-stale');
  }

  await lockRetailPricingPolicyShared(tx, tenant);

  const saleLines = new Map(input.sale.lines.map((line) => [line.id, line] as const));
  const ordered = [...settlement.lines].sort((left, right) => {
    const productOrder = left.productId.localeCompare(right.productId);
    if (productOrder !== 0) return productOrder;
    return (left.packageId ?? '').localeCompare(right.packageId ?? '');
  });

  const identity = new Set<string>();
  for (const line of ordered) {
    if (line.context !== settlement.context) {
      throw new RetailPricingPolicyRefusedError('policy-stale');
    }
    const commercialIdentity = line.productId + '\\u0000' + (line.packageId ?? '');
    if (identity.has(commercialIdentity)) {
      throw new RetailPricingPolicyRefusedError('policy-stale');
    }
    identity.add(commercialIdentity);

    const saleLine = saleLines.get(line.saleLineId);
    if (saleLine === undefined) throw new RetailPricingPolicyRefusedError('policy-stale');

    const product = await lockProduct(tx, tenant, line.productId);
    if (product === null || !product.isActive) {
      throw new RetailPricingPolicyRefusedError('policy-stale');
    }

    let packageRow: PackagePolicyRow | null = null;
    if (line.packageId !== null) {
      packageRow = await lockPackage(tx, tenant, line.productId, line.packageId);
      if (packageRow === null) throw new RetailPricingPolicyRefusedError('unknown-package');
      if (!packageRow.isActive) throw new RetailPricingPolicyRefusedError('package-unavailable');
      if (
        product.productType !== 'unit' ||
        line.packageRevision === null ||
        packageRow.revision.toString() !== line.packageRevision
      ) {
        throw new RetailPricingPolicyRefusedError('policy-stale');
      }
    } else if (line.packageRevision !== null) {
      throw new RetailPricingPolicyRefusedError('policy-stale');
    }

    const expectedInventory =
      packageRow === null
        ? baseInventoryQuantityScaled(BigInt(line.commercialQuantityScaled))
        : packageInventoryQuantityScaled({
            commercialQuantityScaled: BigInt(line.commercialQuantityScaled),
            packageBaseQuantityScaled: packageRow.baseQuantityScaled,
          });
    if (expectedInventory.toString() !== line.inventoryQuantityScaled) {
      throw new RetailPricingPolicyRefusedError('policy-stale');
    }

    const lists = await lockActiveLists(tx, tenant, settlement.context);
    const entriesByList = new Map<string, PriceEntryPolicyRow[]>();
    const domainLists: ContextPriceList[] = [];
    for (const list of lists) {
      const entries = await lockEntries(tx, tenant, list.id, line.productId);
      entriesByList.set(list.id, entries);
      domainLists.push({
        id: list.id,
        code: list.code,
        context: list.context as PriceContext,
        status: 'active',
        revision: list.revision,
        entries: entries.map((entry) => ({
          productId: entry.productId,
          packageId: entry.packageId,
          priceMinor: entry.priceMinor,
        })),
      });
    }

    let resolved;
    try {
      resolved = resolveContextPrice({
        context: settlement.context,
        target: {
          productId: line.productId,
          packageId: line.packageId,
          packageBaseQuantityScaled: packageRow?.baseQuantityScaled ?? null,
          productBasePriceMinor: product.priceMinor,
        },
        lists: domainLists,
      });
    } catch (error) {
      if (error instanceof ContextPriceError && error.detail === 'wholesale-price-incomplete') {
        throw new RetailPricingPolicyRefusedError('wholesale-price-incomplete');
      }
      throw error;
    }

    const list =
      resolved.priceListId === null
        ? null
        : (lists.find((candidate) => candidate.id === resolved.priceListId) ?? null);
    const entry =
      list === null
        ? null
        : selectedEntry(entriesByList.get(list.id) ?? [], resolved.provenance, line.packageId);

    if (
      resolved.unitPriceMinor.toString() !== line.unitPriceMinor ||
      resolved.provenance !== line.provenance ||
      resolved.priceListId !== line.priceListId ||
      resolved.priceListCode !== line.priceListCode ||
      (resolved.priceListRevision?.toString() ?? null) !== line.priceListRevision ||
      (entry?.id ?? null) !== line.priceListEntryId ||
      (entry?.revision.toString() ?? null) !== line.priceListEntryRevision
    ) {
      throw new RetailPricingPolicyRefusedError('policy-stale');
    }

    assertSaleSnapshot(saleLine, line, packageRow);
  }
}
