import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  assignRole,
  createNoReceiptExchangeRepository,
  createPrismaClient,
  createProductRepository,
  createSaleRepository,
  createShiftRepository,
  createTenantRepository,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  withTenant,
} from '@korvi/database';
import { createNoReceiptExchangeService } from '../no-receipt-exchange/service.js';
import type { NoReceiptExchangeService } from '../no-receipt-exchange/service.js';
import type { PrismaClient } from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '018fd100-0000-7000-8000-00000000000a',
  slug: 'v2-one-live-a',
  branch: '018fd100-0000-7000-8000-0000000000b1',
  terminal: '018fd100-0000-7000-8000-0000000000c1',
  shift: '018fd100-0000-7000-8000-0000000000d1',
  user: '018fd100-0000-7000-8000-0000000000e1',
  membership: '018fd100-0000-7000-8000-0000000000e2',
  accepted: '018fd100-0000-7000-8000-0000000000f1',
  replacement: '018fd100-0000-7000-8000-0000000000f2',
  untracked: '018fd100-0000-7000-8000-0000000000f3',
} as const;

const B = {
  tenant: '018fd100-0000-7000-8000-00000000001a',
  slug: 'v2-one-live-b',
  product: '018fd100-0000-7000-8000-00000000001f',
} as const;

describe.skipIf(url === '')('Mastermind V2-1 no-receipt exchange, PostgreSQL live', () => {
  let prisma: PrismaClient;
  let service: NoReceiptExchangeService;
  let principal: AuthenticatedPrincipal;

  const scope: TenantScope = { tenantId: brandTenantId(A.tenant) };
  const otherScope: TenantScope = { tenantId: brandTenantId(B.tenant) };

  async function remove(): Promise<void> {
    for (const id of [A.tenant, B.tenant]) {
      await withTenant(prisma, brandTenantId(id), async (tx) => {
        await tx.tenant.deleteMany({ where: { id } });
      });
    }
  }

  function request(
    input: {
      readonly operationId?: string;
      readonly acceptedProductId?: string;
      readonly replacementProductId?: string;
      readonly acceptedQuantityScaled?: string;
      readonly replacementQuantityScaled?: string;
      readonly approvedAllowanceMinor?: string;
      readonly cashMinor?: string | null;
    } = {},
  ) {
    const cashMinor = input.cashMinor === undefined ? '1150' : input.cashMinor;
    return {
      principal,
      operationId: input.operationId ?? newId(),
      terminalId: A.terminal,
      expectedShiftId: A.shift,
      reason: 'customer-no-receipt' as const,
      evidenceNote: 'فحص فعلي للسلعة أمام المشرف',
      approvedAllowanceMinor: input.approvedAllowanceMinor ?? '1150',
      acceptedLines: [
        {
          productId: input.acceptedProductId ?? A.accepted,
          quantityScaled: input.acceptedQuantityScaled ?? '1000',
        },
      ],
      replacementLines: [
        {
          productId: input.replacementProductId ?? A.replacement,
          quantityScaled: input.replacementQuantityScaled ?? '1000',
        },
      ],
      tenders: cashMinor === null ? [] : [{ kind: 'cash' as const, amountMinor: cashMinor }],
    };
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: A.tenant,
          name: 'متجر V2-1',
          slug: A.slug,
          vatNumber: '300000000000003',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({
        data: {
          tenantId: A.tenant,
          vertical: 'retail',
          priceMode: 'tax-inclusive',
          currency: 'SAR',
          allowNegativeStock: false,
          updatedAt: new Date(),
        },
      });
      await tx.branch.create({
        data: {
          id: A.branch,
          tenantId: A.tenant,
          code: 'V21',
          nameAr: 'فرع V2-1',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: A.user,
          tenantId: A.tenant,
          email: 'manager@v2-one-live.test',
          displayName: 'مدير V2-1',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: {
          id: A.membership,
          tenantId: A.tenant,
          userId: A.user,
          defaultBranchId: A.branch,
          updatedAt: new Date(),
        },
      });
      await tx.terminal.create({
        data: {
          id: A.terminal,
          tenantId: A.tenant,
          branchId: A.branch,
          code: '01',
          label: 'صندوق V2-1',
          updatedAt: new Date(),
        },
      });
      await tx.shift.create({
        data: {
          id: A.shift,
          tenantId: A.tenant,
          branchId: A.branch,
          terminalId: A.terminal,
          userId: A.user,
          openingFloatMinor: 10_000n,
          openedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      for (const [id, sku, priceMinor, tracked, initialQuantity] of [
        [A.accepted, 'V21-ACCEPTED', 1_150n, true, 1_000n],
        [A.replacement, 'V21-REPLACEMENT', 2_300n, true, 5_000n],
        [A.untracked, 'V21-UNTRACKED', 575n, false, 0n],
      ] as const) {
        await tx.product.create({
          data: {
            id,
            tenantId: A.tenant,
            sku,
            nameAr: sku,
            productType: 'unit',
            priceMinor,
            vatBasisPoints: 1500,
            trackInventory: tracked,
            updatedAt: new Date(),
          },
        });
        if (tracked) {
          await tx.inventoryBalance.create({
            data: {
              tenantId: A.tenant,
              branchId: A.branch,
              productId: id,
              quantityScaled: initialQuantity,
              updatedAt: new Date(),
            },
          });
        }
      }
    });

    await withTenant(prisma, otherScope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: B.tenant,
          name: 'متجر آخر',
          slug: B.slug,
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.product.create({
        data: {
          id: B.product,
          tenantId: B.tenant,
          sku: 'OTHER-TENANT',
          nameAr: 'صنف تاجر آخر',
          productType: 'unit',
          priceMinor: 1_150n,
          vatBasisPoints: 1500,
          trackInventory: false,
          updatedAt: new Date(),
        },
      });
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, A.user, 'manager');

    const exchanges = createNoReceiptExchangeRepository(prisma);
    service = createNoReceiptExchangeService({
      tenants: createTenantRepository(prisma),
      products: createProductRepository(prisma),
      shifts: createShiftRepository(prisma),
      sales: createSaleRepository(prisma),
      exchanges,
    });

    principal = {
      tenantId: A.tenant,
      tenantSlug: A.slug,
      userId: A.user,
      sessionId: newId(),
      email: 'manager@v2-one-live.test',
      displayName: 'مدير V2-1',
      roles: ['manager'],
      permissions: ['sale.exchange.no-receipt', 'product.read'],
      maxDiscountBasisPoints: 0n,
      branchId: A.branch,
    };
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  it('A. atomically commits case + unknown-cost intake + replacement sale + allowance + audit', async () => {
    const result = await service.create(request());
    if (result.outcome !== 'success') throw new Error(result.reason);

    const stored = await withTenant(prisma, scope.tenantId, async (tx) => {
      const exchange = await tx.noReceiptExchangeCase.findFirst({
        where: { id: result.case.id },
        include: { lines: true },
      });
      const intake = await tx.inventoryMovement.findMany({
        where: { sourceType: 'no-receipt-exchange', sourceId: result.case.id },
      });
      const sale = await tx.sale.findFirst({
        where: { id: result.sale.saleId },
        include: { tenders: true },
      });
      const audits = await tx.auditEvent.findMany({
        where: {
          OR: [
            { entityType: 'no-receipt-exchange', entityId: result.case.id },
            { entityType: 'sale', entityId: result.sale.saleId },
          ],
        },
      });
      const acceptedBalance = await tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.accepted },
      });
      const replacementBalance = await tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.replacement },
      });
      return { exchange, intake, sale, audits, acceptedBalance, replacementBalance };
    });

    expect(stored.exchange?.caseNumber).toMatch(/^NR-V21-\d{6}$/);
    expect(stored.exchange?.lines).toHaveLength(1);
    expect(stored.intake).toHaveLength(1);
    expect(stored.intake[0]?.quantityScaled).toBe(1_000n);
    expect(stored.intake[0]?.costKnownQuantityScaled).toBe(0n);
    expect(stored.intake[0]?.costUnknownQuantityScaled).toBe(1_000n);
    expect(stored.intake[0]?.costValueMinor).toBe(0n);
    expect(stored.intake[0]?.costProvenance).toBe('unknown');
    expect(stored.sale?.tenders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'exchange_allowance',
          amountMinor: 1_150n,
          changeMinor: 0n,
          scheme: null,
          reference: null,
        }),
        expect.objectContaining({ kind: 'cash', amountMinor: 1_150n }),
      ]),
    );
    expect(stored.audits.map((event) => event.eventType).sort()).toEqual([
      'no-receipt-exchange.completed',
      'sale.completed',
    ]);
    expect(stored.acceptedBalance?.quantityScaled).toBe(2_000n);
    expect(stored.replacementBalance?.quantityScaled).toBe(4_000n);
  });

  it('B. a non-tracked accepted product creates no stock intake movement', async () => {
    const result = await service.create(
      request({
        acceptedProductId: A.untracked,
        approvedAllowanceMinor: '575',
        cashMinor: '1725',
      }),
    );
    if (result.outcome !== 'success') throw new Error(result.reason);

    const movements = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryMovement.findMany({
        where: { sourceType: 'no-receipt-exchange', sourceId: result.case.id },
      }),
    );
    expect(movements).toHaveLength(0);
  });

  it('C. exact concurrent replays create one case, one sale and consume the allowance once', async () => {
    const operationId = newId();
    const same = request({ operationId });

    const results = await Promise.all([service.create(same), service.create(same)]);
    expect(results.every((result) => result.outcome === 'success')).toBe(true);

    const counts = await withTenant(prisma, scope.tenantId, async (tx) => {
      const cases = await tx.noReceiptExchangeCase.findMany({
        where: { operationId },
        select: { id: true, linkedSaleId: true },
      });
      const saleIds = cases.map((row) => row.linkedSaleId);
      return {
        cases: cases.length,
        sales: await tx.sale.count({ where: { id: { in: saleIds } } }),
        allowances: await tx.tender.count({
          where: { saleId: { in: saleIds }, kind: 'exchange_allowance' },
        }),
        keys: await tx.idempotencyKey.count({
          where: { scope: 'no-receipt-exchange', operationId },
        }),
      };
    });

    expect(counts).toEqual({ cases: 1, sales: 1, allowances: 1, keys: 1 });
  });

  it('D. same operation id with different material intent conflicts', async () => {
    const operationId = newId();
    const first = await service.create(request({ operationId }));
    expect(first.outcome).toBe('success');

    const second = await service.create(
      request({ operationId, approvedAllowanceMinor: '1000', cashMinor: '1300' }),
    );
    expect(second).toEqual({ outcome: 'failure', reason: 'idempotency-conflict' });
  });

  it('E. a late replacement-stock failure rolls back intake, case, sale, audit and idempotency', async () => {
    const operationId = newId();
    const before = await withTenant(prisma, scope.tenantId, async (tx) => ({
      accepted: await tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.accepted },
      }),
      intakeCount: await tx.inventoryMovement.count({
        where: { kind: 'no-receipt-exchange-intake' },
      }),
      auditCount: await tx.auditEvent.count(),
    }));

    const result = await service.create(
      request({
        operationId,
        replacementQuantityScaled: '100000',
        cashMinor: '228850',
      }),
    );
    expect(result).toEqual({ outcome: 'failure', reason: 'insufficient-stock' });

    const after = await withTenant(prisma, scope.tenantId, async (tx) => ({
      accepted: await tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.accepted },
      }),
      intakeCount: await tx.inventoryMovement.count({
        where: { kind: 'no-receipt-exchange-intake' },
      }),
      cases: await tx.noReceiptExchangeCase.count({ where: { operationId } }),
      sales: await tx.sale.count({ where: { operationId: `${operationId}:replacement` } }),
      keys: await tx.idempotencyKey.count({
        where: { scope: 'no-receipt-exchange', operationId },
      }),
      auditCount: await tx.auditEvent.count(),
    }));

    expect(after.accepted?.quantityScaled).toBe(before.accepted?.quantityScaled);
    expect(after.accepted?.revision).toBe(before.accepted?.revision);
    expect(after.intakeCount).toBe(before.intakeCount);
    expect(after.cases).toBe(0);
    expect(after.sales).toBe(0);
    expect(after.keys).toBe(0);
    expect(after.auditCount).toBe(before.auditCount);
  });

  it('F. RLS and tenant-scoped product lookup do not enumerate another merchant', async () => {
    const operationId = newId();
    const result = await service.create(request({ operationId }));
    if (result.outcome !== 'success') throw new Error(result.reason);

    const repository = createNoReceiptExchangeRepository(prisma);
    expect(await repository.findByOperationId(otherScope, operationId)).toBeNull();

    const foreign = await service.create(
      request({
        operationId: newId(),
        acceptedProductId: B.product,
      }),
    );
    expect(foreign).toEqual({ outcome: 'failure', reason: 'unknown-product' });

    const visible = await withTenant(prisma, otherScope.tenantId, async (tx) =>
      tx.noReceiptExchangeCase.count(),
    );
    expect(visible).toBe(0);
  });

  it('G. finalized case and line snapshots cannot be updated or directly deleted', async () => {
    const result = await service.create(
      request({
        replacementProductId: A.accepted,
        cashMinor: null,
      }),
    );
    if (result.outcome !== 'success') throw new Error(result.reason);

    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.noReceiptExchangeCase.update({
          where: { id: result.case.id },
          data: { reason: 'manager-exception' },
        }),
      ),
    ).rejects.toThrow(/immutable/i);

    const lineId = result.case.lines[0]?.id;
    if (lineId === undefined) throw new Error('exchange line missing');
    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.noReceiptExchangeLine.update({
          where: { id: lineId },
          data: { nameAr: 'محاولة إعادة كتابة' },
        }),
      ),
    ).rejects.toThrow(/immutable/i);

    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.noReceiptExchangeCase.delete({ where: { id: result.case.id } }),
      ),
    ).rejects.toThrow(/immutable/i);

    await expect(
      withTenant(prisma, scope.tenantId, async (tx) =>
        tx.noReceiptExchangeLine.delete({ where: { id: lineId } }),
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('H. concurrent net-zero exchanges serialize stock and preserve every revision', async () => {
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.accepted },
      }),
    );
    if (before === null) throw new Error('accepted balance missing');

    const make = () =>
      request({
        operationId: newId(),
        acceptedProductId: A.accepted,
        replacementProductId: A.accepted,
        approvedAllowanceMinor: '1150',
        cashMinor: null,
      });

    const results = await Promise.all([service.create(make()), service.create(make())]);
    expect(results.every((result) => result.outcome === 'success')).toBe(true);
    const numbers = results
      .filter((result) => result.outcome === 'success')
      .map((result) => (result.outcome === 'success' ? result.case.caseNumber : ''));
    expect(new Set(numbers).size).toBe(2);

    const after = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.accepted },
      }),
    );
    expect(after?.quantityScaled).toBe(before.quantityScaled);
    expect(after?.revision).toBe(before.revision + 4n);
  });

  it('I. manager role provisioning carries the dedicated permission and cashier does not', async () => {
    const rows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.role.findMany({
        where: { key: { in: ['manager', 'cashier'] } },
        include: { permissions: true },
      }),
    );
    const manager = rows.find((row) => row.key === 'manager');
    const cashier = rows.find((row) => row.key === 'cashier');
    expect(
      manager?.permissions.some((row) => row.permissionKey === 'sale.exchange.no-receipt'),
    ).toBe(true);
    expect(
      cashier?.permissions.some((row) => row.permissionKey === 'sale.exchange.no-receipt'),
    ).toBe(false);
  });

  it(
    'J. PostgreSQL refuses an exchange allowance that is not backed by the linked case amount',
    async () => {
      const result = await service.create(
        request({
          operationId: newId(),
          approvedAllowanceMinor: '0',
          cashMinor: '2300',
        }),
      );
      if (result.outcome !== 'success') throw new Error(result.reason);

      await expect(
        withTenant(prisma, scope.tenantId, async (tx) => {
          await tx.tender.create({
            data: {
              id: newId(),
              tenantId: A.tenant,
              saleId: result.sale.saleId,
              kind: 'exchange_allowance',
              scheme: null,
              amountMinor: 100n,
              changeMinor: 0n,
              reference: null,
            },
          });
          await tx.$executeRawUnsafe(
            'SET CONSTRAINTS "tenders_exchange_allowance_case_link" IMMEDIATE',
          );
        }),
      ).rejects.toThrow(/matching finalized no-receipt exchange case/i);

      const allowances = await withTenant(prisma, scope.tenantId, async (tx) =>
        tx.tender.count({
          where: { saleId: result.sale.saleId, kind: 'exchange_allowance' },
        }),
      );
      expect(allowances).toBe(0);
    },
  );

});
