# KORVI POS — Architecture Map

Status: **TARGET ARCHITECTURE + CURRENT BOUNDARIES**

## 1. Platform layering

```text
Korvi Cashier — Windows ─┐
Korvi Cashier — Android ─┼── shared cashier UI/runtime ── packages/ui
                         │            │
                         │            ├── local durable store / offline queue
                         │            └── device / printer / scanner adapters
                         │
Korvi Control Web ───────┼── merchant management surfaces
Korvi Platform Admin Web ┘── platform-operator surfaces
                                      │
apps/api ─────────────────────────────┼── packages/database ───┐
                                      ├── packages/printing ────┼── packages/domain
                                      └── packages/testing      │
packages/config ────────────────────────────────────────────────┘
```

`@korvi/domain` is the pure authority for deterministic financial/business rules and depends on no UI framework. Apps orchestrate. Database adapters persist authoritative server state. Printing converts approved invoice/receipt facts to device output. UI renders and collects intent; it does not invent business truth.

Installed client packaging must reuse the existing trusted client/domain contracts rather than fork a separate Windows or Android business engine. Packaging technology is an implementation choice and may evolve, but the authority boundaries below are mandatory.

## 2. Official client-surface split

Korvi intentionally separates customer surfaces by operational purpose and attack surface.

### Korvi Cashier — installed only as the primary till product

Targets:
- Windows POS hardware.
- Android POS hardware/tablets.

Contains only the code and local data required for cashier operation, approved device interaction and declared offline capabilities.

It must not ship the full merchant-management or Platform Admin product merely hidden behind UI flags.

### Korvi Control — merchant management web

Responsive web application for owner, manager, accountant, warehouse and purchasing users from phone/tablet/computer.

Owns management experiences such as products, customers, inventory, purchasing, reports, employees, branches/devices, settings and ZATCA operational views while continuing to rely on server-side authority.

### Korvi Platform Admin — platform-operator web

Separated highest-authority surface for Korvi customer/tenant provisioning, commercial state, owner bootstrap, device enrollment and support/health functions.

Merchant authority can never escalate into Platform authority.

## 3. Authority map

| Truth | Authority | Never authoritative |
|---|---|---|
| Money/tax/allocation | Domain | browser/native display formatting, floating-point UI arithmetic |
| Final sale/return/shift snapshot | Transactional server DB through domain ports; offline intent reconciles into this authority | client reconstruction after the fact |
| Tenant identity | Authenticated server context/RLS + bounded installed-client partition identity | request-supplied tenantId as authority |
| Actor identity/permissions | Session/RBAC and bounded offline authorization state | client role/user fields |
| Inventory | One stock movement/ledger authority | UI counters, catalogue flags, or isolated-device assumptions |
| Cost | One costing authority with explicit unknown provenance | guessed zero or current product cost rewriting history |
| Promotions | Deterministic domain decision + sale snapshot | current rule after sale |
| Payment | Tender domain + PSP adapter reference | raw card data |
| Regulatory state | Compliance workflow/gate | QR presence alone or “queued” displayed as externally accepted |
| Platform authority | Platform Admin identity/permission boundary | merchant owner/admin role |
| Device enrollment/license | Korvi Cloud licensing/enrollment authority | local UI flags or copied client files |
| Local offline state | Bounded installed-client durable store for declared offline capabilities | a second independent financial/stock system |

## 4. Bounded domains

### Transaction Core
Catalogue read → cart/pricing → tender → checkout intent → immutable sale → return/refund → drawer → close/reconciliation. C0 mutations are idempotent, tenant-scoped, audited where applicable and transactionally atomic.

### SaaS Control Plane / Platform Admin
Tenant lifecycle, plan/entitlement assignment, branch/terminal/user administration, settings, onboarding, safe suspension/reactivation, initial-owner bootstrap, device enrollment/license issuance and operational account state.

It owns **who may operate Korvi, under which tenant/commercial/device state, and how a merchant is provisioned**. It does not own sale arithmetic.

Required supported administrative chain:

```text
Platform Admin
  → create tenant/business
  → assign commercial plan/entitlements
  → create/bootstrap initial owner through safe one-time authority
  → create/activate branch
  → create/register/enroll terminal/device
  → expose tenant code/login facts safely
  → merchant owner sign-in
  → merchant configuration/onboarding
  → cashier operation
```

