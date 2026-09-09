import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { basisPoints, VAT_STANDARD_BP } from '../../tax/basis-points.js';
import { tenantId } from '../../ports/persistence.js';
import {
  buildZatcaSimplifiedInvoiceHash,
  renderZatcaSimplifiedInvoiceHashPayload,
  ZATCA_INITIAL_PREVIOUS_INVOICE_HASH,
  ZatcaInvoiceError,
} from '../phase2.js';
import type { InvoiceRecord, SaleRecord } from '../../ports/persistence.js';
import type { ZatcaSellerFiscalProfile, ZatcaSimplifiedInvoiceHashInput } from '../phase2.js';

const TENANT_ID = tenantId('018f2e20-7b7a-7c00-8000-000000000010');
const SALE_ID = '018f2e20-7b7a-7c00-8000-000000000001';
const INVOICE_ID = '018f2e20-7b7a-7c00-8000-000000000002';
const ISSUED_AT = '2026-09-09T14:05:06.789Z';

const seller: ZatcaSellerFiscalProfile = {
  registrationName: 'شركة كورفي للتجارة',
  vatRegistrationNumber: '310123456789013',
  legalId: '1010123456',
  legalIdScheme: 'CRN',
  streetName: 'طريق الملك فهد',
  buildingNumber: '1234',
  citySubdivisionName: 'العليا',
  cityName: 'الرياض',
  postalZone: '12345',
  countryCode: 'SA',
};

function sale(overrides: Partial<SaleRecord> = {}): SaleRecord {
  return {
    id: SALE_ID,
    tenantId: TENANT_ID,
    branchId: '018f2e20-7b7a-7c00-8000-000000000011',
    terminalId: '018f2e20-7b7a-7c00-8000-000000000012',
    shiftId: '018f2e20-7b7a-7c00-8000-000000000013',
    userId: '018f2e20-7b7a-7c00-8000-000000000014',
    customerId: null,
    operationId: '018f2e20-7b7a-7c00-8000-000000000015',
    status: 'finalized',
    sequence: 42,
    priceMode: 'tax-exclusive',
    currency: 'SAR',
    grossMinor: '10000',
    lineDiscountMinor: '0',
    basketDiscountMinor: '0',
    netMinor: '10000',
    vatMinor: '1500',
    totalMinor: '11500',
    tenderedMinor: '11500',
    changeMinor: '0',
    issuedAt: ISSUED_AT,
    lines: [
      {
        id: '018f2e20-7b7a-7c00-8000-000000000020',
        lineNumber: 1,
        productId: '018f2e20-7b7a-7c00-8000-000000000021',
        sku: 'KRV-001',
        nameAr: 'منتج كورفي',
        nameEn: 'Korvi Product',
        productType: 'unit',
        unitPriceMinor: '10000',
        vatBasisPoints: VAT_STANDARD_BP,
        quantityScaled: '1000',
        grossMinor: '10000',
        lineDiscountMinor: '0',
        basketDiscountMinor: '0',
        netMinor: '10000',
        vatMinor: '1500',
        totalMinor: '11500',
      },
    ],
    discounts: [],
    tenders: [],
    ...overrides,
  };
}

function invoice(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: INVOICE_ID,
    tenantId: TENANT_ID,
    saleId: SALE_ID,
    invoiceNumber: 'RUH-000042',
    invoiceType: 'simplified',
    sellerName: seller.registrationName,
    sellerVatNumber: seller.vatRegistrationNumber,
    buyerName: null,
    buyerVatNumber: null,
    netMinor: '10000',
    vatMinor: '1500',
    totalMinor: '11500',
    currency: 'SAR',
    issuedAt: ISSUED_AT,
    taxBreakdown: [{ vatBasisPoints: VAT_STANDARD_BP, netMinor: '10000', vatMinor: '1500' }],
    ...overrides,
  };
}

function input(
  overrides: Partial<ZatcaSimplifiedInvoiceHashInput> = {},
): ZatcaSimplifiedInvoiceHashInput {
  return {
    sale: sale(),
    invoice: invoice(),
    seller,
    invoiceCounterValue: '42',
    previousInvoiceHash: ZATCA_INITIAL_PREVIOUS_INVOICE_HASH,
    ...overrides,
  };
}

