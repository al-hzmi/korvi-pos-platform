import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, tenantId as brandTenantId } from '@korvi/domain';
import { createPrismaClient } from '../client.js';
import {
  enableProductLotTracking,
  readProductLotConfig,
  recordInventoryLotReclassification,
} from '../administration/lots.js';
import {
  applyMovementWithin,
  createInventoryRepository,
} from '../repositories/inventory-repository.js';
import { withTenant } from '../tenant-context.js';
import {
  recordInventoryAdjustment,
  recordInventoryCount,
  recordInventoryTransfer,
} from '../inventory/stock-ledger.js';
import type { LotAdminRefusedError } from '../administration/lots.js';
import type { LotPolicyRefusedError, StockOperationRefusedError } from '../errors.js';
import type { PrismaClient } from '../client.js';
import type { InventoryMovementInput, TenantScope } from '@korvi/domain';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const A = {
  tenant: '018fd240-0000-7000-8000-00000000000a',
  branch: '018fd240-0000-7000-8000-0000000000b1',
  branch2: '018fd240-0000-7000-8000-0000000000b2',
  user: '018fd240-0000-7000-8000-0000000000c1',
  product: '018fd240-0000-7000-8000-0000000000d1',
  datedProduct: '018fd240-0000-7000-8000-0000000000d2',
  transferProduct: '018fd240-0000-7000-8000-0000000000d3',
  countProduct: '018fd240-0000-7000-8000-0000000000d4',
  adjustmentProduct: '018fd240-0000-7000-8000-0000000000d5',
} as const;

const B = {
  tenant: '018fd240-0000-7000-8000-00000000001a',
  product: '018fd240-0000-7000-8000-00000000001d',
} as const;

