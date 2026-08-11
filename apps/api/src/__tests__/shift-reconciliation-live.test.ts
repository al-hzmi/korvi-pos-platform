import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantId as brandTenantId } from '@korvi/domain';
import {
  createPrismaClient,
  createShiftReconciliationRepository,
  withTenant,
} from '@korvi/database';
import type { PrismaClient } from '@korvi/database';
import type { ManualCashMovementInput, ReconcileShiftInput, TenantScope } from '@korvi/domain';

/** Real PostgreSQL serialization proofs. TEST_DATABASE_URL must name a migrated throwaway DB. */
const url = process.env['TEST_DATABASE_URL'] ?? '';
const X = {
  tenant: '018f7100-0000-7000-8000-000000000001',
  branch: '018f7100-0000-7000-8000-000000000002',
  terminal: '018f7100-0000-7000-8000-000000000003',
  shift: '018f7100-0000-7000-8000-000000000004',
  user: '018f7100-0000-7000-8000-000000000005',
  membership: '018f7100-0000-7000-8000-000000000006',
} as const;
const scope: TenantScope = { tenantId: brandTenantId(X.tenant) };
let sequence = 100;
const uuid = (): string => `018f7100-0000-7000-8000-${String(sequence++).padStart(12, '0')}`;

describe.skipIf(url === '')('shift reconciliation concurrency, live PostgreSQL', () => {
  let prisma: PrismaClient;
  let rival: PrismaClient;
  beforeAll(async () => {
    prisma = createPrismaClient(url);
    rival = createPrismaClient(url);
    await withTenant(prisma, scope.tenantId, (tx) =>
      tx.tenant.deleteMany({ where: { id: X.tenant } }).then(() => undefined),
    );
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: X.tenant,
          name: 'reconcile',
          slug: 'reconcile-live',
          vatNumber: '300000000000003',
          updatedAt: new Date(),
        },
      });
      await tx.branch.create({
        data: {
          id: X.branch,
          tenantId: X.tenant,
          code: '71',
          nameAr: 'فرع',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: X.user,
          tenantId: X.tenant,
          email: 'live@reconcile.test',
          displayName: 'Live',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: X.membership, tenantId: X.tenant, userId: X.user, updatedAt: new Date() },
      });
      await tx.terminal.create({
        data: {
          id: X.terminal,
          tenantId: X.tenant,
          branchId: X.branch,
          code: '71',
          label: 'Till',
          updatedAt: new Date(),
        },
      });
      await tx.shift.create({
        data: {
          id: X.shift,
          tenantId: X.tenant,
          branchId: X.branch,
          terminalId: X.terminal,
          userId: X.user,
          openingFloatMinor: 100n,
          openedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });
  }, 90_000);
  beforeEach(async () => {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.idempotencyKey.deleteMany({ where: { tenantId: X.tenant } });
      await tx.cashMovement.deleteMany({ where: { tenantId: X.tenant, shiftId: X.shift } });
      await tx.shift.update({
        where: { id: X.shift },
        data: {
          status: 'open',
          openingFloatMinor: 100n,
          declaredCashMinor: null,
          expectedCashMinor: null,
          varianceMinor: null,
          cashSalesMinor: null,
          cashRefundsMinor: null,
          paidInMinor: null,
          paidOutMinor: null,
          closedByUserId: null,
          closedAt: null,
        },
      });
    });
  });
  afterAll(async () => {
    await withTenant(prisma, scope.tenantId, (tx) =>
      tx.tenant.deleteMany({ where: { id: X.tenant } }).then(() => undefined),
    );
    await Promise.all([prisma.$disconnect(), rival.$disconnect()]);
  });

  const close = (operationId = uuid(), declaredCashMinor = '100'): ReconcileShiftInput => ({
    idempotencyId: uuid(),
    operationId,
    shiftId: X.shift,
    terminalId: X.terminal,
    branchId: X.branch,
    actorUserId: X.user,
    declaredCashMinor,
    closedAt: new Date().toISOString(),
  });
  const movement = (
    operationId = uuid(),
    over: Partial<ManualCashMovementInput> = {},
  ): ManualCashMovementInput => ({
    idempotencyId: uuid(),
    operationId,
    movementId: uuid(),
    shiftId: X.shift,
    terminalId: X.terminal,
    branchId: X.branch,
    actorUserId: X.user,
    kind: 'pay-in',
    amountMinor: '7',
    reason: 'reason',
    occurredAt: new Date().toISOString(),
    ...over,
  });
  const repo = () => createShiftReconciliationRepository(prisma);

  async function drawerWriteWins(kind: 'sale' | 'refund' | 'pay-in', amount: bigint) {
    let release: (() => void) | undefined;
    let locked: (() => void) | undefined;
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = withTenant(rival, scope.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "shifts" WHERE "tenantId"=${X.tenant}::uuid AND "id"=${X.shift}::uuid FOR UPDATE`;
      locked?.();
      await releasePromise;
      await tx.cashMovement.create({
        data: {
          id: uuid(),
          tenantId: X.tenant,
          shiftId: X.shift,
          kind,
          amountMinor: amount,
          reason: null,
          actorUserId: X.user,
          occurredAt: new Date(),
        },
      });
    });
    await lockedPromise;
    const closing = repo().reconcile(scope, close(uuid(), (100n + amount).toString()));
    release?.();
    await writer;
    return closing;
  }

  it('A sale wins close; close waits and includes it once', async () => {
    expect((await drawerWriteWins('sale', 13n)).cashSalesMinor).toBe('13');
  });
  it('B close wins sale; later drawer write is atomically refused', async () => {
    await repo().reconcile(scope, close());
    await expect(
      withTenant(rival, scope.tenantId, async (tx) => {
        const rows = await tx.$queryRaw<
          { status: string }[]
        >`SELECT "status" FROM "shifts" WHERE "id"=${X.shift}::uuid FOR UPDATE`;
        if (rows.at(0)?.status !== 'open') throw new Error('closed');
        await tx.cashMovement.create({
          data: {
            id: uuid(),
            tenantId: X.tenant,
            shiftId: X.shift,
            kind: 'sale',
            amountMinor: 1n,
            occurredAt: new Date(),
          },
        });
      }),
    ).rejects.toThrow('closed');
    expect(
      await withTenant(prisma, scope.tenantId, (tx) =>
        tx.cashMovement.count({ where: { shiftId: X.shift } }),
      ),
    ).toBe(0);
  });
  it('C cash refund wins close and is subtracted once', async () => {
    expect((await drawerWriteWins('refund', -17n)).cashRefundsMinor).toBe('17');
  });
  it('D close wins refund and no partial return movement survives', async () => {
    await repo().reconcile(scope, close());
    await expect(
      repo().recordManualMovement(scope, movement(uuid(), { kind: 'pay-out' })),
    ).rejects.toThrow();
    expect(
      await withTenant(prisma, scope.tenantId, (tx) =>
        tx.cashMovement.count({ where: { shiftId: X.shift } }),
      ),
    ).toBe(0);
  });
  it('E manual movement wins close and is included once', async () => {
    expect((await drawerWriteWins('pay-in', 19n)).paidInMinor).toBe('19');
  });
  it('F close wins manual movement and rolls its reservation back', async () => {
    await repo().reconcile(scope, close());
    const op = uuid();
    await expect(repo().recordManualMovement(scope, movement(op))).rejects.toThrow();
    expect(
      await withTenant(prisma, scope.tenantId, (tx) =>
        tx.idempotencyKey.count({ where: { operationId: op } }),
      ),
    ).toBe(0);
  });
  it('G two different close operation ids yield exactly one close', async () => {
    const results = await Promise.allSettled([
      repo().reconcile(scope, close()),
      repo().reconcile(scope, close()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('H concurrent identical close retry converges on one immutable result', async () => {
    const op = uuid();
    const input = close(op, '101');
    const [a, b] = await Promise.all([
      repo().reconcile(scope, input),
      repo().reconcile(scope, {
        ...input,
        idempotencyId: uuid(),
        closedAt: new Date().toISOString(),
      }),
    ]);
    expect(a).toEqual(b);
    expect(a.varianceMinor).toBe('1');
  });
  it('I close idempotency conflict rejects changed declaration', async () => {
    const op = uuid();
    await repo().reconcile(scope, close(op, '100'));
    await expect(repo().reconcile(scope, close(op, '101'))).rejects.toThrow(/idempotency/i);
  });
  it('J concurrent identical movement retries persist exactly one movement', async () => {
    const op = uuid();
    const input = movement(op);
    const [a, b] = await Promise.all([
      repo().recordManualMovement(scope, input),
      repo().recordManualMovement(scope, { ...input, idempotencyId: uuid(), movementId: uuid() }),
    ]);
    expect(a.id).toBe(b.id);
    expect(
      await withTenant(prisma, scope.tenantId, (tx) =>
        tx.cashMovement.count({ where: { shiftId: X.shift } }),
      ),
    ).toBe(1);
  });
  it('K movement idempotency conflicts on amount, kind, and reason', async () => {
    const op = uuid();
    await repo().recordManualMovement(scope, movement(op));
    for (const changed of [
      { amountMinor: '8' },
      { kind: 'pay-out' as const },
      { reason: 'changed' },
    ])
      await expect(repo().recordManualMovement(scope, movement(op, changed))).rejects.toThrow(
        /idempotency/i,
      );
  });
  it('L tenant isolation cannot infer or mutate another tenant shift', async () => {
    const foreign: TenantScope = {
      tenantId: brandTenantId('018f7100-0000-7000-8000-000000000099'),
    };
    await expect(repo().reconcile(foreign, close())).rejects.toThrow();
    expect(
      (
        await withTenant(prisma, scope.tenantId, (tx) =>
          tx.shift.findFirst({ where: { id: X.shift } }),
        )
      )?.status,
    ).toBe('open');
  });
  it('M preserves positive and negative one-halala variance', async () => {
    expect((await repo().reconcile(scope, close(uuid(), '101'))).varianceMinor).toBe('1');
    await beforeReset();
    expect((await repo().reconcile(scope, close(uuid(), '99'))).varianceMinor).toBe('-1');
  });
  async function beforeReset() {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.idempotencyKey.deleteMany({});
      await tx.shift.update({
        where: { id: X.shift },
        data: {
          status: 'open',
          closedByUserId: null,
          closedAt: null,
          declaredCashMinor: null,
          expectedCashMinor: null,
          varianceMinor: null,
          cashSalesMinor: null,
          cashRefundsMinor: null,
          paidInMinor: null,
          paidOutMinor: null,
        },
      });
    });
  }
  it('N preserves integers above Number.MAX_SAFE_INTEGER', async () => {
    await withTenant(prisma, scope.tenantId, (tx) =>
      tx.shift
        .update({ where: { id: X.shift }, data: { openingFloatMinor: 9_007_199_254_740_993n } })
        .then(() => undefined),
    );
    expect((await repo().reconcile(scope, close(uuid(), '9007199254740994'))).varianceMinor).toBe(
      '1',
    );
  });
  it('O applies the non-symmetric sign equation exactly', async () => {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      for (const [kind, amount] of [
        ['sale', 37n],
        ['refund', -11n],
        ['pay-in', 19n],
        ['pay-out', -7n],
      ] as const)
        await tx.cashMovement.create({
          data: {
            id: uuid(),
            tenantId: X.tenant,
            shiftId: X.shift,
            kind,
            amountMinor: amount,
            reason: kind.startsWith('pay-') ? 'reason' : null,
            actorUserId: X.user,
            occurredAt: new Date(),
          },
        });
    });
    expect((await repo().reconcile(scope, close(uuid(), '138'))).expectedCashMinor).toBe('138');
  });
  it('P failed operation leaves no snapshot, movement, status change, or idempotency tombstone', async () => {
    const op = uuid();
    await expect(
      repo().recordManualMovement(scope, movement(op, { amountMinor: '0' })),
    ).rejects.toThrow();
    const state = await withTenant(prisma, scope.tenantId, async (tx) => ({
      shift: await tx.shift.findFirst({ where: { id: X.shift } }),
      movements: await tx.cashMovement.count({ where: { shiftId: X.shift } }),
      keys: await tx.idempotencyKey.count({ where: { operationId: op } }),
    }));
    expect(state).toMatchObject({
      movements: 0,
      keys: 0,
      shift: { status: 'open', expectedCashMinor: null },
    });
  });
});
