# Offline — implementation boundary

ADR-0005 defines the offline-first architecture. Gate 41 is now implemented and proven; Gates 42–45 remain open and must preserve the same authority and ordering guarantees.

## The guarantee we are building toward

A terminal keeps selling with no network, for as long as the outage lasts, and reconciles afterwards with nothing lost and nothing reordered.

Gate 41 deliberately closes only the application-shell prerequisite. It does not claim offline catalogue authority, local sale durability, queued financial mutation authority, synchronization or reconciliation.

## Pieces, and where they live

- **Service Worker** — app shell available with no network — Gate 41 CLOSED.
- **IndexedDB** — local store for sales and the catalogue — Gate 42 OPEN.
- **Transaction queue** — ordered record of what must reach the server — Gate 43 OPEN; port only.
- **Sync engine** — drains the queue and handles rejection — Gate 44 OPEN; port only.
- **Conflict handling** — resolves divergence found on sync — Gate 45 OPEN; policy/proof pending.

## Gate 41 implementation boundary

The production POS registers a same-origin Service Worker from `/sw.js`. The worker is an availability mechanism only; it does not become a financial, identity, inventory or authorization authority.

The cached application shell is published atomically. A candidate snapshot gets its own content-derived cache, all referenced Next.js and brand assets are fetched first, and a completion marker is written before the active-cache pointer changes. The immediately previous complete snapshot is retained so an already-open cashier tab and a newly deployed shell can coexist safely while hashed assets roll over.

Only the root cashier navigation and same-origin `/_next/static/` / `/brand/` assets are intercepted. `/v1/*` API traffic and non-GET requests are never satisfied from CacheStorage. An unavailable authenticated API therefore remains unavailable rather than being replaced by stale authority data.

Exact implementation evidence on `1d5e36b3aed0590ad29e1e2422adda4e0e10b053`:

- full CI run `34660345695`: dependency pins, audit, formatting, lint, invariants, production build, typecheck and tests all green;
- actual Chrome hard-outage run `34660345691`: production web process group was terminated, browser HTTP cache disabled, root document and 21 Next static responses were served by the Service Worker, and `/v1/auth/me` still failed instead of being served from offline cache;
- proof artifact `10286767699`, SHA-256 `d55bdd5f6c52bbdff8fad13b114f3b2f29beb9ffa09f020a44eb9fda6f801b6b`;
- the artifact contains the online and hard-outage screenshots plus a sanitized proof log; no `/v1/` response was present in CacheStorage.

## Why ordering is already solved at the domain boundary

Every queued operation is keyed by UUIDv7, so the identifier carries its own creation time and the queue drains oldest-first by sorting on the key. No sequence, no server round trip, no separate ordering column (ADR-0003).

That ordering contract is not yet a claim that a durable browser queue exists; Gate 43 remains open until IndexedDB-backed persistence and restart/outage proof exist.

## Retry

`RetryPolicy` is a value, not scattered `setTimeout` calls: five minutes initially, doubling to a six-hour ceiling, at most eight attempts. Rejections are recorded rather than dropped, so a sale can be inspected rather than silently lost.

## Next real blocker

Gate 42 must implement a versioned IndexedDB/local durable store for the exact catalogue and sale state required by the cashier. It must define schema upgrade, transaction, quota/failure and corruption boundaries before Gate 43 is allowed to put ordered financial operations on top of it.

Conflict resolution policy per entity type remains intentionally open for Gate 45. `ConflictResolution` names the three outcomes (`keep-local`, `keep-remote`, `needs-review`); the policy must be proven against the concrete synchronized entities rather than guessed in advance.
