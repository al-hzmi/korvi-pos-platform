import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { createCheckoutService } from '../checkout/service.js';
import { createReturnService } from '../returns/service.js';
import { createDrawerService } from '../shifts/service.js';
import {
  MemoryAuthStore,
  memoryAuditRepository as memoryAuthAudit,
  memoryAuthRepository,
} from './support/memory-auth.js';
import {
  MemoryBusinessStore,
  memoryAuditRepository,
  memoryDashboardRepository,
  memoryIdempotencyRepository,
  memoryInventoryRepository,
  memoryProductRepository,
  memoryReturnRepository,
  memorySaleRepository,
  memoryShiftRepository,
  memoryTenantRepository,
  memoryTerminalRepository,
  seedStore,
} from './support/memory-business.js';
import type { Fixture } from './support/memory-business.js';
import type { RoleName } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

/**
 * The drawer's two write routes, over a real Fastify instance.
 *
 * The arithmetic is proved elsewhere. What is proved here is authority: that a
 * client cannot assert what the till should hold, cannot learn it before it
 * counts, cannot reach another branch's drawer, and cannot turn one retry into
 * two movements.
 */

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-real-password-9!';

const A: Fixture = {
  tenant: '018f8000-0000-7000-8000-00000000000a',
  branch: '018f8000-0000-7000-8000-0000000000a1',
  terminal: '018f8000-0000-7000-8000-0000000000a2',
  shift: '018f8000-0000-7000-8000-0000000000a3',
  user: '018f8000-0000-7000-8000-0000000000a4',
  milk: '018f8000-0000-7000-8000-0000000000a5',
  rice: '018f8000-0000-7000-8000-0000000000a6',
};

/** A till and a drawer in a branch this session is not pinned to. */
const FOREIGN_BRANCH = '018f8000-0000-7000-8000-0000000000b1';
const FOREIGN_TERMINAL = '018f8000-0000-7000-8000-0000000000b2';
const FOREIGN_SHIFT = '018f8000-0000-7000-8000-0000000000b3';
/** A second till in this branch, with no shift of its own. */
const SECOND_TERMINAL = '018f8000-0000-7000-8000-0000000000c2';
/** Somebody else's user id, for the ownership tests. */
const OTHER_USER = '018f8000-0000-7000-8000-0000000000d4';

let app: FastifyInstance;
let business: MemoryBusinessStore;
let auth: MemoryAuthStore;
let ids = 0;

function nextId(): string {
  ids += 1;
  return `018f8000-0000-7000-8000-${String(ids).padStart(12, '0')}`;
}

/** A fresh operation id per request, so a retry is a deliberate choice. */
const OPERATIONS = {
  first: '018f8000-0000-7000-8000-0000000000e1',
  second: '018f8000-0000-7000-8000-0000000000e2',
} as const;

