import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_MAX_DISCOUNT_BP, ROLE_PERMISSIONS } from '@korvi/domain';
import { DEFAULT_ROLES, PERMISSION_CATALOGUE } from '../provisioning/rbac.js';
import type { Permission, RoleName } from '@korvi/domain';

/**
 * The database's vocabulary and the domain's must be the same vocabulary.
 *
 * One half of that is enforced by the compiler: PERMISSION_CATALOGUE is typed
 * `Record<Permission, ...>`, so adding a permission to the domain and not
 * describing it here fails to build. This file enforces the other half —
 * nothing described here that the domain does not define — and states the
 * relationship in a way that fails loudly rather than drifting.
 */

describe('the permission catalogue', () => {
  it('describes exactly the permissions the domain defines', () => {
    expect(Object.keys(PERMISSION_CATALOGUE).sort()).toEqual([...PERMISSIONS].sort());
  });

  it('gives every permission an Arabic description, because the UI is Arabic-first', () => {
    for (const key of PERMISSIONS) {
      const described = PERMISSION_CATALOGUE[key];
      expect(described.ar.trim(), key).not.toBe('');
      expect(described.en.trim(), key).not.toBe('');
      // A description that is just the key helps nobody read a role screen.
      expect(described.ar).not.toBe(key);
    }
  });
});

describe('the default roles', () => {
  it('provisions exactly the roles the domain defines and no others', () => {
    const domainRoles = Object.keys(ROLE_PERMISSIONS).sort();
    expect(Object.keys(DEFAULT_ROLES).sort()).toEqual(domainRoles);
  });

  it('takes every discount ceiling from the domain rather than restating it', () => {
    // The ceiling lives in one place. A second copy here is how a cashier ends
    // up able to discount in the database and unable to in the code.
    for (const role of Object.keys(DEFAULT_ROLES) as RoleName[]) {
      const ceiling = ROLE_MAX_DISCOUNT_BP[role];
      expect(Number(ceiling)).toBeGreaterThanOrEqual(0);
      expect(Number(ceiling)).toBeLessThanOrEqual(10_000);
    }
    expect(ROLE_MAX_DISCOUNT_BP.cashier).toBe(0n);
  });

  it('grants each role only permissions that exist in the catalogue', () => {
    for (const role of Object.keys(DEFAULT_ROLES) as RoleName[]) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(permission satisfies Permission);
      }
    }
  });
});
