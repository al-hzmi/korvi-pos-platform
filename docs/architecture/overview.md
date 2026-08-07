# Architecture overview

## Shape

    apps/pos-web  ──┐
                    ├──> packages/ui ──────┐
    apps/api ───────┤                      ├──> (tokens, components)
                    ├──> packages/database ──> packages/domain
                    └──> packages/printing ──> packages/domain

`@korvi/domain` sits at the bottom and depends on nothing. Every arrow points
toward it; none point away. That is what makes it liftable into Korvi ERP later
(ADR-0001).

## Layers

| Layer      | Holds                               | Never holds                            |
| ---------- | ----------------------------------- | -------------------------------------- |
| `domain`   | money, tax, tender, ids, TLV, ports | React, Prisma, HTTP, `fs`, DOM         |
| `database` | Prisma schema and adapters          | business rules                         |
| `printing` | ESC/POS bytes                       | transport, device handles              |
| `ui`       | components and tokens               | business rules, colour literals        |
| `apps`     | composition, routing, HTTP          | anything worth unit-testing on its own |

## Why ports

The domain declares interfaces (`src/ports/`); adapters implement them. A
repository returns domain types, never Prisma rows, so the ORM stays replaceable
and the UI never learns what persistence looks like.

It costs an interface and a mapping function per repository. It buys a core that
can be tested with no database and shared with a product that does not exist
yet.

## Direction and language

RTL is the default (`<html dir="rtl">`), not a later addition. Logical
properties only. Latin runs inside Arabic go through `BidiIsolate`, because the
bidi algorithm will otherwise reorder `INV-2026-00001` into a document number
that does not exist.
