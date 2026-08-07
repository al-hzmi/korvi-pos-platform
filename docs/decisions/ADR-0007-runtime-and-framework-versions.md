# ADR-0007 — Runtime and framework versions

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0
- **Revision:** 2

## Context

The strategy document names Next.js 14. It was written earlier; this is a new
project and should start on current stable software. The standing instruction is
latest production-stable, no canary, beta, preview or RC, and nothing
incompatible with the rest of the toolchain.

Revision 1 chose versions from a single `npm view` per package. Revision 2 adds
`scripts/verify-versions.mjs`, which asserts on every push that each pin is
published, is not a prerelease string, and is not carried only by a prerelease
dist-tag — so a pin cannot drift onto a preview unnoticed.

## Decision

| Package      | Version | Note                                               |
| ------------ | ------- | -------------------------------------------------- |
| Node         | 24 LTS  | Active LTS ("Krypton")                             |
| npm          | 11.17.0 | declared via `packageManager`                      |
| TypeScript   | 6.0.3   | **not 7.x** — see below                            |
| Next.js      | 16.2.12 | **not 16.3.0** — see below                         |
| React        | 19.2.8  | `latest`                                           |
| Prisma       | 7.9.1   | `latest`                                           |
| Tailwind CSS | 3.4.19  | **not 4.x** — see below                            |
| Vitest       | 4.1.10  | `latest`                                           |
| Vite         | 8.2.1   | `latest`                                           |
| ESLint       | 10.8.1  | `latest`, with typescript-eslint 8.66.0 (`latest`) |
| Fastify      | 5.11.2  | `latest`                                           |
| Zod          | 4.4.3   | `latest`                                           |
| Zustand      | 5.0.14  | `latest`                                           |

Three pins are not the newest `latest`. All three are stable releases on
maintained lines; none is a prerelease channel.

### TypeScript 6.0.3, not 7.0.2

`typescript-eslint@8.66.0` declares `typescript: ">=4.8.4 <6.1.0"`. TypeScript 7
falls outside that range and would leave the monorepo unlintable. Lint is a
Phase 0 gate, and a foundation that cannot enforce its own rules is not a
foundation. 6.0.3 is the highest stable release inside the supported range.

Revisit when typescript-eslint ships TypeScript 7 support.

### Tailwind CSS 3.4.19, not 4.3.3

`KORVI-DESIGN-SYSTEM.md` §10 ships a complete `tailwind.config.ts` in v3 format
and records that it was compiled and tested. ADR-0006 makes that document the
authority.

Tailwind v4 replaces the JavaScript config with CSS-first `@theme` declarations.
That is a design-system revision, not a config rewrite, and it should be agreed
with whoever maintains Korvi ERP so the two products do not diverge.

Supporting evidence: 3.4.19 carries the **`v3-lts`** dist-tag, so this is an
officially maintained line rather than an abandoned major.

### Next.js 16.2.12, not 16.3.0

Pinned to the 16.2 line at the architect's direction.

Recording what the registry actually reports, because the reasoning given was
that 16.3 is a preview build and that is not what the dist-tags show:

```
next dist-tags:  latest  = 16.3.0
                 preview = 16.3.0-preview.10
                 canary  = 16.3.1-canary.7
                 beta    = 16.0.0-beta.0
```

`16.3.0` is the `latest` stable release. `16.3.0-preview.10` is a separate
prerelease version that happens to share the `16.3.0` prefix; the two are
different artifacts.

The pin is nonetheless applied as directed. 16.2.12 is the newest stable release
on the 16.2 line, it is not a prerelease, and staying a minor behind costs
nothing here — Phase 0 uses no 16.3-only feature. Recorded rather than argued
so that whoever revisits this has the evidence rather than the conclusion.

## Consequences

- Every pin is machine-verified on each push; a prerelease cannot slip in.
- All three departures are on maintained stable lines, not dead ends.
- Dependabot ignores TypeScript and Tailwind majors, because bumping them is a
  decision recorded here rather than a PR to merge.
- `npm run verify` is the check that any pin can be lifted: if it stays green
  after a bump, the pin can go.
