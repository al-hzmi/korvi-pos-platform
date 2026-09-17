# ADR-0035 — Production Observability Boundary and Incident Proof

Status: **Accepted**

Date: 2026-09-12

## Context

Korvi already separates liveness (`/health`) from dependency readiness (`/ready`), uses UUIDv7 request identifiers and has a bounded graceful shutdown path. Those controls make failures safer, but they do not by themselves make a production POS/ERP observable.

The remaining repository-level operations gap was a machine-readable telemetry surface with a bounded cardinality/privacy contract, plus an executable incident exercise proving that database loss is detected without turning liveness into a restart storm and that the same process can recover when PostgreSQL returns.

Observability must not become a second data export surface. Tenant IDs, users, product IDs, receipt IDs, request bodies, raw URLs, query strings, credentials and financial values are inappropriate metric labels.

## Decision

### 1. Authenticated Prometheus scrape surface

The API exposes `/metrics` only when `METRICS_AUTH_TOKEN` is configured. Production configuration requires a secret of at least 32 characters, injected from the deployment secret manager. The credential is compared with constant-time byte comparison and is never logged, returned or persisted.

Unauthenticated or incorrect scrape requests receive `401`. Metrics responses use `Cache-Control: no-store`.

### 2. Stable low-cardinality metrics only

The process exposes:

- process uptime;
- in-flight HTTP requests;
- completed request counts by method, Fastify route pattern and status class;
- request-duration histogram by method and Fastify route pattern;
- readiness response counts (`ready` / `not_ready`).

The route label comes from Fastify's registered route pattern, never the raw URL. No merchant/business identifier is a metric label.

### 3. Request correlation is returned to the caller

Every API response carries `x-request-id`, using the same server-generated request identifier that appears in the structured Fastify request log. This lets support correlate a client-visible failure with operator evidence without accepting a caller-supplied authority identifier.

### 4. Logs redact credential-bearing fields and raw runtime exceptions are not serialized

Pino redaction covers authorization/cookie headers and bootstrap password/token fields on the standard request shapes. The generic error handler records the request-scoped correlation plus safe error class/status metadata instead of serializing a database/adapter exception whose message can contain infrastructure or credential detail.

### 5. Incident proof is executable

`.github/workflows/operations-incident-proof.yml` is the repository-level outage/recovery drill. It uses PostgreSQL 17 under a restricted non-`BYPASSRLS` application role, starts the production API runtime, proves healthy/ready state and authenticated telemetry, physically stops PostgreSQL, proves liveness remains `200` while readiness fails closed with `503`, verifies the outage is visible in metrics, restarts PostgreSQL, proves readiness recovers without restarting the API, and finally proves graceful `SIGTERM` shutdown exits successfully.

Only a sanitized proof log is retained. Runtime logs, metrics snapshots and generated credentials are destroyed before artifact upload.

## Boundaries

This ADR does **not** claim Gate 50 by itself. Repository telemetry and a CI incident exercise cannot prove:

- that an external monitoring provider is scraping production;
- that alert rules route to a real on-call/incident owner;
- provider log/metric retention;
- production backup retention, RPO or RTO;
- deployed secret-manager policy/rotation;
- controlled merchant field validation.

Those remain deployment/operations evidence and must be proven separately before Gate 50 closes.

## Rejected alternatives

### Public unauthenticated metrics

Rejected. Even deliberately low-cardinality telemetry exposes service behavior and should not be an anonymous production surface.

### Tenant, branch, user, product or receipt labels

Rejected. They create privacy leakage and unbounded metric cardinality, and they turn an operations plane into a shadow business-data export.

### Raw URL labels

Rejected. IDs and query parameters would leak into telemetry and create one series per resource/request.

### Treating `/health` as readiness

Rejected. A PostgreSQL outage should remove the instance from new traffic without causing an orchestrator restart loop for a healthy process.

### Documentation-only incident readiness

Rejected. An incident runbook without an exercised failure/recovery path is procedure, not evidence.

## Consequences

- Production cannot boot while silently lacking the machine scrape credential.
- Operators have a stable correlation header and a bounded Prometheus surface.
- Database outage and recovery semantics are continuously executable rather than assumed.
- Gate 50 still requires external production/provider and controlled-field evidence.
