# KORVI — Executive Decision Register

Status: **LIVING EXECUTIVE SOURCE OF TRUTH**
Purpose: preserve material product, architecture, commercialization, security, UX and release decisions so they do not remain trapped in chat history.

## Standing capture rule

When an executive conversation produces a **material accepted Korvi decision**, the decision must be promoted into the repository governance sources instead of remaining only in conversation history.

Material decisions include changes to:

- product scope;
- user experience;
- supported platforms;
- security model;
- offline behavior;
- tenancy/permissions;
- financial/inventory/tax authority;
- ZATCA boundaries;
- subscription/commercial behavior;
- deployment/release gates;
- launch sequencing;
- competitive-parity requirements;
- Korvi Advantage features;
- intellectual-property or anti-cloning architecture.

Casual brainstorming, rejected ideas, hypothetical examples and unapproved alternatives are **not automatically binding**. They must be clearly accepted before becoming product authority.

The correct repository target depends on the decision:

- product identity/scope → `KORVI-MASTER-PRODUCT-DIRECTIVE.md`
- capability status/gaps → `KORVI-CAPABILITY-MATRIX.md`
- technical authority/boundaries → `KORVI-ARCHITECTURE-MAP.md`
- release evidence → `KORVI-RELEASE-GATES.md`
- execution order → `KORVI-ROADMAP.md`
- installed-client trust/IP → `KORVI-CLIENT-TRUST-ANTI-CLONING.md`
- continuity checkpoint → GitHub Issue `KORVI EXECUTION CONTINUITY — CANONICAL HANDOFF`

This register is a decision log and index. It does not replace the domain-specific source files above.

---

## 2026-09-15 — Installed Korvi is an official product requirement

**Decision:** ACCEPTED.

Korvi Cashier must support official installed clients for Windows POS hardware and Android POS hardware/tablets. A PWA/browser may remain an implementation substrate or fallback, but commercial cashier operation is not defined merely as “keep a website open”.

The installed-client requirement is B0 for the intended Commercial V1 direction.

Source promotion:
- Master Product Directive
- Architecture Map
- Capability Matrix
- Release Gates
- Roadmap

---

## 2026-09-15 — Full-shift offline operation is a field requirement

**Decision:** ACCEPTED.

Target merchants may have no usable WAN internet for most or all of the working shift. Connectivity may return only near closing/end-of-day.

Therefore the supported cashier capability set must continue locally for a full shift, including durable catalogue/search state, drafts and queued sale operations. Reconnect must synchronize without loss, duplication or reordering and must survive application/process restart according to the security policy.

A brief “network blip” model is insufficient.

Source promotion:
- Master Product Directive
- Architecture Map
- Capability Matrix
- Release Gates
- Roadmap

---

## 2026-09-15 — Client surface split: installed cashier, web management

**Decision:** ACCEPTED.

The installed Windows/Android product is primarily **Korvi Cashier**, not the full merchant/platform administration suite.

Merchant administration is primarily **Korvi Control Web**, responsive for phone/tablet/computer.

Korvi customer/tenant administration is **Korvi Platform Admin Web**, separated from merchant authority.

The cashier package must not merely hide full administration behind disabled navigation; unnecessary high-value management/platform code should not be shipped to the till.

Source promotion:
- Architecture Map
- Client Trust / Anti-Cloning Doctrine

---

## 2026-09-15 — Stolen client must not equal stolen product

**Decision:** ACCEPTED.

Primary threat: someone copies/reverse-engineers Korvi Cashier, changes branding/appearance and resells it as a cheap independent POS product.

Korvi's defense is architectural, not based on the false promise that client code is impossible to inspect.

Required principles:

