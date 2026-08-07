# ADR-0010 — What changed in Phase 0 revision 2

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

Revision 1 passed its own quality gate and was still rejected in architecture
review. The gate was real — 81 tests, lint, typecheck, a genuine Next build —
but it verified the things the code claimed about itself, and several claims
were wrong. This ADR records the corrections so the reasoning is not lost.

## Corrections

### UUIDv7 ordering (supersedes part of ADR-0003)

Revision 1 used a 12-bit counter that wrapped silently at 4096 identifiers in
one millisecond, emitting an id that sorted _before_ its predecessor — an
inverted sale order, undetectable after the fact. It also ignored clock
rollback, so an NTP correction produced ids below ones already written.

Now: a 42-bit counter, borrowing a future millisecond instead of wrapping, and a
last-issued floor that survives a backwards clock. Both bounded by a drift
tolerance beyond which the generator refuses rather than inventing a timestamp.
Tested at 20,000 ids inside one frozen millisecond and across a five-second
rollback.

The counter width is injectable so the borrow path is actually exercised; at the
production width it needs ~2^41 calls, which no test can reach.

### Identifier discipline

`crypto.randomUUID()` in the Fastify request-id hook was a v4 — no embedded
time, so a request log line could not be ordered against a sale that synced
late. It now uses the central generator.

### Thermal printing — see ADR-0008

The UTF-8-to-a-code-page bug, missing shaping and bidi, and a receipt that
never emitted a QR.

### Basis points

The domain spoke `bigint` while the ports and the database column spoke
`number`, with conversion implicit at each crossing. Now one branded,
range-validated `BasisPoints` type with explicit column boundary functions, and
a `CHECK` constraint enforcing the same range in Postgres.

### Row-level security — see ADR-0004 (extended)

`WHERE tenantId = ?` protects only the queries that remember it. RLS with
`FORCE`, deny-by-default policies carrying both `USING` and `WITH CHECK`, and
tenant context via `SET LOCAL` inside a transaction.

### Supply chain — see ADR-0009

### Toolchain

Node 24 LTS. Next pinned to the 16.2 line. Every pin machine-verified against
the registry.

## What did not change

Money as integer minor units, largest-remainder allocation, cash-only change,
domain purity, the design system transcription, and the ZATCA Phase 1 scope
boundary. Those were right in revision 1 and are unchanged in revision 2.

## Consequence

The quality gate now includes checks that would have caught these: byte-level
printing fixtures, adversarial UUIDv7 ordering tests, static RLS policy
coverage, and registry verification of every pin. A gate that only confirms what
the code says about itself is not a gate.
