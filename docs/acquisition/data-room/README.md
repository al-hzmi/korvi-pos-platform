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

1. `CURRENT-STATUS.md`
2. `EVIDENCE-INDEX.md`
3. `DOCUMENTATION-DRIFT-NOTICE.md`
4. `RELEASE-PROVENANCE.md`
5. `DUE-DILIGENCE-CHECKLIST.md`
6. `TRANSACTION-HANDOFF-CHECKLIST.md`
7. `EXTERNAL-EVIDENCE-REGISTER.md`
8. `MANIFEST.json`

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
