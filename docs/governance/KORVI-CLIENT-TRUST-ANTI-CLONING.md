# KORVI — Client Trust, Anti-Cloning & Intellectual-Property Defense

Status: **ACCEPTED SECURITY / PRODUCT ARCHITECTURE DOCTRINE**
Authority: installed-client trust, product-boundary, licensing, anti-cloning and intellectual-property defense.

## 1. Executive intent

Korvi must remain commercially valuable even if an attacker obtains, copies, inspects, reverse-engineers or modifies a distributed cashier binary.

The core rule is:

> **STOLEN CLIENT ≠ STOLEN PRODUCT**

Possession of a Korvi Cashier EXE/MSIX/MSI/APK/AAB or its local files must not be sufficient to recreate, rebrand and sell a functioning independent Korvi platform.

The goal is not the impossible promise that client code can never be reverse-engineered. Any code delivered to a customer-controlled device can eventually be inspected by a determined attacker. The security target is instead to make a copied binary commercially incomplete, operationally constrained and cryptographically unable to impersonate Korvi Cloud authority.

## 2. Product-surface separation

Korvi is intentionally split into three security surfaces.

### A. Korvi Cashier — installed client

Targets:
- Windows POS devices.
- Android POS devices/tablets.

Purpose:
- high-speed cashier workflow;
- barcode/search/cart/checkout;
- supported offline sales;
- shift operation;
- approved printing/device interaction;
- durable local queue and later synchronization.

The installed cashier must not contain ordinary merchant-management or platform-administration products merely hidden behind UI flags.

### B. Korvi Control — merchant management web

Targets:
- owner/manager/accountant/warehouse/purchasing users;
- responsive web access from phone, tablet or computer.

Purpose:
- merchant administration;
- products/pricing/customers/inventory/purchasing;
- reports;
- employees/roles/permissions;
- branches/devices;
- settings/ZATCA/commercial account views.

This remains cloud-authenticated and server-authoritative.

### C. Korvi Platform Admin — platform-operator web

Purpose:
- Korvi customer/tenant lifecycle;
- plans/entitlements;
- owner bootstrap;
- branch/device/customer provisioning;
- suspension/reactivation;
- support/health/compliance visibility.

Platform Admin is never shipped as cashier-client code and never reachable through merchant authorization.

## 3. Thin valuable client, thick protected platform

The cashier contains only what is necessary to continue authorized branch operations when WAN internet is unavailable.

The following high-value platform capabilities should remain cloud-side whenever technically and operationally appropriate:

- tenant/customer provisioning authority;
- plan/subscription issuance;
- device enrollment authority;
- license issuance/revocation;
- Platform Admin;
- merchant-management control plane;
- central reporting and cross-branch analytics;
- global configuration and entitlement authority;
- managed ZATCA lifecycle/state beyond required offline facts;
- support operations;
- Command Center/Guardian services;
- Product Knowledge and other shared intelligence;
- update/release authority;
- central integration credentials and provider secrets.

Offline requirements may justify local copies of facts or deterministic rules required for selling, but those copies do not become cloud authority.

## 4. No reusable platform secrets in the client

Installed binaries and local stores must never contain reusable Korvi platform secrets such as:

- server database credentials;
- production API master keys;
- tenant-creation credentials;
- global signing keys;
- ZATCA platform-side secrets that do not belong on that specific authorized device;
- HSM/private infrastructure material;
- persistent support/admin credentials;
- source-control tokens;
- provider master credentials.

Anything that must exist locally is scoped to the minimum device/tenant/branch purpose and treated as compromisable client-side material.

## 5. Device identity and enrollment

Every installed cashier device receives a distinct Korvi device identity through an authenticated enrollment process.

The identity must be bound to relevant facts such as:

- tenant;
- branch;
- terminal/register;
- device installation;
- permitted application/build family;
- commercial entitlement state.

Where supported, the device generates a private key locally and stores it using OS-backed key protection:

- Windows platform protection / TPM-backed storage where available and justified;
- Android Keystore / StrongBox where available.

Private device keys should not be exportable through ordinary application APIs.

