# Historical Phase 0 scope snapshot

> **Historical document:** This records the original Phase 0 boundary. It is
> not the current product roadmap, and items listed as **Out** may now exist.
> For current implementation truth, inspect the repository and accepted ADRs;
> the active bounded task or strike defines the scope of current work.

## In

- Monorepo, build order, quality pipeline (lint, typecheck, test, build, format,
  invariant scan), CI.
- `@korvi/domain`: money, allocation, VAT, tender settlement, UUIDv7, ZATCA
  Phase 1 TLV, and the ports for persistence, search and offline.
- `@korvi/database`: minimal Prisma schema (three models) and adapters.
- `@korvi/printing`: ESC/POS construction and a receipt renderer.
- `@korvi/ui`: tokens, Tailwind preset, and the primitives that carry the design
  rules — `KorviMark`, `Numeric`, `BidiIsolate`, `Button`, `SquareAsset`,
  `CardSurface`.
- `apps/api`: Fastify with health and version routes.
- `apps/pos-web`: Next.js shell with a smoke page proving the wiring.
- Governance: `CLAUDE.md`, `AGENTS.md`, ADRs 0001–0007.

## Out — deliberately

Not built in Phase 0, and not to be added without moving to Phase 1:

- The cashier screen, cart, and checkout flow
- Inventory
- Restaurant modifiers
- The B2B supply hub and MOQ firewall
- The owner dashboard
- ZATCA Phase 2 signing (hash, cryptographic stamp, CSID)
- The offline sync engine (boundaries only — ADR-0005)
- Liquid Search implementation (boundary only)
- The commission engine
- KDS and kiosk

## What "foundation" means here

Every invariant that would be expensive to retrofit is in place and enforced:
integer money, tenancy scoping, injected time and entropy, domain purity,
design tokens, RTL. Everything else is deferred.
