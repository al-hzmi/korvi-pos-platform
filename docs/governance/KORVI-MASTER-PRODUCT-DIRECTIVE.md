# KORVI POS — Master Product Directive

Status: **ACCEPTED PRODUCT CONSTITUTION**
Authority: product direction and accepted capability scope.
Engineering invariants remain governed by `CLAUDE.md`, `AGENTS.md`, accepted ADRs, and mechanical release gates.

## 1. Product identity

Korvi POS is a sellable, independently operable point-of-sale platform for retail and restaurants. It is also the architectural spearhead for a future Korvi ERP, but ERP does not exist yet and Korvi POS must not depend on it. POS owns operational commerce; a future ERP may consume Korvi's immutable business and financial events and map them to accounting/GL without forcing POS to become an ERP.

North star: **One Platform — One Truth — Multiple Experiences.**

Korvi is not a feature dump. It is a unified business operating platform whose capabilities share one tenant model, one transaction truth, one inventory truth, one permission model, one audit model, and one release discipline.

## 2. Product principles

1. **Financial truth is sacred.** Money uses integer minor units; no float-based authority, no hidden rounding, no client-supplied financial truth.
2. **Regulatory claims are gated.** ZATCA compliance is a release gate, not a marketing feature. QR/TLV/XML/hash/signature/SDK evidence alone is not permission to claim Phase 2 compliance.
3. **One stock truth.** Retail, grocery, restaurant, purchasing, returns, and future omnichannel flows must converge on one inventory authority and one costing foundation.
4. **Operational continuity is designed, not improvised.** Offline/continuity capability is explicit per operation; no capability may silently claim offline support.
5. **Security and tenancy are structural.** Tenant isolation, RLS, authorization, non-enumeration, idempotency, and auditability are release properties.
6. **Determinism beats convenience.** Pricing, promotions, tax, allocation, returns, tender composition, close/reconciliation, and numbering must be deterministic and explainable.
7. **Vertical experiences may differ; truth may not.** Retail/grocery and restaurant UX can diverge while sharing the same transaction, inventory, identity, security, and audit foundations.
8. **Runtime self-healing may repair runtime state only.** It must never silently rewrite finalized financial, inventory, invoice, or audit truth.
9. **Guardian detects anomalies; it does not accuse.** Risk signals must be evidence-based and reviewable.
10. **Roadmap may defer an accepted capability; it may not delete it.** Removal requires an explicit product decision and, where architectural, an ADR.

## 3. Status semantics

These labels are not interchangeable:

- **ACCEPTED** — belongs to the product constitution.
- **ARCHITECTED** — boundaries and invariants are defined.
- **IMPLEMENTED** — code exists.
- **TESTED** — required automated evidence exists.
- **PRODUCTION READY** — production release gates are satisfied.
- **REGULATORY COMPLIANT** — the applicable regulatory gate has independently passed.

A capability may be ACCEPTED and deferred. ARCHITECTED never means IMPLEMENTED. IMPLEMENTED never means PRODUCTION READY. ZATCA-related functionality is never called REGULATORY COMPLIANT until the full current official gate passes.

## 4. Business priority vs criticality

Business priority and engineering criticality are separate axes.

- **B0 Launch Blocker** — required to sell/operate the intended launch product.
- **B1 Competitive Parity** — required to compete credibly in the target vertical.
- **B2 Korvi Advantage** — differentiated capability that can win switches.
- **B3 Frontier** — strategic future option.

Engineering criticality:

- **C0** — financial, regulatory, security, or data-integrity authority.
- **C1** — core operational continuity or correctness.
- **C2** — business-important capability.
- **C3** — convenience/polish.

B0 does not automatically mean C0, and C0 does not automatically mean B0.

## 5. Accepted product domains

### Commerce transaction core

Catalogue/browse/search; cart; unit and weighted quantity; pricing; VAT; deterministic discounts; tender composition; checkout; immutable finalized sale; receipt/invoice facts; returns/refunds; shifts; manual drawer movement; close/reconciliation; idempotency; audit.

