# KORVI Acquisition Data Room — READ ME FIRST

Status: **BUYER / DUE-DILIGENCE OVERLAY**
Source release: `61dbb34dea08809756fd767b907b0e852b7e5978`
Source branch: `release/canonical-acquisition-v1`
Data-room branch: `docs/acquisition-data-room-61dbb34`

## Purpose

This folder is the acquisition reading layer for Korvi. It does **not** change the buyer-evaluable runtime or the frozen canonical SHA.

Use this folder before interpreting older scorecards, capability matrices or release notes. Historical governance files remain valuable records, but some were written before the canonical integration closed later capabilities.

## Current defensible description

**KORVI CANONICAL ACQUISITION CANDIDATE — INTERNAL ENGINEERING COMPLETE / EXTERNAL ACTIVATION ONLY**

The source-of-truth release SHA is:

`61dbb34dea08809756fd767b907b0e852b7e5978`

The following must **not** yet be claimed:

- Production Proven;
- Final Canonical Acquisition Release;
- Production ZATCA activated;
- Merchant Production Pilot completed.

## Reading order

### Fast buyer path

1. `15-MINUTE-BUYER-REVIEW.md`
2. `BUYER-EXECUTIVE-SUMMARY.md`
3. `CURRENT-STATUS.md`
4. `DEAL-RISK-REGISTER.md`
5. `EVIDENCE-INDEX.md`
6. `TECHNICAL-DUE-DILIGENCE-QA.md`

### Deep diligence path

7. `DOCUMENTATION-DRIFT-NOTICE.md`
8. `RELEASE-PROVENANCE.md`
9. `DUE-DILIGENCE-CHECKLIST.md`
10. `THIRD-PARTY-LICENSE-TECHNICAL-INVENTORY.md`
11. `ASSET-ACCOUNT-TRANSFER-REGISTER.md`
12. `TRANSACTION-HANDOFF-CHECKLIST.md`
13. `PRIVATE-EVIDENCE-REQUEST-LIST.md`
14. `EXTERNAL-EVIDENCE-REGISTER.md`
15. `MANIFEST.json`

Then review the canonical sources:

- `docs/acquisition/KORVI-ACQUISITION-HANDOFF.md`
- `docs/acquisition/FINAL-ACQUISITION-GATE.md`
- `docs/acquisition/DEFERRED-ACTIVATION-GATES.md`
- `docs/acquisition/OWNERSHIP-IP-LICENSING.md`
- `docs/acquisition/DEPENDENCY-SUPPLY-CHAIN.md`
- `docs/acquisition/ENVIRONMENT-INVENTORY.md`
- `docs/operations/PRODUCTION-DEPLOYMENT.md`
- `docs/operations/DISASTER-RECOVERY.md`
- `docs/operations/MONITORING-ALERTING.md`
- `docs/operations/INCIDENT-RESPONSE.md`
- `docs/operations/RELEASE-ROLLBACK.md`

## Evidence law

A capability is not considered proven merely because code exists.

Evidence classes are kept distinct:

- exact-SHA automated evidence;
- hosted staging evidence;
- operator-observed staging evidence;
- production external evidence;
- merchant evidence;
- legal/transaction evidence.

Staging or synthetic evidence may never be relabeled as production or merchant evidence.

## Freeze rule

Do not add product code, migrations, refactors or feature work to the source release merely to improve the data room.

If a material defect is discovered, open a new release lineage deliberately. Do not silently move the acquisition candidate.
