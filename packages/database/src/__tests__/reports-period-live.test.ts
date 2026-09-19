import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  createPrismaClient,
  provisionPermissionCatalogue,
  provisionTenant,
  withLoginSlug,
  withTenant,
} from '../index.js';
import { readMerchantPeriodReport } from '../reports/period-summary.js';
import type { PrismaClient } from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const SLUG = 'reports-period-live';
const FOREIGN_SLUG = 'reports-period-foreign-live';
const OPERATOR = 'ops:reports/live-proof';

const SALE_AT = new Date('2026-09-10T09:00:00.000Z');
const RETURN_AT = new Date('2026-09-11T09:00:00.000Z');

describe.skipIf(url === '')('merchant period reports, live', () => {
  let prisma: PrismaClient;
  let tenant: string;
  let branch: string;
  let product: string;
  let foreignTenant: string;
  let foreignBranch: string;

  async function purgeSlug(slug: string): Promise<void> {
    const id = await withLoginSlug(prisma, slug, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "tenants" WHERE "slug" = ${slug}`;
      return rows[0]?.id ?? null;
    });
    if (id === null) return;
    await withTenant(prisma, id, async (tx) => {
      await tx.tenant.deleteMany({ where: { id } });
    });
  }

  async function purge(): Promise<void> {
    await purgeSlug(SLUG);
    await purgeSlug(FOREIGN_SLUG);
  }

  async function seed(): Promise<void> {
    const provisioned = await provisionTenant(prisma, {
      operationId: `reports-provision-${newId()}`,
      slug: SLUG,
      name: 'متجر تقارير كورفي',
      vatNumber: '310000000000003',
      vertical: 'retail',
      controlPlaneActorRef: OPERATOR,
    });
    tenant = provisioned.id;

    branch = newId();
    const terminal = newId();
    const user = newId();
    const shift = newId();
    product = newId();
    const sale = newId();
    const saleLine = newId();
    const returned = newId();

    await withTenant(prisma, tenant, async (tx) => {
      await tx.branch.create({
        data: { id: branch, tenantId: tenant, code: 'JED', nameAr: 'فرع جدة' },
      });
      await tx.terminal.create({
        data: {
          id: terminal,
          tenantId: tenant,
          branchId: branch,
          code: 'POS-01',
          label: 'الصندوق 1',
        },
      });
      await tx.user.create({
        data: {
          id: user,
          tenantId: tenant,
          email: 'reports-live@korvi.test',
          displayName: 'مستخدم التقارير',
          passwordHash: 'test-only-credential',
        },
      });
      await tx.shift.create({
        data: {
          id: shift,
          tenantId: tenant,
          branchId: branch,
          terminalId: terminal,
          userId: user,
          openingFloatMinor: 0n,
          openedAt: new Date('2026-09-10T08:00:00.000Z'),
        },
      });
      await tx.product.create({
        data: {
          id: product,
          tenantId: tenant,
          sku: 'REPORT-001',
          nameAr: 'منتج التقرير',
          priceMinor: 11_500n,
          vatBasisPoints: 1500,
        },
      });
      await tx.sale.create({
        data: {
          id: sale,
          tenantId: tenant,
          branchId: branch,
          terminalId: terminal,
          shiftId: shift,
          userId: user,
          operationId: `sale-${newId()}`,
          sequence: 1,
          priceMode: 'tax-inclusive',
          currency: 'SAR',
          grossMinor: 11_500n,
          lineDiscountMinor: 0n,
          basketDiscountMinor: 0n,
          netMinor: 10_000n,
          vatMinor: 1_500n,
          totalMinor: 11_500n,
          tenderedMinor: 11_500n,
          changeMinor: 0n,
          issuedAt: SALE_AT,
        },
      });
      await tx.saleLine.create({
        data: {
          id: saleLine,
          tenantId: tenant,
          saleId: sale,
          productId: product,
          lineNumber: 1,
          sku: 'REPORT-001',
          nameAr: 'منتج التقرير',
          productType: 'unit',
          unitPriceMinor: 11_500n,
          vatBasisPoints: 1500,
          quantityScaled: 1000n,
          grossMinor: 11_500n,
          lineDiscountMinor: 0n,
          basketDiscountMinor: 0n,
          netMinor: 10_000n,
          vatMinor: 1_500n,
          totalMinor: 11_500n,
          costKnownQuantityScaled: 0n,
          costUnknownQuantityScaled: 1000n,
          costValueMinor: 0n,
          costProvenance: 'unknown',
        },
      });
      await tx.return.create({
        data: {
          id: returned,
          tenantId: tenant,
          saleId: sale,
          branchId: branch,
          terminalId: terminal,
          shiftId: shift,
          operationId: `return-${newId()}`,
          sequence: 1,
          returnNumber: 'RET-JED-1',
          currency: 'SAR',
          grossMinor: 2_300n,
          lineDiscountMinor: 0n,
          basketDiscountMinor: 0n,
          netMinor: 2_000n,
          vatMinor: 300n,
          totalMinor: 2_300n,
          actorUserId: user,
          issuedAt: RETURN_AT,
        },
      });
      await tx.returnLine.create({
        data: {
          id: newId(),
          tenantId: tenant,
          returnId: returned,
          saleLineId: saleLine,
          lineNumber: 1,
          productId: product,
          sku: 'REPORT-001',
          nameAr: 'منتج التقرير',
          productType: 'unit',
          vatBasisPoints: null,
          quantityScaled: 200n,
          grossMinor: 2_300n,
          lineDiscountMinor: 0n,
          basketDiscountMinor: 0n,
          netMinor: 2_000n,
          vatMinor: 300n,
          totalMinor: 2_300n,
          costKnownQuantityScaled: 0n,
          costUnknownQuantityScaled: 200n,
          costValueMinor: 0n,
          costProvenance: 'unknown',
        },
      });

      // Current catalogue truth is intentionally changed after issuance. The report
      // must remain anchored to the sale/return snapshots above.
      await tx.product.update({
        where: { id: product },
        data: { priceMinor: 10_500n, vatBasisPoints: 500 },
      });
    });
  }

  async function seedForeign(): Promise<void> {
    const provisioned = await provisionTenant(prisma, {
      operationId: `reports-provision-foreign-${newId()}`,
      slug: FOREIGN_SLUG,
      name: 'متجر تقارير أجنبي',
      vatNumber: '310000000000004',
      vertical: 'retail',
      controlPlaneActorRef: OPERATOR,
    });
    foreignTenant = provisioned.id;
    foreignBranch = newId();
    const terminal = newId();
    const user = newId();
    const shift = newId();
    const foreignProduct = newId();
    const sale = newId();
    const saleLine = newId();

    await withTenant(prisma, foreignTenant, async (tx) => {
      await tx.branch.create({
        data: { id: foreignBranch, tenantId: foreignTenant, code: 'RUH', nameAr: 'فرع الرياض' },
      });
      await tx.terminal.create({
        data: {
          id: terminal,
          tenantId: foreignTenant,
          branchId: foreignBranch,
          code: 'POS-F',
          label: 'صندوق أجنبي',
        },
      });
      await tx.user.create({
        data: {
          id: user,
          tenantId: foreignTenant,
          email: 'foreign-reports@korvi.test',
          displayName: 'مستخدم أجنبي',
          passwordHash: 'test-only-credential',
        },
      });
      await tx.shift.create({
        data: {
          id: shift,
          tenantId: foreignTenant,
          branchId: foreignBranch,
          terminalId: terminal,
          userId: user,
          openingFloatMinor: 0n,
          openedAt: new Date('2026-09-10T08:00:00.000Z'),
        },
      });
      await tx.product.create({
        data: {
          id: foreignProduct,
          tenantId: foreignTenant,
          sku: 'FOREIGN-REPORT-001',
          nameAr: 'منتج أجنبي',
          priceMinor: 105_000n,
          vatBasisPoints: 500,
        },
      });
      await tx.sale.create({
        data: {
          id: sale,
          tenantId: foreignTenant,
          branchId: foreignBranch,
          terminalId: terminal,
          shiftId: shift,
          userId: user,
          operationId: `foreign-sale-${newId()}`,
          sequence: 1,
          priceMode: 'tax-inclusive',
          currency: 'SAR',
          grossMinor: 105_000n,
          lineDiscountMinor: 0n,
          basketDiscountMinor: 0n,
          netMinor: 100_000n,
          vatMinor: 5_000n,
          totalMinor: 105_000n,
          tenderedMinor: 105_000n,
          changeMinor: 0n,
          issuedAt: SALE_AT,
        },
      });
      await tx.saleLine.create({
        data: {
          id: saleLine,
          tenantId: foreignTenant,
          saleId: sale,
          productId: foreignProduct,
          lineNumber: 1,
          sku: 'FOREIGN-REPORT-001',
          nameAr: 'منتج أجنبي',
          productType: 'unit',
          unitPriceMinor: 105_000n,
          vatBasisPoints: 500,
          quantityScaled: 1000n,
          grossMinor: 105_000n,
          lineDiscountMinor: 0n,
          basketDiscountMinor: 0n,
          netMinor: 100_000n,
          vatMinor: 5_000n,
          totalMinor: 105_000n,
          costKnownQuantityScaled: 0n,
          costUnknownQuantityScaled: 1000n,
          costValueMinor: 0n,
          costProvenance: 'unknown',
        },
      });
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await prisma.$connect();
    // Mirrors the API startup contract: the global application vocabulary is
    // installed before control-plane tenant provisioning can reference it.
    await provisionPermissionCatalogue(prisma);
  });

  beforeEach(async () => {
    await purge();
    await seed();
    await seedForeign();
  });

  afterAll(async () => {
    await purge();
    await prisma.$disconnect();
  });

  it('uses immutable sale and return snapshots, including the original rate for legacy returns', async () => {
    const report = await readMerchantPeriodReport(
      prisma,
      { tenantId: brandTenantId(tenant) },
      {
        fromInclusive: '2026-09-01T00:00:00+03:00',
        toExclusive: '2026-10-01T00:00:00+03:00',
      },
    );

    expect(report.currency).toBe('SAR');
    expect(report.sales).toEqual({
      documentCount: '1',
      netMinor: '10000',
      vatMinor: '1500',
      totalMinor: '11500',
    });
    expect(report.returns).toEqual({
      documentCount: '1',
      netMinor: '2000',
      vatMinor: '300',
      totalMinor: '2300',
    });
    expect(report.netAfterReturns).toEqual({
      netMinor: '8000',
      vatMinor: '1200',
      totalMinor: '9200',
    });
    expect(report.vatBreakdown).toEqual([
      {
        vatBasisPoints: 1500,
        salesNetMinor: '10000',
        salesVatMinor: '1500',
        returnsNetMinor: '2000',
        returnsVatMinor: '300',
        netTaxableMinor: '8000',
        netVatMinor: '1200',
      },
    ]);
    expect(report.branchBreakdown).toMatchObject([
      {
        id: branch,
        code: 'JED',
        sales: { totalMinor: '11500' },
        returns: { totalMinor: '2300' },
        netAfterReturns: { totalMinor: '9200' },
      },
    ]);
  });

  it('keeps same-period foreign tenant sales out of every aggregate and branch filter', async () => {
    const report = await readMerchantPeriodReport(
      prisma,
      { tenantId: brandTenantId(tenant) },
      {
        fromInclusive: '2026-09-01T00:00:00+03:00',
        toExclusive: '2026-10-01T00:00:00+03:00',
      },
    );

    expect(report.sales).toEqual({
      documentCount: '1',
      netMinor: '10000',
      vatMinor: '1500',
      totalMinor: '11500',
    });
    expect(report.vatBreakdown.map((bucket) => bucket.vatBasisPoints)).toEqual([1500]);
    expect(report.availableBranches.map((item) => item.id)).toEqual([branch]);
    expect(report.branchBreakdown.map((item) => item.id)).toEqual([branch]);

    const foreignReport = await readMerchantPeriodReport(
      prisma,
      { tenantId: brandTenantId(foreignTenant) },
      {
        fromInclusive: '2026-09-01T00:00:00+03:00',
        toExclusive: '2026-10-01T00:00:00+03:00',
      },
    );
    expect(foreignReport.sales).toMatchObject({
      documentCount: '1',
      netMinor: '100000',
      vatMinor: '5000',
      totalMinor: '105000',
    });

    await expect(
      readMerchantPeriodReport(
        prisma,
        { tenantId: brandTenantId(tenant) },
        {
          fromInclusive: '2026-09-01T00:00:00+03:00',
          toExclusive: '2026-10-01T00:00:00+03:00',
          branchId: foreignBranch,
        },
      ),
    ).rejects.toMatchObject({ detail: 'unknown-branch' });
  });

  it('rejects a branch that is not part of the authenticated tenant scope', async () => {
    await expect(
      readMerchantPeriodReport(
        prisma,
        { tenantId: brandTenantId(tenant) },
        {
          fromInclusive: '2026-09-01T00:00:00+03:00',
          toExclusive: '2026-10-01T00:00:00+03:00',
          branchId: newId(),
        },
      ),
    ).rejects.toMatchObject({ detail: 'unknown-branch' });
  });
});
