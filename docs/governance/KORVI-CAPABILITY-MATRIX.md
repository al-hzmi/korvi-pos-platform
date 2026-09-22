# KORVI POS — Capability Matrix

Status: **LIVING EXECUTIVE CONTROL MATRIX**
Purpose: prevent accepted capabilities from disappearing while keeping implementation sequencing disciplined.

Legend: `A` Accepted, `AR` Architected, `I` Implemented, `T` Tested, `PR` Production Ready, `RC` Regulatory Compliant, `—` not yet claimed.

Important: a row may carry `I/T` while still being incomplete as a sellable workflow. Caveats in the status cell are authoritative. `PR` is only claimed after all mandatory gates pass.

## A. Financial / transaction truth

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| Integer-money/VAT/allocation core | B0 | C0 | A/AR/I/T | `@korvi/domain` | Financial, Test |
| UUIDv7 deterministic identifiers | B0 | C0 | A/AR/I/T | Domain | Data Integrity, Offline |
| Pricing/discount authority | B0 | C0 | A/AR/I/T | Domain/API | Financial, Security |
| Tender composition/cash-only change | B0 | C0 | A/AR/I/T; product UX still needs broader electronic/split-flow proof | Domain/API/POS | Financial, UX |
| Checkout/finalized sale | B0 | C0 | A/AR/I/T | API/Database | Financial, Live DB |
| Immutable sale/invoice snapshots | B0 | C0 | A/AR/I/T | Domain/DB | Financial, Data Integrity |
| Original-sale returns/refunds | B0 | C0 | A/AR/I/T | Domain/API/DB | Financial, Live DB |
| No-receipt return / exchange | B1 | C0 | A; distinct authority not yet claimed implemented | Returns/Risk | Financial, Security, Audit |
| Shift open/lifecycle | B0 | C0 | A/AR/I/T | API/Database | Financial, Live DB |
| Manual pay-in/pay-out | B0 | C0 | A/AR/I/T | Domain/API/DB | Financial, Security, Live DB |
| Blind close/reconciliation | B0 | C0 | A/AR/I/T | Domain/API/DB | Financial, Live DB |
| Historical product/price/tax truth | B0 | C0 | A/AR/I/T | Domain/DB | Financial, Returns |
| Unknown-cost provenance | B0/B1 | C0 | A/AR/I/T | Costing | Financial, Data Integrity |

## B. Security / tenancy / SaaS control plane

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| Tenant isolation + FORCE-RLS | B0 | C0 | A/AR/I/T | Database/Security | Security, Live DB |
| Auth/RBAC/session authority | B0 | C0 | A/AR/I/T | API/Domain | Security |
| Audit trail / privileged-action audit | B0 | C0/C1 | A/AR/I/T foundation | API/DB | Security, Audit |
| SaaS tenant provisioning/lifecycle | B0 | C0 | A/AR/I/T authority; operator workflow is being completed in Product P0 | Control Plane | Security, Data Integrity, Production |
| Platform Admin tenant search/overview | B0 | C1 | A; active Product P0 branch contains real platform routes/surfaces, final release proof pending | Platform | Security, UX, Production |
| Platform Admin create tenant/business | B0 | C0/C1 | A; end-to-end supported operator flow must be proven, DB/manual-only creation is insufficient | Platform | Security, Audit, E2E |
| Platform Admin plan/entitlement assignment | B0 | C1 | A/AR/I/T foundation; final operator flow/enforcement proof pending | Control Plane | Security, Commercial |
| Platform Admin owner bootstrap/invitation | B0 | C0 | A/AR/I/T one-time initial-owner bootstrap foundation; complete UI/operator lifecycle and recovery boundaries remain open | Control Plane/Auth | Security, Audit, E2E |
| Platform Admin activate/suspend/reactivate | B0 | C0/C1 | A/AR/I/T lifecycle authority; final UI/E2E proof pending | Control Plane | Security, Audit |
| Platform Admin ZATCA/health visibility | B0/B1 | C1 | A; must expose status without secrets | Platform/Compliance | Security, UX |
| Merchant settings administration | B0 | C1 | A/AR/I/T foundation | Merchant Admin | Security, UX |
| Branch administration | B0 | C1 | A/AR/I/T foundation | Merchant Admin | Security, Operations |
| Terminal/register/device administration | B0 | C1 | A/AR/I/T foundation | Merchant Admin | Security, Device |
| User/membership administration | B0 | C0 | A/AR/I/T authority/UI foundation; general invitation/recovery still incomplete | Auth/Admin | Security, Audit |
| Role/permission administration | B0 | C0 | A/AR/I/T foundation | Auth/Admin | Security, Negative tests |
| Subscription/plan entitlement foundation | B0 | C1 | A/AR/I/T; billing provider/manual commercial operation separate | Control Plane | Commercial, Security |
| Grace/suspension/expiry behavior | B0 | C0/C1 | A/AR foundation; complete commercial enforcement proof required | Control Plane | Commercial, Security |
| Guided merchant onboarding/readiness | B0 | C1 | A/AR/I/T foundation | Control Plane/POS | Security, UX |
| End-to-end customer provisioning dry run | B0 | C1 | A; must prove Platform Admin → tenant → owner → branch → terminal → merchant login → cashier | Platform/Onboarding | E2E, Security, UX |

