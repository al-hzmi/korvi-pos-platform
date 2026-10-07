import {
  RestaurantModifierAdminRefusedError,
  createRestaurantModifierGroup,
  createRestaurantModifierOption,
  listRestaurantModifierGroups,
  readRestaurantModifierMenu,
  setRestaurantProductModifierGroups,
  updateRestaurantModifierGroup,
  updateRestaurantModifierOption,
} from '@korvi/database';
import {
  requirePrincipalPermission,
  tenantId as brandTenantId,
} from '@korvi/domain';
import type {
  CreateModifierGroupInput,
  CreateModifierOptionInput,
  RestaurantModifierAdminGroup,
  RestaurantModifierAdminRefusal,
  RestaurantModifierMenuGroup,
  SetProductModifierGroupsInput,
  UpdateModifierGroupInput,
  UpdateModifierOptionInput,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '@korvi/database';

export type RestaurantModifierAdminResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: RestaurantModifierAdminRefusal };

export interface MerchantRestaurantModifierService {
  menu(
    principal: AuthenticatedPrincipal,
    productId: string,
  ): Promise<readonly RestaurantModifierMenuGroup[]>;
  list(principal: AuthenticatedPrincipal): Promise<readonly RestaurantModifierAdminGroup[]>;
  createGroup(
    principal: AuthenticatedPrincipal,
    input: CreateModifierGroupInput,
  ): Promise<RestaurantModifierAdminResult<RestaurantModifierAdminGroup>>;
  updateGroup(
    principal: AuthenticatedPrincipal,
    groupId: string,
    input: UpdateModifierGroupInput,
  ): Promise<RestaurantModifierAdminResult<RestaurantModifierAdminGroup>>;
  createOption(
    principal: AuthenticatedPrincipal,
    groupId: string,
    input: CreateModifierOptionInput,
  ): Promise<RestaurantModifierAdminResult<RestaurantModifierAdminGroup>>;
  updateOption(
    principal: AuthenticatedPrincipal,
    optionId: string,
    input: UpdateModifierOptionInput,
  ): Promise<RestaurantModifierAdminResult<RestaurantModifierAdminGroup>>;
  setProductGroups(
    principal: AuthenticatedPrincipal,
    productId: string,
    input: SetProductModifierGroupsInput,
  ): Promise<RestaurantModifierAdminResult<readonly string[]>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

function actorOf(principal: AuthenticatedPrincipal) {
  return {
    userId: principal.userId,
    branchId: principal.branchId,
  };
}

async function attempt<T>(work: () => Promise<T>): Promise<RestaurantModifierAdminResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof RestaurantModifierAdminRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantRestaurantModifierService(
  prisma: PrismaClient,
): MerchantRestaurantModifierService {
  return {
    async menu(principal, productId) {
      requirePrincipalPermission(principal, 'sale.create');
      return readRestaurantModifierMenu(prisma, scopeOf(principal), productId);
    },

    async list(principal) {
      requirePrincipalPermission(principal, 'restaurant.menu.manage');
      return listRestaurantModifierGroups(prisma, scopeOf(principal));
    },

    async createGroup(principal, input) {
      requirePrincipalPermission(principal, 'restaurant.menu.manage');
      return attempt(() =>
        createRestaurantModifierGroup(prisma, scopeOf(principal), actorOf(principal), input),
      );
    },

    async updateGroup(principal, groupId, input) {
      requirePrincipalPermission(principal, 'restaurant.menu.manage');
      return attempt(() =>
        updateRestaurantModifierGroup(
          prisma,
          scopeOf(principal),
          actorOf(principal),
          groupId,
          input,
        ),
      );
    },

    async createOption(principal, groupId, input) {
      requirePrincipalPermission(principal, 'restaurant.menu.manage');
      return attempt(() =>
        createRestaurantModifierOption(
          prisma,
          scopeOf(principal),
          actorOf(principal),
          groupId,
          input,
        ),
      );
    },

    async updateOption(principal, optionId, input) {
      requirePrincipalPermission(principal, 'restaurant.menu.manage');
      return attempt(() =>
        updateRestaurantModifierOption(
          prisma,
          scopeOf(principal),
          actorOf(principal),
          optionId,
          input,
        ),
      );
    },

    async setProductGroups(principal, productId, input) {
      requirePrincipalPermission(principal, 'restaurant.menu.manage');
      return attempt(() =>
        setRestaurantProductModifierGroups(
          prisma,
          scopeOf(principal),
          actorOf(principal),
          productId,
          input,
        ),
      );
    },
  };
}
