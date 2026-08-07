# ADR-0004 — Multi-tenancy boundaries

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

One deployment serves many merchants. A tenancy leak is the worst bug this
system can have: one merchant seeing another's sales.

The strategy document mentions 36 tables carrying `tenantId`. That is a
description of the finished product, not a specification for a foundation, and
creating 36 tables now to match a number would be building schema ahead of
knowledge.

## Decision

**Every tenant-owned model carries `tenantId`,** indexed first in every
composite index, and **every repository method takes a `TenantScope`.** There is
no repository method that can read tenant data without one.

`TenantId` is a branded type, so a bare `string` cannot be passed where a tenant
is expected.

**`GlobalCatalogItem` is the one documented exception.** The national barcode
catalogue is shared infrastructure — hundreds of thousands of rows of barcodes,
names and tax rates that are identical for every merchant. Giving it a
`tenantId` would duplicate the entire table per tenant for no isolation benefit,
because none of it is anyone's private data.

Phase 0 creates three models: `Tenant`, `Product`, `GlobalCatalogItem`. Enough
to prove the boundary works. More arrive when a feature needs them.

## Defence in depth: Row-Level Security

A `WHERE tenantId = ?` in a repository protects only the queries that remember
to include it. One forgotten clause, one raw query written under time pressure,
one ORM helper that builds its own SQL, and a merchant sees another merchant's
sales. Application-level scoping is necessary and not sufficient.

Revision 2 therefore moves the boundary into the database as well:

- **`ENABLE` and `FORCE` row level security** on every tenant-owned table.
  `FORCE` is the part usually missed: without it the table's owner bypasses
  every policy, and the application role is very often the owner.
- **Deny by default.** With RLS on and no matching permissive policy, Postgres
  returns nothing and rejects writes. Each policy opens exactly one door.
- **`USING` _and_ `WITH CHECK` on every policy.** `USING` alone governs reads;
  without `WITH CHECK` a caller could update a visible row and reassign it to
  another tenant.
- **Context via `SET LOCAL` inside a transaction**, through `withTenant()`. A
  plain `SET` persists for the life of the connection, and a pooled connection
  is handed to the next request — leaking one tenant's context into another's
  query, the exact failure RLS is meant to prevent.
- **`current_tenant_id()` is `STABLE`, not `IMMUTABLE`.** `IMMUTABLE` would let
  the planner cache one tenant's value into a plan reused for another.
- **`global_catalog_items` carries no RLS**, deliberately. Enabling it there
  would require a policy permitting everything, which is a misleading way to
  write "not protected".

Prisma has no first-class hook for per-transaction session variables, and
middleware does not reliably share the transaction's connection. `withTenant()`
is therefore a wrapper around `$transaction`, not middleware — the honest
solution rather than a hook that appears to work and sometimes does not.

A live-Postgres test proving cross-tenant reads are blocked belongs in Phase 1
integration. What Phase 0 ships is a static check that every tenant-owned table
has RLS, `FORCE`, and a policy with both clauses — so a table added without
protection fails the build.

## Consequences

- Adding a tenant-owned model means adding `tenantId`, its index, a scoped
  repository method, **and** an RLS policy plus its entry in the policy test.
  Non-negotiable.
- A second global table needs a new ADR, not a judgement call.
- Every tenant-scoped database call must run inside `withTenant()`. Outside it,
  RLS returns nothing — which is safe, and looks like an empty database until
  someone reads this ADR.
