import { describe, expect, it } from 'vitest';
import { merchantLandingPath, prefersMerchantControl } from '../lib/merchant-landing';
import type { Principal } from '../lib/api-types';

function principal(
  roles: readonly string[],
  permissions: readonly string[],
  branchId: string | null = null,
): Principal {
  return {
    user: { id: 'user-1', email: 'user@example.test', displayName: 'User' },
    tenant: { id: 'tenant-1', slug: 'merchant-a' },
    session: { id: 'session-1' },
    roles,
    permissions,
    branchId,
  };
}

describe('merchant role landing', () => {
  it('lands a cashier in the explicit cashier surface', () => {
    const cashier = principal(
      ['cashier'],
      [
        'product.read',
        'inventory.read',
        'sale.create',
        'shift.open',
        'shift.close',
        'customer.read',
        'customer.write',
      ],
      'branch-a',
    );

    expect(prefersMerchantControl(cashier)).toBe(false);
    expect(merchantLandingPath(cashier)).toBe('/cashier');
  });

  it('lands manager, admin and owner authority in Merchant Control', () => {
    expect(merchantLandingPath(principal(['manager'], ['report.read']))).toBe('/control');
    expect(merchantLandingPath(principal(['admin'], ['settings.manage']))).toBe('/control');
    expect(merchantLandingPath(principal(['owner'], ['users.manage']))).toBe('/control');
  });

  it('uses effective permissions rather than trusting a role label', () => {
    expect(merchantLandingPath(principal(['owner'], ['sale.create']))).toBe('/cashier');
    expect(merchantLandingPath(principal(['custom-supervisor'], ['purchasing.read']))).toBe(
      '/control',
    );
  });

  it('does not require a branch before a management user can reach Merchant Control', () => {
    const ownerWithoutBranch = principal(['owner'], ['settings.manage', 'users.manage'], null);
    expect(merchantLandingPath(ownerWithoutBranch)).toBe('/control');
  });
});
