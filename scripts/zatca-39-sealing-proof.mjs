import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  VAT_STANDARD_BP,
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  tenantId,
} from '../packages/domain/dist/index.js';
import { Libxml2ZatcaCanonicalizer } from '../apps/api/dist/zatca/libxml2-canonicalizer.js';
import { createZatcaSimplifiedInvoiceSealer } from '../apps/api/dist/zatca/seal-simplified-invoice.js';

const [outputDirectory, privateKeyPath, leafDerPath, intermediateDerPath, rootDerPath] =
  process.argv.slice(2);
if (
  outputDirectory === undefined ||
  privateKeyPath === undefined ||
  leafDerPath === undefined ||
  intermediateDerPath === undefined ||
  rootDerPath === undefined
) {
  throw new Error(
    'Usage: node scripts/zatca-39-sealing-proof.mjs <output-dir> <leaf-key.pem> <leaf.der> <intermediate.der> <root.der>',
  );
}

const output = resolve(outputDirectory);
mkdirSync(output, { recursive: true, mode: 0o700 });

const leafDer = Uint8Array.from(readFileSync(leafDerPath));
const intermediateDer = Uint8Array.from(readFileSync(intermediateDerPath));
const rootDer = Uint8Array.from(readFileSync(rootDerPath));
const leaf = new X509Certificate(leafDer);
const intermediate = new X509Certificate(intermediateDer);
const root = new X509Certificate(rootDer);
const certificatePath = [leaf, intermediate, root];
const certificatePathDer = [leafDer, intermediateDer, rootDer];
const notBefore = certificatePath.map((certificate) => certificateTime(certificate.validFrom));
const notAfter = certificatePath.map((certificate) => certificateTime(certificate.validTo));
const stampingMilliseconds = Math.max(...notBefore) + 60_000;
if (stampingMilliseconds >= Math.min(...notAfter)) {
  throw new Error('Ephemeral proof certificate path is not valid at a shared signing instant.');
}
const stampingTime = utcSecond(stampingMilliseconds);
const issuedAt = utcSecond(stampingMilliseconds - 1_000);
const checkedAt = utcSecond(stampingMilliseconds - 1_000);
const validUntil = utcSecond(stampingMilliseconds + 60 * 60 * 1000);

const scope = { tenantId: tenantId('zatca-proof-tenant') };
const terminalId = '018f2e20-7b7a-7c00-8000-000000000012';
const signingPublicKeySpkiDer = Uint8Array.from(
  leaf.publicKey.export({ type: 'spki', format: 'der' }),
);
const key = {
  provider: 'proof-openssl-hsm-boundary',
  keyId: 'ephemeral-secp256k1-leaf',
  curve: ZATCA_SIGNING_CURVE,
  algorithm: ZATCA_SIGNING_ALGORITHM,
  exportable: false,
};

