# Production API operations runbook

This runbook covers the API process lifecycle controls introduced by ADR-0030. It does not replace the disaster-recovery runbook or the Stage 5D browser/Human Gate.

## Probes

- `GET /health` is **liveness only**. It must remain independent of PostgreSQL so an orchestrator does not restart a healthy process during a transient database outage.
- `GET /ready` is **traffic readiness**. It returns 200 only when the restricted runtime application connection can execute a constant `SELECT 1`; otherwise it returns 503 with a generic body.
- Deployment/load-balancer traffic gates should use `/ready`. Process restart policy may use `/health`.

## Production boot prerequisites

When `NODE_ENV=production`, configuration parsing refuses to boot unless all of these are present:

- `DATABASE_URL`
- exact `APP_ORIGINS`
- `BOOTSTRAP_SIGNING_KEY`

Port values outside 1-65535 are rejected before `listen()`.

## Database connections

The API owns one lazily-created Prisma client per process and shares it across auth, cashier, admin, catalogue, inventory, purchasing, onboarding and bootstrap services. Tenant isolation continues to be transaction-local and FORCE-RLS-backed; this connection sharing does not alter tenant authority.

Do not create one application Prisma client per route/service as an operational workaround. That multiplies pools and defeats bounded shutdown.

## Shutdown

Both the ordinary production entrypoint and staging entrypoint install one-shot handlers for `SIGTERM` and `SIGINT`:

1. stop accepting new HTTP work through `app.close()`;
2. drain in-flight Fastify requests;
3. run `onClose`, including Prisma disconnect;
4. exit 0 after clean close;
5. exit 1 on close failure or after the 25-second hard deadline.

A second signal does not start a second close sequence.

## Logging safety

Authorization, Cookie and Set-Cookie headers are redacted by the Fastify logger. Public readiness/error bodies never contain raw driver details. Secrets remain configuration-only and must never be deliberately placed in log message strings.

## What this does not prove

This runbook does not close production operations by itself. Gate #50 still requires production-equivalent monitoring/alert routing, incident handling evidence, backup retention/RPO/RTO validation and controlled field rollout evidence.
