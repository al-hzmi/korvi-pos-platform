# ADR-0009 — Supply chain and CI posture

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0
- **Revision:** 2

## Context

Phase 0 revision 1 set `audit=false` in `.npmrc`, let CI fall back from
`npm ci` to `npm install`, referenced GitHub Actions by moving tag, and granted
the workflow default token permissions. Each is a small convenience with a
disproportionate blast radius for a product that handles payments.

Revision 2 records the response to GHSA-ggr8-5vv4-36mx discovered during the
Strike 5B validation gate. Prisma 7.10.0's `@prisma/config` still pins
`deepmerge-ts` 7.1.5, while the advisory affects versions below 8.0.0 and the
current production-stable patched release is 8.0.2. The vulnerability is not
waived: the root lockfile overrides that transitive dependency to 8.0.2 and the
normal build, migration, type, test and audit gates must prove compatibility.

## Decision

**Audit stays on.** `audit=false` disables the check for everyone permanently to
silence something temporary. Advisory noise is handled by
`scripts/audit-allowlist.txt` — dated entries with a reason and a reviewer, so
an exception expires rather than rots. Empty is the preferred state.

**Fix before exception.** When an advisory has a published patched transitive
version but an upstream package still pins the vulnerable version, a narrowly
scoped exact root `overrides` entry is preferred over an audit exception only if
all compatibility gates stay green. An override is temporary architecture debt,
not a silent bypass: it must name the advisory here and is removed when upstream
accepts the patched range.

Current reviewed override:

| Package | Forced version | Advisory | Upstream reason | Removal condition |
| ------- | -------------- | -------- | --------------- | ----------------- |
| `deepmerge-ts` | 8.0.2 | GHSA-ggr8-5vv4-36mx | `@prisma/config@7.10.0` pins 7.1.5 | remove when Prisma's config dependency accepts a patched 8.x release and audit remains green without the override |

**`npm ci`, never a fallback.** `npm ci || npm install` looks defensive and is
the opposite: when the lockfile is missing or stale the fallback resolves fresh
versions, so CI stops testing the tree that will ship. A missing or stale
lockfile must fail the build.

**Exact production-stable versions.** `save-exact=true`, and
`scripts/verify-versions.mjs` asserts on every push that direct pins and root
overrides are published exact stable releases. ADR-0007 defines how the newest
production-stable target is selected. Unjustified stable drift is a hard failure.

**Actions pinned to commit SHAs.** A tag can be repointed at any time by whoever
controls the action's repository, so `@v5` is a trust decision renewed on every
run. The tag is kept in a trailing comment for readability.

**`permissions: contents: read` at workflow level.** A job needing more raises
it locally, so the extra permission appears in the diff that adds it. Temporary
validation automation may request `contents: write` only on an isolated review
branch when it must materialize a reviewed lockfile; that workflow is removed
before the production branch is finalized.

**`packageManager` is declared** so Corepack resolves the same npm everywhere.

**Dependabot weekly**, patches and minors grouped into one PR, majors separate.
TypeScript and Tailwind majors are ignored because ADR-0007 pins them; that pin
is revisited by editing the ADR, not by merging a bot PR.

## Consequences

- CI performs version verification and a security audit before build/test work.
- A genuine unreviewed advisory blocks the build.
- A security override is allowed only as an exact, documented, test-proven
  remediation when the patched transitive exists but upstream has not moved yet.
- No audit threshold is lowered and no advisory is hidden merely to make CI pass.
- SHA pins need periodic refreshing; Dependabot handles action updates.
