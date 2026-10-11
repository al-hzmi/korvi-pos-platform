# Korvi Installed Local-First Application Strategy

**Status:** Accepted product/architecture direction  
**Date:** 2026-09-15  
**Release context:** Korvi V1 final-closure workstream  
**Authority:** Live repository remains higher authority than this document.  
**Baseline before this document:** `strike/product-routing-p0` @ `6127d551a6a931f5f2b1b64591b86d9e8afcbc86`, exact-head CI green.

---

## 1. Executive decision

Korvi will evolve from a browser-delivered POS with offline capability into an **installed, local-first POS application with cloud synchronization**.

The product promise is:

> **Korvi does not require the Internet to keep selling. The Internet is primarily for synchronization, central management, backup, updates and external services.**

This direction is intentionally practical. We are not building a distributed database or a complex branch mesh for rare edge cases. The system must favor uninterrupted retail operation, especially for groceries, small shops and stores where connectivity is weak, intermittent or intentionally enabled only at certain times of day.

The immediate implementation path is **installable PWA first** for Windows and Android because Korvi already has a mature web client and real offline infrastructure. This gives an installed application experience without rewriting the product or adding a second UI codebase. A native shell (for example Tauri/Capacitor or another approved runtime) remains an optional later packaging layer if store distribution, native hardware APIs or stronger OS integration materially require it.

The current web application is not discarded. The same Korvi client becomes the installed application surface.

---

## 2. Why this direction fits Korvi

Korvi targets Saudi retail environments where a till must continue operating even when the connection does not. A cloud-only cashier is operationally fragile: a router problem, ISP outage or weak mobile signal must not stop a sale.

The project already adopted offline-first boundaries in `docs/decisions/ADR-0005-offline-first.md`. The live implementation has progressed beyond that early ADR:

- `apps/pos-web/src/lib/offline-store.ts` implements a real IndexedDB database named `korvi-pos-offline`.
- The database currently contains durable catalogue, sale-draft and transaction-queue stores.
- The transaction queue is partitioned by tenant / branch / terminal and uses canonical UUIDv7 identities.
- Queue payloads are canonicalized and size bounded.
- Local data validation, quota/error classification, transaction handling and queue safety already exist.
- `apps/pos-web/src/components/cashier-screen.tsx` already uses:
  - a durable product source;
  - durable sale drafts;
  - an offline sale synchronization hook;
  - a tenant/branch/terminal queue partition;
  - explicit pending and rejected/review states;
  - server authority after reconnection.

Therefore this is not a restart. It is the next architectural step of the work already present in Korvi.

---

## 3. Product model

Korvi is split into two planes.

### 3.1 Local operational plane

Runs on the merchant device and must remain usable through an Internet outage.

Primary local-first responsibilities:

- cashier / POS;
- local product catalogue required for selling;
- prices and VAT data required for the current sale path;
- current terminal/branch identity;
- current usable shift context subject to safe expiry/reconciliation rules;
- sale draft persistence;
- completed offline sale queue;
- receipt presentation/printing data;
- pending synchronization state;
- locally available customer data only where needed by the sale flow;
- local operational warnings.

The local plane is optimized for continuity, not for becoming the global system of record for every management function.

### 3.2 Cloud control plane

Remains authoritative for central and cross-device responsibilities:

- tenant identity and lifecycle;
- account and subscription control;
- central branch and device administration;
- global reporting;
- cloud backups and disaster recovery;
- cross-branch visibility;
- user/role/permission administration;
- authoritative master-data reconciliation;
- production audit trail;
- ZATCA integration pipeline and its regulated authority boundaries;
- device registration/revocation;
- software/update policy;
- Platform Admin.

The cloud is important, but a temporary inability to reach it must not stop a normal retail checkout that is safe to queue locally.

---

## 4. Deliberate simplification for multiple tills

Korvi will **not** initially build a peer-to-peer distributed inventory protocol between offline tills.

If several tills in the same branch are offline, each till may continue selling from its last locally known catalogue/inventory context. If two tills sell what was locally believed to be the last unit, the sale is not blocked merely to preserve a stale offline stock number.

The business rule is:

