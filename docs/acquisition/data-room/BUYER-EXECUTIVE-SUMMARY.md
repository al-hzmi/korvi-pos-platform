# KORVI — Buyer Executive Summary

Source release under review:

`61dbb34dea08809756fd767b907b0e852b7e5978`

Canonical source branch:

`release/canonical-acquisition-v1`

Status:

**CANONICAL ACQUISITION CANDIDATE — INTERNAL ENGINEERING COMPLETE / EXTERNAL ACTIVATION ONLY**

## 1. What Korvi is

Korvi is a Saudi-focused multi-tenant POS/business operating platform with Arabic-first RTL product surfaces and shared domain authorities across retail, restaurant, inventory, purchasing, migration and operational control.

The current buyer-evaluable release is no longer a collection of separate product/security/restaurant branches. The acquisition candidate consolidates the verified capabilities into one canonical lineage.

## 2. What is inside the canonical release

The current release includes, at the product/engineering level:

- Retail/Core POS;
- Restaurant operating foundations;
- KDS;
- recipes/BOM;
- production/waste flows;
- inventory/purchasing/costing foundations;
- Migration Engine through M6;
- Platform Admin server-side revocable sessions;
- electronic tender workflow;
- mixed tender workflow;
- original-sale returns/refunds;
- shift close;
- cash reconciliation;
- Arabic RTL web product surfaces;
- Windows installed-client proof;
- Android installed-client build proof;
- offline/idempotency/financial-integrity foundations;
- production-shaped ZATCA code path that remains fail-closed without real production authority.

## 3. Core engineering posture

Korvi is designed around several explicit authority rules:

- tenant scope is server-derived;
- PostgreSQL RLS protects tenant boundaries;
- financial arithmetic uses integer/minor-unit semantics rather than browser-owned floating-point truth;
- stock, money, permissions and compliance truth are server/database authoritative;
- critical commands use idempotency and audit boundaries where applicable;
- production ZATCA does not silently fall back to simulation;
- staging simulation is visibly marked as not valid for tax use;
- migrations are forward-only and expected to pass exact ledger/drift checks;
- incident/restore procedures forbid bypassing RLS or rewriting business truth.

## 4. Exact-SHA evidence

The exact buyer-evaluable source SHA has successful evidence for:

- CI;
- restricted PostgreSQL/live proof;
- DR restore rehearsal;
- outage/recovery incident proof;
- Windows installed client;
- Android installed client build;
- browser cashier sale proof;
- ZATCA Gate 38/39/40 engineering proofs.

See `EVIDENCE-INDEX.md` for exact run IDs.

The source commit is GitHub-verified/signed.

## 5. Hosted evaluation environment

Render staging has been realigned to the same canonical source SHA for both API and Web.

This closes the earlier deployment-drift condition where hosted staging was still serving an older RC lineage.

The hosted environment is suitable for evaluation/staging. It is **not** production proof:

- staging PostgreSQL is on a free plan;
- HA is disabled;
- production backup/retention is not proven by this environment;
- production RPO/RTO is not measured from this environment.

## 6. Commercial workflow state

The canonical product no longer has the prior backend-vs-operator gap for the core workflows that were specifically identified during independent review.

Operator flows now exist for:

- electronic tender;
- mixed cash/electronic tender;
- original-sale return/refund;
- shift close;
- cash reconciliation.

Hosted staging smoke execution additionally exercised these flows manually, including clean zero-variance reconciliation and variance detection.

Korvi records electronic tender outcomes/references; the current documented acquisition candidate does not claim to be a direct PSP acquiring/payment-processing platform.

## 7. Security state

The prior Platform Admin logout weakness has been closed in the canonical release.

Platform Admin sessions have durable server-side authority and revocation, rather than logout merely clearing a browser cookie.

The release also carries tenant/RLS, authorization and restricted-runtime proofs appropriate to the current engineering scope.

This data room does not claim that no security defects can ever exist. It records the tested scope and evidence available for this release.

## 8. ZATCA state

Internal engineering is advanced and fail-closed.

The release contains engineering evidence around:

- UBL construction;
- hashing/canonicalization;
- CSID persistence/lifecycle;
- signing/sealing boundaries;
- submission queue/retry/reconciliation;
- official/public validator boundary probes;
- restricted PostgreSQL authority.

Still external:

- real merchant production identity;
- real Production CSID;
- production Azure HSM/non-exportable signing authority;
- real production reporting/clearance;
- real production reconciliation and rotation/recovery evidence.

Therefore:

**ZATCA Engineering Ready != ZATCA Production Activated**

## 9. Operations state

Engineering runbooks and rehearsals exist for:

- production deployment;
- database migration;
- backup/restore;
- disaster recovery;
- monitoring/alerting model;
- incident response;
- release/rollback;
- environment-variable inventory without secret values.

Still external:

- real production provider plan;
- HA/failover;
- managed backup retention;
- measured production-equivalent RPO/RTO;
- external alert delivery;
- named on-call activation/drill;
- production secret-manager/rotation evidence.

## 10. Migration / customer onboarding

The verified Migration Engine baseline includes:

- products;
- categories/product mapping;
- customers;
- suppliers;
- opening inventory;
- explicit update-existing-by-phone customer strategy.

Source-specific adapters are intentionally deferred until a real customer/system produces an actual mapping requirement.

## 11. Acquisition / ownership posture

The repository records technical provenance, but technical history is not a substitute for a legal transaction.

Before transaction close, the buyer/seller still need:

- explicit IP assignment or agreed license instrument;
- contributor/contractor chain-of-title confirmation where applicable;
- third-party license legal review;
- account/domain/credential transfer plan;
- repository governance transfer;
- production-provider/ZATCA operational transfer where in scope.

The repository currently has no root first-party OSS license grant; Korvi first-party code is treated in the existing acquisition docs as proprietary/internal pending explicit transaction documentation.

## 12. Principal open risks

The remaining primary risks are no longer basic product fragmentation or missing core cashier workflows.

They are:

1. **Production activation risk** — infrastructure exists as engineering contracts/rehearsals, not production proof.
2. **Regulatory activation risk** — real Production ZATCA identity/HSM/reporting evidence is not yet present.
3. **Field-validation risk** — no real Merchant Production Pilot has closed AR-7.
4. **Transaction/legal risk** — IP/account/domain/repository transfer documents are not yet executed.
5. **Repository governance risk** — current repository rulesets are absent and `main` is not protected.
6. **Third-party-license diligence risk** — technical inventory exists, legal compatibility/obligation review is still required.

## 13. What a buyer should evaluate

A serious buyer should evaluate:

- source SHA `61dbb34dea08809756fd767b907b0e852b7e5978`;
- exact-SHA workflow evidence;
- hosted staging aligned to the same SHA;
- PostgreSQL/RLS/financial authority;
- Platform Admin session authority;
- core cashier/commercial workflows;
- Migration Engine;
- Restaurant/KDS/BOM/waste scope;
- installed-client evidence;
- operational runbooks;
- ZATCA fail-closed boundaries;
- open external activation gates;
- transaction/IP/licensing records.

## 14. What Korvi may and may not be called today

Defensible now:

- unified canonical engineering/product release;
- buyer-evaluable acquisition candidate;
- internal engineering complete for the adopted acquisition program;
- hosted staging aligned to canonical release;
- engineering handoff ready.

Not defensible yet:

- Production Proven;
- Merchant Proven;
- Production ZATCA Activated;
- Final Canonical Acquisition Release.

The final acquisition gate is intentionally fail-closed until real external and transaction evidence exists.
