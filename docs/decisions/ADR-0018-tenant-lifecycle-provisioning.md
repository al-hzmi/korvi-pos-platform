# ADR-0018 — Tenant lifecycle and provisioning authority

Status: accepted · Strike 4A · builds on ADR-0004, ADR-0012, ADR-0013, ADR-0017

## Context

Korvi could sell, refund and reconcile a drawer, and had no way to say where a
merchant came from. A tenant existed because somebody inserted a row, its
`status` column defaulted to `active`, and nothing recorded who decided any of
it. Three consequences followed from that one default:

- a half-built tenant — a row with no settings, no roles, or roles bound to no
  permissions — was representable, and would fail at the till rather than at
  creation;
- a merchant could be stopped only by editing a column, which left every live
  session working until it expired;
- "this account was suspended, by whom, and why" had no answer anywhere.

This ADR makes the tenant's life a state machine with one authority, and puts
the parts a constraint can hold into PostgreSQL.

## Decision

### Three states, and the safe one is the default

    provisioning — the row exists and its foundation is being laid. Nothing
                   authenticates against it.
    active       — the merchant may sign in and sell.
    suspended    — stopped. Sessions are revoked at the moment of suspension,
                   and authentication is refused from then on.

    provisioning -> active     activate
    active       -> suspended  suspend
    suspended    -> active     reactivate

Everything else fails closed. The transition table lives in
`packages/domain/src/tenancy/lifecycle.ts`, is exhaustive over the nine
state/transition pairs, and is the only definition of what may follow what — a
lifecycle whose illegal moves are "whatever the code forgot to check" is a
lifecycle that will be moved illegally.

The new-row default is `provisioning`, not `active`. That is the whole point:
a tenant becomes usable because somebody decided to admit it, never because a
row appeared. The migration changes the default for new rows only, so every
tenant that was already trading keeps trading.

`active` is **not** "onboarding complete". A tenant can be active with no
branches, no tills and no products. Whether it is _ready to trade_ is a
different question and 4D owns it.

The database carries the parts a constraint can hold: `status` is restricted to
the three states, `activatedAt` is present exactly when the tenant is not
`provisioning`, and `suspendedAt` and `suspensionReason` are present exactly
when it is `suspended` — set together, cleared together, with the reason
trimmed and bounded. Reactivation clears the pair; the history of past
suspensions lives in `audit_events`, which nothing rewrites.

### An unknown historical fact is not a guessed fact

Those strict invariants are true of every tenant Korvi provisioned. They cannot
be true of a tenant that already existed, because the facts they demand were
never recorded: nothing knows when a pre-4A merchant was admitted, and if one
was already suspended, nothing knows when or why.

The temptation is to reach for a nearby timestamp — `createdAt` for admission,
`updatedAt` for suspension. Both would be fabrications. `updatedAt` is when the
row last changed, which for a suspended merchant is at best a coincidence and at
worst a price change; presenting it as "suspended at" turns an unknown into a
number somebody will later cite in a dispute.

So the schema gains one column, `lifecycleProvenance`:

    recorded — Korvi provisioned this tenant and every transition since went
               through the control plane. Full invariants apply.
    legacy   — the tenant predates lifecycle recording. Its status is known;
               its admission time is not, and neither is the origin of a
               suspension it arrived already carrying.

One column rather than a "known" flag per fact, because there is exactly one
cause of unknown history — existing before this migration — and a row either
has that cause or does not. It is set once and never promoted: a legacy tenant
Korvi later suspends gains a real suspension time and reason, but its admission
time stays unknown for ever, so the row stays `legacy`.

The exemption is narrow and named. Legacy rows are exempt from
`tenants_recorded_lifecycle_complete` and from nothing else. In particular the
pairing rule still binds them: a legacy tenant either says nothing about its
suspension or says both halves. What it may not do is say half.

The migration therefore writes almost nothing. Existing rows are marked
`legacy`; an `active` one stays active with a null `activatedAt`, and a
`suspended` one keeps null time and reason. The single exception is a status
this code cannot interpret — `closed`, or anything else. That row is suspended
**now**, by the migration, and so it does get a `suspendedAt` and a reason
naming the migration and quoting the old value. That is not a guess about the
merchant's past: it is a true statement about a Korvi action, and it is the
difference between recording what happened and inventing what might have.

### Provisioning is one transaction

`provisionTenant` establishes, atomically: the tenant row in `provisioning`,
its normalised slug, its `TenantSettings`, Korvi's four default roles with
their exact permission bindings, and one `tenant.provisioned` audit event.