- distributed cashier binary is not the whole platform;
- no reusable cloud/platform secrets inside the client;
- device enrollment and signed offline license/lease;
- tenant/branch/terminal/device binding;
- OS-backed device-key protection where available;
- server-side RBAC/RLS/idempotency remains authoritative under a modified client;
- encrypted/bound local operational store;
- signed official Windows/Android releases and updates;
- production builds avoid unnecessary debug/source-map exposure;
- obfuscation/minification/tamper controls are defense-in-depth only;
- Platform Admin and merchant-management authority remain cloud-side;
- copied binaries cannot create tenants, issue plans/licenses, become Platform Admin or access Korvi Cloud as an authorized product;
- device revocation and duplicate-device response paths must exist.

The accepted rule is:

> **STOLEN CLIENT ≠ STOLEN PRODUCT**

Source promotion:
- `KORVI-CLIENT-TRUST-ANTI-CLONING.md`
- canonical continuity issue

---

## 2026-09-15 — Production resources and human acceptance scheduling

**Decision:** ACCEPTED WITH TRUTHFUL DEFERRAL.

Paid final production infrastructure/domain cutover and launch-window accountant/systems-expert acceptance may be scheduled immediately before the first real customer rather than stopping product implementation today.

This scheduling choice does not mark the corresponding Production/Human gates as passed and does not authorize a false Production Ready claim.

Source promotion:
- Master Product Directive
- Release Gates
- Roadmap

---

## 2026-09-15 — Complete Platform Admin customer-provisioning cycle

**Decision:** ACCEPTED.

Routine customer creation must be supported through product/admin workflows rather than SQL/manual database intervention.

Required chain:

Platform Admin → create tenant/business → assign plan → bootstrap initial owner → create/activate branch → register terminal/device → safely present tenant/login facts → merchant owner sign-in → onboarding → cashier.

Source promotion:
- Master Product Directive
- Capability Matrix
- Architecture Map
- Release Gates
- Roadmap

---

## 2026-09-15 — Master Product Vision remains broader than launch V1

**Decision:** ACCEPTED.

Commercial V1 closure does not delete accepted future capabilities. The Master Product Vision continues to preserve retail/grocery parity, restaurant/cafe, customer/loyalty/promotions, payments/omnichannel, analytics/command center, Migration Engine, Product Knowledge, Explainable Reorder, Expiry Intelligence, Branch Rebalancing, Guardian/Watchdog, Profitability Intelligence, Pricing Assistant, Attention Center, Liquid Cashier, Safe Operational Recovery and Supplier Network direction.

Release-gate readiness, Commercial V1 completeness and Master Product Vision completeness are separate denominators.

Source promotion:
- Master Product Directive
- Capability Matrix
- Roadmap

---

## 2026-09-15 — AI authority boundary

**Decision:** ACCEPTED.

AI may recommend, explain, prioritize and detect anomalies. AI must not become authoritative for money, tax, inventory, costing, finalized financial history or ZATCA compliance state.

Source promotion:
- Master Product Directive
- Architecture Map

---

## 2026-09-16 — Installed cashier distribution is private/direct, not public app-store distribution

**Decision:** ACCEPTED.

Official Korvi Cashier for Windows and Android must be distributed through a controlled private/direct Korvi channel for authorized customers/devices. Korvi Cashier is not to be published as a publicly discoverable consumer application through public app stores such as Google Play or Microsoft Store.

Accepted delivery models include Korvi-controlled authenticated download links, operator-assisted installation, customer-specific/private deployment channels and controlled signed update delivery, provided release authenticity, device enrollment, revocation, update integrity and exact-build provenance remain enforced.

This decision does not permit unsigned APK/EXE distribution, shared reusable secrets, weakened OS security controls or uncontrolled permanent download URLs. Privacy/discoverability is a commercial distribution requirement; cryptographic signing and server-side authorization remain mandatory security requirements.

Source promotion:
- `KORVI-CLIENT-TRUST-ANTI-CLONING.md`
- installed-client release/distribution gates

---

## 2026-09-16 — Food-service scope is narrowed to light/quick-service, not full-service restaurant parity

