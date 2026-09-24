# KORVI — Asset & Account Transfer Register

Status: **TRANSACTION PREPARATION / VALUES EXCLUDED**

Source release: `61dbb34dea08809756fd767b907b0e852b7e5978`

This register records known technical assets and transfer decisions without storing credentials, secret values, private keys or customer data.

| Asset / control plane | Current known state | Transaction action |
|---|---|---|
| GitHub repository | `al-hzmi/korvi-pos-platform`, public, default branch `main` | Decide ownership/access transfer, default branch, protection/rulesets, release governance |
| Canonical source branch | `release/canonical-acquisition-v1` | Preserve exact source SHA and evidence relationship |
| Canonical source SHA | `61dbb34dea08809756fd767b907b0e852b7e5978` | Reference explicitly in transaction/handoff records |
| Acquisition PR | #62 to `main`, currently open | Buyer/seller decide merge/close/preserve strategy |
| Data-room branch | `docs/acquisition-data-room-61dbb34` | Provide as diligence overlay; do not confuse with runtime release |
| Render staging API | `korvi-staging-api` / `srv-dafasa1t0dsc73dbumbg` | Evaluation only; transfer/recreate only if included in transaction |
| Render staging Web | `korvi-staging-web` / `srv-dafashn40ujc73ag1540` | Evaluation only; transfer/recreate only if included |
| Render staging DB | `korvi-staging-db` / PostgreSQL 17 / free / non-HA | Do not treat as production asset; replace/recreate if evaluation continues |
| Production database | Not activated/proven in current evidence | Buyer/merchant selects and activates real production topology |
| Production monitoring | Model documented; external provider not activated | Select provider, bind channels, run alert drill |
| Production secret manager | Required by contract; real activation not evidenced | Select/activate, import secrets securely, rotate post-transfer |
| Azure Key Vault / HSM | Production design boundary exists; real activation not evidenced | Provision under correct production/merchant ownership |
| Production ZATCA identity / CSID | Not present in current acquisition evidence | Provision for actual merchant/legal entity; do not fabricate transferability |
| Fatoora credentials | Environment names documented; production credentials not in repository | Custody only through approved secret/vault mechanisms |
| Windows signing/distribution keys | Not asserted in this data room | Identify separately if they exist; rotate/transfer through secure process |
| Android signing/distribution keys | Production distribution lifecycle not claimed complete | Establish buyer-controlled signing/distribution lifecycle if required |
| Domains / DNS | No specific domain transfer is established by current repository evidence | Inventory externally before transaction if any domain assets are in scope |
| Korvi brand/trademark assets | Transaction scope not established by repository alone | Explicitly include/exclude in legal instrument |
| Customer/merchant contracts | None asserted by this technical data room | Provide privately if any exist and are in scope |
| Revenue/receivables | None asserted by this technical data room | Provide separately if any exist |
| Merchant pilot evidence | No real production pilot asserted | Only real merchant evidence may close AR-7 |

## Environment variable custody classes

Names are documented in `docs/acquisition/ENVIRONMENT-INVENTORY.md`. Values must not be placed in the data room.

Primary custody classes:

- runtime database credentials;
- migration database credentials;
- bootstrap signing key;
- metrics token;
- offline lease signing seed;
- Platform Admin access/session keys;
- Azure client secret;
- ZATCA credential-encryption keyring.

## Transfer rules

1. Prefer recreating credentials under buyer-controlled accounts over sharing old plaintext values.
2. Rotate transferred credentials immediately after control changes.
3. Never export HSM/private signing material if the accepted design requires non-exportability.
4. Do not treat merchant-specific regulatory identities as ordinary software assets.
5. Keep public repository documentation secret-free.
6. Record who owns each account before and after close.
7. Record whether an asset is transferred, recreated, excluded or retired.
