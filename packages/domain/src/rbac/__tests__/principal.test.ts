import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_MAX_DISCOUNT_BP, ROLE_PERMISSIONS } from '../permissions.js';
import {
  PrincipalWithoutRoleError,
  maxDiscountForRoles,
  permissionsForRoles,
  primaryRole,
  principalCan,
  requirePrincipalPermission,
  toActor,
} from '../principal.js';
import type { AuthenticatedPrincipal } from '../principal.js';

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    tenantId: '018f3a1c-9b2e-7c4d-8e5f-00000000000a',
    tenantSlug: 'korvi',
    userId: '018f3a1c-9b2e-7c4d-8e5f-0000000000a1',
    sessionId: '018f3a1c-9b2e-7c4d-8e5f-0000000000a2',
    email: 'sara@korvi.test',
    displayName: 'سارة',
    roles: ['cashier'],
    permissions: [...ROLE_PERMISSIONS.cashier],
    maxDiscountBasisPoints: 0n,
    branchId: null,
    ...overrides,
  };
}

describe('roles held in combination', () => {
  it('picks the most senior role for the single-role contract', () => {
    expect(primaryRole(['cashier', 'manager'])).toBe('manager');
    expect(primaryRole(['admin', 'cashier', 'owner'])).toBe('owner');
    expect(primaryRole([])).toBeNull();
  });

  it('grants the union of what the roles grant, never the intersection', () => {
    const granted = permissionsForRoles(['cashier', 'manager']);
    for (const permission of ROLE_PERMISSIONS.manager) {
      expect(granted).toContain(permission);
    }
    expect(granted).toContain('sale.create');
  });

  it('takes the highest discount ceiling, not the sum', () => {
    // Two roles do not add up to more authority than either grants.
    expect(maxDiscountForRoles(['cashier', 'manager'])).toBe(ROLE_MAX_DISCOUNT_BP.manager);
    expect(maxDiscountForRoles(['manager', 'admin'])).toBe(ROLE_MAX_DISCOUNT_BP.admin);
    expect(maxDiscountForRoles([])).toBe(0n);
  });

  it('gives a cashier no discount authority at all', () => {
    expect(maxDiscountForRoles(['cashier'])).toBe(0n);
  });
});

describe('the principal as an actor', () => {
  it('adapts to the existing single-role Actor used by the sale path', () => {
    const actor = toActor(principal({ roles: ['cashier', 'manager'] }));
    expect(actor.role).toBe('manager');
    expect(actor.userId).toBe('018f3a1c-9b2e-7c4d-8e5f-0000000000a1');
  });

  it('refuses to invent a role for someone who has none', () => {
    // Falling back to the least-privileged role would silently grant a
    // cashier's permissions to someone nobody has placed yet.
    expect(() => toActor(principal({ roles: [] }))).toThrow(PrincipalWithoutRoleError);
  });

  it('answers permission questions from the verified set only', () => {
    const cashier = principal();
    expect(principalCan(cashier, 'sale.create')).toBe(true);
    expect(principalCan(cashier, 'sale.discount')).toBe(false);
    expect(() => requirePrincipalPermission(cashier, 'sale.discount')).toThrow(/Permission denied/);
  });

  it('covers every permission in the catalogue with the owner role', () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
  });
});
