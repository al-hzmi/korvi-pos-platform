# Strike 5A — Stock Ledger Integrity

Status: **IMPLEMENTATION CONTRACT — C0 DATA INTEGRITY**

Parent: ADR-0024

## Objective

Turn Korvi's existing inventory foundation into the authoritative merchant-facing stock mutation layer for:

1. manual adjustments,
2. absolute stock counts,
3. atomic branch transfers,
4. branch/product balance reads with concurrency revision evidence,

while preserving checkout and original-sale return stock semantics exactly.

This strike is intentionally **not** purchasing, receiving, costing, offline inventory or UI.

## Existing truth that must be preserved

- `inventory_movements` is the causal stock ledger.
- `inventory_balances` is the transactional materialized quantity.
- Quantity is signed BIGINT scaled by 1000.
- Sale stock movements commit inside the sale transaction.
- Return stock movements commit inside the return transaction.
- RLS/tenant scope is mandatory.
- `applyMovementWithin` already uses database mutation semantics to stop concurrent negative stock when configured.
- Existing migrations are immutable.

## Required architecture

### A. Balance revision

Add `revision BIGINT NOT NULL DEFAULT 0` to `inventory_balances` in a new forward migration and Prisma schema.

Rules:

- Every committed quantity-changing movement increments revision exactly once.
- A newly created balance produced by its first movement has revision `1`.
- Existing migrated balances remain revision `0`; do not fabricate history.
- A zero-delta count records count evidence but does not create a movement and does not increment revision.
- Sale and return paths must use the revised shared movement primitive and therefore increment revision too.
- Domain/browser/API boundaries represent revision as a decimal integer string, never Number.

Update `InventoryBalance` to expose revision.

### B. Finalized adjustment document

Add tenant-owned immutable-through-authority models equivalent to:

- `InventoryAdjustment`
  - id UUIDv7
  - tenantId
  - branchId
  - operationId
  - requestHash
  - reason (required, bounded)
  - actorUserId
  - occurredAt
  - createdAt
- `InventoryAdjustmentLine`
  - id UUIDv7
  - tenantId
  - adjustmentId
  - productId
  - deltaQuantityScaled
  - beforeQuantityScaled
  - afterQuantityScaled
  - resultRevision

Required constraints:

- tenant-consistent composite foreign keys,
- unique `(tenantId, operationId)`,
- unique product per adjustment,
- non-zero delta,
- indexes begin with tenantId,
- strict FORCE RLS.

The adjustment header, lines, movements, balances, audit event and idempotency reservation complete in one transaction.

### C. Finalized stock count document

Add tenant-owned models equivalent to:

- `InventoryCount`
  - id, tenantId, branchId, operationId, requestHash, reason nullable/bounded, actorUserId, occurredAt, createdAt
- `InventoryCountLine`
  - id, tenantId, countId, productId
  - expectedRevision
  - beforeQuantityScaled
  - countedQuantityScaled
  - deltaQuantityScaled
  - resultRevision

Rules:

- Client submits absolute `countedQuantityScaled` and `expectedRevision` only.
- Counted quantity is non-negative.
- Server materializes an absent balance as zero if needed, takes the balance row lock, verifies revision, then derives delta.
- If current revision differs, fail with a typed `stock-changed`/equivalent conflict and write **nothing**.
- Unit products require whole-unit scaled counts.
- Weighted products may use the fixed 1000 scale.
- If derived delta is zero: finalize count evidence + audit + idempotency, but write no inventory movement and leave balance revision unchanged.
- If delta is non-zero: movement kind remains `adjustment`, sourceType identifies stock count, and balance revision increments once.

### D. Finalized atomic transfer document

Add tenant-owned models equivalent to:

- `InventoryTransfer`
  - id, tenantId, fromBranchId, toBranchId, operationId, requestHash, reason nullable/bounded, actorUserId, occurredAt, createdAt
