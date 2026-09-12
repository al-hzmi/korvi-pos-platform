# Offline — implementation boundary

ADR-0005 defines the offline-first architecture. Gates 41–43 are now implemented and proven; Gates 44–45 remain open and must preserve the same authority, ordering and reconciliation guarantees.

## The guarantee we are building toward

A terminal keeps selling with no network, for as long as the outage lasts, and reconciles afterwards with nothing lost and nothing reordered.

Gates 41–43 establish browser availability, durable local cashier state and the persistent immutable operation queue. They do **not** claim that a financial sale can already be finalized offline: transport/retry execution and conflict/reconciliation policy belong to Gates 44–45.

## Pieces, and where they live

- **Service Worker** — app shell available with no network — Gate 41 CLOSED.
- **IndexedDB** — versioned durable store for cashier catalogue snapshots and in-progress sale state — Gate 42 CLOSED.
- **Transaction queue** — durable ordered immutable record of operations that must reach the server — Gate 43 CLOSED.
- **Sync engine** — drains the queue and handles retry/reporting without loss, duplication or reordering — Gate 44 OPEN.
- **Conflict handling** — resolves divergence and proves the real offline-sale/reconnect workflow — Gate 45 OPEN.

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

The POS owns one versioned IndexedDB database, `korvi-pos-offline`, with deliberately separated stores for locally observed catalogue state and in-progress cashier intent:

- `catalogue-v1`: tenant-partitioned product snapshots that the server has actually returned to the cashier;
- `sale-drafts-v1`: in-progress cashier intent partitioned by tenant, branch, terminal, user and shift.

The browser store never becomes price, tax, stock, identity or authorization authority. Product prices in the local catalogue and draft remain display snapshots; checkout continues to be repriced and validated by the server. An HTTP refusal is never replaced by cached data. The durable product source falls back to IndexedDB only when the request has no authoritative HTTP answer, and corrupt/unavailable local data preserves the original network failure instead of manufacturing an empty or successful response.

Sale-draft writes are serialized so an older asynchronous write cannot overtake a newer cashier edit. Startup locks the mutable cashier surface until the exact scoped draft is loaded or local durability has explicitly failed. A successful online checkout or an explicit new-sale transition clears the draft. If local durability is unavailable, the UI says so and makes no false persistence claim; online server-authoritative selling remains available.

Schema and failure boundaries are explicit. `onversionchange` closes stale connections, blocked upgrades surface as a distinct failure, quota/version/unavailable/transaction failures are classified, and every catalogue/draft read is runtime-validated. Malformed persisted values fail closed as `corrupt` rather than becoming financial/display truth.

Final Gate 42 governance evidence on `21f839f2e1ac7fa3e159263746d5128a2c73ce42`:

- full CI run `34662360647` succeeded on the exact governance SHA;
- actual Chrome full-process restart proof `34662360724` succeeded using the production IndexedDB module and the same persistent browser profile;
- restart persistence, tenant catalogue isolation, sale-draft isolation, Arabic search, barcode search and explicit corruption rejection all passed;
- proof artifact `10288355298`, SHA-256 `03ad4d6f90bd9cdb2af4b4e35583952990182d4c09fd0c104af77a429adf9c4d`.

This does **not** claim a complete merchant catalogue has already been synchronized. The current online `/v1/products` read is bounded, so Gate 42 durably preserves catalogue records actually observed by the cashier. Whole-catalogue synchronization/completeness must be established by the later sync/reconciliation authority rather than inferred from a partial page.

## Gate 43 durable ordered transaction queue

IndexedDB schema version `2` adds `transaction-queue-v1` without deleting or rewriting the Gate 42 catalogue or sale-draft stores. A real browser upgrade proof starts from a populated version-1 database and verifies both legacy stores survive the transition before queue operations are admitted.

Every queued command is an immutable envelope containing:

- a canonical UUIDv7 operation id, which is also the chronological ordering key;
- an explicit operation `kind`;
- one canonical JSON payload frozen at enqueue time;
- the original enqueue timestamp;
- durable lifecycle state and any terminal rejection reason.

The queue is partitioned by tenant, branch and terminal. The operation id is globally unique in the local database. Re-enqueueing the **exact same** immutable envelope is an idempotent no-op; reusing that id with another payload, kind, enqueue time or partition is refused as a conflict. This prevents an ambiguous or retried sale from silently acquiring different financial intent under the same identity.

Payload identity is deterministic: object keys are canonicalized, non-finite numbers, bigint/undefined values, cycles, non-plain objects and sparse arrays are rejected, and payload size is bounded before persistence. Reads re-validate the persisted row and canonical payload; malformed records fail closed as `corrupt` rather than entering replay.

Pending operations are read oldest-first from the compound `[partitionKey, UUIDv7]` index. A terminal `settled` or `rejected` result is durable and cannot be rewritten to another terminal outcome. Rejection reasons are bounded and persisted for later operator/reconciliation visibility. Gate 43 intentionally does not implement the network drain loop: retry scheduling, in-flight ambiguity handling and server acknowledgement belong to Gate 44 so queue durability cannot be confused with sync correctness.

Gate 43 implementation proof on `d6d24a0ec8fb083291ef922d4bc9a970dce12a08`:

- exact implementation CI `34663187823` passed dependency pins, audit, formatting, lint, invariants, build, typecheck and tests;
- actual Chrome durability proof `34663187862` upgraded populated schema v1→v2, enqueued four UUIDv7 operations deliberately out of insertion order, proved chronological read order, exact-envelope idempotency, immutable-payload collision refusal, cross-partition id refusal and terminal-state rewrite refusal;
- the proof terminated **both** Chrome and the proof HTTP origin, then restarted Chrome with the same persistent profile and proved remaining pending order plus settled/rejected state, rejection reason, exact payload and partition isolation survived the outage/restart boundary;
- malformed persisted queue payload was explicitly refused after restart;
- proof artifact `10288466519`, SHA-256 `f0dc3f798c4dab16e07fb425807361d6e22dc845c4d8371a4b3ac6dfb15ccf0e`, recorded Chrome `152.0.7977.82` on Ubuntu 24.04.

## Retry

`RetryPolicy` remains a centralized value rather than scattered timers: five minutes initially, doubling to a six-hour ceiling, at most eight attempts. Gate 43 persists operations and terminal outcomes; Gate 44 must now prove how attempts are claimed, retried and acknowledged without duplicate execution or reordering.

## Next real blocker

Gate 44 must implement the synchronization engine over the Gate 43 queue. It must preserve one operation identity from first send through every retry, distinguish definitive rejection from transport ambiguity, never allow a later operation to overtake an unresolved earlier one, and record acknowledgements durably before advancing the queue.

Gate 45 remains responsible for the concrete conflict/reconciliation policy and the complete real offline sale → reconnect → server-authoritative reconciliation workflow. `ConflictResolution` names the possible outcomes (`keep-local`, `keep-remote`, `needs-review`); policy must be proven against the concrete synchronized entities rather than guessed in advance.
