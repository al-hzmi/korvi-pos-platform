# KORVI — Evidence Artifact Retention Record

Source SHA: `61dbb34dea08809756fd767b907b0e852b7e5978`

Prepared: 2026-09-24

## Why this exists

GitHub Actions artifacts have retention windows. Several high-value acquisition proofs were approaching expiry even though the source SHA remains frozen.

A preservation copy was therefore downloaded without changing source code or rerunning the release.

## Preserved evidence archive

Archive name:

`Korvi_Acquisition_Evidence_61dbb34.zip`

Archive SHA-256:

`eda179635f566a761aa330e674ddd96486005fd015088686350b6e4d219cf151`

The archive contains the original downloaded ZIP artifacts plus:

- `README.md`;
- `MANIFEST.json`;
- `SHA256SUMS.txt`.

## Preserved artifact set

| Run | Artifact ID | Artifact | Original GitHub expiry |
|---:|---:|---|---|
| 35788189451 | 10721385042 | Strike 5C PostgreSQL proof | 2026-10-06 |
| 35788189485 | 10720069805 | Operations DR proof | 2026-10-22 |
| 35788189450 | 10721310131 | Incident outage/recovery proof | 2026-10-22 |
| 35788189607 | 10720779762 | Cashier browser sale proof | 2026-10-06 |
| 35788194784 | 10721840356 | NON-RELEASE Windows cashier artifact | 2026-09-29 |
| 35788194966 | 10720149380 | NON-RELEASE Android cashier artifact | 2026-09-29 |
| 35788189552 | 10720762817 | ZATCA 38 official-validator boundary | 2026-10-22 |
| 35788189482 | 10721115338 | ZATCA 39 C14N proof | 2026-10-22 |
| 35788189427 | 10720762850 | ZATCA 39 public-validator probe | 2026-10-22 |
| 35788189346 | 10720014261 | ZATCA 39 sealing proof | 2026-10-22 |
| 35788189464 | 10720004576 | ZATCA 39 CSID PostgreSQL proof | 2026-10-06 |
| 35788189391 | 10721650145 | ZATCA 40 submission PostgreSQL proof | 2026-10-22 |

## Classification

The archive is preserved **engineering/acquisition evidence**.

It does not become:

- Production Operations evidence merely by being archived;
- Merchant Production Pilot evidence;
- legal transaction evidence;
- Production ZATCA activation evidence.

The Windows/Android artifact names retain their original `NON-RELEASE` classification intentionally.
