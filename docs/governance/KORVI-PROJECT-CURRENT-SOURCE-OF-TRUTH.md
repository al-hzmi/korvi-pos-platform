# KORVI — PROJECT CURRENT SOURCE OF TRUTH

Status: **AUTHORITATIVE PROJECT CONTINUATION SNAPSHOT — V2-2 VERIFIED**
Date: 2026-09-25
Protected acquisition source: `61dbb34dea08809756fd767b907b0e852b7e5978`
Acquisition branch: `release/canonical-acquisition-v1`
Active future-development branch: `mastermind/v2-strengthening`

## 1. Purpose

This document is the continuation bridge between:

- the accepted Master Product Directive;
- the canonical acquisition candidate;
- the acquisition data room;
- the next Mastermind development cycle.

It exists so future work does not rely on conversational memory or stale historical branches.

Repository evidence remains implementation authority.

## 2. Immutable acquisition checkpoint

The frozen buyer-evaluable acquisition candidate remains:

`61dbb34dea08809756fd767b907b0e852b7e5978`

It must not be rewritten or extended merely to continue product development.

Its current defensible label is:

**KORVI CANONICAL ACQUISITION CANDIDATE — INTERNAL ENGINEERING COMPLETE / EXTERNAL ACTIVATION ONLY**

The dedicated acquisition data room lives on:

`docs/acquisition-data-room-61dbb34`

Its final data-room HEAD at closure was:

`23aa0426dc3cca3f0bf1c93858f80b6c9bb8a9c5`

## 3. What the acquisition checkpoint already contains

Internally closed/proven on the adopted canonical program:

- one canonical product lineage;
- Platform Admin durable server-side session revocation;
- electronic tender operator workflow;
- mixed tender operator workflow;
- original-sale return/refund workflow;
- shift close;
- cash reconciliation;
- latest adopted Retail/Core work;
- latest adopted Restaurant/KDS/BOM/production/waste work;
- Migration Engine baseline through M6;
- internal Production Operations engineering package;
- internal Production ZATCA engineering proof package;
- buyer/handoff engineering package;
- hosted staging aligned to exact canonical SHA.

Still intentionally external/open:

- real production infrastructure/HA/backups/RPO/RTO;
- external monitoring/on-call;
- production secret management;
- real Production ZATCA HSM/merchant identity/CSID/reporting/clearance;
- real Merchant Production Pilot;
- legal IP/account/domain transfer;
- final acquisition evidence manifest/human approval.

These external gates must not block legitimate future product development on the new Mastermind branch, but they also must never be fabricated as closed.

## 4. Product constitution remains authoritative

Korvi remains a Saudi-market, multi-vertical business operating platform led by POS.

North star:

**One Platform — One Truth — Multiple Experiences.**

Non-negotiable system laws remain:

- financial truth is server/domain authoritative;
- integer minor-unit money;
- immutable historical truth;
- unknown is never silently converted to zero;
- one stock/cost truth;
- tenant isolation/RLS and least privilege;
- deterministic pricing/tax/allocation/promotions/reconciliation;
- full-shift offline-first doctrine;
- AI may recommend/explain/detect but may not become money/tax/stock/regulatory authority;
- runtime repair may never rewrite finalized business truth;
- no pressure-driven weakening of release gates.

## 5. Client/product surface contract

Official product surfaces remain:

- **Korvi Cashier** — installed Windows/Android till client;
- **Korvi Control** — responsive merchant-management web;
- **Korvi Platform Admin** — separated highest-authority operator web.

Do not combine these merely to reduce implementation effort.

## 6. Active development law after acquisition freeze

All new product development starts from the frozen canonical source but lands only on:

`mastermind/v2-strengthening`

Rules:

1. no force-push;
2. no rewriting acquisition history;
3. no blind merges from old branches;
4. one capability/strike at a time for C0/C1 domains;
5. architecture contract before implementation when authority changes;
6. targeted tests before full verification;
7. live PostgreSQL proof when DB/RLS/concurrency truth changes;
8. browser/device/human proof when user workflow changes;
9. exact-head evidence before promoting a future release candidate;
10. acquisition source stays untouched unless explicitly superseded by a new release program.

## 7. Remaining accepted product scope

The Master Product Directive still accepts substantial product growth beyond the current acquisition candidate.

### Retail / grocery parity

Still accepted where not already fully closed:

- packaging/unit/carton relationships;
- weighted/scale-driven workflows;
- multiple barcodes;
- retail/wholesale/customer/context price lists;
- labels/price lookup/printing;
- batch/lot/expiry;
- deterministic promotions/coupons;
- stronger replenishment;
- explicit customer credit/balance capability;
- supported device integration.

### Restaurant / cafe parity

Still accepted where not already fully closed:

