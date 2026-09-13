# Production Operations Gate 50 — evidence contract

Status: **ENGINEERING ACCEPTANCE CONTRACT READY; external production evidence still required.**

This contract turns Gate 50 from a narrative checklist into a fail-closed, exact-release proof. It does not lower any existing requirement and it does not make staging evidence count as production evidence.

## What must be proved

A Gate 50 evidence bundle is accepted only when it binds to one full 40-character release SHA and proves all of the following at the same time:

- a durable production PostgreSQL 17+ plan with high availability/failover, encrypted managed backups, explicit frequency/retention and authority separation;
- business-accepted RPO/RTO targets plus a production-equivalent rehearsal whose measured RPO/RTO meet those targets;
- external monitoring, real alert routing, an on-call role, escalation path and an exercised alert drill;
- externalized least-privilege secret management plus rotation evidence for the database runtime credential, session authority, metrics authorization and bootstrap capability classes;
- controlled merchant field validation on the same release SHA, including sale, return, shift, inventory, purchase receipt and offline synchronization, with rollback criteria and an explicit human approval reference;
- exact-SHA CI, PostgreSQL live, DR, incident, external-surface and provider-production evidence references.

Render Free staging is rejected mechanically. Synthetic evidence is rejected. A failed RPO/RTO target is rejected. Placeholder values are rejected. Secret-bearing field names and recognizable credential material are rejected before any proof can pass.

## How to prepare the evidence

Copy `PRODUCTION-OPERATIONS-GATE-50.example.json` outside the public repository and replace every placeholder with verified non-secret metadata or an immutable evidence reference. Do not put passwords, tokens, connection strings, private keys, session cookies, merchant PII or raw database URLs in the bundle.

Run locally or in an approved operator environment:

```bash
node scripts/verify-production-operations-gate50.mjs /secure/path/gate50.json <exact-release-sha>
```

The verifier prints only a sanitized summary. A successful local run is useful preflight evidence, but canonical CI proof should use the manual workflow below.

## Canonical exact-SHA workflow

`.github/workflows/operations-gate-50-production-proof.yml` is manual-only. Store the completed JSON bundle as the encrypted GitHub Actions secret `GATE50_EVIDENCE_JSON`, dispatch the workflow on the exact release branch/SHA, and preserve the resulting sanitized artifact.

The workflow:

1. checks out the exact release commit;
2. materializes the encrypted evidence only in the runner temporary directory with a restrictive umask;
3. verifies the evidence against `GITHUB_SHA`;
4. deletes the raw evidence file;
5. secret-scans the proof output; and
6. uploads only the sanitized PASS summary.

The raw evidence bundle is never uploaded as an artifact and must never be committed to the repository.

## What this does not close

The verifier and workflow close only the **internal Gate 50 acceptance-harness gap**. Gate 50 itself remains OPEN until real production/provider/on-call/merchant evidence is supplied and this exact-SHA proof passes. The current free staging database remains explicitly insufficient for production Gate 50.
