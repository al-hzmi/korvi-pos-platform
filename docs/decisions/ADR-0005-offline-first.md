# ADR-0005 — Offline-first boundaries

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0 (boundaries only)

## Context

A till that stops when the connection does is a till that stops. The product
promise is that a terminal keeps selling through an outage and reconciles
afterwards without losing or reordering anything.

Offline cannot be retrofitted. A sale path written against a live server
acquires assumptions — an id from the database, a total from an endpoint,
validation that happens elsewhere — and unpicking them later is where ordering
guarantees get lost.

## Decision

Phase 0 declares the boundaries and implements none of the machinery.

`packages/domain/src/ports/offline.ts` defines:

- `QueuedOperation` — keyed by UUIDv7, so the id _is_ the ordering key.
- `TransactionQueuePort` — enqueue, read pending oldest-first, mark settled or
  rejected.
- `RetryPolicy` and `nextRetryDelayMs` — exponential backoff from five minutes
  to a six-hour ceiling, as a value rather than a caller's `setTimeout`.
- `SyncEnginePort` and `ConflictResolution`.

Not implemented in Phase 0: IndexedDB persistence, the Service Worker, the sync
loop, conflict resolution. Those are Phase 1+.

The point of writing the interfaces now is that Phase 1's sale path is written
against a queue from its first line.

## Consequences

- Some interfaces have no implementation for a while. Deliberate.
- The shapes will be adjusted once measured against a real device; they are a
  starting contract, not a frozen one.
- `RetryPolicy` starting at five minutes is chosen so a rejected invoice does
  not hammer the Authority's endpoint.
