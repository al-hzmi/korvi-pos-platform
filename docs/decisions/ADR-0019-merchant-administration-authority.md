# ADR-0019 — Merchant administration authority

Status: accepted · Strike 4B-1 · builds on ADR-0004, ADR-0012, ADR-0018

## Context

Korvi could sell, reconcile a drawer and provision a tenant, and a merchant
could change nothing about their own shop. Every branch, till, person and role
had to be inserted by hand. 4B-1 gives the merchant that authority as a server
surface, before 4B-2 puts a screen on it.

Two things make this more than CRUD. The first is that a merchant
administrator is not a platform operator, and the boundary between them has to
be structural rather than a convention. The second is that administration
changes _access_, and access that has already been handed out as a session is
the part people get wrong.

## Decision

### One settings model

There is one tenant-settings shape, on the persistence port, and the
administration surface reads and writes through it. `enableProductImages` lives
there with the rest rather than only in the admin layer, because a second
read-side copy of the settings model is how a `PATCH` that persists `true` gets
answered `false` by the next `GET`.

### The boundary with the control plane

`/v1/admin/**` is the merchant administering the merchant. It does not import,
wrap or expose `provisionTenant`, `activateTenant`, `suspendTenant` or
`reactivateTenant`, and there is no field on any request that reaches them. A
merchant owner cannot change their own lifecycle status, and the settings patch
type has no `status` in it to try.

Nothing here takes a tenant id. Every method on `MerchantAdminService` takes an
`AuthenticatedPrincipal` and nothing that could stand in for one, so a body's
`tenantId` has nowhere to go: the compiler enforces what a handler would
otherwise have to remember. The routes additionally name the fields a client
may never send, so an attempt is a legible refusal rather than a silently
ignored key.

### Two permissions, and they are the ones that already exist

`settings.manage` governs the shop's own configuration — settings, branches,
tills. `users.manage` governs people and what they may do. Both are checked by
the existing guard against permissions the auth repository reads from
persistence on every request. There is no second authorization system, no
owner boolean, and no route that consults a role name.

Four settings are deliberately not merchant self-service: `vertical`,
`priceMode`, `defaultVatBasisPoints` and `currency`. Each re-prices or re-taxes
every sale that follows, and two of them change how an already-printed receipt
should be read.

### Access changes take effect immediately, in one transaction

Disabling a user or a membership does three things together: the flag moves,
every live session for that user is revoked, and the audit row is written.
Session resolution would already refuse an inactive user or membership — it
reads both from the row rather than from the token — but revoking is the
durable act, and it closes the window between "the flag moved" and "the next
request notices".

Removing a role revokes nothing, and does not need to. Authorization is
re-derived from `user_roles` on every request, so the very next request from an
already-issued session no longer carries the permission. The session stays
valid because nothing about _who_ the person is has changed. Signing somebody
out because their discount ceiling moved would be a worse answer to a smaller
problem.

Reactivation resurrects nothing. `revokedAt` is only ever set and never cleared
anywhere in Korvi, so a session stopped by a deactivation stays stopped and the
person signs in again. That is structural rather than a rule somebody has to
remember.

### Surviving administrative authority

A merchant must not be able to lock itself out of its own administration with
one request, or with two that are individually safe.

"Administrator" is defined by a permission, not a role name: a _viable
administrator_ is an active user with an active membership who holds
`users.manage` through some role. Keying it on the role called `owner` would be
wrong in both directions — a merchant who renames their roles would lose the
protection, and one whose owner role had been stripped of the permission would
keep a protection that protects nothing.

Every operation that can reduce that authority — disabling a user, disabling a
membership, removing a role — takes the tenant row `FOR UPDATE` first, performs
its write, and then counts the viable administrators **on the state it has
already written**, before committing. Measuring the outcome rather than
predicting it is what makes it correct under concurrency: two requests each
removing a different administrator both look harmless in isolation, and only
the second one's post-state shows the merchant is locked out. The lock is what
serialises them; the post-state count is what catches the loser. The rule
itself is a pure function in `@korvi/domain`, so there is one definition of
"administrator" rather than one per caller.

Operations that cannot reduce authority — creating a branch, renaming a till —
do not take the lock. A shop should not wait behind a role assignment to be
renamed.

### Failing closed rather than repairing, and the lock that makes it true

A branch or till with an open shift is not deactivated. The request is refused
and the merchant closes the drawer first. Deactivating rewrites no history:
every sale, shift and invoice already recorded against a branch is untouched,
there is no hard delete anywhere in this strike, and no shift is ever closed on
a merchant's behalf.

A state check alone would be a lie. "No open shift" read outside a shared
serialization boundary is a fact about the past, and a shift opening in the gap
between the check and the commit would survive under an inactive till — exactly
the kind of stranded drawer this rule exists to prevent.

So opening a shift and standing a branch or a till down take the same rows, in
the same order: **branches, then terminals**, then shifts. That is the order
ADR-0017 already documents for every financial path, with terminals inserted
between branches and shifts — no path takes a terminal lock after a shift lock,
so the extension adds no cycle and no deadlock. Concretely:

