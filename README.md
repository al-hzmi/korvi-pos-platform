# Korvi POS

نظام نقاط بيع للتجزئة والمطاعم — منتج مستقل، ورأس حربة معماري لمنظومة
Korvi ERP المستقبلية.

**الحالة: المرحلة صفر — الأساس.** لم تُبنَ شاشة الكاشير ولا المخزون ولا أي وحدة
تشغيلية بعد. راجع `docs/architecture/scope.md`.

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

| Path                | Contents                                          |
| ------------------- | ------------------------------------------------- |
| `packages/domain`   | Pure financial and compliance core — no framework |
| `packages/database` | Prisma schema and adapters for the domain's ports |
| `packages/printing` | ESC/POS construction for 80mm thermal printers    |
| `packages/ui`       | Design-system tokens and components               |
| `packages/config`   | Tailwind preset, shared with Korvi ERP            |
| `packages/testing`  | Determinism helpers                               |
| `apps/pos-web`      | Next.js PWA shell                                 |
| `apps/api`          | Fastify service                                   |
| `docs/`             | Architecture, ADRs, design system, governance     |

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
tenancy scoping, and the design rules — and most of them fail the build rather
than a review.

Decisions live in `docs/decisions/` as ADRs. Changing one means writing a new
ADR that supersedes it, not editing the old one.
