# Korvi — Current Acquisition Status

Source SHA: `61dbb34dea08809756fd767b907b0e852b7e5978`

## Closed internally

- AR-0 Canonical integration.
- AR-1 Platform Admin durable server-side session revocation.
- AR-2 sellable POS workflows: electronic/mixed tender, original-sale return/refund, shift close and cash reconciliation.
- AR-3 one canonical product lineage containing current Retail/Core, Restaurant, KDS, recipes/BOM, production/waste, Migration Engine and security/workflow fixes.
- AR-4 internal Production Operations engineering package.
- AR-5 internal Production ZATCA engineering proofs.
- AR-6 engineering buyer/handoff package.

## Hosted staging state

As externally re-verified after the independent audit:

- Render API branch: `release/canonical-acquisition-v1`
- Render Web branch: `release/canonical-acquisition-v1`
- API live deploy SHA: `61dbb34dea08809756fd767b907b0e852b7e5978`
- Web live deploy SHA: `61dbb34dea08809756fd767b907b0e852b7e5978`
- API deploy: `dep-daphbcek1f9s7391th4g`
- Web deploy: `dep-daphc8mk1f9s73921c80`
- API health check returned HTTP 200 after deployment.
- staging database: PostgreSQL 17, free plan, HA disabled.
- staging database expiration currently reported by provider: 2026-10-07.

This closes the prior **Canonical Code != Hosted Staging** drift for the evaluation environment. It does not convert free staging into production infrastructure.

## Still open by design

- real production database/provider plan;
- production HA/failover;
- managed production backups/retention;
- production-equivalent restore with measured RPO/RTO;
- external monitoring/alert delivery and real on-call binding;
- production secret-management/rotation evidence;
- Azure HSM / non-exportable production signing authority;
- merchant Production ZATCA identity/CSID/reporting/clearance;
- real Merchant Production Pilot;
- legal chain-of-title / assignment or license instrument;
- account/domain/credential transfer;
- repository-owner governance activation as transaction scope requires;
- final exact-SHA acquisition evidence manifest and human validation.

## Terminology

Allowed:
- Canonical Acquisition Candidate.
- Internal Engineering Complete.
- Engineering/Product release unified.
- Hosted staging aligned to canonical SHA.

Not allowed yet:
- Production Proven.
- Production ZATCA Activated.
- Final Canonical Acquisition Release.
- Merchant Proven.
