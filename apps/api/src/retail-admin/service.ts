import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import {
  RetailAdminRefusedError,
  addRetailProductBarcode,
  createRetailPriceList,
  createRetailPriceListEntry,
  createRetailProductPackage,
  deleteRetailPriceListEntry,
  listRetailPriceLists,
  readRetailProductCommercialConfig,
  updateRetailBasePrice,
  updateRetailPriceList,
  updateRetailPriceListEntry,
  updateRetailProductPackage,
} from '@korvi/database';
import type {
  AddBarcodeRequest,
  CreatePackageRequest,
  CreatePriceListEntryRequest,
  CreatePriceListRequest,
  PrismaClient,
  RetailAdminRefusal,
  RetailPriceList,
  RetailProductCommercialConfig,
  UpdateBasePriceRequest,
  UpdatePackageRequest,
  UpdatePriceListEntryRequest,
  UpdatePriceListRequest,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';

export type RetailAdminFailureReason = RetailAdminRefusal;

export type RetailAdminResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: RetailAdminFailureReason };

export interface PackageCreateInput extends Omit<CreatePackageRequest, 'occurredAt'> {}
export interface PackageUpdateInput extends Omit<UpdatePackageRequest, 'occurredAt'> {}
export interface BarcodeCreateInput extends Omit<AddBarcodeRequest, 'occurredAt'> {}
export interface BasePriceUpdateInput extends Omit<UpdateBasePriceRequest, 'occurredAt'> {}
export interface PriceListCreateInput extends Omit<CreatePriceListRequest, 'occurredAt'> {}
export interface PriceListUpdateInput extends Omit<UpdatePriceListRequest, 'occurredAt'> {}
export interface PriceListEntryCreateInput
  extends Omit<CreatePriceListEntryRequest, 'occurredAt'> {}
export interface PriceListEntryUpdateInput
  extends Omit<UpdatePriceListEntryRequest, 'occurredAt'> {}

export interface MerchantRetailAdminService {
  productCommercial(
    principal: AuthenticatedPrincipal,
    productId: string,
  ): Promise<RetailAdminResult<RetailProductCommercialConfig>>;
  createPackage(
    principal: AuthenticatedPrincipal,
    input: PackageCreateInput,
  ): Promise<RetailAdminResult<RetailProductCommercialConfig>>;
  updatePackage(
    principal: AuthenticatedPrincipal,
    packageId: string,
    input: PackageUpdateInput,
  ): Promise<RetailAdminResult<RetailProductCommercialConfig>>;
  addBarcode(
    principal: AuthenticatedPrincipal,
    input: BarcodeCreateInput,
  ): Promise<RetailAdminResult<RetailProductCommercialConfig>>;
  updateBasePrice(
    principal: AuthenticatedPrincipal,
    productId: string,
    input: BasePriceUpdateInput,
  ): Promise<RetailAdminResult<RetailProductCommercialConfig>>;
  priceLists(principal: AuthenticatedPrincipal): Promise<readonly RetailPriceList[]>;
  createPriceList(
    principal: AuthenticatedPrincipal,
    input: PriceListCreateInput,
  ): Promise<RetailAdminResult<RetailPriceList>>;
  updatePriceList(
    principal: AuthenticatedPrincipal,
    priceListId: string,
    input: PriceListUpdateInput,
  ): Promise<RetailAdminResult<RetailPriceList>>;
  createPriceListEntry(
    principal: AuthenticatedPrincipal,
    priceListId: string,
    input: PriceListEntryCreateInput,
  ): Promise<RetailAdminResult<RetailPriceList>>;
  updatePriceListEntry(
    principal: AuthenticatedPrincipal,
    entryId: string,
    input: PriceListEntryUpdateInput,
  ): Promise<RetailAdminResult<RetailPriceList>>;
  deletePriceListEntry(
    principal: AuthenticatedPrincipal,
    entryId: string,
    expectedRevision: string,
  ): Promise<RetailAdminResult<RetailPriceList>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

function actorOf(principal: AuthenticatedPrincipal): { readonly userId: string } {
  return { userId: principal.userId };
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

async function attempt<T>(work: () => Promise<T>): Promise<RetailAdminResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof RetailAdminRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantRetailAdminService(
  prisma: PrismaClient,
  options: { readonly now?: () => Date } = {},
): MerchantRetailAdminService {
  const now = options.now ?? (() => new Date());

  return {
    async productCommercial(principal, productId) {
      requirePrincipalPermission(principal, 'product.write');
      const value = await readRetailProductCommercialConfig(prisma, scopeOf(principal), productId);
      return value === null
        ? { outcome: 'failure', reason: 'product-not-found' }
        : { outcome: 'success', value };
    },

    async createPackage(principal, input) {
      requirePrincipalPermission(principal, 'product.write');
      return attempt(() =>
        createRetailProductPackage(prisma, scopeOf(principal), actorOf(principal), {
          ...input,
          occurredAt: nowIso(now),
        }),
      );
    },

    async updatePackage(principal, packageId, input) {
      requirePrincipalPermission(principal, 'product.write');
      return attempt(() =>
        updateRetailProductPackage(prisma, scopeOf(principal), actorOf(principal), packageId, {
          ...input,
          occurredAt: nowIso(now),
        }),
      );
    },

    async addBarcode(principal, input) {
      requirePrincipalPermission(principal, 'product.write');
      return attempt(() =>
        addRetailProductBarcode(prisma, scopeOf(principal), actorOf(principal), {
          ...input,
          occurredAt: nowIso(now),
        }),
      );
    },

    async updateBasePrice(principal, productId, input) {
      requirePrincipalPermission(principal, 'product.write');
      return attempt(() =>
        updateRetailBasePrice(prisma, scopeOf(principal), actorOf(principal), productId, {
          ...input,
          occurredAt: nowIso(now),
        }),
      );
    },

    async priceLists(principal) {
      requirePrincipalPermission(principal, 'price-list.manage');
      return listRetailPriceLists(prisma, scopeOf(principal));
    },

    async createPriceList(principal, input) {
      requirePrincipalPermission(principal, 'price-list.manage');
      return attempt(() =>
        createRetailPriceList(prisma, scopeOf(principal), actorOf(principal), {
          ...input,
          occurredAt: nowIso(now),
        }),
      );
    },

    async updatePriceList(principal, priceListId, input) {
      requirePrincipalPermission(principal, 'price-list.manage');
      return attempt(() =>
        updateRetailPriceList(prisma, scopeOf(principal), actorOf(principal), priceListId, {
          ...input,
          occurredAt: nowIso(now),
        }),
      );
    },

    async createPriceListEntry(principal, priceListId, input) {
      requirePrincipalPermission(principal, 'price-list.manage');
      return attempt(() =>
        createRetailPriceListEntry(prisma, scopeOf(principal), actorOf(principal), priceListId, {
          ...input,
          occurredAt: nowIso(now),
        }),
      );
    },

    async updatePriceListEntry(principal, entryId, input) {
      requirePrincipalPermission(principal, 'price-list.manage');
      return attempt(() =>
        updateRetailPriceListEntry(prisma, scopeOf(principal), actorOf(principal), entryId, {
          ...input,
          occurredAt: nowIso(now),
        }),
      );
    },

    async deletePriceListEntry(principal, entryId, expectedRevision) {
      requirePrincipalPermission(principal, 'price-list.manage');
      return attempt(() =>
        deleteRetailPriceListEntry(
          prisma,
          scopeOf(principal),
          actorOf(principal),
          entryId,
          expectedRevision,
          nowIso(now),
        ),
      );
    },
  };
}