## C. Installed Korvi / Offline / Device continuity

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| Windows installed application | B0 | C1 | A; official installed release artifact and real-device proof not yet claimed | Client/Device | Installed App, Offline, Security, Device |
| Android installed application | B0 | C1 | A; official installed release artifact and real-device proof not yet claimed | Client/Device | Installed App, Offline, Security, Device |
| Full-shift WAN-offline cashier operation | B0 | C0/C1 | A/AR/I/T foundations and browser proof exist; 8–12h installed-client proof still required | Offline/POS | Offline, Installed App, Financial |
| Offline application shell/assets | B0 | C1 | A/AR/I/T via Service Worker/browser proof; installed bundle proof pending | Offline/Client | Offline, Installed App |
| Durable local catalogue/search | B0 | C1 | A/AR/I/T browser/IndexedDB foundation; installed-client persistence proof pending | Offline/Catalogue | Offline, Data Integrity |
| Durable sale draft state | B0 | C1 | A/AR/I/T foundation | Offline/POS | Offline, Recovery |
| Durable ordered transaction queue | B0 | C0/C1 | A/AR/I/T | Offline | Offline, Financial |
| Sync retry/backoff/fencing/idempotency | B0 | C0/C1 | A/AR/I/T | Offline/API | Offline, Financial |
| Offline conflict/reconciliation workflow | B0 | C0/C1 | A/AR/I/T core proof; product UX requires final installed-client verification | Offline/POS | Offline, UX |
| End-of-day reconnect synchronization | B0 | C0/C1 | A; must prove full-shift backlog sync with no loss/duplication/reordering | Offline/API | Offline, Live DB |
| Multi-terminal offline coordination policy | B0/B1 | C0/C1 | A; exact strategy must be architected and proved per operation | Offline/Inventory | Offline, Data Integrity |
| Device continuity / authorized recovery | B1/B2 | C1 | A; full workflow not yet claimed implemented | Device Continuity | Offline, Security, Production |
| Signed/versioned app update + rollback safety | B0 | C1 | A; not yet claimed | Client/Release | Security, Production |
| Local corruption/schema-version refusal | B0 | C0/C1 | A/AR/I/T foundation in offline stores | Offline | Data Integrity, Security |
| Barcode scanner integration | B0 | C1 | A/I foundation through POS input; real installed hardware profiles required | Device/POS | Device, UX |
| Thermal printer integration | B0 | C1 | A/AR/I/T Arabic production-byte foundation; real installed-device profiles remain | Printing/Client | Device, Arabic, Production |
| Cash drawer integration where supported | B1 | C1 | A; real hardware profile not yet claimed | Device | Device, Production |

