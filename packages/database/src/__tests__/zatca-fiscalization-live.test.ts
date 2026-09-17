import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ZATCA_INITIAL_PREVIOUS_INVOICE_HASH,
  tenantId,
  type TenantScope,
  type ZatcaSellerFiscalProfile,
} from '@korvi/domain';
import { createPrismaClient } from '../client.js';
import { withTenant } from '../tenant-context.js';
import { createZatcaFiscalizationRepository } from '../zatca/fiscalization-repository.js';
import type { PrismaClient } from '../client.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const VAT = '300000000000003';
const RESERVED_1 = '2026-09-17T12:00:01Z';
const SEALED_1 = '2026-09-17T12:00:02Z';
const RESERVED_2 = '2026-09-17T12:00:03Z';
const SEALED_2 = '2026-09-17T12:00:04Z';

const seller: ZatcaSellerFiscalProfile = {
  registrationName: 'Korvi Fiscal Merchant',
  vatRegistrationNumber: VAT,
  legalId: '1010123456',
  legalIdScheme: 'CRN',
  streetName: 'King Road',
  buildingNumber: '1234',
  citySubdivisionName: 'Olaya',
  cityName: 'Riyadh',
  postalZone: '12345',
  countryCode: 'SA',
};

describe.skipIf(url === '')('ZATCA fiscalization PostgreSQL live', () => {
  let prisma: PrismaClient;
  let tenant: string;
  let branch: string;
  let terminalA: string;
  let terminalB: string;
  let user: string;
  let shiftA: string;
  let shiftB: string;
  let scope: TenantScope;
  let fiscalization: ReturnType<typeof createZatcaFiscalizationRepository>;
  let sequence = 0;

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    tenant = randomUUID();
    branch = randomUUID();
    terminalA = randomUUID();
    terminalB = randomUUID();
    user = randomUUID();
    shiftA = randomUUID();
    shiftB = randomUUID();
    scope = { tenantId: tenantId(tenant) };
    fiscalization = createZatcaFiscalizationRepository(prisma);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenant,
          name: 'ZATCA fiscal chain tenant',
          slug: `zatca-fiscal-${tenant}`,
          vatNumber: VAT,
          status: 'active',
          activatedAt: new Date('2026-09-17T11:59:00Z'),
          updatedAt: new Date('2026-09-17T11:59:00Z'),
        },
      });
      await tx.branch.create({
        data: {
          id: branch,
          tenantId: tenant,
          code: 'ZF',
          nameAr: 'فرع الفوترة',
          updatedAt: new Date('2026-09-17T11:59:00Z'),
        },
      });
      await tx.user.create({
        data: {
          id: user,
          tenantId: tenant,
          email: `fiscal-${tenant}@korvi.test`,
          displayName: 'Fiscal Tester',
          updatedAt: new Date('2026-09-17T11:59:00Z'),
        },
      });
      for (const [id, code] of [
        [terminalA, 'ZF-A'],
        [terminalB, 'ZF-B'],
      ] as const) {
        await tx.terminal.create({
          data: {
            id,
            tenantId: tenant,
            branchId: branch,
            code,
            label: code,
            updatedAt: new Date('2026-09-17T11:59:00Z'),
          },
        });
      }
      for (const [id, terminalId] of [
        [shiftA, terminalA],
        [shiftB, terminalB],
      ] as const) {
        await tx.shift.create({
          data: {
            id,
            tenantId: tenant,
            branchId: branch,
            terminalId,
            userId: user,
            openingFloatMinor: 0n,
            openedAt: new Date('2026-09-17T11:59:00Z'),
            updatedAt: new Date('2026-09-17T11:59:00Z'),
          },
        });
      }
    });

    await fiscalization.upsertSellerProfile(scope, seller, '2026-09-17T12:00:00Z');
  }, 30_000);

  afterAll(async () => {
    if (prisma !== undefined && scope !== undefined) {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        await tx.tenant.deleteMany({ where: { id: tenant } });
      });
      await prisma.$disconnect();
    }
  });

  async function createInvoice(terminalId: string, shiftId: string): Promise<string> {
    sequence += 1;
    const saleId = randomUUID();
    const invoiceId = randomUUID();
    const issuedAt = new Date(`2026-09-17T12:${String(sequence).padStart(2, '0')}:00Z`);

    await withTenant(prisma, scope.tenantId, async (tx) => {
      await tx.sale.create({
        data: {
          id: saleId,
          tenantId: tenant,
          branchId: branch,
          terminalId,
          shiftId,
          userId: user,
          operationId: randomUUID(),
          status: 'finalized',
          sequence,
          priceMode: 'tax-inclusive',
          currency: 'SAR',
          grossMinor: 115n,
          lineDiscountMinor: 0n,
          basketDiscountMinor: 0n,
          netMinor: 100n,
          vatMinor: 15n,
          totalMinor: 115n,
          tenderedMinor: 115n,
          changeMinor: 0n,
          issuedAt,
        },
      });
      await tx.invoice.create({
        data: {
          id: invoiceId,
          tenantId: tenant,
          saleId,
          invoiceNumber: `ZF-${sequence}`,
          invoiceType: 'simplified',
          sellerName: seller.registrationName,
          sellerVatNumber: seller.vatRegistrationNumber,
          netMinor: 100n,
          vatMinor: 15n,
          totalMinor: 115n,
          currency: 'SAR',
          issuedAt,
        },
      });
    });

    return invoiceId;
  }

  it('serializes ICV/PIH and seals exactly once', async () => {
    const invoice1 = await createInvoice(terminalA, shiftA);
    const invoice2 = await createInvoice(terminalA, shiftA);

    const first = await fiscalization.reserve(scope, {
      invoiceId: invoice1,
      terminalId: terminalA,
      reservedAt: RESERVED_1,
    });
    expect(first.state).toBe('reserved');
    expect(first.invoiceCounterValue).toBe('1');
    expect(first.previousInvoiceHash).toBe(ZATCA_INITIAL_PREVIOUS_INVOICE_HASH);
    expect(first.seller).toEqual(seller);

    expect(
      await fiscalization.reserve(scope, {
        invoiceId: invoice1,
        terminalId: terminalA,
        reservedAt: RESERVED_1,
      }),
    ).toEqual(first);

    await expect(
      fiscalization.reserve(scope, {
        invoiceId: invoice2,
        terminalId: terminalA,
        reservedAt: RESERVED_2,
      }),
    ).rejects.toThrow(/waiting for invoice/);

    const hash1 = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const seal1 = {
      invoiceId: invoice1,
      terminalId: terminalA,
      invoiceHash: hash1,
      sealedInvoiceXml: new TextEncoder().encode('<Invoice>sealed-one</Invoice>'),
      qrCodeBase64: 'cXIx',
      signatureValueBase64: 'c2lnMQ==',
      sealedAt: SEALED_1,
    };
    const sealed1 = await fiscalization.seal(scope, seal1);
    expect(sealed1.state).toBe('sealed');
    expect(await fiscalization.seal(scope, seal1)).toEqual(sealed1);

    await expect(
      fiscalization.seal(scope, {
        ...seal1,
        invoiceHash: new Uint8Array(32).fill(9),
      }),
    ).rejects.toThrow(/different evidence/);

    const second = await fiscalization.reserve(scope, {
      invoiceId: invoice2,
      terminalId: terminalA,
      reservedAt: RESERVED_2,
    });
    expect(second.state).toBe('reserved');
    expect(second.invoiceCounterValue).toBe('2');
    expect(second.previousInvoiceHash).toBe(Buffer.from(hash1).toString('base64'));

    const hash2 = new Uint8Array(32).fill(7);
    await fiscalization.seal(scope, {
      invoiceId: invoice2,
      terminalId: terminalA,
      invoiceHash: hash2,
      sealedInvoiceXml: new TextEncoder().encode('<Invoice>sealed-two</Invoice>'),
      qrCodeBase64: 'cXIy',
      signatureValueBase64: 'c2lnMg==',
      sealedAt: SEALED_2,
    });

    const chain = await withTenant(
      prisma,
      scope.tenantId,
      async (tx) =>
        tx.$queryRaw<Array<{ nextIcv: bigint; previousInvoiceHash: string }>>`
        SELECT "nextIcv", "previousInvoiceHash"
          FROM "zatca_terminal_fiscal_chains"
         WHERE "tenantId" = ${tenant}::uuid AND "terminalId" = ${terminalA}::uuid`,
    );
    expect(chain).toEqual([
      {
        nextIcv: 3n,
        previousInvoiceHash: Buffer.from(hash2).toString('base64'),
      },
    ]);
  });

  it('converges concurrent reservation replays', async () => {
    const invoice = await createInvoice(terminalB, shiftB);
    const input = {
      invoiceId: invoice,
      terminalId: terminalB,
      reservedAt: '2026-09-17T12:10:01Z',
    };

    const [left, right] = await Promise.all([
      fiscalization.reserve(scope, input),
      fiscalization.reserve(scope, input),
    ]);
    expect(left).toEqual(right);
    expect(left.invoiceCounterValue).toBe('1');

    const count = await withTenant(
      prisma,
      scope.tenantId,
      async (tx) =>
        tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
          FROM "zatca_invoice_fiscalizations"
         WHERE "tenantId" = ${tenant}::uuid AND "invoiceId" = ${invoice}::uuid`,
    );
    expect(count[0]?.count).toBe(1n);
  });

  it('keeps fiscal artifacts tenant scoped', async () => {
    const foreignScope: TenantScope = { tenantId: tenantId(randomUUID()) };
    const own = await withTenant(
      prisma,
      scope.tenantId,
      async (tx) =>
        tx.$queryRaw<Array<{ invoiceId: string }>>`
        SELECT "invoiceId" FROM "zatca_invoice_fiscalizations"
         WHERE "tenantId" = ${tenant}::uuid ORDER BY "invoiceCounterValue"`,
    );
    expect(own.length).toBeGreaterThan(0);
    expect(
      await fiscalization.findByInvoice(foreignScope, own[0]?.invoiceId ?? randomUUID()),
    ).toBeNull();
    expect(await fiscalization.readSellerProfile(foreignScope)).toBeNull();
  });
});
