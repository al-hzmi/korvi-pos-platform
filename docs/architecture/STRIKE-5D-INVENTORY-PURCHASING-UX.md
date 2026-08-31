# Strike 5D — Inventory & Purchasing UX

Status: **ACTIVE C1 IMPLEMENTATION CONTRACT**

Authority: ADR-0024 and Release Gate 9. Predecessors: Strikes 5A, 5B and 5C.

## 1. Mission

Give a merchant an Arabic, RTL-first operational interface over the inventory,
purchasing, receiving and costing authorities already established by the
server. The interface makes server truth usable; it never becomes another
source of stock, document status, received quantity or inventory value.

The governing rule is:

> **The browser may state intent and observations. Only the server may state
> stock, cost and document effects.**

## 2. Authority boundary

Every request derives tenant, actor and effective permissions from the
authenticated session. A UI permission check only hides an affordance; the
Fastify route remains the authorization boundary and sensitive services keep
their existing defense in depth.

The browser may submit only the inputs accepted by the established authorities:

- adjustment intent and reason;
- a counted quantity plus the last server revision observed;
- transfer source, destination and requested quantity;
- supplier and purchase-order intent;
- receipt quantities against purchase-order line identities;
- optional receipt value or prospective bootstrap value only for a principal
  holding the required cost authority.

The browser must never submit tenant identity, actor identity, current or
resulting stock, movement kind, current or resulting cost balance, received
accumulators, purchase-order status, completion flags, audit facts or
idempotency outcomes.

All quantities and inventory values remain canonical decimal integer strings
across JSON. Display formatting must not feed back into a command.

## 3. Bounded delivery sequence

Strike 5D is delivered in reviewable operational slices. Completing one slice
does not close the strike.

1. **5D-A — Branch stock read.** Permission-aware control-centre navigation,
   a bounded branch read model and exact branch-balance pages with merchant
   product identity.
2. **5D-B — Stock operations.** Adjustments, absolute counts and transfers over
   5A authority, including stale-revision recovery and retry-safe operation
   identity.
3. **5D-C — Purchasing operations.** Suppliers, immutable purchase orders and
   partial receiving over 5B authority, including server-derived order status
   and remaining quantities.
4. **5D-D — Cost affordances.** Cost visibility, valued receiving and
   prospective bootstrap exposed only under the separate 5C permissions.

5D-A was delivered and verified at `39361a6b07c6f7a94074a6581a5fb513e1891077`.
5D-B was delivered and verified at `fd9866c755fa5c6f4b1b428451ad38b7839fff67`.
5D-C was delivered and verified at `30b2a915567e5a3b6ee61cf75a8c955d03dc4fc9`.
The active slice is **5D-D**.

## 4. 5D-A read contract

### Operational branches

The administration branch endpoint is intentionally protected by
`settings.manage` and must not be reused as an inventory shortcut. 5D-A adds a
separate, bounded inventory branch read under `inventory.read`.

The read model contains only merchant-operational identity and state: branch
id, code, Arabic/English name and active state. It contains no tenant id,
settings authority or mutation capability. Keyset pagination stays bounded.
Inactive branches remain visible because historical balances do not cease to
exist when a branch is stood down.

### Balance rows

Each balance row is server-derived and contains:

- branch and product identity;
- product SKU, Arabic/English name, product type and unit label;
- exact `quantityScaled` and `revision` strings.

Product identity is joined on the server. For an active operational branch,
active inventory-tracked products whose balance has never been materialized are returned with exact zero
quantity and revision; a merchant must be able to record the first receipt,
count or adjustment without inventing a balance row in the browser. The read
does not materialize that zero. Inactive or no-longer-tracked products remain
visible only when a historical balance row exists.

The client must not issue an
unbounded catalogue read or guess that a separately paged catalogue contains
every balance row. Inactive products remain readable when a balance exists;
deactivation must not hide historical stock truth.

Balance pagination remains keyset-based on product id. Pages are individually
correct server reads, not a promised snapshot across time: stock may change
between pages. The revision returned with each row is the concurrency evidence
that a later count must submit, not a client-owned version counter.

## 5. Control-centre access

Each built section declares its own permission:

- dashboard: `report.read`;
- catalogue: `product.read`;
- inventory: `inventory.read`;
- branch/settings administration: `settings.manage`;
- staff administration: `users.manage`.

