import { createHash, createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';
import {
  ZatcaInvoiceError,
  assembleZatcaSimplifiedInvoice,
  bytesToBase64,
  extractZatcaSigningCertificateMaterial,
  money,
  phase2SimplifiedInvoiceQr,
  renderZatcaSimplifiedInvoiceHashPayload,
  renderZatcaSignedInfoXml,
  renderZatcaSignedPropertiesXml,
  renderZatcaUblSignatureExtension,
  validateZatcaCsidForStamping,
  validateXmlDsigEcdsaSignature,
  xmlDsigEcdsaSignatureBase64,
  xmlDsigEcdsaSignatureToDer,
  type TenantScope,
  type ZatcaCsidBinding,
  type ZatcaSigningKeyPort,
  type ZatcaSimplifiedInvoiceHashInput,
  type ZatcaXmlCanonicalizationPort,
} from '@korvi/domain';
import { verifyZatcaCertificatePath } from './certificate-path-validator.js';

const SHA256_BYTES = 32;
const ZERO_SHA256 = new Uint8Array(SHA256_BYTES);

export interface ZatcaSimplifiedInvoiceSealerDependencies {
  readonly canonicalizer: ZatcaXmlCanonicalizationPort;
  readonly signingKey: ZatcaSigningKeyPort;
  /** Server-controlled ZATCA trust anchors only; never supplied by a request. */
  readonly trustedAnchorSha256Hex: readonly string[];
  /** Server-controlled authoritative XAdES policy identity and exact SHA-256 digest. */
  readonly signaturePolicyIdentifier: string;
  readonly signaturePolicyDigest: Uint8Array;
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
 * Trust anchors and signature-policy material are captured once from trusted
 * application configuration. Per-request callers can never substitute either.
 */
export function createZatcaSimplifiedInvoiceSealer(
  dependencies: ZatcaSimplifiedInvoiceSealerDependencies,
): ZatcaSimplifiedInvoiceSealer {
  const trustedAnchorSha256Hex = [...dependencies.trustedAnchorSha256Hex];
  const signaturePolicyDigest = Uint8Array.from(dependencies.signaturePolicyDigest);
  const signaturePolicyIdentifier = dependencies.signaturePolicyIdentifier;

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
      const signedPropertiesXml = await renderZatcaSignedPropertiesXml({
        signingTime: input.stampingTime,
        certificatePathDer,
        signaturePolicyIdentifier,
        signaturePolicyDigest,
      });

      const contextSkeleton = assembleZatcaSimplifiedInvoice({
        unsignedInvoiceXml: rendered.canonicalXml,
        signatureExtensionXml: renderZatcaUblSignatureExtension({
          signedInfoXml: renderZatcaSignedInfoXml({
            invoiceDigest: ZERO_SHA256,
            signedPropertiesDigest: ZERO_SHA256,
          }),
          signedPropertiesXml,
          certificatePathDer,
          signatureValueBase64: '',
        }),
      });

      const signedPropertiesCanonical =
        await dependencies.canonicalizer.canonicalizeSignedProperties(contextSkeleton);
      const signedPropertiesDigest = sha256(signedPropertiesCanonical);

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
        signedPropertiesDigest,
      });
      const signingSkeleton = assembleZatcaSimplifiedInvoice({
        unsignedInvoiceXml: rendered.canonicalXml,
        signatureExtensionXml: renderZatcaUblSignatureExtension({
          signedInfoXml,
          signedPropertiesXml,
          certificatePathDer,
          signatureValueBase64: '',
        }),
      });
      const signedInfoCanonical =
        await dependencies.canonicalizer.canonicalizeSignedInfo(signingSkeleton);

      const signatureRaw = validateXmlDsigEcdsaSignature(
        await dependencies.signingKey.signSha256({
          scope: input.scope,
          terminalId: input.terminalId,
          key: csid.key,
          message: Uint8Array.from(signedInfoCanonical),
        }),
      );
      verifyGeneratedSignature(
        signedInfoCanonical,
        signatureRaw,
        certificateMaterial.signingPublicKeySpkiDer,
      );
      const signatureValueBase64 = xmlDsigEcdsaSignatureBase64(signatureRaw);

      const qrCodeBase64 = phase2SimplifiedInvoiceQr({
        sellerName: input.invoice.invoice.sellerName,
        vatRegistrationNumber: input.invoice.invoice.sellerVatNumber,
        timestamp: rendered.issuedAt,
        invoiceTotalWithVat: money(BigInt(input.invoice.invoice.totalMinor), 'SAR'),
        vatTotal: money(BigInt(input.invoice.invoice.vatMinor), 'SAR'),
        invoiceHash: invoiceDigest,
        xmlSignatureValueBase64: signatureValueBase64,
        ecdsaPublicKeySpkiDer: certificateMaterial.signingPublicKeySpkiDer,
        zatcaCaSignatureDer: certificateMaterial.technicalCaSignatureDer,
      });

      const finalXml = assembleZatcaSimplifiedInvoice({
        unsignedInvoiceXml: rendered.canonicalXml,
        signatureExtensionXml: renderZatcaUblSignatureExtension({
          signedInfoXml,
          signedPropertiesXml,
          certificatePathDer,
          signatureValueBase64,
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
    throw new ZatcaInvoiceError('ZATCA sealing terminal does not match the immutable sale terminal.');
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
  if (!Number.isFinite(instant) || new Date(instant).toISOString().replace('.000Z', 'Z') !== value) {
    throw new ZatcaInvoiceError(`ZATCA ${label} is not a real UTC calendar instant.`);
  }
  return instant;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(bytes).digest());
}

function verifyGeneratedSignature(
  signedInfoCanonical: Uint8Array,
  signatureRaw: Uint8Array,
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
  verifier.update(Buffer.from(signedInfoCanonical));
  verifier.end();
  if (!verifier.verify(publicKey, Buffer.from(xmlDsigEcdsaSignatureToDer(signatureRaw)))) {
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
    'final SignedProperties / hashed SignedProperties',
    finalProperties,
    input.signedPropertiesCanonical,
  );
  assertSameBytes('final SignedInfo / signed SignedInfo', finalSignedInfo, input.signedInfoCanonical);
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