**Decision:** ACCEPTED — SUPERSEDES the active execution interpretation that Korvi must pursue full-service restaurant parity as a near-term commercial target.

Korvi will support food merchants whose operational model is close to a fast retail cashier workflow, including cafes, cafeterias, juice shops, shawarma/quick-service counters and other small restaurants that do not require a full restaurant-management suite.

The supported near-term food profile is cashier-first and may add food-specific presentation and preparation output without forking financial/inventory truth. Its target capabilities include:

- image/category-oriented product selection in addition to search/barcode where useful;
- simple takeaway / counter-service order flow;
- stable order/queue number;
- normal customer receipt/invoice plus a separate non-fiscal preparation/kitchen ticket;
- optional second-printer routing for preparation staff, with explicit printer failure/retry state;
- simple item notes/options only where they can be represented deterministically without introducing the full restaurant domain;
- the same Korvi cashier, tenant, branch, terminal, payment, offline, inventory, audit and ZATCA authorities as retail.

The preparation ticket is operational output, not a second fiscal/tax invoice. Reprints must remain traceable and must not create duplicate sales or duplicate fiscal documents.

The following advanced full-service restaurant capabilities are **not current Commercial V1 requirements** and must not block the retail/quick-service product: table maps/zones, waiter/server application, courses, complex split/merge bills, KDS orchestration, QR table ordering/payment, self-service kiosk, full recipe/ingredient/waste suite, online ordering and delivery-platform integrations. They may remain future optional capabilities and require a separate explicit decision before being promoted back into active execution.

Source promotion:
- Roadmap
- Capability Matrix / product scope annotations when next edited
- Master Product Directive scope interpretation when next edited

---

## 2026-09-20 — Migration Engine is a P0 customer-onboarding requirement

**Decision:** ACCEPTED — SUPERSEDES the earlier roadmap interpretation of Migration Engine as B2/future-only work.

Korvi must support controlled migration/import of merchant operational data from existing POS/ERP exports. Initial production priority is XLSX + CSV without paid migration SaaS dependencies. The implementation must be a reusable adapter/canonical-model architecture rather than a one-off uploader.

Mandatory invariants:

- no upload-to-direct-database path;
- deterministic mapping/validation is authoritative; AI is not a correctness authority;
- files are untrusted input and formulas/macros are never executed or treated as authority;
- every import belongs to one authorized tenant and must not disclose or mutate another tenant;
- network retry cannot duplicate committed records;
- inventory opening state must use explicit migration/opening-stock semantics rather than fabricated purchases/sales or direct balance mutation;
- cost remains UNKNOWN unless its authority is explicit;
- financial opening balances require defined ledger semantics before implementation;
- committed rows retain sufficient migration provenance and audit evidence.

M0 repository checkpoint in the same development cycle:

- branch: `product/post-v1-migration-engine`;
- SHA: `72402789b59628b98c7366e101ef4d2ac0fe2ce4`;
- capability: canonical import model + bounded CSV parse + deterministic product mapping/normalization/row review;
- status: **VERIFIED**;
- evidence: CI `35506589825`; 188 test files / 2,284 tests passed;
- open gaps: XLSX parser boundary, Product M1 preview/dry-run/controlled commit, categories, customers, suppliers, opening inventory and end-to-end error export;
- next action: Product Import M1.

The overall **CUSTOMER MIGRATION READINESS** gate remains **IN PROGRESS** and is not satisfied by M0 alone.

### Verified follow-on checkpoint — Product M1 backend/API slice