A principal may enter the control centre when at least one built section is
authorized. The first selected section must itself be authorized; the UI may
not render a dashboard request for a principal who only holds inventory read.
The cashier shell shows the control-centre entry under the same rule.

This does not broaden any server permission. In particular, `inventory.read`
does not imply `settings.manage`, `inventory.adjust`, `inventory.transfer`,
`inventory.cost.read` or any purchasing permission.

## 6. UX and accessibility acceptance

5D-A must provide:

- Arabic labels and RTL/logical layout properties only;
- isolated LTR rendering for SKU and unit labels;
- tabular numeric rendering for exact quantities;
- touch targets of at least 44 px;
- a real loading state that never masquerades as an empty or zero balance;
- recoverable branch-load and balance-load failures;
- disabled loading actions so repeated clicks cannot create parallel page
  loads;
- native keyboard-accessible branch selection;
- responsive horizontal overflow for the data table;
- explicit empty state only after the selected branch has answered.

## 7. Security, performance and continuity

- Every read requires a live session and the exact `inventory.read`
  permission.
- Tenant scope is derived from the principal and enforced through the existing
  FORCE-RLS path. A foreign branch id returns no balance rows and no tenant
  metadata.
- Public limits and cursors remain validated and bounded.
- Reads support `AbortSignal`; branch changes discard stale responses.
- No query or render path is unbounded. Additional branches and balance rows
  require explicit pagination.
- 5D-A makes no offline claim. A network failure is shown as unavailable data,
  never as a cached zero or an authoritative empty stock state.

## 8. Proof required for 5D-A

- route refusal without session and without `inventory.read`;
- service-level permission refusal before persistence access;
- no tenant or mutation authority in the branch response;
- exact string preservation for quantity and revision beyond JavaScript safe
  integer range;
- product identity present on every returned balance row;
- cross-tenant branch probe returns no rows;
- client paths contain only branch, limit and cursor filters;
- permission-aware navigation and authorized initial section;
- first paint, ready, empty, failure and pagination UI states;
- RTL/bidi, touch and numeric component review;
- targeted tests, full `npm run verify`, `git diff --check`, normal CI and the
  applicable PostgreSQL proof green at the same delivered HEAD.

## 9. 5D-A delivery boundary

5D remains open after 5D-A. Closure requires all four bounded slices, a complete
UX/accessibility review, resolution of every C0/C1 finding, full verification,
independent review where required and the Human Gate. No progress percentage is
created from partial screen count.

## 10. 5D-B stock-operation contract

### Permission boundaries

- adjustment and absolute count affordances require `inventory.adjust`;
- transfer affordances require the separate `inventory.transfer` permission;
- the service repeats the same checks before touching persistence, so an
  internal caller cannot bypass the HTTP guard;
- `inventory.read` alone remains read-only and does not render mutation forms.

The current operational form records one product per document. This is a
bounded UI decision, not a server restriction: the established authority keeps
its bounded multi-line contract for scanners and future batch workflows.

### Exact intent

The browser converts a human decimal quantity to scaled integer text using
string and bigint arithmetic only. A unit product accepts whole quantities; a
weighted product accepts at most three decimals. A count may observe zero, a
transfer must be positive, and an adjustment must be non-zero and signed.

An adjustment sends a required merchant reason and signed delta. A count sends
the observed absolute quantity and the exact revision returned with the
selected balance; it never sends a derived delta. A transfer sends direction
and requested quantity; it never predicts either resulting balance. Optional
reasons are trimmed and become `null` when empty.

### Retry and concurrency behavior

The browser owns a synchronous command flight outside React state. The first
submit freezes the complete request and operation id before awaiting. A double
click cannot mint a second operation. A timeout, dropped connection or 5xx is
ambiguous and may resend only that frozen request under the same operation id.
A typed, rolled-back refusal retires the id before the merchant edits anything.
An idempotency conflict blocks further submission pending human review.
While a command is running, ambiguous, successful-but-unacknowledged by the
operator, or blocked, the branch selector and control-centre navigation remain
locked and page unload receives the browser's confirmation guard. The command
context is not silently discarded by ordinary navigation.

`stock_changed` clears the counted quantity, refreshes the server balance and
keeps controls disabled until that refresh finishes. The operator must recount
against the new revision; the UI must never silently rebase an old physical
observation. Successful operations refresh balances while preserving their
server document result and indicate whether the answer was an idempotent
replay.

