# ADR-0021 — Initial owner bootstrap

Status: accepted · Strike 4D-3 · builds on ADR-0004, ADR-0012, ADR-0018, ADR-0019

## Context

Provisioning a tenant creates the tenant row, its settings, Korvi's default
roles with their permission bindings and an audit event — and no merchant user,
and no credential (ADR-0018). Every merchant surface, including 4D's onboarding
readiness, requires a real session. So a freshly provisioned merchant is a shop
nobody can open the door to.

The obvious fixes are both wrong. Having provisioning mint a user would put a
credential into the control plane's hands and an operator-shaped account into
the merchant's own user list. Having the merchant surfaces accept an
unauthenticated "first run" mode would put a permanent hole in the boundary
every other strike has been defending.

## Decision

### Provisioning still creates no merchant user

A platform operator is not a merchant user. They are not in the merchant's
`users` table, they cannot be assigned a role there, and they do not appear in
a member list. That is why control-plane audit events carry a null
`actorUserId` and a bounded `controlPlaneActorRef` in metadata instead
(ADR-0018), and 4D-3 does not weaken it: the operator issues an _invitation_,
and somebody else turns it into an account.

### Two paths, two trust levels

**Issuing** — `issueOwnerBootstrapInvitation` — is trusted control plane. Not
HTTP, not the merchant's, not reachable from any route. It takes a `tenantId`
because naming a tenant is precisely the operator's job inside that boundary,
along with the invitee's email, display name, an `operationId` and a
`controlPlaneActorRef`.

**Accepting** — `POST /v1/bootstrap/owner` — is the one public, unauthenticated
write in Korvi. Its body is two fields: `token` and `password`. Not a tenant,
not a user, not a role, not a membership, not an email. The schema is `.strict()`
and the named authority fields are refused by name, so an attempt is legible
rather than silently ignored.

### The capability

    v1.<base64url canonical payload>.<base64url HMAC-SHA256>

HMAC-SHA256 from `node:crypto`, not a JWT dependency. The only question is "did
this server mint these claims", and a JWT would bring an algorithm-negotiation
header — the field responsible for more token vulnerabilities than any other
decision in that format. Here there is one algorithm and the token cannot
propose another.

The version prefix is **inside** the signed bytes. A verifier reading the
version from an unsigned prefix could be handed a v1 payload wearing a v2
label, which is the downgrade every versioned token eventually meets.

The payload carries three claims — `invitationId`, `tenantId`, `expiresAt` — and
nothing else. Not the email, not the display name, not the role, not the
operator. Those live on the invitation row and are read **under its own lock**
after verification, because a claim in a token is a fact frozen at issue time
and a column is the fact as it stands now. The second is the one that should
decide which account gets created, which is also why an invitee cannot redirect
an invitation to a different address.

Signature comparison is `timingSafeEqual` on equal-length buffers. A `===` on
two base64 strings leaks, one byte at a time, how much of a forged signature was
correct.

The signing key comes from configuration, is required in production, and appears
in no column, no log line, no error and no test fixture that reaches a database.
A deployment without one answers `503` on this route alone.

The boot check is a **length** floor of 32 characters and claims nothing more
than that. It catches `secret` and `changeme`; it cannot distinguish a CSPRNG's
32 bytes from a memorable sentence of the same length, and no schema validator
can. A production `BOOTSTRAP_SIGNING_KEY` must be generated from a
cryptographically secure random source — `openssl rand -base64 48`, or the
platform's secret manager — and handled as a secret: injected as an environment
variable, never committed, never logged, and rotated by re-issuing any
outstanding invitations. That is a deployment obligation. The floor is only the
part of it a boot-time check is capable of enforcing, and it must not be read as
evidence of entropy.

### The raw token is never stored

Everything in the payload comes from the invitation row, so an idempotent
re-issue re-derives the identical capability from the row plus the key. Storing
the token to support replay would mean keeping a live credential in a table —
and in every backup of it — for no gain.

### The acceptance pipeline, in order

Every step depends on the one before it, and the order is the security argument:

