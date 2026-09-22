# KORVI POS — Execution Roadmap

Status: **ACTIVE SEQUENCING DOCUMENT**
Rule: roadmap can sequence/defer accepted capabilities; it cannot delete or downgrade them.

## Executive completion policy — 2026-09-15

The current objective is to finish the **sellable Korvi V1 product experience** first, while preserving the full Master Product Vision in the Directive/Matrix.

The following external items may be intentionally scheduled immediately before the first real customer rather than blocking engineering completion today:

- paid final production infrastructure;
- final production domain/cutover;
- launch-window accountant acceptance;
- launch-window systems-expert acceptance;
- controlled first-customer field validation.

This scheduling exception means “continue building instead of waiting”. It does **not** mean those gates are passed, and it does not authorize a false Production Ready claim.

## Immediate execution order — active workstream

### P0-1 — Finish Product Routing / Role Experience / Visual Truth

Continue from the first real open blocker on the active Product P0 branch. Required outcome:

- cashier lands in cashier experience;
- manager/owner lands in merchant control experience;
- Korvi Platform Admin has a distinct platform authority/surface;
- refresh/back/forward/deep links preserve logical navigation;
- merchant surfaces for sales/customers/inventory/purchasing/reports/settings/ZATCA are real rather than placeholders;
- exact-head desktop/tablet/mobile visual proof is green;
- no regression to financial/offline/inventory/ZATCA core.

### P0-2 — Complete Platform Admin customer-provisioning cycle

Close the gap between “tenant row exists” and “customer can actually sign in”. Required flow:

**Platform Admin → create tenant/business → assign plan → create/bootstrap initial owner → create/activate branch → register/enroll terminal/device → securely present tenant code/login facts → sign in as merchant owner → complete merchant onboarding → open cashier.**

Direct SQL/manual database work is not the normal customer-creation path.

Create a safe demo tenant only through supported product/admin flows; never commit credentials or secrets to GitHub.

### P0-3 — Installed Korvi Cashier for Windows and Android

Installed Korvi is now a B0 commercial requirement, with an explicit surface split:

- **Korvi Cashier** = installed Windows/Android till application.
- **Korvi Control** = responsive merchant-management web application.
- **Korvi Platform Admin** = separated platform-operator web application.

Do not ship the full management/platform product inside the till package merely hidden behind navigation.

Implementation must reuse the existing client/domain/API boundaries rather than rewrite Korvi separately per platform. Choose the smallest production-grade packaging architecture that can satisfy the gates without weakening the current system.

Required cashier outcomes:

- Windows installable release artifact;
- Android installable release artifact;
- application opens independently of a browser tab;
- bundled/offline application shell;
- durable local catalogue/search, drafts and operation queue;
- full-shift WAN outage operation for the supported cashier capability set;
- process/device restart recovery within the declared policy;
- end-of-day reconnect sync with no loss/duplication/reordering;
- deterministic conflict/review handling;
- printer/scanner/device integration for supported profiles;
- no reusable cloud/platform secrets embedded in packages;
- controlled app version/update/local-schema migration behavior;
- real Windows + Android evidence, not report-only proof.

Do not declare victory from existing browser/PWA offline evidence alone. Reuse that proven engine as foundation, then prove the installed clients.

### P0-4 — Harden Client Trust / Anti-Cloning

Before external distribution, close the B0 client-integrity objective:

> **STOLEN CLIENT ≠ STOLEN PRODUCT**

Required work:

- distinct enrolled device identity;
- tenant/branch/terminal/installation binding;
- OS-backed device-key protection where supported;
- signed bounded offline license/lease that supports long WAN outages without embedding private platform signing keys;
- encrypted/bound local operational store;
- no production DB/admin/platform secrets in EXE/APK/local files;
- cloud-only customer provisioning, plan/license issuance and Platform Admin authority;
- server-side RBAC/RLS/idempotency safe against patched clients;
- signed/versioned Windows and Android packages and updates;
- no unjustified debug tooling/public production source maps;
- minification/obfuscation/tamper checks as secondary defense-in-depth;
- device revocation, duplicate-device fencing and audited suspicious-device behavior;
- adversarial proof that copying/rebranding the binary does not yield an independently authorized Korvi platform.

Read and satisfy `docs/governance/KORVI-CLIENT-TRUST-ANTI-CLONING.md` and Gate 13 before calling the distributed cashier commercially hardened.

### P0-5 — Unify all final work on one release lineage

Once Product P0 + provisioning + installed-client + anti-cloning requirements are implemented:

1. reconcile with the current official RC baseline;
2. preserve all closed financial/security/offline/ZATCA/inventory evidence;
3. advance one final release lineage;
4. run full CI/live PostgreSQL/visual/offline/installed-client/client-integrity proof on the exact final SHA/build;
5. deploy the same final code to Staging;
6. run the full administrative and merchant dry run from Staging/installed clients.

