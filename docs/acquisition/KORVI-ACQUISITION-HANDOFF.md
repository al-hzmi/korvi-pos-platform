# Korvi Acquisition / Buyer Handoff Package

Status: **AR-6 ENGINEERING PACKAGE — IN PROGRESS**

Canonical acquisition branch:

`release/canonical-acquisition-v1`

AR-0 through AR-3 canonical governance checkpoint:

`a575da1777f0c5b3ef6c836872c62c88780cf4ec`

Exact-head evidence on that checkpoint:

- CI push `35775961151` / `35775913150` — PASS;
- PostgreSQL 17 restricted-role/full verification `35775913087` — PASS;
- Chrome commercial workflow proof `35775913094` — PASS;
- Installed Cashier Windows proof `35775917528` — PASS;
- Installed Cashier Android proof `35775917445` — PASS.

This package is an engineering/acquisition handoff. It is not a claim that Production Operations, Production ZATCA or a real Merchant Pilot are already complete.

## 1. Architecture package

Primary sources:

- `docs/governance/KORVI-ARCHITECTURE-MAP.md`
- `docs/architecture/overview.md`
- `docs/architecture/offline.md`
- `docs/architecture/zatca.md`
- `docs/governance/KORVI-CAPABILITY-MATRIX.md`

Authority rule: domain/server/database facts own money, stock, permissions and compliance truth. Browser/native clients collect intent and render approved facts.

## 2. Deployment guide

- Production architecture: `docs/operations/PRODUCTION-DEPLOYMENT.md`
- Staging-only reference: `docs/operations/STAGING-DEPLOYMENT.md`
- Production migration script: `scripts/deploy/production-migrate.sh`
- Release/rollback: `docs/operations/RELEASE-ROLLBACK.md`

Staging manifests and free Render resources are not production topology.

## 3. Environment inventory

See `docs/acquisition/ENVIRONMENT-INVENTORY.md`.

The inventory contains names/ownership boundaries only. Values are deliberately excluded.

## 4. Database migration guide

Production rules:

- forward-only Prisma migrations;
- exact ledger/checksum proof;
- no `db push` on occupied environments;
- dedicated restricted migrator;
- separate non-owner runtime role;
- runtime may not write the migration ledger;
- zero schema drift required before serving traffic.

Primary implementation: `scripts/deploy/production-migrate.sh`.

## 5. Backup / restore / DR

- `docs/operations/DISASTER-RECOVERY.md`
- `.github/workflows/operations-dr-postgres.yml`

Engineering restore rehearsal uses PostgreSQL 17, isolated source/restore roles, exact migration verification, RLS and application-level proof. Production backup retention/RPO/RTO still require external provider evidence.

## 6. Monitoring / incident / on-call

- `docs/operations/MONITORING-ALERTING.md`
- `docs/operations/INCIDENT-RESPONSE.md`
- `.github/workflows/operations-incident-proof.yml`

Role-based escalation is defined without committing personal contact data. Production activation must bind roles to real channels and exercise an alert drill.

## 7. ZATCA operations boundary

- `docs/architecture/zatca.md`
- ADR-0032 / ADR-0033 / ADR-0034
- `docs/acquisition/ENVIRONMENT-INVENTORY.md`
- `docs/acquisition/DEFERRED-ACTIVATION-GATES.md`

Production ZATCA remains fail-closed. Simulation/staging evidence never closes the production gate.

## 8. Dependency / supply chain

- `package-lock.json`
- `docs/acquisition/DEPENDENCY-SUPPLY-CHAIN.md`
- `docs/governance/SUPPLY-CHAIN-REVALIDATION-2026-09-08.md`

## 9. Ownership / IP / licensing

See `docs/acquisition/OWNERSHIP-IP-LICENSING.md`.

Technical provenance is recorded by Git. Legal chain-of-title and transaction assignment are separate diligence items and are not fabricated from commit history.

## 10. Test and CI evidence

The current canonical program tracks exact SHAs and run IDs in:

- `docs/governance/KORVI-CANONICAL-ACQUISITION-RELEASE.md`
- `docs/governance/PRODUCT-READINESS-SCORECARD.md`
- `docs/governance/KORVI-EXECUTIVE-DECISION-REGISTER.md`

Standard CI is necessary but C0 domains also use PostgreSQL/browser/device/provider proofs.

## 11. Release history

Git history is authoritative. Release integration is PR-based and non-force.

No attempt should be made to rewrite old unsigned commits merely to create cosmetic signing history. New release tags/commits may be signed where repository/operator capability supports it.

Repository branch protection/rulesets are an owner activation gate because the current connected automation does not have repository-administration permission.

## 12. Merchant onboarding / migration

The verified baseline supports controlled migration through M6:

- products;
- categories/product mapping;
- customers;
- suppliers;
- opening inventory;
- explicit customer update-by-phone conflict strategy.

Source-specific M7 adapters are deferred to real customer demand.

Onboarding/provisioning must use Platform Admin and merchant authorities, not direct SQL tenant/customer fixtures.

## 13. Deferred items

See `docs/acquisition/DEFERRED-ACTIVATION-GATES.md`.

Primary open acquisition gates after AR-3:

- AR-4 Production Operations external evidence;
- AR-5 Production ZATCA;
- AR-6 final transaction/legal/account-transfer diligence after engineering package;
- AR-7 real Merchant Pilot;
- AR-8 final acquisition release gate.

## 14. Handoff acceptance rule

A buyer/operator should be able to identify, from this package:

- the exact release SHA;
- how to build and verify it;
- how to migrate the database safely;
- which environment keys exist without seeing their values;
- how health/readiness/metrics behave;
- how to restore and roll back;
- which gates are externally blocked;
- what evidence is real and what is only engineering preparation.

Any claim that Production or Pilot evidence exists must point to immutable evidence from the exact applicable release lineage.