async function build(role: RoleName, options: { branch?: string | null } = {}) {
  const { branch = A.branch } = options;
  ids = 100;
  business = new MemoryBusinessStore();
  seedStore(business, A, true);

  const tenantId = business.tenants[0]!.id;
  business.terminals.push(
    {
      id: FOREIGN_TERMINAL,
      tenantId,
      branchId: FOREIGN_BRANCH,
      code: '09',
      label: 'صندوق فرع آخر',
      isActive: true,
      lastSeenAt: null,
    },
    {
      id: SECOND_TERMINAL,
      tenantId,
      branchId: A.branch,
      code: '02',
      label: 'صندوق ٢',
      isActive: true,
      lastSeenAt: null,
    },
  );
  business.shifts.push({
    id: FOREIGN_SHIFT,
    tenantId,
    branchId: FOREIGN_BRANCH,
    terminalId: FOREIGN_TERMINAL,
    userId: OTHER_USER,
    status: 'open',
    openingFloatMinor: '10000',
    declaredCashMinor: null,
    expectedCashMinor: null,
    varianceMinor: null,
    closedByUserId: null,
    openedAt: '2026-08-12T06:00:00.000Z',
    closedAt: null,
    reconciliation: null,
    movements: [],
  });

  auth = new MemoryAuthStore();
  auth.tenants.push({ id: A.tenant, slug: 'korvi-a', name: 'Korvi A', status: 'active' });
  auth.users.push({
    id: A.user,
    tenantId: A.tenant,
    email: 'sara@korvi-a.test',
    displayName: 'سارة',
    passwordHash: await hashPassword(PASSWORD, FAST),
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    authVersion: 1,
    lastLoginAt: null,
  });
  auth.memberships.push({
    tenantId: A.tenant,
    userId: A.user,
    status: 'active',
    defaultBranchId: branch,
  });
  auth.grants.push({
    tenantId: A.tenant,
    userId: A.user,
    roles: [role],
    permissions: [...ROLE_PERMISSIONS[role]],
  });

  // A second person, same role and same branch. Everything about them is
  // lawful; the only thing that differs is who they are.
  auth.users.push({
    id: OTHER_USER,
    tenantId: A.tenant,
    email: 'omar@korvi-a.test',
    displayName: 'عمر',
    passwordHash: await hashPassword(PASSWORD, FAST),
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    authVersion: 1,
    lastLoginAt: null,
  });
  auth.memberships.push({
    tenantId: A.tenant,
    userId: OTHER_USER,
    status: 'active',
    defaultBranchId: branch,
  });
  auth.grants.push({
    tenantId: A.tenant,
    userId: OTHER_USER,
    roles: [role],
    permissions: [...ROLE_PERMISSIONS[role]],
  });

  const shifts = memoryShiftRepository(business);
  const terminals = memoryTerminalRepository(business);
  const idempotency = memoryIdempotencyRepository(business);
  const audit = memoryAuditRepository(business);

  const server = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: createAuthService({
      repository: memoryAuthRepository(auth),
      audit: memoryAuthAudit(auth),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    }),
    business: {
      tenants: memoryTenantRepository(business),
      dashboard: memoryDashboardRepository(business),
      products: memoryProductRepository(business),
      shifts,
      terminals,
      checkout: createCheckoutService({
        tenants: memoryTenantRepository(business),
        products: memoryProductRepository(business),
        inventory: memoryInventoryRepository(business),
        shifts,
        sales: memorySaleRepository(business),
        idempotency,
        audit,
        newId: nextId,
      }),
      returns: createReturnService({
        returns: memoryReturnRepository(business),
        terminals,
        shifts,
        idempotency,
        audit,
      }),
      drawer: createDrawerService({ shifts, terminals, idempotency, audit, newId: nextId }),
    },
  });
  await server.ready();
  app = server;
  return server;
}

async function cookieFor(server: FastifyInstance, email = 'sara@korvi-a.test'): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { tenantSlug: 'korvi-a', email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return header.split(';')[0] ?? '';
}

function movementPayload(over: Record<string, unknown> = {}) {
  return {
    operationId: OPERATIONS.first,
    terminalId: A.terminal,
    shiftId: A.shift,
    kind: 'pay-in',
    amountMinor: '5000',
    reason: 'إيداع صرافة',
    ...over,
  };
}

function closePayload(over: Record<string, unknown> = {}) {
  return {
    operationId: OPERATIONS.first,
    terminalId: A.terminal,
    shiftId: A.shift,
    declaredCashMinor: '20000',
    ...over,
  };
}

const post = (url: string, cookie: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: { cookie, origin: ORIGIN },
    payload: payload as never,
  });

afterEach(async () => {
  await app.close();
});

