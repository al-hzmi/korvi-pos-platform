import { describe, expect, it } from 'vitest';
import { assertDatabaseEvidence, readDeploymentManifest } from '../staging/preflight.js';
import type { DatabaseEvidence, DeploymentManifest } from '../staging/preflight.js';

const manifest: DeploymentManifest = {
  migrations: [{ name: 'first', checksum: 'original-sha256' }],
  tables: ['tenants', 'permissions'],
};

function valid(): DatabaseEvidence {
  return {
    major: 17,
    unsafeRole: false,
    inheritedRoles: 0,
    tenantContext: '',
    loginContext: '',
    tables: [
      { name: 'tenants', enabled: true, forced: true, policies: 1 },
      { name: 'permissions', enabled: false, forced: false, policies: 0 },
      { name: '_prisma_migrations', enabled: false, forced: false, policies: 0 },
    ],
    migrations: [{ name: 'first', checksum: 'original-sha256', complete: true }],
  };
}

describe('staging database refusal before serving traffic', () => {
  it('accepts a restricted role with the matching ledger and protected tenant tables', () => {
    expect(() => assertDatabaseEvidence(valid(), manifest)).not.toThrow();
  });

  it.each([
    { major: 18 },
    { unsafeRole: true },
    { inheritedRoles: 1 },
    { tenantContext: 'an-old-tenant' },
    { loginContext: 'an-old-login' },
  ])('refuses unsafe connection facts %j', (change) => {
    expect(() => assertDatabaseEvidence({ ...valid(), ...change }, manifest)).toThrow();
  });

  it.each([
    [],
    [{ name: 'first', checksum: 'edited-file', complete: true }],
    [{ name: 'first', checksum: 'original-sha256', complete: false }],
    [{ name: 'unexpected', checksum: 'original-sha256', complete: true }],
    [
      { name: 'first', checksum: 'original-sha256', complete: true },
      { name: 'first', checksum: 'original-sha256', complete: true },
    ],
  ])('refuses a stale, edited, incomplete or duplicate migration ledger', (...migrations) => {
    expect(() => assertDatabaseEvidence({ ...valid(), migrations }, manifest)).toThrow(
      'Database migrations do not match this deployment.',
    );
  });

  it.each(['enabled', 'forced', 'policies'] as const)('refuses missing %s protection', (field) => {
    const tables = valid().tables.map((table) =>
      table.name === 'tenants' ? { ...table, [field]: field === 'policies' ? 0 : false } : table,
    );
    expect(() => assertDatabaseEvidence({ ...valid(), tables }, manifest)).toThrow(/RLS/);
  });

  it('refuses a missing table even when the migration ledger claims success', () => {
    const tables = valid().tables.filter((table) => table.name !== 'tenants');
    expect(() => assertDatabaseEvidence({ ...valid(), tables }, manifest)).toThrow(/tables/);
  });

  it('refuses an unrelated table in the dedicated database', () => {
    const tables = [
      ...valid().tables,
      { name: 'unexpected', enabled: false, forced: false, policies: 0 },
    ];
    expect(() => assertDatabaseEvidence({ ...valid(), tables }, manifest)).toThrow(/tables/);
  });

  it('refuses an empty deployment manifest', () => {
    expect(() => assertDatabaseEvidence(valid(), { tables: [], migrations: [] })).toThrow(/empty/);
  });

  it('loads the actual checked-in migration bytes and schema table names', async () => {
    const expected = await readDeploymentManifest();
    expect(expected.migrations).toHaveLength(16);
    expect(
      expected.migrations.every((migration) => /^[a-f0-9]{64}$/.test(migration.checksum)),
    ).toBe(true);
    expect(expected.tables).toContain('inventory_cost_balances');
    expect(expected.tables).toContain('tenant_owner_bootstrap_invitations');
    expect(expected.tables).toContain('zatca_csid_provisioning_attempts');
    expect(expected.tables).toContain('zatca_fatoora_credentials');
    expect(expected.tables).toContain('zatca_invoice_submissions');
    expect(new Set(expected.tables).size).toBe(expected.tables.length);
  });
});
