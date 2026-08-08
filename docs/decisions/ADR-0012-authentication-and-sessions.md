# ADR-0012 — Authentication, sessions and persisted authorization

Status: accepted
Date: 2026-08-10
Supersedes: nothing. Extends ADR-0004 (multi-tenancy) and ADR-0001 (boundaries).

## Context

Strike 2A left the database able to keep two merchants apart and left the
application unable to say who anybody is. Everything above it — the cashier
screen, the sale path, the discount ceiling — is waiting on one question:
given a request, which tenant is this, which person is this, and what may they
do? Until that is answered on the server, every answer above it is a guess.

Four decisions carry the weight.

## Decision 1 — Tenant resolution runs under a SELECT-only RLS policy

Login begins with a slug the client typed. The tenant it names is the scope
that will govern everything afterwards, so it cannot itself be established by
that scope: `tenants` is under FORCE RLS keyed on `app.tenant_id`, and at the
moment of login there is no tenant id.

The three usual answers all trade a permanent hole for one lookup: disable RLS,
connect as a superuser, or grant BYPASSRLS. Each of them would mean the
application connection could read every tenant's rows for the rest of time,
because one request per session needs to read one row.

Instead there is a second policy on `tenants`:

```sql
CREATE POLICY "tenants_login_resolution" ON "tenants"
  FOR SELECT
  USING ("slug" = login_tenant_slug());
```

`login_tenant_slug()` reads `app.login_tenant_slug`, set with `SET LOCAL`
inside the resolving transaction — the same mechanism, and the same lifetime,
as the tenant context itself. Three properties make it narrow enough:

- **It cannot write.** `FOR SELECT` means PostgreSQL does not consult it for
  INSERT, UPDATE or DELETE at all. There is no version of this door that
  writes, and no WITH CHECK to get wrong, because the syntax forbids one.
- **It cannot list.** The predicate is an equality against a single setting,
  so it returns the one row whose slug was submitted or none.
- **It is inert by default.** The setting is unset on every ordinary request,
  so the added term is NULL and the isolation policy is the only one in play.

Everything else keys on `app.tenant_id`, which the resolver leaves empty — so
users, products and sessions are invisible from the login context. There is a
live test for each of those claims, including that the context can neither
insert, update, nor delete a tenant.

The resolver returns identity only: id, slug, name, status. Identification is
not authorization, and a caller holding the result still has no `TenantScope`.

## Decision 2 — scrypt from the Node standard library

Passwords are hashed with `crypto.scrypt` at N=2^16, r=8, p=2, 32-byte key,
16-byte random salt — the second configuration on OWASP's list, chosen over the
first (N=2^17, r=8, p=1) because 64 MiB per concurrent login rather than 128 MiB
matters on the single small server a shop of this size actually runs.

argon2id would be the textbook answer. It is a native module, which means a
compiler in every build image, a prebuilt binary to trust for every platform,
and a supply-chain surface on the authentication path — against ADR-0009, and
for a margin OWASP itself treats as equivalent. Node 24 ships scrypt; the
strike adds no dependency at all.

The encoding carries its own parameters:

```
scrypt$1$N=65536,r=8,p=2$<salt base64url>$<key base64url>
```

so the cost can be raised later without invalidating a single stored password,
and a hash lifted out of a backup can be identified without reference to the
code that wrote it. The parser refuses parameters below a floor: a tampered row
claiming N=2 would otherwise verify instantly and become a fast path into the
account.

Failure is uniform. Unknown tenant, unknown address, wrong password, inactive
user, suspended membership and a locked account all produce the same status and
the same body, and every one of them performs a real scrypt derivation first —
against the stored hash where there is one, against a per-profile dummy hash
where there is not. Without that, "no such user" returns in a millisecond and
"wrong password" in two hundred, and the difference enumerates the customer's
staff list.

Lockout is five consecutive failures for fifteen minutes. Enough for a cashier
mistyping on a greasy touchscreen, far too few for a password list. It is a
delay and not a disablement: an account that locks permanently turns a nuisance
into a denial-of-service against the till on the busiest afternoon of the week.

## Decision 3 — Opaque server-side sessions, hashed at rest

The browser holds `kps1.<tenant-uuid>.<43 base64url characters>` in an HttpOnly
cookie. The database holds SHA-256 of the whole token and nothing else, so a
stolen backup yields no usable credential — the same property the password
column has, for the same reason.

The tenant segment exists because RLS has to be established before the
`sessions` table can be read, and the session is what says which tenant. It is
a routing hint and is never authorization. Rewriting it fails twice over: the
hash covers the whole token, so an edited hint hashes to a value no row
carries; and the lookup runs inside the hinted tenant's own RLS context, so
another tenant's session is not visible to be found. Both are tested live.

