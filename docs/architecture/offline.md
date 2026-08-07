# Offline — boundary

Declared in Phase 0, implemented later. See ADR-0005.

## The guarantee we are building toward

A terminal keeps selling with no network, for as long as the outage lasts, and
reconciles afterwards with nothing lost and nothing reordered.

## Pieces, and where they will live

| Piece             | Role                                         | Status    |
| ----------------- | -------------------------------------------- | --------- |
| Service Worker    | app shell available with no network          | Phase 1   |
| IndexedDB         | local store for sales and the catalogue      | Phase 1   |
| Transaction queue | ordered record of what must reach the server | port only |
| Sync engine       | drains the queue, handles rejection          | port only |
| Conflict handling | resolves divergence found on sync            | port only |

## Why ordering is already solved

Every queued operation is keyed by UUIDv7, so the identifier carries its own
creation time and the queue drains oldest-first by sorting on the key. No
sequence, no server round trip, no separate ordering column (ADR-0003).

## Retry

`RetryPolicy` is a value, not scattered `setTimeout` calls: five minutes
initially, doubling to a six-hour ceiling, at most eight attempts. Rejections
are recorded rather than dropped, so a sale can be inspected rather than
silently lost.

## Not yet decided

Conflict resolution policy per entity type. `ConflictResolution` names the three
outcomes (`keep-local`, `keep-remote`, `needs-review`); which applies to which
entity needs the entities to exist first.
