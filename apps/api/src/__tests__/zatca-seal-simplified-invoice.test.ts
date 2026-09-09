import { X509Certificate, createHash, createSign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  VAT_STANDARD_BP,
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  bytesToBase64,
  ecdsaDerToXmlDsigSignature,
  tenantId,
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

const LEAF_DER = Buffer.from(
  'MIIB4zCCAYigAwIBAgIUAd/8P8r0vrwgyH30f9NxM0Dlr4EwCgYIKoZIzj0EAwIwRjEiMCAGA1UEAwwZS29ydmkgU2VhbGVyIEludGVybWVkaWF0ZTETMBEGA1UECgwKS29ydmkgVGVzdDELMAkGA1UEBhMCU0EwHhcNMjYwOTA5MjM0NTM0WhcNMjkwNjA1MjM0NTM0WjA9MRkwFwYDVQQDDBBLb3J2aSBTZWFsZXIgRUdTMRMwEQYDVQQKDApLb3J2aSBUZXN0MQswCQYDVQQGEwJTQTBWMBAGByqGSM49AgEGBSuBBAAKA0IABLzMJqyyf6+Ltv1429ZSDKCxp/IvoU3+Tuyyhq2lh6v83cZipEBC9Jq0vuTgZqcZYIHt6aammDCA3yDp7eQX1bGjYDBeMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgeAMB0GA1UdDgQWBBQhSrWnDMPqiKKLcBiz4EZKE7edIjAfBgNVHSMEGDAWgBQJXJ3MeTNLwE/Fsayy+ymcUtjaZjAKBggqhkjOPQQDAgNJADBGAiEAiRXzzVIn/vR5yZtvUBuq3lBTPsH6YKNw/XEo1FkpYaMCIQCldoSFff4jO6Ip2iCw5Y19YMWlbs12s06wZySSg28edA==',
  'base64',
);
const INTERMEDIATE_DER = Buffer.from(
  'MIIB6TCCAY+gAwIBAgIUJCzX1lR60OABX9QbhN8m2en2KyYwCgYIKoZIzj0EAwIwPjEaMBgGA1UEAwwRS29ydmkgU2VhbGVyIFJvb3QxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMB4XDTI2MDkwOTIzNDUzNFoXDTMyMDMwMTIzNDUzNFowRjEiMCAGA1UEAwwZS29ydmkgU2VhbGVyIEludGVybWVkaWF0ZTETMBEGA1UECgwKS29ydmkgVGVzdDELMAkGA1UEBhMCU0EwVjAQBgcqhkjOPQIBBgUrgQQACgNCAAQppDk+2G99qENha2+oQffgcVPGkp5uJADy3Sip+uB1Z1QBfFcr4QsbmmTiEwawO2Jf3e2eOOUpSLxKxhC1Ky7Lo2YwZDASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUCVydzHkzS8BPxbGssvspnFLY2mYwHwYDVR0jBBgwFoAUseEL/CSXPEAqWDZ6l4xFAFjSJf0wCgYIKoZIzj0EAwIDSAAwRQIgEBrADvdhRIeFnGY6rdIUVeaqg2jl2Pg+6c9ExKul81ICIQCSDxebn7fCZ29iPbiqdpw59xcT/A3YPi92iCn1woiKJw==',
  'base64',
);
const ROOT_DER = Buffer.from(
  'MIIB3jCCAYSgAwIBAgIUTqb9s2SbD83A2JOar8QgXn8uo8EwCgYIKoZIzj0EAwIwPjEaMBgGA1UEAwwRS29ydmkgU2VhbGVyIFJvb3QxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMB4XDTI2MDkwOTIzNDUzNFoXDTM2MDkwNjIzNDUzNFowPjEaMBgGA1UEAwwRS29ydmkgU2VhbGVyIFJvb3QxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEh+hDXRVsGcE2HOv7NskHtkfSEyazop3QAbUhR27aHrqLghk7EQOKMKpe0HhdsHZjPhZVCvrxo/lqCKQfL0TvkaNjMGEwHQYDVR0OBBYEFLHhC/wklzxAKlg2epeMRQBY0iX9MB8GA1UdIwQYMBaAFLHhC/wklzxAKlg2epeMRQBY0iX9MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCID0HpO1Ka1UgyytvN5IWtpKRJQ4tZwyZSGSa9iVzvDkPAiEA0cLqPWS5FXIz2kFkM/Qds4Z8Yq0aNp2dvCPRPEEpFhU=',
  'base64',
);
const LEAF_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGEAgEAMBAGByqGSM49AgEGBSuBBAAKBG0wawIBAQQgTxaPjqKitQysygPm85a0
nC9opoPgRy7E/hshzKmyTvChRANCAAS8zCassn+vi7b9eNvWUgygsafyL6FN/k7s
soatpYer/N3GYqRAQvSatL7k4GanGWCB7emmppgwgN8g6e3kF9Wx
-----END PRIVATE KEY-----
`;
const ROOT_SHA256 = '6ca8d850e4918d6b0cb7b8805177e37913fa8155938fc82f8ea2d96055ac2966';
const SCOPE = { tenantId: tenantId('tenant-a') };
const TERMINAL_ID = '018f2e20-7b7a-7c00-8000-000000000012';
const ISSUED_AT = '2026-12-31T23:59:59Z';
const STAMPING_TIME = '2027-01-01T00:00:00Z';
const SPKI_DER = Uint8Array.from(
  new X509Certificate(LEAF_DER).publicKey.export({ type: 'spki', format: 'der' }),
);

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
    checkedAt: '2026-12-31T00:00:00Z',
    validUntil: '2027-01-07T00:00:00Z',
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
        issuerName: 'CN=Korvi Sealer Intermediate',
        serialNumber: '10704030953714932230974407519112667291351101313',
      },
      {
        certificateDer: Uint8Array.from(INTERMEDIATE_DER),
        issuerName: 'CN=Korvi Sealer Root',
        serialNumber: '206523702612588268175886436154558785309413616422',
      },
      {
        certificateDer: Uint8Array.from(ROOT_DER),
        issuerName: 'CN=Korvi Sealer Root',
        serialNumber: '449025304279827906651231510168251346384099124161',
      },
    ],
    certificateStatus: [evidence(LEAF_DER), evidence(INTERMEDIATE_DER)],
    signingPublicKeySpkiDer: Uint8Array.from(SPKI_DER),
    notBefore: '2026-09-09T23:45:34Z',
    notAfter: '2029-06-05T23:45:34Z',
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

function signingPort(options: { corruptSignature?: boolean; publicKey?: Uint8Array } = {}) {
  const signSha256 = vi.fn<ZatcaSigningKeyPort['signSha256']>(async (input) => {
    const signer = createSign('SHA256');
    signer.update(Buffer.from(input.message));
    signer.end();
    const raw = ecdsaDerToXmlDsigSignature(signer.sign(LEAF_PRIVATE_KEY));
    if (options.corruptSignature) raw[0] ^= 1;
    return raw;
  });
  const port: ZatcaSigningKeyPort = {
    async generateNonExportableKey() {
      throw new Error('not used');
    },
    async describePublicKey() {
      return {
        handle: KEY,
        publicKeySpkiDer: Uint8Array.from(options.publicKey ?? SPKI_DER),
        createdAt: '2026-09-01T00:00:00Z',
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
    fields.set(tag, Uint8Array.from(bytes.subarray(offset + 2, offset + 2 + length)));
    offset += 2 + length;
  }
  return fields;
}

describe('ZATCA simplified invoice sealing authority', () => {
  it('seals from one immutable source, self-verifies, and binds QR tags 6-9 to the signature', async () => {
    const signing = signingPort();
    const sealer = createZatcaSimplifiedInvoiceSealer({
      canonicalizer: new Libxml2ZatcaCanonicalizer(),
      signingKey: signing.port,
      trustedAnchorSha256Hex: [ROOT_SHA256],
      signaturePolicyIdentifier: 'urn:zatca:signature-policy:test-v1',
      signaturePolicyDigest: new Uint8Array(32).fill(7),
    });

    const result = await sealer.seal({
      scope: SCOPE,
      terminalId: TERMINAL_ID,
      stampingTime: STAMPING_TIME,
      csid: csid(),
      invoice: invoiceInput(),
    });

    expect(signing.signSha256).toHaveBeenCalledTimes(1);
    expect(result.xml).toContain(
      `<ds:SignatureValue>${result.signatureValueBase64}</ds:SignatureValue>`,
    );
    expect(result.xml).toContain('<cbc:ID>QR</cbc:ID>');
    expect(result.xml).toContain('urn:oasis:names:specification:ubl:signature:Invoice');
    expect(result.invoiceHashBase64).toBe(bytesToBase64(result.invoiceHash));
    expect(result.trustAnchorSha256Hex).toBe(ROOT_SHA256);

    const tlv = decodeTlv(result.qrCodeBase64);
    expect(tlv.get(6)).toEqual(result.invoiceHash);
    expect(new TextDecoder().decode(tlv.get(7))).toBe(result.signatureValueBase64);
    expect(tlv.get(8)).toEqual(result.signingPublicKeySpkiDer);
    expect(tlv.get(9)).toEqual(result.technicalCaSignatureDer);
  });

  it('fails closed before signing when the trust anchor is not pinned', async () => {
    const signing = signingPort();
    const sealer = createZatcaSimplifiedInvoiceSealer({
      canonicalizer: new Libxml2ZatcaCanonicalizer(),
      signingKey: signing.port,
      trustedAnchorSha256Hex: ['0'.repeat(64)],
      signaturePolicyIdentifier: 'urn:zatca:signature-policy:test-v1',
      signaturePolicyDigest: new Uint8Array(32).fill(7),
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

  it('fails closed if stored and provider SPKI agree with each other but not with the certificate DER', async () => {
    const forgedSpki = Uint8Array.from(SPKI_DER);
    forgedSpki[forgedSpki.length - 1] ^= 1;
    const signing = signingPort({ publicKey: forgedSpki });
    const sealer = createZatcaSimplifiedInvoiceSealer({
      canonicalizer: new Libxml2ZatcaCanonicalizer(),
      signingKey: signing.port,
      trustedAnchorSha256Hex: [ROOT_SHA256],
      signaturePolicyIdentifier: 'urn:zatca:signature-policy:test-v1',
      signaturePolicyDigest: new Uint8Array(32).fill(7),
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
      signaturePolicyIdentifier: 'urn:zatca:signature-policy:test-v1',
      signaturePolicyDigest: new Uint8Array(32).fill(7),
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

  it('rejects cross-tenant authority and a SigningTime before invoice issuance before HSM use', async () => {
    const signing = signingPort();
    const sealer = createZatcaSimplifiedInvoiceSealer({
      canonicalizer: new Libxml2ZatcaCanonicalizer(),
      signingKey: signing.port,
      trustedAnchorSha256Hex: [ROOT_SHA256],
      signaturePolicyIdentifier: 'urn:zatca:signature-policy:test-v1',
      signaturePolicyDigest: new Uint8Array(32).fill(7),
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
        stampingTime: '2026-12-31T23:59:58Z',
        csid: csid(),
        invoice: invoiceInput(),
      }),
    ).rejects.toThrow(/cannot precede/);
    expect(signing.signSha256).not.toHaveBeenCalled();
  });
});
