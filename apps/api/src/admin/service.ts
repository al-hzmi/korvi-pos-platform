import {
  MerchantAdminError,
  normalizeAdminCode,
  normalizeAdminName,
  normalizeEmail,
  normalizeOptionalLine,
  tenantId as brandTenantId,
} from '@korvi/domain';
import {
  MerchantAdminRefusedError,
  assignRoleToMember,
  createBranch,
  createMember,
  createTerminal,
  listAssignableRoles,
  listBranches,
  listMembers,
  listTerminals,
  removeRoleFromMember,
  setBranchActive,
  setMemberMembershipActive,
  setMemberUserActive,
  setTerminalActive,
  updateBranch,
  updateMember,
  updateTenantSettings,
  updateTerminal,
} from '@korvi/database';
import type {
  AccessChange,
  AdminBranch,
  AdminMember,
  AdminPage,
  AdminRole,
  AdminTenantSettings,
  AdminTerminal,
  PrismaClient,
  RoleAssignmentResult,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';

/**
 * Merchant administration, as the API layer sees it.
 *
 * Every method takes an `AuthenticatedPrincipal` and nothing that could stand
 * in for one. That is the whole point of the signature: there is no argument on
 * any of these methods into which a request body's `tenantId` or `actorUserId`
 * could be threaded, so the compiler enforces what the routes would otherwise
 * have to remember. Tenant and actor come from the session or they do not come
 * at all.
 *
 * Normalisation happens here, once, against `@korvi/domain` — so a code typed
 * with Arabic-Indic digits and a code typed with Latin ones are the same code
 * whichever route received it, and a name is bounded before it reaches a
 * column rather than truncated by one.
 */

export type AdminFailureReason =
  | 'unknown-branch'
  | 'unknown-terminal'
  | 'unknown-member'
  | 'unknown-role'
  | 'code-taken'
  | 'email-taken'
  | 'branch-in-use'
  | 'branch-inactive'
  | 'invalid-cursor'
  | 'last-administrator'
  | 'invalid-input';

export type AdminResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: AdminFailureReason };

/**
 * `?: T | undefined` rather than `?: T`, throughout.
 *
 * Under `exactOptionalPropertyTypes` those are different types, and the wider
 * one is what a zod-parsed body actually produces: an absent key arrives as
 * `undefined`. Narrowing here would only push a cast into the routes, which is
 * the place least able to reason about what an absent field means.
 *
 * Absent and null stay distinct all the way down: absent leaves a field alone,
 * null clears it.
 */
export interface SettingsPatchInput {
  readonly requireBarcode?: boolean | undefined;
  readonly allowWeightedItems?: boolean | undefined;
  readonly trackInventory?: boolean | undefined;
  readonly allowNegativeStock?: boolean | undefined;
  readonly enableProductImages?: boolean | undefined;
  readonly receiptHeaderAr?: string | null | undefined;
  readonly receiptFooterAr?: string | null | undefined;
}

export interface BranchCreateInput {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn?: string | null | undefined;
}

export interface BranchPatchInput {
  readonly nameAr?: string | undefined;
  readonly nameEn?: string | null | undefined;
}

export interface TerminalCreateInput {
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
}

export interface MemberCreateInput {
  readonly email: string;
  readonly displayName: string;
  readonly defaultBranchId?: string | null | undefined;
}

export interface MemberPatchInput {
  readonly displayName?: string | undefined;
  readonly defaultBranchId?: string | null | undefined;
}

export interface MerchantAdminService {
  readSettings(principal: AuthenticatedPrincipal): Promise<AdminResult<AdminTenantSettings>>;
  updateSettings(
    principal: AuthenticatedPrincipal,
    patch: SettingsPatchInput,
  ): Promise<AdminResult<AdminTenantSettings>>;

  listBranches(
    principal: AuthenticatedPrincipal,
    limit: number,
    cursor: string | null,
  ): Promise<AdminResult<AdminPage<AdminBranch>>>;
  createBranch(
    principal: AuthenticatedPrincipal,
    input: BranchCreateInput,
  ): Promise<AdminResult<AdminBranch>>;
  updateBranch(
    principal: AuthenticatedPrincipal,
    branchId: string,
    patch: BranchPatchInput,
  ): Promise<AdminResult<AdminBranch>>;
  setBranchActive(
    principal: AuthenticatedPrincipal,
    branchId: string,
    isActive: boolean,
  ): Promise<AdminResult<AdminBranch>>;

