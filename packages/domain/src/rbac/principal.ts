import { PermissionDeniedError, ROLE_MAX_DISCOUNT_BP, ROLE_PERMISSIONS } from './permissions.js';
import type { Actor, Permission, RoleName } from './permissions.js';

/**
 * What the server knows about whoever is making a request.
 *
 * Every field here was read from persistence after a session was verified.
 * Nothing in it came from the request body, a query string, a header or a
 * browser store — which is the whole point of the type existing: a route
 * handler that wants to know who is calling has exactly one place to look, and
 * that place cannot be written to from outside.
 *
 * It carries roles in the plural because a person can be both a manager and a
 * cashier. The existing `Actor` contract takes one role, so `toActor` collapses
 * the set at the boundary rather than forking the authorization model.
 */
export interface AuthenticatedPrincipal {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly RoleName[];
  readonly permissions: readonly Permission[];
  /** Basis points, derived from the roles held. Never sent by the client. */
  readonly maxDiscountBasisPoints: bigint;
  readonly branchId: string | null;
}

/**
 * Seniority, used only to pick which single role represents a multi-role user
 * in the existing one-role `Actor` contract.
 *
 * Permissions are unioned rather than ranked — holding two roles grants what
 * either grants — so this ordering never removes a capability. It exists
 * because the discount ceiling and the legacy `role` field are single-valued.
 */
export const ROLE_RANK: Readonly<Record<RoleName, number>> = {
  cashier: 1,
  manager: 2,
  admin: 3,
  owner: 4,
};

export function primaryRole(roles: readonly RoleName[]): RoleName | null {
  let best: RoleName | null = null;
  for (const role of roles) {
    if (best === null || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  return best;
}

/**
 * The ceiling a user may discount to, in basis points.
 *
 * The maximum across the roles held, not the sum and not the first: a manager
 * who is also a cashier does not lose the manager's authority, and two roles
 * do not add up to more than either grants.
 */
export function maxDiscountForRoles(roles: readonly RoleName[]): bigint {
  let ceiling = 0n;
  for (const role of roles) {
    const limit = ROLE_MAX_DISCOUNT_BP[role];
    if (limit > ceiling) ceiling = limit;
  }
  return ceiling;
}

/** The union of what every role held grants. */
export function permissionsForRoles(roles: readonly RoleName[]): readonly Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return [...granted];
}

/** Adapt to the existing single-role contract used by the sale path. */
export function toActor(principal: AuthenticatedPrincipal): Actor {
  const role = primaryRole(principal.roles);
  if (role === null) {
    // A principal with no role can still authenticate; it just cannot act.
    // Falling back to the least-privileged role would silently grant the
    // cashier's permissions to someone an administrator has not yet placed.
    throw new PrincipalWithoutRoleError(principal.userId);
  }
  return {
    userId: principal.userId,
    tenantId: principal.tenantId,
    role,
    permissions: principal.permissions,
    branchId: principal.branchId,
  };
}

export class PrincipalWithoutRoleError extends Error {
  public override readonly name = 'PrincipalWithoutRoleError';

  public constructor(userId: string) {
    super(`User ${userId} holds no role in this tenant.`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function principalCan(principal: AuthenticatedPrincipal, permission: Permission): boolean {
  return principal.permissions.includes(permission);
}

/** Throws rather than returning false: forgetting to check a boolean is easy. */
export function requirePrincipalPermission(
  principal: AuthenticatedPrincipal,
  permission: Permission,
): void {
  if (!principalCan(principal, permission)) {
    throw new PermissionDeniedError(permission);
  }
}
