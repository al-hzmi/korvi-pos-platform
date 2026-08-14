import { describe, expect, it } from 'vitest';
import {
  ADMINISTRATIVE_AUTHORITY,
  MAX_ADMIN_CODE,
  MAX_ADMIN_NAME,
  MAX_RECEIPT_LINE,
  MERCHANT_ADMIN_EVENTS,
  MerchantAdminError,
  activationEvent,
  assertAdministrativeAuthorityRemains,
  countViableAdministrators,
  isViableAdministrator,
  normalizeAdminCode,
  normalizeAdminName,
  normalizeOptionalLine,
} from '../merchant-admin.js';
import { ROLE_PERMISSIONS } from '../../rbac/permissions.js';
import type { AdministrativeCandidate } from '../merchant-admin.js';

describe('administrative codes', () => {
  it('upper-cases and folds compatibility digits to one code', () => {
    expect(normalizeAdminCode(' br-1 ')).toBe('BR-1');
    expect(normalizeAdminCode('br-1')).toBe(normalizeAdminCode('BR-1'));
    // Arabic-Indic digits are the same code to the person who typed them and a
    // different byte string to a unique index. NFKC does not fold these, so
    // the fold is explicit — Korvi is Arabic-first and this is a Saudi keypad.
    expect(normalizeAdminCode('٠١')).toBe('01');
    expect(normalizeAdminCode('۰۱')).toBe('01');
    expect(normalizeAdminCode('٠١')).toBe(normalizeAdminCode('01'));
  });

  it('refuses anything that is not a code', () => {
    for (const bad of ['', '   ', '-A1', 'A B', 'A_1', 'مركز', 'A'.repeat(MAX_ADMIN_CODE + 1)]) {
      expect(() => normalizeAdminCode(bad), bad).toThrow(MerchantAdminError);
    }
    expect(normalizeAdminCode('A'.repeat(MAX_ADMIN_CODE))).toHaveLength(MAX_ADMIN_CODE);
  });
});

describe('administrative names', () => {
  it('trims and keeps Arabic intact', () => {
    expect(normalizeAdminName('  فرع العليا  ')).toBe('فرع العليا');
  });

  it('refuses an empty name and an over-long one rather than truncating', () => {
    expect(() => normalizeAdminName('   ')).toThrow(MerchantAdminError);
    const atLimit = 'ب'.repeat(MAX_ADMIN_NAME);
    expect(normalizeAdminName(atLimit)).toBe(atLimit);
    // Cutting a merchant's own name in half is a silent corruption of the
    // thing they typed; refusing it is a message they can act on.
    expect(() => normalizeAdminName('ب'.repeat(MAX_ADMIN_NAME + 1))).toThrow(MerchantAdminError);
  });
});

describe('optional lines', () => {
  it('tells "clear it" apart from "leave it alone"', () => {
    // null and an all-whitespace string both mean the merchant wants it gone.
    expect(normalizeOptionalLine(null)).toBeNull();
    expect(normalizeOptionalLine('   ')).toBeNull();
    expect(normalizeOptionalLine('  شكراً لزيارتكم ')).toBe('شكراً لزيارتكم');
  });

  it('refuses an over-long line', () => {
    expect(normalizeOptionalLine('x'.repeat(MAX_RECEIPT_LINE))).toHaveLength(MAX_RECEIPT_LINE);
    expect(() => normalizeOptionalLine('x'.repeat(MAX_RECEIPT_LINE + 1))).toThrow(
      MerchantAdminError,
    );
  });
});

describe('surviving administrative authority', () => {
  const viable = (userId: string): AdministrativeCandidate => ({
    userId,
    userActive: true,
    membershipActive: true,
  });

  it('is defined by a permission the roles actually grant', () => {
    expect(ADMINISTRATIVE_AUTHORITY).toBe('users.manage');
    // Not a role name. The rule has to keep working for a merchant who renames
    // their roles, and stop working for one whose owner role no longer grants
    // the permission.
    expect(ROLE_PERMISSIONS.owner).toContain(ADMINISTRATIVE_AUTHORITY);
    expect(ROLE_PERMISSIONS.admin).toContain(ADMINISTRATIVE_AUTHORITY);
    expect(ROLE_PERMISSIONS.manager).not.toContain(ADMINISTRATIVE_AUTHORITY);
    expect(ROLE_PERMISSIONS.cashier).not.toContain(ADMINISTRATIVE_AUTHORITY);
  });

  it('needs all three facts to count somebody', () => {
    expect(isViableAdministrator(viable('a'))).toBe(true);
    expect(isViableAdministrator({ ...viable('a'), userActive: false })).toBe(false);
    expect(isViableAdministrator({ ...viable('a'), membershipActive: false })).toBe(false);
  });

  it('counts people, not grants', () => {
    // One person holding two roles that both grant the permission arrives as
    // two rows and is still one administrator.
    expect(countViableAdministrators([viable('a'), viable('a')])).toBe(1);
    expect(countViableAdministrators([viable('a'), viable('b')])).toBe(2);
  });

  it('refuses a state with nobody left to administer the merchant', () => {
    expect(() => assertAdministrativeAuthorityRemains([viable('a')])).not.toThrow();
    expect(() => assertAdministrativeAuthorityRemains([])).toThrow(MerchantAdminError);
    // The dangerous shape: candidates exist, and not one of them can act.
    expect(() =>
      assertAdministrativeAuthorityRemains([
        { userId: 'a', userActive: false, membershipActive: true },
        { userId: 'b', userActive: true, membershipActive: false },
      ]),
    ).toThrow(MerchantAdminError);
  });
});

describe('audit vocabulary', () => {
  it('gives every administrative act its own name', () => {
    expect(new Set(MERCHANT_ADMIN_EVENTS).size).toBe(MERCHANT_ADMIN_EVENTS.length);
    // An audit trail whose rows all say "updated" answers no question.
    expect(MERCHANT_ADMIN_EVENTS).toContain('branch.deactivated');
    expect(MERCHANT_ADMIN_EVENTS).toContain('member.role-unassigned');
  });

  it('names activation by entity and direction', () => {
    expect(activationEvent('branch', true)).toBe('branch.activated');
    expect(activationEvent('branch', false)).toBe('branch.deactivated');
    expect(activationEvent('terminal', true)).toBe('terminal.activated');
    expect(activationEvent('terminal', false)).toBe('terminal.deactivated');
  });
});