- modifiers/options/bundles;
- dine-in/takeaway/delivery;
- tables/zones/order ownership;
- courses/notes;
- governed split/merge rules;
- waiter/server experience;
- customer/order-status display;
- self-service kiosk;
- QR table menu/order/pay;
- online ordering;
- delivery adapters.

### Customer / loyalty / promotions

Accepted:

- tags/segments;
- governed credit/balance;
- loyalty ledger/rewards;
- gift-card/wallet only as explicit financial ledgers;
- deterministic promotion engine;
- coupon/voucher instruments.

### Omnichannel / integrations

Accepted:

- PSP adapters behind tender boundary;
- ecommerce ingestion/mapping;
- delivery adapters;
- Salla/Zid-style integration seams;
- webhooks/events;
- immutable accounting/ERP export.

### Korvi Advantage

Accepted differentiators include:

- Migration Engine;
- governed Product Knowledge;
- Explainable Reorder;
- Expiry Intelligence;
- Branch Rebalancing;
- Watchdog/Guardian;
- Profitability Intelligence;
- Pricing Assistant;
- Attention Center / Management by Exception;
- Liquid Cashier / Device Continuity;
- Safe Operational Recovery;
- Supplier Network.

## 8. Mastermind V2 execution objective

The next development program is not “add random features.”

Objective:

**Convert the current strong acquisition candidate into a materially stronger multi-vertical product while preserving the frozen acquisition checkpoint and all financial/security/offline/ZATCA invariants.**

The program will prioritize:

1. close high-value accepted parity gaps that require no paid external provider;
2. improve product/operator completeness before exotic integrations;
3. build deterministic shared engines before vertical-specific duplication;
4. strengthen UX through the canonical Korvi design system;
5. defer provider-dependent integrations until their adapter contracts are ready and a real commercial reason exists.

## 9. Initial prioritized internal roadmap

### V2-0 — Baseline and drift lock

- verify new branch exact base = `61dbb34dea08809756fd767b907b0e852b7e5978`;
- run/inspect current CI evidence before first code strike;
- build a fresh current capability matrix for V2 rather than relying on historical 88/100 snapshot;
- identify implemented-vs-accepted gaps directly from repository.

### V2-1 — No-receipt return / exchange authority — VERIFIED COMPLETE

Verified implementation HEAD:

`a1d640f3b3d30faf4c4c04e90c1c5fa04412971a`

Closed scope:

- separately governed **exchange-only** authority; it does not extend or reinterpret original-sale refunds;
- manager/admin/owner permission `sale.exchange.no-receipt`; cashier role does not receive it;
- current merchant-policy reference valuation only; no original price, VAT, discount, tender, invoice provenance or historical cost is reconstructed;
- approved allowance is bounded by deterministic current-policy reference and cannot create change;
- `exchange_allowance` is an internal non-cash settlement component created only server-side and cannot carry PSP/card references;
- accepted tracked stock re-enters the canonical stock/cost ledger as sellable inventory with **unknown** incoming cost basis, never known zero;
- replacement merchandise is a normal authoritative sale using the existing sale/pricing/VAT/tender/stock authority;
- accepted intake + replacement sale + allowance + case + audit + idempotency commit atomically in PostgreSQL;
- finalized case/line snapshots are append-only/immutable;
- tenant FORCE-RLS, least privilege, deterministic locking, replay/conflict handling and adversarial concurrency are proven;
- Arabic RTL cashier workflow is online-authoritative; this capability is deliberately unavailable offline in V2-1;
- Restaurant use is not claimed by this strike;
- ZATCA applies to the replacement sale through the existing checkout fiscalization boundary; the no-receipt intake does not invent an original invoice or credit note;
- no cash refund and no store-credit balance/ledger were fabricated.

Exact-head evidence for `a1d640f3b3d30faf4c4c04e90c1c5fa04412971a`:

- full CI: GitHub Actions run `36070419973` — **SUCCESS**;
- PostgreSQL 17 / migrations / FORCE-RLS / restricted-runtime live suite: run `36070419982` — **SUCCESS**;
- actual Chrome cashier workflow + restricted database authority: run `36070420015` — **SUCCESS**;
- PR full CI independently repeated at run `36070424151` — **SUCCESS**.

The frozen acquisition candidate remains untouched. V2-1 exists only on the Mastermind V2 lineage.

### Current Mastermind execution state

V2-0 baseline/drift lock: **COMPLETE**.

V2-1 no-receipt exchange: **COMPLETE / EXACT-HEAD VERIFIED**.

V2-2 deterministic promotions/coupons: **COMPLETE / EXACT-HEAD VERIFIED**.

Next authorized strike: **V2-3 Retail packaging + price lists**.

### V2-2 — Deterministic Promotions + Coupons — VERIFIED COMPLETE

Verified implementation HEAD:

`68a56867f189c5f5d44a82b48baebccc2fda3f45`

Closed scope:

