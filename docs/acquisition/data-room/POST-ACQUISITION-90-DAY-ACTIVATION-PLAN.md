# KORVI — Post-Acquisition / Post-Funding 90-Day Activation Plan

This plan starts from source release:

`61dbb34dea08809756fd767b907b0e852b7e5978`

It assumes no new speculative product-development program unless field evidence reveals a material defect or the buyer explicitly expands scope.

## Days 0–15 — Control transfer and production design

Objectives:

- establish legal/technical ownership boundaries;
- preserve source/evidence integrity;
- select production providers;
- establish repository governance.

Actions:

- finalize IP/source/brand/account transaction scope;
- transfer or recreate GitHub/cloud/domain control as applicable;
- enable buyer-approved branch protection/rulesets;
- define final release/default branch policy;
- select production PostgreSQL topology;
- select secret manager;
- select monitoring/alert provider;
- bind real on-call roles/channels;
- select/confirm Azure HSM/Key Vault production ownership model;
- confirm merchant/legal entity that will own Production ZATCA activation;
- preserve exact acquisition source/evidence archive.

Exit criteria:

- ownership/control matrix approved;
- production architecture approved;
- no plaintext-secret handoff;
- release governance active.

## Days 16–30 — Production infrastructure activation

Objectives:

- create production-shaped environment without merchant traffic yet.

Actions:

- provision production database;
- create separate migration/runtime restricted roles;
- activate managed backups/retention;
- configure DNS/TLS;
- configure secret manager;
- configure external monitoring;
- configure alert delivery;
- deploy the exact approved release;
- verify health/readiness/metrics;
- execute isolated backup/restore rehearsal;
- measure restore duration;
- record initial RPO/RTO evidence;
- execute controlled outage/alert drill.

Exit criteria:

- production infrastructure evidence exists;
- alerts route to real operators;
- backup/restore is measured;
- no elevated runtime DB authority.

## Days 31–45 — Production ZATCA activation

Objectives:

- close the real regulatory activation boundary for the actual merchant/legal entity.

Actions:

- provision Azure production signing authority/HSM path;
- establish non-exportable signing key custody;
- activate merchant production identity;
- complete Production CSID lifecycle;
- perform controlled production reporting/clearance tests;
- prove retry/reconciliation behavior;
- test credential/key rotation/recovery process;
- preserve provider evidence without exposing keys/secrets.

Exit criteria:

- Production ZATCA evidence is real and attributable to the merchant/legal entity;
- simulation remains unavailable as a production substitute.

## Days 46–60 — Controlled Merchant Production Pilot

Objectives:

- validate real operational use on the approved production release.

Actions:

- onboard one controlled merchant/branch/terminal cohort;
- migrate agreed data;
- train operator(s);
- execute real shift lifecycle;
- observe payments/returns/inventory;
- exercise offline/reconnect where operationally safe;
- monitor incidents/latency;
- capture acceptance issues;
- preserve merchant sign-off;
- stop/rollback according to predefined criteria if integrity is uncertain.

Exit criteria:

- real field evidence exists;
- AR-7 can be evaluated honestly;
- any material defect is classified before widening rollout.

## Days 61–75 — Closure and hardening from field evidence

Objectives:

- fix only evidence-backed issues;
- avoid feature creep.

Actions:

- address P0/P1 field defects;
- rerun impacted regression/proof gates;
- create a new final candidate SHA only if code changed;
- refresh exact-SHA evidence;
- re-run security/tenant/financial regression scope where impacted;
- verify operational runbooks against actual production procedures.

Exit criteria:

- no unresolved blocking defect;
- final candidate/evidence relationship is exact.

## Days 76–90 — Final acquisition/production gate

Objectives:

- assemble final evidence and close governance.

Actions:

- populate final evidence manifest;
- bind production/HA/backup/RPO/RTO evidence;
- bind monitoring/on-call evidence;
- bind Production ZATCA evidence;
- bind Merchant Pilot evidence;
- bind legal/account-transfer evidence;
- run manual Final Acquisition Gate;
- human-review all external references;
- create final signed/tagged release record;
- archive residual risks and exclusions.

Exit criteria:

Korvi may only then be described as Production Proven / Final Canonical Acquisition Release if the actual evidence supports those terms.
