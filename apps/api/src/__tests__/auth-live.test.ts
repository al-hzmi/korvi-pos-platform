import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, tenantId as brandTenantId } from '@korvi/domain';
import {
  assignRole,
  createAuditRepository,
  createAuthRepository,
  createPrismaClient,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  withTenant,
} from '@korvi/database';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import type { AuthService } from '../auth/service.js';
import type { PrismaClient } from '@korvi/database';
import type { TenantScope } from '@korvi/domain';

/**
 * Login to principal, end to end, against a real PostgreSQL server.
 *
 * The unit suite proves the rules; this proves they survive contact with RLS,
 * the composite keys and the persisted role graph. It is the only place where
 * "permissions are derived from persistence" is a statement about persistence
 * rather than about a fake.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with all
 * three migrations applied, connected as the application role.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;

const A = {
  tenant: '018f0c00-0000-7000-8000-00000000000a',
  slug: 'flow-live-a',
  user: '018f0c00-0000-7000-8000-0000000000a1',
  membership: '018f0c00-0000-7000-8000-0000000000a2',
  email: 'sara@flow-live-a.test',
} as const;

const B = {
  tenant: '018f0c00-0000-7000-8000-00000000000b',
  slug: 'flow-live-b',
  user: '018f0c00-0000-7000-8000-0000000000b1',
  membership: '018f0c00-0000-7000-8000-0000000000b2',
  email: 'omar@flow-live-b.test',
} as const;

/** Suspension and lockout mutate tenant state, so they get their own tenants. */
const C = {
  tenant: '018f0c00-0000-7000-8000-00000000000c',
  slug: 'flow-live-c',
  user: '018f0c00-0000-7000-8000-0000000000c1',
  membership: '018f0c00-0000-7000-8000-0000000000c2',
  email: 'noura@flow-live-c.test',
} as const;

const D = {
  tenant: '018f0c00-0000-7000-8000-00000000000d',
  slug: 'flow-live-d',
  user: '018f0c00-0000-7000-8000-0000000000d1',
  membership: '018f0c00-0000-7000-8000-0000000000d2',
  email: 'khalid@flow-live-d.test',
} as const;

const PASSWORD = 'a-real-password-9!';