- `ShiftRepository.open` takes the branch row, then the terminal row, and now
  refuses an inactive **parent branch** as well as an inactive terminal;
- `setTerminalActive` takes the branch row, then that terminal's row;
- `setBranchActive` takes the branch row — which is sufficient for every till
  in it, because an opening on any of them queues on that same row;
- `createTerminal` takes the branch row, so a branch cannot be stood down
  between "the branch is trading" and the insert.

Whichever transaction the lock manager grants first, the second sees its commit.
An opening that wins makes the deactivation refuse; a deactivation that wins
makes the opening refuse.

An inactive parent branch is its own refusal — `branch-inactive`, 409 — and
deliberately not `branch-in-use`. Nothing is open in that case, and telling a
merchant to close a drawer that does not exist sends them looking for
something that is not there. Shift opening answers it separately too, rather
than folding it into `unknown-terminal`: the till is addressable, and the
remedy is to activate the branch.

Switching a till on under a stood-down branch is refused for the same reason —
it would produce precisely the state `ShiftRepository.open` now declines, while
looking to the merchant like a till that works.

### Creating people, and the invitation that does not exist

`POST /v1/admin/members` creates a user with no credential and an active
membership. The account exists, can be placed in a branch and given roles, and
cannot sign in: `passwordHash` is null and the login path refuses a null
credential outright rather than comparing against nothing.

There is deliberately no invitation. Korvi has no mail transport, no single-use
credential token and no password-reset flow. Adding an `invitedAt` column or
answering "invitation sent" would be a claim that something left the building.
Establishing the credential is a deferred boundary, named below, not a thing
this strike pretends to do.

### Lists are bounded, and continuable

Every list endpoint takes a `limit` capped at 100 and reads one row more than it
returns, so `hasMore` is a fact rather than a guess and no administration screen
can turn into an unbounded production query.

`hasMore` without a way to continue would make everything past the first page
permanently unreachable, so each list also returns `nextCursor`. Continuation is
keyset, not offset: branches and tills order by `code` and members by `email`,
each of which already carries a `(tenantId, …)` unique index, so one column is a
total order and a single-value cursor is complete. An offset would skip or
repeat rows the moment somebody adds a branch mid-traversal.

The cursor is base64url of that key. Encoding is not secrecy — a branch code is
not a secret — it is a statement that the value is the server's to interpret. It
carries no tenant and no actor: scope comes from the session, so a cursor from
another merchant is just a string that sorts somewhere inside the caller's own
rows. A malformed or over-bounded token is refused (`invalid-cursor`, 400) rather
than treated as "start again", which would loop a paging client; a syntactically
valid cursor is simply interpreted as a position in this tenant's ordering. A
cursor naming a row that has since been deleted remains deterministic because it
still names a place in that order.

Assignable roles are **bounded rather than paged**. A tenant's roles are the
four Korvi provisions and custom-role CRUD is deferred, so a cursor would be
ceremony with no reader — but an unbounded `findMany` sitting in the code
waiting for a later strike to make it a production query is not acceptable
either. The query takes a hard `MAX_ASSIGNABLE_ROLES` ceiling, and a live test
gives a tenant more roles than the ceiling to prove the bound is real.

### Audit

One event name per act — `branch.created`, `member.role-unassigned`, and so on
— never a generic one, because a trail whose rows all say "updated" answers no
question. `actorUserId` is the authenticated merchant user, which is exactly
the field a control-plane event leaves null (ADR-0018). Events are written
inside the transaction that made the change, so a refusal, a rollback and a
no-op replay leave no row claiming success.

## Consequences

Authority-reducing operations on one merchant serialise on the tenant row. They
are rare, the transaction is small, and the alternative is a merchant that can
be locked out by two well-formed requests arriving together.

The last-administrator count runs after the write on every such operation. It
touches only users who hold the permission, which is a small set, and it is
paid once per administrative mutation rather than per request.

A merchant with exactly one administrator cannot remove that administrator's
authority at all — not even deliberately. Correct: the way to reduce to zero
administrators is to have Korvi suspend the tenant, which is 4A's and requires
a platform operator.

## Boundaries

**4B-2** owns the administration UI. This strike builds no screens.

**Deferred, and named so nobody looks for them here:**

- Credential establishment for a created member — invitation delivery,
  single-use tokens, password reset. Needs a mail transport and a token model
  Korvi does not have.
- Custom role design. Roles can be _assigned_ here; creating and editing a
  merchant's own roles is not built, and the permission catalogue is the
  application's rather than a merchant's.
- Control-plane transport and operator identity, which remains a 4B-adjacent
  security concern and takes no slot of its own (ADR-0018).
- **4C** Plan/Entitlement Foundation and **4D** Onboarding are unchanged and
  unclaimed by this strike. Nothing here decides what a plan permits, and
  `active` still does not mean "ready to trade".