Intermediate green SHAs do not substitute for final exact-head evidence.

### P0-6 — User-visible full dry run

Provide the executive operator with exactly what is needed to test personally:

- Platform Admin URL/entry point;
- safe temporary Platform Admin access mechanism;
- tenant/customer code;
- demo owner email/user identity;
- safe temporary/one-time credential path;
- merchant login URL;
- installed cashier package/entry point for Windows/Android as available;
- branch/register/device setup facts;
- instructions for first login only where unavoidable.

Never write passwords, CSIDs, API keys, HSM material or persistent secrets into source control or issue comments.

### P0-7 — Customer Migration Engine — ACTIVE IN PARALLEL

Customer data migration is a P0 onboarding requirement and must advance independently of Restaurant Phase 2 wherever shared-core dependencies do not require serialization.

Required controlled pipeline:

**UPLOAD → FILE INSPECTION → PARSE → NORMALIZE → COLUMN DETECTION → FIELD MAPPING → VALIDATION → PREVIEW → ERROR/WARNING REVIEW → DRY RUN → EXPLICIT COMMIT → IMPORT RESULT → AUDIT**

Never permit upload → direct database write.

Supported architecture must remain adapter-based:

**SOURCE → ADAPTER → CANONICAL IMPORT MODEL → VALIDATION → KORVI DOMAIN SERVICES**

Milestone sequence:

- **M0 — VERIFIED** on `product/post-v1-migration-engine@72402789b59628b98c7366e101ef4d2ac0fe2ce4`: canonical import model, `VALID/WARNING/ERROR/BLOCKED` classification, bounded CSV parser, formula-authority refusal, Arabic/Eastern-Arabic digit handling, exact monetary parsing without thousands-separator guessing, deterministic Arabic/English product header aliases, duplicate source/target mapping refusal and row-level SKU/barcode diagnostics.
- Evidence: CI `35506589825` — dependency pins, audit, formatting, lint, invariants, Prisma, build, typecheck and tests green; 188 test files / 2,284 tests passed, 24 files / 369 live-only tests skipped by the normal CI profile.
- **M1 — IN PROGRESS / BACKEND+API VERIFIED:** Product XLSX/CSV vertical slice through preview/dry-run/controlled commit/audit/idempotency.
  - **Verified checkpoint:** `product/post-v1-migration-engine@b07c050be788d6afd50faadd54e9f23c5e733735`, CI `35547048238` green; 190 test files / 2,305 tests passed, 24 files / 369 live-only tests skipped by the normal CI profile.
  - Implemented/proven: bounded CSV inspection and bounded XLSX parsing; formula/macro/external-reference authority protections; deterministic Arabic/English mapping suggestions and explicit mapping contract; preview rows; tenant-scoped reviewed import jobs/rows; original physical spreadsheet row provenance; source SHA-256 and row fingerprints; dry-run catalogue conflict detection; reject-only conflict policy; explicit commit requiring `settings.manage + product.write`; controlled create-only commit through Korvi's existing product bootstrap authority; retry/idempotency protection; audit events; row-level results and source-data minimization after commit.
  - HTTP callers cannot assert tenant identity or source hash; those remain server/principal-derived.
  - **Merchant workflow checkpoint VERIFIED:** `product/post-v1-migration-engine@e1a407565642ea5fcfda6820f475c0c833a6cbea`, CI `35612574884`; 191 test files / 2,315 tests passed, 24 files / 369 live-only tests skipped by the normal CI profile.
  - Implemented/proven in that checkpoint: Arabic-first Control Center migration surface, CSV/XLSX file selection, deterministic mapping override, source preview, reviewed-job creation, dry-run, explicit commit, ambiguous-command same-operation retry, row-level problem table, official product CSV template and downloadable formula-safe CSV error export.
  - **Open before M1 complete:** stronger database-level cross-tenant/adversarial proof. M2 categories may proceed in parallel without weakening the verified M1 pipeline.
- **M2 — VERIFIED:** categories + product→category authority.
  - Closure checkpoint: `product/post-v1-migration-engine@9ce8afc54c4336111f4489a4fb03b651bc9fe6c3`, CI `35631102915` green through dependency pins, audit, formatting, lint, invariants, Prisma, build, typecheck and tests; 195 test files / 2,335 tests passed, 27 files / 382 live-only tests skipped by the standard CI profile.
  - Restricted-runtime PostgreSQL proof: workflow `35630229494` green on `b593ffc534744097140789302e0f649b23ac2be2`; the later M2 closure delta contains only CI-baseline/test-fixture changes and no production migration authority changes.
  - Verified category vertical slice: deterministic Arabic/English mapping, bounded CSV/XLSX inspection/preview, formula/control-character refusal, tenant-scoped reviewed jobs/rows, dry run, reject-only existing-category conflict handling, explicit create-only commit through category bootstrap authority, idempotency, audit/provenance, source-data minimization, Arabic-first merchant workflow, official category template and formula-safe error export.
  - Verified product→category authority: files/browser may provide only `categoryNameAr`; dry-run and commit independently resolve the name inside the authenticated tenant, never accept `categoryId` from client-controlled input, never auto-create a missing category, reject missing/inactive categories row-by-row, and do not disclose or bind a category from another tenant.
