# KORVI — MASTERMIND V2 STRENGTHENING DIRECTIVE

Status: **ACTIVE FUTURE-DEVELOPMENT PROGRAM**
Branch: `mastermind/v2-strengthening`
Base: `61dbb34dea08809756fd767b907b0e852b7e5978`

## Executive order

Resume Korvi development aggressively, but do not destroy the clean acquisition checkpoint we just created.

The frozen acquisition release is a preserved asset.

All new development happens on this branch until a future release candidate is deliberately promoted.

## Mission

Make Korvi materially stronger, more complete and more competitive across Retail/Grocery, Wholesale and Restaurant/Cafe while preserving:

- One Platform — One Truth — Multiple Experiences;
- financial integrity;
- stock/cost integrity;
- tenant isolation;
- auditability;
- offline-first continuity;
- production ZATCA fail-closed behavior;
- deterministic business authority.

## Development operating model

For every new strike:

### 1. Repository-grounded discovery

Read the actual current code before designing.

Never assume a historical capability matrix is current.

### 2. Architecture contract

For C0/C1 work, define:

- authority;
- invariants;
- data model;
- concurrency;
- idempotency;
- audit;
- offline behavior;
- migration compatibility;
- historical truth;
- security/permission boundary;
- UX states;
- definition of done.

### 3. Implementation

Use existing domain/API/database/UI boundaries.

Do not create parallel financial or inventory engines.

### 4. Verification

Minimum according to changed surface:

- targeted unit/domain tests;
- API tests;
- database/live PostgreSQL proof for DB/RLS/concurrency work;
- negative authorization/tenant tests;
- browser proof for user workflows;
- installed-client proof if cashier/offline/device path changes;
- full CI before closure.

### 5. Independent review

Agent report is not enough.

Review the actual diff/evidence before closing C0/C1 work.

### 6. Promotion

Do not merge/promote merely because the feature “works.”

A future release candidate must reconcile the complete lineage and rerun exact-head evidence.

## Cost rule

No new paid external services merely to complete an internal feature.

External/provider-dependent activation remains deferred until:

- a real customer;
- transaction requirement;
- or explicit executive authorization.

Adapter contracts can be built and tested with bounded fakes/sandboxes where legitimate, but no fake provider proof may be labeled production evidence.

## AI rule

AI may:

- recommend;
- explain;
- summarize;
- detect anomalies;
- prioritize attention.

AI may not authoritatively:

- finalize money;
- calculate tax truth outside deterministic domain rules;
- mutate stock truth;
- approve refunds/credits;
- issue regulatory acceptance;
- create autonomous purchase commitments.

## Initial execution sequence

### STRIKE V2-0 — Current Repository Gap Audit

Output:

- fresh V2 capability matrix;
- implemented vs partially implemented vs accepted-only;
- exact source paths/tests/evidence;
- no historical score reuse;
- no product code changes.

### STRIKE V2-1 — No-Receipt Return / Exchange

Only after V2-0 identifies exact existing return/tender/stock authorities.

This is the first preferred code strike unless repository evidence reveals a more severe C0/C1 deficiency.

### STRIKE V2-2 — Promotion Engine

Shared deterministic authority first, then coupon UX.

### STRIKE V2-3 — Grocery/Wholesale Packaging + Price Lists

### STRIKE V2-4 — Batch/Lot/Expiry

### STRIKE V2-5 — Restaurant Modifiers / Dining Modes / Tables

### STRIKE V2-6 — Loyalty/Credit Ledgers

### STRIKE V2-7 — Attention Center

### STRIKE V2-8 — Explainable Reorder / Expiry Intelligence

### STRIKE V2-9 — Omnichannel Adapter Contracts

### STRIKE V2-10 — Kiosk / QR / Customer Display

## Stop conditions

Stop a strike and investigate before proceeding if:

- financial or stock invariants become ambiguous;
- cross-tenant behavior cannot be proven;
- migration modifies historical migrations;
- client is made authoritative for money/tax/stock;
- offline replay semantics become ambiguous;
- ZATCA production path can silently degrade into simulation;
- a feature requires a paid provider not yet authorized;
- exact source lineage becomes unclear.

## Current program truth

The acquisition checkpoint is preserved.

Mastermind is now authorized to advance the broader accepted Master Product Vision again, but every new capability must earn its place through repository evidence and release discipline.
