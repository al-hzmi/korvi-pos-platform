# ADR-0007 — Runtime and framework versions

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0
- **Revision:** 3

## Context

The strategy document names Next.js 14. It was written earlier; this is a new
project and should start on current stable software. The standing instruction is
latest production-stable, no canary, beta, preview or RC, and nothing
incompatible with the rest of the toolchain.

Revision 2 added `scripts/verify-versions.mjs`, which asserts on every push that
each pin is published and production-stable. Revision 3 was made during the
Strike 5B validation gate after registry metadata moved several stable pins and
one package exposed a prerelease through its `latest` dist-tag. The policy is
production-stable, not blindly following a moving tag: when `latest` is not an
exact stable `x.y.z`, the verifier compares against the newest published stable
triplet instead. This prevents CI from ever requiring an RC/preview merely
because a publisher moved a tag.

## Decision

| Package      | Version | Note                                                      |
| ------------ | ------- | --------------------------------------------------------- |
| Node         | 24 LTS  | Active LTS ("Krypton")                                    |
| npm          | 11.17.0 | declared via `packageManager`                             |
| TypeScript   | 6.0.3   | **not 7.x** — see below                                   |
| Next.js      | 16.3.3  | newest production-stable at this revision                 |
| React        | 19.2.8  | production-stable                                         |
| Prisma       | 7.10.0  | production-stable; Prisma packages remain version-aligned |
| Tailwind CSS | 3.4.19  | **not 4.x** — see below                                   |
| Vitest       | 4.1.11  | production-stable                                         |
| Vite         | 8.2.2   | production-stable                                         |
| ESLint       | 10.9.1  | production-stable; typescript-eslint 8.68.0               |
| Fastify      | 5.12.1  | production-stable                                         |
| Zod          | 4.5.4   | production-stable                                         |
| Zustand      | 5.0.15  | production-stable                                         |

Three policy exceptions remain deliberate: TypeScript, Tailwind CSS and
`@types/node`. Every other pin must track the newest production-stable release
and prove compatibility through `npm run verify`.

### TypeScript 6.0.3, not 7.x

`typescript-eslint` declares TypeScript support below 6.1. TypeScript 7 falls
outside that range and would leave the monorepo unable to enforce its lint gate.
6.0.3 remains the highest stable release inside the supported range.

Revisit when typescript-eslint ships TypeScript 7 support.

### Tailwind CSS 3.4.19, not 4.x

`KORVI-DESIGN-SYSTEM.md` §10 ships a complete `tailwind.config.ts` in v3 format
and records that it was compiled and tested. ADR-0006 makes that document the
authority. Tailwind v4 is a design-system migration, not a patch-level toolchain
refresh. 3.4.19 remains on the official `v3-lts` line.

### `@types/node` tracks Node 24

Node typings intentionally track the Node 24 runtime. A newer major can describe
APIs the deployed runtime does not have, creating code that typechecks and then
fails at runtime.

## Production-stable selection rule

1. Every project pin is an exact `x.y.z` and must exist in the public npm registry.
2. A prerelease pin is forbidden.
3. If the registry's `latest` dist-tag is an exact stable `x.y.z`, it is the
   comparison target.
4. If `latest` points to an RC/preview/canary/other non-triplet version, the
   comparison target becomes the numerically newest published stable `x.y.z`.
5. Falling behind that production-stable target is a hard failure unless the
   package is explicitly justified by an accepted ADR in `ALLOWED_BEHIND`.

## Consequences

- A publisher cannot make Korvi chase a prerelease by repointing `latest`.
- Stable patch/minor drift still fails immediately and must be upgraded or
  explicitly justified by architecture.
- TypeScript, Tailwind and Node typings remain deliberate, reviewable exceptions.
- `npm run verify` remains the compatibility gate for lifting or changing pins.
