import type { TenantScope } from './persistence.js';

/** The only signing profile Korvi permits for the ZATCA cryptographic stamp. */
export const ZATCA_SIGNING_ALGORITHM = 'ECDSA_P256_SHA256' as const;
export type ZatcaSigningAlgorithm = typeof ZATCA_SIGNING_ALGORITHM;

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
  readonly algorithm: ZatcaSigningAlgorithm;
  readonly exportable: false;
}

/** Public-only key description safe to cross the domain boundary. */
export interface ZatcaSigningKeyDescription {
  readonly handle: ZatcaSigningKeyHandle;
  /** DER SubjectPublicKeyInfo for the P-256 public key. Never private material. */
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
   * Bytes to be signed using ECDSA P-256 with SHA-256.
   *
   * For XAdES this is the canonicalised `ds:SignedInfo` byte sequence. The
   * security-module adapter owns the algorithm invocation; callers never hash
   * or export private-key material on its behalf.
   */
  readonly message: Uint8Array;
}

/**
 * Security-module boundary for ZATCA signing.
 *
 * Implementations MUST create the key as non-exportable and MUST reject a
 * handle that resolves to an exportable, wrong-curve or wrong-algorithm key.
 */
export interface ZatcaSigningKeyPort {
  generateNonExportableKey(input: GenerateZatcaSigningKeyInput): Promise<ZatcaSigningKeyDescription>;

  describePublicKey(
    scope: TenantScope,
    terminalId: string,
    key: ZatcaSigningKeyHandle,
  ): Promise<ZatcaSigningKeyDescription>;

  /** Return a DER PKCS#10 CSR signed by the referenced private key. */
  createPkcs10Csr(input: CreateZatcaCsrInput): Promise<Uint8Array>;

  /** Return only the ECDSA signature; never the private key or activation data. */
  signSha256(input: ZatcaSignInput): Promise<Uint8Array>;
}