> A real customer sale that physically occurred is recorded. Inventory reconciliation follows reality; reality is not rejected to protect a stale cache.

After synchronization, the authoritative stock position may temporarily become negative or produce an exception that management must review. That is acceptable and preferable to stopping the cashier for an extremely rare race condition.

Initial non-goals:

- no LAN consensus protocol;
- no local leader election;
- no branch-local distributed database;
- no cross-terminal lock for the final unit while the branch is disconnected;
- no blocking checkout merely because another offline terminal might also sell the item.

If a large merchant later requires strict offline multi-terminal allocation, that becomes a separate enterprise capability supported by measured demand.

---

## 5. Installed application strategy

### 5.1 Immediate path: installable PWA

For the current release line, the safest and fastest packaging strategy is to make `@korvi/pos-web` an installable Progressive Web App.

Target behavior:

- installable on Windows through a supported Chromium browser;
- installable on Android through a supported Chromium browser;
- launches in standalone mode without ordinary browser chrome;
- has Korvi name, icons, theme and splash/startup identity;
- retains local IndexedDB data across ordinary restarts;
- uses a controlled service worker for the application shell and approved static assets;
- does not cache sensitive API responses indiscriminately;
- supports safe app-update detection and activation;
- fails closed when an update would be incompatible with the local database schema;
- continues the existing offline sale/queue behavior.

This path minimizes release risk because it keeps:

- the existing React/Next client;
- the existing design system;
- the existing offline queue;
- the existing API contract;
- the existing browser proof tooling;
- one UI codebase.

### 5.2 Native shell later, only when justified

A native wrapper may be added later for reasons such as:

- direct printer/USB/serial/Bluetooth integrations unavailable through the browser environment;
- managed app-store distribution;
- deeper kiosk/device-policy integration;
- secure OS keystore integration beyond normal browser capabilities;
- enterprise device management requirements;
- automatic signed native updates under Korvi control.

A native shell must not fork product logic. It should host the same application and expose a narrow, audited native bridge.

---

## 6. Local database policy

### 6.1 Today

The current browser/PWA local store remains IndexedDB because it already exists and is integrated with the sale path.

Current durable stores include:

- local catalogue;
- sale drafts;
- transaction queue.

### 6.2 Future native runtime

If Korvi adopts a true native shell and SQLite provides a measurable operational advantage, SQLite may replace or complement IndexedDB behind the same domain ports.

The database technology is an implementation detail. The stable architectural contract is:

- local durability;
- deterministic queue ordering;
- tenant/branch/terminal partitioning;
- schema/version migration safety;
- corruption detection;
- bounded storage;
- idempotent synchronization;
- server reconciliation.

No UI component may become directly coupled to SQLite.

---

## 7. Synchronization rules

The sync engine is not a blind two-way database replication system.

Korvi synchronizes domain operations.

Required properties:

1. **Every offline operation has a stable idempotency identity.**
2. **The same queued sale may be retried without creating a duplicate sale.**
3. **Queue ordering is deterministic.**
4. **A successful server settlement is recorded locally.**
5. **A rejected operation is not silently deleted.**
6. **Rejected operations remain reviewable.**
7. **A network timeout never proves that the server did not commit.**
8. **The client must not fabricate server-authoritative financial, tax, stock or ZATCA truth.**
9. **Reconnect triggers reconciliation, not a destructive local overwrite.**
10. **Local storage corruption or version mismatch must surface as an explicit operational state.**

Korvi already contains several of these mechanics in the existing offline queue and cashier flow; the installed-app work must extend rather than bypass them.

---

## 8. Inventory reconciliation policy

Inventory is operational truth, but offline sales may temporarily be based on stale availability.

Rules:

- selling while offline is allowed when the item is present in the local catalogue and the checkout path otherwise permits the sale;
- Korvi does not block a physical sale solely to prevent an unlikely offline final-unit conflict across independent tills;
- after sync, the server applies the sales in its authoritative transaction model;
- if the resulting stock is negative or inconsistent with a later count, the system raises an exception/reconciliation signal;
- Korvi never silently invents stock to hide the conflict;
- later stock counts/corrections use the normal audited inventory authority.

