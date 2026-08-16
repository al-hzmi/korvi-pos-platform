import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PermissionDeniedError,
  ROLE_MAX_DISCOUNT_BP,
  ROLE_PERMISSIONS,
  can,
  maxDiscountFor,
  permissionsForRole,
  requirePermission,
} from '../permissions.js';
import type { Actor, Permission, RoleName } from '../permissions.js';

const ROLES: readonly RoleName[] = ['cashier', 'manager', 'admin', 'owner'];

const actorFor = (role: RoleName): Actor => ({
  userId: `user-${role}`,
  tenantId: 'tenant-1',
  role,
  permissions: permissionsForRole(role),
  branchId: 'branch-1',
});

describe('permission catalogue', () => {
  it('lists eighteen distinct permissions', () => {
    // Eighteen since Strike 5A added `inventory.transfer`. Moving stock between
    // branches is its own authority: it changes two branches' books at once,
    // and a merchant may want to grant it separately from writing stock off.
    expect(PERMISSIONS).toHaveLength(18);
    expect(new Set(PERMISSIONS).size).toBe(18);
  });

  it('grants the owner every permission', () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
  });

  it.each(ROLES)('gives %s only permissions from the catalogue', (role) => {
    for (const permission of ROLE_PERMISSIONS[role]) {
      expect(PERMISSIONS).toContain(permission);
    }
  });
});

describe('least privilege', () => {
  it('nests the roles: cashier subset of manager subset of admin subset of owner', () => {
    const subset = (a: readonly Permission[], b: readonly Permission[]): boolean =>
      a.every((permission) => b.includes(permission));

    expect(subset(ROLE_PERMISSIONS.cashier, ROLE_PERMISSIONS.manager)).toBe(true);
    expect(subset(ROLE_PERMISSIONS.manager, ROLE_PERMISSIONS.admin)).toBe(true);
    expect(subset(ROLE_PERMISSIONS.admin, ROLE_PERMISSIONS.owner)).toBe(true);
  });

  it('keeps a cashier out of every administrative capability', () => {
    const cashier = actorFor('cashier');
    for (const forbidden of [
      'settings.manage',
      'users.manage',
      'zatca.manage',
      'sale.discount',
      'sale.refund',
      'sale.void',
      'inventory.adjust',
      'product.write',
      'report.read',
      'shift.cash-movement',
    ] as const) {
      expect(can(cashier, forbidden), forbidden).toBe(false);
      expect(() => requirePermission(cashier, forbidden)).toThrow(PermissionDeniedError);
    }
  });

  it('lets a cashier do the cashier job', () => {
    const cashier = actorFor('cashier');
    for (const allowed of [
      'product.read',
      'inventory.read',
      'sale.create',
      'shift.open',
      'shift.close',
      'customer.read',
      'customer.write',
    ] as const) {
      expect(can(cashier, allowed), allowed).toBe(true);
      expect(() => requirePermission(cashier, allowed)).not.toThrow();
    }
  });

  it('keeps a manager out of settings and user administration', () => {
    const manager = actorFor('manager');
    expect(can(manager, 'settings.manage')).toBe(false);
    expect(can(manager, 'users.manage')).toBe(false);
    expect(can(manager, 'zatca.manage')).toBe(false);
    expect(can(manager, 'sale.refund')).toBe(true);
  });

  it('gives an admin everything except what only an owner holds', () => {
    const admin = actorFor('admin');
    expect(can(admin, 'settings.manage')).toBe(true);
    expect(can(admin, 'users.manage')).toBe(true);
    expect(ROLE_PERMISSIONS.admin.length).toBeLessThanOrEqual(PERMISSIONS.length);
  });

  it('reports the denied permission on the error', () => {
    try {
      requirePermission(actorFor('cashier'), 'users.manage');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedError);
      expect((error as PermissionDeniedError).permission).toBe('users.manage');
    }
  });

  it('does not grant a permission absent from the actor even if the role would', () => {
    // Authorisation reads the actor's own list, so a narrowed session stays
    // narrowed.
    const narrowed: Actor = { ...actorFor('owner'), permissions: ['product.read'] };
    expect(can(narrowed, 'users.manage')).toBe(false);
  });
});

describe('discount ceilings', () => {
  it('gives a cashier no discount authority at all', () => {
    expect(ROLE_MAX_DISCOUNT_BP.cashier).toBe(0n);
    expect(maxDiscountFor(actorFor('cashier'))).toBe(0n);
  });

  it('increases monotonically with authority', () => {
    expect(ROLE_MAX_DISCOUNT_BP.cashier).toBeLessThan(ROLE_MAX_DISCOUNT_BP.manager);
    expect(ROLE_MAX_DISCOUNT_BP.manager).toBeLessThan(ROLE_MAX_DISCOUNT_BP.admin);
    expect(ROLE_MAX_DISCOUNT_BP.admin).toBeLessThan(ROLE_MAX_DISCOUNT_BP.owner);
  });

  it('never exceeds one hundred percent', () => {
    for (const role of ROLES) {
      expect(ROLE_MAX_DISCOUNT_BP[role]).toBeLessThanOrEqual(10_000n);
    }
  });
});
