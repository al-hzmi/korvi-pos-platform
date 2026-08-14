import type { AdminFailureReason, AdminResult, MerchantAdminService } from '../../admin/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';

/**
 * A merchant-administration service that records rather than persists.
 *
 * The route tests ask two questions — did this request reach the authority
 * layer at all, and what did the route hand it — and both are answered by
 * writing down the call. A second in-memory implementation of the rules would
 * answer a third question nobody asked, and would drift away from the real one
 * the first time a rule changed.
 *
 * `refuseWith` lets a test drive the failure translation without inventing a
 * state that produces the failure: what is under test there is the mapping from
 * a refusal to a status code, and the mapping is the route's, not the
 * database's.
 */

export interface AdminCall {
  readonly name: string;
  readonly principal: AuthenticatedPrincipal;
  readonly args: readonly unknown[];
}

export interface RecordingAdmin {
  readonly service: MerchantAdminService;
  readonly calls: AdminCall[];
  refuseWith(reason: AdminFailureReason | null): void;
}

export function recordingAdminService(): RecordingAdmin {
  const calls: AdminCall[] = [];
  let refusal: AdminFailureReason | null = null;

  function record<T>(
    name: string,
    principal: AuthenticatedPrincipal,
    args: readonly unknown[],
    value: T,
  ): Promise<AdminResult<T>> {
    calls.push({ name, principal, args });
    if (refusal !== null) {
      return Promise.resolve({ outcome: 'failure', reason: refusal });
    }
    return Promise.resolve({ outcome: 'success', value });
  }

  const settings = {
    tenantId: '00000000-0000-7000-8000-000000000000',
    vertical: 'retail',
    priceMode: 'tax-inclusive',
    defaultVatBasisPoints: 1500,
    currency: 'SAR',
    requireBarcode: true,
    allowWeightedItems: false,
    trackInventory: true,
    allowNegativeStock: false,
    enableProductImages: false,
    receiptHeaderAr: null,
    receiptFooterAr: null,
  } as const;

  const branch = {
    id: '018fb000-0000-7000-8000-0000000000f1',
    code: 'B1',
    nameAr: 'فرع',
    nameEn: null,
    isActive: true,
    createdAt: '2026-08-14T00:00:00.000Z',
  } as const;

  const terminal = {
    id: '018fb000-0000-7000-8000-0000000000f2',
    branchId: branch.id,
    code: 'T1',
    label: 'صندوق',
    isActive: true,
    lastSeenAt: null,
  } as const;

  /** No `passwordHash`, no token, no lockout telemetry. Shape is the boundary. */
  const member = {
    userId: '018fb000-0000-7000-8000-0000000000f3',
    email: 'nada@korvi-a.test',
    displayName: 'ندى',
    userActive: true,
    membershipStatus: 'active',
    defaultBranchId: branch.id,
    hasCredential: false,
    roleIds: [] as readonly string[],
    lastLoginAt: null,
  } as const;

  const role = {
    id: '018fb000-0000-7000-8000-0000000000d1',
    key: 'owner',
    nameAr: 'مالك',
    nameEn: 'Owner',
    isSystem: true,
    maxDiscountBasisPoints: 10_000,
    permissions: ['users.manage'] as readonly string[],
  } as const;

  const service: MerchantAdminService = {
    readSettings: (principal) => record('readSettings', principal, [], settings),
    updateSettings: (principal, patch) => record('updateSettings', principal, [patch], settings),

    listBranches: (principal, limit, cursor) =>
      record('listBranches', principal, [limit, cursor], {
        items: [branch],
        hasMore: false,
        nextCursor: null,
      }),
    createBranch: (principal, input) => record('createBranch', principal, [input], branch),
    updateBranch: (principal, id, patch) => record('updateBranch', principal, [id, patch], branch),
    setBranchActive: (principal, id, isActive) =>
      record('setBranchActive', principal, [id, isActive], branch),

    listTerminals: (principal, limit, branchId, cursor) =>
      record('listTerminals', principal, [limit, branchId, cursor], {
        items: [terminal],
        hasMore: false,
        nextCursor: null,
      }),
    createTerminal: (principal, input) => record('createTerminal', principal, [input], terminal),
    updateTerminal: (principal, id, label) =>
      record('updateTerminal', principal, [id, label], terminal),
    setTerminalActive: (principal, id, isActive) =>
      record('setTerminalActive', principal, [id, isActive], terminal),

    listMembers: (principal, limit, cursor) =>
      record('listMembers', principal, [limit, cursor], {
        items: [member],
        hasMore: false,
        nextCursor: null,
      }),
    createMember: (principal, input) => record('createMember', principal, [input], member),
    updateMember: (principal, id, patch) => record('updateMember', principal, [id, patch], member),
    setUserActive: (principal, id, isActive) =>
      record('setUserActive', principal, [id, isActive], { member, revokedSessions: 0 }),
    setMembershipActive: (principal, id, isActive) =>
      record('setMembershipActive', principal, [id, isActive], { member, revokedSessions: 0 }),

    listRoles: (principal) => record('listRoles', principal, [], [role]),
    assignRole: (principal, userId, roleId) =>
      record('assignRole', principal, [userId, roleId], { member, changed: true }),
    removeRole: (principal, userId, roleId) =>
      record('removeRole', principal, [userId, roleId], { member, changed: true }),
  };

  return {
    service,
    calls,
    refuseWith(reason) {
      refusal = reason;
    },
  };
}
