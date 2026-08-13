# KORVI POS — Architecture Map

Status: **TARGET ARCHITECTURE + CURRENT BOUNDARIES**

## 1. Layering

```text
apps/pos-web ───────┐
                    ├── packages/ui
apps/api ───────────┼── packages/database ───┐
                    ├── packages/printing ────┼── packages/domain
                    └── packages/testing      │
packages/config ──────────────────────────────┘ (configuration, no business authority)
```

`@korvi/domain` is the pure authority for deterministic business/financial rules and depends on no framework. Apps orchestrate. Database adapters persist. Printing converts approved invoice/receipt facts to device output. UI renders, never invents business truth.

## 2. Authority map

| Truth | Authority | Never authoritative |
|---|---|---|
| Money/tax/allocation | Domain | browser floats, display formatting |
| Final sale/return/shift snapshot | Transactional DB through domain ports | client payload reconstruction |
| Tenant identity | Authenticated server context/RLS | request tenantId |
| Actor identity/permissions | Session/RBAC | client role/user fields |
| Inventory | One stock movement/ledger authority | UI counters or catalogue flags alone |
| Promotions | Deterministic domain decision + sale snapshot | current rule after sale |
| Payment | Tender domain + PSP adapter reference | raw card data |
| Regulatory state | Compliance workflow/gate | QR presence alone |

## 3. Bounded domains

### Transaction Core
Catalogue read → cart/pricing → tender → checkout → immutable sale → return/refund → drawer → close/reconciliation. Every C0 mutation is idempotent, tenant-scoped, audited where applicable, and transactionally atomic.

### SaaS Control Plane
Tenant lifecycle, entitlement, branch/terminal/user administration, settings, onboarding, safe suspension/reactivation, and operational account state. It owns *who may operate the platform and under what commercial/tenant state*; it does not own sale arithmetic.

### Inventory/Purchasing
One stock truth and one costing foundation. Sales, returns, receiving, adjustments, transfers, and restaurant ingredient consumption all post causally identifiable movements.

### Vertical Experience
Retail/grocery and restaurant present specialized workflows over shared platform authorities. Vertical modules may add specialized domain records but cannot fork tenant, money, inventory, audit, identity, or compliance truth.

### Compliance
Invoice facts → canonical regulatory representation → signing/security artifacts → submission/reporting/clearance state → retry/failure handling → evidence. Regulatory implementation is isolated from generic checkout while consuming immutable sale/invoice facts.

### Offline/Device Continuity
Local operation queue, identity/session constraints, deterministic IDs, idempotent synchronization, conflict policy, retry/dead-letter, device recovery. Offline capability is declared per operation.

### Integrations
Adapter boundary around PSPs, ecommerce/delivery, future ERP/accounting, and external services. External identifiers and mapping are explicit. Integrations cannot mutate finalized internal truth without a governed compensating business operation.

### Intelligence
Analytics and Command Center consume operational truth. Guardian/anomaly detection produces evidence-backed signals, not irreversible accusations or silent financial actions.

### Product Knowledge
Global/shared product knowledge is separate from tenant catalogue and stock. Provenance, confidence, source, version, and merchant override rules are first-class.

### Supply Network
Seed external supplier identity/mapping/event seams early; defer network marketplace/order orchestration until preceding domains are stable.

## 4. Event boundary for future ERP

Korvi POS remains independently operable. Future ERP integration is outbound through immutable business/financial events and stable identifiers. ERP may map events to GL; POS must not call ERP to decide whether a sale, refund, shift close, or stock movement is valid.

## 5. Concurrency and idempotency doctrine

Financial concurrency is serialized on explicit database rows/locks with documented lock order. Idempotency reservation and the business mutation commit together. Same operation + same server-bound intent may replay; same operation + different intent conflicts. Client-controlled actor/tenant/branch authority is forbidden.

## 6. Self-healing boundary

Allowed: reconnect, retry, rebuild cache, restart worker, rehydrate UI, rotate disposable runtime state, isolate unhealthy integrations. Forbidden: silently edit finalized financial records, stock history, regulatory invoices, reconciliation snapshots, or audit events.
