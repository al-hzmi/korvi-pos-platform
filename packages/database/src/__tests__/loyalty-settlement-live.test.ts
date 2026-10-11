import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantId as brandTenantId } from '@korvi/domain';
import {
  createLoyaltyPolicy,
  createPrismaClient,
  enrollLoyaltyCustomer,
  readLoyaltyLedger,
  reviseLoyaltyPolicy,
  withTenant,
} from '../index.js';
import { earnLoyaltyWithin, reverseEarnedLoyaltyWithin } from '../loyalty/settlement.js';
import type { PrismaClient } from '../index.js';
import type { TenantScope } from '@korvi/domain';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const fixture = {
  tenant: '019b7700-0000-7000-8000-00000000000a',
  branch: '019b7700-0000-7000-8000-0000000000a1',
  terminal: '019b7700-0000-7000-8000-0000000000a2',
  user: '019b7700-0000-7000-8000-0000000000a3',
  shift: '019b7700-0000-7000-8000-0000000000a4',
  customer: '019b7700-0000-7000-8000-0000000000a5',
  sale: '019b7700-0000-7000-8000-0000000000b1',
  sale2: '019b7700-0000-7000-8000-0000000000b2',
  sale3: '019b7700-0000-7000-8000-0000000000b3',
  return1: '019b7700-0000-7000-8000-0000000000c1',
  return2: '019b7700-0000-7000-8000-0000000000c2',
};
const scope: TenantScope = { tenantId: brandTenantId(fixture.tenant) };
const actor = { userId: fixture.user };
const NOW = new Date('2026-10-11T11:00:00Z');

