import { createHash, createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';
import {
  ZatcaInvoiceError,
  assembleZatcaSimplifiedInvoice,
  bytesToBase64,
  ecdsaDerToXmlDsigSignature,
  extractZatcaSigningCertificateMaterial,
  hashZatcaSignedPropertiesProfile,
  money,
  phase2SimplifiedInvoiceQr,
  renderZatcaSimplifiedInvoiceHashPayload,
  renderZatcaSignedInfoXml,
  renderZatcaSignedPropertiesHashInputXml,
  renderZatcaSignedPropertiesXml,
  renderZatcaUblSignatureExtension,
  validateZatcaCsidForStamping,
  xmlDsigEcdsaSignatureToDer,
  type TenantScope,
  type ZatcaCsidBinding,
  type ZatcaSigningKeyPort,
  type ZatcaSimplifiedInvoiceHashInput,
  type ZatcaXmlCanonicalizationPort,
} from '@korvi/domain';
import { verifyZatcaCertificatePath } from './certificate-path-validator.js';

const SHA256_BYTES = 32;
const ZERO_SHA256_HEX = '0'.repeat(SHA256_BYTES * 2);

export interface ZatcaSimplifiedInvoiceSealerDependencies {
  readonly canonicalizer: ZatcaXmlCanonicalizationPort;
  readonly signingKey: ZatcaSigningKeyPort;
  /** Server-controlled ZATCA trust anchors only; never supplied by a request. */
  readonly trustedAnchorSha256Hex: readonly string[];
  /**
   * Reserved for policy-version pinning during onboarding. The current Fatoora
   * invoice profile does not serialize an explicit policy element.
   */
  readonly signaturePolicyIdentifier?: string;
  readonly signaturePolicyDigest?: Uint8Array;
}

export interface SealZatcaSimplifiedInvoiceInput {
  readonly scope: TenantScope;
  readonly terminalId: string;
  /** Exact UTC second used by certificate validation, revocation evidence and XAdES SigningTime. */
  readonly stampingTime: string;
  readonly csid: ZatcaCsidBinding;
  /** Immutable sale/invoice/fiscal truth; XML and QR facts are derived from this one source. */
  readonly invoice: ZatcaSimplifiedInvoiceHashInput;
}

export interface SealedZatcaSimplifiedInvoice {
  readonly xml: string;
  readonly invoiceHashBase64: string;
  readonly invoiceHash: Uint8Array;
  readonly qrCodeBase64: string;
  /** Base64 of XMLDSIG's fixed-width secp256k1 r || s SignatureValue. */
  readonly signatureValueBase64: string;
  readonly signingPublicKeySpkiDer: Uint8Array;
  readonly technicalCaSignatureDer: Uint8Array;
  readonly trustAnchorSha256Hex: string;
}

export interface ZatcaSimplifiedInvoiceSealer {
  seal(input: SealZatcaSimplifiedInvoiceInput): Promise<SealedZatcaSimplifiedInvoice>;
}

/**
 * Construct the Gate 39 sealing authority from server-owned dependencies.
 *
 * Trust anchors are captured once from trusted application configuration.
 * Per-request callers can never substitute them or inject private-key material.
 */
export function createZatcaSimplifiedInvoiceSealer(
  dependencies: ZatcaSimplifiedInvoiceSealerDependencies,
): ZatcaSimplifiedInvoiceSealer {
  const trustedAnchorSha256Hex = [...dependencies.trustedAnchorSha256Hex];

  return {
    async seal(input) {
      assertAuthorityBinding(input);

      const rendered = renderZatcaSimplifiedInvoiceHashPayload(input.invoice);
      assertStampingOrder(rendered.issuedAt, input.stampingTime);

      const keyDescription = await dependencies.signingKey.describePublicKey(
        input.scope,
        input.terminalId,
        input.csid.key,
      );
      const csid = await validateZatcaCsidForStamping({
        scope: input.scope,
        terminalId: input.terminalId,
        at: input.stampingTime,
        keyDescription,
        binding: input.csid,
      });

      const trust = verifyZatcaCertificatePath({
        certificatePath: csid.certificatePath,
        trustedAnchorSha256Hex,
        at: input.stampingTime,
      });

      const certificateMaterial = extractZatcaSigningCertificateMaterial(
        csid.signingCertificate.certificateDer,
      );
      assertSameBytes(
        'signing certificate SPKI / persisted CSID SPKI',
        certificateMaterial.signingPublicKeySpkiDer,
        csid.signingPublicKeySpkiDer,
      );
      assertSameBytes(
        'signing certificate SPKI / resolved signing-key SPKI',
        certificateMaterial.signingPublicKeySpkiDer,
        keyDescription.publicKeySpkiDer,
      );

      const certificatePathDer = csid.certificatePath.map((entry) =>
        Uint8Array.from(entry.certificateDer),
      );
      const signedPropertiesInput = {
        signingTime: input.stampingTime,
        signingCertificateDer: Uint8Array.from(csid.signingCertificate.certificateDer),
        issuerName: trust.signingCertificateIssuerName,
        serialNumber: trust.signingCertificateSerialNumber,
      };
      const [signedPropertiesXml, signedPropertiesHashInputXml] = await Promise.all([
        renderZatcaSignedPropertiesXml(signedPropertiesInput),
        renderZatcaSignedPropertiesHashInputXml(signedPropertiesInput),
      ]);
      const signedPropertiesDigestHex = await hashZatcaSignedPropertiesProfile(
        signedPropertiesHashInputXml,
      );

      const contextSkeleton = assembleZatcaSimplifiedInvoice({
        unsignedInvoiceXml: rendered.canonicalXml,
        signatureExtensionXml: renderZatcaUblSignatureExtension({
          signedInfoXml: renderZatcaSignedInfoXml({
            invoiceDigest: new Uint8Array(SHA256_BYTES),
            signedPropertiesDigestHex: ZERO_SHA256_HEX,
          }),
          signedPropertiesXml,
          certificatePathDer,
        }),
      });

      const signedPropertiesCanonical =
        await dependencies.canonicalizer.canonicalizeSignedProperties(contextSkeleton);
      const invoiceCanonical =
        await dependencies.canonicalizer.canonicalizeInvoiceReference(contextSkeleton);
      const gate38Bytes = new TextEncoder().encode(rendered.canonicalXml);
      assertSameBytes(
        'Gate 38 canonical invoice / Gate 39 invoice reference',
        gate38Bytes,
        invoiceCanonical,
      );
      const invoiceDigest = sha256(invoiceCanonical);

      const signedInfoXml = renderZatcaSignedInfoXml({
        invoiceDigest,
        signedPropertiesDigestHex,
      });
      const signingSkeleton = assembleZatcaSimplifiedInvoice({
        unsignedInvoiceXml: rendered.canonicalXml,
        signatureExtensionXml: renderZatcaUblSignatureExtension({
          signedInfoXml,
          signedPropertiesXml,
          certificatePathDer,
        }),
      });
      const signedInfoCanonical =
        await dependencies.canonicalizer.canonicalizeSignedInfo(signingSkeleton);

      const signatureDer = validateCanonicalEcdsaDer(
        await dependencies.signingKey.signSha256({
          scope: input.scope,
          terminalId: input.terminalId,
          key: csid.key,
          message: Uint8Array.from(signedInfoCanonical),
        }),
      );
      verifyGeneratedSignature(
        signedInfoCanonical,
        signatureDer,
        certificateMaterial.signingPublicKeySpkiDer,
      );
      const signatureValue = ecdsaDerToXmlDsigSignature(signatureDer);
      const signatureValueBase64 = bytesToBase64(signatureValue);

      const qrCodeBase64 = phase2SimplifiedInvoiceQr({
        sellerName: input.invoice.invoice.sellerName,
        vatRegistrationNumber: input.invoice.invoice.sellerVatNumber,
        timestamp: rendered.issuedAt,
        invoiceTotalWithVat: money(BigInt(input.invoice.invoice.totalMinor), 'SAR'),
        vatTotal: money(BigInt(input.invoice.invoice.vatMinor), 'SAR'),
        invoiceHash: invoiceDigest,
        ecdsaSignatureDer: signatureDer,
        ecdsaPublicKeySpkiDer: certificateMaterial.signingPublicKeySpkiDer,
        zatcaCaSignatureDer: certificateMaterial.technicalCaSignatureDer,
      });

      const finalXml = assembleZatcaSimplifiedInvoice({
        unsignedInvoiceXml: rendered.canonicalXml,
        signatureExtensionXml: renderZatcaUblSignatureExtension({
          signedInfoXml,
          signedPropertiesXml,
          certificatePathDer,
          signatureValue,
        }),
        qrCodeBase64,
      });

      await assertFinalCryptographicInvariants({
        canonicalizer: dependencies.canonicalizer,
        finalXml,
        invoiceCanonical,
        signedPropertiesCanonical,
        signedInfoCanonical,
      });

      return {
        xml: finalXml,
        invoiceHashBase64: bytesToBase64(invoiceDigest),
        invoiceHash: Uint8Array.from(invoiceDigest),
        qrCodeBase64,
        signatureValueBase64,
        signingPublicKeySpkiDer: Uint8Array.from(certificateMaterial.signingPublicKeySpkiDer),
        technicalCaSignatureDer: Uint8Array.from(certificateMaterial.technicalCaSignatureDer),
        trustAnchorSha256Hex: trust.trustAnchorSha256Hex,
      };
    },
  };
}

function assertAuthorityBinding(input: SealZatcaSimplifiedInvoiceInput): void {
  const sale = input.invoice.sale;
  const invoice = input.invoice.invoice;
  if (sale.tenantId !== input.scope.tenantId || invoice.tenantId !== input.scope.tenantId) {
    throw new ZatcaInvoiceError('ZATCA sealing refuses cross-tenant sale or invoice authority.');
  }
  if (sale.terminalId !== input.terminalId) {
    throw new ZatcaInvoiceError(
      'ZATCA sealing terminal does not match the immutable sale terminal.',
    );
  }
}

function assertStampingOrder(invoiceTime: string, stampingTime: string): void {
  const invoiceInstant = parseUtcSecond(invoiceTime, 'invoice timestamp');
  const stampInstant = parseUtcSecond(stampingTime, 'stamping timestamp');
  if (stampInstant < invoiceInstant) {
    throw new ZatcaInvoiceError('ZATCA SigningTime cannot precede the invoice issue timestamp.');
  }
}

function parseUtcSecond(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new ZatcaInvoiceError(`ZATCA ${label} must be an exact UTC second.`);
  }
  const instant = Date.parse(value);
  if (
    !Number.isFinite(instant) ||
    new Date(instant).toISOString().replace('.000Z', 'Z') !== value
  ) {
    throw new ZatcaInvoiceError(`ZATCA ${label} is not a real UTC calendar instant.`);
  }
  return instant;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(bytes).digest());
}

