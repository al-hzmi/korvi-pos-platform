import { describe, expect, it } from 'vitest';
import { CrossTenantAccessError, assertSameTenant, tenantId } from '../persistence.js';
import { DomainError } from '../../errors.js';
import type { TenantScope } from '../persistence.js';

/**
 * The tenant assertion, exercised.
 *
 * No filesystem access here: the domain must stay isomorphic (ADR-0001), so
 * the tests that read the ports file as source live in @korvi/database.
 */

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const scope: TenantScope = { tenantId: tenantId(TENANT) };

describe('the tenant boundary in the ports', () => {
  it('accepts a row from the scope tenant', () => {
    expect(() => assertSameTenant(scope, TENANT)).not.toThrow();
  });

  it('throws rather than returning a row from another tenant', () => {
    // Returning null would hide a broken boundary; returning the row would
    // leak another merchant's data.
    expect(() => assertSameTenant(scope, '018f3a1c-9b2e-7c4d-8e5f-ffffffffffff')).toThrow(
      CrossTenantAccessError,
    );
  });

  it('compares the whole id, not a prefix', () => {
    expect(() => assertSameTenant(scope, `${TENANT}0`)).toThrow(CrossTenantAccessError);
    expect(() => assertSameTenant(scope, TENANT.slice(0, -1))).toThrow(CrossTenantAccessError);
  });

  it('is a DomainError, so a caller catching those catches this', () => {
    expect(new CrossTenantAccessError('x')).toBeInstanceOf(DomainError);
    expect(new CrossTenantAccessError('x').name).toBe('CrossTenantAccessError');
  });

  it('brands a tenant id without altering its value', () => {
    expect(tenantId(TENANT)).toBe(TENANT);
  });
});