- branch: `product/post-v1-migration-engine`;
- SHA: `b07c050be788d6afd50faadd54e9f23c5e733735`;
- status: **VERIFIED backend/API slice / M1 IN PROGRESS**;
- evidence: CI `35547048238`, 190 test files / 2,305 tests passed; 24 files / 369 live-only tests skipped by the standard CI profile;
- implemented: bounded CSV and XLSX inspection, deterministic mapping/preview contract, tenant-scoped import jobs/rows, source SHA-256 + physical row provenance/fingerprints, dry-run catalogue conflict detection, explicit reject-only conflict policy, controlled create-only commit through existing product bootstrap authority, idempotent create/commit retry, audit, row result tracking and post-commit source-data minimization;
- authorization evidence: inspection/job/dry-run require `settings.manage`; commit additionally requires `product.write`; request bodies cannot assert tenant identity or source hash;
- open gaps: merchant mapping/preview/error UI, downloadable/exportable error results, stronger database-level cross-tenant/adversarial proof, categories/customer/supplier/opening-inventory milestones.

Customer Migration Readiness remains **IN PROGRESS**.

### Verified follow-on checkpoint — Product M1 merchant workflow

- branch: `product/post-v1-migration-engine`;
- SHA: `e1a407565642ea5fcfda6820f475c0c833a6cbea`;
- status: **VERIFIED merchant workflow / M1 IN PROGRESS**;
- evidence: CI `35612574884`; 191 test files / 2,315 tests passed, 24 files / 369 live-only tests skipped by the standard CI profile;
- implemented: Arabic-first XLSX/CSV upload workflow, deterministic field mapping/manual override, source preview, dry run, explicit commit, same-operation retry after ambiguous responses, row-level problem review, product import template and downloadable formula-safe CSV error report;
- remaining M1 closure gap: stronger database-level cross-tenant/adversarial proof.

Customer Migration Readiness remains **IN PROGRESS**.

### Verified Product M1 closure — PostgreSQL tenant-isolation proof

- branch: `product/post-v1-migration-engine`;
- SHA: `2442de56437bb933c1b9730c3fc982e186fce2d3`;
- status: **VERIFIED M1**;
- standard CI: `35615195972` / PR CI `35615200612` green;
- database proof: `35615195979` green using a non-superuser, non-BYPASSRLS runtime role against PostgreSQL 17;
- proved: forced RLS on migration jobs/rows, Tenant B exact UUID invisibility to Tenant A, identical unknown-job behavior for foreign dry-run/commit, no foreign catalogue-conflict leakage, tenant-consistent FK rejection and inability to update/delete foreign migration state;
- next action: M2 categories + product/category mapping.

Customer Migration Readiness remains **IN PROGRESS** because customers, suppliers and opening inventory are not yet end-to-end verified.

### Verified Category M2 backend/API checkpoint

- branch: `product/post-v1-migration-engine`;
- SHA: `c1a974989bd1bce0fc2aede109693186a29ce581`;
- status: **VERIFIED backend/API slice / M2 IN PROGRESS**;
- evidence: CI `35623377323`; 194 test files / 2,327 tests passed, 25 files / 375 live-only tests skipped by the standard CI profile;
- implemented: deterministic category mapping/row review, bounded CSV/XLSX inspection, tenant-scoped reviewed jobs, preview, dry run, reject-only category conflicts, controlled create-only commit through the existing category authority, idempotency, audit/provenance and row-level results;
- authority boundary: clients/files may provide category names and mappings, but must not gain category UUID authority;
- open gaps before M2 closure: product→category server-side resolution, merchant category UI/template/error export and restricted-runtime PostgreSQL tenant-isolation proof.

Customer Migration Readiness remains **IN PROGRESS**.

### Verified Category M2 closure — Product/category authority + merchant workflow + PostgreSQL isolation

