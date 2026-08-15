import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantId } from '@korvi/domain';
import type { PlanEntitlementRefusedError } from '../index.js';
import {
  assignTenantPlan,
  createPrismaClient,
  readCommercialAccount,
  suspendTenant,
  withTenant,
} from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = '018f5100-0000-7000-8000-00000000000a';
const B = '018f5100-0000-7000-8000-00000000000b';

describe.skipIf(url === '')('commercial plan entitlement authority, live', () => {
  let prisma: ReturnType<typeof createPrismaClient>;

  async function removeTenant(id: string): Promise<void> {
    await withTenant(prisma, id, async (tx) => {
      await tx.$executeRaw`DELETE FROM "tenants" WHERE "id" = ${id}::uuid`;
    });
  }

  async function seedTenant(id: string, slug: string): Promise<void> {
    await withTenant(prisma, id, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "tenants" ("id","name","slug","updatedAt")
        VALUES (${id}::uuid, ${`Tenant ${slug}`}, ${slug}, now())`;
    });
  }

  const request = (tenant: string, operationId: string) => ({
    tenantId: tenant,
    operationId,
    controlPlaneActorRef: 'ops:platform/nada',
    planKey: 'growth',
    planRevision: 2,
    accountState: 'active' as const,
    entitlements: [
      { key: 'core.pos', kind: 'flag' as const, enabled: true },
      { key: 'limits.branches', kind: 'limit' as const, limit: 5n },
    ],
  });

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await prisma.$connect();
  });

  beforeEach(async () => {
    await removeTenant(A);
    await removeTenant(B);
    await seedTenant(A, 'plan-live-a');
    await seedTenant(B, 'plan-live-b');
  });

  afterAll(async () => {
    await removeTenant(A);
    await removeTenant(B);
    await prisma.$disconnect();
  });

  it('stores one immutable assignment and makes it current atomically', async () => {
    const assigned = await assignTenantPlan(prisma, request(A, 'plan-a-1'));
    expect(assigned.changed).toBe(true);
    expect(assigned.current).toBe(true);
    expect(assigned.planKey).toBe('growth');
    expect(assigned.entitlements).toHaveLength(2);

    const current = await readCommercialAccount(prisma, { tenantId: tenantId(A) });
    expect(current?.assignmentId).toBe(assigned.assignmentId);
    expect(current?.planRevision).toBe(2);
  });

  it('preserves the original replay result after a newer assignment becomes current', async () => {
    const first = await assignTenantPlan(prisma, request(A, 'plan-a-1'));

    const second = await assignTenantPlan(prisma, {
      ...request(A, 'plan-a-2'),
      planKey: 'growth-plus',
      planRevision: 3,
      accountState: 'restricted',
    });

    expect(second.assignmentId).not.toBe(first.assignmentId);
    expect(second.current).toBe(true);

    const replay = await assignTenantPlan(prisma, request(A, 'plan-a-1'));
    expect(replay.changed).toBe(false);
    expect(replay.assignmentId).toBe(first.assignmentId);
    expect(replay.planKey).toBe('growth');
    expect(replay.current).toBe(false);

    const current = await readCommercialAccount(prisma, { tenantId: tenantId(A) });
    expect(current?.assignmentId).toBe(second.assignmentId);
    expect(current?.state).toBe('restricted');
  });

  it('refuses an operation id whose commercial intent changed', async () => {
    await assignTenantPlan(prisma, request(A, 'plan-conflict'));

    await expect(
      assignTenantPlan(prisma, {
        ...request(A, 'plan-conflict'),
        planRevision: 99,
      }),
    ).rejects.toMatchObject({
      name: 'PlanEntitlementRefusedError',
      detail: 'idempotency-conflict',
    } satisfies Partial<PlanEntitlementRefusedError>);
  });

  it('does not expose one tenant commercial account through another scope', async () => {
    await assignTenantPlan(prisma, request(A, 'plan-a-1'));
    expect(await readCommercialAccount(prisma, { tenantId: tenantId(B) })).toBeNull();
  });

  it('rolls back assignment, grants and current pointer when work fails mid-transaction', async () => {
    let calls = 0;
    const failingId = (): string => {
      calls += 1;
      if (calls === 3) throw new Error('injected-plan-assignment-failure');
      return '018f5100-0000-7000-8000-0000000000f1';
    };

    await expect(
      assignTenantPlan(prisma, request(A, 'plan-rollback'), () => new Date(), failingId),
    ).rejects.toThrow('injected-plan-assignment-failure');

    const residue = await withTenant(prisma, A, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          assignments: bigint;
          entitlements: bigint;
          accounts: bigint;
          audits: bigint;
        }[]
      >`
        SELECT
          (SELECT count(*) FROM "tenant_plan_assignments"
            WHERE "tenantId" = ${A}::uuid
              AND "operationId" = 'plan-rollback') AS "assignments",
          (SELECT count(*) FROM "tenant_plan_entitlements"
            WHERE "tenantId" = ${A}::uuid) AS "entitlements",
          (SELECT count(*) FROM "tenant_commercial_accounts"
            WHERE "tenantId" = ${A}::uuid) AS "accounts",
          (SELECT count(*) FROM "audit_events"
            WHERE "tenantId" = ${A}::uuid
              AND "eventType" = 'commercial.plan-assigned') AS "audits"`;
      return rows[0]!;
    });

    expect(residue).toEqual({
      assignments: 0n,
      entitlements: 0n,
      accounts: 0n,
      audits: 0n,
    });

    const retry = await assignTenantPlan(prisma, request(A, 'plan-rollback'));
    expect(retry.changed).toBe(true);
    expect(retry.current).toBe(true);
  });

  it('serializes lifecycle and commercial assignment while keeping their states independent', async () => {
    await withTenant(prisma, A, async (tx) => {
      await tx.tenant.update({
        where: { id: A },
        data: {
          status: 'active',
          activatedAt: new Date('2026-08-15T12:00:00.000Z'),
          updatedAt: new Date('2026-08-15T12:00:00.000Z'),
        },
      });
    });

    const [plan, suspension] = await Promise.all([
      assignTenantPlan(prisma, request(A, 'plan-vs-lifecycle')),
      suspendTenant(prisma, {
        tenantId: A,
        operationId: 'suspend-vs-plan',
        controlPlaneActorRef: 'ops:platform/nada',
        reason: 'directed concurrency proof',
      }),
    ]);

    expect(plan.current).toBe(true);
    expect(suspension.status).toBe('suspended');

    const final = await withTenant(prisma, A, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: A } });
      return tenant.status;
    });

    const commercial = await readCommercialAccount(prisma, {
      tenantId: tenantId(A),
    });

    expect(final).toBe('suspended');
    expect(commercial?.state).toBe('active');
    expect(commercial?.assignmentId).toBe(plan.assignmentId);
  });

  it('serializes two identical concurrent attempts to one assignment', async () => {
    const input = request(A, 'plan-race');
    const [left, right] = await Promise.all([
      assignTenantPlan(prisma, input),
      assignTenantPlan(prisma, input),
    ]);

    expect(left.assignmentId).toBe(right.assignmentId);
    expect([left.changed, right.changed].sort()).toEqual([false, true]);
  });
});
