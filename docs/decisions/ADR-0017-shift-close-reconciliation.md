# ADR-0017 — Shift close and drawer reconciliation

Status: accepted · Strike 3B-1c · builds on ADR-0002, ADR-0004, ADR-0013,
ADR-0015, ADR-0016

## Context

Korvi could put cash in a drawer and take it out again through a sale and a
refund, and had no way to count it. What existed was worse than nothing: a
`ShiftRepository.close()` that accepted `expectedCashMinor` and
`varianceMinor` from its caller, and a `recordCashMovement()` that read a
shift's status and then wrote to it without holding the row.

Both are financial authority in the wrong place. The first lets whoever calls
it decide what the till should have held; the second can be overtaken by a
close between the read and the insert, leaving money in a drawer that has
already been counted and signed off.

## Decision

### One authority, and it is the server

There is exactly one way a shift closes: `ShiftRepository.close`, which takes
the shift, the till, the branch, the closer and one physical count. It does not
accept an expected cash figure or a variance, and no other method persists
either. The old signature is gone rather than deprecated — a path that can
express the unsafe thing is a path somebody will use.

`recordCashMovement` is likewise gone. Its replacement,
`recordManualMovement`, takes the shift row FOR UPDATE before it writes.

### The shift row is the drawer's serialization boundary

Every transaction that changes what is in a drawer takes that drawer's row
first: a cash sale, a cash refund, a manual movement, the close. PostgreSQL
then decides the order, and both possible orders are correct:

- a writer that acquires first commits, and the close that follows counts it
  exactly once;
- a close that acquires first commits, and the writer behind it sees `closed`
  and its whole transaction fails — no movement, no sale, no stock, and no
  idempotency tombstone.

No process-local mutex, and no preflight status check standing in for a lock.

### Lock order

Verified against the code rather than asserted. The four paths that touch a
drawer acquire, in this order:

**Sale** (`sale-repository.record`)

    branches FOR UPDATE            (allocateReceipt — the receipt number)
    shifts FOR UPDATE              (assertShiftUsable)
    idempotency_keys INSERT
    sale / invoice / inventory / cash writes

**Return** (`return-repository.record`)

    sales FOR UPDATE               (the returnable-quantity boundary)
    sale_lines FOR UPDATE          (the requested lines, in id order)
    returnable reads, then the pure plan
    branches FOR UPDATE            (allocateReturnNumber)
    shifts FOR UPDATE              (assertShiftUsable)
    idempotency_keys INSERT
    return / refund / inventory / cash writes

**Shift open** (`shift-repository.open`) — added in Strike 4B-1

    branches FOR UPDATE            (is this branch trading?)
    terminals FOR UPDATE           (one open shift per till)
    shifts read
    shift / opening-float writes

Terminals sit between branches and shifts, which is where they have to sit:
every financial path below already takes branch locks before shift locks and
none of them touches a terminal, so inserting terminals there extends the order
without creating a cycle. Merchant administration takes the same two rows in
the same order (ADR-0019), so standing a branch or a till down serialises
against opening a shift on it rather than racing it.

**Manual movement** (`shift-repository.recordManualMovement`)

    shifts FOR UPDATE
    idempotency_keys INSERT
    cash_movements INSERT

**Close** (`shift-repository.close`)

    shifts FOR UPDATE
    cash_movements aggregation (authoritative, read under the lock)
    idempotency_keys INSERT
    shifts UPDATE (status + immutable snapshot)

The property that matters is what the two drawer paths do _not_ do: neither
takes a branch or a sale lock at all, and therefore neither takes one _after_
holding a shift. Every other path acquires sale, branch and terminal locks
strictly before the shift. The acquisition order is consistent across all five,
so no two transactions can each hold what the other needs, and a deadlock
between them is not expressible.

### The cash equation

Five positive magnitudes are persisted — opening float, cash sales, cash
refunds, paid in, paid out — and the signs are applied in exactly one place:

    expected = opening + cashSales - cashRefunds + paidIn - paidOut
    variance = declared - expected

Storing magnitudes rather than signed sums is what stops a double negation
turning a shortfall into a surplus of twice the size. The equation is asserted
by the domain and again by a CHECK constraint on the row, and the variance is
neither clamped nor rounded: one halala is information.

