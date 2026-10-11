# KORVI POS — Master Product Directive

Status: **ACCEPTED PRODUCT CONSTITUTION**
Authority: product direction and accepted capability scope.
Engineering invariants remain governed by `CLAUDE.md`, `AGENTS.md`, accepted ADRs, and mechanical release gates.

## 1. Product identity

Korvi is a Saudi-market, production-grade multi-vertical business operating platform led by POS. It must be independently sellable and operable for retail/grocery and restaurant/cafe merchants, while preserving clean event boundaries for a future broader Korvi ERP/accounting platform.

North star: **One Platform — One Truth — Multiple Experiences.**

Korvi is not a feature dump. All user experiences share one tenant model, one financial truth, one stock/cost truth, one identity/permission model, one audit model, one synchronization doctrine and one release discipline.

The product target is not merely “a good cashier”. It is to reach credible market parity in the merchant workflows users buy today, then exceed that parity with Korvi-specific operational intelligence and continuity capabilities.

## 2. Non-negotiable principles

1. **Financial truth is sacred.** Money uses integer minor units; no float-based authority, hidden rounding, or client-supplied financial truth.
2. **Historical truth is immutable.** Finalized sales, invoices, returns, tax facts, tender facts, cost basis, stock movements and audit events are never silently rewritten by later catalogue or rule changes.
3. **Unknown is not zero.** Missing historical cost, provenance or facts must remain explicitly unknown rather than fabricated.
4. **One stock truth + one costing foundation.** Retail, grocery, restaurant ingredients, purchasing, returns, transfers, adjustments and future omnichannel flows converge on one governed inventory/cost authority.
5. **Security and tenancy are structural.** Tenant isolation, FORCE-RLS where applicable, least privilege, authorization, non-enumeration, idempotency, session invalidation and auditability are release properties.
6. **Determinism beats convenience.** Pricing, promotions, tax, allocation, returns, tenders, numbering, synchronization ordering and reconciliation must be deterministic and explainable.
7. **Vertical experiences may differ; truth may not.** Retail/grocery and restaurant UX may diverge while sharing the same underlying money, stock, tenant, identity, audit and compliance authorities.
8. **Offline is a primary operating mode, not an outage afterthought.** A merchant may operate an entire shift without WAN internet and synchronize later.
9. **AI never becomes accounting, tax, stock or regulatory authority.** AI may recommend, explain or detect; deterministic business rules and authoritative ledgers decide.
10. **Runtime self-healing may repair runtime state only.** It must never rewrite finalized financial, inventory, invoice, regulatory or audit truth.
11. **Guardian/Watchdog detects anomalies; it does not accuse.** Every risk signal is evidence-backed, reviewable and auditable.
12. **Roadmap may sequence accepted capabilities; it may not silently delete or downgrade them.** Removal requires an explicit product decision and, where architectural, a superseding ADR.
13. **No pressure-driven shortcuts.** Deadlines never justify weakening tests, gates, tenant isolation, data integrity, financial correctness, regulatory requirements or production evidence.

## 3. Status semantics

These labels are not interchangeable:

- **ACCEPTED (A)** — belongs to the product constitution.
- **ARCHITECTED (AR)** — boundaries/invariants are defined.
- **IMPLEMENTED (I)** — code exists.
- **TESTED (T)** — required automated evidence exists.
- **PRODUCTION READY (PR)** — all applicable production gates are satisfied.
- **REGULATORY COMPLIANT (RC)** — the applicable official regulatory gate independently passed.

Architected never means implemented. Implemented never means production ready. A green CI run is evidence, not a commercial-release claim.

## 4. Business priority vs engineering criticality

Business priority:

- **B0 Launch Blocker** — required to sell/operate the intended launch product.
- **B1 Competitive Parity** — required to compete credibly in the target vertical.
- **B2 Korvi Advantage** — differentiated capability that wins switches and reduces merchant effort/risk.
- **B3 Frontier** — strategic future option that may be intentionally later.

Engineering criticality:

- **C0** — financial, regulatory, security or data-integrity authority.
- **C1** — core operational continuity/correctness.
- **C2** — business-important capability.
- **C3** — convenience/polish.

## 5. Official client experience: Installed Korvi

Installed Korvi is an accepted **B0** product requirement.

Korvi must be distributable as an installed application for at least:

- **Windows** — merchant/cashier desktop installation.
- **Android** — merchant/cashier tablet/phone installation.

A browser/PWA implementation may remain an internal technical substrate, but the customer-facing release must behave as an installed application: launch from the device, own its durable local state, work without WAN internet for the supported offline capability set, integrate safely with supported device functions, and update through a controlled/versioned path.

