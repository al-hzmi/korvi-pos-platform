# Documentation Drift Notice

Status: **BUYER INTERPRETATION CONTROL**

The repository intentionally preserves historical governance snapshots. Some of them predate the final canonical integration and therefore contain statements that are no longer current for source SHA `61dbb34dea08809756fd767b907b0e852b7e5978`.

## Known historical drift

### Capability Matrix

`docs/governance/KORVI-CAPABILITY-MATRIX.md` still contains older caveats such as:

- electronic/split tender UX requiring broader proof;
- installed application proof described as pending;
- Restaurant/KDS/recipe/waste capabilities described as not yet claimed in several rows;
- some Platform Admin/operator flows described as pending.

These statements are historical and must not override later canonical integration/evidence.

### Product Readiness Scorecard

`docs/governance/PRODUCT-READINESS-SCORECARD.md` preserves an older fixed 50-gate denominator and an 88/100 historical score.

That score remains useful as a historical governance snapshot, but it is **not the current acquisition verdict** and must not be presented as a current buyer score.

## Current interpretation authority

For acquisition diligence, read in this order:

1. exact repository state at `61dbb34dea08809756fd767b907b0e852b7e5978`;
2. exact-SHA CI / PostgreSQL / device / ZATCA evidence;
3. `docs/governance/KORVI-CANONICAL-ACQUISITION-RELEASE.md`;
4. `docs/acquisition/FINAL-ACQUISITION-GATE.md`;
5. this data-room overlay;
6. older capability/scorecard snapshots for historical traceability only.

## Why historical files are not rewritten on the source SHA

The acquisition candidate is frozen. Rewriting old documents solely for presentation would move the source SHA and force a new evidence cycle.

The correct approach is a separate due-diligence overlay that identifies historical drift without altering the buyer-evaluable source release.
