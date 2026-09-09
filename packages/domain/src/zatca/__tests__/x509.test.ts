import { describe, expect, it } from 'vitest';
import { ZatcaInvoiceError } from '../phase2.js';
import { extractZatcaSigningCertificateMaterial } from '../x509.js';

const OID_ECDSA_SHA256 = Uint8Array.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
const OID_ECDSA_SHA384 = Uint8Array.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03]);
const OID_EC_PUBLIC_KEY = Uint8Array.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const OID_SECP256K1 = Uint8Array.from([0x2b, 0x81, 0x04, 0x00, 0x0a]);
const OID_SECP256R1 = Uint8Array.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  if (length <= 0xff) return Uint8Array.of(0x81, length);
  return Uint8Array.of(0x82, length >>> 8, length & 0xff);
}

function der(tag: number, ...parts: readonly Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  return concat(Uint8Array.of(tag), derLength(body.length), body);
}

function oid(value: Uint8Array): Uint8Array {
  return der(0x06, value);
}

function algorithm(identifier: Uint8Array): Uint8Array {
  return der(0x30, oid(identifier));
}

function spki(curve = OID_SECP256K1, pointFill = 0x11): Uint8Array {
  const point = new Uint8Array(65).fill(pointFill);
  point[0] = 0x04;
  return der(
    0x30,
    der(0x30, oid(OID_EC_PUBLIC_KEY), oid(curve)),
    der(0x03, Uint8Array.of(0), point),
  );
}

function ecdsaSignature(): Uint8Array {
  return der(0x30, der(0x02, Uint8Array.of(1)), der(0x02, Uint8Array.of(2)));
}

function certificate(
  options: {
    curve?: Uint8Array;
    outerSignatureAlgorithm?: Uint8Array;
    tbsSignatureAlgorithm?: Uint8Array;
    unusedSignatureBits?: number;
  } = {},
): { certificateDer: Uint8Array; publicKeySpkiDer: Uint8Array; caSignatureDer: Uint8Array } {
  const publicKeySpkiDer = spki(options.curve);
  const tbsAlgorithm = algorithm(options.tbsSignatureAlgorithm ?? OID_ECDSA_SHA256);
  const outerAlgorithm = algorithm(options.outerSignatureAlgorithm ?? OID_ECDSA_SHA256);
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Uint8Array.of(2))),
    der(0x02, Uint8Array.of(1)),
    tbsAlgorithm,
    der(0x30),
    der(0x30),
    der(0x30),
    publicKeySpkiDer,
  );
  const caSignatureDer = ecdsaSignature();
  return {
    certificateDer: der(
      0x30,
      tbs,
      outerAlgorithm,
      der(0x03, Uint8Array.of(options.unusedSignatureBits ?? 0), caSignatureDer),
    ),
    publicKeySpkiDer,
    caSignatureDer,
  };
}

describe('ZATCA signing certificate DER material', () => {
  it('extracts the exact secp256k1 SPKI and technical-CA signature defensively', () => {
    const fixture = certificate();
    const result = extractZatcaSigningCertificateMaterial(fixture.certificateDer);

    expect(result.signingPublicKeySpkiDer).toEqual(fixture.publicKeySpkiDer);
    expect(result.technicalCaSignatureDer).toEqual(fixture.caSignatureDer);

    result.signingPublicKeySpkiDer[0] = 0;
    result.technicalCaSignatureDer[0] = 0;
    expect(fixture.publicKeySpkiDer[0]).toBe(0x30);
    expect(fixture.caSignatureDer[0]).toBe(0x30);
  });

  it('refuses secp256r1 even though it is also commonly called P-256', () => {
    const fixture = certificate({ curve: OID_SECP256R1 });
    expect(() => extractZatcaSigningCertificateMaterial(fixture.certificateDer)).toThrow(
      /not secp256k1/,
    );
  });

  it('refuses a certificate whose TBS and outer signature algorithms differ', () => {
    const fixture = certificate({ outerSignatureAlgorithm: OID_ECDSA_SHA384 });
    expect(() => extractZatcaSigningCertificateMaterial(fixture.certificateDer)).toThrow(
      /ECDSA with SHA-256/,
    );

    const mismatch = certificate({ tbsSignatureAlgorithm: OID_ECDSA_SHA384 });
    expect(() => extractZatcaSigningCertificateMaterial(mismatch.certificateDer)).toThrow(
      /do not match/,
    );
  });

  it('refuses a certificate signature BIT STRING with non-zero unused bits', () => {
    const fixture = certificate({ unusedSignatureBits: 1 });
    expect(() => extractZatcaSigningCertificateMaterial(fixture.certificateDer)).toThrow(
      /zero unused bits/,
    );
  });

  it('refuses trailing or malformed DER instead of accepting a prefix', () => {
    const fixture = certificate();
    expect(() =>
      extractZatcaSigningCertificateMaterial(concat(fixture.certificateDer, Uint8Array.of(0))),
    ).toThrow(/trailing DER data/);
    expect(() => extractZatcaSigningCertificateMaterial(Uint8Array.from([0x30, 0x80]))).toThrow(
      ZatcaInvoiceError,
    );
  });
});
