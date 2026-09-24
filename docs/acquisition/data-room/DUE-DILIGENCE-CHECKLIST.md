# Buyer Technical Due-Diligence Checklist

Release under review: `61dbb34dea08809756fd767b907b0e852b7e5978`

## Product / workflows

- [x] one canonical release lineage identified;
- [x] electronic tender operator workflow;
- [x] mixed tender operator workflow;
- [x] original-sale return/refund workflow;
- [x] shift close;
- [x] cash reconciliation;
- [x] Retail/Core included;
- [x] Restaurant/KDS/recipe/BOM/production/waste included;
- [x] Migration Engine baseline through M6;
- [ ] no-receipt return/exchange if transaction scope requires it;
- [ ] direct PSP acquiring adapter if transaction scope requires Korvi-managed payment authorization.

## Engineering / security

- [x] CI exact-SHA green;
- [x] PostgreSQL restricted-role proof;
- [x] RLS/tenant isolation architecture and proof;
- [x] Platform Admin server-side revocable sessions;
- [x] DR engineering rehearsal;
- [x] incident outage/recovery engineering proof;
- [x] Windows installed-client proof;
- [x] Android installed-client build proof;
- [x] dependency audit evidence on release lineage;
- [ ] final third-party license legal review;
- [ ] repository-owner governance/rulesets activation as required by transaction.

## Hosted evaluation

- [x] API staging aligned to canonical SHA;
- [x] Web staging aligned to canonical SHA;
- [x] API health verified after deployment;
- [x] canonical migrations applied;
- [x] operator commercial smoke exercised;
- [ ] replace free/expiring staging database if evaluation continues beyond provider expiration;
- [ ] do not treat staging topology as production evidence.

## Production Operations

- [x] production deployment contract/runbook;
- [x] backup/restore engineering procedure;
- [x] incident/rollback runbooks;
- [x] target RPO <= 15 minutes / RTO <= 60 minutes policy;
- [x] monitoring/on-call model;
- [ ] real production provider plan;
- [ ] real HA/failover;
- [ ] managed backup retention;
- [ ] measured production-equivalent RPO/RTO;
- [ ] external monitoring and actual alert delivery;
- [ ] actual on-call channel/acknowledgement drill;
- [ ] production secret manager and rotation exercise.

## ZATCA

- [x] internal UBL/hash/canonicalization/signing boundaries;
- [x] CSID persistence/lifecycle engineering;
- [x] submission/retry/reconciliation engineering;
- [x] production fail-closed behavior;
- [x] staging simulation separated and marked NOT FOR TAX USE;
- [ ] real Azure HSM/non-exportable production key;
- [ ] real merchant ZATCA production identity;
- [ ] Production CSID;
- [ ] real reporting/clearance;
- [ ] real production reconciliation;
- [ ] production rotation/recovery evidence.

## Commercial / field proof

- [ ] real Merchant Production Pilot;
- [ ] production traffic evidence;
- [ ] merchant acceptance record.

## Legal / transaction

- [x] ownership/IP/licensing position documented technically;
- [x] dependency/supply-chain handoff documented;
- [ ] explicit IP assignment/license instrument;
- [ ] contributor/contractor chain-of-title confirmation;
- [ ] third-party license legal review;
- [ ] account/domain/credential transfer schedule;
- [ ] final repository ownership/governance transfer;
- [ ] transaction approvals.

## Final release

- [ ] final acquisition evidence manifest on exact final SHA;
- [ ] manual final acquisition gate passes;
- [ ] external evidence human-validated;
- [ ] final signed/tagged acquisition release record created;
- [ ] residual risks/exclusions recorded.

Until the unchecked external/transaction items required by scope are satisfied, do not label Korvi Production Proven or Final Canonical Acquisition Release.
