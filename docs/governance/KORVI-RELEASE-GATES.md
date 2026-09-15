# KORVI POS — Release Gates

Status: **MANDATORY CROSS-CUTTING RELEASE POLICY**

No feature is Production Ready because its happy-path tests pass. Release readiness is the intersection of the gates that apply to its criticality and domain.

## Gate 1 — Financial Integrity (C0)

Required for money, tax, discounts, promotions, tenders, sales, returns/refunds, loyalty value, customer credit, gift/wallet value, costing, drawer, reconciliation and accounting-event facts.

Pass criteria include integer minor units; deterministic rates/allocation; exact snapshot equations; no client financial authority; idempotency; rollback atomicity; adversarial edge cases; concurrency proof on real PostgreSQL where transaction behavior matters; explicit unknown provenance rather than fabricated zero values.

## Gate 2 — Security & Tenancy (C0)

Pass criteria include authenticated server-derived tenant/actor authority; least privilege; strict RLS/`FORCE RLS` where applicable; tenant composite references; non-enumeration; bounded/validated public input; secrets absent from client/GitHub; sensitive payment data absent; audit evidence for privileged operations; negative permission tests proving merchant roles cannot escalate into Platform authority.

Installed-client local stores must be partitioned/bound so stale/cross-tenant/cross-branch/device identity cannot silently reuse another merchant's state.

## Gate 3 — Data Integrity & Migration (C0/C1)

All server schema changes are forward-only migrations. Existing migrations are immutable. Constraints encode invariants where practical. Migration order is monotonic. Schema/migration drift tests pass. Failure after partial work leaves no residue.

Installed-client local schema/data upgrades must likewise be versioned, restart-safe and corruption-aware. A bad local migration must not silently discard pending operations or reinterpret their meaning.

## Gate 4 — ZATCA Regulatory (C0)

A standing gate. `REGULATORY COMPLIANT` is forbidden until the then-current official end-to-end requirements pass. Evidence must cover business rules, invoice types/flows, technical/security artifacts, onboarding/integration, reporting/clearance as applicable, failure/retry handling, SDK/validator evidence and production-like end-to-end flows. SDK success is evidence, not approval.

Offline mode must obey the exact applicable regulatory behavior. A locally queued/submitted-later state must never be presented as externally accepted when it is not.

## Gate 5 — Offline & Continuity (C0/C1)

Offline is a primary Korvi operating mode for supported capabilities, including the field case where WAN internet is unavailable for most/all of a working shift and returns near day end.

For every capability that claims offline support, pass criteria include:

- declared supported offline level and explicit unsupported operations;
- offline cold/warm start of the required client surface;
- deterministic local operation IDs/order;
- durable local catalogue/state required for the supported operation;
- durable queue surviving app/process/device restart within the supported recovery model;
- idempotent replay;
- retry/backoff and durable outcomes;
- lease/fencing where concurrent synchronization ownership matters;
- conflict semantics and operator-visible reconciliation;
- data-loss/power-loss recovery;
- reauthentication/authorization behavior;
- multi-device duplication protection;
- full-shift backlog synchronization proof after reconnect;
- no loss, duplication, reordering or silent last-write-wins of C0/C1 truth.

Browser-only navigator toggles or mocked outage tests are insufficient for the official installed release.

## Gate 6 — Device & Printing (C1)

Required for production hardware paths. Arabic shaping/bidi/encoding or raster behavior must be proven for the supported profile. Thermal receipt output, QR, cut/cash-drawer behavior where supported, reconnect/failure behavior and real-device validation are required. Unknown hardware capability fails closed rather than printing corrupt official output.

Barcode scanners, supported scales and cash drawers must enter through governed adapters/input contracts; device code never bypasses financial, stock or permission validation.

## Gate 7 — Performance (B0/B1 operational paths)

Define budgets for cashier interactions, search, checkout, local catalogue queries, queue operations, sync, API latency, cold/warm startup, database query plans and high-volume data. Test representative grocery catalogues, long shifts/backlogs and concurrency. No feature may create an unbounded query or render path on the till.

## Gate 8 — Production Operations

