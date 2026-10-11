# Korvi POS

نظام نقاط بيع للتجزئة والمطاعم — منتج مستقل، ورأس حربة معماري لمنظومة
Korvi ERP المستقبلية.

## Current status

Korvi is no longer a Phase 0 shell. The repository now contains the cashier and
checkout path, authentication and SaaS administration, returns, shifts and cash
reconciliation, inventory, purchasing, receiving and costing authorities, plus
their control-centre UI.

The active execution boundary is **Stage 5D closure**. The four inventory and
purchasing UX slices are delivered, while actual end-to-end browser evidence,
required independent review and the Human Gate remain open.

The evidence-backed product progress denominator is maintained in
[`docs/governance/PRODUCT-READINESS-SCORECARD.md`](docs/governance/PRODUCT-READINESS-SCORECARD.md).
The current audited score is **74/100**. That number is implementation progress,
not permission to ship: ZATCA Phase 2, the promised offline-first path and
production/field release gates remain incomplete.

`docs/architecture/scope.md` is intentionally retained as a **historical Phase 0
snapshot** and must not be used as current product status.

## Requirements

- Node 24 LTS (see `.nvmrc`)
- npm
- PostgreSQL, for anything that touches the database

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill in DATABASE_URL
npm run db:generate
npm run verify
```

Run the apps:

```bash
npm run dev -w @korvi/pos-web   # http://localhost:3000
npm run dev -w @korvi/api       # http://localhost:3001/health
```

## Layout

| Path                | Contents                                                  |
| ------------------- | --------------------------------------------------------- |
| `packages/domain`   | Pure financial and compliance core — no framework         |
| `packages/database` | Prisma schema and adapters for the domain's ports         |
| `packages/printing` | ESC/POS construction for 80mm thermal printers            |
| `packages/ui`       | Design-system tokens and components                       |
| `packages/config`   | Shared configuration and Tailwind authority               |
| `packages/testing`  | Determinism helpers                                       |
| `apps/pos-web`      | Next.js cashier and merchant control-centre web app       |
| `apps/api`          | Fastify service and the server-owned business authorities |
| `docs/`             | Architecture, ADRs, design system and governance          |

## Commands

| Command               | Purpose                                          |
| --------------------- | ------------------------------------------------ |
| `npm run verify`      | Format, lint, invariants, typecheck, test, build |
| `npm run lint`        | ESLint                                           |
| `npm run typecheck`   | TypeScript, no emit                              |
| `npm test`            | Vitest                                           |
| `npm run build`       | Build every package and app, in dependency order |
| `npm run invariants`  | The mechanical scan on its own                   |
| `npm run db:generate` | Regenerate the Prisma client                     |

## Before changing anything

Read `CLAUDE.md`. It holds the invariants — integer money, domain purity,
tenancy scoping and the design rules — and most of them fail the build rather
than a review.

Decisions live in `docs/decisions/` as ADRs. Changing one means writing a new
ADR that supersedes it, not editing the old one. Current release progress must
be updated by closing named gates in the product readiness scorecard, never by
counting commits, tests or screens.