- **M3 — VERIFIED** on `product/post-v1-migration-engine@fffd2e7d870826428064a85d4e52973aa86ea465`: Customer Migration is end-to-end for the actual Korvi customer fields (`nameAr`, `nameEn`, `phone`, `email`, `vatNumber`) with CSV/XLSX mapping, preview, dry run, controlled authoritative commit, audit/idempotency/provenance, Arabic merchant UI/template/error export and restricted-runtime PostgreSQL tenant-isolation/race proof. PR CI `35672537533`: 197 test files / 2,349 tests passed; PostgreSQL proof `35672535019`: 4 files / 18 tests passed.
- **M4 — VERIFIED** on `product/post-v1-migration-engine@512c57fc86a61d72e152ae4c1e05d210b70901b3`: Supplier Migration is end-to-end for the actual supplier create authority only (`name` required; server-authored active state). PR CI `35717607379` is green with 199 test files / 2,362 tests passed and 29 files / 391 live-only tests skipped. Restricted-runtime PostgreSQL proof `35717603645` is green with 5 files / 22 tests passed. CSV/XLSX mapping, preview, dry run, controlled commit, audit/idempotency/provenance, Arabic merchant UI/template/error export, raw formula/control-character safety and cross-tenant isolation are verified. Duplicate supplier names remain legitimate because the schema does not define name uniqueness.
- **M5 — IN PROGRESS / NEXT:** opening inventory through explicit opening-stock semantics, tenant-scoped business-key resolution and causal inventory-ledger evidence; never direct balance fabrication. Opening cost remains UNKNOWN unless explicit authoritative source semantics are defined.
- **M6:** richer explicit conflict/update strategies.
- **M7:** system-specific adapters only from real customer demand.

**CUSTOMER MIGRATION READINESS remains IN PROGRESS.** It cannot become GREEN until a realistic merchant can import products, customers, suppliers and opening inventory from supported spreadsheet formats with mapping, validation, preview, dry run, controlled commit, error reporting, audit, tenant isolation and idempotency.

Opening cost remains unknown unless source authority and meaning are explicit. Opening customer balances remain deferred until accounting/ledger semantics are defined; arbitrary derived-total writes are prohibited.

## Foundation already established

The repository has substantial evidence for:

- integer money/VAT/allocation;
- UUIDv7/idempotency;
- tenancy/RLS/auth/RBAC;
- checkout and immutable sales;
- shifts/cash movement/reconciliation;
- original-sale returns/refunds;
- inventory ledger/adjustments/counts/transfers;
- purchasing/receiving;
- costing with explicit unknown provenance;
- Arabic receipt/printing foundation;
- browser-based offline shell/catalogue/queue/sync/conflict proof;
- substantial ZATCA Phase 2 implementation/evidence;
- SaaS lifecycle/onboarding foundations.

These are foundations and proven authorities, not permission to skip the remaining product workflows.

## Full execution stages after P0 commercial-V1 closure

### Stage 1 — Financial / Security / Transaction Foundation — substantially established

Maintain and never regress money/quantity/tax invariants, pure domain boundaries, UUIDv7, tenant isolation, migrations, auth/RBAC, audit, printing foundation and automated verification.

### Stage 2 — SaaS Control Plane & Merchant Administration — active completion

Finish Platform Admin, customer provisioning, owner bootstrap/recovery boundaries, commercial plan state, branches/devices/users and the complete merchant control experience.

### Stage 3 — Installed / Offline / Device Continuity — active B0 completion

Move the already-proven browser offline engine into official Windows/Android Korvi Cashier release paths and close real-device/full-shift evidence. Then complete Liquid Cashier authorized recovery/device replacement.

### Stage 4 — Retail / Grocery Competitive Parity

Complete:

- high-throughput barcode/search UX;
- physical scale workflow where targeted;
- packaging/unit/carton hierarchy;
- multiple price lists and customer/context pricing;
- coupons/promotion engine;
- labels/price lookup/printing;
- batch/lot/expiry;
- replenishment/reorder foundation;
- warehouse/location modeling where required;
- representative large-catalogue performance.

### Stage 5 — Customer / Loyalty / Promotion Parity

