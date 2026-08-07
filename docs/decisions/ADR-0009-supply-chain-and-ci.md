# ADR-0009 — Supply chain and CI posture

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

Phase 0 revision 1 set `audit=false` in `.npmrc`, let CI fall back from
`npm ci` to `npm install`, referenced GitHub Actions by moving tag, and granted
the workflow default token permissions. Each is a small convenience with a
disproportionate blast radius for a product that handles payments.

## Decision

**Audit stays on.** `audit=false` disables the check for everyone permanently to
silence something temporary. Advisory noise is handled by
`scripts/audit-allowlist.txt` — dated entries with a reason and a reviewer, so
an exception expires rather than rots. Empty is the correct state.

**`npm ci`, never a fallback.** `npm ci || npm install` looks defensive and is
the opposite: when the lockfile is missing or stale the fallback resolves fresh
versions, so CI stops testing the tree that will ship. A missing lockfile should
fail the build.

**Exact versions.** `save-exact=true`, and `scripts/verify-versions.mjs` asserts
on every push that each pin is published, is not a prerelease string, and is not
carried only by a prerelease dist-tag. Departures from `latest` are listed with
the ADR that justifies them; anything else lagging is reported, not failed.

**Actions pinned to commit SHAs.** A tag can be repointed at any time by whoever
controls the action's repository, so `@v5` is a trust decision renewed on every
run. The tag is kept in a trailing comment for readability.

**`permissions: contents: read` at workflow level.** A job needing more raises
it locally, so the extra permission appears in the diff that adds it.

**`packageManager` is declared** so Corepack resolves the same npm everywhere.

**Dependabot weekly**, patches and minors grouped into one PR, majors separate.
TypeScript and Tailwind majors are ignored because ADR-0007 pins them; that pin
is revisited by editing the ADR, not by merging a bot PR.

## Consequences

- CI does more work per run: version verification and an audit before anything
  builds. Both are seconds, and both fail early.
- A genuine advisory blocks the build. That is the intent; the allowlist is the
  escape hatch and it requires writing down a reason.
- SHA pins need periodic refreshing. Dependabot's github-actions ecosystem does
  it and keeps the tag comment in step.