describe.skipIf(url === '')('atomic loyalty earning and original-sale returns, PostgreSQL 17', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;
  let programId: string;
  let enrollmentId: string;

  const saleData = (id: string, sequence: number) => ({
    id,
    tenantId: fixture.tenant,
    branchId: fixture.branch,
    terminalId: fixture.terminal,
    shiftId: fixture.shift,
    userId: fixture.user,
    customerId: fixture.customer,
    operationId: `sale-loyalty-${sequence}`,
    status: 'finalized',
    sequence,
    priceMode: 'tax-exclusive',
    currency: 'SAR',
    grossMinor: 1000n,
    lineDiscountMinor: 0n,
    promotionDiscountMinor: 0n,
    basketDiscountMinor: 0n,
    netMinor: 1000n,
    vatMinor: 150n,
    totalMinor: 1150n,
    tenderedMinor: 1150n,
    changeMinor: 0n,
    issuedAt: NOW,
  });

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    second = createPrismaClient(url);
    await withTenant(prisma, fixture.tenant, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: fixture.tenant } });
      await tx.tenant.create({
        data: {
          id: fixture.tenant,
          slug: 'v26-loyalty-settlement',
          name: 'مطعم الولاء',
          status: 'active',
          activatedAt: NOW,
          updatedAt: NOW,
        },
      });
      await tx.branch.create({
        data: {
          id: fixture.branch,
          tenantId: fixture.tenant,
          code: '01',
          nameAr: 'الفرع',
          updatedAt: NOW,
        },
      });
      await tx.user.create({
        data: {
          id: fixture.user,
          tenantId: fixture.tenant,
          email: 'loyalty-settlement@korvi.test',
          displayName: 'كاشير',
          updatedAt: NOW,
        },
      });
      await tx.terminal.create({
        data: {
          id: fixture.terminal,
          tenantId: fixture.tenant,
          branchId: fixture.branch,
          code: '01',
          label: 'صندوق الولاء',
          updatedAt: NOW,
        },
      });
      await tx.shift.create({
        data: {
          id: fixture.shift,
          tenantId: fixture.tenant,
          branchId: fixture.branch,
          terminalId: fixture.terminal,
          userId: fixture.user,
          status: 'open',
          openingFloatMinor: 0n,
          openedAt: NOW,
          updatedAt: NOW,
        },
      });
      await tx.customer.create({
        data: {
          id: fixture.customer,
          tenantId: fixture.tenant,
          nameAr: 'عميل مشترك',
          isActive: true,
        },
      });
    });
    const draft = await createLoyaltyPolicy(prisma, scope, actor, {
      nameAr: 'الولاء',
      earnNumerator: '1',
      earnDenominator: '100',
      redeemValueMinorPerPoint: '10',
    });
    programId = draft.id;
    await reviseLoyaltyPolicy(prisma, scope, actor, draft.revision, { status: 'active' });
    enrollmentId = await enrollLoyaltyCustomer(prisma, scope, actor, fixture.customer, true);
  }, 120_000);

  afterAll(async () => {
    await withTenant(prisma, fixture.tenant, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: fixture.tenant } });
    });
    await prisma.$disconnect();
    await second.$disconnect();
  });

  it('earns exactly 10 non-cash points within the committed original sale, never on replay', async () => {
    await withTenant(prisma, fixture.tenant, async (tx) => {
      await tx.sale.create({ data: saleData(fixture.sale, 1) });
      await earnLoyaltyWithin(tx, fixture.tenant, {
        id: fixture.sale,
        customerId: fixture.customer,
        status: 'finalized',
        netMinor: '1000',
        userId: fixture.user,
        branchId: fixture.branch,
        terminalId: fixture.terminal,
        issuedAt: NOW.toISOString(),
      });
    });
    expect((await readLoyaltyLedger(prisma, scope, fixture.customer)).balancePoints).toBe('10');
    await expect(
      withTenant(prisma, fixture.tenant, (tx) =>
        earnLoyaltyWithin(tx, fixture.tenant, {
          id: fixture.sale,
          customerId: fixture.customer,
          status: 'finalized',
          netMinor: '1000',
          userId: fixture.user,
          branchId: fixture.branch,
          terminalId: fixture.terminal,
          issuedAt: NOW.toISOString(),
        }),
      ),
    ).rejects.toThrow();
    const ledger = await readLoyaltyLedger(prisma, scope, fixture.customer);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.kind).toBe('earn');
    expect(ledger.entries[0]?.pointsDelta).toBe('10');
  });

  it('refuses two concurrent redemptions of the last 10 points', async () => {
    await withTenant(prisma, fixture.tenant, async (tx) => {
      await tx.sale.createMany({
        data: [saleData(fixture.sale2, 2), saleData(fixture.sale3, 3)],
      });
    });
    const redemption = (client: PrismaClient, saleId: string) =>
      withTenant(client, fixture.tenant, async (tx) => {
        const id = saleId;
        return tx.loyaltyPointEntry.create({
          data: {
            id,
            tenantId: fixture.tenant,
            programId,
            enrollmentId,
            customerId: fixture.customer,
            operationId: `redeem-${saleId}`,
            kind: 'redeem',
            pointsDelta: -7n,
            programRevision: 2n,
            earnNumerator: 1n,
            earnDenominator: 100n,
            redeemValueMinorPerPoint: 10n,
            saleId,
            occurredAt: NOW,
          },
        });
      });
    const attempts = await Promise.allSettled([
      redemption(prisma, fixture.sale2),
      redemption(second, fixture.sale3),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect((await readLoyaltyLedger(prisma, scope, fixture.customer)).balancePoints).toBe('3');
  }, 60_000);

  it('reverses cumulative historic net on partial and final refunds without blocking lawful refund', async () => {
    const recordReturn = async (id: string, sequence: number, net: bigint) => {
      await withTenant(prisma, fixture.tenant, async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "sales"
           WHERE "tenantId" = ${fixture.tenant}::uuid AND "id" = ${fixture.sale}::uuid
           FOR UPDATE
        `;
        await tx.return.create({
          data: {
            id,
            tenantId: fixture.tenant,
            saleId: fixture.sale,
            branchId: fixture.branch,
            terminalId: fixture.terminal,
            shiftId: fixture.shift,
            operationId: `return-loyalty-${sequence}`,
            status: 'finalized',
            sequence,
            returnNumber: `LR-${sequence}`,
            currency: 'SAR',
            grossMinor: net,
            netMinor: net,
            vatMinor: (net * 15n) / 100n,
            totalMinor: net + (net * 15n) / 100n,
            actorUserId: fixture.user,
            issuedAt: NOW,
          },
        });
        await reverseEarnedLoyaltyWithin(tx, fixture.tenant, {
          saleId: fixture.sale,
          returnId: id,
          actorUserId: fixture.user,
          branchId: fixture.branch,
          terminalId: fixture.terminal,
          issuedAt: NOW,
        });
      });
    };
    await recordReturn(fixture.return1, 1, 400n);
    expect((await readLoyaltyLedger(prisma, scope, fixture.customer)).balancePoints).toBe('-1');
    await recordReturn(fixture.return2, 2, 600n);
    const ledger = await readLoyaltyLedger(prisma, scope, fixture.customer);
    expect(ledger.balancePoints).toBe('-7');
    expect(ledger.entries.filter((entry) => entry.kind === 'reverse-earn')).toHaveLength(2);
    expect(
      ledger.entries
        .filter((entry) => entry.kind === 'reverse-earn')
        .reduce((total, entry) => total + BigInt(entry.pointsDelta), 0n),
    ).toBe(-10n);

    const prior = ledger.entries.length;
    await withTenant(prisma, fixture.tenant, (tx) =>
      reverseEarnedLoyaltyWithin(tx, fixture.tenant, {
        saleId: fixture.sale,
        returnId: fixture.return2,
        actorUserId: fixture.user,
        branchId: fixture.branch,
        terminalId: fixture.terminal,
        issuedAt: NOW,
      }),
    );
    expect((await readLoyaltyLedger(prisma, scope, fixture.customer)).entries).toHaveLength(prior);
  }, 60_000);

  it('refuses to mutate past points or spend points when in recovery debt', async () => {
    const ledger = await readLoyaltyLedger(prisma, scope, fixture.customer);
    const first = ledger.entries[0]!;
    await expect(
      withTenant(prisma, fixture.tenant, (tx) =>
        tx.loyaltyPointEntry.update({
          where: { tenantId_id: { tenantId: fixture.tenant, id: first.id } },
          data: { pointsDelta: 99n },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(second, fixture.tenant, (tx) =>
        tx.loyaltyPointEntry.create({
          data: {
            id: '019b7700-0000-7000-8000-0000000000f1',
            tenantId: fixture.tenant,
            programId,
            enrollmentId,
            customerId: fixture.customer,
            operationId: 'overdraw-test',
            kind: 'redeem',
            pointsDelta: -1n,
            programRevision: 2n,
            earnNumerator: 1n,
            earnDenominator: 100n,
            redeemValueMinorPerPoint: 10n,
            saleId: fixture.sale3,
            occurredAt: NOW,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