A merchant must not need to keep a website tab open or depend on WAN connectivity merely to continue ordinary selling during the shift.

## 6. Full-shift offline-first doctrine

The target field condition includes grocery/retail merchants whose internet may be unavailable for most or all of the working day and return only near shift end. Therefore:

1. **Full-shift offline selling is B0.** The cashier shell, required catalogue/search data, price/VAT facts, tenant/branch/terminal identity, authorized user/session state, active shift facts, local sale drafts and durable operation queue must survive WAN outage and application/device restart within the declared security policy.
2. **Reconnect may happen only at end of day.** Synchronization must not assume short outages.
3. **Nothing may be lost, duplicated or reordered.** Operations use durable identity, deterministic ordering, idempotent replay, leases/fencing where required, retry/backoff, durable outcomes and explicit reconciliation.
4. **Offline authority is capability-specific.** No operation silently claims offline support. Regulatory or business operations that legally/technically require online external authority must fail/queue/guide safely according to their governing rule; the UI must never fake completion.
5. **Conflicts are explicit.** Reconnect must surface deterministic conflict/review states rather than overwrite remote truth.
6. **Multi-terminal reality is acknowledged.** When multiple terminals can be offline simultaneously, Korvi must use a governed branch-local coordination/reservation strategy or deterministic reconciliation policy appropriate to the operation; it must never pretend cloud-global stock was exact while devices were isolated.
7. **Local state is bounded and protected.** Cache/database corruption, cross-tenant/cross-branch reuse, stale identity, tampering and unsupported schema versions fail closed.
8. **Device continuity is first-class.** Authorized recovery/replacement must preserve identity, ordering and unsynchronized-operation safety.
9. **Signed/versioned client updates and rollback safety** are required for installed releases.
10. **Real proof is mandatory.** Offline claims require actual Windows and Android process-restart/outage/reconnect evidence, not a report or mocked navigator state.

## 7. Commerce transaction core

Accepted scope includes:

- fast catalogue browse/search and barcode-first operation;
- unit and weighted quantities;
- deterministic pricing/VAT/discount allocation;
- retail, wholesale and customer/context price selection where the product plan requires it;
- deterministic promotion decisions and historical snapshots;
- cash and electronic tenders, split/mixed tender composition, reconciliation references and cash-only change rules;
- atomic checkout and immutable finalized sales;
- Arabic receipt/invoice facts and production printing paths;
- shifts, pay-in/pay-out, blind close and reconciliation;
- original-invoice full/partial returns/refunds preserving historical truth;
- separately governed no-receipt return/exchange capability;
- parked/resumable work only when it preserves deterministic operation identity and stock/financial authority;
- idempotency and audit across C0 mutations.

Tender authority is separate from PSP/payment-provider adapters. Raw card data is never application business data.

## 8. Platform Admin and merchant lifecycle

Korvi must support a real operator path for creating and administering customers without direct database work.

Platform Admin accepted scope includes:

- tenant/customer search and operational overview;
- create tenant/business with stable tenant code/identity;
- owner/business profile and plan/entitlement assignment;
- controlled initial owner-account bootstrap/invitation/reset path;
- branch, terminal/register and user/device counts;
- activation, suspension, grace/reactivation and account status;
- last activity and operational-health indicators;
- ZATCA onboarding/status visibility without exposing secrets;
- audited privileged support notes/actions;
- safe support/impersonation boundaries only if explicitly governed;
- negative authorization proving merchant administrators cannot acquire Platform authority.

A complete administrative dry run must be possible using supported UI/API flows:

**Platform Admin → create tenant → assign plan → create/bootstrap owner → create/activate branch → create/register terminal → obtain tenant code/credentials through a safe one-time path → sign in as merchant owner → configure merchant → operate cashier.**

Creating a tenant row alone does not satisfy this requirement.

## 9. Merchant administration

The merchant control experience includes real operational surfaces for:

- dashboard and exceptions;
- sales list/filter/details/customer/branch/cashier/tax/payment/status;
- products/catalogue/barcodes/categories/price facts;
- customers and customer history;
- inventory, movements, counts, adjustments and transfers;
- purchasing, suppliers, purchase orders and receiving;
- costing visibility and governed cost bootstrap/receiving where authorized;
- branches, terminals/registers and devices;
- employees/users, roles and permissions;
- reports and exports appropriate to the merchant plan;
- settings, business/VAT/receipt/vertical configuration;
- ZATCA status, failures and operational actions without leaking secrets;
- subscription/plan/entitlement visibility.

