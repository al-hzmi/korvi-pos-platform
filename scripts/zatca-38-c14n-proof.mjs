import { writeFileSync } from 'node:fs';
import {
  VAT_STANDARD_BP,
  ZATCA_INITIAL_PREVIOUS_INVOICE_HASH,
  buildZatcaSimplifiedInvoiceHash,
  tenantId,
} from '../packages/domain/dist/index.js';

const xmlPath = process.argv[2];
const hashPath = process.argv[3];
if (xmlPath === undefined || hashPath === undefined) {
  throw new Error('Usage: node scripts/zatca-38-c14n-proof.mjs <xml-path> <hash-path>');
}

const tenant = tenantId('018f2e20-7b7a-7c00-8000-000000000010');
const issuedAt = '2026-09-09T14:05:06Z';
const seller = {
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

const sale = {
  id: '018f2e20-7b7a-7c00-8000-000000000001',
  tenantId: tenant,
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
  issuedAt,
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
};

const invoice = {
  id: '018f2e20-7b7a-7c00-8000-000000000002',
  tenantId: tenant,
  saleId: sale.id,
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
  issuedAt,
  taxBreakdown: [{ vatBasisPoints: VAT_STANDARD_BP, netMinor: '10000', vatMinor: '1500' }],
};

const result = await buildZatcaSimplifiedInvoiceHash({
  sale,
  invoice,
  seller,
  invoiceCounterValue: '42',
  previousInvoiceHash: ZATCA_INITIAL_PREVIOUS_INVOICE_HASH,
});

writeFileSync(xmlPath, result.canonicalXml, { encoding: 'utf8', mode: 0o600 });
writeFileSync(hashPath, result.invoiceHash, { encoding: 'utf8', mode: 0o600 });
console.log(`[zatca38] canonical-bytes=${Buffer.byteLength(result.canonicalXml, 'utf8')}`);
console.log(`[zatca38] invoice-hash=${result.invoiceHash}`);
