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

### Stage 6 — Restaurant / Café Operating Mode — REACTIVATED 2026-09-20

The 2026-09-20 executive directive supersedes the earlier **active-execution** limitation to light quick-service only. Commercial V1 readiness already proven under the narrower scope remains historical evidence and is not reopened merely because the post-V1 product scope is broader.

Restaurant Phase 2 now proceeds on the existing Korvi transaction/inventory/offline/ZATCA authorities rather than creating a disconnected restaurant POS.

Verified checkpoint:

- branch: `product/post-v1-restaurant-foundation`;
- implementation/evidence SHA: `997a17e7c6acf31420fccdf6101b11ee60d49f35`;
- CI: `35478694436` — Formatting, Lint, Invariants, Prisma, Build, Typecheck and Tests green;
- tests: 187 files passed / 2,276 tests passed; 24 files and 369 live-only tests skipped by the normal CI profile;
- implemented/verified: dine-in/takeaway/delivery context, zones/tables, open orders, hold/resume, revision-safe line editing, atomic settlement, table transfer UI, and permissioned/audited cancellation;
- fiscal boundary preserved: customer fiscal receipt remains separate from non-fiscal preparation output.

Immediate next action:

**Kitchen Routing → Preparation Stations → KDS**, preserving non-fiscal preparation semantics, then continue remaining Restaurant Phase 2 capabilities from repository truth.

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