describe('ZATCA Phase 2 simplified invoice hash payload', () => {
  it('projects persisted sale truth into a deterministic unsigned UBL hash payload', () => {
    const first = renderZatcaSimplifiedInvoiceHashPayload(input());
    const second = renderZatcaSimplifiedInvoiceHashPayload(input());

    expect(first).toEqual(second);
    expect(first.issuedAt).toBe('2026-09-09T14:05:06Z');
    expect(first.canonicalXml).toContain('<cbc:ProfileID>reporting:1.0</cbc:ProfileID>');
    expect(first.canonicalXml).toContain(
      '<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>',
    );
    expect(first.canonicalXml).toContain('<cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>');
    expect(first.canonicalXml).toContain('<cbc:ID>ICV</cbc:ID><cbc:UUID>42</cbc:UUID>');
    expect(first.canonicalXml).toContain('<cbc:ID>PIH</cbc:ID>');
    expect(first.canonicalXml).toContain(
      '<cbc:TaxableAmount currencyID="SAR">100.00</cbc:TaxableAmount>',
    );
    expect(first.canonicalXml).toContain('<cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>');
    expect(first.canonicalXml).toContain(
      '<cbc:PayableAmount currencyID="SAR">115.00</cbc:PayableAmount>',
    );
    expect(first.canonicalXml).toContain(
      '<cbc:InvoicedQuantity unitCode="PCE">1.000</cbc:InvoicedQuantity>',
    );
    expect(first.canonicalXml).not.toContain('<?xml');
    expect(first.canonicalXml).not.toContain('<ext:UBLExtensions>');
    expect(first.canonicalXml).not.toContain('<cac:Signature>');
    expect(first.canonicalXml).not.toContain('<cbc:ID>QR</cbc:ID>');
  });

  it('hashes the exact UTF-8 payload bytes with SHA-256 and Base64', async () => {
    const result = await buildZatcaSimplifiedInvoiceHash(input());
    const independent = createHash('sha256').update(result.canonicalXml, 'utf8').digest('base64');

    expect(result.invoiceHash).toBe(independent);
    expect(result.invoiceHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('escapes Arabic merchant data and XML metacharacters canonically', () => {
    const specialSeller = {
      ...seller,
      registrationName: 'شركة كورفي & الشركاء <الرياض>',
      streetName: 'طريق A & B',
    } satisfies ZatcaSellerFiscalProfile;
    const specialInvoice = invoice({ sellerName: specialSeller.registrationName });
    const specialSale = sale({
      lines: [{ ...sale().lines[0]!, nameAr: 'قهوة & شاي <خاص>' }],
    });

    const { canonicalXml } = renderZatcaSimplifiedInvoiceHashPayload(
      input({ seller: specialSeller, invoice: specialInvoice, sale: specialSale }),
    );

    expect(canonicalXml).toContain('شركة كورفي &amp; الشركاء &lt;الرياض&gt;');
    expect(canonicalXml).toContain('طريق A &amp; B');
    expect(canonicalXml).toContain('قهوة &amp; شاي &lt;خاص&gt;');
  });

  it('represents a tax-inclusive discounted line without float arithmetic', () => {
    const discountedSale = sale({
      priceMode: 'tax-inclusive',
      grossMinor: '11500',
      lineDiscountMinor: '1150',
      netMinor: '9000',
      vatMinor: '1350',
      totalMinor: '10350',
      tenderedMinor: '10350',
      lines: [
        {
          ...sale().lines[0]!,
          unitPriceMinor: '11500',
          grossMinor: '11500',
          lineDiscountMinor: '1150',
          netMinor: '9000',
          vatMinor: '1350',
          totalMinor: '10350',
        },
      ],
    });
    const discountedInvoice = invoice({
      netMinor: '9000',
      vatMinor: '1350',
      totalMinor: '10350',
      taxBreakdown: [{ vatBasisPoints: VAT_STANDARD_BP, netMinor: '9000', vatMinor: '1350' }],
    });

    const { canonicalXml } = renderZatcaSimplifiedInvoiceHashPayload(
      input({ sale: discountedSale, invoice: discountedInvoice }),
    );

    expect(canonicalXml).toContain('<cbc:Amount currencyID="SAR">10.00</cbc:Amount>');
    expect(canonicalXml).toContain('<cbc:PriceAmount currencyID="SAR">100.00</cbc:PriceAmount>');
    expect(canonicalXml).toContain(
      '<cbc:LineExtensionAmount currencyID="SAR">90.00</cbc:LineExtensionAmount>',
    );
    expect(canonicalXml).toContain(
      '<cbc:PayableAmount currencyID="SAR">103.50</cbc:PayableAmount>',
    );
  });

  it('emits mandatory KSA line VAT and VAT-inclusive totals from historical line truth', () => {
    const standard = renderZatcaSimplifiedInvoiceHashPayload(input()).canonicalXml;
    expect(standard).toContain(
      '<cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount><cac:TaxTotal><cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount><cbc:RoundingAmount currencyID="SAR">115.00</cbc:RoundingAmount></cac:TaxTotal>',
    );

    const discountedSale = sale({
      priceMode: 'tax-inclusive',
      grossMinor: '11500',
      lineDiscountMinor: '1150',
      netMinor: '9000',
      vatMinor: '1350',
      totalMinor: '10350',
      tenderedMinor: '10350',
      lines: [
        {
          ...sale().lines[0]!,
          unitPriceMinor: '11500',
          grossMinor: '11500',
          lineDiscountMinor: '1150',
          netMinor: '9000',
          vatMinor: '1350',
          totalMinor: '10350',
        },
      ],
    });
    const discountedInvoice = invoice({
      netMinor: '9000',
      vatMinor: '1350',
      totalMinor: '10350',
      taxBreakdown: [{ vatBasisPoints: VAT_STANDARD_BP, netMinor: '9000', vatMinor: '1350' }],
    });
    const discounted = renderZatcaSimplifiedInvoiceHashPayload(
      input({ sale: discountedSale, invoice: discountedInvoice }),
    ).canonicalXml;
    expect(discounted).toContain(
      '<cbc:LineExtensionAmount currencyID="SAR">90.00</cbc:LineExtensionAmount><cac:AllowanceCharge>',
    );
    expect(discounted).toContain(
      '</cac:AllowanceCharge><cac:TaxTotal><cbc:TaxAmount currencyID="SAR">13.50</cbc:TaxAmount><cbc:RoundingAmount currencyID="SAR">103.50</cbc:RoundingAmount></cac:TaxTotal><cac:Item>',
    );
  });

  it('uses KGM for immutable weighted-item snapshots', () => {
    const weightedSale = sale({
      lines: [{ ...sale().lines[0]!, productType: 'weighted', quantityScaled: '1000' }],
    });
    const { canonicalXml } = renderZatcaSimplifiedInvoiceHashPayload(input({ sale: weightedSale }));
    expect(canonicalXml).toContain(
      '<cbc:InvoicedQuantity unitCode="KGM">1.000</cbc:InvoicedQuantity>',
    );
  });

  it('refuses to infer zero-rated, exempt or out-of-scope classification from a zero rate', () => {
    const zeroSale = sale({
      netMinor: '10000',
      vatMinor: '0',
      totalMinor: '10000',
      tenderedMinor: '10000',
      lines: [
        {
          ...sale().lines[0]!,
          vatBasisPoints: basisPoints(0),
          netMinor: '10000',
          vatMinor: '0',
          totalMinor: '10000',
        },
      ],
    });
    const zeroInvoice = invoice({
      netMinor: '10000',
      vatMinor: '0',
      totalMinor: '10000',
      taxBreakdown: [{ vatBasisPoints: basisPoints(0), netMinor: '10000', vatMinor: '0' }],
    });

    expect(() =>
      renderZatcaSimplifiedInvoiceHashPayload(input({ sale: zeroSale, invoice: zeroInvoice })),
    ).toThrow(/tax category cannot be inferred/i);
  });

  it('refuses a historical line with no immutable product type', () => {
    const unknownType = sale({ lines: [{ ...sale().lines[0]!, productType: null }] });
    expect(() => renderZatcaSimplifiedInvoiceHashPayload(input({ sale: unknownType }))).toThrow(
      /no immutable product type/i,
    );
  });

  it('refuses any divergence between sale, invoice and line arithmetic', () => {
    expect(() =>
      renderZatcaSimplifiedInvoiceHashPayload(input({ invoice: invoice({ totalMinor: '11499' }) })),
    ).toThrow(/invoice snapshot diverges/i);

    const brokenLine = sale({ lines: [{ ...sale().lines[0]!, vatMinor: '1499' }] });
    expect(() => renderZatcaSimplifiedInvoiceHashPayload(input({ sale: brokenLine }))).toThrow(
      ZatcaInvoiceError,
    );
  });

  it('refuses mismatched seller fiscal identity, malformed ICV and malformed PIH', () => {
    expect(() =>
      renderZatcaSimplifiedInvoiceHashPayload(
        input({ seller: { ...seller, vatRegistrationNumber: '310123456789023' } }),
      ),
    ).toThrow(/seller VAT number diverges/i);
    expect(() =>
      renderZatcaSimplifiedInvoiceHashPayload(input({ invoiceCounterValue: '42.0' })),
    ).toThrow(/digits only/i);
    expect(() =>
      renderZatcaSimplifiedInvoiceHashPayload(input({ previousInvoiceHash: 'not-base64' })),
    ).toThrow(/Base64/i);
  });

  it('refuses impossible calendar dates instead of allowing Date normalization', () => {
    const impossible = '2026-02-31T14:05:06Z';
    expect(() =>
      renderZatcaSimplifiedInvoiceHashPayload(
        input({ sale: sale({ issuedAt: impossible }), invoice: invoice({ issuedAt: impossible }) }),
      ),
    ).toThrow(/real UTC date\/time/i);
  });

  it('refuses XML control characters before serialization', () => {
    const invalidSeller = { ...seller, registrationName: `Korvi\u0001` };
    expect(() =>
      renderZatcaSimplifiedInvoiceHashPayload(
        input({
          seller: invalidSeller,
          invoice: invoice({ sellerName: invalidSeller.registrationName }),
        }),
      ),
    ).toThrow(/XML 1\.0 cannot represent/i);
  });
});