describe('who may touch the drawer', () => {
  it('refuses an anonymous movement and an anonymous close', async () => {
    await build('manager');
    for (const url of ['/v1/shifts/movements', '/v1/shifts/close']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { origin: ORIGIN },
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('refuses a cashier a manual movement, who does not hold shift.cash-movement', async () => {
    await build('cashier');
    const cookie = await cookieFor(app);
    const response = await post('/v1/shifts/movements', cookie, movementPayload());
    expect(response.statusCode).toBe(403);
    expect(ROLE_PERMISSIONS.cashier).not.toContain('shift.cash-movement');
  });

  it('lets a cashier close their own drawer, which is what shift.close is for', async () => {
    await build('cashier');
    const cookie = await cookieFor(app);
    const response = await post('/v1/shifts/close', cookie, closePayload());
    expect(response.statusCode).toBe(201);
    expect(ROLE_PERMISSIONS.cashier).toContain('shift.close');
  });

  it('refuses a principal with no branch to act in', async () => {
    await build('manager', { branch: null });
    const cookie = await cookieFor(app);
    const response = await post('/v1/shifts/close', cookie, closePayload());
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error).toBe('branch_required');
  });
});

describe('a manual movement', () => {
  it('records a pay-in as a positive amount', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const response = await post('/v1/shifts/movements', cookie, movementPayload());

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload) as {
      movement: { kind: string; amountMinor: string; reason: string; actorUserId: string };
      replayed: boolean;
    };
    expect(body.replayed).toBe(false);
    expect(body.movement.kind).toBe('pay-in');
    expect(body.movement.amountMinor).toBe('5000');
    expect(body.movement.reason).toBe('إيداع صرافة');
    expect(body.movement.actorUserId).toBe(A.user);
  });

  it('records a pay-out as a negative amount, from a positive magnitude', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const response = await post(
      '/v1/shifts/movements',
      cookie,
      movementPayload({ kind: 'pay-out', amountMinor: '750', reason: 'مصروف نقل' }),
    );

    expect(response.statusCode).toBe(201);
    // The client sent 750; the server decided the sign.
    expect(JSON.parse(response.payload).movement.amountMinor).toBe('-750');
  });

  it('is recorded by the manager who performed it, not by the drawer’s owner', async () => {
    // The manager did not open this shift, and does not have to have.
    await build('manager');
    const cookie = await cookieFor(app);
    business.shifts[0] = { ...business.shifts[0]!, userId: OTHER_USER };

    const response = await post('/v1/shifts/movements', cookie, movementPayload());

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload) as { movement: { actorUserId: string } };
    expect(body.movement.actorUserId).toBe(A.user);
    // And the shift still belongs to whoever opened it.
    expect(business.shifts[0]?.userId).toBe(OTHER_USER);
  });

  it('answers an identical retry with the first movement and writes nothing', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const payload = movementPayload();

    const first = await post('/v1/shifts/movements', cookie, payload);
    const second = await post('/v1/shifts/movements', cookie, payload);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.payload).replayed).toBe(true);
    expect(JSON.parse(second.payload).movement.movementId).toBe(
      JSON.parse(first.payload).movement.movementId,
    );
    expect(business.shifts[0]?.movements).toHaveLength(1);
  });

  it('refuses the same operation id carrying a different amount', async () => {
    await build('manager');
    const cookie = await cookieFor(app);

    await post('/v1/shifts/movements', cookie, movementPayload());
    const conflicting = await post(
      '/v1/shifts/movements',
      cookie,
      movementPayload({ amountMinor: '9999' }),
    );

    expect(conflicting.statusCode).toBe(409);
    expect(JSON.parse(conflicting.payload).error).toBe('idempotency-conflict');
    expect(business.shifts[0]?.movements).toHaveLength(1);
  });

  it('refuses a till in another branch, saying nothing about it', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const response = await post(
      '/v1/shifts/movements',
      cookie,
      movementPayload({ terminalId: FOREIGN_TERMINAL, shiftId: FOREIGN_SHIFT }),
    );

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload).error).toBe('unknown-terminal');
    expect(response.payload).not.toContain(FOREIGN_BRANCH);
  });

  it('refuses a shift that is not on the named till', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const response = await post(
      '/v1/shifts/movements',
      cookie,
      movementPayload({ terminalId: SECOND_TERMINAL }),
    );

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload).error).toBe('unknown-shift');
  });

  it('refuses a drawer that has already been counted', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    business.shifts[0] = { ...business.shifts[0]!, status: 'closed' };

    const response = await post('/v1/shifts/movements', cookie, movementPayload());
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.payload).error).toBe('shift-closed');
  });
});