- `InventoryTransferLine`
  - id, tenantId, transferId, productId, quantityScaled
  - sourceBefore/AfterQuantityScaled
  - destinationBefore/AfterQuantityScaled
  - sourceResultRevision
  - destinationResultRevision

Rules:

- source != destination,
- both branches exist, are in tenant, and are active,
- product exists, is active, and `trackInventory=true`,
- quantity is positive; unit products require whole units,
- duplicate product lines are refused,
- transfer source never becomes negative, regardless of checkout oversell setting,
- two movement legs per line: negative source + positive destination, both `kind='transfer'`, both caused by the same transfer document/line,
- no one-sided transfer may commit.

### E. Canonical locking

Multi-row stock operations must be deadlock-resistant by design.

- Materialize required missing balance rows at zero using conflict-safe inserts.
- Lock every `(branchId, productId)` balance row needed by the operation in one deterministic canonical order, e.g. lexical `(branchId, productId)` order after tenant scoping.
- Perform all predicates and mutations after locks are held.
- Count, transfer and multi-line adjustment must not use client/read-side preflight as concurrency authority.

Sale/return paths may retain their existing single-row atomic update semantics, but regression tests must prove they remain compatible with the new revision column and concurrent Stage-5 operations.

### F. Idempotency

Use Korvi's existing `idempotency_keys` doctrine.

Scopes:

- `inventory-adjustment`
- `inventory-count`
- `inventory-transfer`

Requirements:

- public request includes operationId,
- request hash is canonical and independent of JSON property order,
- line order must not change intent: canonicalize/sort by product identity before hashing,
- same operation + same request replays the committed document/result,
- same operation + different request returns conflict,
- simultaneous duplicate submissions produce exactly one committed operation,
- reservation/result and mutation commit atomically.

Do not use a check-then-write race.

### G. Permissions

Keep:

- `inventory.read`
- `inventory.adjust`

Add:

- `inventory.transfer`

Canonical default grants:

- cashier: no new grant,
- manager: `inventory.transfer`,
- admin: inherits manager,
- owner: all permissions.

New forward migration must:

1. insert the global permission catalogue row idempotently,
2. grant it to existing **system** manager/admin/owner roles only,
3. not grant it to custom roles,
4. preserve future provisioning through updated `ROLE_PERMISSIONS`.

Server authorization is permission-based, never role-name based.

### H. API surface

Authenticated merchant administration API only.

Required routes (names may vary only if existing routing conventions demand it):

- `GET /v1/admin/inventory/balances?branchId=...&limit=...&cursor=...`
  - requires `inventory.read`
  - server-derived tenant
  - bounded/keyset pagination
  - returns quantityScaled + revision as strings
- `POST /v1/admin/inventory/adjustments`
  - requires `inventory.adjust`
- `POST /v1/admin/inventory/counts`
  - requires `inventory.adjust`
- `POST /v1/admin/inventory/transfers`
  - requires `inventory.transfer`

Forbidden client authority fields include at minimum:

`tenantId`, `actorUserId`, `userId`, `movementKind`, `kind`, `beforeQuantityScaled`, `afterQuantityScaled`, `deltaQuantityScaled` on a count, `resultRevision`, `currentRevision`, `isFinalized`, `status`, audit fields and any resulting balance.

Adjustment delta is legitimate input; count delta is not.

Use strict body schemas and bounded strings/line counts. Return actionable Arabic messages but do not reveal cross-tenant existence.

### I. Product/branch rules

- Missing/cross-tenant branch/product fails closed.
- Inactive branch cannot accept new adjustment/count/transfer operations.
- Inactive product cannot be newly mutated through these merchant operations.
- `trackInventory=false` products cannot be adjusted/counted/transferred through stock authority.
- Negative adjustment obeys tenant `allowNegativeStock` at the locked mutation.
- Transfer source never goes below zero.

### J. Audit