  listTerminals(
    principal: AuthenticatedPrincipal,
    limit: number,
    branchId: string | null,
    cursor: string | null,
  ): Promise<AdminResult<AdminPage<AdminTerminal>>>;
  createTerminal(
    principal: AuthenticatedPrincipal,
    input: TerminalCreateInput,
  ): Promise<AdminResult<AdminTerminal>>;
  updateTerminal(
    principal: AuthenticatedPrincipal,
    terminalId: string,
    label: string,
  ): Promise<AdminResult<AdminTerminal>>;
  setTerminalActive(
    principal: AuthenticatedPrincipal,
    terminalId: string,
    isActive: boolean,
  ): Promise<AdminResult<AdminTerminal>>;

  listMembers(
    principal: AuthenticatedPrincipal,
    limit: number,
    cursor: string | null,
  ): Promise<AdminResult<AdminPage<AdminMember>>>;
  createMember(
    principal: AuthenticatedPrincipal,
    input: MemberCreateInput,
  ): Promise<AdminResult<AdminMember>>;
  updateMember(
    principal: AuthenticatedPrincipal,
    userId: string,
    patch: MemberPatchInput,
  ): Promise<AdminResult<AdminMember>>;
  setUserActive(
    principal: AuthenticatedPrincipal,
    userId: string,
    isActive: boolean,
  ): Promise<AdminResult<AccessChange>>;
  setMembershipActive(
    principal: AuthenticatedPrincipal,
    userId: string,
    isActive: boolean,
  ): Promise<AdminResult<AccessChange>>;

