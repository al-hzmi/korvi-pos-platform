# ADR-0039 — Batch, Lot and Expiry Provenance Authority

Status: **ACCEPTED FOR MASTERMIND V2-4**
Date: 2026-09-29
Strike: **V2-4 — Batch / Lot / Expiry**
Branch: `mastermind/v2-strengthening`
Issue: **#77**

## Context

Korvi already has one authoritative stock total and one costing truth:

- `InventoryBalance` is one tenant/branch/Product materialized quantity with monotonic revision;
- `InventoryMovement` is the immutable causal quantity ledger;
- the costing ledger records known/unknown quantity and value provenance against those movements;
- sale, return, receipt, adjustment, count, transfer, production and waste ultimately affect that same stock/cost authority;
- V2-3 packages remain commercial metadata and convert into base Product quantity before stock/cost mutation.

The repository currently has no lot, manufacturer batch, expiry or best-before authority.

V2-4 must add lot distribution and historical provenance without creating another warehouse balance or cost pool.

## Decision

### 1. Scope and constitutional rule

V2-4 establishes:

- tenant-owned Product lot identity;
- optional manufacturer/supplier batch reference;
- optional expiry or best-before date;
- per-Product lot tracking policy;
- deterministic automatic outgoing lot selection;
- immutable lot distribution entries correlated to canonical inventory movements;
- explicit zero-net lot reclassification for count/correction cases;
- receiving, sale, return, transfer, adjustment, count, production-consumption and waste compatibility;
- Expiry Intelligence-ready read facts.

The constitutional rule is:

**InventoryBalance + InventoryMovement remain the only Product stock total and quantity-changing ledger.**

There is no `InventoryLotBalance` table and no lot-level cost pool.

Lot availability is a derived distribution of the canonical Product balance.

### 2. Product lot policy

A Product may have zero or one ProductLotPolicy.

Policy fields:

- tenantId / productId;
- trackingMode: `none | required`;
- selectionPolicy: `fefo | fifo`;
- dateRequirement: `optional | required`;
- revision;
- created/updated facts.

Lot tracking requires Product.trackInventory = true.

Both unit and weighted Products may be lot controlled because the existing scaled-integer quantity model already supports exact base quantities for each.

Enabling lot tracking is a governed policy transition under optimistic revision and audit.

If existing branch stock is positive when tracking is enabled, Korvi must not invent a manufacturer batch or expiry date. The activation transaction creates explicit **historical-unknown lot provenance** for that quantity.

If any branch has negative stock, tracking activation is refused until stock is reconciled; a negative physical lot quantity has no truthful interpretation.

### 3. Lot identity

InventoryLot is tenant-owned and Product-owned identity metadata, not a balance.

Required facts:

- id, tenantId, productId;
- internal immutable lot code;
- provenance: `received | produced | historical-unknown | manual-correction`;
- normalized external batch reference, nullable;
- dateKind: `expiry | best-before | null`;
- dateValue: date-only, nullable;
- status: `active | blocked | closed`;
- revision for status changes;
- createdAt / firstObservedAt.

firstObservedAt is the first time Korvi observed that lot identity. For a historical-unknown baseline it is **not** claimed to be an actual receipt time.

Product, external batch reference and date facts are immutable after lot creation.

A non-null external batch reference is unique per tenant/Product. A later receipt naming the same external batch must resolve that lot and must agree with its immutable date facts.

When no external batch reference exists, Korvi creates a distinct internal lot identity; two unknown batches are never silently merged.

### 4. Unknown is explicit

No batch reference means batch is unknown.

No date means expiry/best-before is unknown.

`historical-unknown` is an explicit provenance for pre-V2-4 on-hand quantity initialized when lot tracking is enabled.

Unknown never means:

- batch number `0`;
- expiry today;
- no expiry;
- zero available quantity.

### 5. Business date and expiry semantics

Expiry decisions are calendar-date decisions and must not silently use server UTC.

V2-4 adds tenant-owned `businessTimeZone` to TenantSettings. Existing Saudi-market tenants default to `Asia/Riyadh`.

The server derives an immutable operation `businessDate` from:

- authoritative operation timestamp;
- tenant businessTimeZone.

For a lot with `dateKind = expiry`:

- dateValue < businessDate => expired and ineligible for sale/ordinary consumption;
- dateValue >= businessDate => eligible if every other rule permits it.

For `best-before`:

- passing the date does not make the lot automatically unsellable;
- the date remains visible and participates in FEFO ordering;
- merchant policy/alerts may flag it, but V2-4 does not convert best-before into expiry.

Blocked and closed lots are never auto-selected for sale.

Returns may restore an original historical lot even if that lot is currently blocked/closed; current policy cannot rewrite the original sale provenance.

### 6. Immutable lot distribution ledger

V2-4 adds InventoryLotEntry as an immutable signed quantity-distribution fact.

