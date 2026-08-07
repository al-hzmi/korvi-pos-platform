# ADR-0003 — UUIDv7 for identifiers

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

A terminal must keep selling with no network. It therefore has to mint its own
identifiers, and the server has to replay them later in the order the sales
actually happened.

A database sequence cannot do that — it needs the database. A UUIDv4 cannot do
it either: it carries no time, so a queue drained out of order is
indistinguishable from one drained in order.

## Decision

UUIDv7 everywhere, generated through `createUuidV7Generator` in
`packages/domain/src/ids/uuidv7.ts`.

v7 places a 48-bit millisecond timestamp in the high bits, so identifiers sort
into creation order as plain strings — no parsing, no companion column.

Four details that matter, three of them added in revision 2 after the first
implementation was found able to break the very ordering it exists to provide:

- **A 42-bit counter**, spanning `rand_a` and the top of `rand_b`. Revision 1
  used 12 bits and wrapped silently at 4096 ids in one millisecond, emitting an
  id that sorted _before_ its predecessor.
- **Borrowing, not wrapping.** On exhaustion the generator takes a millisecond
  from the future rather than restarting the counter.
- **A rollback floor.** The last-issued timestamp is a floor, so an NTP
  correction or a merchant fixing the till clock cannot produce ids below ones
  already written. Past a bounded drift the generator refuses outright — a hard
  failure is recoverable, a silently wrong chronology is not.
- **Clock and entropy are injected.** `Clock` and `RandomSource` are interfaces.
  `@korvi/testing` supplies controllable versions, so ordering is asserted
  directly instead of by sleeping and hoping.

Every identifier comes from this generator, including infrastructure ids such
as HTTP correlation ids. `crypto.randomUUID` returns a v4, which carries no time
and cannot be ordered against a sale that synced late.

## Consequences

- Sale ordering survives an offline period of any length.
- The timestamp is readable from the id (`timestampOfUuidV7`), which is useful
  for audit and mildly information-disclosing — acceptable for internal ids.
- The generator holds mutable state (last timestamp, counter). It is a
  singleton per process by design; tests construct their own.