This keeps the cashier simple and makes the back office responsible for exceptional reconciliation rather than forcing distributed systems complexity into every small shop.

---

## 9. Security model

An installed application is **not automatically safer than a web application**. Client software can be inspected, modified or reverse engineered. Korvi security therefore does not depend on hiding JavaScript or pretending a packaged application is secret.

### 9.1 Mandatory principles

- no production master secret is embedded in the client;
- no database superuser credential is embedded in the client;
- no cross-tenant authority is granted by a local flag;
- server-side permissions remain authoritative when synchronization occurs;
- tenant and actor identity remain server-derived where the server is involved;
- TLS/HTTPS is mandatory for cloud communication;
- sessions/tokens use the narrowest practical scope and lifetime;
- local data is partitioned by tenant/branch/terminal and validated before use;
- app updates are delivered only from approved Korvi origins/channels;
- service-worker scope and cache policy are explicit;
- sensitive API responses are not broadly cached by the service worker;
- CSP and current web hardening remain in force;
- RLS and scoped repositories remain mandatory in the cloud database;
- idempotency remains mandatory for replayable operations.

### 9.2 Device identity

Korvi should maintain a server-issued device registration identity:

`tenant + branch + terminal/device + installation identity`

Copying cached files to another machine must not create a second trusted terminal automatically.

For the PWA phase, device registration uses an application-generated installation identity bound to server registration and normal authentication/terminal authority. For a later native shell, the installation private key should be non-exportable where the OS keystore/TPM/Android Keystore permits it.

### 9.3 Local data protection

For PWA/IndexedDB, the browser profile and OS account are part of the local security boundary. Korvi must avoid storing credentials or server secrets in plaintext local application data.

If a native shell is introduced, database-at-rest encryption and OS-backed key storage become release requirements before calling the native package hardened.

### 9.4 Anti-cloning stance

Korvi does not claim that client binaries are impossible to copy or reverse engineer. Instead:

- copied code has no master credential;
- a cloned installation lacks trusted device registration;
- server capabilities remain permission-checked;
- updates can revoke compromised versions/devices;
- commercial entitlement is verified when connectivity returns;
- audit trails expose abnormal device behavior.

Obfuscation may be defense-in-depth, never the security boundary.

---

## 10. ZATCA boundary

Local-first packaging must not weaken or redesign the existing ZATCA authority model casually.

Rules:

- the installed-app work does not bypass current canonicalization, signing, sequencing, reporting/clearance, retry or reconciliation rules;
- a local operation that cannot legally/factually be finalized without an external authority remains explicitly pending rather than being falsely marked final;
- ZATCA credentials/private signing authority must not be moved into ordinary exportable client storage merely to make the app look more offline;
- existing Gate 39/40 security and provider evidence remain authoritative for the production ZATCA pipeline;
- regulatory behavior is governed by the implemented and verified ZATCA release path, not by UI convenience.

This architecture changes delivery and local continuity. It does not downgrade compliance.

---

## 11. What must be finished today for the installed-app milestone

The same-day target is **Installed Korvi V1 shell + proven existing offline cashier continuity**, not a rewrite of every back-office module into a fully disconnected ERP.

### P0 acceptance criteria

1. `@korvi/pos-web` has a valid web app manifest.
2. Windows installability is verified in a supported browser.
3. Android installability is verified/emulated in a supported mobile Chromium context.
4. The installed app launches standalone with Korvi branding.
5. Required app icons and theme metadata are present.
6. A production-safe service worker/app-shell strategy is implemented.
7. Offline app startup after a successful initial bootstrap is proven for the cashier surface.
8. Cached catalogue remains searchable while offline.
9. Sale draft survives app/page restart.
10. Offline sale queue survives restart.
11. A queued sale can be reconciled after connectivity returns without duplication.
12. Rejected/review-required operations remain visible and are not silently deleted.
13. No sensitive API response is accidentally added to a generic cache-first policy.
14. Database/service-worker version upgrades have a fail-safe path.
15. Install/update behavior has automated or browser proof evidence.
16. Existing format/lint/invariants/build/typecheck/tests remain green.
17. Existing cashier/offline regression tests remain green.
18. No release-critical auth/RLS/idempotency/ZATCA invariant is weakened.

