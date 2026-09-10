import { execFileSync } from 'node:child_process';
import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createSign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  VAT_STANDARD_BP,
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  bytesToBase64,
  ecdsaDerToXmlDsigSignature,
  tenantId,
  xmlDsigEcdsaSignatureToDer,
  type InvoiceRecord,
  type SaleRecord,
  type ZatcaCertificateStatusEvidence,
  type ZatcaCsidBinding,
  type ZatcaSigningKeyHandle,
  type ZatcaSigningKeyPort,
  type ZatcaSimplifiedInvoiceHashInput,
} from '@korvi/domain';
import { Libxml2ZatcaCanonicalizer } from '../zatca/libxml2-canonicalizer.js';
import { createZatcaSimplifiedInvoiceSealer } from '../zatca/seal-simplified-invoice.js';

interface EphemeralTestPki {
  readonly leafDer: Uint8Array;
  readonly intermediateDer: Uint8Array;
  readonly rootDer: Uint8Array;
  readonly leafPrivateKey: KeyObject;
  readonly leafCertificate: X509Certificate;
  readonly intermediateCertificate: X509Certificate;
  readonly rootCertificate: X509Certificate;
  readonly rootSha256Hex: string;
  readonly spkiDer: Uint8Array;
}

function runOpenSsl(cwd: string, args: readonly string[]): void {
  execFileSync('openssl', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
}

function generateEphemeralTestPki(): EphemeralTestPki {
  const directory = mkdtempSync(join(tmpdir(), 'korvi-zatca-sealer-'));
  try {
    writeFileSync(
      join(directory, 'intermediate.ext'),
      [
        'basicConstraints=critical,CA:TRUE,pathlen:0',
        'keyUsage=critical,keyCertSign,cRLSign',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid,issuer',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    writeFileSync(
      join(directory, 'leaf.ext'),
      [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid,issuer',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    runOpenSsl(directory, [
      'genpkey',
      '-algorithm',
      'EC',
      '-pkeyopt',
      'ec_paramgen_curve:secp256k1',
      '-out',
      'root.key.pem',
    ]);
    runOpenSsl(directory, [
      'req',
      '-new',
      '-x509',
      '-key',
      'root.key.pem',
      '-sha256',
      '-days',
      '3650',
      '-subj',
      '/CN=Korvi Sealer Root/O=Korvi Test/C=SA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-out',
      'root.cert.pem',
    ]);

    runOpenSsl(directory, [
      'genpkey',
      '-algorithm',
      'EC',
      '-pkeyopt',
      'ec_paramgen_curve:secp256k1',
      '-out',
      'intermediate.key.pem',
    ]);
    runOpenSsl(directory, [
      'req',
      '-new',
      '-key',
      'intermediate.key.pem',
      '-subj',
      '/CN=Korvi Sealer Intermediate/O=Korvi Test/C=SA',
      '-out',
      'intermediate.csr.pem',
    ]);
    runOpenSsl(directory, [
      'x509',
      '-req',
      '-in',
      'intermediate.csr.pem',
      '-CA',
      'root.cert.pem',
      '-CAkey',
      'root.key.pem',
      '-CAcreateserial',
      '-sha256',
      '-days',
      '2000',
      '-extfile',
      'intermediate.ext',
      '-out',
      'intermediate.cert.pem',
    ]);

    runOpenSsl(directory, [
      'genpkey',
      '-algorithm',
      'EC',
      '-pkeyopt',
      'ec_paramgen_curve:secp256k1',
      '-out',
      'leaf.key.pem',
    ]);
    runOpenSsl(directory, [
      'req',
      '-new',
      '-key',
      'leaf.key.pem',
      '-subj',
      '/CN=Korvi Sealer EGS/O=Korvi Test/C=SA',
      '-out',
      'leaf.csr.pem',
    ]);
    runOpenSsl(directory, [
      'x509',
      '-req',
      '-in',
      'leaf.csr.pem',
      '-CA',
      'intermediate.cert.pem',
      '-CAkey',
      'intermediate.key.pem',
      '-CAcreateserial',
      '-sha256',
      '-days',
      '1000',
      '-extfile',
      'leaf.ext',
      '-out',
      'leaf.cert.pem',
    ]);

    for (const name of ['root', 'intermediate', 'leaf']) {
      runOpenSsl(directory, [
        'x509',
        '-in',
        `${name}.cert.pem`,
        '-outform',
        'DER',
        '-out',
        `${name}.cert.der`,
      ]);
    }

    const leafDer = Uint8Array.from(readFileSync(join(directory, 'leaf.cert.der')));
    const intermediateDer = Uint8Array.from(readFileSync(join(directory, 'intermediate.cert.der')));
    const rootDer = Uint8Array.from(readFileSync(join(directory, 'root.cert.der')));
    const leafPrivateKey = createPrivateKey(readFileSync(join(directory, 'leaf.key.pem')));
    const leafCertificate = new X509Certificate(leafDer);
    const intermediateCertificate = new X509Certificate(intermediateDer);
    const rootCertificate = new X509Certificate(rootDer);

    return {
      leafDer,
      intermediateDer,
      rootDer,
      leafPrivateKey,
      leafCertificate,
      intermediateCertificate,
      rootCertificate,
      rootSha256Hex: createHash('sha256').update(rootDer).digest('hex'),
      spkiDer: Uint8Array.from(leafCertificate.publicKey.export({ type: 'spki', format: 'der' })),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function utcSecond(milliseconds: number): string {
  return new Date(Math.floor(milliseconds / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function certificateInstant(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new Error('OpenSSL produced an invalid certificate time.');
  return milliseconds;
}

function decimalSerial(certificate: X509Certificate): string {
  return BigInt(`0x${certificate.serialNumber}`).toString(10);
}

function normalizeIssuer(value: string): string {
  return value
    .split(/\r?\n|,\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

const TEST_PKI = generateEphemeralTestPki();
const LEAF_DER = TEST_PKI.leafDer;
const INTERMEDIATE_DER = TEST_PKI.intermediateDer;
const ROOT_DER = TEST_PKI.rootDer;
const ROOT_SHA256 = TEST_PKI.rootSha256Hex;
const SPKI_DER = TEST_PKI.spkiDer;
const LEAF_NOT_BEFORE = certificateInstant(TEST_PKI.leafCertificate.validFrom);
const LEAF_NOT_AFTER = certificateInstant(TEST_PKI.leafCertificate.validTo);
const ISSUED_AT = utcSecond(LEAF_NOT_BEFORE + 30_000);
const STAMPING_TIME = utcSecond(LEAF_NOT_BEFORE + 60_000);
const STATUS_CHECKED_AT = utcSecond(LEAF_NOT_BEFORE);
const STATUS_VALID_UNTIL = utcSecond(LEAF_NOT_BEFORE + 6 * 24 * 60 * 60 * 1000);
const SCOPE = { tenantId: tenantId('tenant-a') };
const TERMINAL_ID = '018f2e20-7b7a-7c00-8000-000000000012';

const KEY: ZatcaSigningKeyHandle = {
  provider: 'test-hsm',
  keyId: 'sealer-key-1',
  curve: ZATCA_SIGNING_CURVE,
  algorithm: ZATCA_SIGNING_ALGORITHM,
  exportable: false,
};

function sha256Base64(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('base64');
}

function evidence(certificateDer: Uint8Array): ZatcaCertificateStatusEvidence {
  return {
    certificateSha256: sha256Base64(certificateDer),
    status: 'good',
    source: 'crl',
    checkedAt: STATUS_CHECKED_AT,
    validUntil: STATUS_VALID_UNTIL,
  };
}

function csid(overrides: Partial<ZatcaCsidBinding> = {}): ZatcaCsidBinding {
  return {
    credentialId: 'csid-test-1',
    scope: SCOPE,
    terminalId: TERMINAL_ID,
    state: 'active',
    key: KEY,
    certificatePath: [
      {
        certificateDer: Uint8Array.from(LEAF_DER),
        issuerName: normalizeIssuer(TEST_PKI.leafCertificate.issuer),
        serialNumber: decimalSerial(TEST_PKI.leafCertificate),
      },
      {
        certificateDer: Uint8Array.from(INTERMEDIATE_DER),
        issuerName: normalizeIssuer(TEST_PKI.intermediateCertificate.issuer),
        serialNumber: decimalSerial(TEST_PKI.intermediateCertificate),
      },
      {
        certificateDer: Uint8Array.from(ROOT_DER),
        issuerName: normalizeIssuer(TEST_PKI.rootCertificate.issuer),
        serialNumber: decimalSerial(TEST_PKI.rootCertificate),
      },
    ],
    certificateStatus: [evidence(LEAF_DER), evidence(INTERMEDIATE_DER)],
    signingPublicKeySpkiDer: Uint8Array.from(SPKI_DER),
    notBefore: utcSecond(LEAF_NOT_BEFORE),
    notAfter: utcSecond(LEAF_NOT_AFTER),
    fatooraSecret: { provider: 'test-vault', secretId: 'fatoora-test-1' },
    ...overrides,
  };
}

function invoiceInput(): ZatcaSimplifiedInvoiceHashInput {
  const sale: SaleRecord = {
    id: '018f2e20-7b7a-7c00-8000-000000000001',
    tenantId: SCOPE.tenantId,
    branchId: '018f2e20-7b7a-7c00-8000-000000000011',
    terminalId: TERMINAL_ID,
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
  };
  const invoice: InvoiceRecord = {
    id: '018f2e20-7b7a-7c00-8000-000000000002',
    tenantId: SCOPE.tenantId,
    saleId: sale.id,
    invoiceNumber: 'RUH-000042',
    invoiceType: 'simplified',
    sellerName: 'شركة كورفي للتجارة',
    sellerVatNumber: '310123456789013',
    buyerName: null,
    buyerVatNumber: null,
    netMinor: '10000',
    vatMinor: '1500',
    totalMinor: '11500',
    currency: 'SAR',
    issuedAt: ISSUED_AT,
    taxBreakdown: [{ vatBasisPoints: VAT_STANDARD_BP, netMinor: '10000', vatMinor: '1500' }],
  };
  return {
    sale,
    invoice,
    seller: {
      registrationName: invoice.sellerName,
      vatRegistrationNumber: invoice.sellerVatNumber,
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

function flipLastByte(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new Error('cannot corrupt empty test bytes');
  const index = bytes.length - 1;
  const current = bytes[index];
  if (current === undefined) throw new Error('cannot corrupt missing test byte');
  bytes[index] = current ^ 1;
}

function signingPort(options: { corruptSignature?: boolean; publicKey?: Uint8Array } = {}) {
  const signSha256 = vi.fn<ZatcaSigningKeyPort['signSha256']>(async (input) => {
    const signer = createSign('SHA256');
    signer.update(Buffer.from(input.message));
    signer.end();
    const signatureDer = Uint8Array.from(signer.sign(TEST_PKI.leafPrivateKey));
    if (options.corruptSignature) flipLastByte(signatureDer);
    return signatureDer;
  });
  const port: ZatcaSigningKeyPort = {
    async generateNonExportableKey() {
      throw new Error('not used');
    },
    async describePublicKey() {
      return {
        handle: KEY,
        publicKeySpkiDer: Uint8Array.from(options.publicKey ?? SPKI_DER),
        createdAt: STATUS_CHECKED_AT,
      };
    },
    async createPkcs10Csr() {
      throw new Error('not used');
    },
    signSha256,
  };
  return { port, signSha256 };
}

function decodeTlv(base64: string): Map<number, Uint8Array> {
  const bytes = Buffer.from(base64, 'base64');
  const fields = new Map<number, Uint8Array>();
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset];
    const length = bytes[offset + 1];
    if (tag === undefined || length === undefined || offset + 2 + length > bytes.length) {
      throw new Error('invalid test TLV');
    }
    if (fields.has(tag)) throw new Error(`duplicate test TLV tag ${String(tag)}`);
    fields.set(tag, Uint8Array.from(bytes.subarray(offset + 2, offset + 2 + length)));
    offset += 2 + length;
  }
  return fields;
}

async function writeSafeProofArtifacts(
  result: Awaited<ReturnType<ReturnType<typeof createZatcaSimplifiedInvoiceSealer>['seal']>>,
  canonicalizer: Libxml2ZatcaCanonicalizer,
): Promise<void> {
  const configured = process.env.KORVI_ZATCA_PROOF_DIR;
  if (configured === undefined || configured.trim() === '') return;

  const directory = resolve(configured);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write = (name: string, value: string | Uint8Array): void => {
    writeFileSync(join(directory, name), value, { mode: 0o600 });
  };

  write('sealed-invoice.xml', result.xml);
  write('invoice-hash.raw', result.invoiceHash);
  write(
    'signature.der',
    xmlDsigEcdsaSignatureToDer(Uint8Array.from(Buffer.from(result.signatureValueBase64, 'base64'))),
  );
  write('signing-public-key.spki.der', result.signingPublicKeySpkiDer);
  write('technical-ca-signature.der', result.technicalCaSignatureDer);
  write('certificate-path-0.der', LEAF_DER);
  write('certificate-path-1.der', INTERMEDIATE_DER);
  write('certificate-path-2.der', ROOT_DER);
  write(
    'signing-public-key.pem',
    TEST_PKI.leafCertificate.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
  write(
    'production-invoice-reference.c14n.xml',
    await canonicalizer.canonicalizeInvoiceReference(result.xml),
  );
  write('production-signed-info.c14n.xml', await canonicalizer.canonicalizeSignedInfo(result.xml));
  write(
    'production-signed-properties.c14n.xml',
    await canonicalizer.canonicalizeSignedProperties(result.xml),
  );
  write(
    'proof-generator.txt',
    [
      `invoice_hash_base64=${result.invoiceHashBase64}`,
      `signature_value_base64=${result.signatureValueBase64}`,
      `qr_base64_characters=${String(result.qrCodeBase64.length)}`,
      `trust_anchor_sha256=${result.trustAnchorSha256Hex}`,
      'private_key_artifact=ABSENT',
      '',
    ].join('\n'),
  );
}

describe('ZATCA simplified invoice sealing authority', () => {
  it('seals the Fatoora profile and binds the exact invoice hash/signature into QR 6-9', async () => {
    const signing = signingPort();
    const canonicalizer = new Libxml2ZatcaCanonicalizer();
    const sealer = createZatcaSimplifiedInvoiceSealer({
      canonicalizer,
      signingKey: signing.port,
      trustedAnchorSha256Hex: [ROOT_SHA256],
    });

    const result = await sealer.seal({
      scope: SCOPE,
      terminalId: TERMINAL_ID,
      stampingTime: STAMPING_TIME,
      csid: csid(),
      invoice: invoiceInput(),
    });

    expect(signing.signSha256).toHaveBeenCalledTimes(1);
    const call = signing.signSha256.mock.calls[0]?.[0];
    const signedInfoCanonical = await canonicalizer.canonicalizeSignedInfo(result.xml);
    expect(call?.message).toEqual(signedInfoCanonical);
    expect(call?.message).not.toEqual(result.invoiceHash);
    expect(signedInfoCanonical.length).toBeGreaterThan(32);

    const signatureValue = Uint8Array.from(Buffer.from(result.signatureValueBase64, 'base64'));
    expect(signatureValue).toHaveLength(64);
    const signatureDer = xmlDsigEcdsaSignatureToDer(signatureValue);
    expect(
      verify('sha256', signedInfoCanonical, TEST_PKI.leafCertificate.publicKey, signatureDer),
    ).toBe(true);
    expect(
      verify('sha256', result.invoiceHash, TEST_PKI.leafCertificate.publicKey, signatureDer),
    ).toBe(false);
    expect(signatureDer[0]).toBe(0x30);
    expect(ecdsaDerToXmlDsigSignature(signatureDer)).toEqual(signatureValue);
    expect(result.xml).toContain(
      `<ds:SignatureValue>${result.signatureValueBase64}</ds:SignatureValue>`,
    );
    expect(result.xml).toContain('<xades:SigningCertificate>');
    expect(result.xml).not.toContain('SigningCertificateV2');
    expect(result.xml).toContain('<xades:IssuerSerial>');
    expect(result.xml.match(/<ds:X509Certificate>/g)).toHaveLength(1);
    expect(result.xml).toContain(bytesToBase64(LEAF_DER));
    expect(result.xml).not.toContain(bytesToBase64(INTERMEDIATE_DER));
    expect(result.xml).not.toContain(bytesToBase64(ROOT_DER));
    expect(result.xml).toContain('<cbc:ID>QR</cbc:ID>');
    expect(result.invoiceHashBase64).toBe(bytesToBase64(result.invoiceHash));
    expect(result.trustAnchorSha256Hex).toBe(ROOT_SHA256);

    const tlv = decodeTlv(result.qrCodeBase64);
    expect(tlv.get(6)).toEqual(result.invoiceHash);
    expect(new TextDecoder().decode(tlv.get(7))).toBe(bytesToBase64(signatureDer));
    expect(new TextDecoder().decode(tlv.get(7))).not.toBe(result.signatureValueBase64);
    expect(tlv.get(8)).toEqual(result.signingPublicKeySpkiDer);
    expect(tlv.get(9)).toEqual(result.technicalCaSignatureDer);

    await writeSafeProofArtifacts(result, canonicalizer);
  });

  it('fails closed before signing when the trust anchor is not pinned', async () => {
    const signing = signingPort();
    const sealer = createZatcaSimplifiedInvoiceSealer({
      canonicalizer: new Libxml2ZatcaCanonicalizer(),
      signingKey: signing.port,
      trustedAnchorSha256Hex: ['0'.repeat(64)],
    });

    await expect(
      sealer.seal({
        scope: SCOPE,
        terminalId: TERMINAL_ID,
        stampingTime: STAMPING_TIME,
        csid: csid(),
        invoice: invoiceInput(),
      }),
    ).rejects.toThrow(/server-pinned trust anchor/);
    expect(signing.signSha256).not.toHaveBeenCalled();
  });

  it('fails closed if stored and provider SPKI agree with each other but not with certificate DER', async () => {
    const forgedSpki = Uint8Array.from(SPKI_DER);
    flipLastByte(forgedSpki);
    const signing = signingPort({ publicKey: forgedSpki });
    const sealer = createZatcaSimplifiedInvoiceSealer({
      canonicalizer: new Libxml2ZatcaCanonicalizer(),
      signingKey: signing.port,
      trustedAnchorSha256Hex: [ROOT_SHA256],
    });

    await expect(
      sealer.seal({
        scope: SCOPE,
        terminalId: TERMINAL_ID,
        stampingTime: STAMPING_TIME,
        csid: csid({ signingPublicKeySpkiDer: forgedSpki }),
        invoice: invoiceInput(),
      }),
    ).rejects.toThrow(/certificate SPKI \/ persisted CSID SPKI/);
    expect(signing.signSha256).not.toHaveBeenCalled();
  });

  it('rejects a corrupt HSM signature after signing and emits no sealed result', async () => {
    const signing = signingPort({ corruptSignature: true });
    const sealer = createZatcaSimplifiedInvoiceSealer({
      canonicalizer: new Libxml2ZatcaCanonicalizer(),
      signingKey: signing.port,
      trustedAnchorSha256Hex: [ROOT_SHA256],
    });

    await expect(
      sealer.seal({
        scope: SCOPE,
        terminalId: TERMINAL_ID,
        stampingTime: STAMPING_TIME,
        csid: csid(),
        invoice: invoiceInput(),
      }),
    ).rejects.toThrow(/does not verify against the CSID certificate/);
    expect(signing.signSha256).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-tenant authority and pre-invoice SigningTime before HSM use', async () => {
    const signing = signingPort();
    const sealer = createZatcaSimplifiedInvoiceSealer({
      canonicalizer: new Libxml2ZatcaCanonicalizer(),
      signingKey: signing.port,
      trustedAnchorSha256Hex: [ROOT_SHA256],
    });

    await expect(
      sealer.seal({
        scope: { tenantId: tenantId('tenant-b') },
        terminalId: TERMINAL_ID,
        stampingTime: STAMPING_TIME,
        csid: csid(),
        invoice: invoiceInput(),
      }),
    ).rejects.toThrow(/cross-tenant/);
    await expect(
      sealer.seal({
        scope: SCOPE,
        terminalId: TERMINAL_ID,
        stampingTime: utcSecond(Date.parse(ISSUED_AT) - 1000),
        csid: csid(),
        invoice: invoiceInput(),
      }),
    ).rejects.toThrow(/cannot precede/);
    expect(signing.signSha256).not.toHaveBeenCalled();
  });
});
