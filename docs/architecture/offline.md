# Offline — implementation boundary

ADR-0005 defines the offline-first architecture. Gates 41–45 are now implemented and proven with the same authority, ordering and reconciliation guarantees preserved end to end.

## The guarantee we are building toward

A terminal keeps selling with no network, for as long as the outage lasts, and reconciles afterwards with nothing lost and nothing reordered.

Gates 41–44 establish browser availability, durable local cashier state, the persistent immutable operation queue and the ordered retry/acknowledgement engine. Gate 45 closes the complete cashier offline-sale workflow with an explicit fail-closed conflict policy and a real sale → outage → reconnect → server-authoritative reconciliation proof. The browser remains a durable intent holder, never financial, tax, stock, identity or authorization authority.

## Pieces, and where they live

- **Service Worker** — app shell available with no network — Gate 41 CLOSED.
- **IndexedDB** — versioned durable store for cashier catalogue snapshots and in-progress sale state — Gate 42 CLOSED.
- **Transaction queue** — durable ordered immutable record of operations that must reach the server — Gate 43 CLOSED.
- **Sync engine** — leased/fenced oldest-first drain with durable retry/reporting and acknowledgement-before-advance — Gate 44 CLOSED.
- **Conflict handling** — preserves definitive server refusals as `needs-review` and proves the real offline-sale/reconnect workflow — Gate 45 CLOSED.

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

## Gate 44 durable synchronization engine

IndexedDB schema version `3` adds durable sync lifecycle metadata to every queue row: `nextAttemptAt`, `leaseUntil` and an internal claim fencing token. The v2→v3 migration preserves immutable operation identity and payload. A legacy v2 `in-flight` row is conservatively returned to `pending` because Gate 43 had no real claim-owner authority; no unprovable worker ownership is invented during migration.

A worker may claim only the **oldest unresolved** operation for its tenant/branch/terminal partition. Claiming is one IndexedDB read-write transaction, so concurrent tabs/processes cannot both own the same command. A live lease blocks every later operation. An expired lease may be reclaimed, but only as the exact same operation id and payload, with the durable attempt counter incremented. Every acknowledgement, retry schedule or rejection requires the current UUIDv7 fencing token; a stale worker cannot settle or rewrite a command after its lease was recovered by another worker.

The push engine therefore has an explicit acknowledgement-before-advance invariant. A successful send is durably `settled` before the next UUIDv7 is claimed. A retryable/ambiguous response returns the same row to `pending` with centralized exponential backoff and immediately stops the drain, so a newer sale cannot overtake it. A definitive refusal is retained as `rejected` for reconciliation instead of being dropped. Retry exhaustion is also retained explicitly; nothing is silently discarded.

The checkout executor replays only a validated `sale.checkout` payload whose payload `operationId` exactly equals the queue id. Network/server ambiguity and session loss remain retryable because the original sale may already exist server-side; permanent business refusals become durable rejected items for Gate 45 reconciliation. The executor never mints a replacement financial operation id.

Gate 44 implementation proof on `f501be797165cf1190eac6b8bdd4a95c683648e0`:

- exact-head CI run `34664871538` passed dependency pins, audit, formatting, lint, invariants, Prisma generation, production build, typecheck and the complete test suite;
- actual Chrome proof `34664871536` started from populated schema v2, proved v2→v3 migration, deliberately raced two independent store instances for the oldest queue row and observed exactly one claimant while the other was blocked by the active lease;
- the proof then terminated **both** Chrome and the proof HTTP origin, restarted Chrome with the same persistent profile, proved the active lease survived restart, recovered the exact same operation only after lease expiry, incremented the durable attempt counter and refused a stale fencing token;
- a persisted retry schedule blocked all later work before its due instant; after the due instant the engine settled the oldest command, durably acknowledged it, then settled the next UUIDv7 in exact order without duplicate successful execution;
- both settled rows remained in durable storage rather than disappearing after acknowledgement;
- proof artifact `10288890491`, SHA-256 `2faba8ac4fc40e5f80f9423a5fcdcb964d610bb0cba2ecfe9aa41a4b2941969f`.

## Gate 45 real offline sale and reconciliation boundary

A cashier checkout may transfer ownership from the foreground request to the durable queue only after IndexedDB confirms that the **exact immutable checkout intent** has been written. If both the network result and local durability are unavailable, the original checkout remains locked under the same operation id; the till cannot silently mint a replacement sale.

Every delayed `sale.checkout` carries `expectedShiftId` only as a replay precondition. It does not let the browser select financial authority: the server still derives the current open shift, cashier, branch, catalogue price, VAT, stock and settlement. A delayed command may not move cash into a replacement shift. Conversely, if an earlier request actually committed but its response was lost, idempotency is resolved before requiring today's open shift, so the original committed sale can still be recovered exactly after its original shift closes.

Conflict policy is deliberately asymmetric because financial truth is not mergeable local state:

- a successful exact replay becomes durably `settled` only after the server acknowledges the authoritative sale;
- transport/session ambiguity remains the **same operation** and is retried by the Gate 44 leased/fenced engine;
- a definitive business refusal such as `insufficient-stock` becomes immutable `rejected` / `needs-review`; the browser does not convert it into a local sale, local invoice, local VAT fact or local stock movement;
- `keep-local` and `keep-remote` are therefore not automatic financial conflict outcomes. Any later operator tooling must preserve the rejected evidence and require a new explicit server-authorized commercial action where appropriate.

Exact Gate 45 closure evidence on `e979a997b2d72562a1f34d5b6c2fc734c1ef60e2`:

- full CI `34685965135` passed dependency pins, audit, formatting, lint, invariants, Prisma generation, production build, typecheck and the complete test suite;
- actual Chrome/PostgreSQL 17 proof `34685965214` used a fresh persistent cashier profile, a real server-authorized shift and the production IndexedDB/queue/sync path;
- while Chrome was offline, two distinct UUIDv7 sales were durably queued in order without creating local financial truth; a legitimate inventory adjustment through Korvi's authenticated inventory authority changed server stock from `11` units to `1` unit;
- after reconnect on the **same browser profile and IndexedDB**, the oldest queued sale settled exactly once and the second was refused as `insufficient-stock` and retained as `needs-review`;
- PostgreSQL evidence is `sales 1|0`, `invoices 1|0`, sale inventory movements `1|0`, with the accepted movement exactly `-1000`; final stock reconciles exactly as `11 - 10 - 1 = 0` units;
- artifact `10295731642`, SHA-256 `ae7d80bf8d1d31107793cac9b634d539f1fe9816e19bdad24059448482c27570`, contains sanitized authority/proof records and screenshots of the first queued sale, second queued sale and reconnected `needs-review` state;
- proof authority records Chrome `152.0.7977.82`, PostgreSQL `17.11`, all `16/16` migrations applied with zero drift, and a restricted application role with `NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOREPLICATION/NOBYPASSRLS`.

## Retry

`RetryPolicy` is centralized rather than scattered timers: five minutes initially, doubling to a six-hour ceiling, at most eight attempts. Gate 44 applies that policy through durable `nextAttemptAt` scheduling, leased claims and fenced state transitions. Ambiguity therefore preserves the exact operation identity instead of manufacturing a replacement command.

## Offline pillar status

The v1 offline-first resilience pillar is now closed across Gates 41–45: application shell availability, durable local catalogue/draft state, immutable ordered queue, leased/fenced retry engine and the real cashier sale/reconnect/conflict path are all evidence-backed. This closure does not weaken any other release blocker: ZATCA production signing/reporting, independent/Human Gates and production operations remain governed separately by the product readiness scorecard.