describe.skipIf(url === '')('authentication flow, live', () => {
  let prisma: PrismaClient;
  let service: AuthService;
  let repository: ReturnType<typeof createAuthRepository>;
  let clock: Date;

  const LOCKOUT = { threshold: 5, lockSeconds: 900 } as const;

  async function remove(tenant: string): Promise<void> {
    await withTenant(prisma, brandTenantId(tenant), async (tx) => {
      await tx.tenant.deleteMany({ where: { id: tenant } });
    });
  }

  async function seed(
    t: Readonly<Record<keyof typeof A, string>>,
    role: 'cashier' | 'manager',
  ): Promise<void> {
    const scope: TenantScope = { tenantId: brandTenantId(t.tenant) };
    const passwordHash = await hashPassword(PASSWORD, FAST);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        // Historical fixture: a tenant that already trades. The production
        // default is `provisioning` (ADR-0018).
        data: {
          id: t.tenant,
          name: t.slug,
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
          email: t.email,
          displayName: 'كاشير',
          passwordHash,
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: t.membership, tenantId: t.tenant, userId: t.user, updatedAt: new Date() },
      });
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, t.user, role);
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    clock = new Date('2026-08-10T08:00:00.000Z');

    await remove(A.tenant);
    await remove(B.tenant);
    await remove(C.tenant);
    await remove(D.tenant);
    await provisionPermissionCatalogue(prisma);
    await seed(A, 'manager');
    await seed(B, 'cashier');
    await seed(C, 'cashier');
    await seed(D, 'cashier');

    repository = createAuthRepository(prisma);
    service = createAuthService({
      repository,
      audit: createAuditRepository(prisma),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
      lockout: LOCKOUT,
      now: () => clock,
    });
  }, 90_000);

  afterAll(async () => {
    await remove(A.tenant);
    await remove(B.tenant);
    await remove(C.tenant);
    await remove(D.tenant);
    await prisma.$disconnect();
  });

  /**
   * Poke the status column directly, the way an operator's mistake would.
   *
   * The lifecycle constraints treat suspension state as all-or-nothing and tie
   * `activatedAt` to whether the tenant was ever admitted (ADR-0018), so this
   * fixture has to carry the columns the constraints require. It deliberately
   * does not go through the control plane: what is under test here is that
   * authentication reads the row, whatever put the row in that state.
   */
  async function setTenantStatus(tenant: string, status: string): Promise<void> {
    await withTenant(prisma, brandTenantId(tenant), async (tx) => {
      await tx.tenant.updateMany({
        where: { id: tenant },
        data: {
          status,
          activatedAt: status === 'provisioning' ? null : new Date(),
          suspendedAt: status === 'suspended' ? new Date() : null,
          suspensionReason: status === 'suspended' ? 'auth-live fixture' : null,
        },
      });
    });
  }

  async function userRow(t: Readonly<Record<keyof typeof A, string>>): Promise<{
    failedLoginCount: number;
    lockedUntil: Date | null;
    lastLoginAt: Date | null;
  }> {
    return withTenant(prisma, brandTenantId(t.tenant), async (tx) => {
      const rows = await tx.user.findMany({ where: { id: t.user, tenantId: t.tenant } });
      const row = rows.at(0);
      if (row === undefined) throw new Error('seeded user vanished');
      return {
        failedLoginCount: row.failedLoginCount,
        lockedUntil: row.lockedUntil,
        lastLoginAt: row.lastLoginAt,
      };
    });
  }

  function login(overrides: Partial<{ tenantSlug: string; email: string; password: string }> = {}) {
    return service.login({
      tenantSlug: overrides.tenantSlug ?? A.slug,
      email: overrides.email ?? A.email,
      password: overrides.password ?? PASSWORD,
      userAgent: 'vitest',
    });
  }

  it('authenticates against the real login-resolution policy', async () => {
    const result = await login();
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.principal.tenantId).toBe(A.tenant);
    expect(result.principal.tenantSlug).toBe(A.slug);
  });

  it('derives permissions from the persisted role graph, not from a constant', async () => {
    // UserRole -> Role -> RolePermission -> Permission, read back out of
    // PostgreSQL under this tenant's RLS context.
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    expect(result.principal.roles).toEqual(['manager']);
    expect([...result.principal.permissions].sort()).toEqual([...ROLE_PERMISSIONS.manager].sort());
    expect(result.principal.maxDiscountBasisPoints).toBe(2_000n);
  });

  it('gives the other tenant its own, smaller authority', async () => {
    const result = await service.login({
      tenantSlug: B.slug,
      email: B.email,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    if (result.outcome !== 'success') throw new Error('expected success');
    expect(result.principal.roles).toEqual(['cashier']);
    // A cashier may not discount, and the figure came from the database.
    expect(result.principal.maxDiscountBasisPoints).toBe(0n);
    expect(result.principal.permissions).not.toContain('sale.discount');
  });

  it('refuses a real password submitted against the wrong tenant', async () => {
    const result = await login({ tenantSlug: B.slug });
    expect(result.outcome).toBe('failure');
  });

  it.each([
    ['wrong password', { password: 'not-it' }],
    ['unknown email', { email: 'ghost@flow-live-a.test' }],
    ['unknown tenant', { tenantSlug: 'no-such-shop' }],
  ])('refuses a login with a %s', async (_label, overrides) => {
    const result = await login(overrides);
    expect(result.outcome).toBe('failure');
  });

  it('turns its own token back into the same principal', async () => {
    const login1 = await login();
    if (login1.outcome !== 'success') throw new Error('expected success');

    const verified = await service.authenticate(login1.token);
    expect(verified.outcome).toBe('success');
    if (verified.outcome !== 'success') return;
    expect(verified.principal.userId).toBe(A.user);
    expect(verified.principal.sessionId).toBe(login1.principal.sessionId);
  });

  it('does not authenticate into another tenant when the hint is rewritten', async () => {
    // Two independent reasons it fails: the hash covers the tenant segment, and
    // the lookup runs inside the hinted tenant's RLS context.
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    const moved = result.token.replace(A.tenant, B.tenant);
    expect(moved).not.toBe(result.token);
    const verified = await service.authenticate(moved);
    expect(verified.outcome === 'failure' && verified.reason).toBe('unknown-session');
  });

  it('stops accepting a revoked token', async () => {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    await expect(service.logout(result.token)).resolves.toBe(true);
    const verified = await service.authenticate(result.token);
    expect(verified.outcome === 'failure' && verified.reason).toBe('revoked');
  });

  it('stops accepting an expired token', async () => {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    const restore = clock;
    clock = new Date(restore.getTime() + 3600_000 + 1);
    const verified = await service.authenticate(result.token);
    clock = restore;
    expect(verified.outcome === 'failure' && verified.reason).toBe('expired');
  });

  it('stops accepting a token minted under an older authVersion', async () => {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    await withTenant(prisma, brandTenantId(A.tenant), async (tx) => {
      await tx.user.updateMany({
        where: { id: A.user, tenantId: A.tenant },
        data: { authVersion: { increment: 1 } },
      });
    });

    const verified = await service.authenticate(result.token);
    expect(verified.outcome === 'failure' && verified.reason).toBe('auth-version');

    await withTenant(prisma, brandTenantId(A.tenant), async (tx) => {
      await tx.user.updateMany({
        where: { id: A.user, tenantId: A.tenant },
        data: { authVersion: 1 },
      });
    });
  });

  it('stops an existing session the moment its tenant is suspended', async () => {
    // The session predates the suspension, and the token cannot be asked about
    // it — the tenant row can, and is, on every request.
    const result = await service.login({
      tenantSlug: C.slug,
      email: C.email,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    if (result.outcome !== 'success') throw new Error('expected success');
    await expect(service.authenticate(result.token)).resolves.toMatchObject({
      outcome: 'success',
    });

    await setTenantStatus(C.tenant, 'suspended');
    const suspended = await service.authenticate(result.token);
    expect(suspended.outcome === 'failure' && suspended.reason).toBe('tenant-inactive');

    // Not only suspension: a tenant that has been put back into provisioning
    // is not a tenant anybody may sell through either.
    await setTenantStatus(C.tenant, 'provisioning');
    const unadmitted = await service.authenticate(result.token);
    expect(unadmitted.outcome === 'failure' && unadmitted.reason).toBe('tenant-inactive');

    // Reactivating restores the session it never revoked, and nothing else.
    await setTenantStatus(C.tenant, 'active');
    await expect(service.authenticate(result.token)).resolves.toMatchObject({
      outcome: 'success',
    });

    await service.logout(result.token);
    await setTenantStatus(C.tenant, 'suspended');
    await setTenantStatus(C.tenant, 'active');
    const revoked = await service.authenticate(result.token);
    expect(revoked.outcome === 'failure' && revoked.reason).toBe('revoked');
  }, 30_000);

  it('locks after five sequential failures, counted by PostgreSQL', async () => {
    const scope = { tenantId: brandTenantId(D.tenant) };
    for (let attempt = 1; attempt <= LOCKOUT.threshold; attempt += 1) {
      const window = await repository.registerFailedLogin(
        scope,
        D.user,
        clock.toISOString(),
        LOCKOUT,
      );
      expect(window.failedLoginCount).toBe(attempt);
      expect(window.locked).toBe(attempt >= LOCKOUT.threshold);
    }

    const row = await userRow(D);
    expect(row.failedLoginCount).toBe(LOCKOUT.threshold);
    expect(row.lockedUntil).not.toBeNull();
  });

  it('opens a new window after the lock expires rather than re-locking', async () => {
    // Continues from the locked state above. One wrong password after the
    // deadline must read as the first of a new window, not the sixth of the
    // old one.
    const scope = { tenantId: brandTenantId(D.tenant) };
    const later = new Date(clock.getTime() + (LOCKOUT.lockSeconds + 1) * 1000);

    const window = await repository.registerFailedLogin(
      scope,
      D.user,
      later.toISOString(),
      LOCKOUT,
    );
    expect(window.failedLoginCount).toBe(1);
    expect(window.lockedUntil).toBeNull();
    expect(window.locked).toBe(false);
  });

  it('does not extend a live lock while requests keep arriving', async () => {
    const scope = { tenantId: brandTenantId(D.tenant) };
    for (let attempt = 1; attempt < LOCKOUT.threshold; attempt += 1) {
      await repository.registerFailedLogin(scope, D.user, clock.toISOString(), LOCKOUT);
    }
    const locked = await userRow(D);
    expect(locked.lockedUntil).not.toBeNull();

    await repository.registerFailedLogin(scope, D.user, clock.toISOString(), LOCKOUT);
    await repository.registerFailedLogin(scope, D.user, clock.toISOString(), LOCKOUT);
    const after = await userRow(D);
    expect(after.lockedUntil?.toISOString()).toBe(locked.lockedUntil?.toISOString());
  });

  it('loses no increment when failures arrive together', async () => {
    // The reason the transition is one UPDATE. Read-modify-write in the
    // application would let these twelve attempts register as two or three.
    const scope = { tenantId: brandTenantId(D.tenant) };
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { id: D.user, tenantId: D.tenant },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    });

    const attempts = 12;
    await Promise.all(
      Array.from({ length: attempts }, () =>
        repository.registerFailedLogin(scope, D.user, clock.toISOString(), {
          threshold: 1_000,
          lockSeconds: LOCKOUT.lockSeconds,
        }),
      ),
    );

    const row = await userRow(D);
    expect(row.failedLoginCount).toBe(attempts);
  }, 30_000);

  it('clears the failure state and creates the session in one transaction', async () => {
    const scope = { tenantId: brandTenantId(D.tenant) };
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { id: D.user, tenantId: D.tenant },
        data: { failedLoginCount: 3, lockedUntil: null },
      });
    });

    const sessionId = '018f0c00-0000-7000-8000-0000000000df';
    const issuedAt = clock.toISOString();
    await repository.finalizeSuccessfulLogin(scope, {
      id: sessionId,
      userId: D.user,
      tokenHash: 'finalize-live-1',
      authVersion: 1,
      userAgent: null,
      issuedAt,
      expiresAt: new Date(clock.getTime() + 3600_000).toISOString(),
      at: issuedAt,
    });

    const reset = await userRow(D);
    expect(reset.failedLoginCount).toBe(0);
    expect(reset.lockedUntil).toBeNull();
    expect(reset.lastLoginAt).not.toBeNull();
  });

  it('rolls the counter reset back when the session insert fails', async () => {
    // Replaying the same session id makes the insert fail after the user row
    // has been updated. Both must be undone, or a user is left unlocked with
    // no session to show for it.
    const scope = { tenantId: brandTenantId(D.tenant) };
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { id: D.user, tenantId: D.tenant },
        data: { failedLoginCount: 4, lockedUntil: null, lastLoginAt: null },
      });
    });

    const issuedAt = clock.toISOString();
    await expect(
      repository.finalizeSuccessfulLogin(scope, {
        // Same id as the session created by the previous test.
        id: '018f0c00-0000-7000-8000-0000000000df',
        userId: D.user,
        tokenHash: 'finalize-live-2',
        authVersion: 1,
        userAgent: null,
        issuedAt,
        expiresAt: new Date(clock.getTime() + 3600_000).toISOString(),
        at: issuedAt,
      }),
    ).rejects.toThrow();

    const unchanged = await userRow(D);
    expect(unchanged.failedLoginCount).toBe(4);
    expect(unchanged.lastLoginAt).toBeNull();

    const sessions = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.session.findMany({ where: { tenantId: D.tenant, userId: D.user } }),
    );
    expect(sessions.filter((row) => row.tokenHash === 'finalize-live-2')).toHaveLength(0);
  });

  it('writes an audit trail carrying no secret', async () => {
    await login({ password: 'wrong-on-purpose' });
    await login();

    const events = await withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
      tx.auditEvent.findMany({ where: { tenantId: A.tenant }, orderBy: { occurredAt: 'desc' } }),
    );
    const types = events.map((event) => event.eventType);
    expect(types).toContain('auth.login.success');
    expect(types).toContain('auth.login.failure');

    const rendered = JSON.stringify(events);
    expect(rendered).not.toContain(PASSWORD);
    expect(rendered).not.toContain('kps1.');
    expect(rendered).not.toContain('scrypt$');

    // Reset the failure counter this test just moved.
    await login();
  }, 30_000);

  it('never writes the token it issued', async () => {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');

    const stored = await withTenant(prisma, brandTenantId(A.tenant), async (tx) =>
      tx.session.findMany({ where: { tenantId: A.tenant } }),
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain(result.token);
  });
});

describe.skipIf(url !== '')('authentication flow, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