## D. Retail / grocery / catalogue / cashier parity

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| Product read/search/browse | B0 | C1 | A/AR/I/T | POS/API | Performance, UX |
| Product write/catalogue management | B0 | C1 | A/AR/I/T minimal onboarding authority; full catalogue management incomplete | Catalogue | Audit, UX |
| Multiple barcodes | B1 | C1 | A/AR/I/T schema/foundation | Catalogue | Data Integrity, UX |
| Unit + weighted quantity | B0 | C0 | A/AR/I/T | Domain/POS | Financial, Test |
| Physical scale workflow/integration | B1 | C1 | A; not yet claimed implemented | Device/Retail | Device, UX, Financial |
| Packaging/unit/carton hierarchy | B1 | C1 | A; not yet claimed complete | Catalogue/Retail | Data Integrity, UX |
| Retail/wholesale/customer price lists | B1 | C0 | A; pricing core exists, complete price-list product not yet claimed | Pricing | Financial, UX |
| Coupons/vouchers | B1 | C0 | A; promotion engine dependency | Promotions | Financial, Explainability |
| Deterministic promotion engine | B1 | C0 | A/AR principles; full implementation not yet claimed | Domain/Promotions | Financial, Explainability |
| Label/price lookup/printing | B1 | C1 | A; not yet claimed complete | Retail/Printing | Device, UX |
| Batch/lot/expiry | B1 | C1 | A; not yet claimed implemented | Inventory/Retail | Data Integrity, UX |
| High-volume grocery performance | B1 | C1 | A; representative catalogue/load proof required | POS/API/DB | Performance |
| Retail/grocery specialized UX | B1 | C1 | A; cashier foundation exists but full vertical parity not yet claimed | POS | UX, Performance, Device |

## E. Inventory / purchasing / costing

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| Stock ledger/balances | B0 | C0 | A/AR/I/T | Inventory/DB | Data Integrity, Live DB |
| Adjustments | B0 | C0 | A/AR/I/T | Inventory | Data Integrity, Audit |
| Absolute counts + stale revision protection | B0 | C0 | A/AR/I/T | Inventory | Data Integrity, Concurrency |
| Branch transfers | B1 | C1 | A/AR/I/T | Inventory | Data Integrity, UX |
| Inventory operational UX | B0/B1 | C1 | A/AR/I/T; independent/Human Gate still required for closure | POS/Inventory | UX, Security, Performance |
| Supplier management | B1 | C1 | A/AR/I/T basic supplier identity; rich commercial/contact/terms model incomplete | Purchasing | Audit, UX |
| Purchase orders | B1 | C1 | A/AR/I/T | Purchasing | Data Integrity, Audit |
| Partial/concurrent receiving | B1 | C1 | A/AR/I/T | Purchasing | Data Integrity, Live DB |
| MOQ/order multiples | B1 | C1 | A; accepted, complete product enforcement not yet claimed | Purchasing | Data Integrity, UX |
| Costing foundation | B1 | C0 | A/AR/I/T | Costing/Domain | Financial, Live DB |
| Purchasing/costing operational UX | B1 | C1 | A/AR/I/T; independent/Human Gate remains | POS/Purchasing | UX, Security |
| Warehouses/locations independent of branches | B1/B2 | C1 | A; not yet claimed implemented | Inventory | Data Integrity, UX |
| Reorder foundation | B1/B2 | C1 | A; later feeds Explainable Reorder | Inventory/Intelligence | Data Integrity, Explainability |

