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

### Verified follow-on checkpoint — Product M1 authority slice

- branch: `product/post-v1-migration-engine`;
- SHA: `ef49a18610248133feb97bc17ed7778f10558264`;
- status: **VERIFIED authority slice / M1 IN PROGRESS**;
- evidence: CI `35519052509`, 188 test files / 2,294 tests passed;
- implemented: tenant-scoped import jobs and rows, source/mapping provenance, dry-run conflict detection, explicit reject policy, controlled create-only product commit through the existing product bootstrap authority, idempotent commit retry, row result tracking and audit;
- open gaps: production XLSX adapter, upload/file-inspection API, merchant mapping/preview/error UX, downloadable error results and end-to-end API authorization/tenant-isolation proof.

Customer Migration Readiness remains **IN PROGRESS**.

Source promotion:
- Capability Matrix
- Roadmap
- Product Readiness Scorecard
- this Decision Register

---

## Register maintenance rule

When a later executive decision supersedes one above, do not silently edit history. Add a new dated entry marked **SUPERSEDES** and update the affected authoritative source document.
