import { beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { createAuthService, DEFAULT_LOCKOUT, correlationHash } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { parseToken } from '../auth/token.js';
import {
  MemoryAuthStore,
  memoryAuditRepository,
  memoryAuthRepository,
} from './support/memory-auth.js';
import type { AuthService } from '../auth/service.js';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;

const TENANT_A = '018f3a1c-9b2e-7c4d-8e5f-00000000000a';
const TENANT_B = '018f3a1c-9b2e-7c4d-8e5f-00000000000b';
const USER_A = '018f3a1c-9b2e-7c4d-8e5f-0000000000a1';
const USER_B = '018f3a1c-9b2e-7c4d-8e5f-0000000000b1';
const PASSWORD = 'a-real-password-9!';

let store: MemoryAuthStore;
let service: AuthService;
let clock: Date;

async function seed(): Promise<void> {
  store = new MemoryAuthStore();
  clock = new Date('2026-08-10T08:00:00.000Z');

  const passwordHash = await hashPassword(PASSWORD, FAST);
  for (const [tenant, slug, user, email] of [
    [TENANT_A, 'korvi-a', USER_A, 'sara@korvi-a.test'],
    [TENANT_B, 'korvi-b', USER_B, 'omar@korvi-b.test'],
  ] as const) {
    store.tenants.push({ id: tenant, slug, name: slug, status: 'active' });
    store.users.push({
      id: user,
      tenantId: tenant,
      email,
      displayName: 'Cashier',
      passwordHash,
      isActive: true,
      failedLoginCount: 0,
      lockedUntil: null,
      authVersion: 1,
      lastLoginAt: null,
    });
    store.memberships.push({
      tenantId: tenant,
      userId: user,
      status: 'active',
      defaultBranchId: null,
    });
    store.grants.push({
      tenantId: tenant,
      userId: user,
      roles: ['manager'],
      permissions: [...ROLE_PERMISSIONS.manager],
    });
  }

  service = createAuthService({
    repository: memoryAuthRepository(store),
    audit: memoryAuditRepository(store),
    sessionTtlSeconds: 3600,
    scrypt: FAST,
    now: () => clock,
  });
}

beforeEach(seed);

function login(overrides: Partial<{ tenantSlug: string; email: string; password: string }> = {}) {
  return service.login({
    tenantSlug: overrides.tenantSlug ?? 'korvi-a',
    email: overrides.email ?? 'sara@korvi-a.test',
    password: overrides.password ?? PASSWORD,
    userAgent: 'vitest',
  });
}

describe('login', () => {
  it('issues a session for the right credentials', async () => {
    const result = await login();
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    expect(parseToken(result.token)?.tenantHint).toBe(TENANT_A);
    expect(result.principal.roles).toEqual(['manager']);
    expect(result.principal.maxDiscountBasisPoints).toBe(2_000n);
    expect(store.sessions).toHaveLength(1);
  });

  it('never stores the token it hands out', async () => {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');
    const stored = store.sessions[0];
    expect(stored?.tokenHash).not.toBe(result.token);
    expect(JSON.stringify(store.sessions)).not.toContain(result.token);
  });

  it.each([
    ['an unknown tenant', { tenantSlug: 'no-such-shop' }, 'unknown-tenant'],
    ['an unknown email', { email: 'nobody@korvi-a.test' }, 'unknown-user'],
    ['the wrong password', { password: 'not-it' }, 'bad-password'],
  ])('refuses %s', async (_label, overrides, reason) => {
    const result = await login(overrides);
    expect(result.outcome).toBe('failure');
    if (result.outcome === 'failure') expect(result.reason).toBe(reason);
  });

  it('refuses a user from another tenant even with the right password', async () => {
    // The address exists; it just does not belong to this shop. Resolving the
    // tenant first is what makes that a miss rather than a login.
    const result = await login({ email: 'omar@korvi-b.test' });
    expect(result.outcome).toBe('failure');
  });

  it('refuses a deactivated user', async () => {
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.isActive = false;
    const result = await login();
    expect(result.outcome === 'failure' && result.reason).toBe('user-inactive');
  });

  it('refuses a suspended membership', async () => {
    const membership = store.memberships.find((candidate) => candidate.userId === USER_A);
    if (membership !== undefined) membership.status = 'suspended';
    const result = await login();
    expect(result.outcome === 'failure' && result.reason).toBe('membership-inactive');
  });

  it('refuses a suspended tenant', async () => {
    const tenant = store.tenants.findIndex((candidate) => candidate.id === TENANT_A);
    store.tenants[tenant] = { id: TENANT_A, slug: 'korvi-a', name: 'korvi-a', status: 'suspended' };
    const result = await login();
    expect(result.outcome === 'failure' && result.reason).toBe('tenant-inactive');
  });

  it('refuses a user with no credential set', async () => {
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.passwordHash = null;
    const result = await login();
    expect(result.outcome === 'failure' && result.reason).toBe('no-credential');
  });
});

describe('lockout', () => {
  it('locks after the configured number of failures and not before', async () => {
    for (let attempt = 1; attempt < DEFAULT_LOCKOUT.threshold; attempt += 1) {
      const result = await login({ password: 'wrong' });
      expect(result.outcome === 'failure' && result.reason).toBe('bad-password');
      expect(store.users.find((u) => u.id === USER_A)?.lockedUntil).toBeNull();
    }

    const final = await login({ password: 'wrong' });
    expect(final.outcome === 'failure' && final.reason).toBe('bad-password');
    const user = store.users.find((candidate) => candidate.id === USER_A);
    expect(user?.failedLoginCount).toBe(DEFAULT_LOCKOUT.threshold);
    expect(user?.lockedUntil).toBe(
      new Date(clock.getTime() + DEFAULT_LOCKOUT.lockSeconds * 1000).toISOString(),
    );
  });

  it('refuses the right password while locked', async () => {
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.lockedUntil = new Date(clock.getTime() + 60_000).toISOString();
    const result = await login();
    expect(result.outcome === 'failure' && result.reason).toBe('locked');
  });

  it('lets a lock expire rather than disabling the till for the day', async () => {
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.lockedUntil = new Date(clock.getTime() - 1_000).toISOString();
    const result = await login();
    expect(result.outcome).toBe('success');
  });

  it('opens a new window after a lock expires instead of re-locking on one typo', async () => {
    // Five failures, then the lock runs out. The old count must not still be
    // sitting at the threshold, or the next mistyped password locks the till
    // again immediately — which is not what "fifteen minutes" means.
    for (let attempt = 0; attempt < DEFAULT_LOCKOUT.threshold; attempt += 1) {
      await login({ password: 'wrong' });
    }
    const user = store.users.find((candidate) => candidate.id === USER_A);
    expect(user?.lockedUntil).not.toBeNull();

    clock = new Date(clock.getTime() + (DEFAULT_LOCKOUT.lockSeconds + 1) * 1000);
    await login({ password: 'wrong-again' });

    expect(user?.failedLoginCount).toBe(1);
    expect(user?.lockedUntil).toBeNull();

    // And the correct password works, because nothing is holding a lock.
    const result = await login();
    expect(result.outcome).toBe('success');
  });

  it('does not extend a lock just because requests keep arriving', async () => {
    const user = store.users.find((candidate) => candidate.id === USER_A);
    const deadline = new Date(clock.getTime() + 60_000).toISOString();
    if (user !== undefined) user.lockedUntil = deadline;

    await login({ password: 'wrong' });
    await login({ password: 'wrong' });

    expect(user?.lockedUntil).toBe(deadline);
  });

  it('resets the failure count on a success', async () => {
    await login({ password: 'wrong' });
    await login({ password: 'wrong' });
    expect(store.users.find((u) => u.id === USER_A)?.failedLoginCount).toBe(2);

    await login();
    const user = store.users.find((candidate) => candidate.id === USER_A);
    expect(user?.failedLoginCount).toBe(0);
    expect(user?.lockedUntil).toBeNull();
    expect(user?.lastLoginAt).toBe(clock.toISOString());
  });
});

describe('session verification', () => {
  async function loggedIn(): Promise<string> {
    const result = await login();
    if (result.outcome !== 'success') throw new Error('expected success');
    return result.token;
  }

  it('resolves a live session to a server-derived principal', async () => {
    const token = await loggedIn();
    const result = await service.authenticate(token);
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.principal.userId).toBe(USER_A);
    expect(result.principal.tenantId).toBe(TENANT_A);
    expect(result.principal.permissions).toEqual([...ROLE_PERMISSIONS.manager]);
  });

  it('refuses a revoked session', async () => {
    const token = await loggedIn();
    await service.logout(token);
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('revoked');
  });

  it('refuses an expired session', async () => {
    const token = await loggedIn();
    clock = new Date(clock.getTime() + 3600 * 1000 + 1);
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('expired');
  });

  it('refuses a session minted under an older authVersion', async () => {
    // The lever a future password reset pulls: bump the user, and every
    // session in existence stops matching without a sweep.
    const token = await loggedIn();
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.authVersion += 1;
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('auth-version');
  });

  it('refuses a session whose user has been deactivated', async () => {
    const token = await loggedIn();
    const user = store.users.find((candidate) => candidate.id === USER_A);
    if (user !== undefined) user.isActive = false;
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('user-inactive');
  });

  it('refuses a session the moment its tenant is suspended', async () => {
    // The session was minted while the tenant was active. Checking the tenant
    // only at login would leave it working until the cookie expired, which for
    // a twelve-hour session is the rest of the trading day.
    const token = await loggedIn();
    const index = store.tenants.findIndex((candidate) => candidate.id === TENANT_A);
    store.tenants[index] = { id: TENANT_A, slug: 'korvi-a', name: 'korvi-a', status: 'suspended' };

    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('tenant-inactive');
  });

  it('refuses a session whose tenant has been put back into provisioning', async () => {
    const token = await loggedIn();
    const index = store.tenants.findIndex((candidate) => candidate.id === TENANT_A);
    store.tenants[index] = {
      id: TENANT_A,
      slug: 'korvi-a',
      name: 'korvi-a',
      status: 'provisioning',
    };

    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('tenant-inactive');
  });

  it('does not let reactivation skip the other checks', async () => {
    // A tenant coming back must not resurrect a session that was revoked,
    // expired or minted under an older authVersion while it was away.
    const token = await loggedIn();
    const index = store.tenants.findIndex((candidate) => candidate.id === TENANT_A);
    store.tenants[index] = { id: TENANT_A, slug: 'korvi-a', name: 'korvi-a', status: 'suspended' };
    await service.logout(token);

    store.tenants[index] = { id: TENANT_A, slug: 'korvi-a', name: 'korvi-a', status: 'active' };
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('revoked');
  });

  it('keeps cross-tenant behaviour unchanged while the tenant check runs', async () => {
    const token = await loggedIn();
    const moved = token.replace(TENANT_A, TENANT_B);
    const result = await service.authenticate(moved);
    expect(result.outcome === 'failure' && result.reason).toBe('unknown-session');
  });

  it('refuses a session whose membership has been suspended', async () => {
    const token = await loggedIn();
    const membership = store.memberships.find((candidate) => candidate.userId === USER_A);
    if (membership !== undefined) membership.status = 'suspended';
    const result = await service.authenticate(token);
    expect(result.outcome === 'failure' && result.reason).toBe('membership-inactive');
  });

  it('does not authenticate into another tenant when the hint is edited', async () => {
    // The tenant segment is a routing hint. Rewriting it changes which RLS
    // context opens and changes the hash, so the lookup finds nothing —
    // it does not find tenant B's session, and it does not find A's either.
    const token = await loggedIn();
    const moved = token.replace(TENANT_A, TENANT_B);
    expect(moved).not.toBe(token);
    const result = await service.authenticate(moved);
    expect(result.outcome === 'failure' && result.reason).toBe('unknown-session');
  });

  it.each([
    ['random', 'kps1.018f3a1c-9b2e-7c4d-8e5f-00000000000a.' + 'a'.repeat(43)],
    ['malformed', 'not-a-token'],
    ['empty', ''],
  ])('refuses a %s token', async (_label, candidate) => {
    const result = await service.authenticate(candidate);
    expect(result.outcome).toBe('failure');
  });

  it('logs out every session for a user when asked', async () => {
    await loggedIn();
    const second = await loggedIn();
    expect(store.sessions.filter((s) => s.revokedAt === null)).toHaveLength(2);

    const revoked = await service.logoutAll(second);
    expect(revoked).toBe(2);
    expect(store.sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });
});

describe('the audit trail', () => {
  it('records a success and a failure without recording the secret', async () => {
    await login({ password: 'wrong' });
    await login();

    const types = store.audit.map((entry) => entry.event.eventType);
    expect(types).toContain('auth.login.failure');
    expect(types).toContain('auth.login.success');

    const rendered = JSON.stringify(store.audit);
    expect(rendered).not.toContain(PASSWORD);
    expect(rendered).not.toContain('kps1.');
    expect(rendered).not.toContain('scrypt$');
  });

  it('labels an unknown address with a correlation hash, not the address', async () => {
    await login({ email: 'ghost@korvi-a.test' });
    const entry = store.audit.at(-1);
    const rendered = JSON.stringify(entry);
    expect(rendered).not.toContain('ghost@korvi-a.test');
    expect(entry?.event.metadata?.['correlation']).toBe(
      correlationHash(TENANT_A, 'ghost@korvi-a.test'),
    );
  });

  it('leaves no usable session behind when finalization fails', async () => {
    // The session row and the counter reset commit together. A partial write
    // here would be a live session belonging to a user the database still
    // believes is locked out.
    store.finalizeFails = true;
    const before = store.users.find((candidate) => candidate.id === USER_A);
    if (before !== undefined) before.failedLoginCount = 3;

    await expect(login()).rejects.toThrow(/finalizing transaction failed/);

    expect(store.sessions).toHaveLength(0);
    expect(before?.failedLoginCount).toBe(3);
    expect(before?.lastLoginAt).toBeNull();
  });

  it('still authenticates when the audit sink is down', async () => {
    // A session already exists by the time the log line is written. Failing
    // the login there would leave a live session behind an error message.
    store.auditFails = true;
    const result = await login();
    expect(result.outcome).toBe('success');
    expect(store.sessions).toHaveLength(1);
  });
});
