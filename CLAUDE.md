# Korvi POS — working agreement

Read this before changing anything. The rules below are not style preferences;
each one has a failure behind it, and most are enforced mechanically by
`npm run verify`.

## What this repository is

Korvi POS: a point-of-sale system for retail and restaurants, sellable and
operable on its own today. It is also the architectural spearhead for a future
Korvi ERP, which is why the financial core is isolated in `@korvi/domain` — that
package is meant to be shared with ERP later without a rewrite.

Korvi ERP does not exist yet. Do not add a dependency on it, and do not build
ERP features here.

## Non-negotiable invariants

### Money

- Money is **integer minor units** (halalas) in a `bigint`. No `number`, no
  `float`, no `Decimal` library.
- Never `parseFloat`, never `Math.round` on an amount. Use `mulDivRound`.
- Rates are **basis points** as `bigint`. 15% is `1500n`, never `0.15`.
- Across a JSON boundary, minor units travel as a **string**. `JSON.stringify`
  throws on `bigint`, and a `number` silently loses precision past 2^53.
- `allocate` must satisfy `sum(parts) === total` for every input. Splitting uses
  deterministic largest-remainder with index tie-breaking.
- Change comes from **cash only**. Non-cash tenders may not exceed the amount
  due — a card terminal cannot hand money back.

### Domain purity

`@korvi/domain` must not import React, Next, Prisma, Fastify, or Node's
filesystem, and must not touch `window` or `document`. ESLint enforces this. If
the domain needs data, it declares a **port** and an adapter implements it.

### Identifiers

UUIDv7 through the abstraction in `ids/uuidv7.ts`. Never `Math.random`, never a
database sequence for anything a terminal can mint offline. The id carries the
timestamp, which is what preserves ordering across a sync.

### Multi-tenancy

Every tenant-owned row carries `tenantId` and indexes it first. Every repository
method takes a `TenantScope`. `GlobalCatalogItem` is the single documented
exception — see ADR-0004 before adding another.

### Design system

`docs/design/KORVI-DESIGN-SYSTEM.md` is the authority. In particular:

- No colour literal in any component. Tokens only.
- Logical properties only: `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`,
  `text-start`/`text-end`. Never `ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`.
- Touch targets ≥ 44px (`h-touch`), 48px (`h-touch-lg`) for payment and keypad.
- Every image, avatar and logo is 1:1 with `object-cover` and `shrink-0`.
- Every financial figure renders through `Numeric`.
- Every Latin run inside Arabic renders through `BidiIsolate`.
- A submitting button stays disabled while loading.

### TypeScript

`strict`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
No `any`, no `as any`, no `@ts-ignore`. `@ts-expect-error` requires a written
justification on the same line.

## Before you push

    npm run verify

That runs formatting, lint, the invariant scan, typecheck, tests, and build.
All six must pass.

## Scope discipline

This repository is at **Phase 0 — Foundation**. Do not build the cashier screen,
inventory, restaurant modifiers, the B2B hub, the owner dashboard, ZATCA Phase 2
signing, the commission engine, KDS, or kiosk. See `docs/architecture/scope.md`.
