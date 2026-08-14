import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  MAX_ASSIGNABLE_ROLES,
  ROLE_PERMISSIONS,
  newId,
  tenantId as brandTenantId,
} from '@korvi/domain';
import {
  ShiftOpenRefusedError,
  activateTenant,
  createAuditRepository,
  createAuthRepository,
  createPrismaClient,
  createShiftRepository,
  provisionPermissionCatalogue,
  provisionTenant,
  withLoginSlug,
  withTenant,
} from '@korvi/database';
import { createMerchantAdminService } from '../admin/service.js';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import type { MerchantAdminService } from '../admin/service.js';
import type { AuthService } from '../auth/service.js';
import type { PrismaClient } from '@korvi/database';
import type { ShiftRepository } from '@korvi/domain';
import type { AuthenticatedPrincipal, RoleName } from '@korvi/domain';

/**
 * Merchant administration, against a real PostgreSQL server.
 *
 * Everything here is a claim only the database can settle: that one merchant's
 * administrator cannot reach another merchant's rows however they address them,
 * that removing somebody's access removes it from the session they are already
 * holding, that a merchant cannot lock itself out of its own administration
 * even when two requests try at once, and that a failed change leaves nothing
 * behind — including no audit row saying it succeeded.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with every
 * migration applied, connected as the application role — not a superuser and
 * not a BYPASSRLS role, either of which would make the isolation tests pass for
 * the wrong reason. That is asserted rather than assumed.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const PASSWORD = 'a-real-password-9!';
const OPERATOR = 'ops:platform/4b1-suite';

const SLUG_A = '4b1-live-alpha';
const SLUG_B = '4b1-live-beta';
const ALL_SLUGS = [SLUG_A, SLUG_B] as const;

interface Merchant {
  /** Learned when the control plane mints it, not chosen by the fixture. */
  tenantId: string;
  readonly slug: string;
  /** The acting administrator for this tenant. */
  adminOne: string;
  /** A second administrator, so the last-admin rule has something to bite on. */
  adminTwo: string;
  cashier: string;
  branchId: string;
  roles: Map<string, string>;
}