Direct database intervention is not an acceptable normal customer-provisioning path.

### Merchant Administration
Merchant dashboard, sales, catalogue, customers, inventory, purchasing, branches, devices/registers, employees, roles/permissions, reports, settings and ZATCA operations. Merchant authority remains tenant-scoped and cannot escalate to Platform authority.

### Inventory / Purchasing / Costing
One stock truth and one costing foundation. Sales, returns, receiving, adjustments, transfers, counts, restaurant ingredient consumption and future omnichannel effects all post causally identifiable movements through the same authority.

### Retail / Grocery Vertical
High-throughput barcode/search workflows, weighted/scale-aware selling, packaging/unit relationships, price-list selection, labels where justified, batch/expiry, replenishment and branch-aware stock. The vertical may optimize UI aggressively but may not create a second transaction or inventory authority.

### Restaurant / Cafe Vertical
Menu/categories, modifiers, dining modes, tables/zones, kitchen routing/KDS, waiter flows, status displays, kiosk, QR/order/pay, online ordering, delivery adapters, recipes/ingredient consumption and waste. Restaurant records specialize workflow on top of the same tenant, transaction, inventory, costing and audit truths.

### Customer / Loyalty / Promotions
Customer identity/history/segmentation, explicit-value ledgers for loyalty/credit/gift instruments, and deterministic promotion decisions with eligibility/priority/exclusivity/stacking/allocation/refund snapshots and explainability.

### Compliance
Immutable invoice facts → canonical regulatory representation → signing/security artifacts → submission/reporting/clearance state → retry/failure/reconciliation → evidence. Compliance consumes transaction truth but remains isolated from generic checkout implementation.

### Integrations
Adapter boundary around PSPs, ecommerce, delivery, future ERP/accounting and external services. External identities/mappings are explicit. Integrations cannot mutate finalized internal truth except through governed compensating business operations.

### Analytics / Command Center / Intelligence
Reports and command-center views consume authoritative facts. Recommendations and anomaly signals are evidence-backed and explainable. AI/ML may assist but cannot become money/tax/stock/ZATCA authority.

### Product Knowledge
Shared/national product knowledge is separate from tenant catalogue/stock. Provenance, confidence, source/version and merchant override rules are first-class. A text-first grocery knowledge layer is acceptable when it materially improves throughput and storage/maintenance efficiency.

### Supply Network
Seed supplier identity/mapping/event seams only after merchant supplier/purchasing truth is stable. Network marketplace/B2B ordering is later and must not distort core purchasing authority.

## 5. Installed Korvi Cashier boundary

Windows and Android are official installed cashier targets.

The installed layer owns only client-runtime responsibilities:

- bundling/loading the trusted cashier UI shell without WAN dependency;
- durable local storage for declared offline capability state;
- secure device identity/partition binding;
- validation of signed offline license/lease state;
- safe OS/device adapters such as printing/scanner/storage/update channels;
- process lifecycle/restart handling;
- version/schema migration of local runtime stores;
- observability/diagnostics appropriate to a merchant till.

The installed wrapper must **not** fork pricing, VAT, inventory, returns, costing, authorization or regulatory truth into a platform-specific implementation.

It must also not embed ordinary merchant-management or Platform Admin code merely for convenience. Administration remains web/cloud based unless an explicit later product decision approves a bounded installed management capability.

## 6. Client trust / anti-cloning boundary

The governing rule is:

> **STOLEN CLIENT ≠ STOLEN PRODUCT**

Client code must be treated as inspectable/hostile. Possession or modification of a cashier binary must not grant Korvi Cloud authority.

Required architectural consequences:

- no reusable server/database/platform secrets inside the installed client;
- unique device enrollment;
- tenant + branch + terminal + installation binding;
- locally generated device key protected by OS-backed secure storage where available;
- signed, bounded offline license/lease verifiable with public material only;
- Platform Admin, customer provisioning, plan/license issuance and high-value control-plane authority remain cloud-side;
- server APIs enforce RBAC/RLS/idempotency regardless of modified client UI;
- copied local DB/application directories cannot silently become a second enrolled terminal;
- official release/update packages are signed and versioned;
- obfuscation/minification/tamper detection are defense-in-depth, never the authority boundary;
- stolen/compromised devices can be revoked and fenced from future cloud authority.

