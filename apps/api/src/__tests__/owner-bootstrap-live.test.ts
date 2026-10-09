import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  OWNER_BOOTSTRAP_ROLE_KEY,
  WeakCredentialError,
  newId,
  tenantId as brandTenantId,
} from '@korvi/domain';
import {
  OwnerBootstrapRefusedError,
  acceptOwnerBootstrap,
  activateTenant,
  createAuditRepository,
  createAuthRepository,
  createPrismaClient,
  issueOwnerBootstrapInvitation,
  provisionPermissionCatalogue,
  provisionTenant,
  readTenantOnboardingReadiness,
  withLoginSlug,
  withTenant,
} from '@korvi/database';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import type { AuthService } from '../auth/service.js';
import type { PrismaClient } from '@korvi/database';

/**
 * Initial owner bootstrap, against a real PostgreSQL server.
 *
 * Every claim in 4D-3 is a claim about what the database does when a forged
 * capability arrives, when two acceptances arrive together, or when a
 * transaction fails after it has already written a credential. None of that can
 * be answered by a fake, so none of it is asserted anywhere but here.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with every
 * migration applied, connected as the application role — not a superuser and
 * not a BYPASSRLS role. That is asserted rather than assumed.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const KEY = 'bootstrap-signing-key-for-tests-only-0123456789';
const WRONG_KEY = 'a-different-key-of-the-same-shape-0123456789ab';
const PASSWORD = 'a-real-password-9!';
const OPERATOR = 'ops:platform/4d3';

const SLUGS = [
  '4d3-live-alpha',
  '4d3-live-beta',
  '4d3-live-gamma',
  '4d3-live-delta',
  '4d3-live-epsilon',
  '4d3-live-zeta',
  '4d3-live-eta',
  '4d3-live-theta',
  '4d3-live-iota',
  '4d3-live-kappa',
  '4d3-live-lambda',
] as const;

interface Shop {
  slug: string;
  tenantId: string;
}

describe.skipIf(url === '')('initial owner bootstrap, live', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;
  let auth: AuthService;

  const shops = new Map<string, Shop>();

  /**
   * The hasher, counted.
   *
   * "An invalid capability performs no key derivation" is the one claim in this
   * strike that cannot be observed from the outside — the response is identical
   * either way — so it is measured here instead.
   */
  let hashCalls = 0;
  const hash = (secret: string): Promise<string> => {
    hashCalls += 1;
    return hashPassword(secret, FAST);
  };

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

  /** A provisioned, activated tenant with no user and no credential. */
  async function shop(slug: string): Promise<Shop> {
    const provisioned = await provisionTenant(prisma, {
      operationId: `op-${slug}`,
      slug,
      name: `متجر ${slug}`,
      vatNumber: null,
      vertical: 'retail',
      controlPlaneActorRef: OPERATOR,
    });
    await activateTenant(prisma, {
      tenantId: provisioned.id,
      operationId: `op-activate-${slug}`,
      controlPlaneActorRef: OPERATOR,
    });
    const made = { slug, tenantId: provisioned.id };
    shops.set(slug, made);
    return made;
  }

  function invite(target: Shop, over: Record<string, string> = {}) {
    return issueOwnerBootstrapInvitation(prisma, KEY, {
      tenantId: target.tenantId,
      operationId: `op-invite-${target.slug}`,
      email: `owner@${target.slug}.test`,
      displayName: 'المالك',
      controlPlaneActorRef: OPERATOR,
      ...over,
    });
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

  function tamper(token: string, index: 0 | 1 | 2, value: string): string {
    const parts = token.split('.');
    parts[index] = value;
    return parts.join('.');
  }

  /**
   * A signature that is definitely not this signature.
   *
   * The obvious mutation — replace the last character with `A` — is not a
   * mutation at all roughly one run in sixteen. A 32-byte HMAC is 43 base64url
   * characters, and the last one carries only four significant bits plus two
   * bits of padding, so it is drawn from just sixteen values: `048AEIMQUYcgkosw`.
   * When the genuine signature already ends in `A`, "tampering" produces the
   * genuine capability, the server rightly honours it, the invitation is
   * consumed, and this test and the next one both fail for reasons that look
   * like anything but a test bug.
   *
   * The first character has no padding bits, so changing it always changes both
   * the text and the decoded bytes. `A -> B` and everything else `-> A` keeps
   * the alphabet, the length and the determinism.
   */
  function mutateSignature(signature: string): string {
    const first = signature.slice(0, 1);
    return `${first === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  }

  /** An attacker who knows the format perfectly and not the key. */
  function forge(key: string, invitationId: string, tenantId: string, expiresAt: string): string {
    const payload = Buffer.from(
      JSON.stringify(['v1', invitationId, tenantId, expiresAt]),
      'utf8',
    ).toString('base64url');
    const signed = `v1.${payload}`;
    return `${signed}.${createHmac('sha256', key).update(signed, 'utf8').digest('base64url')}`;
  }

  async function ownerState(tenantId: string): Promise<{
    users: number;
    credentialed: number;
    activeMemberships: number;
    ownerGrants: number;
    accepted: number;
  }> {
    return withTenant(prisma, tenantId, async (tx) => {
      const role = await tx.role.findFirst({
        where: { tenantId, key: OWNER_BOOTSTRAP_ROLE_KEY },
        select: { id: true },
      });
      return {
        users: await tx.user.count({ where: { tenantId } }),
        credentialed: await tx.user.count({
          where: { tenantId, passwordHash: { not: null }, isActive: true },
        }),
        activeMemberships: await tx.tenantMembership.count({
          where: { tenantId, status: 'active' },
        }),
        ownerGrants:
          role === null ? 0 : await tx.userRole.count({ where: { tenantId, roleId: role.id } }),
        accepted: await tx.auditEvent.count({
          where: { tenantId, eventType: 'owner-bootstrap.accepted' },
        }),
      };
    });
  }

  /**
   * A credentialed, active, fully-membered account holding exactly these
   * permissions — through a role of its own, so nothing else in the tenant is
   * disturbed.
   *
   * Used to ask the question 4D actually asks: not "does somebody hold the
   * administrative permission" but "does somebody hold *both* of them".
   */
  async function staffWith(
    tenantId: string,
    email: string,
    permissions: readonly string[],
  ): Promise<string> {
    return withTenant(prisma, tenantId, async (tx) => {
      const userId = newId();
      const roleId = newId();
      await tx.user.create({
        data: {
          id: userId,
          tenantId,
          email,
          displayName: 'موظف',
          passwordHash: await hashPassword(PASSWORD, FAST),
          isActive: true,
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: newId(), tenantId, userId, status: 'active', updatedAt: new Date() },
      });
      await tx.role.create({
        data: {
          id: roleId,
          tenantId,
          // The whole id: ours are time-ordered, so a prefix collides for two
          // roles made in the same millisecond and `(tenantId, key)` is unique.
          key: `custom-${roleId}`,
          nameAr: 'دور',
          maxDiscountBasisPoints: 0,
          isSystem: false,
        },
      });
      for (const permissionKey of permissions) {
        await tx.rolePermission.create({
          data: { id: newId(), tenantId, roleId, permissionKey },
        });
      }
      await tx.userRole.create({ data: { id: newId(), tenantId, userId, roleId } });
      return userId;
    });
  }

  /**
   * Is bootstrap still open for this merchant?
   *
   * Asked the way it actually matters — by trying to issue. Only
   * `already-established` closes it; `already-invited` means a live invitation
   * is in the way, which is the opposite of closed. Any other refusal is a real
   * failure and is rethrown rather than read as an answer.
   */
  async function bootstrapStillOpen(target: Shop, operationId: string): Promise<boolean> {
    try {
      await issueOwnerBootstrapInvitation(prisma, KEY, {
        tenantId: target.tenantId,
        operationId,
        email: `owner@${target.slug}.test`,
        displayName: 'المالك',
        controlPlaneActorRef: OPERATOR,
      });
      return true;
    } catch (error) {
      if (error instanceof OwnerBootstrapRefusedError) {
        if (error.detail === 'already-established') return false;
        if (error.detail === 'already-invited') return true;
      }
      throw error;
    }
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    second = createPrismaClient(url);
    await second.$queryRaw`SELECT 1`;
    for (const slug of SLUGS) await purge(slug);
    await provisionPermissionCatalogue(prisma);
    auth = createAuthService({
      repository: createAuthRepository(prisma),
      audit: createAuditRepository(prisma),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    });
  }, 180_000);

  afterAll(async () => {
    for (const slug of SLUGS) await purge(slug);
    await prisma.$disconnect();
    await second.$disconnect();
  });

  it('runs as a role the policies actually apply to', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      enabled: boolean;
      forced: boolean;
    }>(
      `SELECT r.rolsuper, r.rolbypassrls,
              c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_roles r, pg_class c
        WHERE r.rolname = current_user
          AND c.relname = 'tenant_owner_bootstrap_invitations'`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      enabled: true,
      forced: true,
    });
    await client.end();
  });

  it('turns one invitation into exactly one credentialed Owner who can sign in', async () => {
    const alpha = await shop('4d3-live-alpha');

    // Provisioning left no user at all — that is the gap bootstrap exists for.
    expect(await ownerState(alpha.tenantId)).toMatchObject({ users: 0, credentialed: 0 });

    const issued = await invite(alpha);
    expect(issued.created).toBe(true);
    expect(issued.tenantId).toBe(alpha.tenantId);

    const accepted = await acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD);
    expect(accepted.tenantId).toBe(alpha.tenantId);
    // The address comes from the locked row, never from the request.
    expect(accepted.email).toBe(`owner@${alpha.slug}.test`);

    expect(await ownerState(alpha.tenantId)).toEqual({
      users: 1,
      credentialed: 1,
      activeMemberships: 1,
      ownerGrants: 1,
      accepted: 1,
    });

    // The point of the whole strike: this person can now log in normally, and
    // holds the administrative authority.
    const login = await auth.login({
      tenantSlug: alpha.slug,
      email: `owner@${alpha.slug}.test`,
      password: PASSWORD,
      userAgent: 'vitest',
    });
    expect(login.outcome).toBe('success');
    if (login.outcome !== 'success') throw new Error('unreachable');
    expect(login.principal.permissions).toContain('users.manage');
    expect(login.principal.permissions).toContain('settings.manage');
    expect(login.principal.userId).toBe(accepted.userId);
  }, 180_000);

  it('persists neither the capability nor the key that signs it', async () => {
    const alpha = shops.get('4d3-live-alpha');
    if (alpha === undefined) throw new Error('no alpha');
    const issued = await invite(alpha);

    // Every column of the invitation, plus the audit metadata, searched for any
    // fragment of the token or the key.
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [alpha.tenantId]);
    const { rows } = await client.query<{ dump: string }>(
      `SELECT COALESCE(string_agg(t::text, ' '), '') AS dump
         FROM "tenant_owner_bootstrap_invitations" t`,
    );
    const { rows: audits } = await client.query<{ dump: string }>(
      `SELECT COALESCE(string_agg(a."metadata"::text, ' '), '') AS dump
         FROM "audit_events" a WHERE a."eventType" LIKE 'owner-bootstrap%'`,
    );
    await client.query('COMMIT');
    await client.end();

    const dump = `${rows[0]?.dump ?? ''} ${audits[0]?.dump ?? ''}`;
    const [, payload, signature] = issued.capability.split('.');
    expect(dump).not.toContain(issued.capability);
    expect(dump).not.toContain(payload ?? 'payload');
    expect(dump).not.toContain(signature ?? 'signature');
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain(PASSWORD);
  }, 180_000);

  it('replays the same operation and conflicts on a changed intent', async () => {
    const beta = await shop('4d3-live-beta');
    const first = await invite(beta);
    expect(first.created).toBe(true);

    // Same operation, same canonical intent: the same logical invitation, and
    // the identical capability re-derived from the row rather than stored.
    const again = await invite(beta);
    expect(again.created).toBe(false);
    expect(again.invitationId).toBe(first.invitationId);
    expect(again.capability).toBe(first.capability);

    for (const changed of [
      { email: `someone-else@${beta.slug}.test` },
      { displayName: 'اسم آخر' },
      { controlPlaneActorRef: 'ops:platform/somebody-else' },
    ]) {
      const error = await refusal(() => invite(beta, changed));
      expect(error).toBeInstanceOf(OwnerBootstrapRefusedError);
      expect((error as OwnerBootstrapRefusedError).detail).toBe('idempotency-conflict');
    }

    // One invitation, one invited event.
    const invited = await withTenant(prisma, beta.tenantId, async (tx) => ({
      rows: await tx.tenantOwnerBootstrapInvitation.count({ where: { tenantId: beta.tenantId } }),
      events: await tx.auditEvent.count({
        where: { tenantId: beta.tenantId, eventType: 'owner-bootstrap.invited' },
      }),
    }));
    expect(invited).toEqual({ rows: 1, events: 1 });
  }, 180_000);

  it('refuses every capability it did not mint, with one answer', async () => {
    const beta = shops.get('4d3-live-beta');
    const alpha = shops.get('4d3-live-alpha');
    if (beta === undefined || alpha === undefined) throw new Error('no fixtures');
    const issued = await invite(beta);
    const [, payload, signature] = issued.capability.split('.');

    const forged = Buffer.from(
      JSON.stringify(['v1', issued.invitationId, alpha.tenantId, issued.expiresAt]),
      'utf8',
    ).toString('base64url');

    // Asserted before it is used, so this case can never again silently become
    // "present the genuine capability and expect a refusal".
    const mutated = mutateSignature(signature ?? '');
    expect(mutated).not.toBe(signature);
    expect(mutated).toHaveLength((signature ?? '').length);
    expect(mutated).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      Buffer.from(mutated, 'base64url').equals(Buffer.from(signature ?? '', 'base64url')),
    ).toBe(false);

    const attempts: readonly [string, string][] = [
      ['tampered payload', tamper(issued.capability, 1, forged)],
      ['tampered signature', tamper(issued.capability, 2, mutated)],
      ['wrong version', tamper(issued.capability, 0, 'v2')],
      ['wrong key', forge(WRONG_KEY, issued.invitationId, beta.tenantId, issued.expiresAt)],
      ['unknown invitation', forge(KEY, newId(), beta.tenantId, issued.expiresAt)],
      ['wrong tenant', forge(KEY, issued.invitationId, alpha.tenantId, issued.expiresAt)],
      ['expired', forge(KEY, issued.invitationId, beta.tenantId, '2020-01-01T00:00:00.000Z')],
      ['not a token', 'nonsense'],
      ['empty', ''],
    ];

    hashCalls = 0;
    for (const [label, token] of attempts) {
      const error = await refusal(() => acceptOwnerBootstrap(prisma, KEY, token, hash, PASSWORD));
      expect(error, label).toBeInstanceOf(OwnerBootstrapRefusedError);
      // One detail for all nine. The public route turns it into one status and
      // one body, so none of them is distinguishable from outside.
      expect((error as OwnerBootstrapRefusedError).detail, label).toBe('invalid-capability');
      // And not one of them bought a scrypt derivation. This is the whole
      // reason the preflight exists: without it, a caller with no token at all
      // could spend 64 MiB and a CPU-second of the server's budget per request.
      expect(hashCalls, label).toBe(0);
      void payload;
    }

    // Nothing was created by any of them.
    expect(await ownerState(beta.tenantId)).toMatchObject({ users: 0, accepted: 0 });
    // And the neighbour named in two of those forgeries is untouched.
    expect(await ownerState(alpha.tenantId)).toMatchObject({ users: 1, accepted: 1 });
  }, 180_000);

  it('honours a capability once, and never again', async () => {
    const beta = shops.get('4d3-live-beta');
    if (beta === undefined) throw new Error('no beta');
    const issued = await invite(beta);

    await acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD);

    hashCalls = 0;
    const replayed = await refusal(() =>
      acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD),
    );
    expect((replayed as OwnerBootstrapRefusedError).detail).toBe('invalid-capability');
    // A consumed capability is refused by the preflight, before the hasher.
    expect(hashCalls).toBe(0);
    expect(await ownerState(beta.tenantId)).toMatchObject({
      users: 1,
      credentialed: 1,
      accepted: 1,
    });
  }, 180_000);

  it('spends no key derivation on a capability it will not honour', async () => {
    // Its own merchant, so this test owns every capability it uses.
    const eps = await shop('4d3-live-epsilon');
    const issued = await invite(eps);

    // The control first: an honourable capability derives exactly one hash, so
    // the counter below is measuring something real rather than a hasher that
    // is never called at all.
    hashCalls = 0;
    await acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD);
    expect(hashCalls).toBe(1);

    // `issued` is now consumed, which makes it the consumed case.
    const cases: readonly [string, string][] = [
      ['malformed', 'not-a-capability'],
      ['wrong version', tamper(issued.capability, 0, 'v2')],
      [
        'tampered payload',
        tamper(issued.capability, 1, Buffer.from('["v1"]', 'utf8').toString('base64url')),
      ],
      [
        'tampered signature',
        tamper(issued.capability, 2, 'A'.repeat((issued.capability.split('.')[2] ?? '').length)),
      ],
      ['unknown invitation', forge(KEY, newId(), eps.tenantId, issued.expiresAt)],
      ['expired', forge(KEY, issued.invitationId, eps.tenantId, '2020-01-01T00:00:00.000Z')],
      ['consumed', issued.capability],
    ];

    hashCalls = 0;
    for (const [label, token] of cases) {
      const error = await refusal(() => acceptOwnerBootstrap(prisma, KEY, token, hash, PASSWORD));
      expect((error as OwnerBootstrapRefusedError).detail, label).toBe('invalid-capability');
      // The whole point of the preflight: a caller with no valid capability
      // cannot make this endpoint spend 64 MiB and a CPU-second per request.
      expect(hashCalls, label).toBe(0);
    }
  }, 240_000);

  it('closes bootstrap once the merchant has a viable administrator', async () => {
    const beta = shops.get('4d3-live-beta');
    if (beta === undefined) throw new Error('no beta');

    // Issuing is refused outright — a second capability into an established
    // merchant is a second front door.
    const error = await refusal(() =>
      issueOwnerBootstrapInvitation(prisma, KEY, {
        tenantId: beta.tenantId,
        operationId: `op-second-${beta.slug}`,
        email: `intruder@${beta.slug}.test`,
        displayName: 'دخيل',
        controlPlaneActorRef: OPERATOR,
      }),
    );
    expect((error as OwnerBootstrapRefusedError).detail).toBe('already-established');
    expect(await ownerState(beta.tenantId)).toMatchObject({ users: 1, credentialed: 1 });
  }, 180_000);

  it('cannot create two Owners from two competing invitations', async () => {
    const gamma = await shop('4d3-live-gamma');

    // Two invitations that both existed before anybody accepted: the first is
    // superseded by the re-issue, and the second is the live one. The first
    // must not still be a working capability.
    const first = await issueOwnerBootstrapInvitation(prisma, KEY, {
      tenantId: gamma.tenantId,
      operationId: `op-a-${gamma.slug}`,
      email: `owner@${gamma.slug}.test`,
      displayName: 'الأول',
      controlPlaneActorRef: OPERATOR,
    });

    // A second, different operation while the first is still open is refused —
    // one outstanding invitation at a time, decided under the tenant lock.
    const blocked = await refusal(() =>
      issueOwnerBootstrapInvitation(prisma, KEY, {
        tenantId: gamma.tenantId,
        operationId: `op-b-${gamma.slug}`,
        email: `other@${gamma.slug}.test`,
        displayName: 'الثاني',
        controlPlaneActorRef: OPERATOR,
      }),
    );
    expect((blocked as OwnerBootstrapRefusedError).detail).toBe('already-invited');

    await acceptOwnerBootstrap(prisma, KEY, first.capability, hash, PASSWORD);
    expect(await ownerState(gamma.tenantId)).toEqual({
      users: 1,
      credentialed: 1,
      activeMemberships: 1,
      ownerGrants: 1,
      accepted: 1,
    });
  }, 180_000);

  it('lets exactly one of two simultaneous acceptances establish authority', async () => {
    const delta = await shop('4d3-live-delta');
    const issued = await invite(delta);

    const gate = new pg.Client({ connectionString: url });
    await gate.connect();
    const { rows: pidRows } = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = pidRows[0]?.pid;
    if (pid === undefined) throw new Error('no backend pid');
    await gate.query('BEGIN');
    await gate.query("SELECT set_config('app.tenant_id', $1, true)", [delta.tenantId]);
    await gate.query('SELECT "id" FROM "tenants" WHERE "id" = $1 FOR UPDATE', [delta.tenantId]);

    const blocking = async (count: number): Promise<void> => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const { rows } = await gate.query<{ n: string }>(
          `WITH RECURSIVE q AS (
             SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN q ON q.pid = ANY(pg_blocking_pids(a.pid))
              WHERE a.datname = current_database()
           ) SELECT count(*)::text AS n FROM q`,
          [pid],
        );
        if (Number(rows[0]?.n ?? '0') >= count) return;
        if (Date.now() > deadline) throw new Error(`only ${rows[0]?.n ?? '0'} of ${count} blocked`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    };

    // The same capability, twice, on two connections. Both are proven queued on
    // the tenant row before either is allowed to proceed.
    const one = acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD);
    await blocking(1);
    const two = acceptOwnerBootstrap(second, KEY, issued.capability, hash, PASSWORD);
    await blocking(2);
    await gate.query('COMMIT');
    await gate.end();

    const settled = await Promise.allSettled([one, two]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);

    // One Owner, one grant, one audit row. Not two of anything.
    expect(await ownerState(delta.tenantId)).toEqual({
      users: 1,
      credentialed: 1,
      activeMemberships: 1,
      ownerGrants: 1,
      accepted: 1,
    });
  }, 180_000);

  it('rolls back the whole establishment when it fails after writing', async () => {
    const slug = '4d3-live-alpha';
    // A fresh merchant re-using a purged slug, so this test owns its state.
    await purge(slug);
    const fresh = await shop(slug);
    const issued = await invite(fresh);

    /**
     * A fault installed in the database, not in the code under test.
     *
     * The acceptance transaction writes the user, the membership, the grant and
     * the consumption, and *then* appends its audit row. A trigger refusing that
     * last insert fails it at the one point where every credential-bearing write
     * has already happened.
     */
    const fault = new pg.Client({ connectionString: url });
    await fault.connect();
    await fault.query(`
      CREATE FUNCTION korvi_test_refuse_bootstrap_audit() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."eventType" = 'owner-bootstrap.accepted'
           AND NEW."tenantId" = '${fresh.tenantId}'::uuid THEN
          RAISE EXCEPTION 'korvi test fault: audit write refused';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER korvi_test_refuse_bootstrap_audit
        BEFORE INSERT ON "audit_events"
        FOR EACH ROW EXECUTE FUNCTION korvi_test_refuse_bootstrap_audit();`);

    const failed = await refusal(() =>
      acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD),
    );
    expect(failed.message).toMatch(/korvi test fault/);

    // No user, no membership, no grant, no credential, no consumed invitation,
    // no audit row. Half of an authority establishment is not a state Korvi has.
    expect(await ownerState(fresh.tenantId)).toEqual({
      users: 0,
      credentialed: 0,
      activeMemberships: 0,
      ownerGrants: 0,
      accepted: 0,
    });
    const open = await withTenant(prisma, fresh.tenantId, async (tx) =>
      tx.tenantOwnerBootstrapInvitation.count({
        where: { tenantId: fresh.tenantId, consumedAt: null },
      }),
    );
    expect(open).toBe(1);

    await fault.query(`
      DROP TRIGGER korvi_test_refuse_bootstrap_audit ON "audit_events";
      DROP FUNCTION korvi_test_refuse_bootstrap_audit();`);
    await fault.end();

    // The same capability, unchanged, now does exactly what it was for — which
    // is the proof that the rollback left no tombstone.
    const accepted = await acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD);
    expect(accepted.tenantId).toBe(fresh.tenantId);
    expect(await ownerState(fresh.tenantId)).toEqual({
      users: 1,
      credentialed: 1,
      activeMemberships: 1,
      ownerGrants: 1,
      accepted: 1,
    });
  }, 240_000);

  /**
   * Bootstrap closure is 4D's question, not 4B-1's.
   *
   * 4B-1's administrative authority is the single permission `users.manage`.
   * 4D viability is `settings.manage` *and* `users.manage`, both effective, on
   * a credentialed active account with an active membership. They are not the
   * same test, and closing bootstrap on the weaker one would strand a merchant
   * who has somebody that can add staff but nobody that can configure the shop:
   * readiness would call them unadministrable, and there would be no way left
   * to bootstrap an Owner.
   */
  it('does not close bootstrap for users.manage alone', async () => {
    const zeta = await shop('4d3-live-zeta');

    // Holds 4B-1's administrative authority, and only that.
    await staffWith(zeta.tenantId, `staff@${zeta.slug}.test`, ['users.manage']);
    expect(await bootstrapStillOpen(zeta, `op-open-users-${zeta.slug}`)).toBe(true);
  }, 180_000);

  it('does not close bootstrap for settings.manage alone', async () => {
    const eta = await shop('4d3-live-eta');

    await staffWith(eta.tenantId, `staff@${eta.slug}.test`, ['settings.manage']);
    expect(await bootstrapStillOpen(eta, `op-open-settings-${eta.slug}`)).toBe(true);
  }, 180_000);

  it('closes bootstrap only when both effective permissions are held', async () => {
    const iota = await shop('4d3-live-iota');

    // Both permissions, but split across two people. Neither is viable, and
    // "somebody holds each" is not the same as "somebody holds both".
    await staffWith(iota.tenantId, `one@${iota.slug}.test`, ['users.manage']);
    await staffWith(iota.tenantId, `two@${iota.slug}.test`, ['settings.manage']);
    expect(await bootstrapStillOpen(iota, `op-open-split-${iota.slug}`)).toBe(true);

    // One person holding both closes it.
    await staffWith(iota.tenantId, `both@${iota.slug}.test`, ['settings.manage', 'users.manage']);
    expect(await bootstrapStillOpen(iota, `op-closed-${iota.slug}`)).toBe(false);
  }, 180_000);

  /**
   * The postcondition, proved by breaking the thing it exists to catch.
   *
   * Every individual write in the acceptance transaction succeeds here. The
   * user is created, the membership activated, the Owner role found and
   * granted — and the result is an account that cannot administer anything,
   * because the role it was granted no longer carries the permissions. Without
   * the postcondition this returns 204, burns the one-shot capability, and
   * leaves the merchant with no way to get another.
   */
  it('fails closed when the system Owner role cannot establish authority', async () => {
    const theta = await shop('4d3-live-theta');
    const issued = await invite(theta);

    const ownerRoleId = await withTenant(prisma, theta.tenantId, async (tx) => {
      const role = await tx.role.findFirst({
        where: { tenantId: theta.tenantId, key: OWNER_BOOTSTRAP_ROLE_KEY, isSystem: true },
        select: { id: true },
      });
      if (role === null) throw new Error('provisioning left no system owner role');
      return role.id;
    });

    // 1. The bindings corrupted: the role exists, is a system role, and grants
    //    nothing that 4D counts.
    await withTenant(prisma, theta.tenantId, async (tx) => {
      await tx.rolePermission.deleteMany({
        where: {
          tenantId: theta.tenantId,
          roleId: ownerRoleId,
          permissionKey: { in: ['settings.manage', 'users.manage'] },
        },
      });
    });

    const refused = await refusal(() =>
      acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD),
    );
    expect((refused as OwnerBootstrapRefusedError).detail).toBe('invalid-capability');

    // Nothing survived the rollback, and the capability was not spent.
    expect(await ownerState(theta.tenantId)).toEqual({
      users: 0,
      credentialed: 0,
      activeMemberships: 0,
      ownerGrants: 0,
      accepted: 0,
    });
    expect(
      await withTenant(prisma, theta.tenantId, async (tx) =>
        tx.tenantOwnerBootstrapInvitation.count({
          where: { tenantId: theta.tenantId, consumedAt: null },
        }),
      ),
    ).toBe(1);

    // 2. Bindings restored, but the role demoted out of Korvi's system roles.
    //    A custom role that merely answers to the name `owner` is a merchant's
    //    label, not Korvi's authority, so this must be refused too.
    await withTenant(prisma, theta.tenantId, async (tx) => {
      for (const permissionKey of ['settings.manage', 'users.manage']) {
        await tx.rolePermission.create({
          data: { id: newId(), tenantId: theta.tenantId, roleId: ownerRoleId, permissionKey },
        });
      }
      await tx.role.updateMany({
        where: { id: ownerRoleId, tenantId: theta.tenantId },
        data: { isSystem: false },
      });
    });

    const demoted = await refusal(() =>
      acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD),
    );
    expect((demoted as OwnerBootstrapRefusedError).detail).toBe('invalid-capability');
    expect(await ownerState(theta.tenantId)).toMatchObject({ users: 0, accepted: 0 });

    // 3. Repaired. The same capability, never consumed by either failure, now
    //    does exactly what it was issued for — which is the point of failing
    //    closed rather than half-establishing an Owner.
    await withTenant(prisma, theta.tenantId, async (tx) => {
      await tx.role.updateMany({
        where: { id: ownerRoleId, tenantId: theta.tenantId },
        data: { isSystem: true },
      });
    });

    const accepted = await acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD);
    expect(accepted.tenantId).toBe(theta.tenantId);
    expect(await ownerState(theta.tenantId)).toEqual({
      users: 1,
      credentialed: 1,
      activeMemberships: 1,
      ownerGrants: 1,
      accepted: 1,
    });
  }, 240_000);

  /**
   * `consumedAt` means one thing: a bearer presented this capability and it
   * worked. A clock passing a deadline is not that.
   */
  it('never writes consumedAt merely because an invitation expired', async () => {
    const slug = '4d3-live-kappa';
    const fresh = await shop(slug);

    // Issued three days ago, so it lapsed two days ago. The row is real and the
    // expiry is genuine rather than back-dated by an UPDATE.
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const stale = await issueOwnerBootstrapInvitation(
      prisma,
      KEY,
      {
        tenantId: fresh.tenantId,
        operationId: `op-stale-${slug}`,
        email: `owner@${slug}.test`,
        displayName: 'المالك',
        controlPlaneActorRef: OPERATOR,
      },
      () => past,
    );
    expect(new Date(stale.expiresAt).getTime()).toBeLessThan(Date.now());

    // An expired invitation is not in the way: a new control-plane operation
    // issues a replacement rather than being refused `already-invited`.
    const replacement = await issueOwnerBootstrapInvitation(prisma, KEY, {
      tenantId: fresh.tenantId,
      operationId: `op-replacement-${slug}`,
      email: `owner@${slug}.test`,
      displayName: 'المالك',
      controlPlaneActorRef: OPERATOR,
    });
    expect(replacement.created).toBe(true);
    expect(replacement.invitationId).not.toBe(stale.invitationId);

    // And the lapsed row is untouched history: never presented, so never
    // consumed. Issuing the replacement did not rewrite the record of it.
    const rows = await withTenant(prisma, fresh.tenantId, async (tx) =>
      tx.tenantOwnerBootstrapInvitation.findMany({
        where: { tenantId: fresh.tenantId },
        select: { id: true, consumedAt: true },
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.consumedAt === null)).toBe(true);

    // Replaying the original expired operation stays idempotent to its own
    // logical invitation, and does not renew it.
    const replayed = await issueOwnerBootstrapInvitation(
      prisma,
      KEY,
      {
        tenantId: fresh.tenantId,
        operationId: `op-stale-${slug}`,
        email: `owner@${slug}.test`,
        displayName: 'المالك',
        controlPlaneActorRef: OPERATOR,
      },
      () => past,
    );
    expect(replayed.created).toBe(false);
    expect(replayed.invitationId).toBe(stale.invitationId);
    expect(replayed.expiresAt).toBe(stale.expiresAt);

    // The expired capability is still inert, and still costs no key derivation.
    hashCalls = 0;
    const error = await refusal(() =>
      acceptOwnerBootstrap(prisma, KEY, stale.capability, hash, PASSWORD),
    );
    expect((error as OwnerBootstrapRefusedError).detail).toBe('invalid-capability');
    expect(hashCalls).toBe(0);
  }, 180_000);

  /**
   * The credential policy as an invariant of the authority, not a convention of
   * the handler in front of it.
   */
  it('refuses a weak password without spending anything or touching the merchant', async () => {
    // A merchant with a live invitation and no Owner yet, re-using a purged
    // slug so this test owns every row it looks at.
    await purge('4d3-live-epsilon');
    const fresh = await shop('4d3-live-epsilon');
    const issued = await invite(fresh);

    // The last one is twelve code points of two apparently distinct characters
    // that NFKC folds to `a` twelve times — weak only once normalised, which is
    // the string scrypt would have received.
    const disguised = `a${'ａ'}`.repeat(6);

    hashCalls = 0;
    for (const weak of ['short', '', 'aaaaaaaaaaaaaaaa', '            ', disguised]) {
      const error = await refusal(() =>
        acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, weak),
      );
      // Not an OwnerBootstrapRefusedError: this is a fact about the caller's own
      // input, and the API layer turns it into its own 400 rather than the
      // generic capability refusal.
      expect(error, weak).toBeInstanceOf(WeakCredentialError);
      // No key derivation — the policy runs before the signature is even read.
      expect(hashCalls, weak).toBe(0);
    }

    // No user, no membership, no grant, no audit row, and the capability is
    // still unspent.
    expect(await ownerState(fresh.tenantId)).toEqual({
      users: 0,
      credentialed: 0,
      activeMemberships: 0,
      ownerGrants: 0,
      accepted: 0,
    });
    expect(
      await withTenant(prisma, fresh.tenantId, async (tx) =>
        tx.tenantOwnerBootstrapInvitation.count({
          where: { tenantId: fresh.tenantId, consumedAt: null },
        }),
      ),
    ).toBe(1);

    // The same capability with an acceptable password still works.
    const accepted = await acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD);
    expect(accepted.tenantId).toBe(fresh.tenantId);
  }, 240_000);

  /**
   * The bootstrap door is one-way.
   *
   * The dangerous shape this guards against: closure decided by *current*
   * viability. That predicate goes false again the moment the established Owner
   * is deactivated, loses their membership, loses their credential, or has the
   * permissions stripped from their role — and a bootstrap path that reopens on
   * that condition is an unauthenticated Owner-recovery flow nobody designed,
   * reachable by anyone still holding a capability.
   *
   * Recovery and owner transfer are a separate authority with their own threat
   * model, and are explicitly out of scope here (ADR-0021). So this proves the
   * door stays shut on monotonic evidence — a consumed invitation — rather than
   * on a fact that can go backwards.
   */
  it('stays permanently closed after a successful bootstrap, even once viability is lost', async () => {
    const lambda = await shop('4d3-live-lambda');
    const issued = await invite(lambda);
    const accepted = await acceptOwnerBootstrap(prisma, KEY, issued.capability, hash, PASSWORD);

    // A second invitation row that was never consumed, and a genuinely valid
    // capability for it — an operator's leftover, or a capability that was in
    // flight when the first one landed. Signed with the real key, so nothing
    // about it is forged except the circumstances.
    const strayId = newId();
    const strayExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await withTenant(prisma, lambda.tenantId, async (tx) => {
      await tx.tenantOwnerBootstrapInvitation.create({
        data: {
          id: strayId,
          tenantId: lambda.tenantId,
          operationId: `op-stray-${lambda.slug}`,
          requestHash: 'A'.repeat(43),
          email: `stray@${lambda.slug}.test`,
          displayName: 'دخيل',
          controlPlaneActorRef: OPERATOR,
          expiresAt: strayExpiry,
          createdAt: new Date(),
        },
      });
    });
    // The signed expiry must be exactly the column's, because acceptance
    // compares the two rather than trusting the token.
    const strayCapability = forge(KEY, strayId, lambda.tenantId, strayExpiry.toISOString());

    // Now destroy the merchant's authority the way the world destroys it.
    await withTenant(prisma, lambda.tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { id: accepted.userId, tenantId: lambda.tenantId },
        data: { isActive: false, updatedAt: new Date() },
      });
    });

    // 4D agrees the merchant now has nobody: this is the exact condition that
    // would have reopened the door under a current-viability rule.
    const readiness = await readTenantOnboardingReadiness(prisma, {
      tenantId: brandTenantId(lambda.tenantId),
    });
    const administrator = readiness?.checks.find((item) => item.key === 'viable-administrator');
    expect(administrator?.ready).toBe(false);

    // Issuing a new capability is still refused, and refused for the permanent
    // reason rather than for a present-tense one that just became false.
    const blocked = await refusal(() =>
      issueOwnerBootstrapInvitation(prisma, KEY, {
        tenantId: lambda.tenantId,
        operationId: `op-reopen-${lambda.slug}`,
        email: `again@${lambda.slug}.test`,
        displayName: 'المالك',
        controlPlaneActorRef: OPERATOR,
      }),
    );
    expect((blocked as OwnerBootstrapRefusedError).detail).toBe('already-established');

    // And the stray capability — unconsumed, unexpired, correctly signed, aimed
    // at a merchant with no administrator — establishes nothing.
    hashCalls = 0;
    const stray = await refusal(() =>
      acceptOwnerBootstrap(prisma, KEY, strayCapability, hash, PASSWORD),
    );
    expect((stray as OwnerBootstrapRefusedError).detail).toBe('invalid-capability');
    // Closure is proven by the cheap preflight, so it costs no key derivation.
    expect(hashCalls).toBe(0);

    // No second Owner, no second acceptance, and the stray invitation was not
    // consumed by the refusal either.
    expect(await ownerState(lambda.tenantId)).toMatchObject({
      users: 1,
      credentialed: 0,
      ownerGrants: 1,
      accepted: 1,
    });
    expect(
      await withTenant(prisma, lambda.tenantId, async (tx) =>
        tx.tenantOwnerBootstrapInvitation.count({
          where: { tenantId: lambda.tenantId, consumedAt: null },
        }),
      ),
    ).toBe(1);

    // Restoring the account does not reopen anything either: the door is shut on
    // history, not on the current state of anybody's account.
    await withTenant(prisma, lambda.tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { id: accepted.userId, tenantId: lambda.tenantId },
        data: { isActive: true, updatedAt: new Date() },
      });
    });
    const stillBlocked = await refusal(() =>
      acceptOwnerBootstrap(prisma, KEY, strayCapability, hash, PASSWORD),
    );
    expect((stillBlocked as OwnerBootstrapRefusedError).detail).toBe('invalid-capability');
  }, 240_000);

  it("keeps one merchant out of another merchant's invitations", async () => {
    const beta = shops.get('4d3-live-beta');
    const gamma = shops.get('4d3-live-gamma');
    if (beta === undefined || gamma === undefined) throw new Error('no fixtures');

    // Under one tenant's context, the other's invitations do not exist.
    const seen = await withTenant(
      prisma,
      gamma.tenantId,
      async (tx) =>
        tx.$queryRaw<{ tenantId: string }[]>`
        SELECT "tenantId" FROM "tenant_owner_bootstrap_invitations"`,
    );
    expect(seen.every((row) => row.tenantId === gamma.tenantId)).toBe(true);
    expect(seen.some((row) => row.tenantId === beta.tenantId)).toBe(false);

    // And a write cannot be aimed across the boundary: RLS refuses the row.
    const across = await refusal(() =>
      withTenant(prisma, gamma.tenantId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "tenant_owner_bootstrap_invitations"
            ("id","tenantId","operationId","requestHash","email","displayName",
             "controlPlaneActorRef","expiresAt","createdAt")
          VALUES (${newId()}::uuid, ${beta.tenantId}::uuid, 'smuggled',
                  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                  'x@smuggled.test', 'x', 'ops:x', now() + interval '1 day', now())`;
      }),
    );
    expect(across.message).toMatch(/row-level security/i);
  }, 180_000);
});

describe.skipIf(url !== '')('initial owner bootstrap, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
