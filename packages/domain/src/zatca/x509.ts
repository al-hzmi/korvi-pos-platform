import { ZatcaInvoiceError } from './phase2.js';

const DER_SEQUENCE = 0x30;
const DER_INTEGER = 0x02;
const DER_OBJECT_IDENTIFIER = 0x06;
const DER_BIT_STRING = 0x03;
const DER_CONTEXT_VERSION = 0xa0;

const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const OID_SECP256K1 = '1.3.132.0.10';
const UNCOMPRESSED_SECP256K1_POINT_BYTES = 65;

interface DerElement {
  readonly tag: number;
  readonly start: number;
  readonly contentStart: number;
  readonly contentLength: number;
  readonly end: number;
}

export interface ZatcaSigningCertificateMaterial {
  /** Exact DER SubjectPublicKeyInfo carried by the signing certificate. */
  readonly signingPublicKeySpkiDer: Uint8Array;
  /** Exact DER ECDSA signatureValue carried by the certificate BIT STRING; QR tag 9. */
  readonly technicalCaSignatureDer: Uint8Array;
}

/**
 * Extract the public cryptographic material ZATCA needs from a signing certificate.
 *
 * This is intentionally a narrow, strict DER reader rather than a generic X.509
 * implementation. It proves that the stored SPKI really belongs to the exact
 * certificate used in XAdES and extracts the issuer's ECDSA certificate signature
 * for simplified-invoice QR tag 9. Private-key material is never present here.
 */
export function extractZatcaSigningCertificateMaterial(
  certificateDer: Uint8Array,
): ZatcaSigningCertificateMaterial {
  const bytes = Uint8Array.from(certificateDer);
  if (bytes.length === 0) {
    throw new ZatcaInvoiceError('ZATCA signing certificate DER must not be empty.');
  }

  const certificate = readDerElement(bytes, 0, 'X.509 Certificate');
  requireTag(certificate, DER_SEQUENCE, 'X.509 Certificate must be a DER SEQUENCE.');
  if (certificate.end !== bytes.length) {
    throw new ZatcaInvoiceError('ZATCA signing certificate contains trailing DER data.');
  }

  const certificateChildren = readChildren(bytes, certificate, 'X.509 Certificate');
  if (certificateChildren.length !== 3) {
    throw new ZatcaInvoiceError('ZATCA signing certificate has an invalid Certificate structure.');
  }

  const tbsCertificate = certificateChildren[0];
  const outerSignatureAlgorithm = certificateChildren[1];
  const signatureValue = certificateChildren[2];
  if (
    tbsCertificate === undefined ||
    outerSignatureAlgorithm === undefined ||
    signatureValue === undefined
  ) {
    throw new ZatcaInvoiceError(
      'ZATCA signing certificate is missing required Certificate fields.',
    );
  }
  requireTag(tbsCertificate, DER_SEQUENCE, 'X.509 TBSCertificate must be a DER SEQUENCE.');
  requireTag(
    outerSignatureAlgorithm,
    DER_SEQUENCE,
    'X.509 signatureAlgorithm must be a DER SEQUENCE.',
  );
  requireTag(signatureValue, DER_BIT_STRING, 'X.509 signatureValue must be a DER BIT STRING.');

  const outerAlgorithmOid = readAlgorithmOid(
    bytes,
    outerSignatureAlgorithm,
    'certificate signature',
  );
  if (outerAlgorithmOid !== OID_ECDSA_WITH_SHA256) {
    throw new ZatcaInvoiceError(
      `ZATCA signing certificate must use ECDSA with SHA-256, got OID ${outerAlgorithmOid}.`,
    );
  }

  const tbsChildren = readChildren(bytes, tbsCertificate, 'TBSCertificate');
  const fieldOffset = tbsChildren[0]?.tag === DER_CONTEXT_VERSION ? 1 : 0;
  const tbsSignatureAlgorithm = tbsChildren[fieldOffset + 1];
  const subjectPublicKeyInfo = tbsChildren[fieldOffset + 5];
  if (tbsSignatureAlgorithm === undefined || subjectPublicKeyInfo === undefined) {
    throw new ZatcaInvoiceError('ZATCA signing certificate TBSCertificate is incomplete.');
  }
  requireTag(
    tbsSignatureAlgorithm,
    DER_SEQUENCE,
    'TBSCertificate signature algorithm must be a DER SEQUENCE.',
  );
  if (readAlgorithmOid(bytes, tbsSignatureAlgorithm, 'TBS signature') !== outerAlgorithmOid) {
    throw new ZatcaInvoiceError(
      'ZATCA signing certificate TBS and outer signature algorithms do not match.',
    );
  }

  requireTag(
    subjectPublicKeyInfo,
    DER_SEQUENCE,
    'X.509 SubjectPublicKeyInfo must be a DER SEQUENCE.',
  );
  validateSecp256k1Spki(bytes, subjectPublicKeyInfo);
  const spkiDer = bytes.slice(subjectPublicKeyInfo.start, subjectPublicKeyInfo.end);

  const signatureContent = content(bytes, signatureValue);
  if (signatureContent.length < 2 || signatureContent[0] !== 0) {
    throw new ZatcaInvoiceError(
      'ZATCA signing certificate signature BIT STRING must have zero unused bits.',
    );
  }
  const technicalCaSignatureDer = signatureContent.slice(1);
  validateEcdsaSignatureDerShape(technicalCaSignatureDer);

  return {
    signingPublicKeySpkiDer: spkiDer,
    technicalCaSignatureDer,
  };
}