1. **request shape and credential policy** — the body is two fields, and the
   password must satisfy the credential-creation policy. Enforced at the
   authority itself, not only at the route, because `acceptOwnerBootstrap` is
   exported and a rule the handler in front of it applies is a convention rather
   than an invariant;
2. **HMAC and version verification** — nothing in the token is a fact until
   this passes, and the version is inside the signed bytes;
3. **a cheap, tenant-scoped invitation preflight** — read-only, no locks;
4. **scrypt, outside any transaction and holding no lock** — the key derivation
   happens here and nowhere else;
5. **the tenant's RLS context**, so PostgreSQL confines every statement below
   rather than a `WHERE` somebody remembered;
6. **the tenant row `FOR UPDATE`** — the same serialization point 4B-1 uses, so
   this is ordered against other bootstraps _and_ against authority changes;
7. **the invitation row `FOR UPDATE`** — this is what makes single use single;
8. **re-check every authoritative condition** — identity, expiry and
   consumption **by the row**, not by the token and not by the preflight, plus
   the merchant still having no viable administrator;
9. **establish authority** — create or claim the account named by the row,
   activate a membership, grant the tenant's **system** `owner` role found by an
   internal key lookup, write the already-derived hash;
10. **assert the postcondition** — that this account is now a viable
    administrator in 4D's own terms, asked of the tables;
11. **consume** the invitation;
12. **audit**, then commit.

A failure anywhere in steps 5–12 leaves no user, no membership, no grant, no
credential, no consumed invitation and no audit row.

### The preflight is a cost gate and never authority

Step 3 exists for exactly one reason: without it, a public unauthenticated
endpoint performs a memory-hard key derivation for any string at all, and a
caller with no token buys 64 MiB and a CPU-second per request.

It decides nothing. Every condition it reads — the invitation exists, the signed
expiry still matches the row's, it is unconsumed and unexpired — is checked
again in step 8 under the locks, because between the preflight and the
transaction another acceptance can consume the same invitation. Two contenders
holding the same valid capability can both pass the preflight and both derive a
hash; that is fine, because passing it requires possessing a real capability,
and the locked transaction still establishes exactly one Owner.

Step 4 sits outside the transaction deliberately. scrypt is slow and memory-hard
by design, and holding a tenant row lock across it would let one acceptance
stall every administrative change in that merchant.

### The postcondition

Step 10 is not a formality. Each write in step 9 can succeed while the whole
fails to mean anything: a system Owner role whose permission bindings have been
edited away grants nothing, so the acceptance would otherwise return `204`, burn
a one-shot capability, and leave the merchant with an Owner who cannot administer
it and no way to obtain another invitation.

So the transaction asks the question it actually cares about — is this account
now a viable administrator — of the tables as they stand, before spending the
capability. If the answer is no, it fails closed: the whole transaction rolls
back and the invitation stays unconsumed, so the same capability still works once
the tenant is repaired.

The role lookup is by key **among the tenant's system roles**. `isSystem` is the
difference between Korvi's Owner role, installed by provisioning (ADR-0018), and
a custom role a 4B-1 administrator happened to name `owner` — a merchant's label
is not Korvi's authority.

### Idempotency

Issuing is idempotent on `(tenantId, operationId)`. The same operation with the
same canonical intent — tenant, bound email, display name, operator — replays the
same logical invitation and the same derived capability. The same operation with
any of those changed is `idempotency-conflict`: a different decision wearing a
retry's name. Expiry is deliberately outside the fingerprint, because it is
derived from issue time and including it would make every retry a conflict.

At most one **live** invitation is outstanding per merchant, decided under the
tenant lock rather than by a partial unique index — Prisma cannot express one, so
it would read as permanent schema drift, and the lock is the stronger statement
in any case. Live means unconsumed **and** unexpired, asked of the database in
those terms.

### `consumedAt` means consumed

`consumedAt` records one fact: a bearer presented this capability and it was
honoured. Expiry never writes it. An invitation that simply ran out of time keeps
`consumedAt` null and remains a historical row, because it was never presented,
and stamping it would make the column the audit trail reads assert an acceptance
that did not happen.