One privileged audit event per finalized document, in the same transaction.

Suggested event types:

- `inventory.adjustment.finalized`
- `inventory.count.finalized`
- `inventory.transfer.finalized`

Audit metadata may contain safe counts/reason/branch references/operation reference, but never credentials or secret material. Do not duplicate the entire request body into audit.

### K. Existing movement causality

Do not rewrite historical movements.

New Stage-5 movements must carry stable source causality pointing to their finalized document. If a schema addition such as a nullable source-line/causality identifier is necessary to make each transfer leg/line unambiguous, add it forward-only and leave historical rows null rather than inventing provenance.

### L. No costing in 5A

Do not add inventory value, average cost, COGS, supplier cost, PO or receipt tables in this strike. Those are 5B/5C.

Do not derive cost from `Product.priceMinor`.

## Required tests

### Pure/domain

Prove at minimum:

- integer-string quantity validation,
- unit vs weighted quantity rules,
- duplicate-line rejection,
- canonical request fingerprint stability across line order/property order,
- adjustment/count/transfer request invariants,
- no float/Decimal path introduced.

### API

Prove at minimum:

- session required,
- exact permissions required,
- tenant/actor/result authority fields refused,
- count refuses client-supplied delta/result,
- transfer uses `inventory.transfer`, not role name,
- typed conflicts map to stable HTTP statuses/messages,
- balance pagination is bounded and tenant identity cannot be supplied.

### Live PostgreSQL C0 gate

On a fresh database with application role `NOSUPERUSER NOBYPASSRLS`, prove at minimum:

1. migration from zero and no schema drift,
2. RLS isolation for every new table,
3. adjustment atomically writes document + lines + movement + balance/revision + audit + idempotency,
4. multi-line adjustment fully rolls back if one line fails,
5. same-intent replay returns same result and does not duplicate movements,
6. different-intent replay conflicts,
7. simultaneous duplicate requests commit once,
8. negative adjustment cannot race below zero when disabled,
9. count with correct revision derives exact delta under lock,
10. zero-delta count writes evidence but no movement/revision increment,
11. stale count revision after a concurrent sale/return/adjustment fails with zero residue,
12. transfer writes exactly two legs per product and conserves total tenant quantity,
13. insufficient transfer writes neither leg and changes neither balance,
14. opposite-direction concurrent transfers complete without deadlock and preserve conservation,
15. sale concurrent with transfer cannot oversell when sale negative stock is disabled,
16. checkout stock movement remains in the sale transaction and increments revision,
17. original-sale return stock reversal remains in the return transaction and increments revision,
18. cross-tenant IDs do not disclose or mutate foreign rows,
19. existing system roles receive only the intended new permission after migration; custom roles do not,
20. failure injected after movement/balance writes rolls back document, ledger, balance, audit and idempotency together.

Use time bounds on concurrency tests so a deadlock becomes a test failure rather than a hung suite.

## Verification order

If Prisma schema changes:

1. create forward migration,
2. `prisma generate`,
3. build affected packages,
4. targeted tests,
5. fresh PostgreSQL live tests,
6. `npm run verify`.

The generated client must be current before TypeScript build/live tests.

## Implementation discipline

- No destructive git commands.
- Do not rewrite existing migrations.
- Do not change dependency/toolchain versions.
- Do not commit or push.
- Do not disable tests, lint, RLS, constraints or invariants to obtain green output.
- Do not implement 5B/5C/5D.
- Do not claim Production Ready or ZATCA compliance.
- If an architectural conflict makes the contract unsafe, stop and report the exact blocker instead of improvising a weaker design.

## Completion report

Return:

- exact files changed,
- migration name,
- authority/lock order used,
- idempotency design,
- permission migration behavior,
- targeted/live/full verification results,
- any unresolved blocker or skipped test with reason.

A C0 strike is not approved by its writer. ChatGPT performs independent diff review and the final Human Gate before merge.
