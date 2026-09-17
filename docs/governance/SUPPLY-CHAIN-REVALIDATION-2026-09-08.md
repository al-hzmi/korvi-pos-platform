# Supply-chain revalidation — 2026-09-08

This record accompanies ADR-0028 and exists to make the active Stage 5 branch re-run its unchanged release gates after the bounded MySQL2 patch refresh.

- The transitive root override moved from `mysql2@3.24.3` to `mysql2@3.24.4`.
- The remediation preserves every unrelated locked package version.
- No application MySQL path, financial logic, schema, migration, authorization rule, inventory rule, costing rule or browser behavior changed.
- The patch earns no product-readiness credit by itself.
- The active-branch commit must pass normal CI and the PostgreSQL 17 restricted-role proof before staging is moved to it.
- Staging must then run API and web at the same exact commit before the deployment gate is considered current again.

The historical `npm ls mysql2 --all` caveat in ADR-0026 remains explicit while Prisma 7.10.0 retains its older exact upstream dependency declaration; it is not represented as a passing diagnostic.
