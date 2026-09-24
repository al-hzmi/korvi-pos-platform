# KORVI — Acquisition Deal Risk Register

Source release: `61dbb34dea08809756fd767b907b0e852b7e5978`

This register separates current technical residual risk from external activation and transaction risk. It is not a valuation score and does not rank buyers or transaction choices.

| Risk | Current state | Evidence / reason | Closure condition |
|---|---|---|---|
| Source-of-truth fragmentation | CLOSED | One canonical buyer-evaluable branch/SHA | Preserve canonical release governance |
| Hosted staging drift | CLOSED for evaluation staging | API/Web LIVE on exact canonical SHA | Keep evaluation environment pinned |
| Platform Admin revoked-session replay | CLOSED in canonical release | Durable server-side session authority/revocation | Preserve regression tests/runtime store |
| Core cashier workflow gap | CLOSED for adopted scope | Electronic/mixed tender, returns/refunds, shift close/reconciliation present | Preserve operator/browser regression proof |
| Production infrastructure | OPEN EXTERNAL | Current hosted environment is staging/free and non-HA | Real production plan + HA/failover as required |
| Backup/restore SLA | OPEN EXTERNAL | Engineering DR proof exists; provider production retention/RPO/RTO not measured | Managed backup + measured restore/RPO/RTO |
| Monitoring/on-call | OPEN EXTERNAL | Model/runbook exists; real routing/acknowledgement not active | External monitor + real alert/on-call drill |
| Secret management | OPEN EXTERNAL | Environment contract exists; production secret manager/rotation not evidenced | Activate production secret store + rotation evidence |
| Production ZATCA | OPEN EXTERNAL | Internal engineering proof only | Real HSM, merchant identity, Production CSID, reporting/clearance/reconciliation |
| Real merchant field validation | OPEN EXTERNAL | No Merchant Production Pilot | Real controlled merchant pilot evidence |
| Legal IP chain-of-title | OPEN TRANSACTION | Git history is technical provenance only | Executed assignment/license + contributor provenance |
| Third-party license obligations | OPEN TRANSACTION | Technical inventory exists, legal review not complete | Final release license/notice legal review |
| Repository governance | OPEN GOVERNANCE | Rulesets empty; main not protected | Buyer-approved protection/rulesets/release policy |
| Default branch mismatch | OPEN GOVERNANCE | `main` is default while canonical candidate lives on release branch | Deliberate final branch/release decision at transaction |
| Acquisition PR #62 | OPEN GOVERNANCE | PR remains open against main | Buyer/seller decide merge/close/preserve strategy |
| Android production distribution | OPEN IF REQUIRED | Build proof exists, not Play/release-signing lifecycle proof | Release signing + distribution lifecycle evidence |
| Direct PSP acquiring | OUT OF CURRENT CLAIM | Tender recording != acquiring platform | Build/provider-integrate only if transaction scope requires |
| No-receipt exchange/return | OUT OF CURRENT CLOSED SCOPE | Original-sale flow is the closed capability | Implement only if target market/transaction scope requires |
| Historical documentation drift | MITIGATED | Data-room overlay identifies stale capability/scorecard statements | Use this data room as buyer reading layer |
| Final evidence manifest | OPEN BY DESIGN | No fabricated final manifest exists | Populate only from real external evidence on exact final SHA |

## Interpretation

The main residual risks have shifted away from core code fragmentation toward:

- real production operations;
- real regulatory activation;
- real merchant field evidence;
- legal/transaction transfer;
- repository governance.

No open row in this register should be silently relabeled closed because a staging or synthetic proof exists.