That leaves "is this invitation still live" as two facts rather than one, and
both are asked wherever it matters. A lapsed invitation blocks nothing: the
control plane issues a replacement under a new operation. Replaying the original
expired operation stays idempotent to its own logical invitation and returns the
same expiry — a retry does not renew what it is retrying.

### RLS

`tenant_owner_bootstrap_invitations` is private merchant data — it names a
person and a shop — so it sits inside the same boundary as users and sales:
ENABLE and FORCE row level security, `USING` and `WITH CHECK` on
`tenantId = current_tenant_id()`, a tenant foreign key, and a `(tenantId, id)`
composite unique index for tenant-consistent references. Constraint and index
names are short and explicit, because PostgreSQL truncates identifiers at 63
bytes and a truncated name is two constraints sharing one.

### The public surface says one thing

Unknown invitation, wrong tenant, consumed, expired, forged signature, wrong
version, an address that already has a credential, and a merchant that already
has an administrator all answer `403 {"error":"invalid_capability"}` — one
status, one body. Telling them apart would make the endpoint an oracle for which
merchants exist and which invitations are outstanding, and the honest invitee
learns nothing from the distinction: they need a new invitation in every one of
those cases.

Two things stay separate from that. Malformed requests keep `400`, per the
existing conventions. And a weak password answers `400 weak_password` — a fact
about the caller's own input — which is checked **before** the capability is
examined, so it can never mean "your token was good".

### Bootstrap closes

Bootstrap closes on either of two independent facts: this merchant has already
completed a bootstrap, or it currently has a viable administrator. The first is
permanent and is the subject of the next section; the second is described here.

"Viable administrator" is 4D readiness's meaning, taken from 4D readiness's own
definition rather than paraphrased next to it — one shared SQL fragment, used by
readiness, by the pre-bootstrap guard, and by the postcondition:

- an active `User`,
- with a non-null credential,
- with an active `TenantMembership`,
- holding **effective** `settings.manage`,
- and holding **effective** `users.manage`.

Both permissions, effective through any role. This is deliberately **not**
4B-1's administrative authority, which is the single permission `users.manage`
(ADR-0019); the two are not equivalent and this ADR does not pretend they are.
Somebody who can add staff but cannot configure the shop cannot finish
onboarding, which is exactly what readiness measures — so closing bootstrap on
the weaker test would strand a merchant that readiness calls unadministrable with
no way left to bootstrap an Owner.

Sharing one definition matters in both directions. A bootstrap that closed on a
weaker test than readiness produces that stranded merchant; a bootstrap that
established less than readiness demands returns `204` for an Owner who cannot
run the shop. Two copies of the predicate would be two things that could drift
apart, and the drift is silent.

It is a set of permissions and not a role name, because Korvi's truth about
authority is a permission held through some role, and a role name would answer a
different question.

### Closure is permanent, and viability is not what closes it

Current viability and completed bootstrap are two different facts, and only one
of them can hold a door shut.

**Before** the first bootstrap, current viability is the right guard. A merchant
that acquired an administrator some other way — through 4B-1, a migration, a seed
— has never used this mechanism, and issuing there would mint a second authority
beside an existing one. That check stays.

**After** a successful bootstrap, current viability is the wrong guard, and using
it would be a security defect rather than a nicety. It goes false again the
moment the established Owner is deactivated, loses their membership, loses their
credential, or has the permissions stripped from their role. A bootstrap path
that reopens on that condition is an unauthenticated **Owner-recovery** flow that
nobody designed and no threat model covers, reachable by anyone still holding a
capability — precisely the thing this ADR puts out of scope.

So closure is decided on monotonic evidence: **any consumed invitation for the
tenant**, `consumedAt IS NOT NULL`. That column is written in exactly one place,
the consume step of a successful acceptance. Expiry does not write it, issuing
does not write it, no lifecycle change writes it. A consumed invitation is
therefore a fact history can only add to, which is what a permanent gate needs
and what a present-tense predicate can never be. No new state, no new column and
no new migration were required to express it.

The check is asked in the cheap preflight, so a permanently closed tenant costs
no key derivation to refuse, and again authoritatively under the tenant lock,
because the preflight decides nothing. The invitation being accepted is still
unconsumed at that point, so an acceptance never closes the door against itself;
it closes it on the way out, by consuming.

