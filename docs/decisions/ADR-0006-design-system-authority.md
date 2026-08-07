# ADR-0006 — The design system is the authority

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

`KORVI-DESIGN-SYSTEM.md` was reverse-engineered from the working Korvi ERP
codebase: every value read from shipped code, every HEX computed rather than
estimated, the Tailwind config compiled and tested. It is a record of what
exists, not a proposal.

Korvi POS must look like the same product as Korvi ERP.

## Decision

The document is authoritative. Its values are transcribed into
`packages/config/tailwind-preset.cjs` and `packages/ui/src/styles/tokens.css`
without alteration.

Invariant, never changed without a superseding ADR: colours, fonts, border
radius, motion curve, the wordmark, RTL rules.

Deliberately different in POS, as the document itself prescribes (§12):

| Dimension     | ERP           | POS                                    |
| ------------- | ------------- | -------------------------------------- |
| Type scale    | 12–14px base  | 14–16px base                           |
| Button height | `h-10` (40px) | `h-touch` (44px) / `h-touch-lg` (48px) |
| Avatar shape  | circle        | rounded square                         |

Two points the document raises and this ADR settles:

- **The brand green is promoted to a token.** `--brand: 162.9 93.5% 24.3%`
  (`#047857`) and `--brand-on-dark: 158.1 64.4% 51.6%` (`#34D399`), replacing
  scattered `emerald-700` literals. The mark keeps ignoring the theme, because
  it must read the same on paper — and paper has no theme. The decimal place is
  load-bearing: rounding to integers yields `#027855`, a different colour from
  the one the print rule emits literally.
- **The wordmark stays text in-product.** `KorviMark`, not an image file. SVG
  assets exist in `packages/ui/assets/brand/` only for the places a component
  cannot reach: favicon, app icon, print vendors.

## Consequences

- A colour literal in a component is a lint failure, not a review comment.
- Adopting shadcn/ui later is cheap: the token names and format already match
  its convention exactly.
- Tailwind stays on v3 for now — see ADR-0007.