The server stores only the public/verification material needed to recognize the enrolled device.

A copied local database or copied application directory must not automatically become an enrolled second terminal.

## 6. Signed device license / offline lease

Korvi Cashier must not require permanent internet merely to prove it is licensed. Instead, Korvi may issue a signed, bounded offline license/lease containing the minimum necessary claims, for example:

- tenant ID/code;
- branch ID;
- terminal/device ID;
- plan/entitlement version;
- allowed offline capability profile;
- issued-at / not-before / expiry timestamps;
- minimum/maximum client version where applicable;
- cryptographic signature from Korvi licensing authority.

The client verifies the signature locally using embedded public verification material, never a private platform signing key.

The lease duration must balance field continuity with revocation risk. A merchant may be allowed to operate offline for days/weeks according to product policy, while the device renews the lease when internet becomes available.

Expiration/revocation behavior must be deterministic, user-visible and commercially correct. It must not corrupt or discard already-recorded legitimate operations.

## 7. Server-side authority survives client tampering

All server APIs remain hostile-client safe.

Changing JavaScript, patching an APK, editing local files or forging UI state must not allow a user to:

- create arbitrary tenants;
- self-issue plans/entitlements;
- become Platform Admin;
- access another tenant;
- issue device licenses;
- alter finalized financial history;
- bypass server-side RBAC/RLS;
- submit duplicated financial operations as new facts;
- write arbitrary stock/cost truth;
- obtain cloud secrets.

Server-side validation, tenant isolation, RBAC, idempotency, signed device identity and audited platform authority remain decisive even if the client is modified.

## 8. Local database protection

The local cashier store is an operational cache/journal, not an independently transferable Korvi server.

Protection goals:

- encryption at rest where practical;
- encryption key protected through OS-backed device storage;
- partition binding to tenant/branch/terminal/device identity;
- schema/version binding;
- integrity/tamper detection for critical metadata/queued envelopes where appropriate;
- refusal to reuse a store under a mismatched identity;
- no plaintext platform secrets;
- no silent downgrade to an old schema that could reinterpret financial operations.

Copying the local DB to another machine must not yield a ready-to-sell independent POS installation.

## 9. Application signing and release authenticity

Official Korvi client releases must be cryptographically signed through the applicable platform distribution/signing mechanism.

Release requirements include:

- official Windows package signing;
- official Android package signing;
- controlled certificate/key custody;
- versioned release identity;
- update authenticity verification;
- refusal of unsigned/untrusted update packages;
- rollback policy that does not reinterpret newer local data incorrectly;
- release artifacts tied to exact source/build evidence.

Signing proves release authenticity; it is not by itself anti-cloning protection.

### 9.1 Private/direct distribution policy

Official Korvi Cashier is a controlled business client, not a publicly discoverable consumer application.

Korvi Cashier for Windows and Android must therefore be distributed through Korvi-controlled private/direct channels to authorized customers/devices rather than published publicly through consumer app stores such as Google Play or Microsoft Store.

Permitted delivery patterns include:

- authenticated customer-specific download links;
- operator-assisted installation by Korvi or an authorized partner;
- controlled private deployment channels;
- signed package delivery tied to an approved tenant/device enrollment;
- signed Korvi-managed update delivery after installation.

Private distribution does **not** weaken release authenticity requirements. Every official package/update must still be signed, versioned, attributable to exact source/build evidence and reject untrusted/unsigned updates according to platform capability.

Public obscurity is not treated as a security boundary. Possession of a direct APK/installer URL must never itself confer tenant, terminal, license or cloud authority. Permanent unauthenticated download links and shared reusable enrollment secrets are not acceptable substitutes for controlled distribution and device trust.

## 10. Reverse-engineering cost controls

Korvi may use defense-in-depth measures to increase the cost of casual copying/rebranding, including:

- production minification/optimization;
- removal of development/debug tooling;
- no public production source maps unless deliberately access-controlled;
- package obfuscation where compatible with maintainability/supportability;
- symbol stripping where applicable;
- integrity checks for selected high-value runtime assets;
- anti-debug/tamper telemetry where lawful and technically reliable;
- reproducible build/version metadata and watermarking/provenance signals where useful.

