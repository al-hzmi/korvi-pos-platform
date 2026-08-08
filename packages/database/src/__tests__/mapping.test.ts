import { describe, expect, it } from 'vitest';
import { tenantId } from '@korvi/domain';
import {
  iso,
  isoOrNull,
  minor,
  minorOrNull,
  oneOf,
  rate,
  scoped,
  tenantParam,
} from '../repositories/mapping.js';
import { bucketId } from '../repositories/sale-repository.js';
import { DatabaseError } from '../errors.js';
import type { TenantScope } from '@korvi/domain';

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const scope: TenantScope = { tenantId: tenantId(TENANT) };

describe('the mapping boundary', () => {
  it('carries money out as a string, not a number', () => {
    // 9007199254740993 halalas is one above Number.MAX_SAFE_INTEGER; as a
    // number it would silently become an even value.
    expect(minor(9_007_199_254_740_993n)).toBe('9007199254740993');
    expect(minor(-1500n)).toBe('-1500');
    expect(minorOrNull(null)).toBeNull();
    expect(minorOrNull(0n)).toBe('0');
  });

  it('carries time out as ISO 8601 in UTC', () => {
    expect(iso(new Date('2026-08-08T10:00:00.000Z'))).toBe('2026-08-08T10:00:00.000Z');
    expect(isoOrNull(null)).toBeNull();
  });

  it('narrows a rate column into the branded type', () => {
    expect(rate(1500)).toBe(1500n);
  });

  it('rejects a rate column outside 0..10000 rather than printing it', () => {
    expect(() => rate(10_001)).toThrow();
  });

  it('narrows a known status column', () => {
    expect(oneOf(['open', 'closed'] as const, 'closed', 'shifts.status')).toBe('closed');
  });

  it('throws on a status column it has never heard of', () => {
    // Defaulting would take the wrong branch of a switch, silently.
    expect(() => oneOf(['cash', 'card'] as const, 'crypto', 'tenders.kind')).toThrow(DatabaseError);
  });

  it('accepts a row that belongs to the scope', () => {
    expect(scoped(scope, TENANT)).toBe(TENANT);
  });

  it('refuses a row that does not', () => {
    expect(() => scoped(scope, '018f3a1c-9b2e-7c4d-8e5f-ffffffffffff')).toThrow(/another tenant/i);
  });

  it('hands a query the scope tenant and nothing else', () => {
    expect(tenantParam(scope)).toBe(TENANT);
  });
});

describe('tax bucket identity', () => {
  const invoice = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';

  it('derives a stable id from the invoice, so a replay cannot duplicate buckets', () => {
    expect(bucketId(invoice, 0)).toBe(bucketId(invoice, 0));
    expect(bucketId(invoice, 0)).not.toBe(bucketId(invoice, 1));
  });

  it('keeps the derived id a syntactically valid UUID', () => {
    expect(bucketId(invoice, 15)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('refuses an invoice with more tax buckets than a real invoice has', () => {
    expect(() => bucketId(invoice, 300)).toThrow(DatabaseError);
  });
});
