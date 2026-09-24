# KORVI — Seller Technical Disclosure Schedule

Source release:

`61dbb34dea08809756fd767b907b0e852b7e5978`

Status: **DUE-DILIGENCE DISCLOSURE — TECHNICAL FACTS ONLY**

This document is intended to prevent material technical assumptions from being made by a buyer. It is not a legal representation/warranty schedule unless incorporated into transaction documents by counsel.

## 1. Production status

Korvi is not currently represented as Production Proven.

The canonical candidate has strong production-shaped engineering and internal proof, but real production infrastructure evidence remains open.

## 2. Merchant validation

No real Merchant Production Pilot is asserted by this data room.

Synthetic/staging tests do not close AR-7.

## 3. ZATCA

Production ZATCA activation is not asserted.

Internal engineering proof exists, but real merchant identity, Production CSID, real HSM/non-exportable production signing authority and live reporting/clearance evidence remain external.

## 4. Hosted environment

The evaluation environment is hosted on Render staging aligned to the exact canonical SHA.

The current staging database is a free PostgreSQL 17 instance, non-HA, with provider-reported expiration.

This staging topology must not be treated as production infrastructure.

## 5. Repository governance

Current observed repository facts:

- default branch is `main`;
- `main` is currently reported not protected;
- repository-level rulesets collection is empty;
- acquisition PR #62 from the canonical branch remains open;
- buyer-evaluable source release is the canonical branch/SHA, not current `main`.

Governance should be deliberately reconfigured for the buyer's operating model.

## 6. Licensing / IP

No root first-party open-source license grant is asserted for Korvi source code.

Git history is technical provenance, not legal chain-of-title.

Explicit assignment/license documents and contributor/contractor provenance review remain transaction items.

Third-party license technical metadata has been inventoried, but final legal review remains required.

## 7. Payments

Korvi supports electronic/mixed tender recording/workflows in the current acquisition scope.

Direct PSP acquiring/card authorization integration is not claimed as a closed current capability.

## 8. Returns

Original-sale return/refund is in the closed current scope.

No-receipt return/exchange is not claimed as a closed capability.

## 9. Android distribution

Android build proof exists.

Production release signing/store distribution lifecycle is not represented as complete.

## 10. Evidence retention

GitHub Actions artifacts are subject to retention.

A preservation archive was created for critical exact-SHA evidence and checksummed.

Preservation does not upgrade evidence classification.

## 11. Historical documentation

Some historical governance files contain older status statements.

The acquisition data-room overlay identifies known documentation drift and should be read before interpreting historical capability matrices or scorecards.

## 12. Commercial facts

This technical data room does not assert:

- signed customer contracts;
- recurring revenue;
- merchant count;
- production transaction volume;
- receivables;
- acquisition valuation.

If any such evidence exists, it must be supplied separately and privately.

## 13. Final gate

The Final Acquisition Gate remains intentionally open.

It may close only when required external/transaction evidence exists and is bound to the exact final release SHA.
