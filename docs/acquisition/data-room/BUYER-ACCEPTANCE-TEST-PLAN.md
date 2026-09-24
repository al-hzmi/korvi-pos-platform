# KORVI — Buyer Acceptance Test Plan

Target: hosted canonical staging aligned to source SHA `61dbb34dea08809756fd767b907b0e852b7e5978`

Classification: **EVALUATION / STAGING ONLY**

This plan lets a buyer or independent reviewer verify representative product behavior without modifying the frozen source release.

## Preconditions

Before testing:

- confirm API/Web hosted deploys report exact source SHA;
- confirm environment is staging/evaluation, not merchant production;
- use synthetic/non-sensitive data;
- do not enter real card PAN/CVV;
- do not claim staging ZATCA simulation as a tax-valid production invoice;
- do not use direct SQL to manufacture business truth.

## Test A — Release identity

Verify:

- canonical branch is `release/canonical-acquisition-v1`;
- API and Web are deployed from `61dbb34dea08809756fd767b907b0e852b7e5978`;
- Auto Deploy remains controlled/off for the frozen evaluation environment.

Expected: no code/deployment drift.

## Test B — Cashier electronic sale

Perform a small synthetic sale with an electronic tender reference.

Verify:

- server accepts correct tender total;
- receipt reflects server-authoritative tender facts;
- staging receipt/artifact is visibly marked simulation/not for tax use where fiscal simulation is active;
- inventory effect is consistent.

## Test C — Mixed tender

Perform one sale split between cash and electronic tender.

Verify:

- cash + electronic components reconcile exactly to sale total;
- invalid overpayment/reference conditions are refused according to current workflow;
- receipt preserves tender composition.

## Test D — Original-sale return/refund

Locate a previously completed synthetic sale.

Verify:

- only eligible quantities can be returned;
- over-return is refused;
- refund method/reference is captured within supported scope;
- stock restoration occurs through authoritative return flow;
- original sale historical truth is not rewritten.

## Test E — Shift close / reconciliation

Open a clean synthetic shift with known opening float.

Perform a known cash sale.

Close using blind count.

Verify:

- expected cash is server-derived;
- declared cash is operator input;
- variance is calculated;
- both non-zero variance and clean zero-variance cases behave correctly;
- closed shift cannot be silently reinterpreted by client state.

## Test F — Platform Admin session revocation

Using a controlled staging admin account:

- establish two independent sessions if practical;
- preserve one cookie/session copy for test purposes;
- logout/revoke the target session;
- attempt replay of the revoked session.

Expected:

- revoked session fails server-side;
- unrelated valid session remains valid according to policy;
- no reliance on browser cookie deletion alone.

## Test G — Tenant isolation

Use synthetic Tenant A and Tenant B.

Verify through normal application/API authority:

- Tenant A cannot read/write Tenant B business data;
- IDs from another tenant do not bypass authorization/RLS;
- restricted runtime role remains non-superuser/non-BYPASSRLS.

Prefer existing exact-SHA PostgreSQL proof for destructive/negative database cases rather than probing unrelated live data.

## Test H — Migration Engine

With a small synthetic CSV/XLSX:

- import products/categories;
- import customers;
- import suppliers;
- import opening inventory;
- exercise dry-run before commit;
- verify row-level errors;
- retry safely.

For Product->Category mapping, verify tenant-scoped name resolution rather than trusting client/file `categoryId`.

## Test I — Restaurant/KDS representative flow

Using synthetic restaurant data:

- create/resume an open restaurant order;
- route preparation/KDS work;
- advance preparation state;
- settle through supported cashier flow.

Verify customer fiscal/receipt semantics remain separate from kitchen/preparation documents.

## Test J — Health / dependency behavior

Verify normal `/health` and readiness behavior.

Use the existing exact-SHA incident workflow as primary outage proof; do not deliberately damage shared staging solely for a buyer demo unless a controlled window and recovery procedure are agreed.

## Test K — Migration/restore evidence review

Review exact-SHA DR artifact rather than restoring shared staging for every buyer.

Verify evidence includes:

- compatible PostgreSQL tooling;
- migration ledger checks;
- restricted runtime role;
- RLS/application verification after restore.

## Test L — ZATCA boundary review

Review exact-SHA Gate 38/39/40 evidence.

Verify:

- production path is fail-closed without required authority;
- simulation is separate;
- simulation does not claim tax-valid production status;
- real Production CSID/HSM/reporting is correctly disclosed as external/open.

## Acceptance outcome

A successful staging acceptance confirms that the buyer-evaluable engineering candidate behaves consistently with the documented scope.

It does **not** close:

- Production Operations;
- Production ZATCA activation;
- Merchant Production Pilot;
- legal/IP/account transfer;
- Final Acquisition Gate.