const signingKey = {
  async generateNonExportableKey() {
    throw new Error('Proof adapter only signs with the already-created ephemeral key.');
  },
  async describePublicKey() {
    return {
      handle: key,
      publicKeySpkiDer: Uint8Array.from(signingPublicKeySpkiDer),
      createdAt: checkedAt,
    };
  },
  async createPkcs10Csr() {
    throw new Error('Proof adapter does not provision CSIDs.');
  },
  async signSha256(input) {
    const der = execFileSync('openssl', ['dgst', '-sha256', '-sign', privateKeyPath], {
      input: Buffer.from(input.message),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return Uint8Array.from(der);
  },
};

const csid = {
  credentialId: 'proof-csid',
  scope,
  terminalId,
  state: 'active',
  key,
  certificatePath: certificatePathDer.map((certificateDer, index) => ({
    certificateDer: Uint8Array.from(certificateDer),
    issuerName: certificatePath[index].issuer,
    serialNumber: decimalSerial(certificatePath[index]),
  })),
  certificateStatus: [leafDer, intermediateDer].map((certificateDer) => ({
    certificateSha256: sha256Base64(certificateDer),
    status: 'good',
    source: 'crl',
    checkedAt,
    validUntil,
  })),
  signingPublicKeySpkiDer: Uint8Array.from(signingPublicKeySpkiDer),
  notBefore: utcSecond(notBefore[0]),
  notAfter: utcSecond(notAfter[0]),
  fatooraSecret: { provider: 'proof-vault', secretId: 'opaque-proof-handle' },
};

const invoice = buildInvoiceInput(scope.tenantId, terminalId, issuedAt);
const rootSha256Hex = sha256Hex(rootDer);
const canonicalizer = new Libxml2ZatcaCanonicalizer();
const sealer = createZatcaSimplifiedInvoiceSealer({
  canonicalizer,
  signingKey,
  trustedAnchorSha256Hex: [rootSha256Hex],
});

const result = await sealer.seal({
  scope,
  terminalId,
  stampingTime,
  csid,
  invoice,
});

const signedInfoCanonical = await canonicalizer.canonicalizeSignedInfo(result.xml);
const signedPropertiesCanonical = await canonicalizer.canonicalizeSignedProperties(result.xml);
const invoiceReferenceCanonical = await canonicalizer.canonicalizeInvoiceReference(result.xml);
const signatureDer = Uint8Array.from(Buffer.from(result.signatureValueBase64, 'base64'));

writePrivate('sealed-invoice.xml', result.xml);
writePrivate('production-signed-info.c14n.xml', signedInfoCanonical);
writePrivate('production-signed-properties.c14n.xml', signedPropertiesCanonical);
writePrivate('production-invoice-reference.c14n.xml', invoiceReferenceCanonical);
writePrivate('signature.der', signatureDer);
writePrivate('signing-public-key.spki.der', result.signingPublicKeySpkiDer);
writePrivate('technical-ca-signature.der', result.technicalCaSignatureDer);
writePrivate('invoice-hash.raw', result.invoiceHash);
writePrivate('signature-value.txt', `${result.signatureValueBase64}\n`);
writePrivate('qr-code.txt', `${result.qrCodeBase64}\n`);
writePrivate(
  'signing-public-key.pem',
  leaf.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
);

const proof = [
  `stamping_time=${stampingTime}`,
  `invoice_sha256=${sha256Hex(new TextEncoder().encode(result.xml))}`,
  `invoice_reference_sha256=${sha256Hex(invoiceReferenceCanonical)}`,
  `signed_properties_sha256=${sha256Hex(signedPropertiesCanonical)}`,
  `signed_info_sha256=${sha256Hex(signedInfoCanonical)}`,
  `signature_der_bytes=${String(signatureDer.length)}`,
  `root_sha256=${rootSha256Hex}`,
  `qr_base64_characters=${String(result.qrCodeBase64.length)}`,
  'production_sealer_self_verification=PASS',
].join('\n');
writePrivate('generator-proof.txt', `${proof}\n`);
console.log(proof);

function buildInvoiceInput(tenant, terminal, timestamp) {
  const sale = {
    id: '018f2e20-7b7a-7c00-8000-000000000001',
    tenantId: tenant,
    branchId: '018f2e20-7b7a-7c00-8000-000000000011',
    terminalId: terminal,
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
    issuedAt: timestamp,
    lines: [
      {
        id: '018f2e20-7b7a-7c00-8000-000000000020',
        lineNumber: 1,
        productId: '018f2e20-7b7a-7c00-8000-000000000021',
        sku: 'KRV-PROOF-001',
        nameAr: 'منتج إثبات كورفي',
        nameEn: 'Korvi Proof Product',
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
  const invoiceRecord = {
    id: '018f2e20-7b7a-7c00-8000-000000000002',
    tenantId: tenant,
    saleId: sale.id,
    invoiceNumber: 'PROOF-000042',
    invoiceType: 'simplified',
    sellerName: 'شركة كورفي للاختبار',
    sellerVatNumber: '310123456789013',
    buyerName: null,
    buyerVatNumber: null,
    netMinor: '10000',
    vatMinor: '1500',
    totalMinor: '11500',
    currency: 'SAR',
    issuedAt: timestamp,
    taxBreakdown: [{ vatBasisPoints: VAT_STANDARD_BP, netMinor: '10000', vatMinor: '1500' }],
  };
  return {
    sale,
    invoice: invoiceRecord,
    seller: {
      registrationName: invoiceRecord.sellerName,
      vatRegistrationNumber: invoiceRecord.sellerVatNumber,
      legalId: '1010123456',
      legalIdScheme: 'CRN',
      streetName: 'طريق الملك فهد',
      buildingNumber: '1234',
      citySubdivisionName: 'العليا',
      cityName: 'الرياض',
      postalZone: '12345',
      countryCode: 'SA',
    },
    invoiceCounterValue: '42',
    previousInvoiceHash:
      'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
  };
}

function certificateTime(value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid X.509 time: ${value}`);
  }
  return milliseconds;
}

function utcSecond(milliseconds) {
  return new Date(Math.floor(milliseconds / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function decimalSerial(certificate) {
  return BigInt(`0x${certificate.serialNumber}`).toString(10);
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64(value) {
  return createHash('sha256').update(value).digest('base64');
}

function writePrivate(name, value) {
  writeFileSync(resolve(output, name), value, { mode: 0o600 });
}
