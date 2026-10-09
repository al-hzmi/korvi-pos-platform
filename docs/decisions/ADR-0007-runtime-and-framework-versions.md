# ADR-0007 — Runtime and framework versions

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0
- **Revision:** 4
- **Last reviewed:** 2026-09-09

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

Revision 4 records the 2026-09-09 stable refresh to React 19.3.0, React DOM
19.3.0, their 19.3.0 type packages and Zod 4.6.0. Compatibility was proved with
the full production verification gate before adoption. The first React 19.3
trial exposed duplicate React type identities because transitive dependencies
still resolved 19.2.x. Korvi therefore pins one React authority across the npm
dependency graph with root overrides for `react`, `react-dom`, `@types/react`
and `@types/react-dom`. This is not an exception to the latest-stable policy: it
prevents a mixed React runtime/type graph while keeping every resolved React
package on the same verified stable release.

## Decision

| Package      | Version | Note                                                      |
| ------------ | ------- | --------------------------------------------------------- |
| Node         | 24 LTS  | Active LTS ("Krypton")                                    |
| npm          | 11.19.0 | declared via `packageManager`                             |
| TypeScript   | 6.0.3   | **not 7.x** — see below                                   |
| Next.js      | 16.3.4  | production-stable                                         |
| React        | 19.3.0  | production-stable; dependency graph version-aligned       |
| Prisma       | 7.10.0  | production-stable; Prisma packages remain version-aligned |
| Tailwind CSS | 3.4.19  | **not 4.x** — see below                                   |
| Vitest       | 5.0.0   | production-stable                                         |
| Vite         | 8.2.2   | production-stable                                         |
| ESLint       | 10.10.0 | production-stable; typescript-eslint 8.70.0               |
| Fastify      | 5.12.3  | production-stable                                         |
| Zod          | 4.6.0   | production-stable                                         |
| Zustand      | 5.0.15  | production-stable                                         |

Three policy exceptions remain deliberate: TypeScript, Tailwind CSS and
`@types/node`. Every other pin must track the newest production-stable release
and prove compatibility through `npm run verify`.

### React dependency authority

React's runtime and public types participate in structural types that cross
workspace boundaries. Two installed `@types/react` versions can make identical
looking values such as `React.Ref<T>` unrelated to TypeScript. A mixed
`react-dom` graph can likewise make browser behavior depend on which package
resolved which copy.

Korvi therefore uses root npm overrides to keep `react`, `react-dom`,
`@types/react` and `@types/react-dom` on one exact, production-stable version
through the full dependency graph. Workspace manifests remain exact pins as
well. A React refresh is accepted only when all of the following are true:

1. `npm ls` contains no older React runtime or React type copy.
2. dependency pin verification and advisory audit pass.
3. production build and TypeScript checks pass.
4. the complete automated test suite passes.
5. browser regression evidence is obtained before operational promotion.

The override is dependency-graph authority, not permission to force an
incompatible release. If a transitive package becomes invalid under the target
React version, the upgrade is blocked until that dependency is compatible or a
separate accepted ADR justifies a hold.

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
- React runtime and type packages resolve as one version across the monorepo,
  preventing duplicate type identities and mixed runtime copies.
- TypeScript, Tailwind and Node typings remain deliberate, reviewable exceptions.
- `npm run verify` remains the compatibility gate for lifting or changing pins.
