# Offline — implementation boundary

ADR-0005 defines the offline-first architecture. Gates 41–42 are now implemented and proven; Gates 43–45 remain open and must preserve the same authority, ordering and reconciliation guarantees.

## The guarantee we are building toward

A terminal keeps selling with no network, for as long as the outage lasts, and reconciles afterwards with nothing lost and nothing reordered.

Gates 41–42 establish the browser availability and durable-local-state prerequisites. They do **not** claim that a financial sale can already be finalized offline: persistent financial operations, replay, sync and conflict reconciliation belong to Gates 43–45.

## Pieces, and where they live

- **Service Worker** — app shell available with no network — Gate 41 CLOSED.
- **IndexedDB** — versioned durable store for cashier catalogue snapshots and in-progress sale state — Gate 42 CLOSED.
- **Transaction queue** — ordered record of what must reach the server — Gate 43 OPEN; port only.
- **Sync engine** — drains the queue and handles rejection — Gate 44 OPEN; port only.
- **Conflict handling** — resolves divergence found on sync — Gate 45 OPEN; policy/proof pending.

## Gate 41 implementation boundary

The production POS registers a same-origin Service Worker from `/sw.js`. The worker is an availability mechanism only; it does not become a financial, identity, inventory or authorization authority.

The cached application shell is published atomically. A candidate snapshot gets its own content-derived cache, all referenced Next.js and brand assets are fetched first, and a completion marker is written before the active-cache pointer changes. The immediately previous complete snapshot is retained so an already-open cashier tab and a newly deployed shell can coexist safely while hashed assets roll over.

Only the root cashier navigation and same-origin `/_next/static/` / `/brand/` assets are intercepted. `/v1/*` API traffic and non-GET requests are never satisfied from CacheStorage. An unavailable authenticated API therefore remains unavailable rather than being replaced by stale authority data.

Exact Gate 41 implementation evidence on `1d5e36b3aed0590ad29e1e2422adda4e0e10b053`:

- full CI run `34660345695`: dependency pins, audit, formatting, lint, invariants, production build, typecheck and tests all green;
- actual Chrome hard-outage run `34660345691`: production web process group was terminated, browser HTTP cache disabled, root document and 21 Next static responses were served by the Service Worker, and `/v1/auth/me` still failed instead of being served from offline cache;
- proof artifact `10286767699`, SHA-256 `d55bdd5f6c52bbdff8fad13b114f3b2f29beb9ffa09f020a44eb9fda6f801b6b`;
- the artifact contains the online and hard-outage screenshots plus a sanitized proof log; no `/v1/` response was present in CacheStorage.

## Gate 42 durable-local-state boundary

The POS now owns one versioned IndexedDB database, `korvi-pos-offline`, with two deliberately separate stores:

- `catalogue-v1`: tenant-partitioned product snapshots that the server has actually returned to the cashier;
- `sale-drafts-v1`: in-progress cashier intent partitioned by tenant, branch, terminal, user and shift.

The browser store never becomes price, tax, stock, identity or authorization authority. Product prices in the local catalogue and draft remain display snapshots; checkout continues to be repriced and validated by the server. An HTTP refusal is never replaced by cached data. The durable product source falls back to IndexedDB only when the request has no authoritative HTTP answer, and corrupt/unavailable local data preserves the original network failure instead of manufacturing an empty or successful response.

Sale-draft writes are serialized so an older asynchronous write cannot overtake a newer cashier edit. Startup locks the mutable cashier surface until the exact scoped draft is loaded or local durability has explicitly failed. A successful online checkout or an explicit new-sale transition clears the draft. If local durability is unavailable, the UI says so and makes no false persistence claim; online server-authoritative selling remains available.

Schema and failure boundaries are explicit: version `1`, `onversionchange` closes stale connections, blocked upgrades surface as a distinct failure, quota/version/unavailable/transaction failures are classified, and every catalogue/draft read is runtime-validated. Malformed persisted values fail closed as `corrupt` rather than becoming financial/display truth.

Gate 42 real-browser evidence on `768db08f1154eb1c70371ce3d881da8bff87ac05`:

- Chrome IndexedDB durability proof `34661886838` succeeded in Chrome `152.0.7977.82` on Ubuntu 24.04;
- the proof seeded two tenant-A products, one tenant-B product and an exact sale draft through the production `offline-store.ts`, terminated the complete browser process group, restarted Chrome with the same profile, then read the state back through the same production module;
- restart persistence, tenant catalogue isolation, sale-draft isolation, Arabic search, barcode search and explicit corruption rejection all passed;
- proof artifact `10287374129`, SHA-256 `da6474b4d00e78564549992befffcbd9891765c91d1ff1c447e479cf1faeec7e`.

This does **not** claim a complete merchant catalogue has already been synchronized. The current online `/v1/products` read is bounded, so Gate 42 durably preserves catalogue records actually observed by the cashier. Whole-catalogue synchronization/completeness must be established by the later sync/reconciliation authority rather than inferred from a partial page.

## Why ordering is already solved at the domain boundary

Every queued operation is keyed by UUIDv7, so the identifier carries its own creation time and the queue drains oldest-first by sorting on the key. No sequence, no server round trip, no separate ordering column (ADR-0003).

That ordering contract is not yet a claim that a durable financial queue exists. Gate 43 remains open until queued operations themselves persist across restart/outage with exact retry/idempotency state.

## Retry

`RetryPolicy` is a value, not scattered `setTimeout` calls: five minutes initially, doubling to a six-hour ceiling, at most eight attempts. Rejections are recorded rather than dropped, so a sale can be inspected rather than silently lost.

## Next real blocker

Gate 43 must put the financial operation queue on the durable substrate without weakening checkout idempotency. A queued operation must survive browser restart/outage, preserve exact UUIDv7 ordering and payload identity, and never let an ambiguous in-flight operation be silently replaced by a new operation id.

Conflict resolution policy per entity type remains intentionally open for Gate 45. `ConflictResolution` names the three outcomes (`keep-local`, `keep-remote`, `needs-review`); the policy must be proven against the concrete synchronized entities rather than guessed in advance.
