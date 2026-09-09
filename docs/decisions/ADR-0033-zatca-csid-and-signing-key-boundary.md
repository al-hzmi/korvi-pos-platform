# ADR-0033 — ZATCA CSID and signing-key security boundary

- Status: Accepted
- Date: 2026-09-10
- Scope: ZATCA Phase 2 Gate 39 key generation, CSR, CSID and signing authority
- Depends on: ADR-0032

## Context

Gate 38 ends at deterministic compliant UBL/canonicalisation/hash authority. Gate 39 adds the security material that turns the unsigned simplified invoice into a sealed Phase 2 artifact.

The currently published ZATCA Security Features Implementation Standards v1.2 require, among other things:

- the signing key pair to be generated according to FIPS 186 and validated as an ECC key pair;
- signing keys to be marked non-exportable so they cannot leave the security module where they were generated;
- hardware or software security modules to be acceptable only when those requirements are met;
- PKCS#10 CSR generation including at least the certificate CN and public key, signed with the private key as proof-of-possession;
- ECDSA with SHA-256 using the curve ZATCA's current Developer Portal manual explicitly labels **P-256 (secp256k1)**;
- an enveloped XAdES signature at baseline level B-B for XML invoices;
- certificate validity/revocation checking before a certificate is used for stamping;
- a ZATCA-issued certificate/CSID associated with the signing key pair;
- secure storage of the FATOORA API secret issued alongside the credential.

ZATCA's use of the label `P-256` is not treated by Korvi as the generic/NIST curve name. The Developer Portal manual resolves it to **secp256k1**. An implementation MUST NOT substitute NIST P-256 / `secp256r1` / `prime256v1`; those are different curves.

Official references:

- ZATCA Security Requirements: https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/Pages/Security-Requirements.aspx
- Security Features Implementation Standards v1.2 (19 May 2023): https://www.zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf
- Developer Portal User Manual: https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Documents/Developer%20Portal%20User%20Manual.pdf
- Developer Portal: https://sandbox.zatca.gov.sa/

The existing `terminals` table identifies an EGS-like Korvi device by tenant, branch, terminal code and optional device key. It has no private-key, CSID-secret or PEM fields. That is the correct starting point: relational persistence is not the security module.

## Decision

### 1. A ZATCA private key is never a domain value

Korvi code outside the signing adapter may hold only an opaque `ZatcaSigningKeyHandle`. The port has no method that exports the private key, private scalar, PKCS#8, JWK `d`, PEM or activation data.

The signing adapter MUST reject keys that are exportable, use the wrong curve or do not satisfy the configured ZATCA signing profile.

### 2. Private keys live in a security module, not PostgreSQL or browser storage

The implementation may use an approved hardware-backed provider or a software security module only when it can enforce the published non-exportability and protection requirements.

Forbidden production storage locations for raw ZATCA private-key material include:

- Prisma/PostgreSQL columns;
- browser localStorage, IndexedDB or Service Worker caches;
- environment variables containing PKCS#8/PEM private keys;
- GitHub Actions secrets used as long-lived merchant private keys;
- logs, audit-event payloads or application telemetry;
- receipt/QR payloads.

A database row may later retain a non-secret provider/key identifier so the correct security-module key can be addressed, but not the key bytes.

### 3. Terminal identity and key identity are separate

A terminal is merchant configuration and operational identity. A signing key is security-module state. A terminal may acquire a replacement key/CSID during renewal or compromise handling without changing the terminal primary key.

Any future database model for CSID bindings must therefore reference the terminal and preserve historical credential identity rather than adding mutable certificate/key columns directly to `terminals`.

### 4. Key generation and CSR are security-module operations

`ZatcaSigningKeyPort.generateNonExportableKey` creates an ECDSA **secp256k1** key in the provider and returns only public metadata plus an opaque handle. The API contract carries the curve identifier explicitly; the ambiguous generic `P-256` label is not accepted at the adapter boundary.

`createPkcs10Csr` receives validated CSR identity facts and a key handle. The adapter constructs a PKCS#10 request and obtains proof-of-possession from the security module. The private key never crosses the port.

CSR facts must be sourced from authoritative merchant/device configuration. Korvi must not invent a VAT number, branch identity, EGS serial, location, industry or invoice-type capability merely to complete onboarding.

### 5. The domain validates the stable CSR facts it knows

The pure `zatcaCsrSubject` authority validates the published stable shapes before the signing provider is called:

- organization identifier: 15-digit VAT number beginning and ending in `3`;
- EGS serial: `1-provider|2-model-or-version|3-serial-number`;
- country: ISO 3166 alpha-2;
- invoice type: four binary digits mapped to T,S,C,Z with at least one enabled capability;
- required identity fields are non-empty.

Provider-specific ASN.1 encoding remains the signing adapter's responsibility.

### 6. Signing is message-in/signature-out

The domain supplies bytes to `signSha256`; the security module applies ECDSA **secp256k1** with SHA-256 and returns the signature only. For XAdES, those input bytes are the canonicalised `ds:SignedInfo` bytes, whose references bind the invoice digest and the signed-properties digest.

This follows the current Security Features Implementation Standards' XAdES/XMLDSIG structure. The older detailed signing walkthrough describes the operation more loosely as signing the generated invoice hash; Korvi does not collapse XMLDSIG `SignedInfo` signing into a raw-digest shortcut unless the current official validator proves that requirement.

No caller may ask the provider to return the private key so it can sign locally.

### 7. Certificate and API-secret lifecycle remain fail-closed

Gate 39 is not closed by a generated key or a syntactically valid CSR. The production CSID binding still requires:

- ZATCA-issued certificate material tied to the generated key;
- validity-window checking;
- CRL/OCSP revocation policy satisfying the published requirements;
- secure handling of the FATOORA authentication secret;
- renewal/revocation transitions that cannot silently continue with an invalid credential;
- official validation of the final sealed invoice.

A missing/expired/revoked/unknown credential blocks stamping. There is no fallback dummy certificate, local self-signed production certificate or unsigned customer receipt presented as Phase 2 compliant.

### 8. QR and signing layers consume public/derived material only

The Phase 2 QR builder accepts byte material already derived by the validated sealing path: invoice hash, XML signature, public key representation and ZATCA technical-CA signature. It cannot access the signing key.

This keeps receipt rendering and QR generation deterministic and prevents a printer/browser path from becoming a cryptographic key holder.

## Consequences

- A database leak alone cannot disclose raw ZATCA private keys by design.
- A browser compromise does not gain a private key merely because the cashier UI can print a QR code.
- Key rotation/CSID renewal can preserve historical invoice evidence instead of overwriting device identity.
- Provider choice remains replaceable behind the port, but only providers capable of enforcing non-exportability and the exact secp256k1 profile are eligible for production.
- Gate 39 remains OPEN until the concrete provider, CSID lifecycle, XAdES B-B seal, QR tags 6-9 and official sealed-invoice validation are all proven.