- branch: `product/post-v1-migration-engine`;
- closure SHA: `9ce8afc54c4336111f4489a4fb03b651bc9fe6c3`;
- status: **VERIFIED M2**;
- standard CI: `35631102915` green through dependency pins, audit, formatting, lint, invariants, Prisma, build, typecheck and tests;
- evidence: 195 test files / 2,335 tests passed; 27 files / 382 live-only tests skipped by the standard CI profile;
- PostgreSQL security/isolation proof: workflow `35630229494` green on `b593ffc534744097140789302e0f649b23ac2be2`, using the restricted non-superuser, non-BYPASSRLS runtime role;
- category capability: deterministic CSV/XLSX mapping and validation, preview, dry run, controlled create-only commit through the existing category authority, audit/idempotency/provenance, Arabic merchant UI, official template and formula-safe error export;
- product→category authority: client-controlled sources may provide `categoryNameAr` only. The server resolves it inside the current tenant during dry-run and resolves it again at commit. `categoryId` from CSV/XLSX/browser payload is not accepted as authority;
- missing or inactive categories produce row-level errors; Product Import does not create categories and does not guess similar names;
- isolation evidence proves a category belonging to Tenant A cannot satisfy Tenant B resolution, and foreign migration/category state is not disclosed through the flow;
- gaps: M2 has no remaining implementation gap. Overall Customer Migration Readiness remains **IN PROGRESS** because M3 customers, M4 suppliers and M5 opening inventory remain open;
- next action: **M3 Customer Migration vertical slice** using only the fields and semantics supported by Korvi's existing customer domain.

Source promotion:
- Capability Matrix
- Roadmap
- Product Readiness Scorecard
- this Decision Register

### Verified M3 Customer Migration closure — end-to-end customer vertical + PostgreSQL isolation

- branch: `product/post-v1-migration-engine`;
- verified implementation SHA: `fffd2e7d870826428064a85d4e52973aa86ea465`;
- status: **VERIFIED M3**;
- standard PR CI: `35672537533` green through dependency pins, audit, formatting, lint, invariants, Prisma, build, typecheck and tests;
- evidence: 197 test files / 2,349 tests passed; 28 files / 387 live-only tests skipped by the standard CI profile;
- PostgreSQL security/isolation proof: workflow `35672535019` green on the same implementation lineage using a restricted non-superuser, non-BYPASSRLS runtime role; 4 live proof files / 18 tests passed, including 5 Customer Migration isolation tests;
- supported canonical customer fields are exactly the current Korvi customer domain: required `nameAr`; optional `nameEn`, `phone`, `email`, `vatNumber`. No balances, loyalty, credit, addresses or other unsupported semantics were invented;
- capability: bounded CSV/XLSX inspection, deterministic Arabic/English mapping and validation, source preview, reviewed tenant-scoped jobs/rows, dry run, explicit controlled commit, row-level results, audit/provenance, source-data minimization, idempotent retry, Arabic merchant UI, official customer template and formula-safe error export;
- authority: inspection/job/dry-run require `settings.manage`; commit additionally requires `customer.write`. Tenant identity and source hash remain server/principal-derived;
- conflict semantics follow the real database/domain model: phone uniqueness is tenant-scoped, checked during dry run and re-enforced by the authoritative customer writer during commit. Email and VAT number are not falsely treated as unique because the schema does not make them unique;
- isolation evidence proves Tenant B phone conflicts do not leak into Tenant A, foreign customer import jobs are indistinguishable from unknown jobs, identical phone values may legitimately exist in different tenants, and a post-dry-run same-tenant phone race is refused at commit rather than trusting stale preview state;
- gaps: M3 has no remaining implementation gap. Overall Customer Migration Readiness remains **IN PROGRESS** because M4 suppliers and M5 opening inventory remain open;
- next action: **M4 Supplier Migration** using only the actual supplier create semantics currently supported by Korvi.

Source promotion:
- Capability Matrix
- Roadmap
- Product Readiness Scorecard
- this Decision Register


### Verified M4 Supplier Migration closure — end-to-end supplier vertical + PostgreSQL isolation