Complete customer analytics/segmentation, explicit credit/balance authority where offered, loyalty ledger/rewards, gift/wallet value only as governed financial ledgers, and deterministic promotions with snapshot/refund explainability.

### Stage 6 — Light Food / Quick-Service Vertical

Korvi is not currently pursuing full-service restaurant parity as an active commercial requirement. The target food-service profile is deliberately narrow and reuses the proven cashier/retail core for cafes, cafeterias, juice shops, shawarma/quick-service counters and similarly simple food merchants.

Complete only the capabilities needed to make that profile operationally credible:

1. image/category-oriented product tiles while preserving search/barcode support;
2. simple counter/takeaway order flow and deterministic order/queue number;
3. ordinary customer receipt/invoice using the same financial/ZATCA authority as retail;
4. separate non-fiscal preparation/kitchen ticket tied to the finalized order, not a second tax invoice;
5. optional second-printer routing for preparation staff, with explicit failure/retry/reprint state and no duplicate-sale side effects;
6. minimal deterministic item notes/options where commercially required without introducing a separate restaurant transaction engine;
7. offline/restart/reconnect behavior consistent with the same Korvi Cashier guarantees;
8. exact installed Windows/Android printer-profile proof for supported hardware.

The following are intentionally outside the active Commercial V1 / quick-service commitment and must not block it: table maps/zones, waiter/server application, courses, complex split/merge bills, full KDS orchestration, customer displays, kiosks, QR table ordering/payment, full recipes/ingredients/waste management, online ordering and delivery-platform adapters.

Those advanced full-service capabilities are future optional scope only. Re-entering them into active execution requires a new explicit executive decision and must not silently expand the sellable-V1 denominator.

### Stage 7 — Payments / Omnichannel / Integrations

Complete electronic/split/mixed tender UX, PSP adapters, ecommerce ingestion and selected integration identities only where commercially required. Delivery-platform ingestion is no longer assumed to be required merely because Korvi supports light food-service merchants; it requires its own explicit commercial selection, mapping, idempotency and operational-support decision.

### Stage 8 — Reporting / Profit / Command Center

Expand sales/VAT reporting into product/category/customer/branch/cashier, inventory/purchasing/cost, profitability and exception/reconciliation views. Build the Attention Center around What/Why/Evidence/Severity/Affected/Action/Deep Link/State/Audit.

### Stage 9 — Korvi Advantage Engines

Deliver without granting AI authority over money/tax/stock:

1. Migration Engine.
2. Korvi Product Knowledge / national catalogue.
3. Explainable Reorder.
4. Expiry Intelligence.
5. Branch Rebalancing recommendations.
6. Korvi Watchdog / Guardian.
7. Profitability Intelligence.
8. Pricing Assistant.
9. Attention Center enhancements.
10. Liquid Cashier / Device Continuity enhancements.
11. Safe Operational Recovery.
12. Supply-network foundations.

### Stage 10 — Supply Network / B2B Frontier

After merchant purchasing/integration identities are stable, expand governed supplier identity/mapping into B2B supply ordering/network capabilities. This is strategically accepted but intentionally later than the core merchant product.

## Parallel gates across every stage

- Financial Integrity
- Security/Tenancy
- Data/Migration
- ZATCA
- Offline/Continuity
- Installed Application
- Client Trust / Anti-Cloning / IP Defense
- Device/Printing
- Performance
- UX/Accessibility/Visual Truth
- Commercial Truth
- Production Operations
- End-to-End Provisioning/Human Acceptance

## “Korvi Complete” terminology

Never use a single percentage or completion phrase without naming the denominator.

- **Release Gate Readiness** = current release scorecard denominator.
- **Commercial V1 Completeness** = every current sellable-V1 capability plus installed-client/provisioning/client-integrity/acceptance requirements.
- **Master Product Vision Completeness** = the broader accepted platform scope in the Master Product Directive/Capability Matrix.

`Korvi مكتمل ✅` may only be shown with the scope explicitly named and only when that scope has no known missing capability or open required blocker. Deadline pressure is never evidence.

## Executive decision capture

Material accepted decisions from executive conversation must not remain chat-only. Promote them into the applicable governance source and record the dated decision in `docs/governance/KORVI-EXECUTIVE-DECISION-REGISTER.md`.

Rejected brainstorming/hypotheticals are not binding until explicitly accepted.

## Execution behavior

- Always verify live branch/HEAD/CI before continuing.
- Continue from the **FIRST REAL OPEN BLOCKER**.
- Do not reopen proven closed work without contradictory live evidence.
- Do not stop at planning/testing/reporting when an implementable blocker remains and the task context authorizes implementation.
- Do not weaken quality, security, financial correctness, inventory truth, ZATCA, offline guarantees or client-integrity boundaries to move faster.
- Prefer root-cause fixes and reusable architecture over temporary patches.
- Preserve evidence and exact-head traceability.
