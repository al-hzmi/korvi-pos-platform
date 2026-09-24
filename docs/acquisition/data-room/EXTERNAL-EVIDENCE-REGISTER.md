# External Evidence Register

This register tracks evidence that is real but not fully represented by immutable repository workflow runs.

## Render staging alignment

Verified after the independent audit:

| Item | Evidence |
|---|---|
| API branch | `release/canonical-acquisition-v1` |
| API SHA | `61dbb34dea08809756fd767b907b0e852b7e5978` |
| API deploy | `dep-daphbcek1f9s7391th4g` — LIVE |
| Web branch | `release/canonical-acquisition-v1` |
| Web SHA | `61dbb34dea08809756fd767b907b0e852b7e5978` |
| Web deploy | `dep-daphc8mk1f9s73921c80` — LIVE |
| Auto deploy | OFF for both services |
| API health | HTTP 200 after deployment |
| DB engine | PostgreSQL 17 |
| DB staging plan | free |
| DB HA | disabled |
| DB expiration reported by provider | 2026-10-07 |

This proves evaluation staging alignment only.

## Manual hosted commercial smoke

Operator-observed on the canonical staging environment:

- electronic sale;
- mixed cash/electronic sale;
- electronic original-sale refund;
- return inventory effect;
- blind shift close;
- variance detection;
- clean reconciliation with zero variance.

Classification: **HOSTED STAGING / HUMAN-OBSERVED**.

It does not close Production Operations or Merchant Pilot gates.

## Acquisition packaging action

Before a real transaction diligence room is shared, export the relevant screenshots/video/provider pages into a private buyer folder and create checksums. Do not place secrets, customer PII, credentials, private keys or production merchant data in the public repository.