It carries:

- tenantId, branchId, productId, lotId;
- signed quantityScaled;
- causeKind: `tracking-baseline | movement | reclassification`;
- inventoryMovementId nullable;
- reclassificationId nullable;
- source document identity/line where applicable;
- actor and occurredAt.

Availability for one branch/Product/lot is the sum of its lot entries.

Availability across every lot for a tracked branch/Product must reconcile to the canonical InventoryBalance quantity after the tracking baseline.

Lot entries never carry monetary cost.

### 7. Canonical movement reconciliation

For a lot-controlled Product, every non-zero canonical InventoryMovement after tracking activation must have lot entries whose signed quantities:

- use the same sign as the movement;
- are non-zero;
- reference lots of the same tenant/Product;
- sum exactly to InventoryMovement.quantityScaled.

The movement remains the stock mutation.

Lot entries explain which lots that movement distributed the quantity across.

The repository writes the movement and its lot entries in one transaction.

### 8. Baseline when tracking is enabled

Tracking activation locks the Product and all existing InventoryBalance rows for it.

For each branch:

- zero balance => no baseline lot entry;
- positive balance => one historical-unknown lot identity may seed the branch distribution;
- negative balance => activation refuses.

The baseline entry equals the current canonical balance exactly and does not create an InventoryMovement because stock did not change.

This is explicit provenance initialization, not fabricated history.

### 9. Deterministic outgoing selection

Automatic selection supports:

- FEFO;
- FIFO.

Both are deterministic and evaluated under lot identity locks.

FEFO:

1. exclude blocked/closed lots;
2. exclude expired `expiry` lots;
3. known dateValue ascending;
4. unknown date last;
5. firstObservedAt ascending;
6. lot id ascending as final tie-break.

FIFO:

1. exclude blocked/closed lots;
2. exclude expired `expiry` lots;
3. firstObservedAt ascending;
4. lot id ascending.

Allocation consumes each candidate up to its derived available quantity until the requested base quantity is satisfied.

If eligible availability is insufficient, the operation refuses. It never silently consumes an expired or blocked lot.

### 10. Concurrency authority

There is no mutable lot quantity counter to lock.

Before deriving availability, the transaction locks the candidate InventoryLot identity rows in deterministic id order.

After those locks are held, it sums immutable InventoryLotEntry facts for those lots, derives availability, selects allocations and appends the new entries.

Any concurrent consumer needing the same lot must wait for the same lot row lock and then sees the earlier committed entries.

This makes derived availability concurrency-safe without a second stock balance.

The existing InventoryBalance lock remains the Product total authority. Lock order is:

1. document/shift/policy locks already required by the operation;
2. InventoryBalance rows in canonical branch/Product order;
3. InventoryLot rows in canonical lot-id order;
4. append InventoryMovement;
5. append reconciled InventoryLotEntry facts.

### 11. Receiving

For a Product with trackingMode=required, a positive purchase receipt must carry one or more lot allocations.

Each allocation states only:

- accepted base/commercial quantity as allowed by the existing V2-3 package authority;
- external batch reference or explicit absence;
- optional dateKind/dateValue.

The server:

- validates policy/date requirement;
- resolves or creates immutable lot identity;
- writes the canonical positive InventoryMovement;
- writes positive lot entries that sum exactly to that movement;
- writes immutable PurchaseReceipt lot snapshot rows.

Costing remains the existing receipt value authority and is not split into a new lot cost pool.

### 12. Sale and other outgoing consumption

For lot-controlled tracked Products, normal sale checkout does not accept cashier-authored lot quantities in V2-4.

The server selects lots automatically using the Product lot policy at commit time.

SaleLine gets immutable child SaleLineLotAllocation snapshots:

- lotId;
- internal lot code;
- external batch reference nullable;
- dateKind/dateValue nullable;
- base quantity consumed.

The corresponding negative lot entries match the canonical sale InventoryMovement exactly.

Recipe production consumption and waste use the same automatic selector.

If a produced output Product is lot-controlled, production must state/create an output lot; otherwise production refuses rather than placing quantity into an unknown current lot silently.

### 13. Original-sale returns

Return pricing and cost restoration remain owned by the immutable SaleLine under ADR-0016/V2-3.

For lot-controlled historical sale lines, ReturnLine copies the original SaleLineLotAllocation facts proportionally/exactly for the returned commercial quantity.

The positive return InventoryMovement receives positive lot entries for those original lots.

Current lot status/date policy does not redirect a historical return to a different lot.

If a legacy sale has no lot allocation because it predates V2-4, Korvi records restored lot provenance as historical-unknown rather than inventing the original batch.

### 14. Transfers

A transfer of a lot-controlled Product:

- auto-selects source lots under policy/locks;
- source canonical movement gets negative lot entries;
- destination canonical movement gets matching positive entries for the same lot identities and quantities;
- total Product stock still changes only through the two existing transfer movement legs.

