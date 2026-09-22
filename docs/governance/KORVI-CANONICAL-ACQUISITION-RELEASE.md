# KORVI — CANONICAL ACQUISITION RELEASE PROGRAM

Status: **ADOPTED — P0 EXECUTIVE PROGRAM**
Date adopted: 2026-09-22
Canonical integration branch: `release/canonical-acquisition-v1`
Baseline SHA: `fb0d39c0b2b516cdbdb8590281a784a165a41827`

## 1. Executive objective

Korvi will now prioritize a **single canonical acquisition/release lineage** over additional speculative feature expansion.

The target is one auditable release lineage that consolidates the newest verified product, restaurant, migration and security work and closes the remaining sellable-workflow, production-proof and handoff gaps.

The release may not be called Production Proven merely because backend authorities or staging proofs exist. Evidence must exist on the canonical release lineage.

## 2. P0 problems adopted from independent product testing

The following are now official P0 program items:

1. Branch/version fragmentation and release-integration risk.
2. Platform Admin stolen-session invalidation gap on the current product lineage.
3. Missing or incomplete sellable POS workflows despite backend capability:
   - electronic tender UI;
   - mixed tender UI;
   - Return creation UX;
   - Refund execution UX;
   - Shift Close UX;
   - Cash reconciliation UX.
4. Production proof gap:
   - production deployment;
   - high-availability design/evidence where required;
   - managed backup and restore evidence;
   - explicit RPO/RTO;
   - monitoring and alerting;
   - incident/on-call runbook and drill;
   - controlled merchant production pilot;
   - production ZATCA operational closure.
5. Acquisition/handoff gap:
   - one canonical release branch/SHA;
   - repository/release governance;
   - ownership/IP manifest;
   - licensing position;
   - deployment and operations handoff;
   - environment/secrets inventory without exposing secrets;
   - architecture and dependency inventory;
   - release provenance;
   - buyer/operator runbook.

## 3. Target canonical release composition

The final release lineage must include, after evidence-based integration:

- latest verified Retail capabilities;
- latest verified Restaurant capabilities;
- verified Migration Engine baseline through M6;
- Platform Admin revocable server-side session fix;
- Return UX;
- Refund UX;
- Shift Close UX;
- Cash reconciliation UX;
- Electronic tender UX;
- Mixed tender UX;
- production deployment configuration and evidence;
- real production ZATCA provider closure when credentials/infrastructure are available;
- controlled merchant pilot evidence;
- Documentation + Handoff + Ownership package.

No feature is considered included merely because it exists on another branch.

## 4. Integration law

**ONE RELEASE LINEAGE — NO BLIND MERGES.**

For each candidate branch:

1. verify branch and exact HEAD;
2. compare against the canonical integration head;
3. identify domain overlap and conflicts;
4. integrate only verified commits/capabilities;
5. resolve conflicts using current domain invariants, not timestamp alone;
6. run targeted regression;
7. run Full Verify;
8. update canonical governance sources;
9. commit;
10. continue.

No force-push, history overwrite or silent conflict resolution is permitted.

Repository evidence wins for implementation truth.

## 5. Immediate execution order

### AR-0 — Canonical branch and source-of-truth consolidation
Status: **IN PROGRESS**

- canonical integration branch exists;
- enumerate current Retail/Product, Restaurant, Migration and Security heads;
- identify best verified source commit for each required capability;
- produce an integration matrix before code merge;
- stop treating RC7, product branches and security branches as interchangeable release truth.

### AR-1 — Security integration
Status: **ADOPTED / P0**

Integrate the verified Platform Admin revocable-session authority from the security lineage.

Required behavior:

- logout revokes the server-side session, not only the browser cookie;
- replay of a stolen/revoked session fails immediately according to the server authority;
- expiry, rotation and revocation remain server authoritative;
- no privilege or tenant-boundary regression.

