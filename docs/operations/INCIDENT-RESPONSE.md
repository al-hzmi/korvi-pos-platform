# Korvi POS — Incident Response Runbook

Status: **ACTIVE OPERATOR BASELINE — NOT YET A PRODUCTION-GATE PASS**

This runbook governs production-like incidents for the Korvi API, web application and PostgreSQL authority. It complements `DISASTER-RECOVERY.md`; it does not replace the domain invariants, RLS, idempotency or accounting/stock truth.

## 1. Non-negotiable incident rules

1. **Preserve truth before restoring convenience.** Do not alter sales, returns, stock, costing, shifts or audit rows directly to make a symptom disappear.
2. **No direct SQL business repair.** A data repair must use an existing audited authority or a separately reviewed migration/repair procedure with before/after evidence.
3. **Never disable RLS, idempotency, origin checks, permission checks or financial invariants during an incident.** A degraded service is safer than an unbounded one.
4. **Do not log or paste secrets.** Connection URLs, passwords, session cookies, bootstrap capabilities and private keys stay in the secret manager and approved operational channels.
5. **Record exact identifiers.** Capture deployment SHA, UTC timestamps, request IDs, tenant/branch/terminal identifiers where legitimately available, HTTP status and the operator action taken.
6. **Evidence precedes destructive action.** Before restart/rollback/restore, capture the minimum logs and provider state needed to reconstruct the incident.

## 2. Severity model

### SEV-0 — integrity/security emergency

Examples: suspected cross-tenant exposure, unauthorized privileged action, financial/stock corruption, credential compromise, accepted duplicate transaction, regulatory artifact corruption.

Actions: stop the affected write path or service if necessary; preserve evidence; rotate affected secrets when relevant; do not self-remediate data; require senior engineering/security review before reopening writes.

### SEV-1 — critical merchant outage

Examples: checkout unavailable for a material merchant set, database unavailable, widespread login failure, sustained 5xx on core cashier APIs, deployment that cannot drain/recover.

Target: acknowledge immediately; establish incident owner; begin containment and evidence capture before broad changes.

### SEV-2 — degraded operation

Examples: elevated latency, partial back-office failure, one non-critical workflow unavailable, repeated readiness failures while liveness remains healthy.

### SEV-3 — localized defect

Examples: isolated UX defect or bounded non-authoritative presentation problem with a known workaround and no integrity risk.

Severity can only move downward after evidence shows the higher-risk condition is absent.

## 3. First 15 minutes

1. Name one incident owner and record UTC start time.
2. Identify exact environment and deployment SHA. Do not assume web/API parity.
3. Confirm whether `/health` is alive and separately whether business/database operations are failing.
4. Capture representative request IDs, HTTP statuses and safe log excerpts. Do not copy cookies, authorization headers or request bodies containing credentials.
5. Determine blast radius: tenants, branches, terminals, routes, and whether reads, writes or both are affected.
6. Classify the risk domain: security/tenancy, financial transaction, inventory/costing, authentication, infrastructure, or presentation only.
7. For write-path ambiguity, prefer temporarily refusing new writes over guessing whether prior work committed.
8. Before rollback, verify the target SHA and migration compatibility. Existing migrations are forward-only and are never rewritten during incident response.

## 4. Core incident playbooks

### Database unavailable / connection failures

- Keep liveness distinct from database readiness; do not create a restart storm solely because PostgreSQL blipped.
- Check provider database state, application-role reachability and recent deploy/migration evidence.
- Do not switch the application to an administrator or BYPASSRLS role.
- If recovery requires restore, follow `DISASTER-RECOVERY.md` and restore into an isolated target before cutover.

### Elevated checkout/return/inventory 409s

- A 409 can be correct invariant enforcement. Inspect the application reason and business preconditions before labeling it an outage.
- Do not bypass insufficient-stock, stale-revision, idempotency or locked-observation refusals.
- Correlate the request ID with the domain/audit record and verify whether the command committed before advising a retry.

### Elevated 5xx

- Group by route, deployment SHA and request ID rather than by raw error text alone.
- Compare with the immediately previous known-good SHA and CI/PostgreSQL proof.
- If rollback is chosen, verify schema compatibility first. Never roll migrations backward by editing migration history.

### Authentication or origin failures

- Distinguish invalid credentials, lockout, expired session, tenant lifecycle state and origin refusal.
- Do not weaken cookie flags or origin enforcement to restore access.
- If compromise is suspected, revoke sessions/rotate credentials through the existing authorities and preserve audit evidence.

### Suspected tenant isolation failure

Treat as SEV-0 until disproven.

- Stop or isolate the affected write/read surface if necessary.
- Preserve request IDs, tenant IDs, role information and RLS/provider state.
- Verify the application database role does not have `BYPASSRLS`/superuser privileges and that FORCE RLS remains present.
- Do not query unrelated tenant data merely to "see how far it goes"; use a controlled reproduction with synthetic tenants.

## 5. Deployment and shutdown evidence

API termination is expected to log a safe `graceful shutdown started` event, then exit cleanly after Fastify drains. A close failure or 25-second deadline exits non-zero. Repeated signals do not start parallel drains.

A non-zero drain outcome is operational evidence; it is not proof that a business transaction failed. Transaction state must be determined from the authoritative database/idempotency/audit facts before retrying or compensating.

## 6. Recovery acceptance

An incident is not resolved merely because the page loads again. Before declaring recovery:

- exact web/API deployment SHAs are known;
- health and the affected business workflow are both verified;
- no invariant/RLS/permission weakening remains;
- ambiguous transactions are reconciled through authoritative records;
- any restore has migration/RLS/application proof;
- temporary credentials, files or bypass infrastructure used during recovery are removed;
- follow-up defects/actions have an owner.

## 7. Post-incident record

For SEV-0/1 and material SEV-2 incidents record:

- timeline in UTC;
- detection source;
- exact SHAs/environment;
- impact and affected scope;
- root cause and contributing factors;
- evidence used to establish transaction/data truth;
- containment and recovery actions;
- whether RPO/RTO targets were met (once production targets are formally established);
- preventive code/test/runbook/alert changes.

## 8. Remaining Production Operations work

This runbook and the automated DR rehearsal are engineering foundations only. Gate 50 remains open until production-grade external monitoring/alert routing, retention and RPO/RTO evidence, an exercised incident drill, secret-management verification and controlled merchant field validation are complete.
