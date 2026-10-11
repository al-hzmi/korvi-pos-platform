# ADR-0026 — Toolchain Refresh and MySQL2 Remediation

- **Status:** Accepted
- **Date:** 2026-09-07
- **Scope:** Stage 5 validation dependencies; no financial or schema change

Supersedes only the affected version snapshot entries in ADR-0007. Supplements
the override register in ADR-0009; its supply-chain and fail-closed policies
remain unchanged.

## Context

Validation of the Stage 5 cost HTTP contract reached two independent blockers:
eight direct pins fell behind the newest production-stable releases, and the
audit found two advisories in `mysql2@3.15.3`, pinned by `prisma@7.10.0`.
Korvi's schema and application adapter use PostgreSQL, not MySQL. That limits
the relevant application path but does not justify retaining a flagged package
or waiving the advisory gate.

The npm audit suggestion to downgrade Prisma to 6.19.3 would change the ORM
major and break the aligned Prisma 7 stack. The publisher's `latest` Prisma tag
currently points to an 8.0.0 release candidate, which ADR-0007 forbids. Neither
is an appropriate solution to this transitive dependency problem.

## Decision

Use these exact published stable versions, subject to the unchanged verification
gates:

| Package                       | Previous | Selected |
| ----------------------------- | -------- | -------- |
| `@types/react-dom`            | 19.2.5   | 19.2.7   |
| `@vitest/coverage-v8`         | 4.1.11   | 5.0.0    |
| `autoprefixer`                | 10.5.4   | 10.5.5   |
| `eslint`                      | 10.9.1   | 10.10.0  |
| `fastify`                     | 5.12.1   | 5.12.3   |
| `globals`                     | 17.11.0  | 17.12.0  |
| `postcss`                     | 8.5.26   | 8.5.28   |
| `vitest`                      | 4.1.11   | 5.0.0    |
| `mysql2` (inside Prisma only) | 3.15.3   | 3.24.3   |

Keep `prisma`, `@prisma/client` and `@prisma/adapter-pg` aligned at 7.10.0.
Set the package-specific root override `mysql2: 3.24.3`, preserving
the existing `deepmerge-ts` override. MySQL2 enters the current tree only through
Prisma. Do not introduce MySQL to application
code, disable audit, lower its threshold, or add an advisory exception.

A nested `prisma -> mysql2` override was tried first, but npm 11.9.0 and the
declared npm 11.17.0 both retained 3.15.3 in this existing workspace lockfile.
The lockfile regression test and audit correctly rejected that unresolved
state. The package-specific override must be proven against every locked copy
and a clean installation; editing the manifest alone is not evidence of a fix.
Regenerating the lock while the old installed tree remained also retained the
old version. Resolution from an empty installed tree and absent lock produced
3.24.3; the previous lock and installed files were kept outside the repository
as a recovery copy. Subsequent `npm ci` must reproduce that corrected lock.

One diagnostic remains explicit: `npm ls mysql2 --all` reports `ELSPROBLEMS`
against Prisma's original exact 3.15.3 requirement, even with the root override
and installed 3.24.3. Do not record that command as passing. The deliberate
override replaces precisely that upstream pin; the regression checks both
every lockfile copy and its installed package metadata. Compatibility still
requires clean `npm ci`, audit, generation/build and PostgreSQL proof, not
editing vendor metadata or suppressing the diagnostic.

The reviewed advisory database identifies `GHSA-3f6p-5ww8-9rcr` as affecting
MySQL2 below 3.22.0, and `GHSA-rgwj-5xj2-c3m3` as affecting versions through
3.23.0. The selected stable 3.24.3 is outside both ranges. This is a remediation
of those identified ranges, not a claim that dependency audits prove all code
secure.

Remove the MySQL2 override when the supported production-stable Prisma version
accepts a patched MySQL2 version without it, after checking every installed
copy and repeating audit, generation, build, types, tests and PostgreSQL proof.

## Vitest 5 compatibility

Node 24 and Vite 8.2.2 satisfy Vitest 5's published runtime and peer ranges.
Keep the runner and V8 coverage provider version-aligned. Review the official
migration guide, including mock-history clearing, awaited asynchronous
assertions, hoisting restrictions, test discovery, coverage matching, and
report paths. Do not loosen assertions or skip tests to obtain a pass.

Generated Vitest artifacts belong under the ignored `.vitest/` directory.
Existing source and live-test discovery patterns remain unchanged. Validate
both ordinary execution and the V8 coverage provider. Browser interaction and
PostgreSQL evidence remain separate gates; neither is implied by a unit pass.

## Verification and release boundary

Regenerate the lockfile using npm, prove a fresh `npm ci`, and run the unchanged
`npm run verify`. The exact delivered commit must also pass CI and the existing
PostgreSQL 17 workflow, including all twelve migrations, no drift, non-bypass
application role and all discovered live tests. No progress increase, PR merge,
or Human Gate approval follows merely from this dependency refresh.

## Sources

- [Vitest 5 migration guide](https://vitest.dev/guide/migration/)
- [MySQL2 authentication advisory](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr)
- [MySQL2 decompression advisory](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3)
- Public npm metadata for the exact selected versions and Prisma 7.10.0,
  checked on 2026-09-07; registry-backed pin and advisory gates remain mandatory.
