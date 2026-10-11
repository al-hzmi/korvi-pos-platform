import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantId as brandTenantId } from '@korvi/domain';
import {
  createLoyaltyPolicy,
  createPrismaClient,
  enrollLoyaltyCustomer,
  readLoyaltyLedger,
  readLoyaltyPolicy,
  reviseLoyaltyPolicy,
  withTenant,
} from '../index.js';
import type { TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const a = {
  tenant: '019b7600-0000-7000-8000-00000000000a',
  user: '019b7600-0000-7000-8000-0000000000a1',
  customer: '019b7600-0000-7000-8000-0000000000a2',
};
const b = { tenant: '019b7600-0000-7000-8000-00000000000b' };
const scope: TenantScope = { tenantId: brandTenantId(a.tenant) };
const foreign: TenantScope = { tenantId: brandTenantId(b.tenant) };
const actor = { userId: a.user };
const input = {
  nameAr: 'نقاط العملاء',
  earnNumerator: '1',
  earnDenominator: '100',
  redeemValueMinorPerPoint: '10',
};

describe.skipIf(url === '')('V2-6 loyalty policy and explicit consent, PostgreSQL 17', () => {
  let prisma: PrismaClient;
  let other: PrismaClient;
  let programId: string;

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    other = createPrismaClient(url);
    for (const tenant of [a.tenant, b.tenant]) {
      await withTenant(prisma, tenant, async (tx) => {
        await tx.tenant.deleteMany({ where: { id: tenant } });
      });
    }
    await withTenant(prisma, a.tenant, async (tx) => {
      await tx.tenant.create({
        data: {
          id: a.tenant,
          slug: 'v26-loyalty-policy-a',
          name: 'متجر نقاط أ',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: a.user,
          tenantId: a.tenant,
          email: 'owner@v26-loyalty.test',
          displayName: 'مالك',
          updatedAt: new Date(),
        },
      });
      await tx.customer.create({
        data: {
          id: a.customer,
          tenantId: a.tenant,
          nameAr: 'عميل وافق على الاشتراك',
          isActive: true,
        },
      });
    });
    await withTenant(prisma, b.tenant, async (tx) => {
      await tx.tenant.create({
        data: {
          id: b.tenant,
          slug: 'v26-loyalty-policy-b',
          name: 'متجر نقاط ب',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });
  }, 120_000);

  afterAll(async () => {
    for (const tenant of [a.tenant, b.tenant]) {
      await withTenant(prisma, tenant, async (tx) => {
        await tx.tenant.deleteMany({ where: { id: tenant } });
      });
    }
    await prisma.$disconnect();
    await other.$disconnect();
  });

  it('creates draft, refuses silent enrollment, and activates revisioned policy', async () => {
    const policy = await createLoyaltyPolicy(prisma, scope, actor, input);
    programId = policy.id;
    expect(policy.status).toBe('draft');
    expect(policy.revision).toBe('1');
    expect(await readLoyaltyPolicy(prisma, scope)).toEqual(policy);
    await expect(
      enrollLoyaltyCustomer(prisma, scope, actor, a.customer, false),
    ).rejects.toMatchObject({ detail: 'not-consented' });
    await expect(
      enrollLoyaltyCustomer(prisma, scope, actor, a.customer, true),
    ).rejects.toMatchObject({ detail: 'program-inactive' });

    const active = await reviseLoyaltyPolicy(prisma, scope, actor, policy.revision, {
      status: 'active',
    });
    expect(active.status).toBe('active');
    expect(active.revision).toBe('2');
    const enrollment = await enrollLoyaltyCustomer(prisma, scope, actor, a.customer, true);
    expect(enrollment).toBeTruthy();
    expect(await readLoyaltyLedger(prisma, scope, a.customer)).toEqual({
      customerId: a.customer,
      enrolled: true,
      balancePoints: '0',
      entries: [],
    });
    await expect(
      enrollLoyaltyCustomer(prisma, scope, actor, a.customer, true),
    ).rejects.toMatchObject({ detail: 'already-enrolled' });
  });

  it('prevents cross-tenant reads, issued-policy edit and forged point grants', async () => {
    const hidden = await withTenant(other, b.tenant, (tx) =>
      tx.loyaltyProgram.findMany({ where: { id: programId } }),
    );
    expect(hidden).toEqual([]);
    expect(await readLoyaltyPolicy(other, foreign)).toBeNull();
    await expect(
      enrollLoyaltyCustomer(other, foreign, actor, a.customer, true),
    ).rejects.toMatchObject({ detail: 'program-inactive' });
    await expect(
      reviseLoyaltyPolicy(prisma, scope, actor, '2', { earnNumerator: '900' }),
    ).rejects.toMatchObject({ detail: 'policy-locked' });

    const enrollment = await withTenant(prisma, a.tenant, (tx) =>
      tx.loyaltyEnrollment.findUniqueOrThrow({
        where: { tenantId_customerId: { tenantId: a.tenant, customerId: a.customer } },
      }),
    );
    await expect(
      withTenant(prisma, a.tenant, (tx) =>
        tx.loyaltyPointEntry.create({
          data: {
            id: '019b7600-0000-7000-8000-0000000000f1',
            tenantId: a.tenant,
            programId,
            enrollmentId: enrollment.id,
            customerId: a.customer,
            operationId: 'forged-gift',
            kind: 'gift',
            pointsDelta: 999999n,
            programRevision: 2n,
            earnNumerator: 1n,
            earnDenominator: 100n,
            redeemValueMinorPerPoint: 10n,
            occurredAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
    expect((await readLoyaltyLedger(prisma, scope, a.customer)).balancePoints).toBe('0');
  });

  it('serializes concurrent policy updates with optimistic revisions', async () => {
    const results = await Promise.allSettled([
      reviseLoyaltyPolicy(prisma, scope, actor, '2', { nameAr: 'نقاط أ' }),
      reviseLoyaltyPolicy(other, scope, actor, '2', { nameAr: 'نقاط ب' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { status: 'rejected', reason: { detail: 'stale-revision' } },
    ]);
    expect((await readLoyaltyPolicy(prisma, scope))?.revision).toBe('3');
  });
});
