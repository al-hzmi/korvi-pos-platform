import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activateTenant, createPrismaClient, suspendTenant, withTenant } from '../index.js';
import {
  PLATFORM_OPERATIONAL_BOOTSTRAP_SCOPE,
  provisionTenantOperations,
} from '../control-plane/operational-bootstrap.js';
import type { PlatformOperationalBootstrapRefusedError } from '../control-plane/operational-bootstrap.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = '018f6500-0000-7000-8000-00000000000a';
const B = '018f6500-0000-7000-8000-00000000000b';
const BRANCH_ROLLBACK = '018f6500-0000-7000-8000-0000000000b1';

function request(tenantId: string, operationId: string) {
  return {
    tenantId,
    operationId,
    controlPlaneActorRef: 'platform:test/onboarding',
    branch: {
      code: 'BR-01',
      nameAr: 'الفرع الرئيسي',
      nameEn: 'Main branch',
    },
    terminal: {
      code: 'POS-01',
      label: 'الكاشير الرئيسي',
    },
  } as const;
}

describe.skipIf(url === '')('platform operational bootstrap, live', () => {
  let prisma: ReturnType<typeof createPrismaClient>;

  async function removeTenant(id: string): Promise<void> {
    await withTenant(prisma, id, async (tx) => {
      await tx.$executeRaw`DELETE FROM "tenants" WHERE "id" = ${id}::uuid`;
    });
  }

  async function seedTenant(id: string, slug: string): Promise<void> {
    await withTenant(prisma, id, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "tenants" ("id", "name", "slug", "status", "updatedAt")
        VALUES (${id}::uuid, ${`Tenant ${slug}`}, ${slug}, 'provisioning', now())
      `;
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await prisma.$connect();
  });

  beforeEach(async () => {
    await removeTenant(A);
    await removeTenant(B);
    await seedTenant(A, 'ops-bootstrap-a');
    await seedTenant(B, 'ops-bootstrap-b');
  });

  afterAll(async () => {
    await removeTenant(A);
    await removeTenant(B);
    await prisma.$disconnect();
  });

  it('creates an active branch and terminal with platform audit evidence atomically', async () => {
    const created = await provisionTenantOperations(prisma, request(A, 'ops-a-1'));

    expect(created.replayed).toBe(false);
    expect(created.branch).toMatchObject({
      code: 'BR-01',
      nameAr: 'الفرع الرئيسي',
      isActive: true,
    });
    expect(created.terminal).toMatchObject({
      branchId: created.branch.id,
      code: 'POS-01',
      label: 'الكاشير الرئيسي',
      isActive: true,
    });

    const evidence = await withTenant(prisma, A, async (tx) => {
      const audits = await tx.auditEvent.findMany({
        where: {
          tenantId: A,
          eventType: { in: ['platform.branch-provisioned', 'platform.terminal-provisioned'] },
        },
        orderBy: { eventType: 'asc' },
      });
      const reservations = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count"
        FROM "idempotency_keys"
        WHERE "tenantId" = ${A}::uuid
          AND "scope" = ${PLATFORM_OPERATIONAL_BOOTSTRAP_SCOPE}
          AND "operationId" = 'ops-a-1'
      `;
      return { audits, reservations: reservations[0]?.count ?? 0n };
    });

    expect(evidence.audits).toHaveLength(2);
    expect(evidence.audits.every((row) => row.actorUserId === null)).toBe(true);
    expect(evidence.audits.every((row) => row.metadata !== null)).toBe(true);
    expect(evidence.reservations).toBe(1n);
  });

  it('replays the same operation without duplicate branch, terminal or audit rows', async () => {
    const first = await provisionTenantOperations(prisma, request(A, 'ops-replay'));
    const replay = await provisionTenantOperations(prisma, request(A, 'ops-replay'));

    expect(replay.replayed).toBe(true);
    expect(replay.branch.id).toBe(first.branch.id);
    expect(replay.terminal.id).toBe(first.terminal.id);

    const counts = await withTenant(prisma, A, async (tx) => ({
      branches: await tx.branch.count({ where: { tenantId: A } }),
      terminals: await tx.terminal.count({ where: { tenantId: A } }),
      audits: await tx.auditEvent.count({
        where: {
          tenantId: A,
          eventType: { in: ['platform.branch-provisioned', 'platform.terminal-provisioned'] },
        },
      }),
    }));

    expect(counts).toEqual({ branches: 1, terminals: 1, audits: 2 });
  });

  it('refuses a changed intent under the same operation id', async () => {
    await provisionTenantOperations(prisma, request(A, 'ops-conflict'));

    await expect(
      provisionTenantOperations(prisma, {
        ...request(A, 'ops-conflict'),
        terminal: { code: 'POS-02', label: 'كاشير مختلف' },
      }),
    ).rejects.toMatchObject({
      name: 'PlatformOperationalBootstrapRefusedError',
      detail: 'idempotency-conflict',
    } satisfies Partial<PlatformOperationalBootstrapRefusedError>);
  });

  it('keeps branch and terminal codes tenant-scoped', async () => {
    const left = await provisionTenantOperations(prisma, request(A, 'ops-tenant-a'));
    const right = await provisionTenantOperations(prisma, request(B, 'ops-tenant-b'));

    expect(left.branch.code).toBe(right.branch.code);
    expect(left.terminal.code).toBe(right.terminal.code);
    expect(left.branch.id).not.toBe(right.branch.id);
    expect(left.terminal.id).not.toBe(right.terminal.id);
  });

  it('rolls back the branch, audit and idempotency record when terminal creation cannot begin', async () => {
    let ids = 0;
    const failingId = (): string => {
      ids += 1;
      if (ids === 1) return BRANCH_ROLLBACK;
      throw new Error('injected-operational-bootstrap-failure');
    };

    await expect(
      provisionTenantOperations(
        prisma,
        request(A, 'ops-rollback'),
        () => new Date('2026-09-15T04:00:00.000Z'),
        failingId,
      ),
    ).rejects.toThrow('injected-operational-bootstrap-failure');

    const residue = await withTenant(prisma, A, async (tx) => {
      const rows = await tx.$queryRaw<
        { branches: bigint; terminals: bigint; audits: bigint; reservations: bigint }[]
      >`
        SELECT
          (SELECT count(*) FROM "branches" WHERE "tenantId" = ${A}::uuid) AS "branches",
          (SELECT count(*) FROM "terminals" WHERE "tenantId" = ${A}::uuid) AS "terminals",
          (SELECT count(*) FROM "audit_events"
            WHERE "tenantId" = ${A}::uuid
              AND "eventType" IN ('platform.branch-provisioned', 'platform.terminal-provisioned')) AS "audits",
          (SELECT count(*) FROM "idempotency_keys"
            WHERE "tenantId" = ${A}::uuid
              AND "scope" = ${PLATFORM_OPERATIONAL_BOOTSTRAP_SCOPE}
              AND "operationId" = 'ops-rollback') AS "reservations"
      `;
      return rows[0]!;
    });

    expect(residue).toEqual({
      branches: 0n,
      terminals: 0n,
      audits: 0n,
      reservations: 0n,
    });
  });

  it('fails closed while the tenant is suspended', async () => {
    await activateTenant(prisma, {
      tenantId: A,
      operationId: 'ops-suspended-activate',
      controlPlaneActorRef: 'platform:test/onboarding',
    });
    await suspendTenant(prisma, {
      tenantId: A,
      operationId: 'ops-suspended-suspend',
      controlPlaneActorRef: 'platform:test/onboarding',
      reason: 'Operational bootstrap suspension proof',
    });

    await expect(
      provisionTenantOperations(prisma, request(A, 'ops-suspended')),
    ).rejects.toMatchObject({
      name: 'PlatformOperationalBootstrapRefusedError',
      detail: 'tenant-suspended',
    } satisfies Partial<PlatformOperationalBootstrapRefusedError>);
  });
});
