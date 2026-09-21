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

## 2026-09-20 — Full Restaurant Phase 2 is reactivated

**Decision:** ACCEPTED — SUPERSEDES the 2026-09-16 limitation on the **active post-V1 restaurant execution scope**.

Korvi Commercial/Sales V1 work already proven remains closed and is not reopened. Post-V1 product development now actively extends the existing Quick-Service/restaurant foundations into the broader Restaurant / Café operating mode, including tables/open orders, table transfer, cancellation, kitchen routing, preparation stations, KDS and the remaining explicitly adopted Restaurant Phase 2 capabilities.

The existing financial, inventory, tenant-isolation, offline, audit, printing and ZATCA authorities remain mandatory. Restaurant work must extend them rather than fork them.

Customer fiscal receipts and kitchen/preparation documents remain separate domains. Kitchen/preparation output is non-fiscal and must never carry VAT invoice identifiers, fiscal QR, ICV/PIH or other fiscal semantics.

Verified checkpoint recorded in the same development cycle:

- branch: `product/post-v1-restaurant-foundation`;
- SHA: `997a17e7c6acf31420fccdf6101b11ee60d49f35`;
- capability: Transfer Table UI + Cancel Order workflow on the existing backend authority;
- status: **VERIFIED**;
- evidence: CI run `35478694436`, 187 test files / 2,276 tests passed;
- open gap / next action: Kitchen Routing → Preparation Stations → KDS.

Source promotion:
- Roadmap
- Capability Matrix
- this Decision Register

### Verified follow-on checkpoint — Preparation Stations / Kitchen Routing

- branch: `product/post-v1-restaurant-foundation`;
- SHA: `bf9b9c77818f3093c5d20de674cd982bf7474541`;
- capability: branch-scoped preparation stations plus deterministic product→station routing;
- status: **VERIFIED**;
- evidence: CI run `35507010055`, 188 test files / 2,291 tests passed, plus Windows and Android installed-client proof workflows green on the same SHA;
- authority: station configuration is permissioned, tenant/branch scoped, RLS protected, idempotent and audited;
- fiscal boundary: preparation routing remains operational/non-fiscal and excludes price/VAT/invoice/QR/ICV/PIH semantics;
- open gap / next action: KDS lifecycle → preparation status/timing → retry/reprint semantics.

### Verified follow-on checkpoint — KDS core lifecycle / POS fire safety

- branch: `product/post-v1-restaurant-foundation`;
- SHA: `1123897555d8ba27407ed9edcaf7343461d725c2`;
- status: **VERIFIED KDS core / Restaurant Phase 2 IN PROGRESS**;
- evidence: CI `35547240369` green, 189 test files / 2,306 tests passed; Android installed-client proof green on the same SHA; Windows installed proof still running at checkpoint capture and is not claimed complete;
- implemented: station task persistence, explicit revision-bound/idempotent fire, queued→preparing→ready→served transitions, preparation timestamps, audited status changes, station KDS UI and explicit POS send-to-kitchen workflow;
- safety: once preparation tasks exist, open-order line replacement and cancellation are refused server-side, avoiding silent duplicate preparation until safe delta/cancel-to-kitchen semantics are implemented;
- fiscal boundary: KDS/preparation payloads remain operational/non-fiscal and do not carry price/VAT/invoice/fiscal QR/ICV/PIH authority;
- open gap / next action: course sequencing and safe post-fire delta semantics, then remaining split/merge/payment and recipe/inventory restaurant capabilities.

---

### Verified follow-on checkpoint — Recipe/BOM authority + authoritative costing

- branch: `product/post-v1-restaurant-foundation`;
- SHA: `5ff6a633b5818aab71f53315dbc0d90597b0eeee`;
- status: **VERIFIED recipe/BOM foundation / Restaurant Phase 2 IN PROGRESS**;
- evidence: CI `35616882259` green through dependency pins, audit, formatting, lint, invariants, Prisma, build, typecheck and tests; 192 test files / 2,329 tests passed, 24 files / 369 live-only tests skipped by the standard profile;
- implemented: revisioned/idempotent recipe/BOM writes, explicit ingredient quantities/yield, duplicate/self/nested-recipe guards, tenant-scoped product authority and branch recipe costing;
- financial invariant: recipe cost is derived only from synchronized inventory-cost authority; any unknown ingredient cost keeps the recipe yield cost UNKNOWN rather than inventing margin;
- fiscal boundary: recipe/KDS APIs remain operational and do not create sales, VAT invoices, fiscal QR, ICV or PIH semantics;
- open gap / next action: ingredient consumption/production inventory movements, waste/spoilage, then remaining split/merge/payment and course/delta semantics.

---

## Register maintenance rule

When a later executive decision supersedes one above, do not silently edit history. Add a new dated entry marked **SUPERSEDES** and update the affected authoritative source document.