  listRoles(principal: AuthenticatedPrincipal): Promise<AdminResult<readonly AdminRole[]>>;
  assignRole(
    principal: AuthenticatedPrincipal,
    userId: string,
    roleId: string,
  ): Promise<AdminResult<RoleAssignmentResult>>;
  removeRole(
    principal: AuthenticatedPrincipal,
    userId: string,
    roleId: string,
  ): Promise<AdminResult<RoleAssignmentResult>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

function actorOf(principal: AuthenticatedPrincipal): { readonly userId: string } {
  return { userId: principal.userId };
}

function ok<T>(value: T): AdminResult<T> {
  return { outcome: 'success', value };
}

function no<T>(reason: AdminFailureReason): AdminResult<T> {
  return { outcome: 'failure', reason };
}

/**
 * Turn the two kinds of deliberate refusal into one vocabulary.
 *
 * A `MerchantAdminError` is the domain saying the input is not well formed; a
 * `MerchantAdminRefusedError` is the database saying the change cannot be made.
 * Anything else is rethrown — an unexpected failure must not be laundered into
 * a tidy 4xx that tells the caller their request was the problem.
 */
async function attempt<T>(work: () => Promise<T>): Promise<AdminResult<T>> {
  try {
    return ok(await work());
  } catch (error) {
    if (error instanceof MerchantAdminError) return no('invalid-input');
    if (error instanceof MerchantAdminRefusedError) return no(error.detail);
    throw error;
  }
}

export interface MerchantAdminDeps {
  readonly prisma: PrismaClient;
  /** Reading settings reuses the tenant repository the till already uses. */
  readonly readSettings: (scope: TenantScope) => Promise<AdminTenantSettings | null>;
}

export function createMerchantAdminService(deps: MerchantAdminDeps): MerchantAdminService {
  const { prisma } = deps;

  return {
    async readSettings(principal) {
      const settings = await deps.readSettings(scopeOf(principal));
      return settings === null ? no('unknown-member') : ok(settings);
    },

    async updateSettings(principal, patch) {
      return attempt(async () => {
        // Normalised before it reaches a column: `null` clears a receipt line,
        // an over-long one is refused rather than cut in half.
        const normalized = {
          ...patch,
          ...(patch.receiptHeaderAr === undefined
            ? {}
            : { receiptHeaderAr: normalizeOptionalLine(patch.receiptHeaderAr) }),
          ...(patch.receiptFooterAr === undefined
            ? {}
            : { receiptFooterAr: normalizeOptionalLine(patch.receiptFooterAr) }),
        };
        return updateTenantSettings(prisma, scopeOf(principal), actorOf(principal), normalized);
      });
    },

    async listBranches(principal, limit, cursor) {
      return attempt(() => listBranches(prisma, scopeOf(principal), limit, cursor));
    },

    async createBranch(principal, input) {
      return attempt(() =>
        createBranch(prisma, scopeOf(principal), actorOf(principal), {
          code: normalizeAdminCode(input.code),
          nameAr: normalizeAdminName(input.nameAr),
          nameEn: normalizeOptionalLine(input.nameEn ?? null),
        }),
      );
    },

    async updateBranch(principal, branchId, patch) {
      return attempt(() =>
        updateBranch(prisma, scopeOf(principal), actorOf(principal), branchId, {
          ...(patch.nameAr === undefined ? {} : { nameAr: normalizeAdminName(patch.nameAr) }),
          ...(patch.nameEn === undefined ? {} : { nameEn: normalizeOptionalLine(patch.nameEn) }),
        }),
      );
    },

    async setBranchActive(principal, branchId, isActive) {
      return attempt(() =>
        setBranchActive(prisma, scopeOf(principal), actorOf(principal), branchId, isActive),
      );
    },

    async listTerminals(principal, limit, branchId, cursor) {
      return attempt(() => listTerminals(prisma, scopeOf(principal), limit, branchId, cursor));
    },

    async createTerminal(principal, input) {
      return attempt(() =>
        createTerminal(prisma, scopeOf(principal), actorOf(principal), {
          branchId: input.branchId,
          code: normalizeAdminCode(input.code),
          label: normalizeAdminName(input.label),
        }),
      );
    },

    async updateTerminal(principal, terminalId, label) {
      return attempt(() =>
        updateTerminal(prisma, scopeOf(principal), actorOf(principal), terminalId, {
          label: normalizeAdminName(label),
        }),
      );
    },

    async setTerminalActive(principal, terminalId, isActive) {
      return attempt(() =>
        setTerminalActive(prisma, scopeOf(principal), actorOf(principal), terminalId, isActive),
      );
    },

    async listMembers(principal, limit, cursor) {
      return attempt(() => listMembers(prisma, scopeOf(principal), limit, cursor));
    },

    async createMember(principal, input) {
      const email = normalizeEmail(input.email);
      // The same normalisation login uses. An address that will never resolve
      // is refused here rather than becoming an account nobody can sign into.
      if (email === '') return no('invalid-input');
      return attempt(() =>
        createMember(prisma, scopeOf(principal), actorOf(principal), {
          email,
          displayName: normalizeAdminName(input.displayName),
          defaultBranchId: input.defaultBranchId ?? null,
        }),
      );
    },

    async updateMember(principal, userId, patch) {
      return attempt(() =>
        updateMember(prisma, scopeOf(principal), actorOf(principal), userId, {
          ...(patch.displayName === undefined
            ? {}
            : { displayName: normalizeAdminName(patch.displayName) }),
          ...(patch.defaultBranchId === undefined
            ? {}
            : { defaultBranchId: patch.defaultBranchId }),
        }),
      );
    },

    async setUserActive(principal, userId, isActive) {
      return attempt(() =>
        setMemberUserActive(prisma, scopeOf(principal), actorOf(principal), userId, isActive),
      );
    },

    async setMembershipActive(principal, userId, isActive) {
      return attempt(() =>
        setMemberMembershipActive(prisma, scopeOf(principal), actorOf(principal), userId, isActive),
      );
    },

    async listRoles(principal) {
      return attempt(() => listAssignableRoles(prisma, scopeOf(principal)));
    },

    async assignRole(principal, userId, roleId) {
      return attempt(() =>
        assignRoleToMember(prisma, scopeOf(principal), actorOf(principal), userId, roleId),
      );
    },

    async removeRole(principal, userId, roleId) {
      return attempt(() =>
        removeRoleFromMember(prisma, scopeOf(principal), actorOf(principal), userId, roleId),
      );
    },
  };
}