Before **Production Ready** is claimed, evidence includes environment separation, secret management, domain/TLS/health, observability, structured error IDs, auditability, backup + actual restore, known RPO/RTO, migration procedure, rollback/compensating plan, incident/on-call basics and controlled field validation.

Executive scheduling may intentionally defer paid production resources/domain cutover until immediately before the first real customer. Such a deferral may unblock product implementation work, but it does **not** convert missing production evidence into a passed Production Operations gate.

## Gate 9 — UX & Accessibility

Design-system authority, Arabic/RTL and bidi correctness, keyboard/scanner/touch flows, minimum practical touch targets, loading/double-submit protection, empty/error/offline/sync/conflict states, recoverable messages, deep-link/back-forward behavior and vertical-specific usability must pass.

Actual Chromium/device visual truth is required on the exact release lineage for the intended surfaces; screenshots of a different SHA do not close the gate.

## Gate 10 — Commercial Truth

Plan/entitlement, limits, billing/subscription state, active/suspended/grace behavior, feature claims and compliance claims must match actual capability status. No UI or sales material may label a deferred feature active or a regulatory/production gate passed when it is not.

## Gate 11 — Installed Application Release (B0/C1)

Required before Korvi is sold as an installed Windows/Android application.

### Windows proof

- real installer/package artifact produced by the release pipeline;
- install/uninstall/start/restart on a clean supported Windows environment;
- application launches without depending on an already-open browser tab;
- required shell/assets and supported local data operate without WAN internet;
- local durable state survives application restart;
- supported printer/scanner/device flows work through the installed client;
- version/update path is controlled, signed where applicable, and schema-compatible;
- rollback/recovery behavior is defined.

### Android proof

- real APK/AAB or equivalent official package artifact from the release pipeline;
- clean-device/emulator + real-device install/start/restart evidence for supported Android versions;
- offline shell/catalogue/draft/queue behavior survives process termination/restart within the security policy;
- scanner/camera/printing/device permissions are bounded and understandable;
- background/foreground lifecycle does not lose or duplicate pending operations;
- update/version compatibility is proved.

### Shared installed-client acceptance

- same authoritative domain/API contracts as the web/PWA client; no forked financial engine;
- no secrets baked into packages;
- local stores partitioned by merchant/device identity;
- full-shift WAN outage + end-of-day reconnect proof;
- evidence artifacts are tied to the exact release SHA/build version.

A PWA install badge alone does not close this gate if Windows/Android packaged Installed Korvi is the declared commercial product.

## Gate 12 — End-to-End Provisioning & Human Acceptance

Korvi cannot be called commercially complete if a customer can only be created through SQL/scripts or if the operator cannot perform a full supported onboarding cycle.

Required dry run on the final release lineage:

1. Platform Admin sign-in.
2. Create tenant/business through supported admin workflow.
3. Assign plan/entitlements.
4. Create/bootstrap initial owner through the approved one-time credential path.
5. Create/activate branch.
6. Register terminal/device.
7. Obtain tenant code/login facts without exposing persistent secrets.
8. Sign in as merchant owner.
9. Configure merchant basics/products/users as needed.
10. Open cashier/shift.
11. Complete representative cash/electronic sale, receipt and inventory effect.
12. Exercise return/close/reconciliation and offline/reconnect path.

Human acceptance must include accountant review for financial/VAT/stock/history behavior and systems-expert review for auth/permissions/navigation/admin/cashier/mobile/offline/reconnect/error handling at the scheduled acceptance window.

An executive decision may schedule those people for launch/first-customer time rather than the engineering day, but the system must not silently mark their acceptance as completed beforehand.

## Standard repository gate

`npm run verify` is necessary for every push but not sufficient for all releases. C0 changes additionally require relevant live/adversarial evidence. A writer does not self-approve a C0 change.

## Evidence rule

A gate is **PASS**, **FAIL**, or **NOT APPLICABLE with reason**. “Looks good”, “implemented”, “tests exist”, “SDK passed”, “PWA installs”, or “report written” are not gate states.

Every final claim must name the exact SHA/build, the evidence artifact/run, the applicable client/platform and any intentionally deferred external acceptance item.