- branch: `product/post-v1-migration-engine`;
- verified implementation SHA: `512c57fc86a61d72e152ae4c1e05d210b70901b3`;
- status: **VERIFIED M4**;
- standard PR CI: `35717607379` green through dependency pins, audit, formatting, lint, invariants, Prisma, build, typecheck and tests;
- evidence: 199 test files / 2,362 tests passed; 29 files / 391 live-only tests skipped by the standard CI profile;
- PostgreSQL security/isolation proof: workflow `35717603645` green on the same SHA using the restricted non-superuser, non-BYPASSRLS runtime role; 5 live proof files / 22 tests passed, including the supplier isolation suite;
- supported canonical supplier model is exactly the current Korvi create authority: required `name` only. No phone, tax number, payment terms, credit, contact or other unsupported supplier semantics were invented;
- capability: bounded CSV/XLSX inspection, deterministic mapping/validation, source preview, tenant-scoped reviewed jobs/rows, dry run, controlled commit through the authoritative supplier writer, idempotent retry, audit/provenance, source-data minimization, Arabic merchant UI, official template and formula-safe error export;
- authority: inspection/job/dry-run require `settings.manage`; commit additionally requires `purchasing.manage`. Tenant identity and source hash remain server/principal-derived;
- supplier names are not falsely treated as unique because the current schema permits legitimate duplicates. Formula-like input is blocked and raw control characters are rejected before text normalization;
- isolation evidence proves foreign supplier migration jobs remain indistinguishable from unknown jobs and identical supplier names may legitimately exist across tenants without leaking foreign state;
- gaps: M4 has no remaining implementation gap. Overall Customer Migration Readiness remains **IN PROGRESS** because M5 opening inventory remains open;
- next action: **M5 Opening Inventory** with explicit opening-stock semantics, tenant-scoped business-key resolution and causal inventory-ledger evidence; never direct balance fabrication.

Source promotion:
- Capability Matrix
- Roadmap
- Product Readiness Scorecard
- this Decision Register

### Verified M5 Opening Inventory closure — causal opening stock + PostgreSQL isolation

- branch: `product/post-v1-migration-engine`;
- verified implementation SHA: `0fad77ff837fe4677c67bd74cab50be384bda068`;
- status: **VERIFIED M5**;
- standard CI: `35720975124` green through dependency pins, audit, formatting, lint, invariants, Prisma, build, typecheck and tests;
- evidence: 201 test files / 2,374 tests passed; 30 files / 395 live-only tests skipped by the standard CI profile;
- PostgreSQL security/isolation proof: workflow `35720975187` green on the same SHA using the restricted non-superuser, non-BYPASSRLS runtime role; 6 live proof files / 26 tests passed;
- supported canonical opening-inventory model is business-key only: `branchCode`, `sku`, `openingQuantity`. Client/file payloads cannot assert tenant identity, branch/product UUIDs, source hash or cost/value authority;
- dry run and commit independently resolve branch code and SKU inside the authenticated tenant. Foreign-tenant branch/SKU facts remain non-resolving, and commit requires `settings.manage + inventory.adjust` at the HTTP/service authority boundary;
- commit rechecks pristine opening state under inventory locks after dry run, then writes one causal `migration-opening-stock` movement through the existing inventory/cost ledger. It does not fabricate `inventory_balances`, fake purchases/sales or invent opening cost;
- positive opening quantity without explicit value authority is recorded with UNKNOWN cost provenance/value, preserving future cost-bootstrap truth;
- capability includes bounded CSV/XLSX inspection, deterministic Arabic/English mapping/validation, source preview, controlled commit, idempotent retry, audit/provenance, source-data minimization, Arabic merchant UI, official template and formula-safe error export;
- gaps: M5 has no remaining baseline implementation gap. **CUSTOMER MIGRATION READINESS is VERIFIED** for the adopted P0 baseline;
- next action: **M6 ADOPTED** — add richer explicit conflict/update strategies only where existing Korvi domain authority and deterministic tenant-scoped business keys make the update unambiguous. M7 remains DEFERRED to real customer demand.

Source promotion:
- Capability Matrix
- Roadmap
- Product Readiness Scorecard
- this Decision Register

