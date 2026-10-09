# ADR-0023 — Guided onboarding is a projection of live readiness

Status: Accepted

## Context

Strike 4D already has two authorities that must not be duplicated in the browser:

- `GET /v1/admin/onboarding/readiness` derives current readiness from tenant, settings, branch, terminal, viable-administrator, viable POS-operator and active-product truth.
- Existing merchant administration and catalogue routes own the writes that can satisfy those checks.

A wizard that persisted `step`, `completed`, `ready` or `onboardingCompletedAt` would create a second truth. It could remain green after the last terminal or product was disabled. A browser that independently inferred readiness from several list calls would be the same defect in a different place.

A tenant-level active branch and terminal are necessary but not sufficient for daily operation. The POS session derives its branch from the active member's `defaultBranchId`, and the operator still needs effective product, sale and shift authority. Therefore readiness must not call a merchant operational merely because a terminal exists somewhere in the tenant while no active, credentialed member can actually use one.

## Decision

The Control UI is guided, not authoritative.

1. The home surface reads the readiness endpoint exactly as the authenticated merchant session permits it to.
2. It renders no readiness verdict before the server answers.
3. Each incomplete check links only to an already-authorized merchant surface. Navigation never grants permission and the destination API remains the authority.
4. Tenant lifecycle remains a control-plane concern; the merchant UI does not manufacture an activation action.
5. Product onboarding uses `POST /v1/admin/products`. The browser sends catalogue facts only. Tenant, actor, active state, inventory tracking, default VAT and history remain server-derived.
6. Human price input is converted through Korvi's existing exact SAR parser to a minor-unit integer string. No floating-point conversion is introduced.
7. The first product is not special persisted state. Once created and active, the existing readiness query observes it. If it is later deactivated, readiness becomes incomplete again.
8. Users without `product.write` may view the catalogue but receive no product-create affordance. The server still enforces `product.write` independently.
9. `pos-operator` is a separate live readiness invariant. It is true only when one credentialed active member is assigned to an active default branch that has an active terminal and that same member effectively holds `product.read`, `sale.create`, `shift.open` and `shift.close`. A terminal on another branch or permissions split across different users does not satisfy it.
10. `viable-administrator` remains independent from `pos-operator`. Initial owner bootstrap is allowed to establish administrator viability before any branch exists; onboarding must not weaken or reopen that one-time bootstrap authority to solve branch assignment.

## Consequences

- There is no onboarding state migration and no repair job for stale completion flags.
- The same administration screens remain useful after onboarding; the wizard does not become a dead-end parallel control panel.
- A merchant can always see which current system fact is missing, subject to their session permissions.
- Product creation closes the `active-product` gap without pulling inventory quantities or purchasing into Strike 4D.
- Readiness no longer reports a merchant ready when every tenant-level resource exists but no user can enter the actual POS lifecycle on the branch bound to their session.
- `TenantMembership.defaultBranchId` remains nullable. Null is legitimate for non-POS administration; operational readiness is the place that requires at least one usable POS assignment.
