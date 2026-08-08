import { DomainError } from '../errors.js';

/**
 * Permissions, not roles, are what the server checks.
 *
 * Roles are a way to hand out sets of permissions to people; the authorisation
 * decision is always about a single named capability. That keeps "can this
 * actor do this thing" answerable in one place when the role list grows.
 */
export const PERMISSIONS = [
  'product.read',
  'product.write',
  'inventory.read',
  'inventory.adjust',
  'sale.create',
  'sale.discount',
  'sale.refund',
  'sale.void',
  'shift.open',
  'shift.close',
  'shift.cash-movement',
  'customer.read',
  'customer.write',
  'report.read',
  'settings.manage',
  'users.manage',
  'zatca.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type RoleName = 'owner' | 'admin' | 'manager' | 'cashier';

export class PermissionDeniedError extends DomainError {
  public override readonly name = 'PermissionDeniedError';
  public readonly permission: Permission;

  public constructor(permission: Permission) {
    super(`Permission denied: ${permission}`);
    this.permission = permission;
  }
}

const CASHIER: readonly Permission[] = [
  'product.read',
  'inventory.read',
  'sale.create',
  'shift.open',
  'shift.close',
  'customer.read',
  'customer.write',
];

const MANAGER: readonly Permission[] = [
  ...CASHIER,
  'sale.discount',
  'sale.refund',
  'sale.void',
  'shift.cash-movement',
  'inventory.adjust',
  'product.write',
  'report.read',
];

const ADMIN: readonly Permission[] = [
  ...MANAGER,
  'settings.manage',
  'users.manage',
  'zatca.manage',
];

export const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = {
  cashier: CASHIER,
  manager: MANAGER,
  admin: ADMIN,
  owner: PERMISSIONS,
};

/**
 * Discount ceiling per role, in basis points of the undiscounted cart.
 *
 * A cashier gets none: granting a discount is a management decision, and the
 * commonest shrinkage pattern in retail is a cashier discounting for friends.
 */
export const ROLE_MAX_DISCOUNT_BP: Readonly<Record<RoleName, bigint>> = {
  cashier: 0n,
  manager: 2_000n,
  admin: 5_000n,
  owner: 10_000n,
};

export interface Actor {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: RoleName;
  readonly permissions: readonly Permission[];
  readonly branchId: string | null;
}

export function permissionsForRole(role: RoleName): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function can(actor: Actor, permission: Permission): boolean {
  return actor.permissions.includes(permission);
}

/** Throws rather than returning false: forgetting to check a boolean is easy. */
export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new PermissionDeniedError(permission);
  }
}

export function maxDiscountFor(actor: Actor): bigint {
  return ROLE_MAX_DISCOUNT_BP[actor.role];
}