No new destination lot identity is invented for a transfer.

### 15. Adjustments

Negative adjustments auto-select eligible lots unless the governed lot-correction surface supplies explicit lot identities.

Positive adjustments require explicit lot provenance:

- existing lot identity; or
- new manual-correction lot with explicit unknown/date facts.

A positive adjustment may not silently increase an arbitrary current lot.

### 16. Counts and zero-net lot reclassification

A lot-controlled physical count must include per-lot observations.

The sum of counted lot quantities must equal the counted Product quantity.

If Product total changes, the existing canonical count derives/writes the Product InventoryMovement and lot entries explain the lot deltas.

If Product total is unchanged but the observed distribution between lots changed, Korvi writes an InventoryLotReclassification document:

- one branch/Product;
- expected InventoryBalance revision;
- reason;
- immutable signed lot lines;
- signed lot lines sum exactly to zero;
- no InventoryMovement is written because Product stock did not change.

This is distribution correction, not a second stock movement.

### 17. Offline boundary

A cached Product records whether lot tracking is required.

V2-4 does not invent a signed full lot-availability snapshot.

Therefore:

- non-lot-controlled ordinary offline sales continue unchanged;
- a lot-controlled Product may be browsed/scanned offline, but checkout cannot be finalized/queued offline because the client cannot prove current lot availability or expiry eligibility;
- reconnect re-runs server lot selection under current authoritative locks.

A future signed lot snapshot may extend offline availability under a separate ADR.

### 18. Permissions and audit

V2-4 adds `lot.manage` for:

- lot policy activation/change;
- block/unblock/close lot lifecycle;
- governed lot reclassification/correction.

Existing `purchasing.receive` authorizes receiving lot facts for a purchase receipt.

Automatic sale/production/waste lot selection requires no extra permission beyond the parent operation.

Every lot policy mutation, lot lifecycle mutation, baseline initialization and reclassification is audited.

### 19. RLS and tenant consistency

ProductLotPolicy, InventoryLot, InventoryLotEntry, lot reclassification and document snapshot tables are tenant-owned and FORCE-RLS protected.

Composite foreign keys include tenantId and Product identity where needed so PostgreSQL itself refuses:

- cross-tenant lot use;
- a lot attached to another Product;
- a lot entry whose branch/Product/movement provenance disagrees.

Finalized lot entry and historical document snapshot rows are append-only.

### 20. Expiry Intelligence boundary

V2-4 exposes deterministic read facts such as:

- on-hand quantity by lot;
- days to expiry/best-before;
- expired quantity;
- quantity with unknown date;
- soonest eligible expiry.

These are read models over authoritative facts.

Expiry Intelligence may later recommend markdown, transfer or waste actions, but it cannot mutate stock, select sale lots outside the deterministic policy, or create adjustments autonomously.

### 21. ZATCA/tax boundary

Lot/batch/expiry metadata is inventory provenance only.

The existing sale pricing/VAT/invoice/fiscalization authority remains unchanged.

Production ZATCA stays fail-closed.

Lot metadata may be printed/displayed where useful but never changes VAT arithmetic or invoice authority.

## Data model direction

V2-4 adds:

- TenantSettings.businessTimeZone;
- ProductLotPolicy;
- InventoryLot;
- InventoryLotEntry;
- InventoryLotReclassification + lines;
- PurchaseReceiptLotAllocation;
- SaleLineLotAllocation;
- ReturnLineLotAllocation;
- additive lot-aware request/snapshot fields for adjustment/count/transfer/production paths as required.

It does **not** add:

- InventoryLotBalance;
- lot cost balance;
- mutable expiry quantity counters;
- a second inventory movement ledger.

## Implementation order

1. pure lot/date/FEFO/FIFO/reconciliation domain contract + adversarial tests;
2. schema/migration/FORCE-RLS/immutability/backward-compatibility;
3. lot availability and movement-allocation repository authority;
4. lot policy administration + baseline initialization;
5. purchase receiving;
6. sale + historical snapshots + returns;
7. transfer / adjustment / count reclassification;
8. production consumption/output + waste;
9. offline fail-closed boundaries;
10. Arabic RTL Control/Cashier/receiving UX;
11. PostgreSQL live concurrency/RLS/migration proof;
12. browser proof;
13. full CI;
14. exact-head governance reconciliation.

## Definition of Done

V2-4 is not complete until repository evidence proves every item in Issue #77.

## Consequences

This ADR deliberately chooses an immutable lot-distribution ledger plus identity-row locking over a mutable lot-balance table.

The cost is additional aggregate queries and locking discipline.

The benefit is architectural consistency: Korvi still has one stock total, one quantity-changing movement ledger and one costing truth, while lot/expiry provenance becomes exact, auditable and concurrency-safe.
