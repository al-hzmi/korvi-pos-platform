# ADR-0023 — Guided onboarding is a projection of live readiness

Status: Accepted

## Context

Strike 4D already has two authorities that must not be duplicated in the browser:

- `GET /v1/admin/onboarding/readiness` derives current readiness from tenant, settings, branch, terminal, viable-administrator and active-product truth.
- Existing merchant administration and catalogue routes own the writes that can satisfy those checks.

A wizard that persisted `step`, `completed`, `ready` or `onboardingCompletedAt` would create a second truth. It could remain green after the last terminal or product was disabled. A browser that independently inferred readiness from several list calls would be the same defect in a different place.

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

## Consequences

- There is no onboarding state migration and no repair job for stale completion flags.
- The same administration screens remain useful after onboarding; the wizard does not become a dead-end parallel control panel.
- A merchant can always see which current system fact is missing, subject to their session permissions.
- Product creation closes the `active-product` gap without pulling inventory quantities or purchasing into Strike 4D.
