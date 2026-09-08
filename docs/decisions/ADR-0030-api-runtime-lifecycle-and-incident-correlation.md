# ADR-0030 — API Runtime Lifecycle and Incident Correlation

Status: **Accepted**

Date: 2026-09-08

## Context

Korvi already has server-derived authority, exact request IDs, structured Fastify logging, isolated staging preflight and a liveness endpoint. That is not sufficient production operations evidence by itself.

Two runtime properties were still inconsistent:

1. the staging entrypoint drained Fastify on `SIGTERM`/`SIGINT`, while the normal API entrypoint exited without the same bounded drain contract;
2. incident handling existed as engineering practice but was not encoded as an operator runbook with severity, evidence-preservation and no-direct-database-fix rules.

A POS/ERP process can be terminated while a checkout, receipt, return or inventory command is in flight. The database authorities are transactional and idempotent, but the process should still stop accepting new work and give already-started HTTP requests a bounded chance to finish. Runtime shutdown semantics must therefore be common infrastructure, not staging-only behavior.

## Decision

### 1. One shutdown authority

All API entrypoints install the same `installGracefulShutdown` runtime helper after the listener is live.

On the first `SIGTERM` or `SIGINT` it:

- becomes idempotently `stopping`;
- invokes Fastify `app.close()` so new work is no longer accepted and in-flight requests can drain;
- allows at most 25 seconds for the drain;
- exits `0` only after Fastify closes successfully;
- exits `1` on close failure or deadline expiry;
- never logs the raw close error because adapter errors can contain connection details.

A second signal cannot start a second close sequence.

### 2. Transaction and idempotency authorities remain unchanged

Graceful shutdown is not a substitute for transactional safety. Checkout, returns, shifts, inventory and purchasing continue to rely on their existing database transactions, idempotency identities and locked observations. No request is declared successful because a process happened to drain cleanly.

### 3. Incident correlation is evidence-first

The operator runbook in `docs/operations/INCIDENT-RESPONSE.md` is the authority for severity, first-response actions, evidence capture and escalation. Existing UUIDv7 Fastify request IDs are the primary HTTP correlation key until the observability stack is expanded.

### 4. Production Operations gate remains open

This ADR does **not** claim Product Readiness Gate 50. External telemetry/alerting, production retention/RPO/RTO evidence, an incident exercise and controlled field validation still require separate proof.

## Rejected alternatives

### Immediate `process.exit()` on termination

Rejected. It can cut off a response or connection while business work is settling and creates avoidable ambiguity for clients deciding whether to retry.

### A staging-only shutdown path

Rejected. Production and staging must not have materially different termination semantics.

### Unlimited graceful drain

Rejected. A deadlocked or wedged process must not block a deployment or recovery indefinitely.

### Logging raw shutdown/driver failures

Rejected. Operational logs are not a license to disclose connection strings or secret-bearing adapter details.

## Consequences

- Normal and staging API startup now share one termination contract.
- Signal handling is directly regression-tested for success, duplicate signals and close failure.
- Operators have an explicit incident-response baseline without pretending that documentation alone constitutes an exercised production process.
