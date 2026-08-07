import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static verification of the tenancy boundary.
 *
 * These assertions run without a database on purpose. A live-Postgres test
 * proving cross-tenant reads are blocked belongs in Phase 1 integration; what
 * belongs *here* is the check that nobody adds a tenant-owned table without
 * protecting it — a review-time mistake this catches on every push, for free.
 *
 * The migration SQL is parsed rather than trusted, so the guarantee comes from
 * what will actually be applied to the database.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(here, '../../prisma/migrations/00000000000000_rls_foundation/migration.sql'),
  'utf8',
);
const schema = readFileSync(join(here, '../../prisma/schema.prisma'), 'utf8');

/** Tables holding tenant-owned rows. Adding one here without a policy fails. */
const TENANT_OWNED = ['tenants', 'products'];

/** The single documented exception. See ADR-0004. */
const GLOBAL_TABLES = ['global_catalog_items'];

describe('row-level security', () => {
  it.each(TENANT_OWNED)('enables RLS on %s', (table) => {
    expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  });

  it.each(TENANT_OWNED)('forces RLS on %s so the table owner cannot bypass it', (table) => {
    // Without FORCE, the owning role ignores every policy — and the
    // application role is very often the owner.
    expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  });

  it.each(TENANT_OWNED)('defines an isolation policy for %s', (table) => {
    expect(migration).toMatch(new RegExp(`CREATE POLICY "\\w+" ON "${table}"`));
  });

  it('gives every policy both USING and WITH CHECK', () => {
    // USING alone governs reads. Without WITH CHECK a caller could UPDATE a
    // visible row and reassign it to another tenant.
    const policies = migration.split('CREATE POLICY').slice(1);
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      const body = policy.split(';')[0] ?? '';
      expect(body).toContain('USING');
      expect(body).toContain('WITH CHECK');
      expect(body).toContain('current_tenant_id()');
    }
  });

  it('resolves tenant context from a session setting, not a literal', () => {
    expect(migration).toContain("current_setting('app.tenant_id', TRUE)");
  });

  it('marks current_tenant_id STABLE rather than IMMUTABLE', () => {
    // IMMUTABLE would let the planner cache one tenant's value into a plan
    // reused for another.
    expect(migration).toMatch(/current_tenant_id\(\)[\s\S]*?LANGUAGE SQL STABLE/);
  });

  it.each(GLOBAL_TABLES)('leaves %s outside RLS deliberately', (table) => {
    expect(migration).not.toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    // and says why, so the omission cannot be mistaken for an oversight
    expect(migration).toContain('ADR-0004');
  });
});

describe('schema invariants', () => {
  it('indexes tenantId first on every tenant-scoped index', () => {
    for (const match of schema.matchAll(/@@(?:index|unique)\(\[([^\]]+)\]/g)) {
      const columns = (match[1] ?? '').split(',').map((column) => column.trim());
      if (columns.includes('tenantId')) {
        expect(columns[0]).toBe('tenantId');
      }
    }
  });

  it('stores money as BigInt, never a float', () => {
    expect(schema).toMatch(/priceMinor\s+BigInt/);
    expect(schema).not.toMatch(/priceMinor\s+(Float|Decimal)/);
  });

  it('constrains the VAT rate at the column as well as in the domain', () => {
    expect(migration).toContain('products_vat_basis_points_range');
    expect(migration).toContain('"vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000');
  });

  it('rejects negative money at the column', () => {
    expect(migration).toContain('"priceMinor" >= 0');
  });
});

describe('tenant context helper', () => {
  it('uses SET LOCAL semantics rather than a session-wide SET', async () => {
    // A plain SET survives into the next request on a pooled connection and
    // leaks one tenant's context into another's query.
    const source = readFileSync(join(here, '../tenant-context.ts'), 'utf8');
    expect(source).toContain('set_config');
    expect(source).toContain('TRUE'); // the is_local argument
    expect(source).not.toMatch(/\$executeRaw`\s*SET\s+app\.tenant_id/i);
  });

  it('runs inside a transaction, so the context cannot outlive the request', () => {
    const source = readFileSync(join(here, '../tenant-context.ts'), 'utf8');
    expect(source).toContain('$transaction');
  });
});
