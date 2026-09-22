# KORVI — Production ZATCA Operations Guide

Status: **AR-5 INTERNAL PATH READY / EXTERNAL ACTIVATION OPEN**
Created: 2026-09-22

Production remains fail-closed. The staging simulation provider is never
production evidence and must never be enabled in production.

## 1. Production authority chain

```text
finalized Korvi invoice truth
 -> fiscalization reservation
 -> canonical UBL / invoice hash
 -> tenant + terminal CSID binding
 -> non-exportable secp256k1 signing key
 -> XAdES / QR 6-9 sealing
 -> durable submission/reporting queue
 -> FATOORA transport
 -> accepted/rejected/ambiguous state
 -> reconciliation / retry
```

No browser/client supplies tax totals, private signing material, CSID plaintext
credentials or accepted external status.

## 2. Signing/key custody

The production fiscalization composition requires:

- `AZURE_KEY_VAULT_NAME`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `ZATCA_TRUST_ANCHOR_SHA256_HEX`

The Azure adapter requires a versioned secp256k1/P-256K key handle, enabled,
non-exportable, with signing authority and no returned private `d` material.
Keys are tagged to Korvi tenant + terminal authority.

For production closure, use an Azure tier/topology that genuinely supplies the
required protected non-exportable signing semantics and preserve provider proof.
Do not claim HSM custody from a mocked or software-only test.

## 3. Production CSID/FATOORA credential vault

Plain Production-CSID credentials must not be persisted unencrypted or returned
to HTTP/browser callers. The process-secret boundary uses:

- `ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID`
- `ZATCA_FATOORA_VAULT_KEYS`

The keyring stays outside PostgreSQL. Rotation adds a new key id, makes it
active for new writes, retains required previous decryption keys during the
rotation window, and removes old keys only after stored ciphertext no longer
depends on them.

Never print this keyring or put it in GitHub artifacts.

## 4. Merchant/terminal lifecycle

Production activation is per real merchant/terminal identity:

1. verify legal merchant/ZATCA identity and required onboarding data;
2. create/bind the protected signing key for that tenant + terminal;
3. generate the required CSR through the protected key authority;
4. complete compliance-CSID flow as required;
5. complete production-CSID issuance/binding;
6. store FATOORA credentials only through the encrypted credential store;
7. verify certificate chain/trust anchors and binding;
8. run a controlled production invoice/reporting validation;
9. record evidence without merchant secrets or private material.

Staging/simulation CSIDs cannot be promoted into production.

## 5. Checkout behavior

Production checkout composes the real fiscalization provider lazily at the
fiscalization boundary. Read-only dashboard/terminal routes do not require Azure
provider availability.

When production checkout reaches fiscalization and required provider
configuration is missing or invalid, the operation fails closed. Do not add a
production fallback to simulation and do not stamp a synthetic success.

## 6. Reporting, retry and reconciliation

Submission infrastructure owns durable reservation/claim, HTTP transport,
ambiguity and reconciliation semantics. A network timeout is not proof of
external failure and must not cause uncontrolled duplicate reporting.

Operational handling:
- preserve internal invoice/submission identifiers and request correlation;
- classify accepted, rejected and ambiguous outcomes;
- retry only through the durable submission authority;
- reconcile ambiguous records against FATOORA/provider truth before declaring
  final state;
- never edit finalized invoice/hash/signature facts to make a rejected
  submission pass.

## 7. Monitoring and incident response

Alert on:
- repeated fiscalization/provider failures;
- growing submission backlog;
- ambiguous submissions older than the operational threshold;
- credential/certificate expiry windows;
- key-vault authentication/sign failures;
- reconciliation failures.

Treat suspected signing-key/credential compromise as a security incident:
preserve evidence, stop affected issuance if required, rotate/revoke through
provider/ZATCA procedures and never copy private material into support channels.

## 8. External activation gate

AR-5 remains OPEN until real production evidence exists for:
- merchant identity/credentials;
- production certificate/CSID lifecycle;
- protected non-exportable signing key custody and remote sign/verify;
- production reporting/reconciliation;
- provider availability/operations;
- proof that simulation cannot run in production.

Existing unit, PostgreSQL, cryptographic, official-validator and staging
simulation evidence remains valuable engineering evidence, but it is not
Production ZATCA closure.
