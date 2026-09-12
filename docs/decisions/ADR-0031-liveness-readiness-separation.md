# ADR-0031 — Liveness / Readiness Separation

Status: **Accepted**

Date: 2026-09-08

## Context

Korvi's existing `/health` endpoint is deliberately process-only liveness. It does not open PostgreSQL because an orchestrator restart cannot repair a transient database outage and can amplify it into a restart storm.

Production operations also need the inverse signal: an instance whose event loop is healthy but whose authoritative database is unreachable must not continue receiving new cashier/back-office traffic as though it were ready.

A readiness endpoint is itself part of the failure path. If a database handshake or query stalls, an unbounded readiness request can hang provider routing and monitoring. If every incoming probe starts another dependency operation while the first is still stalled, the monitor can amplify a database incident into connection/query pressure. The readiness path therefore needs both a public response deadline and a per-process single-flight boundary.

## Decision

1. `/health` remains a dependency-free liveness probe.
2. API entrypoints additionally register `/ready` as an operational readiness probe.
3. `/ready` performs a real, read-only `SELECT 1` through the same Prisma/PostgreSQL driver family used by application persistence.
4. The readiness Prisma client is lazy. Merely booting the process or calling `/health` does not create a database connection.
5. Missing `DATABASE_URL`, a failed connection, deadline expiry or driver exception all produce the same public response: HTTP 503 `{ "status": "not_ready" }`.
6. The default readiness response deadline is 2.5 seconds. Tests may inject a shorter positive safe-integer deadline; an invalid deadline is rejected at registration rather than silently coerced.
7. At most one dependency check may be in flight per API process. Concurrent readiness requests share that operation. If the public deadline expires while the driver operation is still unresolved, later probes continue to reuse the pending operation instead of starting a thundering herd. A later request may start a fresh operation only after the previous one settles.
8. Deadline expiry does not attempt generic query cancellation at this boundary. Cancellation semantics belong to the concrete database driver/pool; pretending a timed-out JavaScript promise cancelled server-side work would be unsafe. Single-flight bounds the remaining work instead.
9. Driver exception text is never returned or logged by the readiness route because it may contain connection details.
10. A successful round trip within the deadline returns HTTP 200 `{ "status": "ready" }`.
11. The owned readiness client disconnects during Fastify close, therefore participating in the common bounded graceful-shutdown lifecycle from ADR-0030.
12. CI includes fail-closed, bounded-deadline and single-flight unit proof plus a real PostgreSQL readiness round trip in the live suite.

## What readiness does not mean

A green `/ready` is not migration verification, RLS verification, business-flow verification or regulatory approval. Those remain separate release gates. Staging startup preflight and PostgreSQL CI continue to prove schema/RLS invariants; readiness only answers whether this instance can currently reach its authoritative dependency.

## Rejected alternatives

### Make `/health` query PostgreSQL

Rejected because liveness and dependency availability have different operational recovery actions.

### Return the database exception in the 503

Rejected because public diagnostics can disclose topology or credentials and do not improve automated routing decisions.

### Create a new Prisma client per readiness request

Rejected because provider probes are frequent and connection churn would itself become an availability risk.

### Start one database query per concurrent readiness request

Rejected because monitoring traffic must not multiply dependency pressure during the incident it is trying to observe.

### Treat a JavaScript timeout as database-query cancellation

Rejected because losing a `Promise.race` does not prove the driver/server operation stopped. Korvi keeps the unresolved operation single-flight until it actually settles.

## Release status

This improves the Production Operations foundation but does **not** close Product Readiness Gate 50. External alerting, production retention/RPO/RTO evidence, an incident exercise, secret-management verification and controlled merchant field validation remain open.