### SaaS control plane

Tenant provisioning and lifecycle; branch/terminal identity; user/membership/role administration; tenant settings; plan/subscription entitlement foundation; account status; safe suspension/reactivation; onboarding; operational tenancy observability.

### Inventory and purchasing

One stock ledger; adjustments; stock movement causality; counting; transfers; reorder foundation; suppliers; purchase orders; receiving; MOQ/multiple rules; one costing foundation; restaurant ingredient/recipe deductions as a specialized domain over the same stock truth.

### Retail and grocery

Barcode-first high-throughput selling; weighted items; labels/price lookup as justified; shelf/stock workflows; batch/expiry where required; fast catalogue operations; branch-aware stock.

### Restaurant and cafe

Menu/categories; modifiers; dining modes; table/order boundaries where required; kitchen routing/KDS; courses/notes; split/merge rules only when architected against the transaction authority. Restaurant boundaries are reserved early; empty speculative abstractions are forbidden.

### Customer, loyalty, and promotions

Customer identity; loyalty ledger; rewards; segmentation; deterministic promotion engine with eligibility, priority, exclusivity, stacking, allocation, tax/refund snapshotting, and explainability.

### Omnichannel and integrations

External order ingestion; ecommerce/delivery integration adapters; payment-provider adapters; accounting/ERP event export; webhooks/events; integration identity/mapping; no sensitive card-number storage.

### Analytics and command center

Operational dashboards; reports; evidence-backed alerts; branch/terminal health; reconciliation/exception views. Every command-center alert must carry evidence, severity, reason, affected entity, next action/deep link, state, and audit trail.

### Korvi advantage engines

Migration engine; Product Knowledge Layer/national catalogue; Operational Intelligence; Device Continuity; Command Center; governed anomaly detection (Guardian); supply-network foundation. Product Knowledge is independent from tenant inventory and must have explicit provenance/governance.

### Supply network

Supplier identity; external mappings; transaction/event hooks; future B2B ordering and supply hub. Functionality is late, but identity/mapping/event seams are seeded without building speculative supplier-network business logic too early.

## 6. Financial and operational boundaries

POS must emit immutable business/financial events and snapshots. A future ERP may map these to journal entries and GL, but POS does not become the general ledger.

Tender domain is separate from PSP/payment-provider adapters. Korvi stores only the minimum references needed for reconciliation and never treats raw card data as application business data.

Original-invoice returns and no-receipt returns are separate business capabilities with different authority and fraud/risk implications; one must not be faked as the other.

Promotion decisions must be snapshotted so later rule edits cannot rewrite historical sale/refund truth.

## 7. Offline and continuity doctrine

Offline support is declared by capability level, not by slogan. The target is that authorized selling capabilities can continue without network and reconcile afterward with nothing lost, duplicated, or reordered. UUIDv7 and idempotency are foundations, not the entire offline solution.

A device-continuity path may restore service on another device, but it must preserve identity, authorization, transaction ordering, and unsynchronized-operation safety.

## 8. ZATCA doctrine

ZATCA is a standing parallel release gate. Building local TLV/QR, XML, hashing, signing, SDK validation, retry queues, or invoice-state tracking contributes evidence; none alone authorizes a Phase 2 compliance claim.

The gate must cover the then-current official business, technical, security, invoice, onboarding/integration, reporting/clearance, failure/retry, and end-to-end requirements. Solution Provider qualification is a separate later commercial/official process after technical compliance readiness.

## 9. Product governance

Competitor claims used for decisions must record source, date, vertical, and commercial importance. Capability tracking must include owner/domain, dependencies, definition of done, release gates, and deprecation/removal decisions.

The strategy document under `docs/governance/Korvi_POS_Master_Strategy_Document.txt` is an input, not executable authority. Where it conflicts with current code, accepted ADRs, current official requirements, or this constitution, the conflict is resolved explicitly rather than silently copied.
