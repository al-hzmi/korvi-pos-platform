# Korvi Production ZATCA Activation Boundary

Status: **AR-5 INTERNAL ENGINEERING COMPLETE — EXTERNAL PRODUCTION ACTIVATION OPEN**

This document defines the exact boundary between ZATCA engineering evidence that can be
proved without merchant production credentials or paid HSM infrastructure and evidence that
must remain external.

## Internal proof set

The following workflows are required to run on the same AR-5 acquisition SHA:

- ZATCA 38 Official Validator Boundary Proof
- ZATCA 38 UBL Hash Proof
- ZATCA 39 C14N Native Crosscheck
- ZATCA 39 CSID PostgreSQL Proof
- ZATCA 39 Sealing Cryptographic Proof
- ZATCA 39 Official Public Validator Probe
- ZATCA 40 Submission PostgreSQL Proof

Together they cover the internal production code path for:

- UBL/Phase-2 invoice construction and deterministic hash authority;
- independent/native canonicalization equivalence;
- sealed invoice/signature/QR binding;
- CSID lifecycle persistence and transition guards;
- encrypted Fatoora credential-vault persistence boundary;
- active terminal/credential binding and RLS;
- submission queue identity, retry/idempotency and reconciliation semantics;
- official public-validator compatibility where the public endpoint permits it;
- separate restricted migration/runtime PostgreSQL authorities.

Passing these workflows does **not** prove production ZATCA activation.

## External activation gate

The following evidence cannot be fabricated or replaced by local/staging proof:

- Azure Key Vault Premium or accepted equivalent HSM resource actually provisioned;
- version-pinned non-exportable P-256K/secp256k1 production signing key custody;
- remote ES256K sign/verify through the real HSM;
- merchant/customer production identity and credentials;
- real production CSID lifecycle against the production authority;
- real production reporting/clearance requests and response reconciliation;
- credential/key rotation and operational recovery evidence on the production provider.

The existing Azure HSM custody workflow remains manually/external activated and is not
automatically triggered by the acquisition branch.

## Production fail-closed rule

Production remains fail-closed.

- Staging simulation is never valid production evidence.
- Simulation must not activate when `KORVI_ENVIRONMENT=production`.
- Missing Azure/ZATCA production authority must prevent production fiscalization rather than
  silently downgrade to simulation or a local software key.
- Unknown/ambiguous external outcomes must remain reconcilable and must not be rewritten as
  successful tax reporting.

## AR-5 closure terminology

After the internal proof set passes on one canonical acquisition lineage, Korvi may record:

**AR-5 INTERNAL ENGINEERING COMPLETE / EXTERNAL PRODUCTION ACTIVATION OPEN**

Korvi may not record **Production ZATCA CLOSED** until the HSM, merchant identity,
production-CSID and real reporting/clearance evidence above exists.


## Canonical internal proof checkpoint — 2026-09-22

Canonical evidence SHA:

`b9e063cb252ef0270756f52ba43d7562d644b2d5`

Exact-head internal evidence:

- CI `35785967302` / PR `35785973886` — PASS;
- ZATCA 38 UBL Hash `35785967470` — PASS;
- ZATCA 38 Official Validator Boundary `35785967291` — PASS;
- ZATCA 39 C14N Native Crosscheck `35785967469` — PASS;
- ZATCA 39 CSID PostgreSQL `35785967359` — PASS;
- ZATCA 39 Sealing Cryptographic `35785967271` — PASS;
- ZATCA 39 Official Public Validator Probe `35785967175` — PASS;
- ZATCA 40 Submission PostgreSQL `35785967414` — PASS.

This closes the internal engineering portion only. Azure HSM custody, merchant production
identity, real Production CSID, reporting/clearance and production rotation/recovery remain
external activation evidence.