The detailed binding doctrine is `docs/governance/KORVI-CLIENT-TRUST-ANTI-CLONING.md`.

## 7. Offline-first local architecture

The field assumption is not “brief internet blip”. A branch may operate for an entire shift without WAN connectivity and reconnect near day end.

### Required local partition

Every durable local partition is bound to the minimum identity set needed to prevent cross-use, including tenant, branch, terminal/device, user/authorization context and shift/operation context where applicable.

Local state may include:

- application shell/assets;
- bounded catalogue/search data;
- authoritative-at-download price/VAT/product facts required for supported offline sales;
- branch/device/session configuration required for allowed offline operation;
- signed offline lease/entitlement facts required to prove current authorized till operation;
- durable cart/draft state;
- immutable queued operation envelopes;
- synchronization attempts/outcomes/conflict states;
- locally renderable receipt facts when allowed by the transaction/regulatory path.

### Durable queue and sync state machine

The queue must preserve:

- deterministic operation identity;
- total/partition ordering where required;
- exact replay payload identity;
- atomic enqueue/state transition;
- lease/fencing for single-owner synchronization;
- retry/backoff and durable terminal outcomes;
- idempotent server replay;
- acknowledgement-before-advance;
- process/device restart recovery;
- explicit `needs-review` or equivalent conflict states rather than silent overwrite.

### End-of-day synchronization

The synchronizer must tolerate a full-shift backlog. It must prove bounded batches, resume after interruption, preserve ordering, avoid duplicate side effects, reconcile local outcomes with server truth and leave a clear operator-visible status.

### Multi-terminal offline boundary

Multiple isolated terminals create truths that cannot be globally known during WAN loss. Therefore Korvi must not pretend otherwise.

For operations where simultaneous offline terminals can violate an invariant, the architecture must choose and document one safe strategy, for example:

- branch-local LAN/edge coordination;
- pre-authorized/reserved operation budgets;
- operation-specific temporary local authority with deterministic reconciliation/refusal;
- restricted offline capability for that operation.

The strategy is operation-specific and must be proved. Silent last-write-wins is forbidden for C0/C1 truth.

## 8. Device continuity / Liquid Cashier

Authorized recovery onto another device may restore service, but only with explicit rules for:

- device identity and trust;
- user reauthorization;
- unsynchronized pending-operation ownership;
- duplicate-device fencing;
- transaction ordering;
- local-store transfer/recovery or deliberate abandonment rules;
- audit trail.

“Open the same website on another phone” is not sufficient proof of safe Device Continuity.

## 9. Hardware adapters

Printing, scanner, scale and cash-drawer support are adapter capabilities, not UI hacks.

- Arabic thermal output must use tested encoding/raster behavior for supported profiles.
- Unknown printer behavior fails safely rather than emitting corrupted official output.
- Barcode scanner input must preserve high-throughput keyboard/scanner operation.
- Physical-scale integration, when supported, must feed governed quantity intent and never bypass transaction validation.
- Hardware-specific code must remain outside pure financial/domain authority.

## 10. Event boundary for future ERP

Korvi POS remains independently operable. Future ERP/accounting integration is outbound through immutable business/financial events and stable identifiers. A future ERP may map events to journals/GL; POS must not call ERP to decide whether a sale, refund, close or stock movement is valid.

## 11. Concurrency and idempotency doctrine

Financial/data-integrity concurrency is serialized on explicit database rows/locks with documented lock order. Idempotency reservation and the business mutation commit together. Same operation + same server-bound intent may replay; same operation + different intent conflicts. Client-controlled actor/tenant/branch authority is forbidden.

## 12. Self-healing boundary

Allowed: reconnect, retry, rebuild cache/search index, restart worker/client, migrate local runtime schema, rehydrate UI, rotate disposable runtime state, isolate unhealthy integrations.

Forbidden: silently edit finalized financial records, stock history, cost history, regulatory invoices, reconciliation snapshots, audit events or accepted external submission outcomes.

Legacy “rescue scripts” or destructive repair ideas never supersede this rule.