describe.skipIf(url === '')('Mastermind V2-4 lot authority, PostgreSQL live', () => {
  let prisma: PrismaClient;
  const scope: TenantScope = { tenantId: brandTenantId(A.tenant) };
  const otherScope: TenantScope = { tenantId: brandTenantId(B.tenant) };
  const actor = { userId: A.user };

  async function remove(): Promise<void> {
    for (const id of [A.tenant, B.tenant]) {
      await withTenant(prisma, brandTenantId(id), async (tx) => {
        await tx.tenant.deleteMany({ where: { id } });
      });
    }
  }

  function movement(
    productId: string,
    quantityScaled: string,
    occurredAt = '2026-09-29T00:00:00.000Z',
  ): InventoryMovementInput {
    return {
      id: newId(),
      branchId: A.branch,
      productId,
      kind: 'adjustment',
      quantityScaled,
      reason: 'v2-4-live-proof',
      sourceType: 'v2-4-live-proof',
      sourceId: newId(),
      actorUserId: A.user,
      occurredAt,
    };
  }

  async function createLot(input: {
    readonly productId: string;
    readonly provenance?: 'received' | 'manual-correction';
    readonly dateKind?: 'expiry' | 'best-before' | null;
    readonly dateValue?: string | null;
  }): Promise<string> {
    const id = newId();
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.inventoryLot.create({
        data: {
          id,
          tenantId: A.tenant,
          productId: input.productId,
          internalCode: `LIVE-${id.replaceAll('-', '').slice(-12).toUpperCase()}`,
          provenance: input.provenance ?? 'received',
          externalBatchReference: null,
          dateKind: input.dateKind ?? null,
          dateValue:
            input.dateValue === undefined || input.dateValue === null
              ? null
              : new Date(`${input.dateValue}T00:00:00.000Z`),
          status: 'active',
          revision: 1n,
          firstObservedAt: new Date('2026-09-29T00:00:00.000Z'),
          updatedAt: new Date('2026-09-29T00:00:00.000Z'),
        },
      });
    });
    return id;
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: A.tenant,
          name: 'V2-4 Live',
          slug: 'v2-four-live',
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
          businessTimeZone: 'Asia/Riyadh',
          allowNegativeStock: true,
          updatedAt: new Date(),
        },
      });
      await tx.branch.create({
        data: {
          id: A.branch,
          tenantId: A.tenant,
          code: 'V24',
          nameAr: 'فرع V2-4',
          updatedAt: new Date(),
        },
      });
      await tx.branch.create({
        data: {
          id: A.branch2,
          tenantId: A.tenant,
          code: 'V24-B',
          nameAr: 'فرع V2-4 الثاني',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: A.user,
          tenantId: A.tenant,
          email: 'lot-manager@v2-four-live.test',
          displayName: 'مدير الدفعات',
          updatedAt: new Date(),
        },
      });
      for (const [id, sku, quantity] of [
        [A.product, 'LOT-LIVE-1', 5_000n],
        [A.datedProduct, 'LOT-LIVE-DATE', 0n],
        [A.transferProduct, 'LOT-LIVE-TRANSFER', 4_000n],
        [A.countProduct, 'LOT-LIVE-COUNT', 4_000n],
        [A.adjustmentProduct, 'LOT-LIVE-ADJUST', 0n],
      ] as const) {
        await tx.product.create({
          data: {
            id,
            tenantId: A.tenant,
            sku,
            nameAr: sku,
            productType: 'unit',
            priceMinor: 1_000n,
            vatBasisPoints: 1500,
            trackInventory: true,
            updatedAt: new Date(),
          },
        });
        await tx.inventoryBalance.create({
          data: {
            tenantId: A.tenant,
            branchId: A.branch,
            productId: id,
            quantityScaled: quantity,
            revision: 0n,
            updatedAt: new Date(),
          },
        });
      }
      await tx.inventoryBalance.create({
        data: {
          tenantId: A.tenant,
          branchId: A.branch2,
          productId: A.transferProduct,
          quantityScaled: 0n,
          revision: 0n,
          updatedAt: new Date(),
        },
      });
    });

    await withTenant(prisma, otherScope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: B.tenant,
          name: 'Other V2-4 Tenant',
          slug: 'v2-four-other',
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({
        data: {
          tenantId: B.tenant,
          vertical: 'retail',
          priceMode: 'tax-inclusive',
          currency: 'SAR',
          updatedAt: new Date(),
        },
      });
      await tx.product.create({
        data: {
          id: B.product,
          tenantId: B.tenant,
          sku: 'OTHER-LOT',
          nameAr: 'صنف تاجر آخر',
          productType: 'unit',
          priceMinor: 1_000n,
          vatBasisPoints: 1500,
          trackInventory: true,
          updatedAt: new Date(),
        },
      });
    });
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  it('A. enables tracking without changing canonical stock and seeds explicit historical-unknown provenance', async () => {
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.product },
      }),
    );

    const config = await enableProductLotTracking(prisma, scope, actor, A.product, {
      selectionPolicy: 'fefo',
      dateRequirement: 'optional',
      occurredAt: '2026-09-29T00:00:00.000Z',
    });

    expect(config.trackingMode).toBe('required');
    expect(config.lots).toHaveLength(1);
    expect(config.lots[0]?.provenance).toBe('historical-unknown');
    expect(config.lots[0]?.externalBatchReference).toBeNull();
    expect(config.lots[0]?.dateValue).toBeNull();
    expect(config.lots[0]?.availabilityByBranch).toEqual([
      { branchId: A.branch, quantityScaled: '5000' },
    ]);

    const after = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.product },
      }),
    );
    expect(after?.quantityScaled).toBe(before?.quantityScaled);
    expect(after?.revision).toBe(before?.revision);

    const baseline = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryLotEntry.findMany({
        where: { productId: A.product, causeKind: 'tracking-baseline' },
      }),
    );
    expect(baseline).toHaveLength(1);
    expect(baseline[0]?.inventoryMovementId).toBeNull();
    expect(baseline[0]?.quantityScaled).toBe(5_000n);
  });

  it('B. automatically consumes the locked lot and commits allocation with the canonical movement', async () => {
    const inventory = createInventoryRepository(prisma);
    const stock = await inventory.applyMovement(scope, movement(A.product, '-2000'));
    expect(stock.quantityScaled).toBe('3000');

    const rows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryLotEntry.findMany({
        where: { inventoryMovementId: { not: null }, productId: A.product },
        orderBy: { occurredAt: 'asc' },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantityScaled).toBe(-2_000n);
  });

  it('C. refuses a positive lot-controlled movement that supplies no lot provenance', async () => {
    const inventory = createInventoryRepository(prisma);
    await expect(inventory.applyMovement(scope, movement(A.product, '1000'))).rejects.toMatchObject(
      {
        name: 'LotPolicyRefusedError',
        detail: 'incoming-lot-required',
      } satisfies Partial<LotPolicyRefusedError>,
    );
  });

  it('D. accepts explicit incoming provenance and returns immutable lot snapshots from the movement primitive', async () => {
    const lotId = await createLot({ productId: A.product });
    const incoming = movement(A.product, '1000');
    const applied = await withTenant(prisma, scope.tenantId, (tx) =>
      applyMovementWithin(tx, A.tenant, incoming, true, null, undefined, {
        kind: 'explicit',
        allocations: [{ lotId, quantityScaled: '1000' }],
      }),
    );

    expect(applied.quantityScaled).toBe(4_000n);
    expect(applied.lots).toEqual([
      expect.objectContaining({
        lotId,
        quantityScaled: 1_000n,
        provenance: 'received',
      }),
    ]);
  });

  it('E. records zero-net lot reclassification without changing Product stock or revision', async () => {
    const config = await readProductLotConfig(prisma, scope, A.product);
    if (config === null || config.lots.length < 2) throw new Error('lot setup missing');
    const baseline = config.lots.find((lot) => lot.provenance === 'historical-unknown');
    const received = config.lots.find((lot) => lot.provenance === 'received');
    if (baseline === undefined || received === undefined) throw new Error('lot identities missing');

    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.product },
      }),
    );
    if (before === null) throw new Error('balance missing');

    await recordInventoryLotReclassification(prisma, scope, actor, {
      operationId: 'v2-4-live-reclassification',
      requestHash: 'A'.repeat(43),
      productId: A.product,
      branchId: A.branch,
      expectedBalanceRevision: before.revision.toString(),
      reason: 'physical-lot-count-correction',
      lines: [
        { lotId: baseline.id, quantityScaled: '-500' },
        { lotId: received.id, quantityScaled: '500' },
      ],
      occurredAt: '2026-09-29T00:01:00.000Z',
    });

    const after = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.product },
      }),
    );
    expect(after?.quantityScaled).toBe(before.quantityScaled);
    expect(after?.revision).toBe(before.revision);
  });

  it('F. FORCE-RLS prevents another tenant from reading the Product lot configuration', async () => {
    expect(await readProductLotConfig(prisma, otherScope, A.product)).toBeNull();
  });

  it('G. refuses tracking activation over negative canonical stock', async () => {
    const productId = newId();
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.product.create({
        data: {
          id: productId,
          tenantId: A.tenant,
          sku: 'LOT-NEGATIVE',
          nameAr: 'رصيد سالب',
          productType: 'unit',
          priceMinor: 1_000n,
          vatBasisPoints: 1500,
          trackInventory: true,
          updatedAt: new Date(),
        },
      });
      await tx.inventoryBalance.create({
        data: {
          tenantId: A.tenant,
          branchId: A.branch,
          productId,
          quantityScaled: -1_000n,
          revision: 1n,
          updatedAt: new Date(),
        },
      });
    });

    await expect(
      enableProductLotTracking(prisma, scope, actor, productId, {
        selectionPolicy: 'fifo',
        dateRequirement: 'optional',
        occurredAt: '2026-09-29T00:02:00.000Z',
      }),
    ).rejects.toMatchObject({
      name: 'LotAdminRefusedError',
      detail: 'negative-stock',
    } satisfies Partial<LotAdminRefusedError>);
  });

  it('H. expiry intelligence uses the business date and consumption excludes expired stock', async () => {
    await enableProductLotTracking(prisma, scope, actor, A.datedProduct, {
      selectionPolicy: 'fefo',
      dateRequirement: 'required',
      occurredAt: '2026-09-29T00:00:00.000Z',
    });
    const expired = await createLot({
      productId: A.datedProduct,
      dateKind: 'expiry',
      dateValue: '2026-09-28',
    });
    const bestBefore = await createLot({
      productId: A.datedProduct,
      dateKind: 'best-before',
      dateValue: '2026-09-28',
    });
    const futureExpiry = await createLot({
      productId: A.datedProduct,
      dateKind: 'expiry',
      dateValue: '2026-10-05',
    });

    for (const lotId of [expired, bestBefore, futureExpiry]) {
      await withTenant(prisma, scope.tenantId, (tx) =>
        applyMovementWithin(tx, A.tenant, movement(A.datedProduct, '1000'), true, null, undefined, {
          kind: 'explicit',
          allocations: [{ lotId, quantityScaled: '1000' }],
        }),
      );
    }

    const observedAt = new Date('2026-09-29T12:00:00.000Z');
    const before = await readProductLotConfig(prisma, scope, A.datedProduct, observedAt);
    if (before === null) throw new Error('dated lot config missing');
    expect(before.expiryIntelligence).toEqual({
      observedAt: observedAt.toISOString(),
      businessDate: '2026-09-29',
      totalAvailableQuantityScaled: '3000',
      eligibleQuantityScaled: '2000',
      expiredQuantityScaled: '1000',
      pastBestBeforeQuantityScaled: '1000',
      unknownDateQuantityScaled: '0',
      blockedOrClosedQuantityScaled: '0',
      soonestEligibleExpiryDate: '2026-10-05',
    });
    expect(before.lots.find((lot) => lot.id === expired)).toMatchObject({
      dateState: 'expired',
      daysUntilDate: -1,
      totalAvailableQuantityScaled: '1000',
      eligibleForConsumptionQuantityScaled: '0',
    });
    expect(before.lots.find((lot) => lot.id === bestBefore)).toMatchObject({
      dateState: 'past-best-before',
      daysUntilDate: -1,
      eligibleForConsumptionQuantityScaled: '1000',
    });
    expect(before.lots.find((lot) => lot.id === futureExpiry)).toMatchObject({
      dateState: 'eligible',
      daysUntilDate: 6,
      eligibleForConsumptionQuantityScaled: '1000',
    });

    const inventory = createInventoryRepository(prisma);
    await inventory.applyMovement(
      scope,
      movement(A.datedProduct, '-2000', '2026-09-29T12:00:00.000Z'),
    );

    const after = await readProductLotConfig(
      prisma,
      scope,
      A.datedProduct,
      new Date('2026-09-29T12:01:00.000Z'),
    );
    const expiredRow = after?.lots.find((lot) => lot.id === expired);
    const bestBeforeRow = after?.lots.find((lot) => lot.id === bestBefore);
    const futureExpiryRow = after?.lots.find((lot) => lot.id === futureExpiry);
    expect(expiredRow?.availabilityByBranch[0]?.quantityScaled).toBe('1000');
    expect(bestBeforeRow?.availabilityByBranch[0]?.quantityScaled).toBe('0');
    expect(futureExpiryRow?.availabilityByBranch[0]?.quantityScaled).toBe('0');

    await expect(
      inventory.applyMovement(scope, movement(A.datedProduct, '-1', '2026-09-29T12:02:00.000Z')),
    ).rejects.toMatchObject({
      name: 'LotPolicyRefusedError',
      detail: 'lot-unavailable',
    } satisfies Partial<LotPolicyRefusedError>);
  });

  it('I. concurrent consumers serialize on lot identities and cannot oversell lot-controlled stock', async () => {
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.product },
      }),
    );
    if (before === null) throw new Error('balance missing');

    const first = movement(A.product, '-3000', '2026-09-29T00:03:00.000Z');
    const second = movement(A.product, '-3000', '2026-09-29T00:03:00.000Z');

    const results = await Promise.allSettled([
      withTenant(prisma, scope.tenantId, (tx) => applyMovementWithin(tx, A.tenant, first, true)),
      withTenant(prisma, scope.tenantId, (tx) => applyMovementWithin(tx, A.tenant, second, true)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const after = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.product },
      }),
    );
    expect(after?.quantityScaled).toBe(before.quantityScaled - 3_000n);
    expect(after?.quantityScaled).toBeGreaterThanOrEqual(0n);
  });

  it('J. transfers preserve exact lot identities across branches without a parallel stock truth', async () => {
    const config = await enableProductLotTracking(prisma, scope, actor, A.transferProduct, {
      selectionPolicy: 'fifo',
      dateRequirement: 'optional',
      occurredAt: '2026-09-29T00:04:00.000Z',
    });
    const sourceLot = config.lots[0];
    if (sourceLot === undefined) throw new Error('transfer baseline lot missing');

    const result = await recordInventoryTransfer(
      prisma,
      { tenantId: A.tenant, userId: A.user },
      {
        operationId: newId(),
        fromBranchId: A.branch,
        toBranchId: A.branch2,
        reason: 'v2-4-lot-transfer-proof',
        lines: [{ productId: A.transferProduct, quantityScaled: '1000' }],
      },
      'transfer-proof'.padEnd(43, 'T'),
      () => new Date('2026-09-29T00:05:00.000Z'),
    );
    expect(result.lines[0]?.sourceAfterQuantityScaled).toBe('3000');
    expect(result.lines[0]?.destinationAfterQuantityScaled).toBe('1000');

    const proof = await withTenant(prisma, scope.tenantId, async (tx) => {
      const balances = await tx.inventoryBalance.findMany({
        where: { productId: A.transferProduct },
        orderBy: { branchId: 'asc' },
      });
      const entries = await tx.inventoryLotEntry.findMany({
        where: { productId: A.transferProduct, lotId: sourceLot.id },
        orderBy: [{ branchId: 'asc' }, { occurredAt: 'asc' }],
      });
      return { balances, entries };
    });

    const sourceEntries = proof.entries.filter((entry) => entry.branchId === A.branch);
    const destinationEntries = proof.entries.filter((entry) => entry.branchId === A.branch2);
    expect(sourceEntries.reduce((sum, row) => sum + row.quantityScaled, 0n)).toBe(3_000n);
    expect(destinationEntries.reduce((sum, row) => sum + row.quantityScaled, 0n)).toBe(1_000n);
    expect(new Set(proof.entries.map((entry) => entry.lotId))).toEqual(new Set([sourceLot.id]));

    const balances = new Map(
      proof.balances.map((balance) => [balance.branchId, balance.quantityScaled] as const),
    );
    expect(balances.get(A.branch)).toBe(3_000n);
    expect(balances.get(A.branch2)).toBe(1_000n);
  });

  it('K. keeps lot count redistribution zero-net, then records only the true Product delta', async () => {
    const config = await enableProductLotTracking(prisma, scope, actor, A.countProduct, {
      selectionPolicy: 'fifo',
      dateRequirement: 'optional',
      occurredAt: '2026-09-29T00:06:00.000Z',
    });
    const baseline = config.lots[0];
    if (baseline === undefined) throw new Error('count baseline lot missing');
    const secondLot = await createLot({
      productId: A.countProduct,
      provenance: 'manual-correction',
    });

    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.countProduct },
      }),
    );
    if (before === null) throw new Error('count balance missing');

    const zeroNet = await recordInventoryCount(
      prisma,
      { tenantId: A.tenant, userId: A.user },
      {
        operationId: newId(),
        branchId: A.branch,
        reason: 'physical lot recount',
        lines: [
          {
            productId: A.countProduct,
            countedQuantityScaled: '4000',
            expectedRevision: before.revision.toString(),
            lots: [
              { lotId: baseline.id, countedQuantityScaled: '3000' },
              { lotId: secondLot, countedQuantityScaled: '1000' },
            ],
          },
        ],
      },
      'lot-count-zero'.padEnd(43, 'Z'),
      () => new Date('2026-09-29T00:07:00.000Z'),
    );
    expect(zeroNet.lines[0]?.deltaQuantityScaled).toBe('0');
    expect(zeroNet.lines[0]?.resultRevision).toBe(before.revision.toString());

    const afterZero = await withTenant(prisma, scope.tenantId, async (tx) => ({
      balance: await tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.countProduct },
      }),
      countMovements: await tx.inventoryMovement.count({
        where: {
          productId: A.countProduct,
          sourceType: 'inventory-count',
          sourceId: zeroNet.id,
        },
      }),
      reclassifications: await tx.inventoryLotReclassification.count({
        where: { productId: A.countProduct, branchId: A.branch },
      }),
      lots: await tx.inventoryLotEntry.groupBy({
        by: ['lotId'],
        where: { productId: A.countProduct, branchId: A.branch },
        _sum: { quantityScaled: true },
      }),
    }));
    expect(afterZero.balance?.quantityScaled).toBe(4_000n);
    expect(afterZero.balance?.revision).toBe(before.revision);
    expect(afterZero.countMovements).toBe(0);
    expect(afterZero.reclassifications).toBe(1);
    expect(
      new Map(afterZero.lots.map((row) => [row.lotId, row._sum.quantityScaled ?? 0n] as const)),
    ).toEqual(
      new Map([
        [baseline.id, 3_000n],
        [secondLot, 1_000n],
      ]),
    );

    const netPositive = await recordInventoryCount(
      prisma,
      { tenantId: A.tenant, userId: A.user },
      {
        operationId: newId(),
        branchId: A.branch,
        reason: 'found one extra unit in existing batch',
        lines: [
          {
            productId: A.countProduct,
            countedQuantityScaled: '5000',
            expectedRevision: before.revision.toString(),
            lots: [
              { lotId: baseline.id, countedQuantityScaled: '3000' },
              { lotId: secondLot, countedQuantityScaled: '2000' },
            ],
          },
        ],
      },
      'lot-count-plus'.padEnd(43, 'P'),
      () => new Date('2026-09-29T00:08:00.000Z'),
    );
    expect(netPositive.lines[0]?.deltaQuantityScaled).toBe('1000');
    expect(netPositive.lines[0]?.afterQuantityScaled).toBe('5000');

    const afterPositive = await withTenant(prisma, scope.tenantId, async (tx) => ({
      balance: await tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.countProduct },
      }),
      movement: await tx.inventoryMovement.findFirst({
        where: {
          productId: A.countProduct,
          sourceType: 'inventory-count',
          sourceId: netPositive.id,
        },
      }),
      lots: await tx.inventoryLotEntry.groupBy({
        by: ['lotId'],
        where: { productId: A.countProduct, branchId: A.branch },
        _sum: { quantityScaled: true },
      }),
    }));
    expect(afterPositive.balance?.quantityScaled).toBe(5_000n);
    expect(afterPositive.balance?.revision).toBe(before.revision + 1n);
    expect(afterPositive.movement?.quantityScaled).toBe(1_000n);
    expect(
      new Map(afterPositive.lots.map((row) => [row.lotId, row._sum.quantityScaled ?? 0n] as const)),
    ).toEqual(
      new Map([
        [baseline.id, 3_000n],
        [secondLot, 2_000n],
      ]),
    );
  });

  it('L. positive adjustments require provenance and create manual-correction lots explicitly', async () => {
    await enableProductLotTracking(prisma, scope, actor, A.adjustmentProduct, {
      selectionPolicy: 'fifo',
      dateRequirement: 'required',
      occurredAt: '2026-09-29T00:09:00.000Z',
    });

    await expect(
      recordInventoryAdjustment(
        prisma,
        { tenantId: A.tenant, userId: A.user },
        {
          operationId: newId(),
          branchId: A.branch,
          reason: 'found stock without system history',
          lines: [{ productId: A.adjustmentProduct, deltaQuantityScaled: '1000' }],
        },
        'lot-adjust-missing'.padEnd(43, 'M'),
        () => new Date('2026-09-29T00:10:00.000Z'),
      ),
    ).rejects.toMatchObject<Partial<StockOperationRefusedError>>({
      detail: 'lot-adjustment-required',
      productId: A.adjustmentProduct,
    });

    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryBalance.findFirst({
        where: { branchId: A.branch, productId: A.adjustmentProduct },
      }),
    );
    expect(before?.quantityScaled).toBe(0n);

    const operationId = newId();
    const result = await recordInventoryAdjustment(
      prisma,
      { tenantId: A.tenant, userId: A.user },
      {
        operationId,
        branchId: A.branch,
        reason: 'governed manual lot correction',
        lines: [
          {
            productId: A.adjustmentProduct,
            deltaQuantityScaled: '1000',
            lot: {
              kind: 'manual-correction',
              externalBatchReference: 'MANUAL-FOUND-001',
              dateKind: 'expiry',
              dateValue: '2026-11-30',
            },
          },
        ],
      },
      'lot-adjust-manual'.padEnd(43, 'A'),
      () => new Date('2026-09-29T00:11:00.000Z'),
    );
    expect(result.lines[0]?.afterQuantityScaled).toBe('1000');

    const facts = await withTenant(prisma, scope.tenantId, async (tx) => {
      const lot = await tx.inventoryLot.findFirst({
        where: {
          productId: A.adjustmentProduct,
          externalBatchReference: 'MANUAL-FOUND-001',
        },
      });
      const movements = await tx.inventoryMovement.findMany({
        where: {
          productId: A.adjustmentProduct,
          sourceType: 'inventory-adjustment',
          sourceId: result.id,
        },
      });
      return { lot, movements };
    });
    expect(facts.lot).toMatchObject({
      provenance: 'manual-correction',
      dateKind: 'expiry',
      status: 'active',
    });
    expect(facts.lot?.dateValue?.toISOString().slice(0, 10)).toBe('2026-11-30');
    expect(facts.movements).toHaveLength(1);

    const replay = await recordInventoryAdjustment(
      prisma,
      { tenantId: A.tenant, userId: A.user },
      {
        operationId,
        branchId: A.branch,
        reason: 'governed manual lot correction',
        lines: [
          {
            productId: A.adjustmentProduct,
            deltaQuantityScaled: '1000',
            lot: {
              kind: 'manual-correction',
              externalBatchReference: 'MANUAL-FOUND-001',
              dateKind: 'expiry',
              dateValue: '2026-11-30',
            },
          },
        ],
      },
      'lot-adjust-manual'.padEnd(43, 'A'),
      () => new Date('2026-09-29T00:12:00.000Z'),
    );
    expect(replay.id).toBe(result.id);
    expect(replay.replayed).toBe(true);
  });

  it('M. finalized lot distribution entries reject historical rewrites', async () => {
    const entry = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.inventoryLotEntry.findFirst({ where: { productId: A.product } }),
    );
    if (entry === null) throw new Error('lot entry missing');

    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.inventoryLotEntry.update({
          where: { id: entry.id },
          data: { quantityScaled: entry.quantityScaled + 1n },
        }),
      ),
    ).rejects.toThrow(/immutable/i);
  });
});