describe('a shift you cannot address', () => {
  /**
   * Three requests that must be indistinguishable from outside.
   *
   * A caller holding a shift UUID — guessed, or left over from another
   * branch — must not be able to learn from the answer whether that drawer
   * exists elsewhere in the merchant. "No such shift" and "somebody else's
   * shift" are one answer, and the repository proves branch and terminal
   * before it looks at status, so even a *closed* foreign drawer answers the
   * same way.
   */
  const NOWHERE = '018f8000-0000-7000-8000-0000000000f9';

  async function answers(cookie: string, shiftId: string, terminalId: string) {
    const movement = await post(
      '/v1/shifts/movements',
      cookie,
      movementPayload({ operationId: nextId(), shiftId, terminalId }),
    );
    const close = await post(
      '/v1/shifts/close',
      cookie,
      closePayload({ operationId: nextId(), shiftId, terminalId }),
    );
    return {
      movement: { status: movement.statusCode, body: movement.payload },
      close: { status: close.statusCode, body: close.payload },
    };
  }

  it('answers identically for a shift that does not exist and one in another branch', async () => {
    await build('manager');
    const cookie = await cookieFor(app);

    // 1. A shift id that names nothing at all, on this session's own till.
    const missing = await answers(cookie, NOWHERE, A.terminal);
    // 2. A real shift in another branch, named through this session's till.
    const elsewhere = await answers(cookie, FOREIGN_SHIFT, A.terminal);

    expect(missing).toEqual(elsewhere);
    expect(missing.movement.status).toBe(404);
    expect(missing.close.status).toBe(404);
    expect(JSON.parse(missing.close.body).error).toBe('unknown-shift');
    // Nothing about the other branch reaches the caller.
    expect(missing.close.body).not.toContain(FOREIGN_BRANCH);
    expect(elsewhere.close.body).not.toContain(FOREIGN_BRANCH);
  });

  it('answers identically for a real shift on a till this session may not use', async () => {
    await build('manager');
    const cookie = await cookieFor(app);

    // 3. A real shift of this branch, named through a different till.
    const wrongTill = await answers(cookie, A.shift, SECOND_TERMINAL);
    const missing = await answers(cookie, NOWHERE, SECOND_TERMINAL);

    expect(wrongTill).toEqual(missing);
    expect(wrongTill.close.status).toBe(404);
    // And the drawer it could not address is untouched.
    expect(business.shifts[0]?.status).toBe('open');
    expect(business.shifts[0]?.movements).toHaveLength(0);
  });

  it('does not reveal that an unaddressable drawer is already closed', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    // A closed shift in another branch answers exactly as a missing one: the
    // repository proves addressability before it looks at status.
    business.shifts[1] = { ...business.shifts[1]!, status: 'closed' };

    const closedElsewhere = await answers(cookie, FOREIGN_SHIFT, A.terminal);
    const missing = await answers(cookie, NOWHERE, A.terminal);

    expect(closedElsewhere).toEqual(missing);
    expect(closedElsewhere.close.body).not.toContain('shift-closed');
  });
});