Once closed, a merchant that loses its administrator has a **recovery** problem,
not a bootstrap one. Recovery and owner transfer need their own authority, their
own threat model and their own decision record; they are not this one, and they
must not be reachable by omission.

After the first Owner, adding people is 4B-1's job and goes through an
authenticated administrator. Bootstrap is a bridge to the _first_ Owner, not a
permanent second front door and not a way back in.

### Credential-creation policy

New passwords are checked against a reusable credential-creation policy in
`@korvi/domain`, not a bootstrap-specific rule: the question "is this an
acceptable new password" will be the same question at a future staff invitation
and a future password change.

It is enforced **at the authority**, as step 1 of the acceptance pipeline, and
not only at the route in front of it. `acceptOwnerBootstrap` is exported, so a
policy applied only by the HTTP handler would be bypassed by any other caller —
an internal path, a future route, a test reaching past the API layer — and a
password rule that a caller can step around is a convention, not an invariant.
The route keeps its own check and its own `400 weak_password`, so the HTTP
response semantics are exactly as before; the authority simply no longer depends
on it. Because the check is first, a weak-password refusal costs no key
derivation, touches nothing, and can never mean "and your capability was good".

It is deliberately **not** applied at login. Login compares a presented secret
against a stored hash; running a strength check there would lock out every
account whose password predates the policy, which is a self-inflicted outage
rather than a security improvement. Strength is a question about a password being
set, and it is asked exactly there.

The policy judges the **NFKC** value, because that is the credential. Korvi's
`hashPassword` and `verifyPassword` both derive from `password.normalize('NFKC')`
(ADR-0012), so a rule applied to the raw input would be measuring a string no
stored hash corresponds to — and the gap is exploitable in both directions:
`a` alternating with fullwidth `ａ` looks like twelve code points of two distinct
characters and folds to one character repeated, while `e` followed by a combining
acute is two code points that compose to one, so a "twelve character" passphrase
can be six. Both pass a raw check and then collapse.

So the input is bounded, normalised, bounded again — NFKC can expand, and U+FDFA
is one code point that becomes eighteen — and every strength rule is evaluated
against the normalised value. The caller still hands the original string to
`hashPassword`, which normalises it identically; nothing here changes what is
stored or what login must reproduce.

### No session, and no lifecycle

Acceptance returns `204` and no cookie. Minting a session here would be a second
way to become authenticated, on the one route reachable without being
authenticated already; the new Owner signs in through the normal login path.

Bootstrap does not activate, suspend or reactivate a tenant, does not touch
commercial account state and does not grant entitlements. Creating an Owner does
**not** make a merchant ready to trade — readiness stays evidence-derived, and
gaining an administrator is one piece of evidence among several.

## Consequences

Acceptance serialises on the tenant row. It happens once per merchant, and the
alternative is two capabilities each creating an Owner.

An invitation is delivered by whatever the operator already uses. Korvi has no
mail transport and this strike does not add one, so "the operator sends the
capability" is an operational step rather than a product feature.

## Out of scope

Password recovery, password change, **owner recovery**, owner transfer, MFA, an
email delivery provider, and a generic staff-invitation system. Each is a
separate decision with its own threat model; none of them is reachable from this
code.

Owner recovery deserves naming rather than implying. A merchant that completes
bootstrap and later loses its administrator — deactivated, unmembered,
uncredentialed, stripped of permissions — is in a real situation that Korvi will
have to answer for. This strike does not answer it, and, more to the point, does
not answer it **by accident**: the bootstrap door stays shut on monotonic
evidence rather than reopening the moment viability lapses. An implicit recovery
flow would be an unauthenticated path to a merchant's highest authority, arrived
at without anyone having designed it.

Rate limiting is a **deployment hardening** item, not an unresolved product
risk: an unauthenticated caller cannot force a key derivation at all, because
nothing expensive runs before the capability has been verified and preflighted.
A per-IP or per-tenant limit in front of the API is still worth having, as it is
for any public endpoint, and it belongs with the deployment rather than in this
code.

This capability is **not** production ready until the human gate.