## F. Customers / loyalty / promotions

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| Customer profile/search/create/edit | B1 | C2 | A/AR/I/T basic product/API/UI evidence exists | CRM | Security, Privacy, UX |
| Customer sales history | B1 | C2 | A/AR/I/T recent-sales foundation | CRM/Reports | Privacy, UX |
| Customer analytics/branch behavior | B1 | C2 | A; not yet claimed complete | CRM/Analytics | Data Integrity |
| Customer tags/segments | B1 | C2 | A; not yet claimed | CRM | Privacy, UX |
| Customer credit/balance | B1 | C0 | A; explicit financial ledger required before implementation claim | CRM/Finance | Financial, Audit |
| Loyalty ledger/rewards | B1 | C0/C1 | A; not yet claimed implemented | Loyalty/Domain | Financial, Data Integrity |
| Gift card / merchant wallet | B1/B2 | C0 | A; only as explicit financial ledger | Loyalty/Finance | Financial, Security |

## G. Restaurant / cafe

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| Restaurant/menu/categories foundation | B1 | C1 | ADOPTED / IN PROGRESS; restaurant vertical reuses catalogue/category truth, dedicated menu/modifier depth remains open | Restaurant | UX, Data Integrity |
| Modifiers/options | B1 | C0/C1 | ADOPTED; basic deterministic preparation options/notes exist, authoritative modifier groups/pricing remain open | Restaurant/Pricing | Financial, UX |
| Dine-in/takeaway/delivery modes | B1 | C1 | IMPLEMENTED / VERIFIED on `product/post-v1-restaurant-foundation@997a17e7`; checkout/open-order context and POS flow covered by green CI | Restaurant | UX, Data Integrity |
| Tables/zones/order ownership | B1 | C1 | IMPLEMENTED / VERIFIED through floor authority, open orders, hold/resume, revision-safe line edits and table transfer; `997a17e7` CI `35478694436` | Restaurant | Operational, UX |
| Open-order cancellation | B1 | C1 | IMPLEMENTED / VERIFIED; `sale.void` server authority, explicit reason, idempotency/revision protection and audit, POS command surface on `997a17e7` | Restaurant | Security, Audit, UX |
| Courses/notes | B1 | C1 | ADOPTED / PARTIAL; preparation notes exist, course/firing lifecycle remains open | Restaurant | UX |
| Split/merge bills/orders | B1 | C0/C1 | ADOPTED; must be architected against transaction authority before implementation claim | Restaurant/Transaction | Financial, Data Integrity |
| Kitchen routing/KDS | B1 | C1 | KDS CORE IMPLEMENTED / VERIFIED; latest green lineage `product/post-v1-restaurant-foundation@5ff6a633` with CI `35616882259` (192 test files / 2,329 tests passed). Branch-scoped Preparation Stations, deterministic product→station routing, idempotent revision-bound fire, queued→preparing→ready→served lifecycle with timing/revision/audit, dedicated KDS UI, explicit POS «إرسال للمطبخ», retry-safe firing and server-side post-fire lock are present. Preparation payloads remain structurally non-fiscal. Advanced course sequencing and safe delta/re-fire semantics remain open. | Restaurant/KDS | Operational, Offline |
| Waiter/server application | B1 | C1 | ADOPTED; not yet claimed implemented | Restaurant/Client | UX, Offline |
| Customer/order-status display | B1/B2 | C2 | ADOPTED; not yet claimed | Restaurant/Display | UX |
| Self-service kiosk | B1/B2 | C1 | ADOPTED; not yet claimed | Restaurant/Kiosk | UX, Security |
| QR table menu/order/pay | B1/B2 | C0/C1 | ADOPTED; not yet claimed | Restaurant/Payments | Security, Financial |
| Online ordering | B1 | C1 | ADOPTED; not yet claimed | Omnichannel/Restaurant | Integration, Idempotency |
| Recipes/ingredients/consumption | B1 | C0/C1 | RECIPE/BOM + PRODUCTION/CONSUMPTION IMPLEMENTED / VERIFIED. Foundation remains proven from `product/post-v1-restaurant-foundation@5ff6a633`; governed batch production is verified on `product/post-v1-restaurant-production@dc224a951774b0b44edd87141535ee7a08698d74` with CI `35731689033` GREEN and PostgreSQL/RLS proof `35731689046` GREEN. Production freezes recipe revision + batch count, derives ingredient/output quantities server-side, consumes ingredients and creates finished stock through the existing inventory/cost ledger, is idempotent/audited/tenant-scoped, refuses physical over-consumption, and preserves UNKNOWN cost instead of fabricating finished-goods value. | Restaurant/Inventory | Data Integrity, Financial |
| Waste/spoilage | B1 | C1 | IMPLEMENTED / VERIFIED on `product/post-v1-restaurant-waste@a7553e4d31fae66a087e241382bca60420f3afb7`. CI `35734109879` GREEN (193 files / 2,359 tests); PostgreSQL/RLS proof `35734109870` GREEN (38 live files, 34 runtime-live, waste proof 5/5, final PostgreSQL-backed verify 194 files / 2,360 tests). Explicit waste/spoilage documents consume stock through the shared inventory/cost authority, preserve UNKNOWN cost, are permissioned/idempotent/audited/tenant-scoped, refuse physical over-consumption, and atomically roll back on late failure. | Restaurant/Inventory | Data Integrity, Audit |

