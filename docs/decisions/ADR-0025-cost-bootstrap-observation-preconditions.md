# ADR-0025 — Cost Bootstrap Observation Preconditions

Status: **ACCEPTED — STAGE 5 C0 CORRECTION**

Supersedes: ADR-0024 §8 only where prospective cost bootstrap was previously
allowed without binding the human decision to the cost facts observed.

## Context

Prospective bootstrap assigns one merchant-entered acquisition total to all
currently unknown positive stock for a branch/product. The server must derive
that quantity under the stock and cost locks; allowing the browser to dictate
the resulting quantity would create client financial authority.

Derivation under a lock is necessary but not sufficient. If stock or cost state
changes after the manager reviews the row but before bootstrap obtains its
locks, applying the old total to the new unknown quantity changes the financial
meaning of the manager's decision. Serialization protects database consistency;
it does not prove that a human decision is fresh.

## Decision

Every bootstrap intent carries these exact decimal-integer observation
preconditions from the cost read model:

- `expectedStockRevision`;
- `expectedCostRevision`;
- `expectedUnknownPositiveQuantityScaled`.

They are assertions about the row reviewed, not authority over the result. The
server continues to derive current unknown positive quantity from locked stock
and cost state and continues to own every resulting balance, revision, event
and audit fact.

After acquiring the existing canonical locks, the server compares all three
observations with current truth. Any mismatch raises the dedicated
`cost-state-changed` conflict. The transaction rolls back, including the
idempotency reservation and any cost-row materialization. No cost-pool update,
valuation event or bootstrap audit may survive that refusal.

The three preconditions are part of the canonical idempotency fingerprint and
the browser's synchronously frozen command. A same-intent retry after an
ambiguous transport outcome must retain them byte-for-byte. A typed stale
refusal retires the operation id, forces a successful cost refresh, clears the
entered total and requires a new human decision with a newly minted operation
id. Korvi never silently rebuilds the old intent against refreshed state.

A committed request still replays its recorded result even if current stock or
cost facts later move. That is confirmation of an already committed operation,
not a new valuation decision.

## Consequences

- Stock/cost locks retain their existing order and authority boundaries.
- The browser may transmit observed revisions and unknown quantity only under
  the `expected*` names. Unprefixed/current/result quantity, pool and revision
  fields remain forbidden.
- A known-cost receipt can invalidate bootstrap even when unknown quantity is
  numerically unchanged, because its revisions changed.
- A receipt, sale, transfer or sibling bootstrap that wins the lock can turn an
  older bootstrap into a safe 409 conflict rather than silently rebasing it.
- Live PostgreSQL proof must cover increases, decreases, known-cost inflows,
  cost-only revision movement, rollback residue and frozen ambiguous retry.

## Non-goals

This ADR does not make displayed state authoritative, add optimistic writes,
change cost allocation, infer unit/average cost, or permit the browser to send
the quantity/value/revisions that the command will produce.