function validateSecp256k1Spki(bytes: Uint8Array, spki: DerElement): void {
  const children = readChildren(bytes, spki, 'SubjectPublicKeyInfo');
  if (children.length !== 2) {
    throw new ZatcaInvoiceError(
      'ZATCA SubjectPublicKeyInfo must contain algorithm and public key.',
    );
  }
  const algorithm = children[0];
  const publicKey = children[1];
  if (algorithm === undefined || publicKey === undefined) {
    throw new ZatcaInvoiceError('ZATCA SubjectPublicKeyInfo is incomplete.');
  }
  requireTag(algorithm, DER_SEQUENCE, 'ZATCA public-key algorithm must be a DER SEQUENCE.');
  requireTag(publicKey, DER_BIT_STRING, 'ZATCA public key must be a DER BIT STRING.');

  const algorithmChildren = readChildren(bytes, algorithm, 'EC public-key algorithm');
  if (algorithmChildren.length !== 2) {
    throw new ZatcaInvoiceError('ZATCA EC public-key algorithm must explicitly name its curve.');
  }
  const algorithmOid = algorithmChildren[0];
  const curveOid = algorithmChildren[1];
  if (algorithmOid === undefined || curveOid === undefined) {
    throw new ZatcaInvoiceError('ZATCA EC public-key algorithm is incomplete.');
  }
  requireTag(algorithmOid, DER_OBJECT_IDENTIFIER, 'ZATCA public-key algorithm OID is missing.');
  requireTag(curveOid, DER_OBJECT_IDENTIFIER, 'ZATCA public-key curve OID is missing.');
  if (decodeOid(content(bytes, algorithmOid)) !== OID_EC_PUBLIC_KEY) {
    throw new ZatcaInvoiceError('ZATCA signing certificate public key is not id-ecPublicKey.');
  }
  if (decodeOid(content(bytes, curveOid)) !== OID_SECP256K1) {
    throw new ZatcaInvoiceError('ZATCA signing certificate public key is not secp256k1.');
  }

  const publicKeyContent = content(bytes, publicKey);
  if (
    publicKeyContent.length !== UNCOMPRESSED_SECP256K1_POINT_BYTES + 1 ||
    publicKeyContent[0] !== 0 ||
    publicKeyContent[1] !== 0x04
  ) {
    throw new ZatcaInvoiceError(
      'ZATCA secp256k1 SubjectPublicKeyInfo must contain one uncompressed 65-byte EC point.',
    );
  }
}

function validateEcdsaSignatureDerShape(signatureDer: Uint8Array): void {
  const signature = readDerElement(signatureDer, 0, 'certificate ECDSA signature');
  requireTag(signature, DER_SEQUENCE, 'Certificate ECDSA signature must be a DER SEQUENCE.');
  if (signature.end !== signatureDer.length) {
    throw new ZatcaInvoiceError('Certificate ECDSA signature contains trailing DER data.');
  }
  const scalars = readChildren(signatureDer, signature, 'certificate ECDSA signature');
  if (scalars.length !== 2) {
    throw new ZatcaInvoiceError(
      'Certificate ECDSA signature must contain exactly r and s INTEGERs.',
    );
  }
  for (const [index, scalar] of scalars.entries()) {
    if (scalar === undefined) {
      throw new ZatcaInvoiceError('Certificate ECDSA signature scalar is missing.');
    }
    requireTag(scalar, DER_INTEGER, 'Certificate ECDSA signature scalar must be a DER INTEGER.');
    const value = content(signatureDer, scalar);
    const label = index === 0 ? 'r' : 's';
    if (value.length === 0 || value.length > 33) {
      throw new ZatcaInvoiceError(`Certificate ECDSA ${label} scalar has invalid width.`);
    }
    if ((value[0] ?? 0) >= 0x80) {
      throw new ZatcaInvoiceError(`Certificate ECDSA ${label} scalar must not be negative.`);
    }
    if (value.length > 1 && value[0] === 0 && ((value[1] ?? 0) & 0x80) === 0) {
      throw new ZatcaInvoiceError(`Certificate ECDSA ${label} scalar has redundant DER padding.`);
    }
    if (value.every((byte) => byte === 0)) {
      throw new ZatcaInvoiceError(`Certificate ECDSA ${label} scalar must be non-zero.`);
    }
  }
}