## H. Payments / omnichannel / integrations

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| PSP/payment adapters | B1 | C0 | A; tender domain exists, direct provider adapters not yet claimed | Integrations/Payments | Security, Financial |
| Electronic tender UX | B0/B1 | C0/C1 | A; backend tender foundation stronger than current cashier UX | POS/Payments | Financial, UX |
| Split/mixed tender UX | B1 | C0 | A; domain support exists, full cashier product proof pending | POS/Payments | Financial, UX |
| Ecommerce adapters | B1 | C1 | A; not yet claimed | Integrations | Idempotency, Operations |
| Delivery-platform adapters | B1 | C1 | A; not yet claimed | Integrations | Idempotency, Operations |
| Salla/Zid-style integration seams | B1/B2 | C1 | A; not yet claimed | Integrations | Security, Idempotency |
| Webhooks/events | B1/B2 | C1 | A/AR boundary only | Events/Integrations | Security, Idempotency |
| External identity/mapping | B1/B2 | C1 | A; required for integrations/supply | Integrations | Data Integrity |
| POS→future ERP/accounting event export | B2 | C0 | A/AR boundary only | Events/Integration | Financial, Data Integrity |

## I. Reporting / intelligence / Korvi Advantage

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| Sales/returns/net/VAT reports | B0/B1 | C1 | A/AR/I/T real report foundation | Reports | Data Integrity, Performance |
| Product/category/branch/cashier analysis | B1 | C1/C2 | A; partial report foundation, full breadth not yet claimed | Analytics | Data Integrity |
| Inventory/purchasing/cost reports | B1 | C1 | A; foundations exist, full reporting product not yet claimed | Analytics | Data Integrity |
| Profitability Intelligence | B2 | C1 | A; cost/report foundations exist, strategic engine not yet claimed | Intelligence | Financial, Explainability |
| Command Center / Attention Center | B2 | C1 | A/AR principles; dashboard foundation exists, evidence/action engine not yet claimed | Intelligence | Evidence, Audit |
| Guardian / Watchdog anomaly detection | B2 | C1 | A/AR principles; not yet claimed implemented | Intelligence/Risk | Explainability, Privacy |
| Migration Engine | B2 | C1 | A; not yet claimed implemented | Migration | Data Integrity, Reconciliation |
| Product Knowledge / national catalogue | B2 | C1 | A; shared-catalogue concept accepted, production knowledge layer not yet claimed | Product Knowledge | Provenance, Governance |
| Explainable Reorder | B2 | C1 | A; not yet claimed implemented | Intelligence/Inventory | Explainability, Data Integrity |
| Expiry Intelligence | B2 | C1 | A; batch/expiry dependency not yet implemented | Intelligence/Inventory | Evidence, Data Integrity |
| Branch Rebalancing recommendations | B2 | C1 | A; transfer execution exists, recommendation engine not yet claimed | Intelligence/Inventory | Evidence, Data Integrity |
| Pricing Assistant | B2 | C0/C1 | A; recommendation only, not price authority; not yet claimed implemented | Intelligence/Pricing | Financial, Explainability |
| Liquid Cashier continuity | B2 | C1 | A; offline foundations exist, full authorized device-recovery workflow not yet claimed | Device Continuity | Offline, Security |
| Safe Operational Recovery | B2 | C1 | A/AR doctrine; full productized recovery workflow not yet claimed | Operations | Security, Data Integrity |

