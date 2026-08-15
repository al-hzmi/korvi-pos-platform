import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { ROLE_PERMISSIONS, newId } from '@korvi/domain';
import {
  TenantLifecycleRefusedError,
  TenantProvisioningError,
  activateTenant,
  createAuditRepository,
  createAuthRepository,
  createPrismaClient,
  provisionPermissionCatalogue,
  provisionTenant,
  reactivateTenant,
  suspendTenant,
  withLoginSlug,
  withTenant,
} from '@korvi/database';
import { createAuthService } from '../auth/service.js';
import { createGuards } from '../auth/guards.js';
import { hashPassword } from '../auth/password.js';
import { registerAuthRoutes } from '../routes/auth.js';
import type { AuthService } from '../auth/service.js';
import type { ApiConfig } from '../config.js';
import type { PrismaClient, TenantProvisioningRequest } from '@korvi/database';
import type { RoleName } from '@korvi/domain';

/**
 * The SaaS control plane, against a real PostgreSQL server.
 *
 * Every claim in Strike 4A is a claim about what the database does when two
 * transactions disagree, or when a constraint is asked to hold a line the
 * application forgot. None of that can be answered by a fake, so none of it is
 * asserted anywhere but here.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with every
 * migration applied, connected as the application role — not a superuser and
 * not a BYPASSRLS role, either of which would make half of this file pass for
 * the wrong reason. Test N asserts that directly rather than trusting the
 * environment to have been set up correctly.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

/** Deliberately weak, so a suite that does dozens of derivations still runs. */
const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const PASSWORD = 'a-real-password-9!';

const ALPHA = '4a-live-alpha';
const ELSEWHERE = '4a-live-elsewhere';
const ROLLBACK = '4a-live-rollback';
const NEIGHBOUR = '4a-live-neighbour';
const RACE_A = '4a-live-race-a';
const RACE_B = '4a-live-race-b';
/** Provisioning races. Each pair contends on the `tenants` table itself. */
const RACE_SAME = '4a-live-race-same';
const RACE_SLUG = '4a-live-race-slug';
const RACE_OP_ONE = '4a-live-race-op-one';
const RACE_OP_TWO = '4a-live-race-op-two';
const LEGACY = '4a-live-legacy';
const LEGACY_STOPPED = '4a-live-legacy-stopped';
const FAULT = '4a-live-fault';

const ALL_SLUGS = [
  ALPHA,
  ELSEWHERE,
  ROLLBACK,
  NEIGHBOUR,
  RACE_A,
  RACE_B,
  RACE_SAME,
  RACE_SLUG,
  RACE_OP_ONE,
  RACE_OP_TWO,
  LEGACY,
  LEGACY_STOPPED,
  FAULT,
] as const;

const OPERATOR = 'ops:platform/nada';

const CONFIG: ApiConfig = {
  NODE_ENV: 'test',
  API_PORT: 4000,
  LOG_LEVEL: 'fatal',
  APP_ORIGINS: ['http://localhost:3000'],
  SESSION_TTL_SECONDS: 3600,
  DATABASE_URL: undefined,
  // This suite exercises the control plane, not owner bootstrap; the route is
  // deliberately unconfigured here.
  BOOTSTRAP_SIGNING_KEY: undefined,
  isProduction: false,
};

interface AuditRow {
  id: string;
  eventType: string;
  actorUserId: string | null;
  entityId: string | null;
  metadata: unknown;
}

