import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(
    here,
    '../../prisma/migrations/20260914115000_platform_support_notes/migration.sql',
  ),
  'utf8',
);

function policyBody(name: string): string {
  const marker = `CREATE POLICY "${name}" ON "platform_support_notes"`;
  const start = migration.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return migration.slice(start, migration.indexOf(';', start));
}

describe('platform support-note storage boundary', () => {
  it('is FORCE-RLS protected and tenant-linked without joining the merchant ORM', () => {
    expect(migration).toContain('CREATE TABLE "platform_support_notes"');
    expect(migration).toContain(
      'ALTER TABLE "platform_support_notes" ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE "platform_support_notes" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")',
    );
  });

  it('admits reads only through the authenticated control-plane setting', () => {
    const body = policyBody('platform_support_notes_control_plane_read');
    expect(body).toContain('FOR SELECT');
    expect(body).toContain('current_control_plane_actor() IS NOT NULL');
    expect(body).not.toContain('current_tenant_id()');
    expect(body).not.toContain('WITH CHECK');
  });

  it('binds inserts to the authenticated actor and has no mutation policy', () => {
    const body = policyBody('platform_support_notes_control_plane_insert');
    expect(body).toContain('FOR INSERT');
    expect(body).toContain('WITH CHECK');
    expect(body).toContain('"actorRef" = current_control_plane_actor()');
    expect(migration).not.toMatch(/CREATE POLICY[^;]+FOR UPDATE/s);
    expect(migration).not.toMatch(/CREATE POLICY[^;]+FOR DELETE/s);
  });

  it('has a tenant-scoped idempotency key and bounded note columns', () => {
    expect(migration).toContain(
      '"platform_support_notes_tenantId_operationId_key"',
    );
    expect(migration).toContain('"operationId" VARCHAR(120) NOT NULL');
    expect(migration).toContain('"requestHash" CHAR(64) NOT NULL');
    expect(migration).toContain('"actorRef" VARCHAR(120) NOT NULL');
    expect(migration).toContain('"body" VARCHAR(4000) NOT NULL');
  });
});
