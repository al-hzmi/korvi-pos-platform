# ADR-0030 — Runtime health and graceful shutdown

Status: Accepted
Date: 2026-09-08

## Context

Korvi's staging entrypoint had an explicit SIGTERM/SIGINT drain path, while the ordinary API entrypoint did not. In a rolling replacement or host shutdown, the production-shaped entrypoint could therefore be terminated without first asking Fastify to stop accepting new requests and drain in-flight work.

For a POS/ERP system, abrupt process replacement is not merely cosmetic: a request may be between client acknowledgement, idempotency claim, transaction commit and response delivery. Server-side transactional/idempotency authorities still protect data integrity, but the runtime should not manufacture avoidable ambiguous outcomes by dropping active HTTP work during a normal shutdown.

The existing `/health` route is intentionally liveness-only and must remain independent of PostgreSQL. A transient database problem should drain traffic through readiness/operational controls, not trigger a restart storm by redefining process liveness.

## Decision

1. Production and staging use one shared graceful-shutdown implementation.
2. SIGTERM and SIGINT are idempotent: only the first signal begins shutdown.
3. Shutdown calls `FastifyInstance.close()`, allowing Fastify to stop accepting new work and finish in-flight requests.
4. A 25-second hard deadline exits non-zero if shutdown wedges.
5. Successful drain exits zero; close failure exits non-zero.
6. Raw shutdown/startup errors are not serialized to logs because driver/configuration errors can contain connection details. Operators receive a stable failure signal and exit code instead.
7. `/health` remains process liveness only. Dependency readiness is a separate concern and must not be faked by making liveness query PostgreSQL.

## Consequences

- Ordinary host replacement now has the same bounded drain semantics as staging.
- The change does not weaken idempotency, database transactions, RLS, or command reconciliation; it reduces the number of ambiguous client outcomes caused by infrastructure shutdown.
- A later readiness endpoint may be added separately, but it must fail closed on dependency failure without changing `/health` semantics.
- Production operations evidence still requires provider-level alerting, incident handling and controlled field validation; this ADR alone does not close readiness scorecard gate 50.
