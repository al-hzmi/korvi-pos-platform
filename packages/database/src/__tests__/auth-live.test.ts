import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantId as brandTenantId } from '@korvi/domain';
import { createPrismaClient } from '../client.js';
import { withLoginSlug, withTenant, withoutTenant } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

/**
 * The Strike 2B tenancy surface, against a real PostgreSQL server.
 *
 * Two claims that only a live database can settle:
 *
 *   the login-resolution policy reads exactly one tenant and writes nothing,
 *   and sessions are isolated as strictly as every other tenant-owned table.
 *
 * Opt-in, same as the Strike 2A live suite. Point KORVI_TEST_DATABASE_URL at a
 * throwaway database with all three migrations applied, connected as the
 * application role — not a superuser, which bypasses RLS and would make every
 * assertion here pass for the wrong reason.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const here = dirname(fileURLToPath(import.meta.url));

const A = {
  tenant: '018f0b00-0000-7000-8000-00000000000a',
  slug: 'auth-live-a',
  user: '018f0b00-0000-7000-8000-0000000000a1',
  session: '018f0b00-0000-7000-8000-0000000000a2',
} as const;

const B = {
  tenant: '018f0b00-0000-7000-8000-00000000000b',
  slug: 'auth-live-b',
  user: '018f0b00-0000-7000-8000-0000000000b1',
  session: '018f0b00-0000-7000-8000-0000000000b2',
} as const;

const SCRATCH = '018f0b00-0000-7000-8000-0000000000c1';
const HOUR = 3_600_000;

describe.skipIf(url === '')('authentication tenancy, live', () => {
  let prisma: PrismaClient;

  async function refused(work: () => Promise<unknown>): Promise<string> {
    try {
      await work();
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function seed(t: Readonly<Record<keyof typeof A, string>>): Promise<void> {
    const scope = { tenantId: brandTenantId(t.tenant) };
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        // Historical fixture: a tenant that already trades. The production
        // default is `provisioning` (ADR-0018).
        data: {
          id: t.tenant,
          name: `Tenant ${t.slug}`,
          slug: t.slug,
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: t.user,
          tenantId: t.tenant,
          email: `cashier@${t.slug}.test`,
          displayName: 'كاشير',
          updatedAt: new Date(),
        },
      });
      await tx.session.create({
        data: {
          id: t.session,
          tenantId: t.tenant,
          userId: t.user,
          tokenHash: `hash-${t.slug}`,
          authVersion: 1,
          expiresAt: new Date(Date.now() + HOUR),
          lastSeenAt: new Date(),
        },
      });
    });
  }

  async function remove(tenant: string): Promise<void> {
    await withTenant(prisma, brandTenantId(tenant), async (tx) => {
      await tx.tenant.deleteMany({ where: { id: tenant } });
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove(A.tenant);
    await remove(B.tenant);
    await remove(SCRATCH);
    await seed(A);
    await seed(B);
  });

  afterAll(async () => {
    await remove(A.tenant);
    await remove(B.tenant);
    await remove(SCRATCH);
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Login resolution
  // -------------------------------------------------------------------------

  it('resolves exactly the tenant whose slug was submitted', async () => {
    const rows = await withLoginSlug(prisma, A.slug, async (tx) =>
      tx.tenant.findMany({ select: { id: true, slug: true } }),
    );
    expect(rows).toEqual([{ id: A.tenant, slug: A.slug }]);
  });

  it('returns nothing for a slug that does not exist', async () => {
    const rows = await withLoginSlug(prisma, 'no-such-shop', async (tx) => tx.tenant.findMany());
    expect(rows).toEqual([]);
  });

  it('cannot list tenants, however the query is written', async () => {
    // The policy is an equality on one setting. An unfiltered findMany is the
    // most generous query available and still returns one row.
    const rows = await withLoginSlug(prisma, A.slug, async (tx) => tx.tenant.findMany({}));
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.id).toBe(A.tenant);
  });

  it('cannot see users, products or sessions from the login context', async () => {
    // Every other table keys its policy on app.tenant_id, which is empty here.
    const seen = await withLoginSlug(prisma, A.slug, async (tx) => ({
      users: await tx.user.count(),
      products: await tx.product.count(),
      sessions: await tx.session.count(),
      memberships: await tx.tenantMembership.count(),
    }));
    expect(seen).toEqual({ users: 0, products: 0, sessions: 0, memberships: 0 });
  });

  it('cannot insert a tenant through the login context', async () => {
    const message = await refused(() =>
      withLoginSlug(prisma, A.slug, async (tx) =>
        tx.tenant.create({
          data: { id: SCRATCH, name: 'Smuggled', slug: 'smuggled', updatedAt: new Date() },
        }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('cannot update the tenant it just resolved', async () => {
    const changed = await withLoginSlug(prisma, A.slug, async (tx) =>
      tx.tenant.updateMany({ where: { id: A.tenant }, data: { name: 'Renamed' } }),
    );
    // The isolation policy governs UPDATE, and app.tenant_id is empty, so the
    // row is not visible for writing. Zero rows, not an error — which is the
    // deny-by-default shape RLS gives an UPDATE.
    expect(changed.count).toBe(0);

    const name = await withLoginSlug(prisma, A.slug, async (tx) =>
      tx.tenant.findMany({ select: { name: true } }),
    );
    expect(name.at(0)?.name).toBe(`Tenant ${A.slug}`);
  });

  it('cannot delete the tenant it just resolved', async () => {
    const removed = await withLoginSlug(prisma, A.slug, async (tx) =>
      tx.tenant.deleteMany({ where: { id: A.tenant } }),
    );
    expect(removed.count).toBe(0);
  });

  it('leaves the ordinary isolation policy exactly as it was', async () => {
    // The login policy is additive and SELECT-only. With no context at all,
    // tenants is still invisible.
    const rows = await withoutTenant(prisma, async (tx) => tx.tenant.findMany());
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  it('shows a tenant only its own sessions', async () => {
    const rows = await withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
      tx.session.findMany({ select: { id: true } }),
    );
    expect(rows.map((row) => row.id)).toEqual([A.session]);
  });

  it('returns nothing for another tenant’s session, asked for by primary key', async () => {
    const rows = await withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
      tx.session.findMany({ where: { id: B.session } }),
    );
    expect(rows).toEqual([]);
  });

  it('finds no session at all with no tenant context', async () => {
    const rows = await withoutTenant(prisma, async (tx) => tx.session.findMany());
    expect(rows).toEqual([]);
  });

  it('refuses a session minted for another tenant’s user', async () => {
    // The composite key does this, not RLS: the row would carry tenant A, and
    // (A, B.user) is not a pair that exists in users.
    const message = await refused(() =>
      withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
        tx.session.create({
          data: {
            id: SCRATCH,
            tenantId: A.tenant,
            userId: B.user,
            tokenHash: 'hash-smuggled',
            authVersion: 1,
            expiresAt: new Date(Date.now() + HOUR),
            lastSeenAt: new Date(),
          },
        }),
      ),
    );
    // Prisma phrases the driver error its own way, so the assertion is on
    // the constraint name — which is the part that identifies the guard.
    expect(message).toMatch(/sessions_tenantId_userId_fkey/);
  });

  it('refuses a session row that names another tenant outright', async () => {
    const message = await refused(() =>
      withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
        tx.session.create({
          data: {
            id: SCRATCH,
            tenantId: B.tenant,
            userId: B.user,
            tokenHash: 'hash-smuggled-2',
            authVersion: 1,
            expiresAt: new Date(Date.now() + HOUR),
            lastSeenAt: new Date(),
          },
        }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses to repoint a session at another tenant’s user', async () => {
    const message = await refused(() =>
      withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
        tx.session.updateMany({ where: { id: A.session }, data: { userId: B.user } }),
      ),
    );
    // Prisma phrases the driver error its own way, so the assertion is on
    // the constraint name — which is the part that identifies the guard.
    expect(message).toMatch(/sessions_tenantId_userId_fkey/);
  });

  it('enables and forces RLS on the sessions table', async () => {
    const rows = await withoutTenant(
      prisma,
      async (tx) =>
        tx.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT c.relrowsecurity, c.relforcerowsecurity
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'sessions'`,
    );
    expect(rows.at(0)?.relrowsecurity).toBe(true);
    expect(rows.at(0)?.relforcerowsecurity).toBe(true);
  });

  it('has no drift between the migrations and the Prisma schema', async () => {
    // The Strike 2B migration is hand-written SQL, same as Strike 2A's. If
    // Prisma's model of it ever disagrees, the next `prisma migrate dev`
    // silently proposes to undo it.
    const output = execFileSync(
      'npx',
      [
        '--no-install',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
      ],
      { cwd: join(here, '../..'), env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
    );
    expect(output).toContain('No difference detected');
  }, 120_000);
});

describe.skipIf(url !== '')('authentication tenancy, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
