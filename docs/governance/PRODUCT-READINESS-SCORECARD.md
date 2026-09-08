# Korvi POS — Product Readiness Scorecard

Status: **ACTIVE GOVERNANCE DENOMINATOR (v1)**

Evidence baseline: `6e23f6bddb4ff72d20dcb64a4ec20300284e3509`

Snapshot date: 2026-09-08

Current evidence-backed progress: **74 / 100** (`37 / 50` gates closed)

> This score measures implementation progress toward the current sellable Korvi
> POS production target. It is not permission to ship. Critical release gates
> can block production even when the numeric score is high.

## 1. Why this document exists

The previously reported `58 / 100` was an accepted historical baseline, not a
fraction backed by a stable denominator. It therefore could not be moved safely
by counting commits, tests, screens or deployments.

This document replaces that historical baseline with a durable denominator:
**50 named product gates, each worth exactly 2 points, with binary scoring and
explicit evidence rules.** The denominator is fixed for this release target.
A future roadmap expansion (for example KDS, kiosk or delivery-platform
integration) requires a versioned scorecard change; it must not silently change
this denominator retroactively.

## 2. Scoring rules

1. Every gate is worth exactly **2 points**.
2. A gate is either `CLOSED` (2) or `OPEN` (0). There is no partial credit.
3. A gate closes only from evidence appropriate to that gate: accepted
   architecture/ADR, implementation, tests, real PostgreSQL proof, staging,
   browser evidence or Human Gate as specified.
4. Test count, commit count and deployment count are never progress by
   themselves. They are evidence only when they prove the named capability.
5. If later evidence invalidates a closed gate, the gate reopens and the score
   decreases. Progress is not monotonic by decree.
6. A documentation-only change cannot close a functional gate.
7. Backend authority and operational UX are intentionally separate gates. A
   complete service does not imply that the human workflow is closed.
8. Long-term ecosystem scope is not smuggled into this v1 release denominator.
   This score is product-wide for the current Korvi POS production target, not
   the future Korvi ERP/KDS/kiosk ecosystem.

## 3. Hard release blockers

The numeric score is subordinate to release safety. Production release remains
**BLOCKED** while any of these are open:

- full ZATCA Phase 2 issuance/reporting for the target regulatory scope;
- the promised offline-first sales path and reconciliation;
- required actual-browser / accessibility / Human Gates for the active strike;
- independent review where the governance model requires it;
- production operations evidence (backup/restore, observability, incident
  handling and controlled field validation).

A score of 100 means all 50 gates below are closed. A score below 100 may still
be useful for controlled engineering/staging work, but it is not automatically
saleable.

## 4. Gate ledger

### Pillar A — Architecture and arithmetic integrity (10 / 10)

| # | Gate | State | Evidence |
|---|---|---|---|
| 01 | Integer money is authoritative end to end; no floating-point financial truth | CLOSED | ADR-0002; money/allocation tests; invariant scan |
| 02 | VAT, discounts and settlement allocation are deterministic and reconcile exactly | CLOSED | pricing/tax/tender domain suites; checkout/settlement authorities |
| 03 | Quantities use canonical scaled integer text and exact bigint/string conversion | CLOSED | quantity domain/client suites; inventory/purchasing contracts |
| 04 | UUIDv7 and injected time/entropy preserve deterministic operation identity | CLOSED | ADR-0003; UUIDv7 tests; idempotent operation authorities |
| 05 | Domain/layer boundaries and mechanical invariants are enforced in CI | CLOSED | ADR-0001; `check-invariants.sh`; exact-head CI |

### Pillar B — Security, tenancy and authorization (10 / 10)

| # | Gate | State | Evidence |
|---|---|---|---|
| 06 | Tenant scope is server-derived and FORCE-RLS protected | CLOSED | ADR-0004; RLS policies; restricted-role PostgreSQL proof |
| 07 | Cross-tenant reads/writes are refused under live database execution | CLOSED | RLS/live tenancy suites and hosted two-tenant smoke evidence |
| 08 | Authentication/session/cookie/origin boundaries are production-shaped | CLOSED | ADR-0012/0014; auth/cookie/origin suites; hosted HTTPS smoke |
| 09 | Password hashing, lockout and session invalidation are enforced | CLOSED | auth service/password suites and session authority |
| 10 | RBAC is checked at HTTP and sensitive service boundaries | CLOSED | permission catalogue; route/service refusal suites; inventory/purchasing defense in depth |