No JWT. A signed token that carries roles is a decision cached in the attacker's
browser: revoking a session, deactivating a user or removing a permission would
not take effect until it expired. A row lookup costs one indexed query and makes
revocation immediate — which is what a POS needs when a cashier is dismissed
mid-shift.

`authVersion` is stamped on the session at creation and compared to the user's
on every request, so a future password reset invalidates every existing session
by incrementing one integer, with no session sweep and no change to this design.

The cookie is HttpOnly, SameSite=Lax, Path=/, with no Domain attribute, and
Secure with the `__Host-` prefix in production — a prefix the browser itself
enforces, so the guarantee survives a careless edit to the cookie builder.
Development drops the prefix because it requires HTTPS; nothing else changes.
The token never appears in a JSON body, in a log line, or in localStorage.

Cookie authentication needs a second lock against cross-site writes, so every
unsafe method is checked against an exact list of allowed origins, configured
per deployment and required in production — a server that has not been told its
origin refuses to boot rather than accepting writes from anywhere. Matching is
string equality: `https://pos.korvi.sa.evil.example` ends with the right
characters, and a suffix check is precisely how that becomes a valid origin.
`X-Forwarded-*` is ignored, because this server establishes no trusted-proxy
semantics and will not pretend to.

## Decision 4 — Authorization is read, never received

`UserRole → Role → RolePermission → Permission`, resolved from the database on
every authenticated request, into a principal the request cannot influence.
Nothing named `role`, `permissions`, `tenantId` or `discount` is read from a
body, a query string, a header or a browser store, anywhere in this layer.

The vocabulary is not reinvented. `@korvi/domain` already defines the seventeen
permissions, the four roles and the discount ceiling each carries; provisioning
copies those into the database and the request path reads them back. The
catalogue is typed `Record<Permission, …>`, so adding a permission to the domain
without describing it fails to compile, and a test asserts the reverse — a
second definition here is how a cashier ends up able to discount in the database
and unable to in the code.

A user may hold several roles. Permissions are unioned, because holding two
roles grants what either grants; the discount ceiling is the maximum, not the
sum, because two roles do not add up to more authority than either confers.

Audit records `auth.login.success`, `auth.login.failure`, `auth.logout` and
`auth.session.revoked`. No password, token, hash or cookie reaches the metadata;
a failed login is labelled with a correlation hash rather than the address it
was attempted against, so the table does not become a directory of who banks
here. The audit write happens outside the transaction that created the session
and its failure is logged rather than raised: the session already exists by
then, and failing the login would hand the user an error while leaving a live
session behind them.

## Decision 5 — The state transitions belong to PostgreSQL

Two of them, and both were originally written in application memory.

**The failure counter.** `count + 1`, computed in Node and written back as an
absolute value, loses increments: two wrong passwords arriving together read the
same number and the second overwrites the first, so a burst of concurrent
guessing registers as one failure. The transition is now a single
`UPDATE … RETURNING` carrying the whole rule, and PostgreSQL's row lock
serialises it. The same statement fixes a second bug the memory version had —
after a lock expired, the old count was still sitting at the threshold, so the
first typo afterwards re-locked the account instantly. Three arms:

- currently locked → the count moves, the deadline does not, because requests
  arriving during a lock must not extend it;
- lock expired → a new window opens at one, which is what "fifteen minutes"
  is supposed to mean;
- threshold crossed → the deadline is set by the statement that crosses it.

**Successful login.** Creating the session and clearing the failure state were
two round trips. A crash between them leaves a live session belonging to a user
the database still believes is locked out. They are now one transaction, with
the user update written first so that a failing session insert rolls it back.
Audit stays outside, best-effort, as above — the session exists by then and
failing the login would leave one behind an error message.

Tenant status joins the same principle. Login already refused a suspended
tenant; session verification did not, so a suspension took effect only when the
last cookie expired. It is now read from the tenants row on every request, under
that tenant's own RLS scope — never from the token, which was minted before the
suspension existed.

## Consequences

- One SELECT-only policy is the entire public surface of the tenants table
  before authentication, and it is testable in isolation.
- Passwords and session tokens are both useless at rest.
- Revocation, deactivation and permission changes take effect on the next
  request rather than at token expiry.
- No native dependency, and no new dependency of any kind.
- Suspending a tenant takes effect on the next request from every session it
  has, not at cookie expiry.
- The lockout counter is correct under concurrency, and a lock that expires
  genuinely restores a full attempt window.
- A login either produces a session and a cleared counter, or neither.
- Signup, password reset, MFA and invitations are deliberately absent. Each
  needs email delivery and a rate-limited public endpoint, which is a different
  strike with a different threat model.
- Rate limiting remains an explicit gate before public deployment. Lockout
  protects one account; it does nothing about a spray across many.