Desktop, tablet and phone layouts must preserve functional usability with true RTL, no clipped content and appropriately sized touch targets.

## 10. Inventory, purchasing and costing

Accepted scope includes:

- one stock ledger and exact balances/revisions;
- causal stock movements;
- adjustments and absolute counts with stale-revision protection;
- atomic branch transfers;
- suppliers and governed supplier metadata;
- immutable purchase-order intent;
- partial/concurrent receiving with over-receipt refusal;
- MOQ/order-multiple rules where configured;
- one costing foundation with explicit known/unknown provenance;
- sale/return/transfer/receiving cost conservation;
- branch-aware stock and, when introduced, warehouse/location modeling without forking stock truth;
- batch/lot/expiry capability for verticals that require it;
- reorder foundation that later powers explainable recommendations.

## 11. Retail and grocery competitive-parity scope

Accepted parity scope includes:

- high-throughput barcode/search cashier;
- unit, weighted and variable/scale-driven workflows where supported;
- packaging/unit/carton relationships appropriate to grocery/wholesale;
- multiple barcodes;
- retail/wholesale/customer/context price lists;
- labels/price lookup/printing where justified by the merchant workflow;
- batch/lot/expiry where required;
- coupons and deterministic promotions;
- stock counts/transfers/replenishment;
- suppliers/PO/receiving/costing;
- multi-branch visibility;
- customer balances/credit only when governed as an explicit financial capability;
- device integration for barcode scanners, supported printers and cash drawers.

## 12. Restaurant and cafe competitive-parity scope

Restaurant/cafe is an accepted vertical, not a theme switch. Accepted scope includes:

- menu/categories/products;
- modifiers/options and bundles/meals where required;
- dining modes: dine-in/takeaway/delivery;
- tables/zones/order ownership where required;
- courses/notes and split/merge rules only when architected against transaction authority;
- kitchen routing and KDS;
- waiter/server experience;
- customer/order-status display where commercially justified;
- self-service kiosk;
- QR table menu/order/pay flows where applicable;
- online ordering;
- delivery-platform adapters;
- recipes/ingredients/consumption/waste using the same stock/cost truth.

Restaurant modules may specialize workflow but never fork the financial/inventory source of truth.

## 13. Customers, loyalty and promotions

Accepted scope includes:

- customer identity/profile/search/create/edit/history;
- sales/returns behavior and branch behavior analytics;
- tags/segments;
- governed balances/credit where enabled;
- loyalty ledger and rewards;
- gift-card/wallet capability only as explicit financial ledgers, never display-only counters;
- deterministic promotion engine with eligibility, priority, exclusivity, stacking, allocation, tax/refund snapshotting and explainability;
- coupons/vouchers as governed promotion instruments.

## 14. Omnichannel, payments and integrations

Accepted scope includes:

- PSP/payment-provider adapters behind the tender boundary;
- ecommerce ingestion and stock/order mapping;
- delivery-platform adapters;
- Salla/Zid-style commerce integration seams where commercially selected;
- webhook/event infrastructure;
- external identity/mapping and replay safety;
- accounting/ERP immutable event export;
- no integration may mutate finalized internal truth except through a governed compensating business operation.

## 15. Analytics, reporting and command center

Accepted scope includes:

- sales/returns/net/VAT reporting;
- branch/cashier/product/category/customer analysis;
- stock, purchasing and cost reporting;
- profitability and contribution analysis where source facts are available;
- reconciliation/exception views;
- branch/terminal/device/integration health;
- evidence-backed alerts.

Every Command Center alert must carry: **What happened / Why / Evidence / Severity / Affected entity / Recommended next action / Deep link / State / Audit trail.**

## 16. Korvi Advantage engines

The following differentiated engines are accepted product direction. They may be sequenced after launch-parity work, but they may not disappear from the product constitution:

