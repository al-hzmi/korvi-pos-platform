import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { basisPoints, newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  assignRole,
  createAuditRepository,
  createIdempotencyRepository,
  createInventoryRepository,
  createPrismaClient,
  createProductRepository,
  createSaleRepository,
  createShiftRepository,
  createTenantRepository,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  withTenant,
} from '@korvi/database';
import { createCheckoutService } from '../checkout/service.js';
import type { CheckoutService } from '../checkout/service.js';
import type { PrismaClient } from '@korvi/database';
import type {
  AuthenticatedPrincipal,
  RecordSaleInput,
  SaleRepository,
  TenantScope,
} from '@korvi/domain';

/**
 * Settlement, priced and persisted by a real server.
 *
 * The questions here are the ones a fake cannot answer: whether a split tender
 * survives the round trip with its scheme and its change attribution intact,
 * whether a discounted sale reconciles against the CHECK constraints the
 * database itself enforces, and whether a failure part-way through leaves
 * anything behind.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with
 * every migration applied, connected as the application role — not a
 * superuser, which bypasses RLS.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const S = {
  tenant: '018f5000-0000-7000-8000-00000000000a',
  slug: 'settle-live-a',
  branch: '018f5000-0000-7000-8000-0000000000b1',
  terminal: '018f5000-0000-7000-8000-0000000000c1',
  shift: '018f5000-0000-7000-8000-0000000000d1',
  user: '018f5000-0000-7000-8000-0000000000e1',
  membership: '018f5000-0000-7000-8000-0000000000e2',
  milk: '018f5000-0000-7000-8000-0000000000f1',
  odd: '018f5000-0000-7000-8000-0000000000f2',
} as const;

describe.skipIf(url === '')('settlement, live', () => {
  let prisma: PrismaClient;
  let service: CheckoutService;
  let sales: SaleRepository;
  let principal: AuthenticatedPrincipal;

  const scope: TenantScope = { tenantId: brandTenantId(S.tenant) };

  async function remove(): Promise<void> {
    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: S.tenant } });
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await remove();
    await provisionPermissionCatalogue(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: S.tenant,
          name: 'متجر كورفي',
          slug: S.slug,
          vatNumber: '300000000000003',
          updatedAt: new Date(),
        },
      });
      await tx.tenantSettings.create({ data: { tenantId: S.tenant, updatedAt: new Date() } });
      await tx.branch.create({
        data: {
          id: S.branch,
          tenantId: S.tenant,
          code: '05',
          nameAr: 'الفرع',
          updatedAt: new Date(),
        },
      });
      await tx.user.create({
        data: {
          id: S.user,
          tenantId: S.tenant,
          email: 'noura@settle-live-a.test',
          displayName: 'نورة',
          updatedAt: new Date(),
        },
      });
      await tx.tenantMembership.create({
        data: { id: S.membership, tenantId: S.tenant, userId: S.user, updatedAt: new Date() },
      });
      await tx.terminal.create({
        data: {
          id: S.terminal,
          tenantId: S.tenant,
          branchId: S.branch,
          code: '01',
          label: 'صندوق ١',
          updatedAt: new Date(),
        },
      });
      await tx.shift.create({
        data: {
          id: S.shift,
          tenantId: S.tenant,
          branchId: S.branch,
          terminalId: S.terminal,
          userId: S.user,
          openingFloatMinor: 20_000n,
          openedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      for (const [id, sku, price] of [
        [S.milk, 'MILK-1L', 1_150n],
        // A price that divides badly, on purpose.
        [S.odd, 'ODD-1', 333n],
      ] as const) {
        await tx.product.create({
          data: {
            id,
            tenantId: S.tenant,
            sku,
            nameAr: 'صنف',
            priceMinor: price,
            vatBasisPoints: 1500,
            updatedAt: new Date(),
          },
        });
        await tx.inventoryBalance.create({
          data: {
            tenantId: S.tenant,
            branchId: S.branch,
            productId: id,
            quantityScaled: 1_000_000n,
            updatedAt: new Date(),
          },
        });
      }
    });

    await provisionTenantRbac(prisma, scope);
    await assignRole(prisma, scope, S.user, 'manager');

    sales = createSaleRepository(prisma);
    service = createCheckoutService({
      tenants: createTenantRepository(prisma),
      products: createProductRepository(prisma),
      inventory: createInventoryRepository(prisma),
      shifts: createShiftRepository(prisma),
      sales,
      idempotency: createIdempotencyRepository(prisma),
      audit: createAuditRepository(prisma),
    });

    principal = {
      tenantId: S.tenant,
      tenantSlug: S.slug,
      userId: S.user,
      sessionId: newId(),
      email: 'noura@settle-live-a.test',
      displayName: 'نورة',
      roles: ['manager'],
      permissions: ['sale.create', 'sale.discount', 'product.read'],
      // The ceiling a manager carries. Read from the roles, never the request.
      maxDiscountBasisPoints: 2_000n,
      branchId: S.branch,
    };
  }, 90_000);

  afterAll(async () => {
    await remove();
    await prisma.$disconnect();
  });

  it('persists a split tender with its scheme, its reference and its change', async () => {
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-LIVE-1', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const rows = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.tender.findMany({ where: { saleId: result.sale.saleId }, orderBy: { kind: 'asc' } }),
    );

    expect(rows).toHaveLength(2);
    const cash = rows.find((row) => row.kind === 'cash');
    const card = rows.find((row) => row.kind === 'electronic');

    expect(card?.scheme).toBe('mada');
    expect(card?.reference).toBe('AUTH-LIVE-1');
    expect(card?.amountMinor).toBe(1_000n);
    // A card terminal cannot hand money back, and the row says so.
    expect(card?.changeMinor).toBe(0n);

    expect(cash?.scheme).toBeNull();
    expect(cash?.amountMinor).toBe(2_000n);
    expect(cash?.changeMinor).toBe(700n);

    // 23.00 due, 30.00 given, 7.00 back: 13.00 of cash stays in the drawer.
    expect(result.sale.totalMinor).toBe('2300');
    expect(result.sale.changeMinor).toBe('700');
    const retained = (cash?.amountMinor ?? 0n) - (cash?.changeMinor ?? 0n);
    expect(retained).toBe(1_300n);
  }, 30_000);

  it('reads a split tender back with its scheme intact', async () => {
    // A replay has to return what was recorded, not a cash-shaped guess.
    const operationId = newId();
    const request = {
      principal,
      operationId,
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '1000' }],
      tenders: [
        {
          kind: 'electronic' as const,
          scheme: 'visa' as const,
          reference: 'AUTH-LIVE-2',
          amountMinor: '1150',
        },
      ],
    };
    const first = await service.checkout(request);
    const second = await service.checkout(request);
    if (first.outcome !== 'success' || second.outcome !== 'success')
      throw new Error('expected success');

    expect(second.replayed).toBe(true);
    const recorded = await sales.findByOperationId(scope, operationId);
    expect(recorded?.tenders[0]).toMatchObject({
      kind: 'electronic',
      scheme: 'visa',
      reference: 'AUTH-LIVE-2',
      changeMinor: '0',
    });
  }, 30_000);

  it('reconciles a discounted basket that does not divide evenly', async () => {
    // Three lines at 3.33, 10% off the basket. The discount is 1 halala short
    // of dividing by three, and the database's own CHECK constraints refuse a
    // sale whose parts do not sum to its total.
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.odd, quantityScaled: '3000' }],
      basketDiscount: { mode: 'basis-points', value: 1_000, reason: 'عرض' },
      tenders: [{ kind: 'cash', amountMinor: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const rows = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sale: await tx.sale.findFirstOrThrow({
        where: { id: result.sale.saleId },
        include: { lines: true, discounts: true, invoice: { include: { taxBreakdown: true } } },
      }),
    }));

    const sale = rows.sale;
    const lineNet = sale.lines.reduce((total, line) => total + line.netMinor, 0n);
    const lineVat = sale.lines.reduce((total, line) => total + line.vatMinor, 0n);
    const basketShares = sale.lines.reduce((total, line) => total + line.basketDiscountMinor, 0n);

    expect(lineNet).toBe(sale.netMinor);
    expect(lineVat).toBe(sale.vatMinor);
    expect(sale.netMinor + sale.vatMinor).toBe(sale.totalMinor);
    expect(basketShares).toBe(sale.basketDiscountMinor);
    expect(sale.tenderedMinor - sale.changeMinor).toBe(sale.totalMinor);

    // 9.99 less 10% is 8.99 (999 - 100 rounded once), and the discount row
    // records what was asked for and what was actually granted.
    expect(sale.discounts).toHaveLength(1);
    expect(sale.discounts[0]?.scope).toBe('basket');
    expect(sale.discounts[0]?.kind).toBe('percentage');
    expect(sale.discounts[0]?.inputValue).toBe(1_000n);
    expect(sale.discounts[0]?.amountMinor).toBe(sale.basketDiscountMinor);
    expect(sale.discounts[0]?.grantedByUserId).toBe(S.user);
    expect(sale.discounts[0]?.createdAt).toBeInstanceOf(Date);

    // The tax breakdown still adds up to the invoice.
    const buckets = sale.invoice?.taxBreakdown ?? [];
    expect(buckets.reduce((total, bucket) => total + bucket.vatMinor, 0n)).toBe(sale.vatMinor);
  }, 30_000);

  it('refuses a discount past the ceiling before anything is written', async () => {
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { tenantId: S.tenant } }),
    );
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      basketDiscount: { mode: 'basis-points', value: 2_001 },
      tenders: [{ kind: 'cash', amountMinor: '2000' }],
    });

    expect(result.outcome === 'failure' && result.reason).toBe('discount-not-authorized');
    const after = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.sale.count({ where: { tenantId: S.tenant } }),
    );
    expect(after).toBe(before);
  }, 30_000);

  it('leaves nothing behind when a discounted split-tender sale dies mid-transaction', async () => {
    /*
     * The failure lands after the receipt number has been taken, after the
     * operation id has been reserved, and after the sale row itself exists —
     * a sale line pointing at a product that does not exist fails the foreign
     * key in PostgreSQL. Everything must go back, including the tender rows
     * and the discount rows this strike added.
     */
    const ghost = '018f5000-0000-7000-8000-0000000000ff';
    const saleId = newId();
    const operationId = newId();
    const issuedAt = new Date().toISOString();

    const doomed: RecordSaleInput = {
      sale: {
        id: saleId,
        branchId: S.branch,
        terminalId: S.terminal,
        shiftId: S.shift,
        userId: S.user,
        customerId: null,
        operationId,
        status: 'finalized',
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        grossMinor: '1150',
        lineDiscountMinor: '0',
        basketDiscountMinor: '150',
        netMinor: '870',
        vatMinor: '130',
        totalMinor: '1000',
        tenderedMinor: '1000',
        changeMinor: '0',
        issuedAt,
        lines: [
          {
            id: newId(),
            lineNumber: 1,
            productId: ghost,
            sku: 'GHOST-1',
            nameAr: 'صنف',
            nameEn: null,
            productType: 'unit',
            unitPriceMinor: '1150',
            vatBasisPoints: basisPoints(1500),
            quantityScaled: '1000',
            grossMinor: '1150',
            lineDiscountMinor: '0',
            basketDiscountMinor: '150',
            netMinor: '870',
            vatMinor: '130',
            totalMinor: '1000',
          },
        ],
        discounts: [
          {
            id: newId(),
            scope: 'basket',
            lineNumber: null,
            kind: 'fixed',
            inputValue: '150',
            amountMinor: '150',
            reason: 'test',
            grantedByUserId: S.user,
          },
        ],
        tenders: [
          {
            id: newId(),
            kind: 'electronic',
            scheme: 'mada',
            amountMinor: '1000',
            changeMinor: '0',
            reference: 'AUTH-DOOMED',
          },
        ],
      },
      invoice: {
        id: newId(),
        saleId,
        invoiceType: 'simplified',
        sellerName: 'متجر كورفي',
        sellerVatNumber: '300000000000003',
        buyerName: null,
        buyerVatNumber: null,
        netMinor: '870',
        vatMinor: '130',
        totalMinor: '1000',
        currency: 'SAR',
        issuedAt,
        taxBreakdown: [{ vatBasisPoints: basisPoints(1500), netMinor: '870', vatMinor: '130' }],
      },
      inventory: [],
      cashMovement: {
        id: newId(),
        shiftId: S.shift,
        kind: 'sale',
        amountMinor: '1000',
        reason: null,
        actorUserId: S.user,
        occurredAt: issuedAt,
      },
      idempotency: {
        id: newId(),
        scope: 'checkout',
        operationId,
        requestHash: null,
      },
    };

    await expect(sales.record(scope, doomed)).rejects.toThrow();

    const survivors = await withTenant(prisma, scope.tenantId, async (tx) => ({
      sales: await tx.sale.count({ where: { id: saleId } }),
      lines: await tx.saleLine.count({ where: { saleId } }),
      tenders: await tx.tender.count({ where: { saleId } }),
      discounts: await tx.saleDiscount.count({ where: { saleId } }),
      invoices: await tx.invoice.count({ where: { saleId } }),
      keys: await tx.idempotencyKey.count({ where: { operationId } }),
    }));
    expect(survivors).toEqual({
      sales: 0,
      lines: 0,
      tenders: 0,
      discounts: 0,
      invoices: 0,
      keys: 0,
    });
  }, 30_000);

  it('lets the database refuse a settlement the application should never write', async () => {
    // The constraints are the last line, not the first. Each of these is
    // written directly, past every application guard.
    const badRows: readonly [string, string][] = [
      [
        'an electronic tender with no scheme',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","amountMinor","changeMinor","reference")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'electronic', 100, 0, 'AUTH-X')`,
      ],
      [
        'a cash tender wearing an approval reference',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","amountMinor","changeMinor","reference")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'cash', 100, 0, 'AUTH-Z')`,
      ],
      [
        'a cash tender wearing a scheme',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","scheme","amountMinor","changeMinor")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'cash', 'visa', 100, 0)`,
      ],
      [
        'an electronic tender giving change',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","scheme","amountMinor","changeMinor","reference")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'electronic', 'mada', 100, 10, 'AUTH-Y')`,
      ],
      [
        'a tender of nothing',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","amountMinor","changeMinor")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'cash', 0, 0)`,
      ],
      [
        'change larger than the cash it came from',
        `INSERT INTO "tenders" ("id","tenantId","saleId","kind","amountMinor","changeMinor")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'cash', 100, 101)`,
      ],
      [
        'a rate discount above 100 per cent',
        `INSERT INTO "sale_discounts" ("id","tenantId","saleId","scope","kind","inputValue","amountMinor")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'basket', 'percentage', 10001, 1)`,
      ],
      [
        'a line discount naming no line',
        `INSERT INTO "sale_discounts" ("id","tenantId","saleId","scope","kind","inputValue","amountMinor")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'line', 'fixed', 1, 1)`,
      ],
    ];

    const anchor = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '1000' }],
      tenders: [{ kind: 'cash', amountMinor: '1150' }],
    });
    if (anchor.outcome !== 'success') throw new Error(anchor.reason);

    for (const [description, sql] of badRows) {
      await expect(
        withTenant(prisma, scope.tenantId, (tx) =>
          tx.$executeRawUnsafe(sql, S.tenant, anchor.sale.saleId),
        ),
        description,
      ).rejects.toThrow();
    }
  }, 60_000);

  it('moves the drawer by the cash that stayed in it', async () => {
    // 23.00 sale, 10.00 on a card, 20.00 cash, 7.00 back. The drawer gained
    // 13.00 — not 23.00, which is what recording the total would have said and
    // what would have left every shift short by the card portion.
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-DRAWER-1', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const movements = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.findMany({
        where: { tenantId: S.tenant, shiftId: S.shift, kind: 'sale' },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      }),
    );
    expect(movements[0]?.amountMinor).toBe(1_300n);
  }, 30_000);

  it('records no drawer movement for a sale settled entirely on a card', async () => {
    const before = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { tenantId: S.tenant, kind: 'sale' } }),
    );
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      tenders: [
        { kind: 'electronic', scheme: 'visa', reference: 'AUTH-DRAWER-2', amountMinor: '2300' },
      ],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const after = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.count({ where: { tenantId: S.tenant, kind: 'sale' } }),
    );
    // Nothing was taken in cash, so nothing moved. A zero row would be a
    // movement that did not happen.
    expect(after).toBe(before);
  }, 30_000);

  it('leaves the cash-only drawer effect exactly as it was', async () => {
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      cashReceivedMinor: '5000',
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    const movements = await withTenant(prisma, scope.tenantId, async (tx) =>
      tx.cashMovement.findMany({
        where: { tenantId: S.tenant, shiftId: S.shift, kind: 'sale' },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      }),
    );
    // 50.00 given, 27.00 back, 23.00 retained — the total, as it always was.
    expect(movements[0]?.amountMinor).toBe(2_300n);
    expect(result.sale.tenderedMinor).toBe('5000');
    expect(result.sale.cashReceivedMinor).toBe('5000');
  }, 30_000);

  it('tells the tendered total apart from the cash in the drawer', async () => {
    const result = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-SUMMARY-1', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    expect(result.sale.tenderedMinor).toBe('3000');
    expect(result.sale.cashReceivedMinor).toBe('2000');
    expect(result.sale.changeMinor).toBe('700');

    // And a replay says the same, from the persisted rows.
    const replay = await service.checkout({
      principal,
      operationId: result.sale.operationId,
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '2000' }],
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-SUMMARY-1', amountMinor: '1000' },
        { kind: 'cash', amountMinor: '2000' },
      ],
    });
    if (replay.outcome !== 'success') throw new Error(replay.reason);
    expect(replay.replayed).toBe(true);
    expect(replay.sale.tenderedMinor).toBe('3000');
    expect(replay.sale.cashReceivedMinor).toBe('2000');
    expect(
      replay.sale.tenders.map((tender) => [tender.kind, tender.scheme, tender.amountMinor]).sort(),
    ).toEqual([
      ['cash', null, '2000'],
      ['electronic', 'mada', '1000'],
    ]);
  }, 30_000);

  it('lets the database refuse a second cash tender and a repeated approval', async () => {
    // Defence in depth. The domain refuses both first, so an ordinary checkout
    // never meets these; what they stop is everything that is not one.
    const anchor = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '1000' }],
      tenders: [
        { kind: 'electronic', scheme: 'mada', reference: 'AUTH-DUP-1', amountMinor: '575' },
        { kind: 'cash', amountMinor: '575' },
      ],
    });
    if (anchor.outcome !== 'success') throw new Error(anchor.reason);

    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "tenders" ("id","tenantId","saleId","kind","amountMinor","changeMinor")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'cash', 100, 0)`,
          S.tenant,
          anchor.sale.saleId,
        ),
      ),
    ).rejects.toThrow(/tenders_one_cash_per_sale/);

    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "tenders" ("id","tenantId","saleId","kind","scheme","reference","amountMinor","changeMinor")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'electronic', 'mada', 'AUTH-DUP-1', 100, 0)`,
          S.tenant,
          anchor.sale.saleId,
        ),
      ),
    ).rejects.toThrow(/tenders_one_approval_per_sale/);

    // A different approval on the same scheme is ordinary and stays legal.
    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "tenders" ("id","tenantId","saleId","kind","scheme","reference","amountMinor","changeMinor")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'electronic', 'mada', 'AUTH-DUP-2', 100, 0)`,
          S.tenant,
          anchor.sale.saleId,
        ),
      ),
    ).resolves.toBeDefined();
  }, 30_000);

  it('refuses a discount attributed to a user in another tenant', async () => {
    // Composite tenant-consistent foreign key (ADR-0004): RLS is not the only
    // thing standing between two merchants' audit trails.
    const anchor = await service.checkout({
      principal,
      operationId: newId(),
      terminalId: S.terminal,
      lines: [{ productId: S.milk, quantityScaled: '1000' }],
      tenders: [{ kind: 'cash', amountMinor: '1150' }],
    });
    if (anchor.outcome !== 'success') throw new Error(anchor.reason);

    await expect(
      withTenant(prisma, scope.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "sale_discounts"
             ("id","tenantId","saleId","scope","kind","inputValue","amountMinor","grantedByUserId")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'basket', 'fixed', 1, 1, $3::uuid)`,
          S.tenant,
          anchor.sale.saleId,
          '018f5000-0000-7000-8000-00000000dead',
        ),
      ),
    ).rejects.toThrow(/sale_discounts_tenantId_grantedByUserId_fkey/);
  }, 30_000);
});

describe.skipIf(url !== '')('settlement, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    expect(url).toBe('');
  });
});