Everything is `bigint` minor units and crosses the wire as a decimal string,
including a declared count larger than `Number.MAX_SAFE_INTEGER`, which the
route accepts up to the BIGINT range and refuses past it.

### Blind close

Nothing tells the cashier what the drawer should hold before they count it.
`GET /v1/shifts/current` exposes the opening float and no derived figure, and
the close request carries one number: what was counted. The reconciliation
comes back only in the response, after the count is committed. A figure shown
beforehand is a figure to count towards.

### Who may do what

A **close** is `shift.close`, and the closer must be the shift's own operator.
Korvi's model is one drawer, one cashier, and a normal close is that person
reconciling their own till. Manager force-close is a separate capability with
its own audit story and is deliberately not built here.

A **manual movement** is `shift.cash-movement`, which in the current role model
belongs to manager-level roles. The actor is therefore _not_ required to be the
shift's owner — requiring that would make the permission unusable by the only
people who hold it. What is required is that the supervisor is authorised for
the branch the drawer is in, that the till is in that branch, and that the shift
is on that till and open. Accountability comes from recording the actor
(`cash_movements.actorUserId`) separately from the owner (`shifts.userId`).

Both routes validate authority fields with a rule of their own rather than the
sale routes' global list, which names `shiftId` and `branchId` because a _sale_
must not carry them. A shared list that is wrong for one caller is worse than
two lists.

### Refusals do not enumerate

The repository proves _addressability_ before it looks at state: branch, then
terminal, then status, then ownership. A drawer the caller cannot address
answers identically whatever its status, so a closed shift in another branch is
indistinguishable from a shift id that names nothing.

Internally the three unaddressable cases stay apart — `unknown-shift`,
`branch-mismatch`, `terminal-mismatch` — because a developer reading a log
needs them. Over HTTP they collapse into one `unknown-shift` / 404. Telling
them apart would turn a guessed UUID into a probe for what exists elsewhere in
the merchant, which is the branch boundary every other Korvi route keeps.

`shift-closed` and `not-shift-owner` survive as distinct answers precisely
because both are only reachable for a drawer the caller _can_ address, and both
are actionable: count it again tomorrow, or fetch the cashier.

### Idempotency

Scopes `cash-movement` and `shift-close`. The fingerprint covers the material
intent — the shift, the till, and either the kind, magnitude and trimmed reason
or the declared count — bound to the **actor and the branch**, both taken from
the session and the terminal lookup and never from the request body.

Everything the server derives _from the request_ stays out: the signed amount,
the expected cash, the variance, the closing time. The actor and the branch are
not derived from the request at all — they are the context it arrived in, and
binding them is what stops an operation id becoming a bearer token for somebody
else's transaction. Without it a second cashier replaying a colleague's close
would be handed that colleague's reconciliation, and a second manager reusing
an operation id would inherit a movement recorded under another name. Both are
identity swaps wearing a retry's clothes, and both now answer
`idempotency-conflict` with nothing of the original in the response.

The reservation is written inside the same transaction as the financial change,
so a rollback takes it with it and leaves no tombstone to block a lawful retry.
An identical retry replays the original result, including the original
`closedAt` and the original snapshot; the same operation id with a different
intent is a conflict; a different operation id against a closed shift is told
the drawer is closed.

Because a close may commit on another connection between a retry's preflight
read and its own lock, a `shift-closed` refusal re-reads the reservation before
it is reported: a lawful replay is not a late arrival.

### Physical cash is not financial authority

There is no rule refusing a pay-out because the expected balance looks low.
Expected cash is accounting state, not a count of the notes in the drawer, and a
till can legitimately hold more than Korvi knows about. A merchant policy
requiring sufficient drawer cash is a policy, and would be a separate decision.

### Legacy closers

`closedByUserId` and the four category columns are nullable. A shift closed
before this migration has no recorded closer and no snapshot, and none is
invented for it. A CHECK constraint makes the snapshot all-or-nothing, so a
partial reconciliation is not representable and there is no state for a later
write to fill in.

## Consequences

Cash operations on one drawer serialise. That is the cost of an invariant no
constraint can express, and the lock is held for one small transaction.

The close reads every movement on the shift. A drawer with tens of thousands of
movements would want an incremental total; a shift is a working day at one till,
so it does not.

## Deferred

Manager force-close, the drawer user interface, offline queueing, and any
posting to a general ledger.
