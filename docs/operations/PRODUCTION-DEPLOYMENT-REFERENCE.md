# KORVI — Production Deployment Reference

Status: **AR-4 ENGINEERING REFERENCE — no paid production resource is activated by this document**
Created: 2026-09-22

This is the provider-neutral production topology and execution contract. It
describes what can be prepared before the first customer and separates that from
evidence that requires a real production provider.

## 1. Reference topology

```text
Public HTTPS / TLS
  |
  +--> Korvi Control / POS Web (Next.js)
  |       browser /v1/* -> same-origin proxy -> API
  |
  +--> Korvi API (Node 24 / Fastify)
          |
          +--> PostgreSQL 17+ managed production database
          |      - HA/failover
          |      - encrypted backups / PITR
          |      - migration identity != runtime identity
          |
          +--> Secret manager / externalized runtime secrets
          +--> Metrics scraper + alert router
          +--> Azure Key Vault / Managed HSM for production ZATCA signing
          +--> ZATCA FATOORA endpoints

Installed Windows/Android Korvi Cashier -> HTTPS API origin
```

API/web must deploy from the same reviewed canonical SHA. Runtime, migration,
backup and key-management authorities are separate.

## 2. Production planning objectives

Engineering planning targets, pending business-owner acceptance and measured
rehearsal:

- **RPO target:** <= 15 minutes.
- **RTO target:** <= 60 minutes.
- PostgreSQL major: 17 or newer only after compatibility proof.
- Backup retention minimum for provider selection: 7 days; production selection
  should prefer PITR/continuous WAL or backup frequency capable of the RPO.
- Production web/API availability must be externally monitored.
- Required alert classes: availability, readiness, 5xx rate and latency.

These targets are explicit planning requirements, not evidence that the targets
have been achieved.

## 3. Runtime identities

Database identities:

- **migration identity** — dedicated non-superuser/non-BYPASSRLS operations role;
  owns/executes forward-only migration authority;
- **runtime identity** — distinct non-owner, non-superuser, non-BYPASSRLS role;
  application DML only; migration ledger read-only;
- **backup/restore authority** — provider/operations identity outside API runtime.

The executable contract is `scripts/deploy/production-migrate.sh`.
The API runtime must never receive `MIGRATION_DATABASE_URL` or
`PRODUCTION_RUNTIME_DB_ROLE`.

## 4. Environment inventory — names only

No values belong in this document.

### API runtime

| Variable | Class | Production handling |
| --- | --- | --- |
| `NODE_ENV` | mode | exactly `production` |
| `KORVI_ENVIRONMENT` | deployment marker | exactly `production` where deployment scripts require it |
| `API_PORT` | runtime setting | platform-provided or explicit |
| `LOG_LEVEL` | runtime setting | production-safe level |
| `APP_ORIGINS` | security config | exact HTTPS browser origins |
| `SESSION_TTL_HOURS` | auth config | bounded by config parser |
| `AUTH_LOGIN_GLOBAL_LIMIT` | auth admission | bounded setting |
| `AUTH_LOGIN_IDENTITY_LIMIT` | auth admission | bounded setting |
| `AUTH_LOGIN_WINDOW_SECONDS` | auth admission | bounded setting |
| `AUTH_LOGIN_MAX_CONCURRENT` | auth admission | bounded setting |
| `AUTH_LOGIN_MAX_TRACKED_IDENTITIES` | auth admission | bounded setting |
| `DATABASE_URL` | secret | restricted runtime DB credential |
| `BOOTSTRAP_SIGNING_KEY` | secret | independent CSPRNG secret |
| `METRICS_AUTH_TOKEN` | secret | independent machine-only scrape credential |
| `OFFLINE_LEASE_SIGNING_SEED_B64` | secret | server-only Ed25519 seed |
| `OFFLINE_LEASE_KEY_ID` | key identifier | rotation-aware identifier |
| `OFFLINE_LEASE_TTL_HOURS` | policy | bounded offline lease lifetime |
| `PLATFORM_ADMIN_ACCESS_KEY` | secret | configure with both Platform session fields or leave Platform surface fail-closed |
| `PLATFORM_SESSION_SIGNING_KEY` | secret | independent from Platform access key |
| `PLATFORM_ADMIN_ACTOR_REF` | actor identity | opaque operator/audit reference |
| `PLATFORM_SESSION_TTL_HOURS` | policy | bounded Platform session lifetime |

### Migration/pre-deploy process only