### Explicitly not required for today's milestone

- publishing in Microsoft Store or Google Play;
- native `.exe`/`.msi` installer;
- native `.apk` package;
- LAN synchronization between offline tills;
- peer-to-peer inventory consensus;
- replacing IndexedDB with SQLite;
- migrating all management/back-office screens to offline write capability;
- redesigning the entire Korvi client.

Those are separate deliverables and must not delay the safe installed-app milestone.

---

## 12. Recommended implementation sequence

### Strike A — installability

- manifest;
- icons;
- standalone display mode;
- theme/background metadata;
- installability checks;
- deterministic start URL.

### Strike B — safe service worker

- app shell/static asset strategy;
- explicit exclusions for API/auth/sensitive routes;
- offline navigation fallback only where safe;
- versioned cache names;
- controlled cleanup of old caches;
- update notification/reload behavior.

### Strike C — offline boot proof

- bootstrap online once;
- load catalogue;
- disconnect network;
- restart installed/standalone client;
- open cashier;
- search catalogue;
- build cart;
- queue sale;
- restart again;
- prove pending sale remains;
- reconnect;
- prove exactly-once reconciliation.

### Strike D — Windows + Android presentation proof

- Windows standalone viewport screenshot/proof;
- Android standalone/mobile viewport proof;
- RTL verification;
- no browser-only chrome assumptions;
- touch targets and keyboard/scanner path remain usable.

### Strike E — release gates

- format;
- lint;
- invariants;
- Prisma generation where relevant;
- build;
- typecheck;
- tests;
- browser proof;
- diff hygiene;
- exact-head CI.

---

## 13. Failure modes we must avoid

- caching authenticated API responses with a blanket service-worker strategy;
- treating the service worker as a security boundary;
- storing a tenant secret in client JavaScript;
- letting two app versions write incompatible IndexedDB schemas without migration/version handling;
- silently deleting rejected offline sales;
- marking a timed-out sync as failed when the server may already have committed;
- creating duplicate sales during reconnect;
- making the app unusable because an entitlement server is temporarily unavailable;
- forcing a complex multi-terminal protocol before real merchant demand exists;
- claiming native-grade anti-tamper security merely because the app is installed;
- starting a native rewrite before the current V1 release candidate is stable.

---

## 14. Release and commercial positioning

Recommended product language:

> **Korvi works even when the Internet does not. Sell, print and continue your shift normally; when connectivity returns, Korvi synchronizes automatically.**

This statement must only be used for flows that have passed actual offline/reconnect proof. It must not imply that every cloud-only administrative or regulatory operation can be finalized without connectivity.

The installed-app direction gives Korvi a strong fit for:

- groceries;
- convenience stores;
- small retail shops;
- warehouses with weak connectivity;
- temporary retail locations;
- merchants who do not want cashier uptime to depend on an ISP.

---

## 15. Relationship to current release closure

This decision must not derail the September 16 Korvi V1 readiness objective.

The rule is:

> **Reuse the proven web/offline core; add installability and safe app-shell behavior; do not rewrite the cashier or cloud authority.**

The installed-app work is acceptable before final release only if it remains an additive, test-backed change and all exact-head release gates stay green.

If the app-shell work reveals a blocker that threatens financial, inventory, security, ZATCA or release invariants, the blocker is fixed or the installed-app change is deferred from the release SHA. No deadline justifies weakening Korvi's protected core.

---

## 16. Final architecture statement

Korvi's intended long-term runtime model is now:

**Installed Local-First POS + Cloud Sync + Central Control Plane.**

The cashier is designed to continue through connectivity loss. The cloud remains authoritative for central control, reconciliation and protected services. Multi-terminal offline stock races are treated as operational reconciliation exceptions rather than a reason to introduce distributed-consensus complexity into ordinary merchants.

The immediate implementation should be PWA-first because the existing Korvi code already contains the correct offline primitives and because this is the fastest path to a real Windows/Android installed experience without duplicating the product.
