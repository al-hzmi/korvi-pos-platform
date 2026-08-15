# ADR-0020 — Plan identity and entitlement authority

Status: **ACCEPTED FOR STRIKE 4C**

## Decision

Korvi separates tenant lifecycle from commercial entitlement.

Tenant lifecycle remains `provisioning | active | suspended` and continues to
own admission, authentication suspension and session revocation.

Commercial account state is initially only:

- `active`
- `restricted`

No billing-provider states such as `past_due`, `trialing` or `cancelled` are
invented until a billing authority actually exists.

## Plan identity

A plan is identified by `(planKey, planRevision)`.

Strike 4C deliberately creates no global plan catalogue and names no fabricated
Basic/Pro/Enterprise tiers. Product/commercial configuration can later map real
plans onto this identity without migrating tenant commercial history.

## Immutable assignments

Every control-plane change inserts a `tenant_plan_assignments` row plus its
`tenant_plan_entitlements`.

`tenant_commercial_accounts` contains only the pointer to the current assignment.

Changing plans therefore never rewrites the old commercial snapshot. A retry of
an older operation can still return the exact result that operation originally
created, even when a newer assignment has since become current.

## Entitlements

Two primitives exist:

- `flag`: enabled or disabled capability.
- `limit`: non-negative integer ceiling stored as PostgreSQL BIGINT.

There is no floating-point commercial limit.

Unknown, missing, unconfigured and restricted states fail closed.

## Concurrency and idempotency

Every assignment locks the tenant row first.

This is also the serialization row used by tenant lifecycle, so a lifecycle move
and a commercial assignment cannot race through half-observed state while still
remaining semantically independent.

The control-plane `operationId` is unique per tenant and is bound to a canonical
SHA-256 fingerprint including tenant, plan identity, account state, operator and
the normalized entitlement snapshot.

A replay with the same fingerprint returns the immutable original assignment.
A reused operation id with different intent is refused.

## Security

All commercial tables carry tenantId and use ENABLE + FORCE RLS with USING and
WITH CHECK.

The platform operator remains an opaque `controlPlaneActorRef`; it is not
fabricated as a merchant User.

There is no merchant-facing write route in Strike 4C.

## Not claimed

Strike 4C does not claim:

- payment collection,
- subscription invoicing,
- trial or renewal rules,
- merchant self-service plan changes,
- enforcement on every existing POS route,
- production readiness.

Those require later bounded strikes and their own gates.