These controls are secondary. They must never be treated as a replacement for server-side authorization, licensing boundaries or the thin-client/platform split.

Anti-tamper features must not create fragile false positives that stop legitimate stores from operating without a safe recovery path.

## 11. Commercial anti-cloning principle

A stolen/rebranded cashier binary should lack enough surrounding authority that a low-effort clone cannot credibly offer “Korvi under another name”.

A clone should still be missing, at minimum, meaningful combinations of:

- customer/tenant lifecycle;
- cloud account authority;
- license/device issuance;
- official sync service compatibility;
- merchant administration;
- Platform Admin;
- cross-branch operations;
- protected integrations;
- central analytics/reporting;
- ZATCA managed lifecycle;
- signed updates;
- support/operations;
- advanced Korvi intelligence/product-knowledge services.

The commercial defense is architectural: the distributed binary is not the whole product.

## 12. Offline mode and anti-cloning are compatible

Offline-first does not require shipping the entire platform.

The device receives only the data/rules needed for the declared offline cashier capability set, such as:

- permitted catalogue/search subset;
- barcode mappings;
- price/VAT/product snapshots needed to sell;
- branch/terminal configuration;
- authorized session/offline grant state;
- active shift facts;
- sale drafts;
- operation queue;
- synchronization state;
- locally renderable receipt/invoice facts where permitted.

When WAN returns, the cloud remains the authority for synchronization acceptance, central history, cross-branch truth, licensing and management.

## 13. Stolen / compromised device response

Korvi must support an auditable device-response path including:

- revoke/disable device enrollment;
- stop future lease renewal;
- invalidate relevant sessions/tokens;
- prevent a cloned installation from enrolling as the same terminal without reauthorization;
- preserve already-legitimate unsynchronized operations through a controlled recovery process where possible;
- alert/operator visibility for suspicious duplicate-device identity or impossible synchronization behavior;
- forensic identifiers/audit records that avoid exposing customer secrets.

## 14. Legal / operational defense in depth

Technical architecture is primary, but commercial protection may also include:

- clear proprietary licensing terms;
- trademark/brand protection;
- copyright notices and ownership records;
- controlled signing certificates;
- build provenance;
- customer agreements prohibiting unauthorized redistribution/reverse engineering where enforceable;
- documented takedown/evidence process for copied distributions.

Legal terms never replace technical boundaries.

## 15. Verification gates

Before anti-cloning/client-integrity can be called production-grade, evidence should include:

1. unpack/install an official client on a clean device and prove no reusable server/admin secrets are present;
2. attempt to call Platform/Merchant Admin APIs using cashier authorization and prove denial;
3. copy local state to another device and prove it cannot silently become a valid enrolled terminal;
4. patch obvious client-side role/plan/UI flags and prove server authority still refuses escalation;
5. replay queued financial operations and prove idempotency;
6. attempt duplicate device identity and prove fencing/revocation policy;
7. prove unsigned update rejection;
8. prove lease expiry/renewal/revocation behavior during long offline operation;
9. prove a revoked device cannot regain cloud authority merely by restoring old local files;
10. verify release packages contain no production source maps/debug endpoints/secrets not explicitly justified.

## 16. Non-goals / honesty rule

Korvi must never claim “unhackable” or “impossible to reverse engineer”.

The accepted objective is:

- very high practical resistance;
- no single client artifact contains the full platform;
- copied binaries do not carry cloud authority;
- unauthorized rebranding requires substantial independent engineering rather than trivial reskinning;
- customer and platform security remains intact even under a hostile modified client.

## 17. Relationship to other governance sources

This doctrine extends and must be read with:

- `KORVI-MASTER-PRODUCT-DIRECTIVE.md`
- `KORVI-CAPABILITY-MATRIX.md`
- `KORVI-ARCHITECTURE-MAP.md`
- `KORVI-RELEASE-GATES.md`
- `KORVI-ROADMAP.md`

Where a client-packaging convenience conflicts with this doctrine or with financial/security/offline invariants, the invariant wins.