- shared deterministic promotion/coupon authority for direct Retail/Grocery/Wholesale checkout;
- merchant policy owns eligibility, priority, stacking/exclusivity, effect and target scope;
- coupon is a normalized tenant-owned activation instrument, not money/tender/store credit;
- server-only checkout preview derives current product price, VAT, policy eligibility and promotion allocation;
- integer-money largest-remainder allocation feeds the existing canonical pricing/VAT engine;
- manual operator discount + promotion policy is refused in V2-2 rather than ambiguously merged;
- promotion/coupon application snapshots are immutable sale history, including promotion revision and per-line allocation;
- original-sale returns continue from historical sold facts and do not re-evaluate today's policy;
- coupon redemption + sale + promotion snapshots + audit commit atomically;
- final-redemption concurrency is governed by coupon/promotion locks and immutable redemption facts;
- retry/idempotency remains the canonical checkout operation authority;
- promotion/coupon tables use FORCE-RLS and tenant-consistent relational guards;
- `promotion.manage` is separate administration authority; cashier cannot mutate policy;
- Control Center provides governed Arabic RTL promotion/coupon lifecycle management;
- Cashier provides server-authoritative coupon preview and checkout;
- promotion/coupon checkout is deliberately online-authoritative; the client may not guess campaign state or remaining redemption offline;
- Restaurant open-order promotions, category/tag/segment predicates, BOGO/bundles, loyalty coupling and offline signed promotion snapshots remain outside this strike;
- Production ZATCA remains fail-closed and receives only the ordinary finalized sale financial truth.

Exact-head evidence for `68a56867f189c5f5d44a82b48baebccc2fda3f45`:

- full CI: GitHub Actions run `36082432970` — **SUCCESS**;
- PostgreSQL 17 / migrations / FORCE-RLS / concurrency / full verify: run `36082432869` — **SUCCESS**;
- actual Chrome Control + cashier coupon workflow: run `36082432819` — **SUCCESS**;
- independent PR full CI: run `36082437825` — **SUCCESS**.

The frozen acquisition candidate remains untouched. V2-2 exists only on the Mastermind V2 lineage.
### V2-3 — Retail packaging / price-list / wholesale parity

Strengthen grocery/wholesale competitiveness:

- unit/carton hierarchy;
- retail/wholesale/customer/context price lists;
- multiple barcode authority where incomplete;
- operator UX and migration compatibility.

### V2-4 — Batch/Lot/Expiry foundation

One inventory truth:

- lot/batch identity;
- expiry;
- receiving;
- sale/consumption policy where configured;
- adjustment/transfer/count compatibility;
- Expiry Intelligence-ready data model.

### V2-5 — Restaurant modifiers + dining modes + table ownership completion

Close remaining operator parity:

- modifiers/options;
- dine-in/takeaway/delivery;
- table/zone/order ownership;
- notes/courses where justified;
- deterministic settlement compatibility;
- KDS compatibility.

### V2-6 — Loyalty/Credit explicit ledgers

Only after ledger architecture:

- points/rewards ledger;
- customer credit/balance ledger;
- gift-card/wallet only if explicit financial authority is implemented.

Never implement as mutable display counters.

### V2-7 — Attention Center / Management by Exception

Use existing trusted facts to surface:

- operational exceptions;
- evidence;
- severity;
- affected entity;
- recommended action;
- deep link;
- state;
- audit trail.

No AI authority over financial/stock/regulatory action.

### V2-8 — Explainable Reorder + Expiry Intelligence

Recommendations only.

Never autonomous purchasing authority.

### V2-9 — Omnichannel adapter contracts

Prepare safe seams for:

- Salla/Zid;
- delivery platforms;
- PSP adapters;
- immutable ERP/accounting event export.

Do not pay for or activate providers without a commercial need.

### V2-10 — Kiosk / QR / customer display

Build only on shared Restaurant/Transaction authorities; never fork money/stock truth.

## 10. Design authority

The canonical Korvi Design System remains mandatory:

- Arabic RTL first;
- IBM Plex Sans Arabic interface baseline;
- IBM Plex Mono where technical/numeric alignment benefits;
- centralized tokens;
- no random hex/component styling;
- minimum practical touch target around 44px for POS actions;
- deliberate loading/empty/error/offline/sync/conflict/success states;
- Korvi software mark must not impersonate the merchant issuer on tax documents.

## 11. Evidence and promotion rule

No future branch becomes “the real Korvi” merely because it has more features.

A future release promotion requires:

- named candidate SHA;
- full CI;
- relevant PostgreSQL/RLS proof;
- relevant browser/device proof;
- no invariant regression;
- reconciliation against the frozen acquisition source;
- updated current-status documentation;
- explicit executive promotion decision.

Until then:

- acquisition candidate = stable buyer checkpoint;
- Mastermind V2 branch = active future development.
