# KORVI POS — Capability Matrix

Status: **LIVING EXECUTIVE CONTROL MATRIX**
Purpose: prevent accepted capabilities from disappearing while keeping implementation sequencing disciplined.

Legend: `A` Accepted, `AR` Architected, `I` Implemented, `T` Tested, `PR` Production Ready, `RC` Regulatory Compliant, `—` not yet claimed.

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| Integer-money/VAT/allocation core | B0 | C0 | A/AR/I/T | `@korvi/domain` | Financial, Test |
| UUIDv7 deterministic identifiers | B0 | C0 | A/AR/I/T | Domain | Data Integrity, Offline |
| Tenant isolation + RLS | B0 | C0 | A/AR/I/T | Database/Security | Security, Live DB |
| Auth/RBAC/session authority | B0 | C0 | A/AR/I/T | API/Domain | Security |
| Product read/search/browse | B0 | C1 | A/AR/I/T | POS/API | Performance, UX |
| Unit + weighted quantity | B0 | C0 | A/AR/I/T | Domain/POS | Financial, Test |
| Pricing/discount authority | B0 | C0 | A/AR/I/T | Domain/API | Financial, Security |
| Tender composition/cash-only change | B0 | C0 | A/AR/I/T | Domain/API | Financial |
| Checkout/finalized sale | B0 | C0 | A/AR/I/T | API/Database | Financial, Live DB |
| Arabic thermal printing foundation | B0 | C1 | A/AR/I/T, production profile coverage incomplete | Printing | Device, Arabic, Production |
| Cash shift open | B0 | C0 | A/AR/I/T | API/Database | Financial, Live DB |
| Cash settlement foundation | B0 | C0 | A/AR/I/T | Domain/API/DB | Financial, Live DB |
| Returns/refunds against original sale | B0 | C0 | A/AR/I/T | Domain/API/DB | Financial, Live DB |
| Manual pay-in/pay-out | B0 | C0 | A/AR/I/T | Domain/API/DB | Financial, Security, Live DB |
| Blind shift close/reconciliation | B0 | C0 | A/AR/I/T | Domain/API/DB | Financial, Live DB |
| Control dashboard foundation | B0 | C1 | A/AR/I/T | POS/API | Security, Performance |
| SaaS tenant provisioning/lifecycle | B0 | C0 | A/AR/I/T; no control-plane transport or UI yet, so not PR | Control Plane | Security, Data Integrity, Production |
| Subscription/plan entitlement foundation | B0 | C1 | A/AR/I/T; stable plan identity, immutable assignments, deterministic fail-closed evaluator, account state, RLS/idempotency/rollback/concurrency live DB proof; no billing provider or universal enforcement, not PR | Control Plane | Security, Commercial |
| Onboarding/settings administration | B0 | C1 | A/AR/I/T; evidence-derived readiness, authenticated readiness API and guided onboarding UI established through 4D; no fake persisted completion state; not PR | Control Plane/POS | Security, UX |
| User/membership administration UI/API | B0 | C0 | A/AR/I/T for authority and administration UI through 4B; 4D adds signed one-time initial-owner credential bootstrap with replay/concurrency/rollback proof, but general staff invitation/recovery remains outstanding; not PR | Control Plane/Auth | Security, Audit |
| Branch/terminal administration | B0 | C1 | A/AR/I/T for authority and administration UI through 4B; onboarding readiness consumes live active branch/terminal truth through 4D; not yet PR | Control Plane | Security, Operations |
| Product write/catalogue management | B0 | C1 | A/AR/I/T for the minimal audited onboarding product bootstrap authority through 4D; full catalogue management remains deferred | Inventory/Catalogue | Audit, UX |
| Stock ledger/adjustments | B0 | C0 | A/AR/I/T through 5A; authoritative balances, revisions, movements, adjustments, counts, idempotency, RLS and live concurrency/rollback proof established | Inventory/DB | Data Integrity, Live DB |
| Transfers/counting | B1 | C1 | A/AR/I/T through 5A; atomic branch transfers and stale-safe absolute counts established; operational UI belongs to active 5D | Inventory | Data Integrity, UX |
| Suppliers/PO/receiving | B1 | C1 | A/AR/I/T through 5B; immutable PO intent, partial receiving, exact accumulators, atomic stock effects and live over-receipt/rollback proof established; operational UI belongs to active 5D | Purchasing | Data Integrity, Audit, UX |
| Costing foundation | B1 | C0 | A/AR/I/T through 5C; explicit unknown provenance, exact valuation conservation, sale/return/transfer/receiving basis and prospective bootstrap authority established; cost UX belongs to active 5D | Inventory/Domain | Financial, Live DB, Security |
| Inventory & purchasing operational UX | B1 | C1 | A/AR; bounded 5D contract accepted, implementation active beginning with branch stock read; no stock or cost authority in the browser | POS/Inventory/Purchasing | UX, Security, Performance |
| Offline transaction continuity | B0 | C0/C1 | A/AR foundation; not PR | Offline/Device | Offline, Security, Data Integrity |
| Device continuity/recovery | B2 | C1 | A | Device Continuity | Offline, Security, Production |
| ZATCA Phase 1 invoice/QR facts | B0 | C0 | A/AR/I/T foundation | Compliance/Printing | ZATCA |
| ZATCA Phase 2 end-to-end | B0 | C0 | A; **RC not claimed** | Compliance | Full ZATCA Gate |
| Retail/grocery vertical UX | B1 | C1 | A | POS | UX, Performance, Device |
| Restaurant/menu/modifiers foundation | B1 | C1 | A | Restaurant | UX, Data Integrity |
| KDS/kitchen routing | B1 | C1 | A | Restaurant | Operational, Offline |
| Customer management | B1 | C2 | A; basic permissions exist | CRM | Security, Privacy |
| Loyalty ledger | B1 | C0/C1 | A | Loyalty/Domain | Financial, Data Integrity |
| Promotion engine | B1 | C0 | A/AR principles | Domain | Financial, Explainability |
| No-receipt return | B1 | C0 | A; distinct from original-sale return | Returns/Risk | Financial, Security, Audit |
| PSP/payment adapters | B1 | C0 | A | Integrations | Security, Financial |
| Ecommerce/delivery adapters | B1 | C1 | A | Integrations | Idempotency, Offline, Operations |
| Analytics/reporting | B1 | C1/C2 | A; dashboard foundation exists | Analytics | Data Integrity, Performance |
| Command Center alerts | B2 | C1 | A/AR principles | Intelligence | Evidence, Audit |
| Guardian anomaly detection | B2 | C1 | A/AR principles | Intelligence/Risk | Explainability, Privacy |
| Migration engine | B2 | C1 | A | Migration | Data Integrity, Reconciliation |
| Product Knowledge Layer/national catalogue | B2 | C1 | A; global catalogue exception exists | Product Knowledge | Provenance, Governance |
| Supply-network identity/mapping seams | B2 | C1 | A | Supply | Security, Integration |
| B2B supply ordering/network | B3 | C1/C2 | A; functionally late | Supply | Commercial, Integration |
| Future POS→ERP event export | B2 | C0 | A/AR boundary only | Events/Integration | Financial, Data Integrity |

## Definition-of-done rule

Every new row moved to `I` must identify code ownership and tests. Every move to `PR` must identify all release gates passed. Every move to `RC` must cite the regulatory gate evidence. A roadmap deferment changes schedule, not acceptance.
