# ADR-0001 — Monorepo layout and domain boundaries

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

Korvi POS ships and sells on its own now. Korvi ERP is a stated future, and the
two are meant to share one financial core rather than drift into two systems
that disagree about a halala.

Korvi ERP does not exist. Building against it now would mean coupling to an
interface nobody has specified.

## Decision

A single npm-workspaces monorepo, with the shareable core isolated behind a
package boundary from the first commit:

    packages/domain     pure — no framework, no I/O
    packages/database   Prisma adapters for the domain's ports
    packages/printing   ESC/POS construction
    packages/ui         design-system components
    packages/config     Tailwind preset
    packages/testing    determinism helpers
    apps/pos-web        Next.js PWA
    apps/api            Fastify service

`@korvi/domain` may not import React, Next, Prisma, Fastify, or `node:fs`, and
may not touch the DOM. This is enforced by `no-restricted-imports` in
`eslint.config.js`, not by convention.

Where the domain needs data it declares a **port** — an interface in
`src/ports/` — and an adapter in `packages/database` implements it. Prisma types
never cross that line.

npm workspaces rather than pnpm: Codespaces has npm already, and one less tool
to install is one less way for the first run to fail. Revisit if install time
becomes a problem.

## Consequences

- The financial core can be lifted into Korvi ERP as a dependency with no
  rewrite, because it has no opinion about how it is hosted.
- Adding a port and an adapter is more work than calling Prisma directly. That
  cost is the point: it is what stops ORM shapes leaking into the UI.
- The build has an order (domain first, apps last), expressed in the root
  `build` script.
