# Korvi Production Deployment Architecture

Status: **ENGINEERING CONTRACT READY — EXTERNAL PRODUCTION ACTIVATION NOT YET PROVEN**

This document defines the production-shaped deployment contract for Korvi. It does not claim that a paid production provider, DNS/TLS cutover, real backup plan, external monitoring route, production ZATCA identity or merchant pilot already exists.

## Production topology

The minimum production topology is:

1. Korvi Web/Control surface on an HTTPS origin.
2. Korvi API as a separately deployable Node.js service.
3. PostgreSQL 17+ on a durable production plan with high availability/failover.
4. A restricted runtime database role used only by the API.
5. A separate restricted migration identity used only by the controlled migration process.
6. External secret management for runtime, migration, monitoring and ZATCA secrets.
7. External monitoring/alert routing that consumes Korvi health/readiness/metrics surfaces.
8. Installed Cashier Windows/Android packages using the same cloud authorities and domain contracts.

The application runtime must never receive the migration credential. The migration process must never use the provider administrator or a superuser merely to make a deployment pass.

## Deployment sequence

1. Select one reviewed canonical release SHA.
2. Provision production infrastructure without customer traffic.
3. Create the migration role and runtime role as separate non-superuser, non-BYPASSRLS identities.
4. Configure the production environment using the key inventory in `docs/acquisition/ENVIRONMENT-INVENTORY.md`.
5. Run `scripts/deploy/production-migrate.sh` from the isolated migration plane.
6. Require exact migration ledger proof, zero schema drift and runtime least-privilege proof.
7. Build API/Web from the exact reviewed SHA.
8. Start API with the restricted runtime role only.
9. Verify `/health` liveness and `/ready` database readiness separately.
10. Verify anonymous `/metrics` is refused and an authorized machine scrape succeeds.
11. Verify API and Web report/deploy the same release SHA.
12. Run representative production smoke tests before enabling merchant traffic.
13. Promote traffic only after a named human approval reference is recorded.

Automatic migration from the running API process is forbidden.

## Production RPO / RTO policy

Engineering target until a real production provider and business owner formally accept and measure it:

- **RPO target: ≤ 15 minutes.**
- **RTO target: ≤ 60 minutes.**

These are release requirements, not measured evidence. Gate 50 remains open until a production-equivalent backup/restore rehearsal records measured RPO/RTO that meet the accepted targets.

## Health and readiness

- `/health`: process liveness only. It may remain healthy during a database outage.
- `/ready`: business/runtime readiness. It must fail closed while PostgreSQL is unavailable and recover without weakening authority.
- `/metrics`: machine-only metrics surface protected by `METRICS_AUTH_TOKEN`.

A provider health dashboard is not a substitute for these three application-level signals.

## Production database requirements

Required before activation:

- PostgreSQL 17+;
- durable non-free plan;
- encrypted transport;
- high availability/failover appropriate to the provider;
- encrypted backups with explicit frequency and retention;
- separate migration/runtime authorities;
- no runtime table ownership;
- no runtime schema CREATE;
- no runtime migration-ledger writes;
- FORCE RLS/policy behavior retained;
- actual isolated restore rehearsal.

The free Render staging database is explicitly not production evidence.

## Rollout and rollback

Rollback follows `docs/operations/RELEASE-ROLLBACK.md`.

Code rollback may only target a previously verified SHA that is schema-compatible with the current forward-only database. Database migrations are never rolled backward by editing the Prisma ledger or deleting migration files. When schema/data recovery is necessary, restore into an isolated target and execute `docs/operations/DISASTER-RECOVERY.md` before traffic promotion.

## External Activation Gates

The following cannot be claimed by repository engineering alone:

- durable production provider/plan and region;
- provider-managed HA/failover evidence;
- managed backup frequency/retention evidence;
- measured production-equivalent RPO/RTO;
- production DNS/TLS/domain cutover;
- external monitoring provider and real alert routing;
- named on-call contact channel and exercised acknowledgement;
- production secret-manager evidence and rotation exercise;
- production ZATCA credentials/customer identity/provider path;
- real merchant field validation/pilot.

Until these exist, AR-4 remains **ENGINEERING READY / EXTERNAL ACTIVATION OPEN**, not Production Proven.