### Pillar C — Core cashier and transaction integrity (10 / 10)

| # | Gate | State | Evidence |
|---|---|---|---|
| 11 | Online product discovery/catalogue path is operational with exact product identity | CLOSED | search/browse tests; real authenticated mobile product-search evidence |
| 12 | Cart, unit/weighted quantities and pricing are deterministic | CLOSED | cart/quantity/pricing suites |
| 13 | Checkout is atomic and enforces server-owned stock/financial truth | CLOSED | ADR-0013; checkout service/routes/live proof; real 409 insufficient-stock refusal |
| 14 | Checkout retry/idempotency cannot duplicate or mutate an already-claimed command | CLOSED | idempotency contracts; command-flight and live transaction tests |
| 15 | Tender composition, discounts, non-cash rules and change reconcile exactly | CLOSED | ADR-0015; tender/discount/settlement suites |

### Pillar D — Cash operations, after-sale and receipt path (8 / 10)

| # | Gate | State | Evidence |
|---|---|---|---|
| 16 | Shift open/close authority and lifecycle are implemented | CLOSED | shift domain/routes/live suites; real staging shift-open 201 |
| 17 | Cash-drawer reconciliation is immutable and server authoritative | CLOSED | ADR-0017; drawer routes/validation/reconciliation suites |
| 18 | Returns/refunds preserve historical sale/tender truth | CLOSED | ADR-0016; returns domain/routes/live suites |
| 19 | Arabic thermal receipt/QR generation has a tested production byte path | CLOSED | ADR-0008/0011; CP864, Arabic production, golden and fail-safe suites |
| 20 | A complete successful cashier sale is proven in actual target browsers/devices | OPEN | Current real browser reached checkout, but the synthetic item had zero stock and sale correctly refused 409 |

### Pillar E — SaaS control plane and merchant administration (10 / 10)

| # | Gate | State | Evidence |
|---|---|---|---|
| 21 | Tenant lifecycle/provisioning is an explicit server authority | CLOSED | ADR-0018; lifecycle/live suites |
| 22 | Initial owner bootstrap is bounded, auditable and credential-safe | CLOSED | ADR-0021; owner-bootstrap capability/live suites |
| 23 | Merchant settings, branches, terminals and member administration are permissioned | CLOSED | ADR-0019; admin/merchant-admin routes and UI |
| 24 | Plan entitlements are explicit product authority, not client assumptions | CLOSED | ADR-0020; entitlement database/domain suites |
| 25 | Guided merchant onboarding/readiness is implemented without conflating cashier branch assignment | CLOSED | ADR-0023; readiness domain/API/UI and staging onboarding evidence |

### Pillar F — Inventory authority and operator surface (8 / 10)

| # | Gate | State | Evidence |
|---|---|---|---|
| 26 | Stock ledger/balance integrity is server-owned and transactionally protected | CLOSED | Strike 5A; inventory live/database suites |
| 27 | Adjustment and absolute count use exact intent plus stale-revision protection | CLOSED | Strike 5A/5D-B; inventory command and live suites |
| 28 | Transfers enforce branch/product/stock concurrency and cannot create stock | CLOSED | transfer authority/live tests and exact request freezing |
| 29 | Inventory read model is bounded, paginated, tenant-safe and exact for zero/revision facts | CLOSED | Strike 5D-A; inventory route/UI tests |
| 30 | Inventory workflow is proven end-to-end in actual browser on desktop/mobile, keyboard/touch, with required review/Human Gate | OPEN | 5D implementation is delivered; actual `/control` interaction closure is still pending |

### Pillar G — Purchasing and costing (8 / 10)

| # | Gate | State | Evidence |
|---|---|---|---|
| 31 | Suppliers and immutable purchase orders are server authoritative | CLOSED | ADR-0024; Strike 5B/5D-C; purchasing suites |
| 32 | Partial/concurrent receiving is atomic, bounded and idempotent | CLOSED | purchasing receiving live suite; over-receipt/concurrency/rollback proof |
| 33 | Cost pool preserves known/unknown quantity/value and historical COGS truth | CLOSED | Strike 5C; costing domain/database/checkout proof |
| 34 | Cost read/bootstrap/valued receiving require separate cost authority and observation preconditions | CLOSED | ADR-0025; cost route/live/HTTP contract tests |
| 35 | Purchasing and costing workflows are proven in actual browser and pass independent review/Human Gate | OPEN | Static/automated implementation evidence exists; required real `/control` workflow evidence does not |