| Variable | Class | Rule |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | secret | never injected into API runtime |
| `PRODUCTION_RUNTIME_DB_ROLE` | authority identifier | canonical PostgreSQL role name only |
| `NODE_ENV` | mode | `production` |
| `KORVI_ENVIRONMENT` | marker | `production` |

### Web build/runtime

| Variable | Class | Rule |
| --- | --- | --- |
| `NODE_ENV` | mode | `production` |
| `KORVI_API_ORIGIN` | topology | exact API origin used by Next same-origin rewrite; never a database or secret URL |

### Installed cashier build/release

| Variable | Class | Rule |
| --- | --- | --- |
| `KORVI_NATIVE_API_ORIGIN` | release topology | HTTPS production API origin for release-authorized packages |

Windows/Android signing variables are release-pipeline secrets, not runtime
application configuration. Their names/requirements remain in the installed
client proof workflows and must not be exposed to the application bundle.

### Production ZATCA provider

| Variable | Class | Rule |
| --- | --- | --- |
| `AZURE_KEY_VAULT_NAME` | provider config | production signing vault/HSM name |
| `AZURE_TENANT_ID` | provider identity | Azure tenant UUID |
| `AZURE_CLIENT_ID` | provider identity | least-privilege application UUID |
| `AZURE_CLIENT_SECRET` | secret | external secret manager only |
| `ZATCA_TRUST_ANCHOR_SHA256_HEX` | trust config | approved comma-separated SHA-256 certificate anchors |
| `ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID` | key identifier | active encryption key id |
| `ZATCA_FATOORA_VAULT_KEYS` | secret keyring | encrypted-credential AES-256 keyring; never log/store in DB |

## 5. Build and deployment

1. Select the exact canonical SHA and require green release evidence.
2. Build with Node 24 and the locked npm version/lockfile.
3. Provision the production PostgreSQL database and separate restricted
   migration/runtime roles.
4. Run `scripts/deploy/production-migrate.sh` in an isolated pre-deploy job with
   migration credentials only.
5. Abort on migration checksum mismatch, drift, unsafe DB roles or runtime
   migration-ledger write authority.
6. Build API and web from the same SHA.
7. Inject runtime secrets from the selected secret manager. Do not materialize
   secrets into repository files or build logs.
8. Start API from `apps/api/dist/index.js`. Production boot must fail closed if
   required database/security configuration is absent.
9. Start Next web and verify its configured API origin.
10. Verify externally: TLS, web, `/health`, `/ready`, authenticated
    `/metrics`, unauthenticated metrics refusal, and a representative business
    read/write workflow.
11. Record provider deployment IDs and exact source SHA.

## 6. Database migration procedure

- migrations are forward-only and immutable;
- no `db push` on production;
- no migration-ledger edits;
- no API-runtime schema owner;
- exact migration ledger/checksum + schema drift proof runs before admission;
- runtime DML grants are refreshed only after migration proof succeeds;
- deployment stops on any uncertainty.

## 7. Rollback

Application rollback is allowed only to a previously proven SHA whose runtime is
compatible with the current forward schema. Database migrations are not rolled
back by rewriting history.

If schema/data recovery is required:
1. isolate traffic;
2. preserve evidence;
3. restore into an isolated target using `DISASTER-RECOVERY.md`;
4. verify migration ledger, drift, RLS and full application proof;
5. promote only after recovery acceptance.

Prefer a reviewed forward fix when data is intact.

## 8. Health, monitoring and alerting

- `/health`: liveness; must remain distinct from database readiness.
- `/ready`: dependency/business readiness; must fail closed during DB outage
  and recover without requiring an API restart.
- `/metrics`: machine-only, authenticated by `METRICS_AUTH_TOKEN`.
- preserve request correlation IDs in operational logs;
- route alerts for availability, readiness, sustained 5xx and latency;
- name an on-call role and escalation path before production approval;
- exercise at least one alert drill and record acknowledgement time/evidence.

The repository incident proof can prove the internal outage/recovery behavior.
Real external alert routing remains production evidence.

## 9. Backup / restore

Production provider selection must provide encrypted managed backups/PITR and a
topology capable of the stated RPO. Runtime credentials cannot request/read
backups.

Before launch, execute a production-equivalent restore rehearsal and record:
backup timestamp, exact release SHA, measured RPO/RTO, migration ledger,
restricted-role/RLS proof and application verification. Follow
`docs/operations/DISASTER-RECOVERY.md`.

## 10. External activation gates

This document intentionally does not select or purchase a provider. AR-4 cannot
be called Production Proven until actual production provider, backups,
monitoring/on-call routing, measured RPO/RTO and field evidence are available.