function readAlgorithmOid(bytes: Uint8Array, algorithm: DerElement, label: string): string {
  const children = readChildren(bytes, algorithm, `${label} AlgorithmIdentifier`);
  const oid = children[0];
  if (oid === undefined) {
    throw new ZatcaInvoiceError(`ZATCA ${label} AlgorithmIdentifier is empty.`);
  }
  requireTag(oid, DER_OBJECT_IDENTIFIER, `ZATCA ${label} algorithm identifier is not an OID.`);
  return decodeOid(content(bytes, oid));
}

function readChildren(bytes: Uint8Array, parent: DerElement, label: string): DerElement[] {
  const children: DerElement[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = readDerElement(bytes, offset, label);
    if (child.end > parent.end) {
      throw new ZatcaInvoiceError(`${label} child extends beyond its DER container.`);
    }
    children.push(child);
    offset = child.end;
  }
  if (offset !== parent.end) {
    throw new ZatcaInvoiceError(`${label} DER children do not fill their container exactly.`);
  }
  return children;
}

function readDerElement(bytes: Uint8Array, offset: number, label: string): DerElement {
  const tag = bytes[offset];
  const firstLength = bytes[offset + 1];
  if (tag === undefined || firstLength === undefined) {
    throw new ZatcaInvoiceError(`${label} DER element is truncated.`);
  }

  let contentLength: number;
  let lengthOctets = 1;
  if (firstLength < 0x80) {
    contentLength = firstLength;
  } else {
    const count = firstLength & 0x7f;
    if (count === 0) {
      throw new ZatcaInvoiceError(`${label} uses forbidden indefinite DER length.`);
    }
    if (count > 4 || offset + 2 + count > bytes.length) {
      throw new ZatcaInvoiceError(`${label} DER length is unsupported or truncated.`);
    }
    if (bytes[offset + 2] === 0) {
      throw new ZatcaInvoiceError(`${label} DER length has redundant leading zeroes.`);
    }
    contentLength = 0;
    for (let index = 0; index < count; index += 1) {
      contentLength = contentLength * 256 + (bytes[offset + 2 + index] ?? 0);
    }
    if (contentLength < 0x80) {
      throw new ZatcaInvoiceError(`${label} DER length is not minimally encoded.`);
    }
    lengthOctets += count;
  }

  const contentStart = offset + 1 + lengthOctets;
  const end = contentStart + contentLength;
  if (!Number.isSafeInteger(end) || end > bytes.length || end <= offset) {
    throw new ZatcaInvoiceError(`${label} DER length exceeds the available bytes.`);
  }
  return { tag, start: offset, contentStart, contentLength, end };
}

function content(bytes: Uint8Array, element: DerElement): Uint8Array {
  return bytes.subarray(element.contentStart, element.end);
}

function requireTag(element: DerElement, expected: number, message: string): void {
  if (element.tag !== expected) {
    throw new ZatcaInvoiceError(message);
  }
}

function decodeOid(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    throw new ZatcaInvoiceError('DER object identifier must not be empty.');
  }

  const values: bigint[] = [];
  let value = 0n;
  let inComponent = false;
  for (const byte of bytes) {
    if (!inComponent && byte === 0x80) {
      throw new ZatcaInvoiceError('DER object identifier has a non-minimal component.');
    }
    inComponent = true;
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      values.push(value);
      value = 0n;
      inComponent = false;
    }
  }
  if (inComponent || values.length === 0) {
    throw new ZatcaInvoiceError('DER object identifier is truncated.');
  }

  const firstValue = values[0] ?? 0n;
  const firstArc = firstValue < 40n ? 0n : firstValue < 80n ? 1n : 2n;
  const secondArc = firstValue - firstArc * 40n;
  return [firstArc, secondArc, ...values.slice(1)].map(String).join('.');
}
