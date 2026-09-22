# KORVI — Acquisition Handoff Package

Status: **AR-6 WORKING PACKAGE — buyer/operator ready structure; production/external gates remain explicit**
Created: 2026-09-22

This directory is the acquisition/operator index. It does not duplicate Korvi's
domain authorities. Where an authoritative document already exists, this package
points to it and records its status.

## 1. Canonical release authority

Canonical branch: `release/canonical-acquisition-v1`.

Canonical integration checkpoint at package start:
`a575da1777f0c5b3ef6c836872c62c88780cf4ec`.

The underlying AR-0–AR-3 product merge is
`941b512bdb82be8a4d52113a77def365b81cd4e4`, with exact-SHA CI,
PostgreSQL 17 and Chrome commercial workflow proof recorded in
`docs/governance/KORVI-CANONICAL-ACQUISITION-RELEASE.md`.

A buyer must evaluate the latest canonical SHA, not a feature branch or old RC.

## 2. Handoff map

| Required package item | Authority / location | Current position |
| --- | --- | --- |
| Architecture package | `docs/governance/KORVI-ARCHITECTURE-MAP.md`, `docs/architecture/overview.md`, ADRs | Versioned repository authority |
| Exact production deployment guide | `docs/operations/PRODUCTION-DEPLOYMENT-REFERENCE.md` | Engineering contract ready; provider activation external |
| Environment inventory without values | Production deployment reference §4 | Names/classes only; no secret values |
| Database migration guide | `scripts/deploy/production-migrate.sh`, production deployment reference §6 | Automated fail-closed contract |
| Backup/restore guide | `docs/operations/DISASTER-RECOVERY.md` | Engineering rehearsal path exists; managed production evidence external |
| Monitoring/alerting guide | Production deployment reference §8 + `docs/operations/INCIDENT-RESPONSE.md` | Internal surfaces defined; external routing evidence pending |
| Incident runbook | `docs/operations/INCIDENT-RESPONSE.md` | Active baseline |
| ZATCA operations guide | `docs/operations/ZATCA-PRODUCTION-OPERATIONS.md` | Internal path documented; production activation external |
| Dependency inventory | root `package.json`, `package-lock.json`, workspace manifests | Lockfile is machine inventory |
| Supply-chain status | `docs/governance/SUPPLY-CHAIN-REVALIDATION-2026-09-08.md`, CI audit/pin gates | CI-enforced; revalidate on final SHA |
| Ownership/IP provenance | `docs/governance/KORVI-IP-LICENSING-PROVENANCE.md` | Repository facts recorded; legal assignment diligence remains |
| Licensing position | same IP/licensing document | No root license detected; do not infer transfer rights |
| Test evidence | Product Readiness Scorecard + release/acquisition program + Actions run artifacts | Exact-SHA evidence required |
| CI evidence | GitHub Actions on canonical SHA | Exact run IDs recorded at checkpoints |
| Release history | Git history, merged PRs, `docs/governance/RELEASE-CANDIDATE-2026-09-14.md` | Retained; no rewrite of old unsigned commits |
| Deferred-items register | §5 below | Active |
| Merchant onboarding/migration | `docs/handoff/MERCHANT-ONBOARDING-MIGRATION.md` | Engineering guide ready; real merchant evidence is AR-7 |

## 3. Buyer verification sequence

1. Resolve `release/canonical-acquisition-v1` to one full SHA.
2. Verify that SHA has green CI and required C0 PostgreSQL/browser proofs.
3. Review the capability/readiness sources; do not infer a feature from another branch.
4. Review the environment inventory and ensure no secret values are stored in source.
5. Rehearse deployment/migration/DR/incident procedures on the selected production-equivalent environment.
6. Verify third-party dependency/license and contributor/IP diligence before transaction close.
7. Activate production ZATCA only with real merchant identity, production credentials and protected signing infrastructure.
8. Complete AR-7 with an actual merchant. Synthetic/staging evidence cannot replace it.

## 4. Evidence handling

Evidence should identify exact SHA, run/artifact reference, environment and result.
Do not preserve raw database dumps, cookies, passwords, CSIDs, access tokens,
private keys, connection strings or merchant PII in repository artifacts.

## 5. Deferred / external activation register

The following are deliberately not represented as closed:

- **Production database/provider activation:** requires a durable PostgreSQL 17+
  production plan with HA/failover and managed encrypted backup semantics.
- **Production monitoring/on-call routing:** requires the selected external
  monitoring/alert destination and an exercised alert drill.
- **Production RPO/RTO evidence:** engineering planning target is RPO <= 15 min
  and RTO <= 60 min; closure requires business acceptance and measured
  production-equivalent rehearsal meeting those targets.
- **Production ZATCA:** real CSID/certificate identity, non-exportable signing
  authority, vault credentials, reporting/reconciliation and merchant identity.
  Production remains fail-closed without them.
- **Signed private-distribution release authority:** Windows/Android release
  signing/origin material is not inferred from non-release CI packages.
- **Repository branch protection:** repository Rulesets are currently absent and
  the connected automation identity has no Administration permission to impose
  branch protection. PR-only integration remains the operating policy until the
  repository owner enables protection.
- **Merchant Production Pilot (AR-7):** requires a real merchant and human
  evidence. Synthetic tenants and staging do not close it.
- **Legal ownership/license diligence:** repository provenance can be described,
  but contributor assignment and transaction-specific IP warranties require
  human/legal confirmation.

## 6. Release-governance rules

- canonical changes are integrated by reviewed PR;
- no force overwrite;
- old unsigned commits are not rewritten merely to manufacture signatures;
- use signed release commits/tags going forward where repository/operator
  signing authority is available;
- feature branches are provenance, never release truth after canonical integration;
- every final claim names an exact SHA and evidence.
