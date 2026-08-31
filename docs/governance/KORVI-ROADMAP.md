# KORVI POS — Execution Roadmap

Status: **ACTIVE SEQUENCING DOCUMENT**
Rule: roadmap can defer accepted capabilities; it cannot delete them.

## Completed foundation through current main

The repository has established the platform/domain foundation, strict money and quantity rules, identifiers, tenancy/RLS, authentication/RBAC, cashier server and UI foundations, settlement, commercial dashboard foundation, original-sale returns/refunds, shift close/cash-drawer reconciliation, and the substantially established SaaS control plane through Stage 4. These are engineering milestones, not a claim that the whole product is launch-ready or ZATCA Phase 2 compliant.

## Execution order

### Stage 1 — Foundation Integrity — substantially established

Money/quantity/tax invariants, pure domain, UUIDv7, tenant isolation, migrations, auth/RBAC, audit, printing foundation, automated verification.

### Stage 2 — Commercial Transaction Core — substantially established

Checkout, tender settlement, sale persistence, cashier experience foundation, original-sale returns/refunds, cash movements, blind close/reconciliation. Remaining work in this stage is completed only when later UI/printing/compliance dependencies for each operation are delivered.

### Stage 3 — Product Constitution — substantially established

Adopt the five governance documents: Master Product Directive, Capability Matrix, Architecture Map, Release Gates, Roadmap. They become the anti-drift control layer before expanding product breadth.

### Stage 4 — SaaS Control Plane — **SUBSTANTIALLY ESTABLISHED**

Sequence:

1. **4A Tenant Lifecycle & Provisioning Authority** — **substantially established.** Lifecycle states, provisioning transaction, safe activation/suspension/reactivation rules, idempotency, RLS/security, audit and live DB proof are in place (ADR-0018). It is backend authority only: no control-plane transport or operator identity model, so the capability is not yet production ready.
2. **4B Control-Plane Administration — substantially established.**
   - **4B-1 Merchant administration authority — substantially established.** Server authority and authenticated API for tenant settings, branches, terminals, users/memberships and role assignment, with session-invalidation and last-administrator protection proved against live PostgreSQL (ADR-0019).
   - **4B-2 Merchant administration UI — substantially established.** Settings, branches, terminals, members, roles and permissions screens operate over the 4B-1 authority and add no independent authority. General staff credential/invitation lifecycle remains outside this milestone, so the capability is not yet production ready.
3. **4C Plan/Entitlement Foundation — substantially established.** Stable `(planKey, planRevision)` identity, immutable assignment snapshots, deterministic entitlement evaluation, orthogonal commercial account state, RLS, audit, idempotency, rollback and concurrency proof are established (ADR-0020). No payment/billing provider, merchant plan-write surface or universal route enforcement is claimed, so this is not production ready.
4. **4D Onboarding — substantially established.** Evidence-derived readiness authority and authenticated readiness API, one-time signed initial-owner bootstrap, minimal audited product bootstrap authority, and guided merchant onboarding UI are implemented and tested (ADR-0021 through ADR-0023). Readiness is derived from live tenant/settings/branch/terminal/administrator/product truth; no persisted fake completion flag exists. Initial owner bootstrap is permanently closed after successful consumption and is not a recovery flow. General staff credential invitation/recovery, control-plane operator transport, billing/provider activation and Production Operations remain separate work, so 4D is not by itself a Production Ready claim.

### Stage 5 — Inventory & Purchasing Foundation — **IN PROGRESS**

One stock ledger and causality model; adjustments/counts/transfers; supplier/PO/receiving; MOQ/multiple rules; costing foundation; branch stock. Preserve current sale/return semantics during migration. ADR-0024 defines the authority boundary.

Sequence:

1. **5A Stock Ledger Integrity — substantially established.** Balance revision, authoritative adjustments, concurrency-safe absolute counts, atomic branch transfers, idempotency, audit, strict RLS and sale/return regression proof are implemented and proved against live PostgreSQL. C0 data-integrity strike, reviewed and closed.
2. **5B Purchasing & Receiving — substantially established.** Suppliers, immutable purchase orders, partial receiving and receipt-to-stock atomicity are implemented and proved against live PostgreSQL. Purchase orders do not mutate stock; accepted receipts do. Over-receipt is refused under concurrency while PO-line locks are held.
3. **5C Costing Authority — substantially established.** Exact integer valuation, explicit unknown historical provenance, deterministic remainder conservation, sale-line cost-basis freeze, original-sale return restoration, transfer conservation, valued receiving and prospective bootstrap authority are implemented and proved against fresh and occupied PostgreSQL. Independent C0 review and the Human Gate closed the strike at `600373c`.
4. **5D Inventory & Purchasing UX — delivered; closure gates pending.** Branch stock read, retry-safe stock commands, purchasing/partial-receiving workflows and separately permissioned cost affordances are implemented and verified at one delivered HEAD. The UI does not become stock/cost authority. Independent review, actual visual-browser evidence and the Human Gate remain open, so the strike is not yet closed and no progress increase is claimed — see `docs/architecture/STRIKE-5D-INVENTORY-PURCHASING-UX.md`.

### Stage 6 — Offline & Device Continuity

Capability-level offline contract; local durable queue; sync state machine; conflict/idempotency proof; device recovery. Release claims only after Offline Gate passes.

### Stage 7 — Retail/Grocery Vertical

Barcode-first acceleration, weighted workflows, grocery-specific inventory/expiry/label needs justified by product discovery, high-volume performance.

### Stage 8 — Restaurant Vertical

Menu/modifiers and restaurant order boundaries first, then kitchen routing/KDS and additional service workflows. Do not fork financial/inventory authority.

### Stage 9 — Customer, Loyalty & Promotions

Customer model, loyalty ledger, deterministic promotion engine, snapshot/refund semantics, segmentation and retention surfaces.

### Stage 10 — Omnichannel & Integrations

PSP adapters, ecommerce/delivery ingestion, integration mapping/idempotency, future accounting/ERP event export.

### Stage 11 — Analytics & Command Center

Operational reporting, exception/reconciliation views, evidence-backed alerts, branch/device health, governed Guardian anomaly signals.

### Stage 12 — Korvi Advantage Engines

Migration engine; Product Knowledge/national catalogue; Device Continuity enhancements; Operational Intelligence; premium Command Center capabilities.

### Stage 13 — Supply Network

Supplier-network workflows and B2B supply ordering after core merchant operations and integration identity are proven.

## Parallel gates across every stage

Security/Tenancy, Financial Integrity, Data/Migration, ZATCA, Offline/Continuity, Performance, Device/Printing, UX, Production Operations, Commercial Truth.

## Immediate execution rule under constrained AI quota

Expensive implementation-agent quota is reserved for bounded C0/C1 strikes. Architecture, scope decomposition, acceptance criteria, documentation, review, test planning, and DevOps orchestration are performed outside that quota. A strike prompt must be small enough to finish in one implementation pass plus at most one correction pass without reducing system quality.