function validateCanonicalEcdsaDer(signatureDer: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(signatureDer);
  const xmlDsigRaw = ecdsaDerToXmlDsigSignature(copy);
  const canonicalDer = xmlDsigEcdsaSignatureToDer(xmlDsigRaw);
  assertSameBytes('HSM ECDSA DER / canonical ECDSA DER', copy, canonicalDer);
  return copy;
}

function verifyGeneratedSignature(
  invoiceDigest: Uint8Array,
  signatureDer: Uint8Array,
  publicKeySpkiDer: Uint8Array,
): void {
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(publicKeySpkiDer),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new ZatcaInvoiceError(
      'ZATCA signing certificate SPKI cannot be loaded for self-verification.',
    );
  }

  const verifier = createVerify('SHA256');
  verifier.update(Buffer.from(invoiceDigest));
  verifier.end();
  if (!verifier.verify(publicKey, Buffer.from(signatureDer))) {
    throw new ZatcaInvoiceError(
      'ZATCA signing provider returned a signature that does not verify against the CSID certificate.',
    );
  }
}

async function assertFinalCryptographicInvariants(input: {
  readonly canonicalizer: ZatcaXmlCanonicalizationPort;
  readonly finalXml: string;
  readonly invoiceCanonical: Uint8Array;
  readonly signedPropertiesCanonical: Uint8Array;
  readonly signedInfoCanonical: Uint8Array;
}): Promise<void> {
  const finalInvoice = await input.canonicalizer.canonicalizeInvoiceReference(input.finalXml);
  const finalProperties = await input.canonicalizer.canonicalizeSignedProperties(input.finalXml);
  const finalSignedInfo = await input.canonicalizer.canonicalizeSignedInfo(input.finalXml);
  assertSameBytes(
    'final invoice reference / signed invoice reference',
    finalInvoice,
    input.invoiceCanonical,
  );
  assertSameBytes(
    'final SignedProperties / generated SignedProperties',
    finalProperties,
    input.signedPropertiesCanonical,
  );
  assertSameBytes(
    'final SignedInfo / generated SignedInfo',
    finalSignedInfo,
    input.signedInfoCanonical,
  );
}

function assertSameBytes(label: string, left: Uint8Array, right: Uint8Array): void {
  if (left.length !== right.length) {
    throw new ZatcaInvoiceError(`ZATCA ${label} byte length diverged.`);
  }
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (!timingSafeEqual(leftBuffer, rightBuffer)) {
    throw new ZatcaInvoiceError(`ZATCA ${label} bytes diverged.`);
  }
}
