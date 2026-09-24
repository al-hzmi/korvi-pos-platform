# KORVI — Technical Due-Diligence Q&A

Source SHA: `61dbb34dea08809756fd767b907b0e852b7e5978`

This document provides concise answers to likely CTO, engineering, security, operations and acquisition diligence questions. Answers are limited to evidence currently supported by the repository and acquisition data room.

## Product / release

### Q: Which exact version should a buyer evaluate?

`release/canonical-acquisition-v1` at:

`61dbb34dea08809756fd767b907b0e852b7e5978`

Older RC/Product/Restaurant/Migration/Security branches are development history, not competing current release truth.

### Q: Is hosted staging on the same version?

Yes. Both current Render API and Web staging deploys have been verified LIVE on the same exact SHA.

This is evaluation/staging alignment, not production infrastructure proof.

### Q: Is the product still fragmented across branches?

The buyer-evaluable product source of truth is no longer fragmented. Verified capabilities were consolidated into the canonical acquisition lineage.

Historical branches still exist as development provenance.

### Q: Is `main` the buyer-evaluable current release?

No. The GitHub default branch remains `main`, but the buyer-evaluable acquisition candidate is the canonical release branch/SHA above. Acquisition PR #62 to `main` remains open.

## Architecture / data authority

### Q: What owns financial and stock truth?

Korvi's domain/server/database authorities own financial, stock, permission and compliance truth. Browser/native clients collect intent and display approved facts; they are not treated as final financial authority.

### Q: How is money represented?

The repository's governance and domain evidence use integer/minor-unit money semantics and deterministic allocation rather than relying on browser floating-point financial truth.

### Q: Is checkout intended to be atomic/idempotent?

The current engineering model includes transaction integrity and idempotency authorities appropriate to checkout and other critical command paths. Exact behavior should be reviewed in the source and associated tests for the transaction under diligence.

### Q: Does the application runtime use a privileged PostgreSQL role?

Restricted PostgreSQL proof exists on the exact SHA. The documented runtime model forbids production runtime from depending on superuser/BYPASSRLS authority.

## Multi-tenancy / security

### Q: How is tenant isolation enforced?

Tenant scope is server-derived and PostgreSQL RLS is part of the security model. Exact-SHA restricted/live database proof exists.

### Q: Was the Platform Admin logout/session issue fixed?

Yes for the canonical release. Platform Admin sessions have durable server-side session authority and revocation. Logout does not merely clear the browser cookie.

### Q: Can a stolen revoked Platform Admin cookie remain valid?

The canonical authority verifies durable session state; a revoked server-side session is not supposed to remain valid merely because a copied cookie still has a valid signature.

### Q: Is the system proven completely secure?

No such claim is made. The data room records tested security scope and known evidence. Future independent review can still discover defects.

## Payments

### Q: Does Korvi support electronic tender?

Yes at POS workflow level.

### Q: Does Korvi support mixed tender?

Yes. The canonical product supports mixed cash/electronic tender workflow and server-side financial authority around tender totals.

### Q: Does Korvi directly process Mada/card authorization with a PSP?

That is not claimed by the current acquisition candidate. Korvi records electronic tender outcome/reference information; direct acquiring/provider-adapter capability is a separate integration scope.

### Q: Does Korvi store card PAN/CVV?

The acquisition evidence does not assert Korvi as a card-data processing/acquiring platform. A buyer should separately review any future PSP integration architecture before bringing PCI-sensitive card data into scope.

## Returns / shifts

### Q: Are returns/refunds UI-only or backend-only?

The canonical release includes an operator workflow for original-sale returns/refunds, including electronic/cash refund modes within the documented scope.

### Q: Does Korvi support no-receipt returns/exchanges?

Not as a closed current acquisition capability. That remains broader future scope if a buyer/merchant requires it.

### Q: Does shift close exist in the UI?

Yes. Blind shift close and cash reconciliation are part of the canonical product workflow.

### Q: Can the system detect a cash variance?

Hosted staging manual smoke evidence demonstrated both a non-zero variance and a clean zero-variance reconciliation.

## Restaurant

### Q: Is restaurant functionality part of the canonical release?

Yes. The canonical lineage includes the adopted Restaurant work, including KDS, recipes/BOM and production/waste capabilities referenced by the current acquisition program.

### Q: Should historical Capability Matrix rows saying Restaurant/KDS are pending be trusted as current status?

No. Those rows are historical drift. Use the exact source SHA, later canonical acquisition program and this data-room overlay first.

## Migration

### Q: What can be imported today?

The verified Migration baseline covers products, categories/product mapping, customers, suppliers and opening inventory, plus the explicit customer update-existing-by-phone strategy.

