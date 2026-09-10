import type { TenantScope } from './persistence.js';

/**
 * ZATCA's current developer material labels the required curve as
 * "P-256 (secp256k1)". The explicit identifier prevents an adapter from
 * substituting NIST P-256 / secp256r1 / prime256v1, which is a different curve.
 */
export const ZATCA_SIGNING_CURVE = 'secp256k1' as const;
export type ZatcaSigningCurve = typeof ZATCA_SIGNING_CURVE;

/** The only signing profile Korvi permits for the ZATCA cryptographic stamp. */
export const ZATCA_SIGNING_ALGORITHM = 'ECDSA_SECP256K1_SHA256' as const;
export type ZatcaSigningAlgorithm = typeof ZATCA_SIGNING_ALGORITHM;

/** Fixed-width r || s used only by Korvi's strict DER/XMLDSIG conversion helpers. */
export const ZATCA_XMLDSIG_ECDSA_SIGNATURE_BYTES = 64 as const;

/**
 * Opaque reference to a signing key held by a compliant security module.
 *
 * There is intentionally no private-key byte field anywhere in this contract.
 * An adapter may map `provider` + `keyId` to an HSM, KMS or compliant software
 * security module, but the domain can never request the private material back.
 */
export interface ZatcaSigningKeyHandle {
  readonly provider: string;
  readonly keyId: string;
  readonly curve: ZatcaSigningCurve;
  readonly algorithm: ZatcaSigningAlgorithm;
  readonly exportable: false;
}

/** Public-only key description safe to cross the domain boundary. */
export interface ZatcaSigningKeyDescription {
  readonly handle: ZatcaSigningKeyHandle;
  /** DER SubjectPublicKeyInfo for the secp256k1 public key. Never private material. */
  readonly publicKeySpkiDer: Uint8Array;
  readonly createdAt: string;
}

/**
 * ZATCA CSR subject data for one EGS / solution unit.
 *
 * The key itself is not part of this value. `createPkcs10Csr` proves possession
 * by asking the security module to sign the request with the referenced key.
 */
export interface ZatcaCsrSubject {
  /** Unique solution-unit name or taxpayer asset-tracking number. */
  readonly commonName: string;
  /** `1-provider|2-model-or-version|3-serial-number`. */
  readonly egsSerialNumber: string;
  /** Taxpayer/group VAT registration number. */
  readonly organizationIdentifier: string;
  /** Branch name, or the required member TIN for a VAT group. */
  readonly organizationalUnitName: string;
  readonly organizationName: string;
  /** ISO 3166 alpha-2 country code. */
  readonly countryCode: string;
  /** Four 0/1 digits mapped to T,S,C,Z capabilities, e.g. `1100`. */
  readonly invoiceType: string;
  readonly location: string;
  readonly industry: string;
}

export interface GenerateZatcaSigningKeyInput {
  readonly scope: TenantScope;
  readonly terminalId: string;
  /** Stable, non-secret alias chosen by Korvi for provider-side lookup/audit. */
  readonly keyAlias: string;
  readonly at: string;
}

export interface CreateZatcaCsrInput {
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly key: ZatcaSigningKeyHandle;
  readonly subject: ZatcaCsrSubject;
}

export interface ZatcaSignInput {
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly key: ZatcaSigningKeyHandle;
  /**
   * Raw 32-byte SHA-256 invoice hash from the ZATCA invoice-reference transform.
   *
   * Fatoora's stamping profile signs this hash as the message using ECDSA with
   * SHA-256. The security module therefore performs the algorithm invocation;
   * callers never receive or export private-key material.
   */
  readonly message: Uint8Array;
}

/**
 * Security-module boundary for ZATCA signing.
 *
 * Implementations MUST create the key as non-exportable secp256k1 and MUST reject
 * a handle that resolves to an exportable, wrong-curve or wrong-algorithm key.
 */
export interface ZatcaSigningKeyPort {
  generateNonExportableKey(
    input: GenerateZatcaSigningKeyInput,
  ): Promise<ZatcaSigningKeyDescription>;

  describePublicKey(
    scope: TenantScope,
    terminalId: string,
    key: ZatcaSigningKeyHandle,
  ): Promise<ZatcaSigningKeyDescription>;

  /** Return a DER PKCS#10 CSR signed by the referenced private key. */
  createPkcs10Csr(input: CreateZatcaCsrInput): Promise<Uint8Array>;

  /**
   * Sign the raw invoice-hash bytes with ECDSA secp256k1/SHA-256 and return one
   * canonical ASN.1 DER ECDSA signature. Provider adapters MUST NOT return the
   * XMLDSIG fixed-width `r || s` form at this boundary.
   *
   * The sealing authority parses the DER strictly, checks scalar bounds, round-
   * trips it to canonical DER, self-verifies it against the CSID certificate and
   * only then writes its Base64 text into Fatoora XML and QR tag 7.
   */
  signSha256(input: ZatcaSignInput): Promise<Uint8Array>;
}

/**
 * Canonical XML boundary for the ZATCA cryptographic-stamp pipeline.
 *
 * The domain names the three regulatory byte sequences it needs, but deliberately
 * knows nothing about a DOM/parser/WASM implementation. Implementations MUST use
 * Canonical XML 1.1 without comments and MUST fail closed on malformed or
 * ambiguous signature structures.
 */
export interface ZatcaXmlCanonicalizationPort {
  /** Apply the ZATCA invoice-reference exclusions, then Canonical XML 1.1. */
  canonicalizeInvoiceReference(xml: string): Promise<Uint8Array>;

  /** Canonicalize the unique xades:SignedProperties target in its final XML context. */
  canonicalizeSignedProperties(xml: string): Promise<Uint8Array>;

  /** Canonicalize the unique ds:SignedInfo target in its final XML context. */
  canonicalizeSignedInfo(xml: string): Promise<Uint8Array>;
}
