# ADR-0031 — Liveness / Readiness Separation

Status: **Accepted**

Date: 2026-09-08

## Context

Korvi's existing `/health` endpoint is deliberately process-only liveness. It does not open PostgreSQL because an orchestrator restart cannot repair a transient database outage and can amplify it into a restart storm.

Production operations also need the inverse signal: an instance whose event loop is healthy but whose authoritative database is unreachable must not continue receiving new cashier/back-office traffic as though it were ready.

## Decision

1. `/health` remains a dependency-free liveness probe.
2. API entrypoints additionally register `/ready` as an operational readiness probe.
3. `/ready` performs a real, read-only `SELECT 1` through the same Prisma/PostgreSQL driver family used by application persistence.
4. The readiness Prisma client is lazy. Merely booting the process or calling `/health` does not create a database connection.
5. Missing `DATABASE_URL`, a failed connection, timeout or driver exception all produce the same public response: HTTP 503 `{ "status": "not_ready" }`.
6. Driver exception text is never returned or logged by the readiness route because it may contain connection details.
7. A successful round trip returns HTTP 200 `{ "status": "ready" }`.
8. The owned readiness client disconnects during Fastify close, therefore participating in the common bounded graceful-shutdown lifecycle from ADR-0030.
9. CI includes both fail-closed unit proof and a real PostgreSQL readiness round trip in the live suite.

## What readiness does not mean

A green `/ready` is not migration verification, RLS verification, business-flow verification or regulatory approval. Those remain separate release gates. Staging startup preflight and PostgreSQL CI continue to prove schema/RLS invariants; readiness only answers whether this instance can currently reach its authoritative dependency.

## Rejected alternatives

### Make `/health` query PostgreSQL

Rejected because liveness and dependency availability have different operational recovery actions.

### Return the database exception in the 503

Rejected because public diagnostics can disclose topology or credentials and do not improve automated routing decisions.

### Create a new Prisma client per readiness request

Rejected because provider probes are frequent and connection churn would itself become an availability risk.

## Release status

This improves the Production Operations foundation but does **not** close Product Readiness Gate 50. External alerting, production retention/RPO/RTO evidence, an incident exercise, secret-management verification and controlled merchant field validation remain open.
