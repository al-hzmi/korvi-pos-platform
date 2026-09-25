# Korvi Controlled Merchant Production Pilot Runbook

Status: **AR-7 PREPARED — REAL MERCHANT EXECUTION REQUIRED**

This runbook prepares the controlled Merchant Production Pilot. It does not replace the pilot and it must not turn staging, synthetic tenants, employee demos or internal dry runs into production evidence.

## Pilot identity

Every pilot must be bound to:

- one exact canonical release SHA;
- branch `release/canonical-acquisition-v1`;
- one real merchant organization;
- one production environment;
- a defined pilot scope/time window;
- merchant/operator acceptance evidence;
- a Korvi technical reviewer;
- a business release owner.

Do not commit merchant secrets, tax credentials, private identifiers or personal contact data. Store durable evidence references only.

## Entry criteria

Before merchant traffic is enabled:

1. canonical CI is green on the candidate SHA;
2. PostgreSQL restricted-role/live verification is green;
3. relevant Chrome/operator proof is green;
4. installed-client proof is green where that client is in scope;
5. production migration/runtime identities are separated;
6. production provider, backup retention and external monitoring are active;
7. measured RPO/RTO meet the accepted production targets;
8. real production ZATCA is activated where required;
9. incident/rollback contacts are bound to real channels;
10. explicit go/no-go approval is recorded.

AR-4/AR-5/AR-6 external activation gates must not be bypassed merely to begin AR-7.

## Change freeze

The pilot release SHA is frozen for the pilot window. Any code change requires a new SHA, affected proof reruns, and a documented decision to restart or re-approve the pilot. No force-push, history rewrite or silent environment drift is allowed.

## Merchant onboarding evidence

Record actual evidence for merchant provisioning, branch/terminal provisioning, member/permission setup, plan configuration, source-data import where applicable, migration preview/dry-run/commit outcome, and row-level exceptions. Direct SQL customer/tenant fixtures do not count.

## Operator workflow evidence

When applicable to the merchant, record actual operator use of:

- login/session and open shift;
- cash sale;
- full electronic tender;
- mixed tender;
- receipt rendering/printing;
- return and cash/electronic refund;
- shift close and cash reconciliation;
- stock decrement/restoration;
- inventory lookup/adjustment/count;
- restaurant order/preparation/waste flow if restaurant features are in scope.

Money, stock, VAT, permissions and ZATCA facts remain server authoritative.

## Offline / reconnect evidence

If installed cashier offline capability is used, record offline lease validity, offline capture, durability across restart, reconnect, idempotent replay, server reconciliation, conflict/ambiguous-outcome handling and final authoritative truth. Offline operation must never fabricate a successful external ZATCA result.

## Production Operations evidence

Record provider/region, HA/failover, managed backup schedule/retention, restore rehearsal, measured RPO/RTO, external monitoring, real alert delivery, on-call acknowledgement, escalation, secret rotation/custody and rollback readiness.

Engineering target remains **RPO ≤ 15 minutes / RTO ≤ 60 minutes** unless governance explicitly adopts another production target.

## Production ZATCA evidence

Where applicable, record real non-exportable HSM custody, remote sign/verify, merchant production identity, Production CSID lifecycle, reporting/clearance, retry/reconciliation and rotation/recovery.

Simulation, staging credentials and local software-key substitutes do not count.

## Stop conditions

Stop the pilot on cross-tenant/permission uncertainty, money/VAT/stock mismatch, unreconciled payment or ZATCA ambiguity, migration/schema drift, excessive runtime database authority, unknown backup state, unprovable release SHA, repeated readiness failure or rollback criteria.

Resume only after authoritative reconciliation and a new go/no-go decision.

## Acceptance

AR-7 closes only after a real merchant pilot evidence package is reviewed and accepted by the responsible technical/business owners. Automated CI, browser, DR, incident and staging proofs are necessary context but are not Merchant Pilot evidence.

The final evidence contract is defined in `docs/acquisition/schemas/final-acquisition-evidence.schema.json`.