describe.skipIf(url === '')('tenant lifecycle and provisioning, live', () => {
  let prisma: PrismaClient;
  /** A second connection, because two operators are two processes. */
  let second: PrismaClient;
  let auth: AuthService;

  /** Ids the control plane minted, learned as the suite runs. */
  const minted = new Map<string, string>();

  function request(
    slug: string,
    overrides: Partial<TenantProvisioningRequest> = {},
  ): TenantProvisioningRequest {
    return {
      operationId: `op-${slug}`,
      slug,
      name: `متجر ${slug}`,
      vatNumber: '300000000000003',
      vertical: 'retail',
      controlPlaneActorRef: OPERATOR,
      ...overrides,
    };
  }

  /**
   * Read a tenant id by slug through the login-resolution policy.
   *
   * The only lookup in the system that runs before a scope exists, and the one
   * the provisioner itself uses to resolve a replay (ADR-0012).
   */
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

  interface TenantRow {
    id: string;
    status: string;
    activatedAt: Date | null;
    suspendedAt: Date | null;
    suspensionReason: string | null;
    provisioningOperationId: string | null;
    provisioningRequestHash: string | null;
  }

  async function row(id: string): Promise<TenantRow | null> {
    return withTenant(prisma, id, async (tx) => {
      const rows = await tx.$queryRaw<TenantRow[]>`
        SELECT "id","status","activatedAt","suspendedAt","suspensionReason",
               "provisioningOperationId","provisioningRequestHash"
          FROM "tenants" WHERE "id" = ${id}::uuid`;
      return rows[0] ?? null;
    });
  }

  /** Ordered by id, which is UUIDv7 and therefore ordered by creation. */
  async function audit(id: string): Promise<readonly AuditRow[]> {
    return withTenant(prisma, id, async (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: id, entityType: 'tenant' },
        orderBy: { id: 'asc' },
        select: { id: true, eventType: true, actorUserId: true, entityId: true, metadata: true },
      }),
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

  /** A merchant user, so the authentication tests have somebody to be. */
  async function seedUser(tenant: string, email: string, role: RoleName): Promise<string> {
    const userId = newId();
    const passwordHash = await hashPassword(PASSWORD, FAST);
    await withTenant(prisma, tenant, async (tx) => {
      const branchId = newId();
      await tx.branch.create({
        data: {
          id: branchId,
          tenantId: tenant,
          code: '01',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: userId,
          tenantId: tenant,
          email,
          displayName: 'ندى',
          passwordHash,
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: {
          id: newId(),
          tenantId: tenant,
          userId,
          defaultBranchId: branchId,
          updatedAt: new Date(),
        },
      });
      const target = await tx.role.findFirst({ where: { tenantId: tenant, key: role } });
      if (target === null) throw new Error(`role ${role} was not provisioned`);
      await tx.userRole.create({
        data: { id: newId(), tenantId: tenant, userId, roleId: target.id },
      });
    });
    return userId;
  }

  /**
   * A third connection holding a tenant row, so a race can be *ordered* rather
   * than hoped for.
   *
   * Lifted unchanged in shape from the drawer suite (ADR-0017): each contender
   * is started and then observed queueing on the held row before the next is
   * started, and only then is the holder released. PostgreSQL grants row locks
   * in the order waiters arrived, so the sequence under test is the sequence
   * that happens.
   */
  class Gate {
    private constructor(
      private readonly client: pg.Client,
      private readonly pid: number,
    ) {}

    static async hold(tenant: string): Promise<Gate> {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      await client.query('SELECT "id" FROM "tenants" WHERE "id" = $1 FOR UPDATE', [tenant]);
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error('no backend pid');
      return new Gate(client, pid);
    }

    /**
     * Hold the whole `tenants` table against INSERT.
     *
     * Provisioning races cannot be gated on a row, because the row is what the
     * contenders are trying to create.
     *
     * SHARE is the weakest mode that does the job. An INSERT takes ROW
     * EXCLUSIVE, which conflicts with exactly four modes — SHARE, SHARE ROW
     * EXCLUSIVE, EXCLUSIVE and ACCESS EXCLUSIVE — and SHARE is the least
     * invasive of them. It leaves ACCESS SHARE alone, so ordinary SELECTs run
     * (including the losing contender's login-slug resolution), and it leaves
     * ROW SHARE alone, so even `SELECT ... FOR UPDATE` is unaffected. The only
     * thing this gate stops is the write the race is about.
     *
     * Nothing in production takes this lock. It exists for the duration of one
     * test, on a throwaway database, and the code under test is unaware of it.
     */
    static async holdTenantsTable(): Promise<Gate> {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await client.query('BEGIN');
      await client.query('LOCK TABLE "tenants" IN SHARE MODE');
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error('no backend pid');
      return new Gate(client, pid);
    }

    /**
     * Wait until `count` backends are queued behind this gate's row lock.
     *
     * `pg_blocking_pids` is computed from the lock manager at the moment it is
     * called, so it answers "is blocked now" — unlike `wait_event`, which a
     * backend keeps after it has stopped waiting. Recursive, because PostgreSQL
     * reports only the *direct* blocker: the second waiter is blocked by the
     * first, and the chain roots here.
     */
    async blocking(count: number): Promise<void> {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const { rows } = await this.client.query<{ n: string }>(
          `WITH RECURSIVE queued AS (
             SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a
               JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
              WHERE a.datname = current_database()
           )
           SELECT count(*)::text AS n FROM queued`,
          [this.pid],
        );
        if (Number(rows[0]?.n ?? '0') >= count) return;
        if (Date.now() > deadline) {
          const { rows: all } = await this.client.query(
            `SELECT pid, state, pg_blocking_pids(pid) AS blockers, left(query, 70) AS q
               FROM pg_stat_activity WHERE datname = current_database()`,
          );
          throw new Error(
            `Only ${rows[0]?.n ?? '0'} of ${count} blocked (gate ${this.pid}): ${JSON.stringify(all)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }

    async release(): Promise<void> {
      await this.client.query('COMMIT');
      await this.client.end();
    }
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    second = createPrismaClient(url);
    // Force the second pool to open a backend now, so a race is not waiting on
    // a connection handshake it could mistake for a lock.
    await second.$queryRaw`SELECT 1`;

    for (const slug of ALL_SLUGS) await purge(slug);
    await provisionPermissionCatalogue(prisma);

    auth = createAuthService({
      repository: createAuthRepository(prisma),
      audit: createAuditRepository(prisma),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    });
  }, 120_000);

  afterAll(async () => {
    for (const slug of ALL_SLUGS) await purge(slug);
    await prisma.$disconnect();
    await second.$disconnect();
  });

  // -------------------------------------------------------------------------
  // A. provisioning
  // -------------------------------------------------------------------------

  it('A. provisioning creates one atomic foundation, in provisioning state', async () => {
    const result = await provisionTenant(prisma, request(ALPHA));
    minted.set(ALPHA, result.id);

    expect(result.created).toBe(true);
    // Not active. A tenant becomes usable because somebody decided to admit it,
    // never because a row appeared.
    expect(result.status).toBe('provisioning');
    expect(result.slug).toBe(ALPHA);

    const tenant = await row(result.id);
    expect(tenant?.status).toBe('provisioning');
    expect(tenant?.activatedAt).toBeNull();
    expect(tenant?.suspendedAt).toBeNull();
    expect(tenant?.suspensionReason).toBeNull();
    expect(tenant?.provisioningOperationId).toBe(`op-${ALPHA}`);
    expect(tenant?.provisioningRequestHash).toEqual(expect.any(String));

    // Settings, and exactly the settings asked for.
    const settings = await withTenant(prisma, result.id, async (tx) =>
      tx.tenantSettings.findFirst({ where: { tenantId: result.id } }),
    );
    expect(settings?.vertical).toBe('retail');

    // The four default roles, with the exact bindings the domain defines —
    // read back from the database rather than from the return value.
    const roles = await withTenant(prisma, result.id, async (tx) =>
      tx.role.findMany({ where: { tenantId: result.id }, orderBy: { key: 'asc' } }),
    );
    expect(roles.map((role) => role.key).sort()).toEqual(['admin', 'cashier', 'manager', 'owner']);
    for (const role of roles) {
      const bindings = await withTenant(prisma, result.id, async (tx) =>
        tx.rolePermission.findMany({ where: { tenantId: result.id, roleId: role.id } }),
      );
      const expected = ROLE_PERMISSIONS[role.key as RoleName];
      expect(bindings.map((binding) => binding.permissionKey).sort()).toEqual([...expected].sort());
      expect(role.isSystem).toBe(true);
    }

    // One audit event, with no fabricated user behind it.
    const events = await audit(result.id);
    expect(events.map((event) => event.eventType)).toEqual(['tenant.provisioned']);
    expect(events[0]?.actorUserId).toBeNull();
    expect(events[0]?.entityId).toBe(result.id);
    expect(events[0]?.metadata).toMatchObject({
      controlPlaneActorRef: OPERATOR,
      operationId: `op-${ALPHA}`,
      slug: ALPHA,
    });

    // 4A creates a tenant, not a business. Branches, terminals and users are
    // 4B/4D's, and provisioning must not quietly invent any.
    const counts = await withTenant(prisma, result.id, async (tx) => ({
      branches: await tx.branch.count({ where: { tenantId: result.id } }),
      terminals: await tx.terminal.count({ where: { tenantId: result.id } }),
      users: await tx.user.count({ where: { tenantId: result.id } }),
    }));
    expect(counts).toEqual({ branches: 0, terminals: 0, users: 0 });
  }, 60_000);

  it('B. the same operation with the same intent replays exactly', async () => {
    const first = minted.get(ALPHA);
    const again = await provisionTenant(prisma, request(ALPHA));

    expect(again.created).toBe(false);
    expect(again.id).toBe(first);
    expect(again.slug).toBe(ALPHA);
    expect(again.roles.map((role) => role.key).sort()).toEqual([
      'admin',
      'cashier',
      'manager',
      'owner',
    ]);

    // A replay creates nothing — not a second tenant, and not a second event.
    const events = await audit(again.id);
    expect(events.map((event) => event.eventType)).toEqual(['tenant.provisioned']);
  }, 60_000);

  it('C. the same operation with a different intent is a conflict', async () => {
    // Same id, same slug, different name: a retry that changed its mind.
    const changed = await refusal(() =>
      provisionTenant(prisma, request(ALPHA, { name: 'A Different Merchant' })),
    );
    expect(changed).toBeInstanceOf(TenantProvisioningError);
    expect((changed as TenantProvisioningError).detail).toBe('request-mismatch');

    // Same id, different slug: this id already made a merchant elsewhere, and
    // handing that one back would be an identity swap wearing a retry's
    // clothes.
    const elsewhere = await refusal(() =>
      provisionTenant(prisma, request(ELSEWHERE, { operationId: `op-${ALPHA}` })),
    );
    expect(elsewhere).toBeInstanceOf(TenantProvisioningError);
    expect((elsewhere as TenantProvisioningError).detail).toBe('operation-id-reused');

    // Neither attempt left anything behind.
    expect(await resolveId(ELSEWHERE)).toBeNull();
    const events = await audit(minted.get(ALPHA) ?? '');
    expect(events).toHaveLength(1);
  }, 60_000);

  it('D. the same slug under a different operation is a conflict', async () => {
    const taken = await refusal(() =>
      provisionTenant(prisma, request(ALPHA, { operationId: 'op-somebody-else' })),
    );
    expect(taken).toBeInstanceOf(TenantProvisioningError);
    expect((taken as TenantProvisioningError).detail).toBe('slug-taken');

    // The original is untouched: same id, same operation, same fingerprint.
    const tenant = await row(minted.get(ALPHA) ?? '');
    expect(tenant?.provisioningOperationId).toBe(`op-${ALPHA}`);
  }, 60_000);

  it('E. a failure part-way through rolls back every piece of the foundation', async () => {
    // A generator that hands out one id for everything. The tenant row and the
    // first role take it; the second role collides on the primary key and the
    // transaction dies — after the tenant, its settings and one role were
    // already written.
    const stuck = newId();
    const broken = await refusal(() =>
      provisionTenant(
        prisma,
        request(ROLLBACK, { operationId: `op-${ROLLBACK}` }),
        () => new Date(),
        () => stuck,
      ),
    );
    expect(broken.message).toMatch(/unique|duplicate|constraint/i);

    // No tenant, and therefore no settings, roles or audit row: they are all
    // children of a row that no longer exists.
    expect(await resolveId(ROLLBACK)).toBeNull();

    // And no tombstone. The failed attempt's operation id is still usable,
    // which is the difference between a rollback and a poisoned key.
    const retried = await provisionTenant(prisma, request(ROLLBACK));
    expect(retried.created).toBe(true);
    expect(retried.status).toBe('provisioning');
    minted.set(ROLLBACK, retried.id);
    expect((await audit(retried.id)).map((event) => event.eventType)).toEqual([
      'tenant.provisioned',
    ]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Concurrent provisioning
  // -------------------------------------------------------------------------
  //
  // Everything above raced on a tenant row. These cannot: the row is what the
  // contenders are competing to create, so the boundary under test is the pair
  // of unique indexes plus `ON CONFLICT DO NOTHING`, and the gate has to be the
  // table. Each test proves both contenders were queued on that table before
  // either was allowed to proceed — the ordering is directed, not hoped for.

  it('P. two identical provisioning calls at once make one tenant and one replay', async () => {
    const gate = await Gate.holdTenantsTable();

    const one = provisionTenant(prisma, request(RACE_SAME));
    await gate.blocking(1);
    const two = provisionTenant(second, request(RACE_SAME));
    await gate.blocking(2);
    await gate.release();

    const [first, other] = await Promise.all([one, two]);
    minted.set(RACE_SAME, first.id);

    // Exactly one created it; the other resolved the same tenant.
    expect([first.created, other.created].filter(Boolean)).toHaveLength(1);
    expect(first.id).toBe(other.id);
    expect(first.slug).toBe(RACE_SAME);
    expect(other.slug).toBe(RACE_SAME);
    expect(first.status).toBe('provisioning');
    expect(other.status).toBe('provisioning');
    // The replay is handed the same foundation, read from the database.
    expect(other.roles.map((role) => role.key).sort()).toEqual([
      'admin',
      'cashier',
      'manager',
      'owner',
    ]);

    // One tenant holds the slug, and its foundation was built exactly once.
    const holders = await withLoginSlug(
      prisma,
      RACE_SAME,
      async (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "tenants" WHERE "slug" = ${RACE_SAME}`,
    );
    expect(holders).toEqual([{ id: first.id }]);

    const foundation = await withTenant(prisma, first.id, async (tx) => ({
      settings: await tx.tenantSettings.count({ where: { tenantId: first.id } }),
      roles: await tx.role.count({ where: { tenantId: first.id } }),
      bindings: await tx.rolePermission.count({ where: { tenantId: first.id } }),
      branches: await tx.branch.count({ where: { tenantId: first.id } }),
    }));
    expect(foundation).toEqual({
      settings: 1,
      roles: 4,
      bindings: Object.values(ROLE_PERMISSIONS).reduce((sum, list) => sum + list.length, 0),
      branches: 0,
    });

    expect((await audit(first.id)).map((event) => event.eventType)).toEqual(['tenant.provisioned']);
  }, 120_000);

  it('Q. two operations racing for one slug leave one tenant and one refusal', async () => {
    const gate = await Gate.holdTenantsTable();

    const one = provisionTenant(prisma, request(RACE_SLUG, { operationId: 'op-race-slug-one' }));
    await gate.blocking(1);
    const two = provisionTenant(second, request(RACE_SLUG, { operationId: 'op-race-slug-two' }));
    await gate.blocking(2);
    await gate.release();

    const settled = await Promise.allSettled([one, two]);
    const winners = settled.filter((result) => result.status === 'fulfilled');
    const losers = settled.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winner = winners[0];
    if (winner?.status !== 'fulfilled') throw new Error('unreachable');
    minted.set(RACE_SLUG, winner.value.id);
    expect(winner.value.created).toBe(true);

    const loser = losers[0];
    if (loser?.status !== 'rejected') throw new Error('unreachable');
    expect(loser.reason).toBeInstanceOf(TenantProvisioningError);
    expect((loser.reason as TenantProvisioningError).detail).toBe('slug-taken');

    // One tenant, one foundation, one event. The loser wrote nothing at all —
    // its INSERT was refused before any child row could exist.
    const holders = await withLoginSlug(
      prisma,
      RACE_SLUG,
      async (tx) =>
        tx.$queryRaw<{ id: string; provisioningOperationId: string | null }[]>`
        SELECT "id","provisioningOperationId" FROM "tenants" WHERE "slug" = ${RACE_SLUG}`,
    );
    expect(holders).toHaveLength(1);
    expect(holders[0]?.id).toBe(winner.value.id);

    const foundation = await withTenant(prisma, winner.value.id, async (tx) => ({
      settings: await tx.tenantSettings.count(),
      roles: await tx.role.count(),
      audits: await tx.auditEvent.count(),
    }));
    expect(foundation).toEqual({ settings: 1, roles: 4, audits: 1 });
  }, 120_000);

  it('R. one operation racing for two slugs makes one tenant and no second', async () => {
    const gate = await Gate.holdTenantsTable();
    const shared = 'op-race-shared';

    const one = provisionTenant(prisma, request(RACE_OP_ONE, { operationId: shared }));
    await gate.blocking(1);
    const two = provisionTenant(second, request(RACE_OP_TWO, { operationId: shared }));
    await gate.blocking(2);
    await gate.release();

    const settled = await Promise.allSettled([one, two]);
    const winners = settled.filter((result) => result.status === 'fulfilled');
    const losers = settled.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winner = winners[0];
    if (winner?.status !== 'fulfilled') throw new Error('unreachable');
    expect(winner.value.created).toBe(true);
    minted.set(winner.value.slug, winner.value.id);

    // The loser's slug is free, so the index that refused its INSERT was the
    // one on the operation id. Handing back the winner's merchant would be an
    // identity swap wearing a retry's clothes.
    const loser = losers[0];
    if (loser?.status !== 'rejected') throw new Error('unreachable');
    expect(loser.reason).toBeInstanceOf(TenantProvisioningError);
    expect((loser.reason as TenantProvisioningError).detail).toBe('operation-id-reused');

    const other = winner.value.slug === RACE_OP_ONE ? RACE_OP_TWO : RACE_OP_ONE;
    expect(await resolveId(other)).toBeNull();

    const foundation = await withTenant(prisma, winner.value.id, async (tx) => ({
      settings: await tx.tenantSettings.count(),
      roles: await tx.role.count(),
      audits: await tx.auditEvent.count(),
    }));
    expect(foundation).toEqual({ settings: 1, roles: 4, audits: 1 });
  }, 120_000);

  // -------------------------------------------------------------------------
  // F. the database's own opinion
  // -------------------------------------------------------------------------

  it('F. the database refuses a status it has never heard of', async () => {
    const id = minted.get(ALPHA) ?? '';

    // The pre-4A vocabulary. It compiles nowhere any more, and it does not
    // persist either. `activatedAt` is set in the same statement so that this
    // row leaves exactly one constraint to refuse it, and the assertion names
    // which one rather than accepting whichever fired first.
    const closed = await refusal(() =>
      withTenant(prisma, id, async (tx) => {
        await tx.$executeRaw`
          UPDATE "tenants" SET "status" = 'closed', "activatedAt" = now()
           WHERE "id" = ${id}::uuid`;
      }),
    );
    expect(closed.message).toMatch(/tenants_status_known/);

    // A tenant whose history Korvi recorded may not claim to be admitted
    // without saying when.
    const admittedWithoutSaying = await refusal(() =>
      withTenant(prisma, id, async (tx) => {
        await tx.$executeRaw`
          UPDATE "tenants" SET "status" = 'active' WHERE "id" = ${id}::uuid`;
      }),
    );
    expect(admittedWithoutSaying.message).toMatch(/tenants_recorded_lifecycle_complete/);

    // When and why arrive together or not at all — for a legacy row as much as
    // a recorded one. Half a suspension is not representable.
    const halfSuspended = await refusal(() =>
      withTenant(prisma, id, async (tx) => {
        await tx.$executeRaw`
          UPDATE "tenants"
             SET "status" = 'suspended', "activatedAt" = now(), "suspendedAt" = now()
           WHERE "id" = ${id}::uuid`;
      }),
    );
    expect(halfSuspended.message).toMatch(/tenants_suspension_evidence_paired/);

    // And a reason that is not a reason — untrimmed, or longer than the column
    // will hold — is refused rather than quietly cut short.
    const sloppyReason = await refusal(() =>
      withTenant(prisma, id, async (tx) => {
        await tx.$executeRaw`
          UPDATE "tenants"
             SET "status" = 'suspended', "activatedAt" = now(),
                 "suspendedAt" = now(), "suspensionReason" = '  padded  '
           WHERE "id" = ${id}::uuid`;
      }),
    );
    expect(sloppyReason.message).toMatch(/tenants_suspension_reason_bounded/);

    // Provenance is a closed vocabulary too: a row cannot claim a third kind
    // of history and thereby escape the invariants attached to both.
    const inventedProvenance = await refusal(() =>
      withTenant(prisma, id, async (tx) => {
        await tx.$executeRaw`
          UPDATE "tenants" SET "lifecycleProvenance" = 'assumed' WHERE "id" = ${id}::uuid`;
      }),
    );
    expect(inventedProvenance.message).toMatch(/tenants_lifecycle_provenance_known/);

    // And the new-row default is the safe one, even for a row nobody routed
    // through the control plane.
    const scratch = newId();
    const defaults = await withTenant(prisma, scratch, async (tx) => {
      const inserted = await tx.$queryRaw<{ status: string; lifecycleProvenance: string }[]>`
        INSERT INTO "tenants" ("id","name","slug","updatedAt")
        VALUES (${scratch}::uuid, 'Accidental', ${`${NEIGHBOUR}-scratch`}, now())
        RETURNING "status", "lifecycleProvenance"`;
      const value = inserted[0];
      await tx.$executeRaw`DELETE FROM "tenants" WHERE "id" = ${scratch}::uuid`;
      return value;
    });
    // Provisioning, and `recorded` — a row created after this migration has no
    // unknown history to inherit, so the permissive legacy shape is not its
    // default and cannot be reached by omission.
    expect(defaults).toEqual({ status: 'provisioning', lifecycleProvenance: 'recorded' });
  }, 60_000);

  // -------------------------------------------------------------------------
  // G, H. the state machine
  // -------------------------------------------------------------------------

  it('G. provisioning -> active succeeds and is recorded', async () => {
    const id = minted.get(ALPHA) ?? '';
    const result = await activateTenant(prisma, {
      tenantId: id,
      operationId: 'op-activate-alpha',
      controlPlaneActorRef: OPERATOR,
    });

    expect(result).toMatchObject({ id, status: 'active', changed: true, revokedSessions: 0 });

    const tenant = await row(id);
    expect(tenant?.status).toBe('active');
    expect(tenant?.activatedAt).not.toBeNull();

    const events = await audit(id);
    expect(events.map((event) => event.eventType)).toEqual([
      'tenant.provisioned',
      'tenant.activated',
    ]);
    expect(events[1]?.actorUserId).toBeNull();
    expect(events[1]?.metadata).toMatchObject({
      controlPlaneActorRef: OPERATOR,
      fromStatus: 'provisioning',
      toStatus: 'active',
    });
  }, 60_000);

  it('H. every move the machine does not have fails closed', async () => {
    const active = minted.get(ALPHA) ?? '';
    const provisioning = minted.get(ROLLBACK) ?? '';

    const cases: readonly [string, () => Promise<unknown>][] = [
      // Already active: reactivate has nowhere to come from.
      [
        'reactivate an active tenant',
        () =>
          reactivateTenant(prisma, {
            tenantId: active,
            operationId: newId(),
            controlPlaneActorRef: OPERATOR,
          }),
      ],
      // Never admitted: suspension starts from active.
      [
        'suspend a provisioning tenant',
        () =>
          suspendTenant(prisma, {
            tenantId: provisioning,
            operationId: newId(),
            controlPlaneActorRef: OPERATOR,
            reason: 'not yet trading',
          }),
      ],
      // Activation is only ever the first admission.
      [
        'activate an active tenant',
        () =>
          activateTenant(prisma, {
            tenantId: active,
            operationId: newId(),
            controlPlaneActorRef: OPERATOR,
          }),
      ],
    ];

    for (const [label, work] of cases) {
      const error = await refusal(work);
      expect(error, label).toBeInstanceOf(TenantLifecycleRefusedError);
      expect((error as TenantLifecycleRefusedError).detail, label).toBe('illegal-transition');
    }

    // A tenant that does not exist is its own answer, and this is a trusted
    // internal surface, so it says so rather than pretending.
    const missing = await refusal(() =>
      activateTenant(prisma, {
        tenantId: newId(),
        operationId: newId(),
        controlPlaneActorRef: OPERATOR,
      }),
    );
    expect((missing as TenantLifecycleRefusedError).detail).toBe('unknown-tenant');

    // A refused move writes nothing at all.
    expect((await audit(active)).map((event) => event.eventType)).toEqual([
      'tenant.provisioned',
      'tenant.activated',
    ]);
    expect((await row(provisioning))?.status).toBe('provisioning');
  }, 60_000);

  // -------------------------------------------------------------------------
  // I, J, K. suspension and what it does to a session
  // -------------------------------------------------------------------------

  it('I. active -> suspended revokes every live session in the same transaction', async () => {
    const id = minted.get(ALPHA) ?? '';
    await seedUser(id, `nada@${ALPHA}.test`, 'manager');

    // Two live sessions and one the user already ended, so the count is a
    // count of what was actually running.
    const first = await auth.login({
      tenantSlug: ALPHA,
      email: `nada@${ALPHA}.test`,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    const secondLogin = await auth.login({
      tenantSlug: ALPHA,
      email: `nada@${ALPHA}.test`,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    const ended = await auth.login({
      tenantSlug: ALPHA,
      email: `nada@${ALPHA}.test`,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    if (first.outcome !== 'success' || secondLogin.outcome !== 'success') {
      throw new Error('expected two live sessions');
    }
    if (ended.outcome !== 'success') throw new Error('expected a third session');
    await auth.logout(ended.token);

    minted.set(`${ALPHA}:token`, first.token);
    await expect(auth.authenticate(first.token)).resolves.toMatchObject({ outcome: 'success' });

    const result = await suspendTenant(prisma, {
      tenantId: id,
      operationId: 'op-suspend-alpha',
      controlPlaneActorRef: OPERATOR,
      reason: '  unpaid subscription  ',
    });

    expect(result).toMatchObject({ id, status: 'suspended', changed: true });
    // The two that were live, and not the one that had already ended.
    expect(result.revokedSessions).toBe(2);

    const tenant = await row(id);
    expect(tenant?.status).toBe('suspended');
    expect(tenant?.suspendedAt).not.toBeNull();
    // Trimmed, never truncated.
    expect(tenant?.suspensionReason).toBe('unpaid subscription');

    const live = await withTenant(prisma, id, async (tx) =>
      tx.session.count({ where: { tenantId: id, revokedAt: null } }),
    );
    expect(live).toBe(0);

    const events = await audit(id);
    expect(events.map((event) => event.eventType)).toEqual([
      'tenant.provisioned',
      'tenant.activated',
      'tenant.suspended',
    ]);
    expect(events[2]?.metadata).toMatchObject({
      controlPlaneActorRef: OPERATOR,
      fromStatus: 'active',
      toStatus: 'suspended',
      reason: 'unpaid subscription',
      revokedSessions: 2,
    });
  }, 120_000);

  it('J. a suspended tenant is refused at login, and says nothing about why', async () => {
    // The route, not the service, because the route is what the outside world
    // can see. Every refusal below has to be the same bytes.
    const app = Fastify({ logger: false });
    registerAuthRoutes(app, { service: auth, guards: createGuards(auth, CONFIG), config: CONFIG });
    await app.ready();

    const post = async (body: Record<string, string>): Promise<{ code: number; body: string }> => {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: body });
      return { code: response.statusCode, body: response.body };
    };

    const suspended = await post({
      tenantSlug: ALPHA,
      email: `nada@${ALPHA}.test`,
      password: PASSWORD,
    });
    const provisioning = await post({
      tenantSlug: ROLLBACK,
      email: `nada@${ALPHA}.test`,
      password: PASSWORD,
    });
    const nonexistent = await post({
      tenantSlug: '4a-live-nobody',
      email: `nada@${ALPHA}.test`,
      password: PASSWORD,
    });
    const wrongPassword = await post({
      tenantSlug: ALPHA,
      email: `nada@${ALPHA}.test`,
      password: 'not-the-password',
    });

    // Correct credentials on a suspended tenant are refused.
    expect(suspended.code).toBe(401);
    // And the four cases are indistinguishable: suspended, never admitted, no
    // such merchant, and a wrong password all answer identically. A caller who
    // could tell them apart could enumerate the platform's customers.
    for (const answer of [provisioning, nonexistent, wrongPassword]) {
      expect(answer.code).toBe(suspended.code);
      expect(answer.body).toBe(suspended.body);
    }
    // No cookie on any of them.
    expect(suspended.body).not.toMatch(/session/i);

    await app.close();
  }, 120_000);

  it('K. reactivation restores the tenant and resurrects no session', async () => {
    const id = minted.get(ALPHA) ?? '';
    const token = minted.get(`${ALPHA}:token`) ?? '';

    const result = await reactivateTenant(prisma, {
      tenantId: id,
      operationId: 'op-reactivate-alpha',
      controlPlaneActorRef: OPERATOR,
    });
    expect(result).toMatchObject({ id, status: 'active', changed: true, revokedSessions: 0 });

    const tenant = await row(id);
    expect(tenant?.status).toBe('active');
    // The present is clean; the history of the suspension is in the audit trail.
    expect(tenant?.suspendedAt).toBeNull();
    expect(tenant?.suspensionReason).toBeNull();
    // Admission is not undone and not re-dated by a suspension round trip.
    expect(tenant?.activatedAt).not.toBeNull();

    // The mandatory part: a session revoked by the suspension stays revoked.
    const replayed = await auth.authenticate(token);
    expect(replayed.outcome === 'failure' && replayed.reason).toBe('revoked');

    const live = await withTenant(prisma, id, async (tx) =>
      tx.session.count({ where: { tenantId: id, revokedAt: null } }),
    );
    expect(live).toBe(0);

    // The user signs in again, and that is the only way back.
    const fresh = await auth.login({
      tenantSlug: ALPHA,
      email: `nada@${ALPHA}.test`,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    expect(fresh.outcome).toBe('success');
    if (fresh.outcome !== 'success') throw new Error('unreachable');
    await expect(auth.authenticate(fresh.token)).resolves.toMatchObject({ outcome: 'success' });
  }, 120_000);

  // -------------------------------------------------------------------------
  // L. replay semantics
  // -------------------------------------------------------------------------

  it('L. a lifecycle operation replays, and a changed one conflicts', async () => {
    const id = minted.get(ALPHA) ?? '';

    // Suspend once more so there is a committed operation to replay against.
    const suspended = await suspendTenant(prisma, {
      tenantId: id,
      operationId: 'op-suspend-alpha-2',
      controlPlaneActorRef: OPERATOR,
      reason: 'second suspension',
    });
    expect(suspended.changed).toBe(true);

    const before = await audit(id);

    // The same operation, the same actor, the same reason — including one that
    // differs only by whitespace, which is the same intent to a human.
    const replay = await suspendTenant(prisma, {
      tenantId: id,
      operationId: 'op-suspend-alpha-2',
      controlPlaneActorRef: OPERATOR,
      reason: '  second suspension ',
    });
    expect(replay).toMatchObject({ id, status: 'suspended', changed: false, revokedSessions: 0 });

    // A different reason under the same id is a different operation wearing a
    // retry's name.
    const changedReason = await refusal(() =>
      suspendTenant(prisma, {
        tenantId: id,
        operationId: 'op-suspend-alpha-2',
        controlPlaneActorRef: OPERATOR,
        reason: 'a different reason entirely',
      }),
    );
    expect((changedReason as TenantLifecycleRefusedError).detail).toBe('idempotency-conflict');

    // So is a different operator. Binding the actor is what stops an operation
    // id becoming a bearer token for somebody else's decision.
    const changedActor = await refusal(() =>
      suspendTenant(prisma, {
        tenantId: id,
        operationId: 'op-suspend-alpha-2',
        controlPlaneActorRef: 'ops:platform/someone-else',
        reason: 'second suspension',
      }),
    );
    expect((changedActor as TenantLifecycleRefusedError).detail).toBe('idempotency-conflict');

    // A *different* operation asking for a move that has already happened is
    // not a replay — it is an illegal transition.
    const other = await refusal(() =>
      suspendTenant(prisma, {
        tenantId: id,
        operationId: newId(),
        controlPlaneActorRef: OPERATOR,
        reason: 'yet another',
      }),
    );
    expect((other as TenantLifecycleRefusedError).detail).toBe('illegal-transition');

    // None of the four wrote anything.
    expect(await audit(id)).toHaveLength(before.length);
  }, 120_000);

  // -------------------------------------------------------------------------
  // M. concurrency
  // -------------------------------------------------------------------------

  it('M. two operators suspending at once serialise, and only one moves', async () => {
    const provisioned = await provisionTenant(prisma, request(RACE_A));
    minted.set(RACE_A, provisioned.id);
    await activateTenant(prisma, {
      tenantId: provisioned.id,
      operationId: `op-activate-${RACE_A}`,
      controlPlaneActorRef: OPERATOR,
    });

    const gate = await Gate.hold(provisioned.id);

    const one = suspendTenant(prisma, {
      tenantId: provisioned.id,
      operationId: 'op-race-one',
      controlPlaneActorRef: OPERATOR,
      reason: 'first operator',
    });
    // Demonstrably queued on the tenant row, not merely started.
    await gate.blocking(1);

    const two = suspendTenant(second, {
      tenantId: provisioned.id,
      operationId: 'op-race-two',
      controlPlaneActorRef: 'ops:platform/omar',
      reason: 'second operator',
    });
    await gate.blocking(2);
    await gate.release();

    // Settled together rather than awaited in turn. The loser rejects while
    // `one` is still pending, and a rejection nobody is awaiting yet is an
    // unhandled rejection — which Vitest reports as a run-level error even
    // though every assertion passes.
    const settled = await Promise.allSettled([one, two]);
    const [first, second_] = settled;
    if (first?.status !== 'fulfilled') throw new Error('the first contender should have won');
    expect(first.value).toMatchObject({ status: 'suspended', changed: true });

    // The loser was granted the lock second, saw a suspended tenant, and — its
    // operation id being its own — was told the move is not available.
    if (second_?.status !== 'rejected') throw new Error('the second contender should have lost');
    expect((second_.reason as TenantLifecycleRefusedError).detail).toBe('illegal-transition');

    // One reason, one audit event, one reservation.
    const tenant = await row(provisioned.id);
    expect(tenant?.suspensionReason).toBe('first operator');
    const events = await audit(provisioned.id);
    expect(events.filter((event) => event.eventType === 'tenant.suspended')).toHaveLength(1);
    const keys = await withTenant(prisma, provisioned.id, async (tx) =>
      tx.idempotencyKey.count({ where: { tenantId: provisioned.id, scope: 'tenant-lifecycle' } }),
    );
    // Activation and the winning suspension. The loser left no tombstone.
    expect(keys).toBe(2);
  }, 120_000);

  it('M. two copies of the same operation produce one change and one replay', async () => {
    const provisioned = await provisionTenant(prisma, request(RACE_B));
    minted.set(RACE_B, provisioned.id);
    await activateTenant(prisma, {
      tenantId: provisioned.id,
      operationId: `op-activate-${RACE_B}`,
      controlPlaneActorRef: OPERATOR,
    });

    const gate = await Gate.hold(provisioned.id);
    const intent = {
      tenantId: provisioned.id,
      operationId: 'op-race-same',
      controlPlaneActorRef: OPERATOR,
      reason: 'one decision, two deliveries',
    } as const;

    const one = suspendTenant(prisma, intent);
    await gate.blocking(1);
    const two = suspendTenant(second, intent);
    await gate.blocking(2);
    await gate.release();

    const [first, secondResult] = await Promise.all([one, two]);
    // Exactly one of them moved anything, and neither failed.
    expect([first.changed, secondResult.changed].filter(Boolean)).toHaveLength(1);
    expect(first.status).toBe('suspended');
    expect(secondResult.status).toBe('suspended');

    const events = await audit(provisioned.id);
    expect(events.filter((event) => event.eventType === 'tenant.suspended')).toHaveLength(1);
  }, 120_000);

  // -------------------------------------------------------------------------
  // N. the boundary the whole platform rests on
  // -------------------------------------------------------------------------

  it('N. tenant isolation is intact, and this suite is entitled to say so', async () => {
    // First: the role running these tests can be refused. A superuser or a
    // BYPASSRLS role would make every assertion below pass for the wrong
    // reason, so it is checked rather than assumed.
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const { rows: role } = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      forced: boolean;
      enabled: boolean;
    }>(
      `SELECT r.rolsuper, r.rolbypassrls,
              c.relforcerowsecurity AS forced, c.relrowsecurity AS enabled
         FROM pg_roles r, pg_class c
        WHERE r.rolname = current_user AND c.relname = 'tenants'`,
    );
    expect(role[0]?.rolsuper).toBe(false);
    expect(role[0]?.rolbypassrls).toBe(false);
    // The lifecycle migration lifts FORCE for one backfill inside its own
    // transaction. This is the assertion that it put it back.
    expect(role[0]?.enabled).toBe(true);
    expect(role[0]?.forced).toBe(true);
    await client.end();

    const neighbour = await provisionTenant(prisma, request(NEIGHBOUR));
    minted.set(NEIGHBOUR, neighbour.id);
    const alpha = minted.get(ALPHA) ?? '';

    // Under one tenant's context, the other does not exist — not its row, not
    // its audit trail, not its reservations.
    const seen = await withTenant(prisma, neighbour.id, async (tx) => ({
      tenants: await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "tenants"`,
      audits: await tx.auditEvent.count(),
      keys: await tx.idempotencyKey.count(),
      sessions: await tx.session.count(),
    }));
    expect(seen.tenants.map((tenant) => tenant.id)).toEqual([neighbour.id]);
    expect(seen.audits).toBe(1);
    expect(seen.keys).toBe(0);
    expect(seen.sessions).toBe(0);

    // And a lifecycle mutation cannot reach across, even holding a real id:
    // the row is invisible in the wrong context, so it reads as unknown rather
    // than as somebody else's.
    const across = await refusal(() =>
      withTenant(prisma, neighbour.id, async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "tenants" WHERE "id" = ${alpha}::uuid FOR UPDATE`;
        if (rows.length === 0) throw new TenantLifecycleRefusedError('unknown-tenant');
        return rows;
      }),
    );
    expect((across as TenantLifecycleRefusedError).detail).toBe('unknown-tenant');

    // The login-slug door is still exactly one row wide, and still read-only.
    const resolved = await withLoginSlug(
      prisma,
      ALPHA,
      async (tx) => tx.$queryRaw<{ slug: string }[]>`SELECT "slug" FROM "tenants"`,
    );
    expect(resolved.map((tenant) => tenant.slug)).toEqual([ALPHA]);

    const written = await withLoginSlug(prisma, ALPHA, async (tx) =>
      tx.tenant.updateMany({ where: { id: alpha }, data: { name: 'Renamed' } }),
    );
    expect(written.count).toBe(0);
  }, 120_000);

  // -------------------------------------------------------------------------
  // O. the audit trail
  // -------------------------------------------------------------------------

  it('O. the audit trail names successful transitions and nothing else', async () => {
    const id = minted.get(ALPHA) ?? '';
    const events = await audit(id);

    // Exactly the transitions that committed, in the order they committed:
    // provisioned, activated, suspended, reactivated, suspended again. Every
    // refusal this suite has provoked against this tenant — an illegal move, a
    // conflicting replay, a request that changed its mind — is absent.
    expect(events.map((event) => event.eventType)).toEqual([
      'tenant.provisioned',
      'tenant.activated',
      'tenant.suspended',
      'tenant.reactivated',
      'tenant.suspended',
    ]);

    // No platform operator was smuggled in as one of the merchant's users.
    for (const event of events) {
      expect(event.actorUserId).toBeNull();
      expect(event.entityId).toBe(id);
    }

    // The metadata carries bounded operational facts and no credential
    // material: the operator reference, the operation, the states and the
    // reason are the whole vocabulary.
    const suspensions = events.filter((event) => event.eventType === 'tenant.suspended');
    expect(suspensions).toHaveLength(2);
    for (const event of suspensions) {
      const metadata = event.metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual([
        'controlPlaneActorRef',
        'fromStatus',
        'operationId',
        'reason',
        'revokedSessions',
        'toStatus',
      ]);
      expect(JSON.stringify(metadata)).not.toMatch(/password|token|secret|hash/i);
    }

    // Append-only in the shape that matters: nothing this strike added ever
    // updates or deletes an audit row, so the count only ever grows. Replaying
    // the last operation proves it — a replay changes state nowhere, including
    // here.
    await suspendTenant(prisma, {
      tenantId: id,
      operationId: 'op-suspend-alpha-2',
      controlPlaneActorRef: OPERATOR,
      reason: 'second suspension',
    });
    expect(await audit(id)).toHaveLength(events.length);
  }, 120_000);
  // -------------------------------------------------------------------------
  // Legacy rows, as the migration leaves them
  // -------------------------------------------------------------------------

  it('S. a tenant with no recorded history still trades, or is still stopped', async () => {
    // Exactly the two shapes the 4A migration leaves behind: status known,
    // admission unknown, and — for one that arrived already suspended — no
    // invented time or reason. Written directly, because no control-plane call
    // can produce them; the point is that the constraints permit them and the
    // application reads them correctly (ADR-0018).
    const trading = newId();
    const stopped = newId();

    for (const [id, slug, status] of [
      [trading, LEGACY, 'active'],
      [stopped, LEGACY_STOPPED, 'suspended'],
    ] as const) {
      await withTenant(prisma, id, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "tenants"
            ("id","name","slug","status","lifecycleProvenance","createdAt","updatedAt")
          VALUES (${id}::uuid, ${`متجر ${slug}`}, ${slug}, ${status}, 'legacy', now(), now())`;
        await tx.tenantSettings.create({ data: { tenantId: id, updatedAt: new Date() } });
      });
      minted.set(slug, id);
    }

    // Neither claims a fact it does not have.
    for (const id of [trading, stopped]) {
      const legacy = await withTenant(
        prisma,
        id,
        async (tx) =>
          tx.$queryRaw<
            {
              lifecycleProvenance: string;
              activatedAt: Date | null;
              suspendedAt: Date | null;
              suspensionReason: string | null;
            }[]
          >`SELECT "lifecycleProvenance","activatedAt","suspendedAt","suspensionReason"
            FROM "tenants" WHERE "id" = ${id}::uuid`,
      );
      expect(legacy[0]).toEqual({
        lifecycleProvenance: 'legacy',
        activatedAt: null,
        suspendedAt: null,
        suspensionReason: null,
      });
    }

    const passwordHash = await hashPassword(PASSWORD, FAST);
    for (const [id, slug] of [
      [trading, LEGACY],
      [stopped, LEGACY_STOPPED],
    ] as const) {
      await withTenant(prisma, id, async (tx) => {
        const branchId = newId();
        const userId = newId();
        await tx.branch.create({
          data: { id: branchId, tenantId: id, code: '01', nameAr: 'الفرع', updatedAt: new Date() },
        });
        await tx.user.create({
          data: {
            id: userId,
            tenantId: id,
            email: `nada@${slug}.test`,
            displayName: 'ندى',
            passwordHash,
            updatedAt: new Date(),
          },
        });
        await tx.tenantMembership.create({
          data: {
            id: newId(),
            tenantId: id,
            userId,
            defaultBranchId: branchId,
            updatedAt: new Date(),
          },
        });
      });
    }

    // An existing merchant keeps trading. That is the compatibility promise the
    // migration makes, and it is worth stating as behaviour rather than as a
    // column value.
    const allowed = await auth.login({
      tenantSlug: LEGACY,
      email: `nada@${LEGACY}.test`,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    expect(allowed.outcome).toBe('success');

    // And one that arrived stopped stays stopped, with correct credentials.
    const app = Fastify({ logger: false });
    registerAuthRoutes(app, { service: auth, guards: createGuards(auth, CONFIG), config: CONFIG });
    await app.ready();
    const post = async (slug: string): Promise<{ code: number; body: string }> => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { tenantSlug: slug, email: `nada@${slug}.test`, password: PASSWORD },
      });
      return { code: response.statusCode, body: response.body };
    };
    const refused = await post(LEGACY_STOPPED);
    const nobody = await post('4a-live-nobody-either');
    expect(refused.code).toBe(401);
    // Fail-closed, and still saying nothing about which kind of nothing.
    expect(refused.body).toBe(nobody.body);
    await app.close();
  }, 120_000);

  // -------------------------------------------------------------------------
  // Post-reservation rollback
  // -------------------------------------------------------------------------

  it('T. a failure after the reservation undoes the reservation too', async () => {
    const provisioned = await provisionTenant(prisma, request(FAULT));
    minted.set(FAULT, provisioned.id);
    const id = provisioned.id;
    await activateTenant(prisma, {
      tenantId: id,
      operationId: `op-activate-${FAULT}`,
      controlPlaneActorRef: OPERATOR,
    });
    await seedUser(id, `nada@${FAULT}.test`, 'manager');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await auth.login({
        tenantSlug: FAULT,
        email: `nada@${FAULT}.test`,
        password: PASSWORD,
        userAgent: 'vitest',
      });
      expect(session.outcome).toBe('success');
    }
    const liveBefore = await withTenant(prisma, id, async (tx) =>
      tx.session.count({ where: { tenantId: id, revokedAt: null } }),
    );
    expect(liveBefore).toBe(2);
    const auditBefore = await audit(id);

    /**
     * A fault installed in the database, not in the code under test.
     *
     * The suspension transaction reserves, revokes sessions, moves the tenant
     * and *then* appends its audit event. A trigger that refuses that last
     * insert fails the transaction at the one point where every earlier write
     * has already happened — which is the only way to prove they are one
     * transaction rather than four that usually succeed together.
     *
     * `id` is a UUID this test minted, so the interpolation below cannot carry
     * anything but a UUID. Production code is untouched and has no idea this
     * exists.
     */
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`
      CREATE FUNCTION korvi_test_refuse_suspension_audit() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."eventType" = 'tenant.suspended' AND NEW."tenantId" = '${id}'::uuid THEN
          RAISE EXCEPTION 'korvi test fault: audit write refused';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER korvi_test_refuse_suspension_audit
        BEFORE INSERT ON "audit_events"
        FOR EACH ROW EXECUTE FUNCTION korvi_test_refuse_suspension_audit();`);

    const failed = await refusal(() =>
      suspendTenant(prisma, {
        tenantId: id,
        operationId: 'op-fault-suspend',
        controlPlaneActorRef: OPERATOR,
        reason: 'the suspension that did not happen',
      }),
    );
    expect(failed.message).toMatch(/korvi test fault/);

    // Nothing that transaction did survives it.
    const after = await row(id);
    expect(after?.status).toBe('active');
    expect(after?.suspendedAt).toBeNull();
    expect(after?.suspensionReason).toBeNull();

    const liveAfter = await withTenant(prisma, id, async (tx) =>
      tx.session.count({ where: { tenantId: id, revokedAt: null } }),
    );
    expect(liveAfter).toBe(2);

    const reservations = await withTenant(prisma, id, async (tx) =>
      tx.idempotencyKey.count({
        where: { tenantId: id, scope: 'tenant-lifecycle', operationId: 'op-fault-suspend' },
      }),
    );
    // No tombstone. A rolled-back reservation that survived would block the
    // lawful retry below for ever.
    expect(reservations).toBe(0);

    expect((await audit(id)).map((event) => event.eventType)).toEqual(
      auditBefore.map((event) => event.eventType),
    );

    await admin.query(`
      DROP TRIGGER korvi_test_refuse_suspension_audit ON "audit_events";
      DROP FUNCTION korvi_test_refuse_suspension_audit();`);
    await admin.end();

    // The same operation id, unchanged, now does exactly what it was asked to.
    const retried = await suspendTenant(prisma, {
      tenantId: id,
      operationId: 'op-fault-suspend',
      controlPlaneActorRef: OPERATOR,
      reason: 'the suspension that did not happen',
    });
    expect(retried).toMatchObject({ id, status: 'suspended', changed: true, revokedSessions: 2 });

    const settled = await row(id);
    expect(settled?.suspensionReason).toBe('the suspension that did not happen');
    expect((await audit(id)).map((event) => event.eventType)).toEqual([
      ...auditBefore.map((event) => event.eventType),
      'tenant.suspended',
    ]);
  }, 180_000);
});

describe.skipIf(url !== '')('tenant lifecycle and provisioning, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
