# Korvi Acquisition Evidence Index

Exact source SHA: `61dbb34dea08809756fd767b907b0e852b7e5978`

## GitHub exact-SHA evidence

All runs below completed successfully on the exact source SHA.

| Evidence | Run ID |
|---|---:|
| CI — push | 35788189407 |
| CI — PR | 35788194829 |
| PostgreSQL restricted-role / live proof | 35788189451 |
| DR PostgreSQL restore proof | 35788189485 |
| Incident outage/recovery proof | 35788189450 |
| Cashier browser sale proof | 35788189607 |
| Installed Cashier Windows proof | 35788194784 |
| Installed Cashier Android proof | 35788194966 |
| ZATCA 38 UBL hash proof | 35788189408 |
| ZATCA 38 official validator boundary | 35788189552 |
| ZATCA 39 C14N native cross-check | 35788189482 |
| ZATCA 39 public validator probe | 35788189427 |
| ZATCA 39 sealing cryptographic proof | 35788189346 |
| ZATCA 39 CSID PostgreSQL proof | 35788189464 |
| ZATCA 40 submission PostgreSQL proof | 35788189391 |

The exact commit is GitHub-verified/signed.

## Hosted staging evidence

Provider: Render — evaluation/staging only.

- API service: `korvi-staging-api`
- API service ID: `srv-dafasa1t0dsc73dbumbg`
- API deploy ID: `dep-daphbcek1f9s7391th4g`
- API deploy status: LIVE
- API deploy SHA: `61dbb34dea08809756fd767b907b0e852b7e5978`
- API health: HTTP 200 after deployment

- Web service: `korvi-staging-web`
- Web service ID: `srv-dafashn40ujc73ag1540`
- Web deploy ID: `dep-daphc8mk1f9s73921c80`
- Web deploy status: LIVE
- Web deploy SHA: `61dbb34dea08809756fd767b907b0e852b7e5978`

During API deployment, Prisma reported 35 migrations and an up-to-date schema after applying the canonical lineage.

## Operator-observed hosted smoke evidence

On the hosted canonical staging deployment, an operator manually exercised:

- full electronic tender sale;
- mixed cash + electronic tender sale;
- original-sale return/refund;
- inventory restoration behavior;
- blind shift close;
- cash reconciliation variance detection;
- clean cash reconciliation with expected = counted and variance = 0.

This is useful evaluation evidence, but it is **staging/operator evidence**, not Merchant Production Pilot evidence.

If transaction diligence requires immutable screenshots/video, export and checksum those artifacts into the buyer data room outside the public repository. Do not commit sensitive merchant/customer data.

## Evidence packaging caveat

Some older canonical documents point to earlier ancestor checkpoints such as `48400d02...`. Those remain historical evidence, but this index should be used first for the final buyer-evaluable SHA.

No production-provider, real merchant, legal transfer or Production ZATCA evidence is asserted here.