describe.skipIf(url === '')('merchant administration, live', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;
  let admin: MerchantAdminService;
  let adminB: MerchantAdminService;
  let auth: AuthService;

  const A = { slug: SLUG_A } as Partial<Merchant> as Merchant;
  const B = { slug: SLUG_B } as Partial<Merchant> as Merchant;

  async function resolveId(slug: string): Promise<string | null> {
    return withLoginSlug(prisma, slug, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "tenants" WHERE "slug" = ${slug}`;
      return rows[0]?.id ?? null;
    });
  }

  async function purge(slug: string): Promise<void> {
    const id = await resolveId(slug);
    if (id === null) return;
    await withTenant(prisma, id, async (tx) => {
      await tx.tenant.deleteMany({ where: { id } });
    });
  }

  /** A person, their membership, and one role. Password set so they can log in. */
  async function seedUser(merchant: Merchant, email: string, role: RoleName): Promise<string> {
    const userId = newId();
    const passwordHash = await hashPassword(PASSWORD, FAST);
    await withTenant(prisma, merchant.tenantId, async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          tenantId: merchant.tenantId,
          email,
          displayName: email,
          passwordHash,
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: {
          id: newId(),
          tenantId: merchant.tenantId,
          userId,
          defaultBranchId: merchant.branchId,
          updatedAt: new Date(),
        },
      });
      const target = await tx.role.findFirst({
        where: { tenantId: merchant.tenantId, key: role },
      });
      if (target === null) throw new Error(`role ${role} is not provisioned`);
      await tx.userRole.create({
        data: { id: newId(), tenantId: merchant.tenantId, userId, roleId: target.id },
      });
    });
    return userId;
  }

  async function principalFor(slug: string, email: string): Promise<AuthenticatedPrincipal> {
    const result = await auth.login({
      tenantSlug: slug,
      email,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    if (result.outcome !== 'success') throw new Error(`login failed: ${result.reason}`);
    return result.principal;
  }

  async function sessionFor(slug: string, email: string): Promise<string> {
    const result = await auth.login({
      tenantSlug: slug,
      email,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    if (result.outcome !== 'success') throw new Error(`login failed: ${result.reason}`);
    return result.token;
  }

  async function auditFor(tenantId: string, eventType: string): Promise<number> {
    return withTenant(prisma, tenantId, async (tx) =>
      tx.auditEvent.count({ where: { tenantId, eventType } }),
    );
  }

  /** The other merchant's own authoritative read, through their own session. */
  async function admin_readOther(principal: AuthenticatedPrincipal): Promise<boolean> {
    const settings = await adminB.readSettings(principal);
    if (settings.outcome !== 'success') throw new Error('unreachable');
    return settings.value.enableProductImages;
  }

  async function liveSessions(tenantId: string, userId: string): Promise<number> {
    return withTenant(prisma, tenantId, async (tx) =>
      tx.session.count({ where: { tenantId, userId, revokedAt: null } }),
    );
  }

  async function build(merchant: Merchant, index: number): Promise<void> {
    const provisioned = await provisionTenant(prisma, {
      operationId: `op-${merchant.slug}`,
      slug: merchant.slug,
      name: `متجر ${merchant.slug}`,
      vatNumber: '300000000000003',
      vertical: 'retail',
      controlPlaneActorRef: OPERATOR,
    });
    merchant.tenantId = provisioned.id;
    await activateTenant(prisma, {
      tenantId: provisioned.id,
      operationId: `op-activate-${merchant.slug}`,
      controlPlaneActorRef: OPERATOR,
    });

    merchant.roles = new Map(provisioned.roles.map((role) => [role.key, role.id]));

    merchant.branchId = newId();
    await withTenant(prisma, provisioned.id, async (tx) => {
      await tx.branch.create({
        data: {
          id: merchant.branchId,
          tenantId: provisioned.id,
          code: `0${index}`,
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
      });
    });

    merchant.adminOne = await seedUser(merchant, `one@${merchant.slug}.test`, 'owner');
    merchant.adminTwo = await seedUser(merchant, `two@${merchant.slug}.test`, 'admin');
    merchant.cashier = await seedUser(merchant, `till@${merchant.slug}.test`, 'cashier');
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    second = createPrismaClient(url);
    await second.$queryRaw`SELECT 1`;

    for (const slug of ALL_SLUGS) await purge(slug);
    await provisionPermissionCatalogue(prisma);

    auth = createAuthService({
      repository: createAuthRepository(prisma),
      audit: createAuditRepository(prisma),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    });

    await build(A, 1);
    await build(B, 2);

    const deps = (client: PrismaClient): MerchantAdminService =>
      createMerchantAdminService({
        prisma: client,
        readSettings: async (scope) =>
          withTenant(client, scope.tenantId, async (tx) => {
            const row = await tx.tenantSettings.findFirst({
              where: { tenantId: scope.tenantId as string },
            });
            return row === null
              ? null
              : {
                  tenantId: row.tenantId,
                  vertical: row.vertical,
                  priceMode: row.priceMode,
                  defaultVatBasisPoints: row.defaultVatBasisPoints,
                  currency: row.currency,
                  requireBarcode: row.requireBarcode,
                  allowWeightedItems: row.allowWeightedItems,
                  trackInventory: row.trackInventory,
                  allowNegativeStock: row.allowNegativeStock,
                  enableProductImages: row.enableProductImages,
                  receiptHeaderAr: row.receiptHeaderAr,
                  receiptFooterAr: row.receiptFooterAr,
                };
          }),
      });

    admin = deps(prisma);
    adminB = deps(second);
  }, 180_000);

  afterAll(async () => {
    for (const slug of ALL_SLUGS) await purge(slug);
    await prisma.$disconnect();
    await second.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('runs as a role the policies actually apply to', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      forced: boolean;
    }>(
      `SELECT r.rolsuper, r.rolbypassrls, c.relforcerowsecurity AS forced
         FROM pg_roles r, pg_class c
        WHERE r.rolname = current_user AND c.relname = 'users'`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, forced: true });
    await client.end();
  });

  it('A cannot read or change B settings, branches, members or roles', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);

    // Reads are scoped by the principal and cannot be redirected: there is no
    // argument on any of these methods that names a tenant.
    const settings = await admin.readSettings(principal);
    expect(settings.outcome === 'success' && settings.value.tenantId).toBe(A.tenantId);

    const branches = await admin.listBranches(principal, 50, null);
    expect(branches.outcome).toBe('success');
    if (branches.outcome !== 'success') throw new Error('unreachable');
    expect(branches.value.items.every((branch) => branch.code === '01')).toBe(true);

    const members = await admin.listMembers(principal, 50, null);
    if (members.outcome !== 'success') throw new Error('unreachable');
    expect(members.value.items.map((member) => member.email).sort()).toEqual([
      `one@${A.slug}.test`,
      `till@${A.slug}.test`,
      `two@${A.slug}.test`,
    ]);

    // Writes addressed at B's rows, by id, from A's session. Every one answers
    // "unknown", which is also what a row that does not exist answers.
    const attempts: readonly [string, Promise<{ outcome: string }>][] = [
      ['branch', admin.updateBranch(principal, B.branchId, { nameAr: 'مخترق' })],
      ['branch activation', admin.setBranchActive(principal, B.branchId, false)],
      ['member', admin.updateMember(principal, B.adminTwo, { displayName: 'مخترق' })],
      ['user activation', admin.setUserActive(principal, B.adminTwo, false)],
      ['membership', admin.setMembershipActive(principal, B.adminTwo, false)],
    ];
    for (const [label, work] of attempts) {
      const result = await work;
      expect(result.outcome, label).toBe('failure');
    }

    // And B is untouched.
    const foreign = await withTenant(prisma, B.tenantId, async (tx) => ({
      branch: await tx.branch.findFirst({ where: { id: B.branchId, tenantId: B.tenantId } }),
      user: await tx.user.findFirst({ where: { id: B.adminTwo, tenantId: B.tenantId } }),
    }));
    expect(foreign.branch?.nameAr).toBe('الفرع');
    expect(foreign.branch?.isActive).toBe(true);
    expect(foreign.user?.isActive).toBe(true);
  }, 120_000);

  it('A cannot bind a B branch to a till, or assign a B role', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);

    const terminal = await admin.createTerminal(principal, {
      branchId: B.branchId,
      code: 'T9',
      label: 'صندوق',
    });
    expect(terminal.outcome === 'failure' && terminal.reason).toBe('unknown-branch');

    const foreignRole = B.roles.get('cashier');
    if (foreignRole === undefined) throw new Error('no cashier role in B');
    const assigned = await admin.assignRole(principal, A.cashier, foreignRole);
    expect(assigned.outcome === 'failure' && assigned.reason).toBe('unknown-role');

    // Nothing was written into either merchant.
    const counts = await withTenant(prisma, A.tenantId, async (tx) => ({
      terminals: await tx.terminal.count({ where: { tenantId: A.tenantId } }),
      grants: await tx.userRole.count({ where: { tenantId: A.tenantId, userId: A.cashier } }),
    }));
    expect(counts.terminals).toBe(0);
    expect(counts.grants).toBe(1);
  }, 120_000);

  // -------------------------------------------------------------------------
  // The happy path, and what it writes
  // -------------------------------------------------------------------------

  it('creates a branch and a till, and records who did it', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);

    const branch = await admin.createBranch(principal, { code: '٠٢', nameAr: 'فرع العليا' });
    if (branch.outcome !== 'success') throw new Error(`branch failed: ${branch.reason}`);
    // Arabic-Indic digits folded to the code a unique index can compare.
    expect(branch.value.code).toBe('02');

    const duplicate = await admin.createBranch(principal, { code: '02', nameAr: 'مكرر' });
    expect(duplicate.outcome === 'failure' && duplicate.reason).toBe('code-taken');

    const terminal = await admin.createTerminal(principal, {
      branchId: branch.value.id,
      code: 'T1',
      label: 'صندوق ١',
    });
    if (terminal.outcome !== 'success') throw new Error('terminal failed');
    expect(terminal.value.branchId).toBe(branch.value.id);

    const events = await withTenant(prisma, A.tenantId, async (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: A.tenantId, eventType: { in: ['branch.created', 'terminal.created'] } },
        orderBy: { id: 'asc' },
      }),
    );
    expect(events.map((event) => event.eventType)).toEqual(['branch.created', 'terminal.created']);
    // The merchant's own administrator, from the session — not null, and not
    // anything the request said.
    for (const event of events) expect(event.actorUserId).toBe(principal.userId);

    // The duplicate wrote no event at all.
    expect(await auditFor(A.tenantId, 'branch.created')).toBe(1);
  }, 120_000);

  it('refuses to deactivate a branch or till with an open drawer', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);
    const terminals = await admin.listTerminals(principal, 50, null, null);
    if (terminals.outcome !== 'success') throw new Error('unreachable');
    const terminal = terminals.value.items[0];
    if (terminal === undefined) throw new Error('no terminal');

    const shiftId = newId();
    await withTenant(prisma, A.tenantId, async (tx) => {
      await tx.shift.create({
        data: {
          id: shiftId,
          tenantId: A.tenantId,
          branchId: terminal.branchId,
          terminalId: terminal.id,
          userId: A.cashier,
          openingFloatMinor: 0n,
          openedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });

    // Fail closed rather than silently repairing: a drawer nobody has counted
    // must not be stranded behind an inactive till.
    const till = await admin.setTerminalActive(principal, terminal.id, false);
    expect(till.outcome === 'failure' && till.reason).toBe('branch-in-use');
    const branch = await admin.setBranchActive(principal, terminal.branchId, false);
    expect(branch.outcome === 'failure' && branch.reason).toBe('branch-in-use');
    expect(await auditFor(A.tenantId, 'terminal.deactivated')).toBe(0);

    await withTenant(prisma, A.tenantId, async (tx) => {
      await tx.shift.updateMany({
        where: { id: shiftId, tenantId: A.tenantId },
        data: { status: 'closed', closedAt: new Date() },
      });
    });

    const closed = await admin.setTerminalActive(principal, terminal.id, false);
    expect(closed.outcome === 'success' && closed.value.isActive).toBe(false);
    expect(await auditFor(A.tenantId, 'terminal.deactivated')).toBe(1);
  }, 120_000);

  it('creates a member who exists and cannot yet sign in', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);
    const created = await admin.createMember(principal, {
      email: ` NEW@${A.slug}.TEST `,
      displayName: 'موظف جديد',
      defaultBranchId: A.branchId,
    });
    if (created.outcome !== 'success') throw new Error(`create failed: ${created.reason}`);
    // Normalised the same way login normalises, so the two cannot disagree
    // about whether this address exists.
    expect(created.value.email).toBe(`new@${A.slug}.test`);
    expect(created.value.hasCredential).toBe(false);

    // No invitation was sent, because Korvi cannot send one. What it can say
    // truthfully is that the account exists and has no credential — and the
    // login path refuses a null credential outright.
    const attempt = await auth.login({
      tenantSlug: A.slug,
      email: `new@${A.slug}.test`,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    expect(attempt.outcome === 'failure' && attempt.reason).toBe('no-credential');

    const duplicate = await admin.createMember(principal, {
      email: `new@${A.slug}.test`,
      displayName: 'مكرر',
      defaultBranchId: null,
    });
    expect(duplicate.outcome === 'failure' && duplicate.reason).toBe('email-taken');
  }, 120_000);

  // -------------------------------------------------------------------------
  // Access changes and the sessions already out there
  // -------------------------------------------------------------------------

  it('disabling a user stops the session they are already holding', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);
    const token = await sessionFor(A.slug, `till@${A.slug}.test`);
    await expect(auth.authenticate(token)).resolves.toMatchObject({ outcome: 'success' });

    const result = await admin.setUserActive(principal, A.cashier, false);
    if (result.outcome !== 'success') throw new Error(`refused: ${result.reason}`);
    expect(result.value.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(await liveSessions(A.tenantId, A.cashier)).toBe(0);

    const stopped = await auth.authenticate(token);
    expect(stopped.outcome).toBe('failure');

    // Re-enabling restores the account and resurrects nothing.
    const back = await admin.setUserActive(principal, A.cashier, true);
    expect(back.outcome === 'success' && back.value.revokedSessions).toBe(0);
    const stillDead = await auth.authenticate(token);
    expect(stillDead.outcome === 'failure' && stillDead.reason).toBe('revoked');
    expect(await liveSessions(A.tenantId, A.cashier)).toBe(0);

    // And the only way back in is to sign in again.
    const fresh = await sessionFor(A.slug, `till@${A.slug}.test`);
    await expect(auth.authenticate(fresh)).resolves.toMatchObject({ outcome: 'success' });
  }, 180_000);

  it('disabling a membership does the same, and reactivating it resurrects nothing', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);
    const token = await sessionFor(A.slug, `till@${A.slug}.test`);
    await expect(auth.authenticate(token)).resolves.toMatchObject({ outcome: 'success' });

    const off = await admin.setMembershipActive(principal, A.cashier, false);
    if (off.outcome !== 'success') throw new Error(`refused: ${off.reason}`);
    expect(off.value.revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await auth.authenticate(token)).outcome).toBe('failure');

    const on = await admin.setMembershipActive(principal, A.cashier, true);
    expect(on.outcome).toBe('success');
    const stillDead = await auth.authenticate(token);
    expect(stillDead.outcome === 'failure' && stillDead.reason).toBe('revoked');
  }, 180_000);

  it('removing a role removes the permission from a session already issued', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);
    const token = await sessionFor(A.slug, `two@${A.slug}.test`);

    const before = await auth.authenticate(token);
    if (before.outcome !== 'success') throw new Error('expected a session');
    // The fixture's claim tied back to the permission model rather than to the
    // author's memory of it: `admin` is a role that grants the authority.
    expect(ROLE_PERMISSIONS.admin).toContain('users.manage');
    expect(before.principal.permissions).toContain('users.manage');

    const adminRole = A.roles.get('admin');
    if (adminRole === undefined) throw new Error('no admin role');
    const removed = await admin.removeRole(principal, A.adminTwo, adminRole);
    expect(removed.outcome === 'success' && removed.value.changed).toBe(true);

    // The session is still valid — nothing about who they are changed — and it
    // no longer carries the permission. Authorization is read from the role
    // graph on every request rather than carried in the token, which is what
    // makes this immediate without a sweep (ADR-0019).
    const after = await auth.authenticate(token);
    if (after.outcome !== 'success') throw new Error('the session should still be valid');
    expect(after.principal.permissions).not.toContain('users.manage');
    expect(after.principal.permissions).not.toContain('settings.manage');

    // Put it back, so the last-admin tests have two administrators again.
    const restored = await admin.assignRole(principal, A.adminTwo, adminRole);
    expect(restored.outcome === 'success' && restored.value.changed).toBe(true);
    const regained = await auth.authenticate(token);
    expect(regained.outcome === 'success' && regained.principal.permissions).toContain(
      'users.manage',
    );
  }, 180_000);

  it('assigns a role idempotently rather than twice', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);
    const managerRole = A.roles.get('manager');
    if (managerRole === undefined) throw new Error('no manager role');

    const first = await admin.assignRole(principal, A.cashier, managerRole);
    expect(first.outcome === 'success' && first.value.changed).toBe(true);
    const again = await admin.assignRole(principal, A.cashier, managerRole);
    // Not an error, and not a second row: the unique index decides, and the
    // replay says plainly that it changed nothing.
    expect(again.outcome === 'success' && again.value.changed).toBe(false);

    const rows = await withTenant(prisma, A.tenantId, async (tx) =>
      tx.userRole.count({
        where: { tenantId: A.tenantId, userId: A.cashier, roleId: managerRole },
      }),
    );
    expect(rows).toBe(1);
    // One grant, one event.
    expect(await auditFor(A.tenantId, 'member.role-assigned')).toBe(2);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Locking yourself out
  // -------------------------------------------------------------------------

  it('refuses the change that would leave nobody able to administer', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);
    const ownerRole = A.roles.get('owner');
    const adminRole = A.roles.get('admin');
    if (ownerRole === undefined || adminRole === undefined) throw new Error('missing roles');

    // Two administrators. Removing one is fine.
    const first = await admin.removeRole(principal, A.adminTwo, adminRole);
    expect(first.outcome).toBe('success');

    // Removing the second is not, and neither is disabling them.
    const last = await admin.removeRole(principal, A.adminOne, ownerRole);
    expect(last.outcome === 'failure' && last.reason).toBe('last-administrator');
    const disabled = await admin.setUserActive(principal, A.adminOne, false);
    expect(disabled.outcome === 'failure' && disabled.reason).toBe('last-administrator');
    const unadmitted = await admin.setMembershipActive(principal, A.adminOne, false);
    expect(unadmitted.outcome === 'failure' && unadmitted.reason).toBe('last-administrator');

    // Every one of those refusals rolled back whole: the grant is intact, the
    // account is enabled, and no audit row claims otherwise.
    const state = await withTenant(prisma, A.tenantId, async (tx) => ({
      grant: await tx.userRole.count({
        where: { tenantId: A.tenantId, userId: A.adminOne, roleId: ownerRole },
      }),
      user: await tx.user.findFirst({ where: { id: A.adminOne, tenantId: A.tenantId } }),
      membership: await tx.tenantMembership.findFirst({
        where: { tenantId: A.tenantId, userId: A.adminOne },
      }),
    }));
    expect(state.grant).toBe(1);
    expect(state.user?.isActive).toBe(true);
    expect(state.membership?.status).toBe('active');
    expect(await auditFor(A.tenantId, 'member.user-deactivated')).toBe(1); // the cashier, earlier

    // Restore the second administrator for the concurrency test below.
    const restored = await admin.assignRole(principal, A.adminTwo, adminRole);
    expect(restored.outcome).toBe('success');
  }, 180_000);

  it('two simultaneous requests cannot remove the last administrative authority', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);
    const adminRole = A.roles.get('admin');
    if (adminRole === undefined) throw new Error('no admin role');

    /**
     * A third connection holding the tenant row, so the race is ordered rather
     * than hoped for. Each contender is started and then observed queueing on
     * that row before the next is started; PostgreSQL grants row locks in the
     * order waiters arrived.
     */
    const gate = new pg.Client({ connectionString: url });
    await gate.connect();
    const { rows: pidRows } = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = pidRows[0]?.pid;
    if (pid === undefined) throw new Error('no backend pid');
    await gate.query('BEGIN');
    await gate.query("SELECT set_config('app.tenant_id', $1, true)", [A.tenantId]);
    await gate.query('SELECT "id" FROM "tenants" WHERE "id" = $1 FOR UPDATE', [A.tenantId]);

    const blocking = async (count: number): Promise<void> => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const { rows } = await gate.query<{ n: string }>(
          `WITH RECURSIVE queued AS (
             SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a
               JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
              WHERE a.datname = current_database()
           )
           SELECT count(*)::text AS n FROM queued`,
          [pid],
        );
        if (Number(rows[0]?.n ?? '0') >= count) return;
        if (Date.now() > deadline) throw new Error(`only ${rows[0]?.n ?? '0'} of ${count} blocked`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    };

    // Two individually safe requests. Together they would leave nobody.
    const one = admin.removeRole(principal, A.adminTwo, adminRole);
    await blocking(1);
    const two = adminB.setUserActive(principal, A.adminOne, false);
    await blocking(2);
    await gate.query('COMMIT');
    await gate.end();

    const [first, other] = await Promise.all([one, two]);
    const outcomes = [first.outcome, other.outcome].sort();
    expect(outcomes).toEqual(['failure', 'success']);
    const refused = first.outcome === 'failure' ? first : other;
    expect(refused.outcome === 'failure' && refused.reason).toBe('last-administrator');

    // Exactly one administrator survives, and the merchant is still
    // administrable.
    const survivors = await withTenant(
      prisma,
      A.tenantId,
      async (tx) =>
        tx.$queryRaw<{ n: string }[]>`
        SELECT count(DISTINCT u."id")::text AS n
          FROM "users" u
          JOIN "user_roles" ur ON ur."tenantId" = u."tenantId" AND ur."userId" = u."id"
          JOIN "role_permissions" rp
            ON rp."tenantId" = ur."tenantId" AND rp."roleId" = ur."roleId"
          JOIN "tenant_memberships" m
            ON m."tenantId" = u."tenantId" AND m."userId" = u."id"
         WHERE u."tenantId" = ${A.tenantId}::uuid AND u."isActive" = true
           AND m."status" = 'active' AND rp."permissionKey" = 'users.manage'`,
    );
    expect(Number(survivors[0]?.n ?? '0')).toBe(1);

    // Put the merchant back to two administrators, as a fixture rather than as
    // an authority call: whichever contender won, one of them can no longer
    // act, so asking the service to undo it would be asking a locked-out
    // administrator to unlock themselves.
    await withTenant(prisma, A.tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { id: A.adminOne, tenantId: A.tenantId },
        data: { isActive: true, updatedAt: new Date() },
      });
      const existing = await tx.userRole.findFirst({
        where: { tenantId: A.tenantId, userId: A.adminTwo, roleId: adminRole },
      });
      if (existing === null) {
        await tx.userRole.create({
          data: { id: newId(), tenantId: A.tenantId, userId: A.adminTwo, roleId: adminRole },
        });
      }
    });
  }, 180_000);

  // -------------------------------------------------------------------------
  // Failure leaves nothing behind
  // -------------------------------------------------------------------------

  it('a failure after the write rolls back the access change and its audit', async () => {
    const principal = await principalFor(B.slug, `one@${B.slug}.test`);
    const token = await sessionFor(B.slug, `till@${B.slug}.test`);
    await expect(auth.authenticate(token)).resolves.toMatchObject({ outcome: 'success' });
    const before = await liveSessions(B.tenantId, B.cashier);
    expect(before).toBeGreaterThanOrEqual(1);

    /**
     * A fault installed in the database, not in the code under test.
     *
     * The deactivation writes the flag, revokes the sessions and *then* appends
     * its audit row. A trigger that refuses that last insert fails the
     * transaction at the one point where every earlier write has already
     * happened — which is the only way to show they are one transaction rather
     * than three that usually succeed together.
     */
    const fault = new pg.Client({ connectionString: url });
    await fault.connect();
    await fault.query(`
      CREATE FUNCTION korvi_test_refuse_member_audit() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."eventType" = 'member.user-deactivated' AND NEW."tenantId" = '${B.tenantId}'::uuid
        THEN
          RAISE EXCEPTION 'korvi test fault: audit write refused';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER korvi_test_refuse_member_audit
        BEFORE INSERT ON "audit_events"
        FOR EACH ROW EXECUTE FUNCTION korvi_test_refuse_member_audit();`);

    let failed = '';
    try {
      await admin.setUserActive(principal, B.cashier, false);
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    }
    // Rethrown rather than laundered into a tidy 4xx: an unexpected failure
    // must not tell the caller their request was the problem.
    expect(failed).toMatch(/korvi test fault/);

    const user = await withTenant(prisma, B.tenantId, async (tx) =>
      tx.user.findFirst({ where: { id: B.cashier, tenantId: B.tenantId } }),
    );
    expect(user?.isActive).toBe(true);
    expect(await liveSessions(B.tenantId, B.cashier)).toBe(before);
    await expect(auth.authenticate(token)).resolves.toMatchObject({ outcome: 'success' });
    expect(await auditFor(B.tenantId, 'member.user-deactivated')).toBe(0);

    await fault.query(`
      DROP TRIGGER korvi_test_refuse_member_audit ON "audit_events";
      DROP FUNCTION korvi_test_refuse_member_audit();`);
    await fault.end();

    // And the same request, unchanged, now does exactly what it was asked to.
    const retried = await admin.setUserActive(principal, B.cashier, false);
    expect(retried.outcome === 'success' && retried.value.revokedSessions).toBe(before);
    expect(await auditFor(B.tenantId, 'member.user-deactivated')).toBe(1);
  }, 180_000);

  // -------------------------------------------------------------------------
  // Settings: what was written is what is read
  // -------------------------------------------------------------------------

  it('reads back the value it just persisted, and nobody else sees it', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);
    const other = await principalFor(B.slug, `one@${B.slug}.test`);

    const before = await admin.readSettings(principal);
    if (before.outcome !== 'success') throw new Error('unreachable');
    expect(before.value.enableProductImages).toBe(false);

    const updated = await admin.updateSettings(principal, { enableProductImages: true });
    if (updated.outcome !== 'success') throw new Error('unreachable');
    expect(updated.value.enableProductImages).toBe(true);

    // The authoritative read, not the write's own return value. A read-side
    // constant would pass the line above and fail this one.
    const after = await admin.readSettings(principal);
    expect(after.outcome === 'success' && after.value.enableProductImages).toBe(true);

    // And the row itself.
    const row = await withTenant(prisma, A.tenantId, async (tx) =>
      tx.tenantSettings.findFirst({ where: { tenantId: A.tenantId } }),
    );
    expect(row?.enableProductImages).toBe(true);

    // One merchant's setting is not another's.
    const neighbour = await admin_readOther(other);
    expect(neighbour).toBe(false);

    // Put it back, so later assertions start from a known page.
    const reset = await admin.updateSettings(principal, { enableProductImages: false });
    expect(reset.outcome === 'success' && reset.value.enableProductImages).toBe(false);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  it('walks every branch through cursors, without gaps or repeats', async () => {
    const principal = await principalFor(B.slug, `one@${B.slug}.test`);
    for (const code of ['P1', 'P2', 'P3', 'P4']) {
      const made = await adminB.createBranch(principal, { code, nameAr: `فرع ${code}` });
      expect(made.outcome, code).toBe('success');
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<typeof adminB.listBranches>> = await adminB.listBranches(
        principal,
        2,
        cursor,
      );
      if (result.outcome !== 'success') throw new Error('unreachable');
      seen.push(...result.value.items.map((branch) => branch.code));
      expect(result.value.items.length).toBeLessThanOrEqual(2);
      if (!result.value.hasMore) {
        expect(result.value.nextCursor).toBeNull();
        break;
      }
      expect(result.value.nextCursor).not.toBeNull();
      cursor = result.value.nextCursor;
    }

    // Every branch exactly once, in order, and the whole set — which is what a
    // `hasMore` with no way to continue could never demonstrate.
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain('P1');
    expect(seen).toContain('P4');
    expect(seen).toContain('02');
  }, 180_000);

  it('walks members and tills the same way, and refuses malformed cursors', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);

    const first = await admin.listMembers(principal, 1, null);
    if (first.outcome !== 'success') throw new Error('unreachable');
    expect(first.value.items).toHaveLength(1);
    expect(first.value.hasMore).toBe(true);
    const next = first.value.nextCursor;
    expect(next).not.toBeNull();

    const secondPage = await admin.listMembers(principal, 1, next);
    if (secondPage.outcome !== 'success') throw new Error('unreachable');
    expect(secondPage.value.items).toHaveLength(1);
    // Strictly after the first, so no row is served twice.
    expect((secondPage.value.items[0]?.email ?? '') > (first.value.items[0]?.email ?? '')).toBe(
      true,
    );

    const tills = await admin.listTerminals(principal, 1, null, null);
    expect(tills.outcome).toBe('success');

    // A malformed cursor is refused rather than silently treated as
    // "start again", which would make a paging client loop.
    const bogus = await admin.listMembers(principal, 10, 'not-base64!!');
    expect(bogus.outcome === 'failure' && bogus.reason).toBe('invalid-cursor');

    // A cursor that is well formed but stale — it names a row that no longer
    // exists — is deterministic rather than an error: it is a place in an
    // order, and the order still has a place.
    const stale = Buffer.from('zzz-nobody@nowhere.test', 'utf8').toString('base64url');
    const afterStale = await admin.listMembers(principal, 10, stale);
    expect(afterStale.outcome === 'success' && afterStale.value.items).toEqual([]);
  }, 180_000);

  it('bounds the assignable-role read rather than leaving it open', async () => {
    const principal = await principalFor(B.slug, `one@${B.slug}.test`);
    // More roles than the ceiling, which the architecture cannot produce today
    // and a later strike could. The bound is what stops that becoming an
    // unbounded production query by accident.
    await withTenant(prisma, B.tenantId, async (tx) => {
      for (let index = 0; index < MAX_ASSIGNABLE_ROLES + 5; index += 1) {
        await tx.role.create({
          data: {
            id: newId(),
            tenantId: B.tenantId,
            key: `bulk-${String(index).padStart(3, '0')}`,
            nameAr: 'دور',
            updatedAt: new Date(),
          },
        });
      }
    });

    const roles = await adminB.listRoles(principal);
    if (roles.outcome !== 'success') throw new Error('unreachable');
    expect(roles.value).toHaveLength(MAX_ASSIGNABLE_ROLES);
  }, 180_000);

  it('bounds a list rather than returning a merchant-sized page', async () => {
    const principal = await principalFor(A.slug, `one@${A.slug}.test`);
    const page = await admin.listMembers(principal, 1, null);
    if (page.outcome !== 'success') throw new Error('unreachable');
    expect(page.value.items).toHaveLength(1);
    // The extra row is read and never returned; it is the answer to "is there
    // more", which is what stops a caller having to ask for everything.
    expect(page.value.hasMore).toBe(true);
  }, 120_000);
});

/**
 * Deactivation against shift opening, ordered rather than hoped for.
 *
 * Both paths take the **branch** row `FOR UPDATE` first and the terminal row
 * second — the order ADR-0017 already documents for every financial path, with
 * terminals inserted between branches and shifts, so no cycle is introduced. A
 * third connection holding the branch row therefore gates both, and each
 * contender is proven queued on it before the next is started.
 *
 * Its own tenant, so nothing here depends on what the administration suite
 * above left behind.
 */
describe.skipIf(url === '')('deactivation against shift opening, live', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;
  let admin: MerchantAdminService;
  let adminB: MerchantAdminService;
  let shifts: ShiftRepository;
  let principal: AuthenticatedPrincipal;
  let auth: AuthService;

  const SLUG = '4b1-live-race';
  let tenantId = '';
  let ownerId = '';

  interface Gate {
    blocking(count: number): Promise<void>;
    release(): Promise<void>;
  }

  async function holdBranch(branchId: string): Promise<Gate> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error('no backend pid');
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query('SELECT "id" FROM "branches" WHERE "id" = $1 FOR UPDATE', [branchId]);
    return {
      async blocking(count) {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const { rows: queued } = await client.query<{ n: string }>(
            `WITH RECURSIVE q AS (
               SELECT pid FROM pg_stat_activity
                WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
               UNION
               SELECT a.pid FROM pg_stat_activity a JOIN q ON q.pid = ANY(pg_blocking_pids(a.pid))
                WHERE a.datname = current_database()
             ) SELECT count(*)::text AS n FROM q`,
            [pid],
          );
          if (Number(queued[0]?.n ?? '0') >= count) return;
          if (Date.now() > deadline) {
            throw new Error(`only ${queued[0]?.n ?? '0'} of ${count} blocked`);
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      },
      async release() {
        await client.query('COMMIT');
        await client.end();
      },
    };
  }

  /** A fresh branch with one till, so each race starts from a clean shop. */
  async function freshShop(code: string): Promise<{ branchId: string; terminalId: string }> {
    const branch = await admin.createBranch(principal, { code, nameAr: `فرع ${code}` });
    if (branch.outcome !== 'success') throw new Error(`branch: ${branch.reason}`);
    const terminal = await admin.createTerminal(principal, {
      branchId: branch.value.id,
      code: `T${code}`,
      label: 'صندوق',
    });
    if (terminal.outcome !== 'success') throw new Error(`terminal: ${terminal.reason}`);
    return { branchId: branch.value.id, terminalId: terminal.value.id };
  }

  function openShift(
    repository: ShiftRepository,
    shop: { branchId: string; terminalId: string },
  ): Promise<unknown> {
    return repository.open(
      { tenantId: brandTenantId(tenantId) },
      {
        id: newId(),
        branchId: shop.branchId,
        terminalId: shop.terminalId,
        userId: ownerId,
        openingFloatMinor: '0',
        openedAt: new Date().toISOString(),
        openingMovementId: newId(),
      },
    );
  }

  async function refusal(work: () => Promise<unknown>): Promise<Error> {
    try {
      await work();
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error('expected a refusal, and the call succeeded');
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    second = createPrismaClient(url);
    await second.$queryRaw`SELECT 1`;

    const existing = await withLoginSlug(
      prisma,
      SLUG,
      async (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "tenants" WHERE "slug" = ${SLUG}`,
    );
    const previous = existing[0]?.id;
    if (previous !== undefined) {
      await withTenant(prisma, previous, async (tx) => {
        await tx.tenant.deleteMany({ where: { id: previous } });
      });
    }

    await provisionPermissionCatalogue(prisma);
    const provisioned = await provisionTenant(prisma, {
      operationId: `op-${SLUG}`,
      slug: SLUG,
      name: 'متجر السباق',
      vatNumber: null,
      vertical: 'retail',
      controlPlaneActorRef: OPERATOR,
    });
    tenantId = provisioned.id;
    await activateTenant(prisma, {
      tenantId,
      operationId: `op-activate-${SLUG}`,
      controlPlaneActorRef: OPERATOR,
    });

    ownerId = newId();
    const passwordHash = await hashPassword(PASSWORD, FAST);
    const seedBranch = newId();
    await withTenant(prisma, tenantId, async (tx) => {
      await tx.branch.create({
        data: { id: seedBranch, tenantId, code: '00', nameAr: 'الرئيسي', updatedAt: new Date() },
      });
      await tx.user.create({
        data: {
          id: ownerId,
          tenantId,
          email: `one@${SLUG}.test`,
          displayName: 'مالك',
          passwordHash,
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: {
          id: newId(),
          tenantId,
          userId: ownerId,
          defaultBranchId: seedBranch,
          updatedAt: new Date(),
        },
      });
      const owner = provisioned.roles.find((role) => role.key === 'owner');
      if (owner === undefined) throw new Error('no owner role');
      await tx.userRole.create({
        data: { id: newId(), tenantId, userId: ownerId, roleId: owner.id },
      });
    });

    auth = createAuthService({
      repository: createAuthRepository(prisma),
      audit: createAuditRepository(prisma),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    });
    const login = await auth.login({
      tenantSlug: SLUG,
      email: `one@${SLUG}.test`,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    if (login.outcome !== 'success') throw new Error(`login: ${login.reason}`);
    principal = login.principal;

    const settings = (client: PrismaClient): MerchantAdminService =>
      createMerchantAdminService({
        prisma: client,
        readSettings: async () => null,
      });
    admin = settings(prisma);
    adminB = settings(second);
    shifts = createShiftRepository(second);
  }, 180_000);

  afterAll(async () => {
    await withTenant(prisma, tenantId, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
    await prisma.$disconnect();
    await second.$disconnect();
  });

  it('A. a shift proved to be waiting first wins, and the deactivation refuses', async () => {
    const shop = await freshShop('RA');
    const gate = await holdBranch(shop.branchId);

    const opening = openShift(shifts, shop);
    await gate.blocking(1);
    const deactivating = admin.setTerminalActive(principal, shop.terminalId, false);
    await gate.blocking(2);
    await gate.release();

    await expect(opening).resolves.toMatchObject({ status: 'open' });
    const result = await deactivating;
    // The very race the review named: without a shared boundary this would
    // have committed and stranded an open drawer under an inactive till.
    expect(result.outcome === 'failure' && result.reason).toBe('branch-in-use');

    const till = await withTenant(prisma, tenantId, async (tx) =>
      tx.terminal.findFirst({ where: { id: shop.terminalId, tenantId } }),
    );
    expect(till?.isActive).toBe(true);
  }, 180_000);

  it('B. a deactivation proved to be waiting first wins, and the shift refuses', async () => {
    const shop = await freshShop('RB');
    const gate = await holdBranch(shop.branchId);

    const deactivating = admin.setTerminalActive(principal, shop.terminalId, false);
    await gate.blocking(1);
    const opening = refusal(() => openShift(shifts, shop));
    await gate.blocking(2);
    await gate.release();

    expect((await deactivating).outcome).toBe('success');
    const error = await opening;
    expect(error).toBeInstanceOf(ShiftOpenRefusedError);
    expect((error as ShiftOpenRefusedError).detail).toBe('unknown-terminal');

    const open = await withTenant(prisma, tenantId, async (tx) =>
      tx.shift.count({ where: { tenantId, terminalId: shop.terminalId, status: 'open' } }),
    );
    expect(open).toBe(0);
  }, 180_000);

  it('C. a shift that wins stops the branch being stood down', async () => {
    const shop = await freshShop('RC');
    const gate = await holdBranch(shop.branchId);

    const opening = openShift(shifts, shop);
    await gate.blocking(1);
    const deactivating = admin.setBranchActive(principal, shop.branchId, false);
    await gate.blocking(2);
    await gate.release();

    await expect(opening).resolves.toMatchObject({ status: 'open' });
    const result = await deactivating;
    expect(result.outcome === 'failure' && result.reason).toBe('branch-in-use');

    const branch = await withTenant(prisma, tenantId, async (tx) =>
      tx.branch.findFirst({ where: { id: shop.branchId, tenantId } }),
    );
    expect(branch?.isActive).toBe(true);
  }, 180_000);

  it('D. a branch stood down first refuses the shift, and says which', async () => {
    const shop = await freshShop('RD');
    const gate = await holdBranch(shop.branchId);

    const deactivating = admin.setBranchActive(principal, shop.branchId, false);
    await gate.blocking(1);
    const opening = refusal(() => openShift(shifts, shop));
    await gate.blocking(2);
    await gate.release();

    expect((await deactivating).outcome).toBe('success');
    const error = await opening;
    expect(error).toBeInstanceOf(ShiftOpenRefusedError);
    // Its own answer. The till is addressable and the remedy is to activate
    // the branch, not to go looking for a missing terminal.
    expect((error as ShiftOpenRefusedError).detail).toBe('branch-inactive');
  }, 180_000);

  it('E. a till cannot be switched on under a branch that is stood down', async () => {
    const shop = await freshShop('RE');
    const off = await admin.setTerminalActive(principal, shop.terminalId, false);
    expect(off.outcome).toBe('success');
    const branchOff = await admin.setBranchActive(principal, shop.branchId, false);
    expect(branchOff.outcome).toBe('success');

    const on = await admin.setTerminalActive(principal, shop.terminalId, true);
    // Not `branch-in-use`: nothing is open, and claiming otherwise would send
    // the merchant hunting for a drawer to close.
    expect(on.outcome === 'failure' && on.reason).toBe('branch-inactive');

    // Creating one is refused for the same reason.
    const created = await admin.createTerminal(principal, {
      branchId: shop.branchId,
      code: 'TRE2',
      label: 'صندوق',
    });
    expect(created.outcome === 'failure' && created.reason).toBe('branch-inactive');
  }, 180_000);

  it('F. a branch deactivation racing a till creation cannot leave an openable till', async () => {
    const shop = await freshShop('RF');
    const gate = await holdBranch(shop.branchId);

    const deactivating = admin.setBranchActive(principal, shop.branchId, false);
    await gate.blocking(1);
    const creating = adminB.createTerminal(principal, {
      branchId: shop.branchId,
      code: 'TRF2',
      label: 'صندوق',
    });
    await gate.blocking(2);
    await gate.release();

    const [stood, made] = await Promise.all([deactivating, creating]);
    expect(stood.outcome).toBe('success');
    // Whichever order the lock granted, the creation cannot succeed under a
    // branch that is now stood down — it waits on the same row and then sees
    // the commit.
    expect(made.outcome === 'failure' && made.reason).toBe('branch-inactive');

    // And the till that already existed cannot start trading either.
    const error = await refusal(() => openShift(shifts, shop));
    expect((error as ShiftOpenRefusedError).detail).toBe('branch-inactive');

    const tills = await withTenant(prisma, tenantId, async (tx) =>
      tx.terminal.count({ where: { tenantId, branchId: shop.branchId } }),
    );
    expect(tills).toBe(1);
  }, 180_000);
});

describe.skipIf(url !== '')('merchant administration, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
