# Korvi Deferred External Activation Gates

Status: **AUTHORITATIVE DEFERRED-ITEM REGISTER**

The following items are intentionally not fabricated or purchased before they are actually needed.

## AR-4 Production Operations

Internal engineering evidence is complete on canonical SHA
`48400d02a3990eecd6169933c207e282d9371084`.

Verified without paid production resources:

- PostgreSQL 17 restricted migration/runtime authority;
- logical backup and isolated restore;
- restored schema/RLS/application truth;
- dependency-outage fail-closed readiness and recovery;
- graceful drain;
- deployment/rollback/monitoring/on-call contracts;
- secret-free retained evidence.

This is engineering evidence, not real production activation.

External activation still requires:

- durable production PostgreSQL/provider plan;
- real HA/failover configuration;
- managed backup frequency/retention;
- production-equivalent restore with measured RPO/RTO;
- production DNS/TLS;
- external monitoring provider and alert route;
- real on-call contact binding and drill;
- production secret-manager/rotation evidence.

Target policy exists now: RPO ≤ 15 minutes, RTO ≤ 60 minutes. Measured evidence does not.

## AR-5 Production ZATCA

Production remains fail-closed.

External activation requires at least:

- real Azure Key Vault Premium/EC-HSM path required by the accepted design;
- production signing key/custody evidence;
- merchant/customer ZATCA identity and credentials;
- Production-CSID lifecycle against real authority;
- production reporting/clearance calls and reconciliation evidence.

Staging simulation is not valid production evidence and must never activate in production.

## AR-6 Acquisition / Handoff

The engineering package is complete and mechanically checked on the canonical lineage.

Transaction-level activation remains external.

Transaction-level diligence still requires:

- explicit IP assignment/license instrument;
- contributor/contractor chain-of-title confirmation as applicable;
- third-party license review;
- credential/account/domain transfer plan if those assets are included;
- repository-owner activation of branch protection/rulesets when administration access is available.

The current GitHub connection cannot administer branch protection. No protection state is fabricated.

## AR-7 Merchant Pilot

Only a real merchant can close this gate. Synthetic or staging tenants do not count.

Required pilot evidence must be bound to the exact pilot release SHA and include actual onboarding, operator workflows, return/shift, stock, offline/reconnect and rollback/incident readiness appropriate to that merchant.

## AR-8 Final acquisition release

AR-8 cannot close until the required external activation gates above are satisfied or explicitly excluded by the final transaction scope with truthful residual-risk disclosure.
