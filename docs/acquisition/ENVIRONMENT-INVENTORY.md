# Korvi Environment Inventory — Names Only

Status: **HANDOFF INVENTORY — VALUES MUST NEVER BE COMMITTED**

This file inventories configuration names and ownership boundaries. It intentionally contains no credentials.

## API runtime

Required/commonly configured:

- `NODE_ENV`
- `KORVI_ENVIRONMENT`
- `API_PORT`
- `LOG_LEVEL`
- `APP_ORIGINS`
- `DATABASE_URL`
- `BOOTSTRAP_SIGNING_KEY`
- `METRICS_AUTH_TOKEN`
- `OFFLINE_LEASE_SIGNING_SEED_B64`
- `OFFLINE_LEASE_KEY_ID`
- `OFFLINE_LEASE_TTL_HOURS`
- `SESSION_TTL_HOURS`
- `AUTH_LOGIN_GLOBAL_LIMIT`
- `AUTH_LOGIN_IDENTITY_LIMIT`
- `AUTH_LOGIN_WINDOW_SECONDS`
- `AUTH_LOGIN_MAX_CONCURRENT`
- `AUTH_LOGIN_MAX_TRACKED_IDENTITIES`

Optional Platform Admin realm, configured as one unit:

- `PLATFORM_ADMIN_ACCESS_KEY`
- `PLATFORM_SESSION_SIGNING_KEY`
- `PLATFORM_ADMIN_ACTOR_REF`
- `PLATFORM_SESSION_TTL_HOURS`

The Platform Admin access key and session signing key must be independent. Production Platform Admin sessions require the durable PostgreSQL server-side session store.

## Migration plane

Never pass these into the API runtime:

- `MIGRATION_DATABASE_URL`
- `PRODUCTION_RUNTIME_DB_ROLE`

The migration identity and runtime role must be separate restricted PostgreSQL identities.

## Web build/runtime

- `NODE_ENV`
- `KORVI_API_ORIGIN`

The browser bundle must never receive database, Platform Admin, metrics, bootstrap, offline-signing or ZATCA secrets.

## ZATCA production activation boundary

Azure signing/key-custody path:

- `AZURE_KEY_VAULT_NAME`
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `ZATCA_TRUST_ANCHOR_SHA256_HEX`

Encrypted Fatoora credential vault:

- `ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID`
- `ZATCA_FATOORA_VAULT_KEYS`

These variables are intentionally read only at narrow server-side ZATCA composition boundaries. Their presence in this inventory does not mean production ZATCA is activated.

## Secret classes and custody

- Database runtime credential — production secret manager.
- Database migration credential — operations/migration plane only.
- Owner-bootstrap signing key — production secret manager.
- Metrics bearer token — monitoring integration only.
- Offline lease signing seed — server-side signing authority only.
- Platform Admin access/session keys — internal control plane only.
- Azure client secret — ZATCA production provider integration only.
- Fatoora vault keyring — ZATCA credential-encryption boundary only.

No values, example secrets, connection strings or private keys belong in acquisition documentation.