### Verified M6 customer conflict/update closure — explicit tenant-scoped phone authority

- branch: `product/post-v1-migration-engine-m6`;
- verified implementation/proof SHA: `f8b1c0bd253b7668b3da370c307cfa5dcf269857`;
- status: **VERIFIED M6**;
- standard CI: `35724243049` green through dependency pins, audit, formatting, lint, invariants, Prisma, build, typecheck and tests;
- evidence: 201 test files / 2,375 tests passed; 30 files / 397 live-only tests skipped by the standard CI profile;
- PostgreSQL security/isolation proof: workflow `35724243105` green on the same SHA using the restricted non-superuser, non-BYPASSRLS runtime role; 6 live proof files / 28 tests passed;
- M6 adds exactly one currently justified explicit strategy: Customer `update-existing-by-phone`. Default behavior remains `reject`; opting into update requires the phone field to be mapped;
- files/browser payloads never receive customer UUID authority. Unsupported strategies and request-controlled `customerId` are refused at the strict HTTP boundary;
- dry run resolves phone only within the authenticated tenant and marks an existing same-tenant match as a planned update. A same phone in another tenant is not a match and is not disclosed;
- commit never trusts the dry-run target id. It re-resolves the tenant-scoped phone under tenant locking, then either updates the authoritative same-tenant customer or creates when no same-tenant match exists;
- update execution reuses Korvi's authoritative transactional customer writer and changes only fields actually mapped in the source. Unmapped optional fields are preserved rather than silently erased;
- explicit update-by-phone jobs carry their strategy in the idempotency fingerprint, while legacy/default reject jobs preserve the pre-M6 fingerprint for safe retry compatibility;
- merchant UI exposes the strategy as an explicit opt-in and reports created and updated results separately;
- no Product, Category, Supplier or other migration update/merge semantics are implied by M6. Those domains retain their previously verified behavior until a deterministic business key plus authoritative update path is proven;
- **CUSTOMER MIGRATION READINESS remains VERIFIED**. M6 strengthens conflict handling but does not change the established P0 baseline denominator;
- next action: **M7 DEFERRED** — system-specific source adapters only when real customer demand supplies an actual system and mapping contract.

Source promotion:
- Capability Matrix
- Roadmap
- Product Readiness Scorecard
- this Decision Register

---

## Register maintenance rule

When a later executive decision supersedes one above, do not silently edit history. Add a new dated entry marked **SUPERSEDES** and update the affected authoritative source document.


---

## 2026-09-22 — Canonical Acquisition Release becomes P0

**Decision:** ACCEPTED.

Korvi will prioritize a single canonical acquisition/release lineage over additional speculative feature expansion.

Canonical integration branch:

- `release/canonical-acquisition-v1`
- baseline: `fb0d39c0b2b516cdbdb8590281a784a165a41827`

The adopted P0 program is defined in:

- `docs/governance/KORVI-CANONICAL-ACQUISITION-RELEASE.md`

Required closure areas:

- unify verified Retail/Product, Restaurant, Migration and Security work into one release lineage;
- integrate revocable Platform Admin server-side sessions;
- complete Electronic/Mixed Tender UI;
- complete Return/Refund UI;
- complete Shift Close and Cash Reconciliation UI;
- prove production operations rather than relying on staging evidence;
- close real production ZATCA provider/operations when external activation is available;
- create acquisition-grade deployment/handoff/ownership documentation;
- run a controlled real merchant production pilot;
- finish with one exact canonical release SHA and evidence package.

Until production operations, production ZATCA and a real merchant pilot are evidence-backed, Korvi must not be described as **Production Proven**.

The program permits parallel isolated workstreams, but no force-push, silent overwrite, blind merge or weakening of Korvi financial/inventory/tax/security invariants is allowed.

Source promotion:

- Canonical Acquisition Release Program
- Roadmap
- Product Readiness Scorecard
- Executive Decision Register