### Pillar H — Fiscal compliance (4 / 10)

| # | Gate | State | Evidence |
|---|---|---|---|
| 36 | ZATCA Phase 1 simplified QR tags 1-5 are deterministic and UTF-8 byte-correct | CLOSED | `docs/architecture/zatca.md`; TLV tests |
| 37 | Required QR is carried through the thermal receipt generation path | CLOSED | receipt renderer and printing suites |
| 38 | Compliant UBL XML, canonicalisation and invoice hash are implemented for Phase 2 | OPEN | Explicitly deferred by `docs/architecture/zatca.md` |
| 39 | CSID lifecycle, cryptographic stamp and QR tags 6-9 are implemented | OPEN | Explicitly deferred by `docs/architecture/zatca.md` |
| 40 | FATOORA reporting, retry and reconciliation are implemented and proven | OPEN | Architecture defined; production authority not yet implemented/proven |

### Pillar I — Offline-first resilience (0 / 10)

| # | Gate | State | Evidence |
|---|---|---|---|
| 41 | Service Worker keeps the cashier application shell usable without network | OPEN | `docs/architecture/offline.md` marks implementation deferred |
| 42 | IndexedDB/local durable store contains the required catalogue and sale state | OPEN | Boundary/ports exist; durable browser implementation is not closed |
| 43 | Persistent ordered transaction queue survives restart/outage | OPEN | Port/RetryPolicy architecture only |
| 44 | Sync engine retries/reporting without loss, duplication or reordering | OPEN | Port/architecture only |
| 45 | Conflict/reconciliation policy and a real offline sale/reconnect workflow are proven | OPEN | Explicitly undecided/unproven in offline architecture |

### Pillar J — Release engineering, staging and field readiness (6 / 10)

| # | Gate | State | Evidence |
|---|---|---|---|
| 46 | Exact-head CI enforces dependency pins, audit, format, lint, invariants, build, typecheck and tests | CLOSED | Push/PR CI on `6e23f6b...`; 119 test files passed, 1,806 tests passed, 0 failed |
| 47 | Restricted-role PostgreSQL 17 proof applies all migrations, detects drift and runs live/full verification | CLOSED | exact-head PostgreSQL workflow `34182652451` succeeded; 12/12 migrations and no drift |
| 48 | Matching-SHA API/web staging deployment is live and health-checked | CLOSED | Render API `dep-dafts6m7bikc73djgtmg` and web `dep-dafts9u7bikc73djh9n0`, both on `6e23f6b...`; API `/health` 200 |
| 49 | Current-head independent review and all required Human Gates are complete | OPEN | No fresh independent approval/Human Gate is claimed |
| 50 | Production operations and controlled field validation are complete | OPEN | Backup/restore, production observability/incident evidence and the planned controlled merchant field rollout are not closed |

## 5. Arithmetic

Closed gates by pillar:

- A: 5
- B: 5
- C: 5
- D: 4
- E: 5
- F: 4
- G: 4
- H: 2
- I: 0
- J: 3

Total: `37 / 50` gates.

`37 × 2 = 74`.

**Canonical evidence-backed overall progress: 74 / 100.**

This replaces the historical `58 / 100` baseline because the old number had no
stable denominator. The increase is the result of a repository-wide re-audit
against a fixed 50-gate denominator, not credit for one recent commit or for a
larger test count.

## 6. What must happen next

The score must move only when a named open gate closes. The nearest legitimate
opportunities are:

1. complete the actual Stage 5D inventory/purchasing/costing browser workflows;
2. obtain the required independent current-head review and Human Gate;
3. prove a successful cashier sale after stock is established through the
   legitimate inventory/purchasing authority;
4. then proceed into the remaining fiscal/offline/production-readiness gates in
   their dependency order.

No direct SQL fixture, fake stock, weakened permission, fabricated browser
claim, skipped regulatory requirement or temporary production bypass may be
used to earn score.