### Q: Does Korvi auto-create ambiguous categories or trust foreign IDs from the file?

The adopted Migration design resolves product category by tenant-scoped name mapping and does not treat arbitrary client/file category IDs as authoritative.

### Q: Are competitor-specific adapters complete?

No. M7 adapters were intentionally deferred until a real customer/source system supplies an actual mapping requirement.

## Offline / installed clients

### Q: Is there Windows proof?

Yes. Exact-SHA Installed Cashier Windows workflow evidence exists.

### Q: Is there Android proof?

Yes. Exact-SHA Android installed-client build proof exists.

### Q: Does Android proof mean Play Store production distribution is complete?

No. Build/install proof is distinct from production release-signing/store-distribution lifecycle.

### Q: Is full merchant offline operation production-proven?

The repository has strong offline engineering foundations and proofs, but real merchant production field validation remains open.

## Database / migrations / DR

### Q: What database is used?

PostgreSQL with Prisma migrations in the current architecture.

### Q: How are production migrations expected to run?

Forward-only through the documented production migration process, with migration-ledger/drift verification. The runbooks explicitly reject using `db push` to silently reconcile an occupied production database.

### Q: Has restore been tested?

A PostgreSQL DR restore workflow succeeded on the exact SHA. This is engineering rehearsal evidence, not proof of a production provider's backup retention/SLA.

### Q: Are RPO/RTO proven?

Not in real production. Current targets are RPO <= 15 minutes and RTO <= 60 minutes; real measured production-equivalent evidence remains external.

## Operations

### Q: Does Korvi have health/readiness concepts?

Yes. The operations model separates liveness/readiness, and outage/recovery engineering proof exists.

### Q: Is external monitoring live?

Not claimed. Monitoring thresholds/model are documented; provider routing and real alert acknowledgement remain external activation items.

### Q: Is there an incident runbook?

Yes.

### Q: Is there a rollback procedure?

Yes, with explicit schema/data-integrity stop conditions.

## ZATCA

### Q: Is Korvi ZATCA Production activated?

No.

### Q: What is proven internally?

The current exact-SHA evidence includes multiple Gate 38/39/40 engineering proofs covering UBL/hash/canonicalization/sealing/CSID/submission boundaries.

### Q: What remains?

Real merchant production identity, Production CSID, Azure HSM/non-exportable production key custody, real production reporting/clearance/reconciliation and production rotation/recovery evidence.

### Q: Can staging simulation accidentally be represented as production tax compliance?

The adopted design separates simulation and production, visibly marks simulation artifacts as not for tax use, and requires production authority to fail closed.

## Supply chain / licensing

### Q: Is there a root Korvi open-source license?

No root first-party OSS license grant is present in the current repository state documented for acquisition.

### Q: Does that alone prove legal ownership?

No. Git history proves technical provenance, not legal chain-of-title.

### Q: Are third-party dependency licenses inventoried?

A technical npm lockfile inventory is now included in the data room. Legal review of actual distribution/linking/notice obligations remains required.

### Q: Are there licenses that deserve special diligence?

Yes. The technical inventory surfaces LGPL, MPL, EPL and CC-BY metadata among mostly MIT/Apache/ISC/BSD dependencies. This is a review flag, not a legal conclusion of incompatibility.

## Repository governance

### Q: Is the canonical source commit signed?

The exact acquisition source commit is GitHub-verified/signed.

### Q: Is `main` protected?

Current read-only repository metadata reports `main` as not protected, and the repository-level rulesets collection is empty.

This is a governance item to address deliberately, not a runtime defect.

### Q: Should old unsigned commits be rewritten?

No. The current acquisition guidance explicitly prefers preserving history and using controlled signing/release governance going forward.

## Production / merchant proof

### Q: Is Korvi Production Proven?

No.

### Q: Why not if engineering evidence is strong?

Because production proof requires real production provider/HA/backups/RPO/RTO/monitoring/on-call/secret management, real ZATCA production activation where required, and real field evidence.

### Q: Has a Merchant Production Pilot happened?

No. AR-7 remains open by design.

### Q: Can staging or a synthetic tenant close AR-7?

No.

## Acquisition gate

### Q: Is Korvi a Final Canonical Acquisition Release?

Not yet.

### Q: What is it today?

A unified, buyer-evaluable Canonical Acquisition Candidate with internal engineering complete for the adopted program and remaining external activation/transaction gates clearly disclosed.

### Q: What closes the final gate?

The final evidence package must bind required Production Operations, Production ZATCA, transaction/handoff and real Merchant Pilot evidence to the exact final release SHA, followed by human validation/approval.
