# Agent instructions — Korvi POS

Applies to any automated contributor. Read `CLAUDE.md` first; it holds the
invariants. This file covers how to work in the repository.

## Orientation

    packages/domain     pure financial and compliance core — no framework
    packages/database   Prisma adapters implementing the domain's ports
    packages/printing   ESC/POS byte construction for 80mm thermal printers
    packages/ui         design-system components and tokens
    packages/config     the Tailwind preset, shared with Korvi ERP
    packages/testing    determinism helpers (controllable clock, seeded bytes)
    apps/pos-web        Next.js PWA shell
    apps/api            Fastify service
    docs/               architecture, ADRs, design system, governance

Dependency direction is one way:

    apps -> packages/{ui,database,printing} -> packages/domain

`@korvi/domain` depends on nothing. Never add an import that reverses an arrow.

## Rules that will fail the build

1. A float, a `parseFloat`, or a `Math.round` anywhere near money.
2. `any`, `as any`, or `@ts-ignore`.
3. A colour literal inside a component.
4. A physical direction utility (`ml-`, `pr-`, `left-`, `text-right`).
5. React, Prisma, Fastify, or `node:fs` imported into `packages/domain`.
6. A repository method that does not take a `TenantScope`.
7. A secret, token, or real connection string committed anywhere.

## Making a change

1. Read the relevant ADR in `docs/decisions/` before altering an invariant. If
   you are changing a decision, write a new ADR that supersedes it — do not edit
   the old one.
2. Put behaviour in `@korvi/domain` where it can be tested without a browser or
   a database.
3. Write the test with the behaviour, not after it. Financial rules need the
   adversarial case: the amount that does not divide, the tender that overpays
   on a card, the Arabic string whose byte length differs from its length.
4. Run `npm run verify`.
5. Do not commit or push unless you were asked to.

## Reference documents

`docs/design/KORVI-DESIGN-SYSTEM.md` and
`docs/governance/Korvi_POS_Master_Strategy_Document.txt` are inputs, not
working files. Do not edit them. If reality diverges from them, write an ADR
recording the divergence.

## Things that look like bugs and are not

- `--brand` is a different green from `--primary`. Deliberate: the mark ignores
  the theme because it also prints. See KORVI-DESIGN-SYSTEM.md §2.4.
- `border` and `input` hold the same value but are separate tokens, so touch
  targets can gain a heavier border without touching card borders.
- The domain re-implements Base64 instead of using `Buffer`. It must produce
  identical bytes in the browser, offline, and on the server.