Inactive branches are historical read-only views. Inactive or untracked
products are visible where history requires but are not offered as new command
lines. Only active loaded branches may be transfer destinations; the server
still revalidates all branch and product facts under its locks.

## 11. Proof required for 5D-B

- route and service permission refusal before persistence access;
- zero-balance active products visible without creating a database balance;
- a foreign branch id still returns no product or zero-balance rows;
- decimal-to-scaled conversion for signed, zero-count, weighted and unit edge
  cases without floating point;
- count payload contains the displayed revision and no delta;
- adjustment and transfer payloads contain no tenant, actor, before/after,
  movement-kind or resulting-revision authority;
- synchronous double-submit exclusion and frozen same-id retry after timeout;
- typed stale-stock, insufficient-stock and idempotency-conflict UX paths;
- permission-specific affordances, inactive historical view and loading locks;
- targeted tests, full `npm run verify`, `git diff --check`, normal CI and the
  PostgreSQL live proof green at one delivered HEAD.

## 12. 5D-C purchasing-operation contract

### Operational identity and permissions

`purchasing.read` exposes bounded, keyset-paged supplier, branch, product and
purchase-order identity needed to understand and state a purchasing intent. It
does not imply `product.read`, `inventory.read`, retail-price visibility or
stock-balance visibility. The purchasing product model therefore contains
identity, quantity shape, active state and inventory-tracking state only.
Inactive and untracked products remain readable for historical order identity
but are not offered for new order lines.

Supplier and purchase-order mutation affordances require
`purchasing.manage`; recording physical receipt evidence requires the separate
`purchasing.receive`. Every read and write permission is repeated in the
service before persistence access so an internal caller cannot bypass the HTTP
guard. UI checks only shape affordances.

### Suppliers and immutable orders

A supplier can be created, renamed, activated or deactivated. There is no
delete: existing orders and receipts remain evidence. Only an active supplier,
active branch and active inventory-tracked product are offered for a new
order, and the authority repeats those predicates under its locks.

An order may contain multiple distinct product lines. Human decimal quantities
are converted to canonical scaled integer strings without floating point;
unit products refuse fractions and weighted products accept at most three
decimal places. The browser submits supplier, destination branch, optional
reference, product identities and ordered quantities only. It never submits
received accumulators, remaining quantities, status, stock effects or audit
facts. Orders are immutable after creation and do not move stock.

### Partial receiving

The operator selects a server order and may accept any non-empty subset of its
remaining lines. The request names purchase-order line identities and accepted
quantities only; supplier, branch and product are derived from the locked order
rows. Displayed ordered, received and remaining quantities and order status are
server truth. The browser may prevent an obvious over-receipt using the last
read, but the locked server accumulator remains the authority under
concurrency.

5D-C intentionally omits `inventoryValueMinor` from its browser request type.
An unvalued receipt records explicit unknown cost through the established 5C
authority. Valued receiving is a separate 5D-D affordance requiring
`inventory.cost.manage`; 5D-C neither invents zero cost nor silently widens a
receiver's costing authority.

### Retry, refresh and continuity

Supplier mutations, order creation and receiving freeze their complete request
and operation id synchronously before the first await. A double submit cannot
mint a second command. A timeout, dropped connection or 5xx may resend only
the frozen command with the same id. A typed rolled-back refusal retires that
id before amendment. An idempotency conflict blocks further action pending
human reconciliation.

Inactive master data, a completed order, over-receipt and another state
conflict force bounded supplier/product/branch/order and selected-order detail
refresh before a new decision is allowed. While a command is running,
ambiguous, successful-but-unacknowledged or blocked, control-centre navigation,
POS navigation, logout and ordinary unload are guarded so command identity is
not silently discarded.

## 13. Proof required for 5D-C

- route and service refusal for every `purchasing.read`, `purchasing.manage`
  and `purchasing.receive` path before persistence access;
- bounded branch and product identity reads with FORCE-RLS tenant exclusion,
  inactive historical identity and no price or stock fields;
- exact multi-line order quantities beyond JavaScript safe integer range,
  fractional-unit refusal and duplicate-product refusal;
- receipt requests contain purchase-order line identity and accepted quantity
  only, with no tenant, actor, supplier, branch, product, status, accumulator,
  stock, cost or result authority;
- partial receipt, repeated partial receipt, final remainder, concurrent
  over-receipt, atomic rollback and idempotent replay remain green in the live
  PostgreSQL suite;
- synchronous double-submit exclusion, frozen same-id retry, typed conflict
  refresh and permission-specific affordances;
