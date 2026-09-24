# Korvi Monitoring, Alerting and On-Call Model

Status: **ENGINEERING POLICY READY — EXTERNAL ROUTING ACTIVATION REQUIRED**

Korvi exposes liveness, readiness and protected metrics. This runbook defines the minimum production monitoring model without selecting or paying for a provider.

## Required alert classes

Gate 50 requires all four classes:

1. **availability** — API/Web unreachable or repeated failed liveness checks;
2. **readiness** — API alive but `/ready` fails because an operational dependency is unavailable;
3. **5xx** — sustained server-error rate on business endpoints;
4. **latency** — sustained high latency on critical cashier/business operations.

## Engineering default thresholds

These are default production requirements and may be tightened by the selected provider/SLA:

- Availability: page after 2 consecutive failed external checks within 2 minutes.
- Readiness: page when `/ready` remains non-200 for 2 minutes.
- 5xx: page when server-error rate exceeds 2% over 5 minutes with at least 20 requests; warn earlier if a single C0 route shows repeated 5xx.
- Latency: warn when p95 critical API latency exceeds 2 seconds for 10 minutes; page if the condition combines with checkout/return/shift failures.
- Authentication abuse: alert on sustained login-admission exhaustion or abnormal lockout volume.
- ZATCA: alert on durable submission ambiguity/retry backlog growth, but do not convert an externally unknown outcome into success.

These thresholds are not production evidence until connected to a real monitoring route and exercised.

## Severity and escalation

- **SEV-0:** integrity, cross-tenant, credential, financial/stock/regulatory corruption risk. Stop affected writes if needed. Escalate immediately to Engineering Lead + Executive Owner.
- **SEV-1:** material merchant outage or checkout/database unavailability. Primary On-Call owns containment and escalates to Engineering Lead.
- **SEV-2:** partial degradation with bounded workaround. Primary On-Call owns recovery and follow-up.
- **SEV-3:** localized presentation/non-authoritative defect.

Role model:

1. Primary On-Call — acknowledges and owns initial incident.
2. Engineering Lead — owns technical containment/rollback/restore decision.
3. Executive Owner — owns merchant communication, business stop/go and production-risk acceptance.
4. Specialist escalation — security, ZATCA/provider or database expertise when the incident domain requires it.

No person names are hardcoded in the repository. The production evidence bundle must bind these roles to real contacts/channels.

## Logging requirements

Operational logs must:

- include request/deployment correlation IDs;
- avoid passwords, connection URLs, session cookies, private keys, ZATCA secrets and bearer tokens;
- record safe reason codes rather than raw sensitive payloads;
- preserve UTC timestamps and release SHA;
- retain enough context to reconcile ambiguous commands through authoritative database/idempotency/audit state.

## Alert drill

Before Gate 50 can close, execute a real alert drill that proves:

- the external signal fires;
- routing reaches the actual on-call channel;
- acknowledgement time is recorded;
- escalation path is usable;
- evidence contains no secrets.

The existing incident workflow proves Korvi's internal outage/readiness/recovery behavior, but does not claim a real external pager route.
