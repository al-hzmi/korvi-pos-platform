# ADR-0034 — ZATCA reporting, clearance, and ambiguous remote effects

- Status: Accepted
- Date: 2026-09-12
- Gate: 40

## Context

Gate 39 freezes and seals the fiscal artifact. Gate 40 sends that artifact to FATOORA for simplified-invoice reporting or standard-invoice clearance.

A remote HTTP submission is not an ordinary retryable read. Korvi can lose the response after request bytes have reached ZATCA. At that point the remote effect is ambiguous: an automatic retry may create a duplicate authority-side effect, while pretending the request failed would falsify fiscal history.

The transport boundary therefore cannot provide end-to-end exactly-once semantics. Gate 40 must instead make one local fact authoritative before the first outbound byte and refuse automatic retransmission after ambiguity.

## Decision

### 1. PostgreSQL is the submission authority

One tenant-owned `zatca_invoice_submissions` row freezes:

- source invoice and sale terminal;
- reporting vs clearance mode;
- environment;
- invoice UUID;
- exact SHA-256 invoice hash bytes;
- exact sealed XML bytes;
- opaque encrypted Production-CSID handle;
- queue/request/resolution timestamps;
- attempt count and durable outcome.

The unique `(tenantId, invoiceId, mode)` key is the idempotency boundary. A concurrent caller may generate a different local submission UUID or queue timestamp; those generated reservation details are not business identity. Equivalent immutable requests converge on the first durable row. A changed terminal/environment/mode/invoice UUID/hash/XML/credential handle is a conflict and is refused.

RLS/FORCE RLS, tenant-consistent foreign keys, CHECK constraints and a database trigger independently enforce isolation, source-invoice mode/terminal binding, immutable request identity, legal state transitions and append-only evidence.

### 2. Automatic submission is at-most-once

The production coordinator is the only automatic-send authority. Its order is load-bearing:

1. reserve the exact immutable request as `pending`;
2. atomically claim `pending -> in-flight` and persist `requestStartedAt`;
3. only the winner may call the FATOORA transport;
4. persist `accepted`, `rejected`, or `uncertain`.

A caller that observes `in-flight`, `uncertain`, `accepted`, or `rejected` returns that durable state without network I/O. A concurrent claim loser re-reads the authority and never sends.

If the process dies after step 2, the surviving `in-flight` row blocks automatic resend. This is deliberate.

### 3. Transport performs exactly one HTTP attempt

The HTTP adapter has no retry loop. Timeout, connection loss, response overflow, malformed/unknown successful responses, and retryable/ambiguous HTTP statuses become `uncertain`. Definite client or ZATCA validation refusal becomes `rejected`.

The adapter resolves Production-CSID plaintext only inside the encrypted server-side credential boundary. Submission rows contain only the opaque provider/secret handle.

### 4. Ambiguity is reconciliation work

`uncertain` is not a retry state. It can transition only to a trusted reconciled `accepted` or `rejected` outcome. Reconciliation performs no HTTP submission.

An unexpected adapter exception after the durable claim is treated conservatively as transport ambiguity. If outcome persistence itself fails, the already-persisted `in-flight` row remains the safety brake and must be reconciled rather than resent.

### 5. Reporting and clearance results remain distinct

- Simplified invoice reporting accepts only authority status `REPORTED` and stores no cleared invoice.
- Standard invoice clearance accepts only authority status `CLEARED` and stores the canonical cleared-invoice bytes returned by ZATCA.
- A mode/status mismatch or malformed cleared invoice is `response-invalid` uncertainty, not success.

No UUID, hash, sealed XML, or credential handle is regenerated on replay.

## Rejected alternatives

### Blind HTTP retry

Rejected. A missing response does not prove the authority did not accept the request.

### Mark timeout as rejected

Rejected. It invents a definite fiscal fact from an ambiguous network observation.

### Let callers invoke the HTTP adapter directly as the production workflow

Rejected. That permits network bytes before durable `in-flight` evidence and defeats the single-claim boundary.

### Use generated submission UUID as idempotency identity

Rejected. Concurrent equivalent callers generate different UUIDs. Fiscal idempotency is the immutable invoice submission request, not a caller-local reservation identifier.

## Verification required to close Gate 40

Gate 40 is closed only when the same final source SHA proves all of the following:

- restricted PostgreSQL application role;
- all migrations applied and zero Prisma schema drift;
- RLS/FORCE RLS and transition guard on the submission table;
- equivalent concurrent reservations converge and conflicting immutable replay is refused;
- exactly one concurrent automatic claimant can reach transport;
- `in-flight` is persisted before transport invocation;
- accepted/rejected/uncertain outcomes persist correctly;
- uncertain and in-flight replays never issue a blind second request;
- trusted reconciliation resolves uncertainty without transport;
- one-shot reporting/clearance HTTP contract, fixed endpoints, bounded responses and no plaintext CSID persistence;
- full repository verification remains green.
