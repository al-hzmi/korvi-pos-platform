# KORVI — 15-Minute Buyer Review Path

Target source release:

`61dbb34dea08809756fd767b907b0e852b7e5978`

Purpose: allow a technical buyer/reviewer to understand the current acquisition candidate quickly without confusing historical snapshots with current evidence.

## Minute 0–2 — Establish release truth

Read:

1. `README.md`
2. `CURRENT-STATUS.md`
3. `RELEASE-PROVENANCE.md`

Confirm:

- the only buyer-evaluable source SHA is `61dbb34dea08809756fd767b907b0e852b7e5978`;
- hosted staging API/Web are aligned to the same SHA;
- the canonical candidate is frozen;
- Production Proven / Merchant Proven / Final Acquisition Release are not claimed.

## Minute 2–5 — Understand product scope

Read:

- `BUYER-EXECUTIVE-SUMMARY.md`
- `TECHNICAL-DUE-DILIGENCE-QA.md`

Key product checks:

- Retail/Core POS;
- Restaurant/KDS/BOM/waste;
- Migration M2–M6;
- Platform Admin revocable sessions;
- electronic/mixed tender;
- original-sale return/refund;
- shift close;
- cash reconciliation.

Do not use stale historical capability rows as current truth without checking `DOCUMENTATION-DRIFT-NOTICE.md`.

## Minute 5–8 — Validate engineering evidence

Read:

- `EVIDENCE-INDEX.md`
- `MANIFEST.json`

Check exact-SHA workflow evidence:

- CI;
- PostgreSQL/RLS;
- DR restore;
- incident outage/recovery;
- Windows installed client;
- Android build;
- ZATCA 38/39/40 proofs.

Check hosted staging evidence separately from automated evidence.

## Minute 8–11 — Review risk and open gates

Read:

- `DEAL-RISK-REGISTER.md`
- `DUE-DILIGENCE-CHECKLIST.md`
- `docs/acquisition/DEFERRED-ACTIVATION-GATES.md`
- `docs/acquisition/FINAL-ACQUISITION-GATE.md`

Focus on:

- production provider/HA/backups/RPO/RTO;
- external monitoring/on-call;
- production secret management;
- real Production ZATCA activation;
- real Merchant Production Pilot;
- legal/IP/account transfer;
- repository governance.

## Minute 11–13 — Review IP / supply chain

Read:

- `docs/acquisition/OWNERSHIP-IP-LICENSING.md`
- `THIRD-PARTY-LICENSE-TECHNICAL-INVENTORY.md`
- `docs/acquisition/DEPENDENCY-SUPPLY-CHAIN.md`

Confirm:

- first-party repository code has no root OSS license grant asserted;
- technical Git provenance is not being misrepresented as legal chain-of-title;
- third-party license technical metadata has been surfaced;
- final legal license review remains a transaction item.

## Minute 13–15 — Handoff decision

Read:

- `TRANSACTION-HANDOFF-CHECKLIST.md`
- `ASSET-ACCOUNT-TRANSFER-REGISTER.md`
- `PRIVATE-EVIDENCE-REQUEST-LIST.md`

At the end of the review the buyer should be able to answer:

1. What exact SHA am I evaluating?
2. Which product workflows are actually present?
3. Which claims have exact-SHA proof?
4. Which evidence is staging only?
5. Which external gates remain?
6. What legal/account assets still need transfer?
7. What must happen before Production Proven or Final Acquisition Release can be claimed?