Must include regression and PostgreSQL/runtime proof appropriate to the implementation.

### AR-2 — Sellable POS workflow completion
Status: **ADOPTED / P0**

Close the gap between backend capability and operator product workflow:

- Electronic Tender UI;
- Mixed Tender UI;
- Return creation UX;
- Refund execution UX;
- Shift Close UX;
- Cash reconciliation UX.

A backend endpoint alone does not satisfy this gate.

Each workflow requires:

- server-authoritative permissions;
- deterministic money semantics;
- idempotency where applicable;
- receipt/audit integrity;
- Arabic RTL operator flow;
- error/retry handling;
- browser proof;
- regression coverage.

### AR-3 — Canonical product integration
Status: **ADOPTED / P0**

Consolidate the newest verified:

- Retail/Product work;
- Restaurant work;
- Migration M2-M6;
- Security fixes;
- AR-2 operator workflows;

into the same release lineage.

No separate branch may be advertised as containing the real product after this gate closes.

### AR-4 — Production Operations Proof
Status: **ADOPTED / P0 — EVIDENCE REQUIRED**

Close with actual evidence, not documentation-only claims:

- production-shaped deployment;
- health checks;
- backup schedule and restore proof;
- explicit RPO and RTO;
- monitoring/alerting;
- operational logs without secret leakage;
- incident response;
- on-call/escalation model;
- disaster-recovery exercise appropriate to the deployment;
- release/rollback procedure.

Existing staging evidence is useful but does not automatically satisfy production proof.

### AR-5 — Production ZATCA closure
Status: **ADOPTED / P0 — EXTERNAL DEPENDENCY POSSIBLE**

Production must remain fail-closed.

Required final evidence:

- real production provider path;
- required production CSID/certificate lifecycle;
- protected/non-exportable key custody as designed;
- signing/reporting/reconciliation evidence;
- no staging simulation path active in production;
- operational retry/reconciliation proof.

If production credentials, customer identity or paid infrastructure are legitimately required, record the gate as BLOCKED BY EXTERNAL ACTIVATION rather than faking closure.

### AR-6 — Acquisition / Handoff Package
Status: **ADOPTED / P0**

Prepare a buyer/operator-grade package containing at least:

- canonical release SHA;
- architecture map;
- capability matrix;
- security status and known residual risks;
- deployment guide;
- environment-variable inventory without values;
- database/migration procedure;
- backup/restore procedure;
- monitoring/incident procedure;
- ZATCA operational boundary;
- dependency and supply-chain inventory;
- ownership/IP provenance manifest;
- licensing position;
- release history;
- test/CI evidence;
- known deferred items;
- onboarding/migration guide;
- operator/admin runbooks.

### AR-7 — Controlled Merchant Production Pilot
Status: **ADOPTED / P0 — HUMAN/EXTERNAL EVIDENCE REQUIRED**

Run the canonical release with a real merchant under controlled rollout.

Evidence should cover as applicable:

- onboarding/import;
- branch/terminal provisioning;
- real operator workflow;
- shift lifecycle;
- payment/tender path;
- return/refund;
- stock effects;
- receipts;
- restaurant flow if used by that merchant;
- sync/offline behavior;
- backup/restore confidence;
- incident/rollback readiness;
- ZATCA production path where legally applicable.

A synthetic tenant or staging dry run is not a Merchant Production Pilot.

### AR-8 — Final Acquisition Release Gate
Status: **NOT STARTED**

Only after required P0 gates close may Korvi claim a canonical acquisition release.

The final state must point to one exact SHA and one evidence package.

## 6. Readiness terminology

Until AR-4, AR-5 and AR-7 are evidence-backed:

- **Engineering/Product maturity:** advanced.
- **Pilot/Staging readiness:** may be claimed where evidence supports it.
- **Production Proven:** must NOT be claimed.
- **Canonical Acquisition Release:** IN PROGRESS.

## 7. Speed rule

