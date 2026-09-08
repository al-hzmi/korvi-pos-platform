# ADR-0030 — Production API lifecycle and readiness

Status: Accepted

## Context

Korvi has a deliberately shallow liveness endpoint: `/health` proves that the HTTP process can answer and must not restart a healthy process merely because PostgreSQL blinks. That is correct liveness behavior, but it is not sufficient deployment readiness. Before this ADR, the generic production entrypoint could also boot without `DATABASE_URL`, and unlike the staging entrypoint it did not drain Fastify on `SIGTERM`/`SIGINT`.

A production POS/ERP API must distinguish three facts:

1. the process is alive;
2. the process can serve database-backed traffic now;
3. the process is shutting down and must stop accepting new work before termination.

These are operational controls, not business-authority shortcuts. Readiness must not bypass RLS, mutate tenant data, or require administrative database authority.

## Decision

1. `/health` remains liveness-only and never queries PostgreSQL.
2. `/ready` is a separate readiness probe. It executes only a constant `SELECT 1` through the same restricted application Prisma client used by runtime services. Success returns HTTP 200; missing/unreachable database returns HTTP 503 with a generic body. Raw driver details are never returned.
3. `DATABASE_URL` is mandatory when `NODE_ENV=production`. Development/test may still construct a liveness-only server without a database.
4. Runtime database-backed services share one lazily-created Prisma client per API process. This avoids multiplying connection pools across auth, cashier, admin, catalogue, inventory, purchasing, onboarding and bootstrap surfaces.
5. Fastify `onClose` disconnects that shared Prisma client if it was created.
6. Both production and staging entrypoints handle `SIGTERM` and `SIGINT`, stop only once, call `app.close()` to drain HTTP work and trigger database disconnect, and retain a bounded 25-second hard deadline so a wedged shutdown cannot hang deployment indefinitely.
7. Runtime logs redact common credential-bearing HTTP headers. Unexpected errors remain server-side; client responses continue to use generic error codes.

## Non-goals

- Readiness is not a migration check. Migration/RLS authority remains startup/deployment preflight where explicitly configured.
- Readiness is not tenant health and does not execute tenant-scoped business reads.
- This ADR does not claim production monitoring, alert routing, SLOs, incident response or field validation are complete.

## Verification requirements

- Unit proof that liveness remains 200 when readiness is unavailable.
- Unit proof that readiness returns 200 only on a successful probe and 503 on false/rejected probes.
- Configuration proof that production refuses to load without `DATABASE_URL` while development/test behavior remains legal.
- Exact-head CI, PostgreSQL live proof and DR restore proof remain mandatory before advancing the active strike branch.
