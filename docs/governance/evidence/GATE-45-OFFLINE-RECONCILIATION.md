# Gate 45 — Offline Sale/Reconnect Reconciliation Evidence

Status: **CLOSED**

Functional evidence baseline: `e979a997b2d72562a1f34d5b6c2fc734c1ef60e2`

Gate 45 closes the v1 offline-first cashier reconciliation boundary. The browser may durably preserve an immutable checkout intent while disconnected, but it never becomes authority for price, VAT, stock, shift ownership, invoice issuance, identity or authorization.

## Production invariants proved

- Foreground checkout transfers ownership to IndexedDB only after the exact immutable command is durably written. If both network outcome and local durability fail, the till remains locked on the original operation id.
- Offline commands remain ordered UUIDv7 operations and are drained oldest-first by the leased/fenced Gate 44 engine.
- `expectedShiftId` is a replay precondition only. The server derives the authoritative shift and refuses moving delayed cash into a replacement shift.
- An exact operation that previously committed can still resolve idempotently after its original shift closes; no replacement sale id is minted.
- A definitive server business refusal is retained as immutable `rejected` / `needs-review`. It is not converted into a local sale, invoice, VAT fact or stock movement.
- Automatic `keep-local` / `keep-remote` resolution is not permitted for financial checkout conflicts. Any follow-up commercial action must be a new explicit server-authorized operation while preserving the rejected evidence.

## Exact browser/database evidence

On `e979a997b2d72562a1f34d5b6c2fc734c1ef60e2`:

- Full CI: `34685965135` — success.
- Actual Chrome/PostgreSQL 17 reconciliation proof: `34685965214` — success.
- Artifact: `10295731642`.
- Artifact SHA-256: `ae7d80bf8d1d31107793cac9b634d539f1fe9816e19bdad24059448482c27570`.
- Chrome: `152.0.7977.82`.
- PostgreSQL: `17.11`.
- Restricted application role flags: `f|f|f|f|f|f` for superuser / createdb / createrole / inherit / replication / bypassrls.
- Migrations: `16/16`; schema drift: none.

The real-browser scenario queued two distinct offline sales. While that same browser profile remained offline, Korvi's authenticated inventory authority legitimately changed server stock from 11 units to 1 unit. After reconnect with the same browser profile and IndexedDB, the oldest sale settled exactly once; the second was refused as `insufficient-stock` and remained visible as `needs-review`.

PostgreSQL authoritative reconciliation:

- accepted/rejected sale rows: `1|0`;
- accepted/rejected invoice rows: `1|0`;
- accepted/rejected sale inventory movements: `1|0`;
- accepted sale movement quantity: `-1000` scaled units;
- final stock: `11 - 10 - 1 = 0` units exactly.

The proof artifact also contains screenshots of the first queued sale, second queued sale and the post-reconnect `needs-review` state.

## Release boundary

This closure completes Pillar I, Gates 41–45. It does **not** waive or imply closure of Gate 39, Gate 40, the required independent/Human Gates, or production operations/controlled field validation. Those remain separate release blockers under the product readiness scorecard.