This program is now the highest product-development priority.

Do not open speculative product features while a P0 acquisition-release gap is executable.

Work in parallel only when branches/worktrees are isolated and domains do not create overwrite risk.

Recommended parallel lanes:

- Lane A: canonical branch integration;
- Lane B: Platform Admin security fix validation/integration;
- Lane C: POS commercial workflow UX;
- Lane D: production operations/handoff preparation.

External-only gates (real ZATCA activation and merchant pilot) must not prevent executable code/documentation work from progressing.

## 8. Non-negotiable Korvi invariants

Nothing in the acquisition push may weaken:

- tenant isolation / RLS;
- authorization;
- idempotency;
- immutable historical truth;
- stock authority;
- financial authority;
- VAT/tax authority;
- auditability;
- offline integrity;
- production ZATCA fail-closed behavior.

No score, deadline or acquisition target justifies bypassing these rules.


## 9. AR-0 integration matrix — 2026-09-22

Repository comparison is authoritative for this checkpoint.

| Capability | Candidate/source | Evidence observed | Canonical disposition |
| --- | --- | --- | --- |
| Migration M2-M6 | `fb0d39c0b2b516cdbdb8590281a784a165a41827` | Canonical is 4 commits ahead and this SHA is its merge-base ancestor; CI `35724936239` succeeded | **ALREADY PRESENT** — do not replay or merge |
| Platform Admin server-side revocation | Security lineage `0015d7c46c3044790a5dfa814894f5ab4f44f370`; focused authority commits `a7f7fc3c`, `cee01671`, `075dc5fd`, `ebf952b4`, `90163b99`, `f0587195` plus hardening/tests through the security head | Security-head CI `35424686058` and PostgreSQL proof `35424686044` succeeded | **SELECTED FOR AR-1 FOCUSED PORT** — no blind 62-commit branch merge |
| Latest verified Restaurant foundation/waste | `73d46d095422f58be5f23027d00746ed8115e074` | CI `35746589569` succeeded | **VERIFIED SOURCE CANDIDATE** for subsequent canonical Restaurant integration |
| Split/Mixed/Electronic tender UX | Functional commit `4d3ae99438ada59a6f3c1d7f7ef2bfc50e4d1463`; formatted head `e6e21ee64315e60f5cbe405cceca804462a88f4a` | Existing implementation confirmed, but feature/formatter-lineage CI runs failed and final formatter head has no independent green CI | **IMPLEMENTATION CANDIDATE ONLY** — reconcile and prove on canonical before adoption |
| Latest Product/Retail review branches | `57758041e7cc7970f41aa92144a1dfe7b2e50a2e`, `c877c979e0cf98c13fa7ef8f411b07fe7ebd7a21`, `67c761c26c5ca5131817c4e73a7c6b7e92bd7b9d` | All inspected heads have failing CI | **NOT SELECTED** — current canonical Retail remains authority until a newer candidate is proven |

AR-0 remains open for the later Restaurant/AR-2 integration checkpoint; Migration and the AR-1 source selection are resolved without duplication.

## 10. AR-1 focused integration checkpoint

The Platform Admin port is capability-scoped. It imports the durable PostgreSQL session authority and migration, signed session ID binding, server-side active/revoked/expired checks, logout revocation, production fail-closed behavior when durable revocation authority is unavailable, and regression coverage. Later canonical server/database work is preserved by patching only the required wiring points.

Required acceptance on the canonical-release lineage:

- logout makes a captured cookie unusable;
- an explicitly revoked session is rejected;
- an expired session is rejected;
- a separate valid session remains valid;
- Platform Admin permissions/actor authority remain server-owned;
- control-plane RLS assertions include the Platform Admin session policy;
- Full Verify/CI must pass on the integration SHA and again after canonical merge.

Source-branch success is provenance only; AR-1 is not CLOSED until the canonical release SHA carries and proves the behavior.
