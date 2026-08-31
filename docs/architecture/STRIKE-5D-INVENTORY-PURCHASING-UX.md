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

The active slice is **5D-A**. No mutation UI is implied by this first slice.

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

Product identity is joined on the server. The client must not issue an
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

## 9. Strike closure

5D remains open after 5D-A. Closure requires all four bounded slices, a complete
UX/accessibility review, resolution of every C0/C1 finding, full verification,
independent review where required and the Human Gate. No progress percentage is
created from partial screen count.