It deliberately does **not** create branches, terminals or users. Those are
4B/4D's, and a tenant does not need them to be a tenant.

`provisionTenantRbac` was split so the role installation can join the caller's
transaction (`provisionTenantRbacWithin`). A tenant whose roles were installed
by a second, independent transaction can exist with no roles if that second
transaction fails, which is exactly the half-built merchant this decision
exists to prevent. The `…Within` form takes a raw tenant id and an open
transaction, so it is not exported from the package barrel — the same rule
`applyMovementWithin` already follows.

### RLS is satisfied, not bypassed

The bootstrap looks circular: `tenants` is under FORCE RLS keyed on a scope
that does not exist until the tenant does. It is not circular, because the
scope is _chosen_ by the provisioner rather than discovered. The id is minted
first, `app.tenant_id` is set to it, and the insert then satisfies the existing
`tenants_isolation` WITH CHECK without a new door being opened. Every child row
in the same transaction is written under the same context.

A provisioning replay is resolved through `tenants_login_resolution`, the
FOR SELECT policy ADR-0012 already added for the login lookup — one row wide,
read-only, and matched on one transaction-local setting.

No bypass role, no superuser connection, no policy weakened.

The one place FORCE is lifted is the lifecycle migration, for a backfill of
legacy rows. That migration opens and commits its **own** transaction: it
literally begins with `BEGIN;` and ends with `COMMIT;`, placed so that the
lift, the backfill, the FORCE restoration, every constraint and the unique
index are inside it. Explicit, because Prisma Migrate does not wrap a
PostgreSQL migration file in a transaction on its own, and because a client
that happens to give a multi-statement string an implicit one is not something
a security boundary may depend on — that behaviour varies by driver, by
protocol and by how the file is fed to psql.

So there is no committed state in which FORCE is off. Either the whole
migration lands or none of it does, and while it runs the `ALTER TABLE`s hold
an ACCESS EXCLUSIVE lock so nothing else can read or write the table. Both
halves are rehearsed against a live server: one rehearsal applies the migration
to a seeded pre-4A schema statement by statement and checks the result, and a
second injects a fault after FORCE has been lifted and the backfill has written
rows — reading `pg_class` inside the open transaction to prove the window is
genuinely the dangerous one — then rolls back and finds FORCE on, no lifecycle
columns, and every legacy row untouched.

### Provisioning idempotency lives on the tenant row

`IdempotencyKey` is tenant-owned, and provisioning is the operation that
decides a tenant exists — there is no tenant to scope a key to until it has
succeeded. Rather than add a second global table, the evidence lives on the row
the operation creates: `provisioningOperationId`, unique across the
installation, and `provisioningRequestHash`, the canonical fingerprint of what
was asked for. The two are paired by a constraint: an id with no fingerprint
could not answer the only question it exists to answer.

The insert is `ON CONFLICT DO NOTHING` rather than a preflight read, because
two identical attempts arriving together would both find the slug free. When it
writes nothing, one of the two unique indexes has already spoken, and the
answer is read back through the login-slug policy:

    same operation, same fingerprint      replay the same tenant
    same operation, different fingerprint request-mismatch
    slug held by a different operation    slug-taken
    slug held by nobody                   operation-id-reused

The last case is the one worth naming: the slug is free, so the index that
refused was the one on the operation id — this id already created a merchant
somewhere else, and handing that merchant back would be an identity swap
wearing a retry's clothes.

Because the reservation _is_ the tenant row, a failure part-way through
provisioning takes it with it. There is no tombstone, and the same operation id
is still usable on a lawful retry.

### Lifecycle mutations lock the row

Every transition runs inside `withTenant` and takes the tenant row
`SELECT ... FOR UPDATE` before it decides anything. The order is the drawer's
(ADR-0017): lock, then the state question, then the reservation, then the
writes. A status check before the lock would be a guess, and a reservation
taken before the state check would leave a tombstone behind an illegal move.

Reservations use the existing `idempotency_keys` table under scope
`tenant-lifecycle`, written in the same transaction as the state change.

The fingerprint binds the transition, the target tenant, the operator and the
suspension reason. Binding the operator is what stops an operation id becoming
a bearer token for somebody else's decision — the same rule the drawer
fingerprints follow, for the same reason. Consequently:

- same operation, same intent → replay, `changed: false`;
- same operation, changed reason or changed operator → `idempotency-conflict`;
- a _different_ operation asking for a move that has already happened →
  `illegal-transition`, not a replay.