1. **Migration Engine** — import, mapping, cleaning, deduplication, preview, dry run, reconciliation and safe cutover from incumbent systems.
2. **Korvi Product Knowledge** — governed shared/national product knowledge separate from tenant stock, with provenance, confidence, versioning and merchant override; grocery catalogue may be intentionally text-first/no-image where that improves speed.
3. **Explainable Reorder** — recommendation using sales velocity, lead time, safety stock, MOQ/order multiple, stock and evidence; recommendation is not an autonomous purchase authority.
4. **Expiry Intelligence** — batch/expiry risk, aging, approaching-expiry attention and explainable action suggestions.
5. **Branch Rebalancing** — evidence-based transfer recommendations across branches without bypassing transfer authority.
6. **Korvi Watchdog / Guardian** — anomaly detection for suspicious operational patterns, voids/returns/discounts/cash/inventory/attendance-style signals where lawful and configured; evidence-backed, privacy-aware, reviewable and non-accusatory.
7. **Profitability Intelligence** — true profit/contribution views using trusted cost/revenue facts and explicit unknowns.
8. **Pricing Assistant** — explainable recommendations using trusted cost/margin/market inputs; never silently changes authoritative prices.
9. **Attention Center / Management by Exception** — prioritized exceptions with evidence and direct remediation paths.
10. **Liquid Cashier / Device Continuity** — authorized recovery on another device without losing or duplicating pending operations.
11. **Safe Operational Recovery** — self-repair/retry/rebuild of runtime state without rewriting financial/stock/regulatory truth.
12. **Supplier Network** — governed supplier identity/mapping seams leading to future network/B2B supply ordering after merchant core is stable.

## 17. Commercial subscription and operations

Minimum sellable commercial control includes plan identity/revision, assignment dates, active/suspended/grace states, entitlements, branch/device/user allowances where sold, deterministic expiry/suspension behavior and audited changes. Manual billing is acceptable initially if commercial truth remains explicit; fake or implicit entitlement state is not.

Support must use structured issue intake, least-privilege audited access, no password sharing and basic user/operator runbooks.

## 18. ZATCA doctrine

ZATCA is a standing parallel release gate. Local TLV/QR, UBL/XML, hashing, signing, SDK/validator evidence, retry queues and submission state each contribute evidence; none alone authorizes a Phase 2 compliance claim.

Offline behavior must follow the exact current regulatory/business rule for each invoice flow. If external clearance/reporting authority is required, the product must queue/refuse/guide honestly rather than display a false success state.

## 19. UX and design authority

Korvi must look and behave like a serious commercial SaaS/product, not an internal prototype.

- Arabic/RTL is first-class.
- IBM Plex Sans Arabic is the interface-family baseline; IBM Plex Mono is used where numeric/technical alignment benefits.
- Design tokens, spacing, radius, hierarchy and status colors are centralized; random component-level hex values are forbidden.
- Cashier UX prioritizes speed, scanner/keyboard/touch operation and minimal cognitive load.
- Retail UX and restaurant UX may diverge substantially where workflow requires it.
- Mobile/tablet/desktop are real test targets.
- Core actions target at least 44px touch affordance where appropriate.
- Refresh preserves logical location; key records support usable deep links/back/forward behavior.
- Loading, empty, error, offline, syncing, conflict and success states are deliberate and understandable.

## 20. Product-completion and release-truth rule

Three completion statements must never be conflated:

1. **Release-gate readiness** — the current named release denominator only.
2. **Commercial V1 product completeness** — every capability explicitly designated for the current sellable V1 is implemented, tested and human-accepted as required.
3. **Master Product Vision completeness** — the broader accepted multi-vertical and Korvi-advantage constitution, including capabilities intentionally sequenced after initial V1.

`Korvi مكتمل ✅` / `Korvi Complete ✅` may not be used as a blanket statement while the scope intended by that statement still contains known missing accepted capabilities or unresolved C0/C1 blockers. If external paid production resources, final domain cutover or launch-day human acceptance are intentionally deferred by executive decision, that deferral must be stated explicitly rather than silently counted as completed.

## 21. Product governance

The five controlling sources of truth are:

1. `KORVI-MASTER-PRODUCT-DIRECTIVE.md` — what Korvi is and what belongs to it.
2. `KORVI-CAPABILITY-MATRIX.md` — current capability status, evidence, gaps and dependencies.
3. `KORVI-ARCHITECTURE-MAP.md` — authority/domain boundaries and allowed technical shapes.
4. `KORVI-RELEASE-GATES.md` — what evidence is required before production claims.
5. `KORVI-ROADMAP.md` — execution order only; it may never delete accepted scope.

Competitor claims used for product decisions must record source/date/vertical/commercial relevance. Capability tracking must include owner/domain, dependencies, definition of done and release gates.

The legacy strategy document under `docs/governance/Korvi_POS_Master_Strategy_Document.txt` is an input, not executable authority. Where it conflicts with current code, accepted ADRs, official requirements or this constitution, the conflict is resolved explicitly. In particular, legacy language advocating destructive database repair, force-push shortcuts or rewriting business truth is superseded by the current safety, migration and immutable-history doctrines.
