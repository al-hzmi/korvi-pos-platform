# Korvi Final Acquisition Release Gate

Status: **AR-8 PREPARED — FAIL-CLOSED / NOT ELIGIBLE WITHOUT EXTERNAL EVIDENCE**

The final gate prevents engineering maturity, staging proof or a synthetic pilot from being mislabeled as a Canonical Acquisition Release.

## Current position

Already canonicalized or internally proven:

- AR-0 Canonical Integration — closed;
- AR-1 Platform Admin Security — closed;
- AR-2 Sellable POS Workflows — closed;
- AR-3 One Product / One Canonical Lineage — closed;
- AR-4 internal Production Operations engineering package — complete;
- AR-5 internal production-ZATCA code-path proofs — complete;
- AR-6 engineering Buyer/Handoff package — complete.

Still external/human:

- AR-4 real production provider/HA/backups/measured RPO-RTO/monitoring/on-call activation;
- AR-5 real HSM + merchant identity + Production CSID + real reporting/clearance;
- AR-6 transaction/legal/account/domain/repository-governance activation;
- AR-7 real Merchant Production Pilot.

Therefore **Production Proven** and **Canonical Acquisition Release** remain unclaimed.

## Final evidence manifest

The manual gate consumes a committed evidence manifest conforming to `docs/acquisition/schemas/final-acquisition-evidence.schema.json`. It must bind Production Operations, Production ZATCA, Transaction/Handoff and Real Merchant Pilot evidence to the same exact canonical SHA.

Do not commit credentials, private keys, secrets or personal data.

## Automated behavior

Manual workflow: `.github/workflows/acquisition-final-gate.yml`

Verifier: `scripts/verify-acquisition-final-gate.mjs`

The verifier requires the manifest SHA to equal the workflow SHA, rejects staging/synthetic claims, enforces measured RPO ≤ 15m and RTO ≤ 60m, requires real external monitoring/on-call evidence, real non-exportable HSM/ZATCA evidence, transaction evidence and real merchant workflow evidence.

No final evidence manifest is created by this preparation checkpoint. The gate is intentionally not passable yet.

## Meaning of workflow success

A green manual final-gate workflow means the evidence manifest is structurally complete and internally consistent for the exact SHA. It does not independently authenticate external provider records or legal documents. Human reviewers must validate referenced evidence before governance may close AR-8.

## Final closure

After the manual evidence gate passes and reviewers validate references:

1. record the exact canonical SHA;
2. record the final-gate workflow run;
3. record reviewer/approval references;
4. update canonical governance sources;
5. create the acquisition release tag/record using repository-supported signing where practical;
6. do not rewrite old unsigned history;
7. preserve residual risks and transaction-scope exclusions explicitly.

Until then AR-8 remains OPEN.