describe('closing the drawer', () => {
  it('derives expected cash and variance from what was persisted', async () => {
    await build('manager');
    const cookie = await cookieFor(app);

    await post('/v1/shifts/movements', cookie, movementPayload());
    await post(
      '/v1/shifts/movements',
      cookie,
      movementPayload({
        operationId: OPERATIONS.second,
        kind: 'pay-out',
        amountMinor: '750',
        reason: 'مصروف',
      }),
    );

    // opening 20000 + paid in 5000 - paid out 750 = 24250. Count one over.
    const response = await post(
      '/v1/shifts/close',
      cookie,
      closePayload({ operationId: nextId(), declaredCashMinor: '24251' }),
    );

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload) as {
      shift: {
        closedByUserId: string;
        status: string;
        reconciliation: Record<string, string>;
      };
    };
    expect(body.shift.status).toBe('closed');
    expect(body.shift.closedByUserId).toBe(A.user);
    expect(body.shift.reconciliation).toMatchObject({
      openingFloatMinor: '20000',
      cashSalesMinor: '0',
      cashRefundsMinor: '0',
      paidInMinor: '5000',
      paidOutMinor: '750',
      expectedCashMinor: '24250',
      declaredCashMinor: '24251',
      varianceMinor: '1',
    });
  });

  it('never reveals the expected cash before the count is submitted', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    await post('/v1/shifts/movements', cookie, movementPayload());

    const current = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${A.terminal}`,
      headers: { cookie },
    });

    expect(current.statusCode).toBe(200);
    // A number shown beforehand is a number to count towards.
    expect(current.payload).not.toContain('expectedCash');
    expect(current.payload).not.toContain('variance');
    expect(current.payload).not.toContain('paidIn');
    expect(current.payload).not.toContain('24250');
  });

  it('refuses a close by somebody who does not own the shift', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    business.shifts[0] = { ...business.shifts[0]!, userId: OTHER_USER };

    const response = await post('/v1/shifts/close', cookie, closePayload());
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.payload).error).toBe('not-shift-owner');
  });

  it('answers an identical retry with the original snapshot, unrecomputed', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const payload = closePayload();

    const first = await post('/v1/shifts/close', cookie, payload);
    // A sale would have changed the expected figure had the retry recomputed.
    await post('/v1/shifts/close', cookie, payload);
    const second = await post('/v1/shifts/close', cookie, payload);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.payload).replayed).toBe(true);
    expect(JSON.parse(second.payload).shift.reconciliation).toEqual(
      JSON.parse(first.payload).shift.reconciliation,
    );
    expect(JSON.parse(second.payload).shift.closedAt).toBe(
      JSON.parse(first.payload).shift.closedAt,
    );
  });

  it('refuses the same operation id carrying a different count', async () => {
    await build('manager');
    const cookie = await cookieFor(app);

    await post('/v1/shifts/close', cookie, closePayload());
    const conflicting = await post(
      '/v1/shifts/close',
      cookie,
      closePayload({ declaredCashMinor: '19999' }),
    );

    expect(conflicting.statusCode).toBe(409);
    expect(JSON.parse(conflicting.payload).error).toBe('idempotency-conflict');
  });

  it('refuses a second close under a new operation id', async () => {
    await build('manager');
    const cookie = await cookieFor(app);

    await post('/v1/shifts/close', cookie, closePayload());
    const stale = await post(
      '/v1/shifts/close',
      cookie,
      closePayload({ operationId: OPERATIONS.second }),
    );

    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.payload).error).toBe('shift-closed');
  });

  it('refuses a till in another branch', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const response = await post(
      '/v1/shifts/close',
      cookie,
      closePayload({ terminalId: FOREIGN_TERMINAL, shiftId: FOREIGN_SHIFT }),
    );
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.payload).error).toBe('unknown-terminal');
  });
});

describe('an operation id belongs to whoever minted it', () => {
  /**
   * The fingerprint binds the actor and the branch, and both come from the
   * session rather than the body.
   *
   * Without that binding an operation id is a bearer token for somebody else's
   * transaction: a second cashier replaying a colleague's close would be
   * handed that colleague's reconciliation, and a second manager reusing an
   * operation id would inherit a movement recorded under another name. Neither
   * is a retry; both are identity swaps wearing a retry's clothes (ADR-0017).
   */

  it('replays a close for the cashier who performed it', async () => {
    await build('cashier');
    const cookie = await cookieFor(app);
    const payload = closePayload();

    const first = await post('/v1/shifts/close', cookie, payload);
    const again = await post('/v1/shifts/close', cookie, payload);

    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.payload).replayed).toBe(true);
    expect(JSON.parse(again.payload).shift.reconciliation).toEqual(
      JSON.parse(first.payload).shift.reconciliation,
    );
    expect(JSON.parse(again.payload).shift.closedByUserId).toBe(A.user);
  });

  it('refuses a second user replaying that close, and shows them nothing', async () => {
    await build('cashier');
    const mine = await cookieFor(app);
    const theirs = await cookieFor(app, 'omar@korvi-a.test');
    const payload = closePayload();

    const first = await post('/v1/shifts/close', mine, payload);
    expect(first.statusCode).toBe(201);
    const snapshot = JSON.parse(first.payload).shift;

    const stolen = await post('/v1/shifts/close', theirs, payload);

    expect(stolen.statusCode).toBe(409);
    expect(JSON.parse(stolen.payload).error).toBe('idempotency-conflict');
    // Not one figure of the first cashier's count reaches the second.
    expect(stolen.payload).not.toContain('reconciliation');
    expect(stolen.payload).not.toContain(snapshot.reconciliation.expectedCashMinor);
    expect(stolen.payload).not.toContain(snapshot.reconciliation.varianceMinor);
  });

  it('leaves the snapshot and the closer untouched after a refused replay', async () => {
    await build('cashier');
    const mine = await cookieFor(app);
    const theirs = await cookieFor(app, 'omar@korvi-a.test');

    await post('/v1/shifts/close', mine, closePayload());
    const closed = { ...business.shifts[0]! };

    await post('/v1/shifts/close', theirs, closePayload());

    const after = business.shifts[0]!;
    expect(after.closedByUserId).toBe(A.user);
    expect(after.closedByUserId).not.toBe(OTHER_USER);
    expect(after.reconciliation).toEqual(closed.reconciliation);
    expect(after.declaredCashMinor).toBe(closed.declaredCashMinor);
    expect(after.expectedCashMinor).toBe(closed.expectedCashMinor);
    expect(after.varianceMinor).toBe(closed.varianceMinor);
    expect(after.closedAt).toBe(closed.closedAt);
  });

  it('replays a manual movement for the manager who performed it', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const payload = movementPayload();

    const first = await post('/v1/shifts/movements', cookie, payload);
    const again = await post('/v1/shifts/movements', cookie, payload);

    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.payload).replayed).toBe(true);
    expect(JSON.parse(again.payload).movement.movementId).toBe(
      JSON.parse(first.payload).movement.movementId,
    );
    expect(business.shifts[0]?.movements).toHaveLength(1);
  });

  it('refuses a second manager reusing that operation id, and keeps the first name on it', async () => {
    await build('manager');
    const mine = await cookieFor(app);
    const theirs = await cookieFor(app, 'omar@korvi-a.test');
    const payload = movementPayload();

    expect((await post('/v1/shifts/movements', mine, payload)).statusCode).toBe(201);
    const stolen = await post('/v1/shifts/movements', theirs, payload);

    expect(stolen.statusCode).toBe(409);
    expect(JSON.parse(stolen.payload).error).toBe('idempotency-conflict');
    // One movement, still recorded under the manager who actually made it.
    const movements = business.shifts[0]?.movements ?? [];
    expect(movements).toHaveLength(1);
    expect(movements[0]?.actorUserId).toBe(A.user);
    expect(movements[0]?.actorUserId).not.toBe(OTHER_USER);
  });
});

describe('what the browser may not decide', () => {
  const forbidden: readonly [string, Record<string, unknown>][] = [
    ['an expected cash', { expectedCashMinor: '1' }],
    ['a variance', { varianceMinor: '0' }],
    ['a cash sales total', { cashSalesMinor: '0' }],
    ['a cash refunds total', { cashRefundsMinor: '0' }],
    ['a paid-in total', { paidInMinor: '0' }],
    ['a paid-out total', { paidOutMinor: '0' }],
    ['a closer', { closedByUserId: '018f8000-0000-7000-8000-0000000000d4' }],
    ['a branch', { branchId: '018f8000-0000-7000-8000-0000000000b1' }],
    ['a user', { userId: '018f8000-0000-7000-8000-0000000000d4' }],
    ['a status', { status: 'open' }],
  ];

  for (const [what, extra] of forbidden) {
    it(`refuses ${what} on a close, by name`, async () => {
      await build('manager');
      const cookie = await cookieFor(app);
      const response = await post('/v1/shifts/close', cookie, closePayload(extra));

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).error).toBe('forbidden_field');
      expect(business.shifts[0]?.status).toBe('open');
    });
  }

  it('accepts the shiftId and terminalId a drawer request must carry', async () => {
    // The defect this exists to catch: a global forbidden-field list that
    // names shiftId for the sale routes and rejects it here.
    await build('manager');
    const cookie = await cookieFor(app);
    const response = await post('/v1/shifts/close', cookie, closePayload());

    expect(response.statusCode).toBe(201);
    expect(response.payload).not.toContain('forbidden_field');
  });

  it('still refuses a shiftId on a sale, where it never belonged', async () => {
    await build('manager');
    const cookie = await cookieFor(app);
    const response = await post('/v1/sales', cookie, {
      operationId: nextId(),
      terminalId: A.terminal,
      shiftId: A.shift,
      cashReceivedMinor: '10000',
      lines: [{ productId: A.milk, quantityScaled: '1000' }],
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).field).toBe('shiftId');
  });
});