Two operators suspending the same merchant at once serialise on the row. The
second is granted the lock after the first commits, sees a suspended tenant,
and is answered from its own operation id: a retry replays, a different
operation is told the move is not available. Neither leaves a reservation
behind.

### Who asked

Privileged operations require a bounded `controlPlaneActorRef` — an opaque
trimmed string, at most 120 characters. Deliberately not a user id.

A platform operator is not a merchant's user. Minting a `User` row inside the
merchant's own data to satisfy `audit_events.actorUserId` would put an operator
into that merchant's user list — visible, assignable, and available to be
granted a role. So `actorUserId` stays null on control-plane events, and the
operator reference travels in the event's structured metadata alongside the
operation id, the two states and, for a suspension, the reason. Bounded
operational facts only; no credential, token or password material.

Suspension requires a trimmed, bounded reason. It is refused rather than
truncated: half an explanation on the row that stopped a merchant trading reads
like the whole one.

### Suspension is immediate, and reactivation does not undo it

`active -> suspended` revokes every session with a null `revokedAt` in the same
transaction as the state change. There is no window in which the tenant is
stopped and its sessions still authenticate, and no reliance on a cookie
expiring.

`suspended -> active` restores the tenant and resurrects nothing. `revokedAt`
is only ever set, never cleared — there is no code path that could un-revoke a
session, which is what makes the guarantee structural rather than a rule
somebody has to remember. The user signs in again.

Authentication already read the tenant's status on every request (ADR-0012) and
continues to: login refuses a tenant that is not `active`, and so does session
resolution, before the session's own revocation, expiry and version checks.

Externally none of this is distinguishable. A suspended tenant, a tenant still
provisioning, a tenant that does not exist and a wrong password all answer
`401` with the same body, and every early exit still pays for a scrypt
derivation. A caller who could tell them apart could enumerate the platform's
customers.

### Audit

Four append-only events: `tenant.provisioned`, `tenant.activated`,
`tenant.suspended`, `tenant.reactivated`. One name per move, never a generic
one, each written in the transaction that made the change — so a refused
transition, a conflicting replay and a rolled-back provisioning leave no event
at all.

## Consequences

Lifecycle operations on one tenant serialise. The lock is held for one small
transaction and a merchant's lifecycle changes perhaps a handful of times in
its life.

`provisioningOperationId` is unique installation-wide, which is a global
namespace the control plane has to keep. That is inherent: the operation
predates the tenant, so it cannot be namespaced by one.

`TenantStatus` in the persistence port is now an alias of the domain's
`TenantLifecycleState` rather than its own literal union. Two unions that agree
today are free to disagree tomorrow, and these two sit on either side of the
boundary that decides whether a merchant may trade.

The pre-4A `closed` status is gone. It was never written by anything and had no
transition into or out of it; the migration maps any uninterpretable status to
`suspended`, because a row whose state cannot be read must not be one that can
trade.

## Boundaries

Strike 4A is the authority and nothing else. There is **no UI** and **no public
control-plane HTTP route** — `provisionTenant`, `activateTenant`,
`suspendTenant` and `reactivateTenant` are internal functions, reachable only
from a process that has already been trusted.

The accepted Stage 4 sequence is unchanged by this ADR, and this ADR does not
get to change it. The roadmap may defer an accepted capability; it may not
delete one or quietly reassign its slot.

- **4B — Control-Plane Administration.** Owner/admin APIs and UI for tenant
  settings, branches, terminals, memberships and roles.
- **4C — Plan/Entitlement Foundation.** Plan identity, entitlement evaluation,
  account state. Accepted at B0/C1 in the Capability Matrix as
  "Subscription/plan entitlement foundation", and named in the Master Product
  Directive as part of the SaaS Control Plane. Not implemented here, and not
  deleted here.
- **4D — Onboarding.** Guided merchant setup and readiness checks — the
  question `active` deliberately does not answer.

One concern this strike creates is deferred without a slot of its own:
**control-plane transport and operator identity**. `controlPlaneActorRef` is
today an opaque string supplied by whatever process calls these functions, and
nothing in Korvi authenticates a platform operator or exposes these operations
over a wire. That is a control-plane security and transport concern belonging
with 4B's administrative surface, and it must be settled before any of these
functions is reachable from outside the process. It is **not** a fifth stage
and it does not take 4C's place.

Entitlement is 4C's, and this ADR states only what 4A must not become: a
tenant's lifecycle is an operational state, not a billing state. When 4C lands,
whether an invoice was paid must not be expressed by suspending a tenant unless
that is an explicit, separately decided policy.