- loading, empty, failure, pagination, RTL/bidi, touch and exact numeric
  presentation review;
- targeted tests, full `npm run verify`, `git diff --check`, normal CI and the
  PostgreSQL live proof green at one delivered HEAD.

## 14. 5D-D cost-affordance contract

### Cost visibility

`inventory.cost.read` exposes a bounded branch/product valuation page. The
page contains operational product identity plus exact current facts:

- total `quantityScaled` from the stock balance;
- `knownQuantityScaled` and `knownValueMinor` from the cost pool;
- server-derived `unknownPositiveQuantityScaled`;
- stock and cost revisions.

All are decimal integer strings. The read never divides the pool into an
average or unit cost, never consults retail price, and never exposes tenant or
actor identity. An absent active-product balance is displayed as exact zero
without materialization. A materialized cost cursor that disagrees with its
stock revision is an invariant failure; the read must fail rather than label a
broken pool as unknown.

The cost endpoint requires `inventory.cost.read` independently of
`inventory.read`. In the current control-centre composition, cost facts are a
sub-workspace of the inventory section, so the browser needs `inventory.read`
to enter that section and `inventory.cost.read` to render the valuation page.
Neither server permission implies the other.

### Valued receiving

A receiver holding `inventory.cost.manage` may opt in separately on each
accepted purchase-order line and state one exact **total acquisition value for
that line's accepted quantity**. The amount is entered in SAR, converted by
string/bigint arithmetic and sent as canonical minor-unit text. It is not a
unit price, tax amount, invoice total or selling price.

Opt-in is explicit because omission and zero are different facts:

- unchecked/omitted `inventoryValueMinor` records unknown cost;
- checked `0.00` sends `"0"` and records known zero value.

Mixed valued and unvalued lines in one receipt remain valid. The browser does
not add product, branch, supplier, quantity accumulator, stock result, cost
pool or revision authority. The established receiving route and service both
repeat `inventory.cost.manage` whenever any line carries value.

### Prospective bootstrap

The bootstrap affordance requires cost visibility and
`inventory.cost.manage`. It selects from active tracked products whose last
read has positive unknown quantity, but that read is guidance rather than
write authority. The frozen command contains only operation id, branch,
product and exact total value. It never sends displayed quantity, current pool
or either revision.

Under the established 5C locks, the server derives the unknown positive
quantity at commit time and returns the exact quantity actually valued. The
UI preserves that result until explicit acknowledgement, refreshes valuation
facts, and makes clear that stock quantity and stock revision do not change.
Timeout or transport ambiguity can resend only the frozen same-id request;
idempotency conflict blocks; a changed/no-longer-valued state requires a fresh
cost read before a new decision.

Stock commands and bootstrap share the control-centre command lock. One
ambiguous or unacknowledged command cannot be abandoned by switching branch,
section, POS, logout or ordinary unload, and sibling mutation forms cannot
start concurrently from the same screen.

## 15. Proof required for 5D-D

- route and service refusal for `inventory.cost.read` and
  `inventory.cost.manage` before persistence access;
- bounded cost pages, exact strings beyond JavaScript safe integer range,
  non-materialized zero rows, foreign-branch exclusion and loud cursor
  divergence under live FORCE-RLS PostgreSQL;
- no tenant, retail price, average/unit cost or client-supplied valuation facts
  in the cost read path;
- explicit omitted-versus-known-zero receipt behavior, mixed valued/unvalued
  lines and exact totals beyond JavaScript safe integer range;
- valued receipt requests retain purchase-order line identity only and add no
  product, branch, supplier, tax, unit-price, stock, pool or revision fields;
- bootstrap requests contain value and identity only; synchronous double
  submit is excluded and timeout retry preserves the frozen operation/value;
- permission-specific cost and receipt affordances, inactive historical view,
  refresh locks, RTL/bidi, touch and exact numeric presentation;
- the existing live valued-receipt/bootstrap atomicity, replay, concurrency,
  overflow, rollback and tenant-isolation proofs remain green;
- targeted tests, full `npm run verify`, `git diff --check`, normal CI and the
  PostgreSQL live proof are green at one delivered HEAD.

## 16. Strike closure

Strike 5D closes only after 5D-A through 5D-D are delivered, the complete
inventory and purchasing workflow is reviewed end to end, every required gate
is green at one HEAD, independent review is complete and the Human Gate is
approved.