## J. Compliance / design / production / commercial operation

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| ZATCA Phase 1 invoice/QR facts | B0 | C0 | A/AR/I/T foundation | Compliance/Printing | ZATCA |
| ZATCA Phase 2 issuance/reporting chain | B0 | C0 | A/AR/I/T substantial exact-head evidence on release lineage; RC claim remains governed by final gate | Compliance | Full ZATCA Gate |
| Arabic/RTL commercial design system | B0 | C1 | A/I foundation; Product P0 visual completion active, final exact-head proof required | UI/POS | UX, Accessibility |
| Desktop/tablet/mobile responsiveness | B0 | C1 | A; visual evidence exists on intermediate heads, final exact-head proof required | UI/POS | UX, Visual Truth |
| Route/deep-link/back-forward continuity | B0 | C1 | A; Product P0 active | POS/Navigation | UX |
| Production operations | B0 | C0/C1 | A; real paid production resources/domain may be intentionally deferred by executive decision, but PR cannot be claimed without actual evidence | Operations | Production |
| Backup + real restore / RPO/RTO | B0 | C0 | A; proof exists for release engineering DR pieces, final production-environment evidence remains required | Operations/DB | Production, Data Integrity |
| Monitoring/alerts/on-call/incident process | B0 | C1 | A; final production evidence required | Operations | Production |
| Commercial plans/allowances/expiry | B0 | C1 | A/AR/I/T foundation; final commercial flow/enforcement still requires closure | Control Plane | Commercial |
| Structured support + audited access | B0/B1 | C1 | A; basic support-note foundation exists, full support runbook/process required | Operations/Platform | Security, Audit |
| Human accountant acceptance | B0 release acceptance | C0 | A; executive scheduling may defer to launch/first-customer window, but cannot be silently marked passed | Acceptance | Human Gate |
| Systems-expert acceptance | B0 release acceptance | C0/C1 | A; executive scheduling may defer to launch/first-customer window, but cannot be silently marked passed | Acceptance | Human Gate |
| Controlled first-customer pilot | B0 | C1 | A; intentionally later than product/staging completion | Operations | Production, Field Validation |

## K. Supply network / frontier

| Capability | Business | Criticality | Current evidence/status | Primary owner/domain | Mandatory gates |
|---|---:|---:|---|---|---|
| Supplier-network identity/mapping seams | B2 | C1 | A; merchant supplier model exists, network identity not yet claimed | Supply | Security, Integration |
| B2B supply ordering/network | B3 | C1/C2 | A; intentionally late, not yet claimed | Supply | Commercial, Integration |

## Definition-of-done rule

Every move to `I` must identify code ownership and implementation evidence. Every move to `T` must identify the required automated/live evidence. Every move to `PR` must identify all applicable release gates and installed-client/field evidence when relevant. Every move to `RC` must cite regulatory gate evidence.

For user-visible operational capabilities, backend authority alone is not enough: the supported end-to-end human workflow must also exist.

For installed/offline claims, a PWA/browser proof alone is not enough once the official commercial client is defined as Windows/Android Installed Korvi; real installed-client proof is required.

A roadmap deferment changes schedule, not acceptance. It does not erase the row.
