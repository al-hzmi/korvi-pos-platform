# KORVI — Private Evidence Request List

Purpose: define what should be collected in a **private buyer diligence room** when a real transaction begins.

Do not place the following evidence in the public repository when it contains secrets, PII, account identifiers, legal documents or merchant data.

## Corporate / legal

Request or prepare as applicable:

- seller legal identity;
- buyer legal identity;
- IP assignment/license draft;
- contributor/contractor agreements or assignment records;
- brand/trademark ownership evidence if included;
- domain ownership records if included;
- transaction asset schedule;
- warranties/disclosures agreed by counsel.

## Repository / source control

- repository ownership/admin screenshot or export;
- collaborator/access review;
- final branch/ruleset settings;
- final release/tag/signature evidence;
- exact source archive checksum if a transaction archive is created;
- PR/review history relevant to final release.

## Cloud / infrastructure

For the final production environment, privately retain:

- provider account ownership evidence;
- service IDs/regions/plans;
- HA/failover configuration;
- backup policy/retention configuration;
- restore rehearsal output;
- measured RPO/RTO;
- DNS/TLS ownership/configuration;
- secret-manager ownership/configuration;
- production deployment SHA evidence.

Do not disclose secret values.

## Monitoring / incident

- monitoring provider account ownership;
- alert policy screenshots/exports;
- actual alert delivery evidence;
- on-call channel ownership;
- acknowledgement timestamps;
- incident/DR drill record;
- escalation contact list.

## ZATCA production

Only when legally/operationally appropriate:

- merchant production identity evidence;
- Production CSID lifecycle evidence;
- HSM/Key Vault ownership/configuration;
- non-exportable key-custody evidence;
- production reporting/clearance evidence;
- retry/reconciliation evidence;
- credential/key rotation and recovery drill evidence.

Never copy private signing keys into diligence documents.

## Merchant / field validation

If a real Merchant Production Pilot occurs:

- merchant identity/authorization to use evidence;
- pilot scope;
- exact release SHA;
- onboarding/migration evidence;
- branch/terminal/operator evidence;
- payment/return/shift/stock evidence;
- offline/reconnect evidence where applicable;
- incident/rollback readiness;
- merchant acceptance/sign-off;
- issues/residual risks.

Redact customer PII and commercially sensitive records.

## Commercial proof

If applicable:

- executed customer contracts;
- invoices;
- revenue ledger/extract;
- receivables;
- support commitments;
- SLA obligations;
- pipeline only if clearly distinguished from contracted business.

This technical data room currently asserts none of those commercial facts.

## Evidence integrity

For important private artifacts:

- preserve original export;
- record UTC collection time;
- record collector;
- record source system;
- compute file checksum;
- bind evidence to exact release/environment where relevant;
- redact only copies, not the preserved original;
- maintain a private index of redactions.

Private evidence should strengthen, not replace, the fail-closed public acquisition gate.
