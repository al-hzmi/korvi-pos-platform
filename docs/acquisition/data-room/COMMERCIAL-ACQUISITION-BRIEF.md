# KORVI — Commercial Acquisition Brief

Source release:

`61dbb34dea08809756fd767b907b0e852b7e5978`

Status:

**BUYER-EVALUABLE CANONICAL ACQUISITION CANDIDATE**

## What is being acquired

The technical asset under diligence is a unified Korvi POS/business operating platform codebase and its associated engineering documentation, release evidence and operational runbooks.

The current acquisition candidate consolidates the verified product/security/restaurant/migration work into one source lineage.

Subject to final transaction scope and legal instrument, an acquisition package may include:

- source code and Git history;
- web/API applications;
- installed-client source and build pipelines;
- database schema/migrations;
- domain/business logic;
- migration engine;
- restaurant/KDS/BOM/waste capabilities;
- Retail/Core POS capabilities;
- Platform Admin/control-plane capabilities;
- deployment/runbooks;
- DR/incident/rollback procedures;
- ZATCA engineering implementation and boundaries;
- acquisition/due-diligence documentation;
- brand/domain/cloud assets only if explicitly included by transaction documents.

## Current product position

Korvi is not a demo-only repository.

The canonical release contains real operator workflows for:

- electronic tender;
- mixed tender;
- original-sale return/refund;
- shift close;
- cash reconciliation;
- retail/core operations;
- restaurant/KDS-related operations;
- migration/onboarding baseline;
- installed-client paths.

The system also carries a strong engineering emphasis on:

- tenant isolation;
- PostgreSQL RLS;
- server-authoritative money/stock/security;
- idempotency;
- auditability;
- migration safety;
- fail-closed production ZATCA boundaries;
- offline/retry integrity.

## What has been de-risked before acquisition

The adopted acquisition program has already closed internally:

- source-of-truth branch fragmentation;
- Platform Admin durable session-revocation gap;
- core electronic/mixed tender operator workflow gap;
- original-sale return/refund operator workflow gap;
- shift-close/reconciliation workflow gap;
- canonical integration of current Retail/Restaurant/Migration/Security work;
- internal Production Operations engineering package;
- internal Production ZATCA engineering proof package;
- engineering buyer/handoff package;
- hosted staging deployment drift for evaluation.

## What the buyer is NOT being told

The current package does not claim:

- Production Proven;
- Merchant Proven;
- Production ZATCA Activated;
- final production HA/SLA;
- completed real Merchant Production Pilot;
- executed IP assignment;
- transferred production accounts/domains/credentials;
- direct PSP acquiring/payment-processing platform capability;
- completed Play/App Store production distribution lifecycle;
- a specific revenue/customer valuation.

## Main remaining activation work

A buyer or continuing owner must still activate/prove, according to final scope:

- real production infrastructure;
- HA/failover and managed backups;
- measured production-equivalent RPO/RTO;
- external monitoring and on-call;
- production secret management;
- real Azure HSM / Production ZATCA identity/CSID/reporting;
- merchant production field validation;
- legal IP/account/domain transfer;
- repository governance/rulesets;
- final transaction-specific third-party license review.

## Buyer advantage

The main remaining work is no longer broad product reconstruction.

The buyer receives an engineering candidate where the major remaining gates are primarily:

- production activation;
- regulatory activation;
- field validation;
- transaction/legal transfer.

This reduces integration ambiguity compared with acquiring several independent product/security branches.

## Evaluation package

The data room contains:

- exact source SHA;
- exact-SHA CI/PostgreSQL/DR/incident/device/ZATCA evidence;
- hosted staging aligned to source SHA;
- buyer acceptance test plan;
- technical Q&A;
- risk register;
- environment inventory;
- dependency/license technical inventory;
- ownership/handoff checklists;
- external activation disclosures;
- preserved evidence archive with checksums.

## Transaction rule

The transaction agreement, not this repository, defines exactly what is sold, assigned, licensed or excluded.

No technical document should be interpreted as transferring legal title by itself.
