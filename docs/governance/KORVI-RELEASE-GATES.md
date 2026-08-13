# KORVI POS — Release Gates

Status: **MANDATORY CROSS-CUTTING RELEASE POLICY**

No feature is Production Ready because its happy-path tests pass. Release readiness is the intersection of the gates that apply to its criticality and domain.

## Gate 1 — Financial Integrity (C0)

Required for money, tax, discounts, promotions, tenders, sales, returns/refunds, loyalty value, costing, drawer, reconciliation, and accounting-event facts.

Pass criteria include integer minor units; deterministic rates/allocation; exact snapshot equations; no client financial authority; idempotency; rollback atomicity; adversarial edge cases; concurrency proof on real PostgreSQL where transaction behavior matters.

## Gate 2 — Security & Tenancy (C0)

Pass criteria include authenticated server-derived tenant/actor authority; least privilege; strict RLS/`FORCE RLS` where applicable; tenant composite references; non-enumeration; bounded/validated public input; secrets absent; sensitive payment data absent; audit evidence for privileged operations.

## Gate 3 — Data Integrity & Migration (C0/C1)

All schema changes are forward-only migrations. Existing migrations are immutable. Constraints encode invariants where practical. Migration order is monotonic. Schema/migration drift tests pass. Failure after partial work leaves no residue.

## Gate 4 — ZATCA Regulatory (C0)

A standing gate. `REGULATORY COMPLIANT` is forbidden until the then-current official end-to-end requirements pass. Evidence must cover business rules, invoice types/flows, technical/security artifacts, onboarding/integration, reporting/clearance as applicable, failure/retry handling, SDK/validator evidence, and production-like end-to-end flows. SDK success is evidence, not approval.

## Gate 5 — Offline & Continuity (C0/C1)

For every capability that claims offline support: declare supported offline level; prove deterministic local IDs/order; durable queue; idempotent replay; retry/backoff/dead-letter; conflict semantics; data-loss/power-loss recovery; reauthentication/authorization behavior; multi-device duplication protection; reconciliation after reconnect.

## Gate 6 — Device & Printing (C1)

Required for production hardware paths. Arabic shaping/bidi/encoding or raster behavior must be proven for the profile used. Thermal receipt output, QR, cut/cash-drawer behavior where supported, reconnect/failure behavior, and real-device validation are required. Unknown hardware capability fails closed rather than printing corrupt Arabic.

## Gate 7 — Performance (B0/B1 operational paths)

Define budgets for cashier interactions, search, checkout, API latency, cold/warm startup, database query plans, and high-volume data. Test representative catalogues and concurrency. No feature may create an unbounded query or render path on the till.

## Gate 8 — Production Operations

Observability, structured error IDs, auditability, backup/restore, migration procedure, rollback/compensating plan, health checks, environment separation, secret management, incident/runbook basics, and pilot telemetry must exist before Production Ready.

## Gate 9 — UX & Accessibility

Design-system authority, Arabic/RTL and bidi correctness, touch target rules, loading/double-submit protection, recoverable error messages, keyboard/scanner flows, and vertical-specific usability must pass for user-facing work.

## Gate 10 — Commercial Truth

Plan/entitlement, limits, billing/subscription state, feature claims, and compliance claims must match actual capability status. No UI or sales material may label a deferred feature active or a regulatory gate passed when it is not.

## Standard repository gate

`npm run verify` is necessary for every push but not sufficient for all releases. C0 changes additionally require the relevant live/adversarial evidence. A writer does not self-approve a C0 change.

## Evidence rule

A gate is either **PASS**, **FAIL**, or **NOT APPLICABLE with reason**. “Looks good”, “implemented”, “SDK passed”, or “tests exist” are not gate states.
