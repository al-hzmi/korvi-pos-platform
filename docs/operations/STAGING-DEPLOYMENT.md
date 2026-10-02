# Isolated staging deployment

Status: deployment preparation; no hosted or Production Ready claim.

## Scope

The root `render.yaml` describes two **free** Node web services and one **free**
PostgreSQL 17 database in Frankfurt. These are disposable test resources, with
synthetic merchants only. They are not the eventual production topology or a
commercial SLA. Automatic deploys are disabled so one reviewed commit can be
selected for both services after its CI and PostgreSQL gates pass.

The staging Blueprint uses `strike/5c-costing-authority` as the controlled
promotion branch. Release candidates are proved first on
`review/operations-50-production-readiness`. Only after the exact review SHA has
passed the required CI, incident and DR gates may the promotion branch be moved
to that same SHA by a non-forced fast-forward. Automatic deployment remains
disabled, and the operator must verify that API and web both deployed exactly
the promoted SHA before recording field evidence.

Next continues to proxy browser `/v1/*` requests to Fastify (ADR-0014). The API
keeps production secure/HttpOnly cookies, exact origin validation and all normal
authentication/permission checks. Free API services cannot receive private
network traffic, so the web service uses the API's HTTPS URL. The database uses
its internal connection and rejects all external connections by default.

The existing development entrypoint is unchanged. The separate staging API
entrypoint refuses to listen until it has read and checked:

- the explicit staging marker, production mode, HTTPS origins and secrets;
- PostgreSQL major 17 and a role without SUPERUSER, BYPASSRLS, CREATEDB,
  CREATEROLE, INHERIT, REPLICATION or memberships in other roles;
- absence of persistent tenant/login context on the connection;
- every checked-in migration name and SHA-256 against its successful ledger row;
- the exact schema table set, with ENABLE/FORCE RLS and a policy on every tenant
  table. Only permissions, global catalogue and Prisma's ledger are exempt.

The boot check is read-only: it never repairs, migrates, grants or seeds. A
connection error is logged generically to avoid leaking driver credentials.
Migration execution is a separate controlled build stage described below.

## Deployment contract

`apps/api/src/config.ts` is authoritative for production-required secret names.
`scripts/check-deployment-contract.mjs`, executed by `npm run verify`, fails if
`render.yaml` stops provisioning one of those secrets, hardcodes it, duplicates
an environment key, enables automatic deployment, points API/web at a branch
other than the controlled promotion branch, or stops using the guarded API build
entrypoint.

The current required secret domains are owner-bootstrap signing and machine-only
metrics scraping. Render generates each independently. They must never share a
value, be copied into browser configuration, be committed, or be printed into
logs or release evidence. The runtime independently rejects missing, weak,
whitespace-padded or equal credentials at boot.

Free Render web services do not provide one-off jobs or the paid pre-deploy
command. For this **disposable staging environment only**, the manually triggered
API build therefore executes `scripts/deploy/staging-migrate.sh` before building
the runtime. That script is fail-closed unless both `KORVI_ENVIRONMENT=staging`
and `NODE_ENV=production` are present, requires `DATABASE_URL`, never prints the
URL, runs `prisma migrate deploy`, verifies `prisma migrate status`, and requires
an empty Prisma schema diff. `scripts/check-staging-migration-contract.sh`
proves the command order and refusal paths in every repository verification.
This staging adaptation is not the production migration topology.

## Operator sequence

1. Connect the Render account. Inspect existing resources and quota first. Do
   not apply the template over an unrelated resource with a matching name.
   Use only explicitly free plans; decline any paid upgrade. Keep staging API
   and web bound to `strike/5c-costing-authority` with automatic deployments off.
   Candidate code remains on the review branch until all exact-head release
   proofs are green; never deploy an unproved candidate by moving the provider
   branch ad hoc.
2. Create the dedicated PostgreSQL 17 instance. Do not reuse a customer database.
   Use the provider's secure query capability to create `korvi_staging_app` with
   `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`,
   a generated password and no memberships. Grant CONNECT/CREATE/TEMPORARY on
   **this database only** and USAGE/CREATE on its public schema, matching the
   verified CI ownership model. Never supply the provider's administrative
   credentials to the running API.
3. Keep API `DATABASE_URL` bound to that restricted application role. On a
   controlled free-staging API deploy, `scripts/deploy/build.sh api` invokes the
   guarded staging migration stage before runtime compilation. The stage applies
   checked-in migrations **as that application role**, then proves migration
   status and zero schema drift. Do not use `db push`, reset an occupied database,
   relax RLS, alter migration history, or switch to provider administrative
   credentials to make a deploy pass. A migration/status/diff failure aborts the
   build and leaves the previous successful service deploy serving traffic.
   Role ownership remains the existing staging/CI model, not a claim of a
   completed production separation between runtime and migration identities.
4. Record the provider-assigned service URLs. Set API `DATABASE_URL` to the
   internal URL for `korvi_staging_app` and `APP_ORIGINS` to the web's exact HTTPS
   origin without a trailing slash. Provision independent CSPRNG-backed
   `BOOTSTRAP_SIGNING_KEY` and `METRICS_AUTH_TOKEN` values of at least 32
   characters each; when the Blueprint creates a missing variable,
   `generateValue: true` supplies an independent provider-generated secret.
   Existing services do not gain evidence merely because the manifest changed:
   verify both variables are present before deployment without reading or
   recording their values. Set web `KORVI_API_ORIGIN` to the API's exact HTTPS
   origin **before building**. No database URL, signing key, metrics token or
   password belongs in the web environment.
5. After CI, incident and DR all succeed on the exact review SHA, re-read both
   GitHub refs and prove the promotion branch is an ancestor. Fast-forward
   `strike/5c-costing-authority` to that exact SHA with `force=false`; abort on
   any concurrent change. Then build API and web using the commands in
   `render.yaml` and manually deploy both from that promoted branch. The API
   build must first complete the guarded migration/status/drift sequence. Record
   each provider-reported deployed SHA and refuse field validation if they differ
   from each other or from the promoted/reviewed SHA. The API's `/health` becomes
   reachable only after migration and preflight both succeed. It remains a
   liveness check, not continuous DB readiness. Next's `/` only proves web
   liveness. Check both independently.
6. Before merchant workflow evidence, verify operations surfaces: `/ready` must
   fail closed when PostgreSQL is unavailable and recover afterward; anonymous
   `/metrics` must return 401; an authenticated scrape using the provider-held
   `METRICS_AUTH_TOKEN` must succeed. Never print, copy into issue text, browser
   storage, screenshots or artifacts the bearer credential itself.
7. Provision synthetic merchants through the existing tenant lifecycle,
   entitlement and initial-owner bootstrap authorities. Do not invent direct
   SQL tenant/user seeds or add a public provisioning endpoint. No demo credential
   or owner capability is committed or published in an issue. Complete the
   existing onboarding flow before exercising merchant operations.
8. Record interactive evidence: sign-in and cookie attributes; same-origin
   stock/cost/purchasing reads and writes; unauthenticated and forbidden-origin
   refusal; supplier/order/partial-receipt flow; stale count/cost refresh;
   double-submit/ambiguous retry; keyboard/focus, RTL, responsive overflow and
   touch. Use two synthetic tenants to verify isolation. Record browser and
   viewport, deployed SHA and result per case. Unit/HTTP tests do not replace
   these observations.

## Recovery and cost bounds

- A failed migration or preflight leaves the candidate unavailable while the
  previous successful deploy remains authoritative. Correct the real migration,
  configuration or role problem; never disable the gate to obtain a green probe.
- Roll back API and web to the same previously verified source revision only
  when the database schema remains compatible. Never blindly roll back database
  migrations. Prefer a reviewed forward fix when a migration has already been
  committed to the staging ledger.
- Free services sleep after inactivity and share 750 instance hours/month.
  Two web services share that allowance. Free PostgreSQL expires after 30 days
  and has no managed backups. Set a dated expiry/removal plan at creation; do
  not test with data worth preserving. No free-plan availability or latency
  guarantee is claimed. Confirm current provider limits before provisioning.
- Even after successful staging deployment, independent review and the Human
  Gate remain necessary for Stage 5D closure. Production Operations, offline,
  regulatory and physical-device gates remain separate.

## Provider references checked 2026-09-12

- [Deploy lifecycle and pre-deploy availability](https://render.com/docs/deploys)
- [Blueprint fields](https://render.com/docs/blueprint-spec)
- [Free service and database limits](https://render.com/docs/free)
- [Database connections](https://render.com/docs/postgresql-creating-connecting)

## Progress interpretation

The repository roadmap establishes 5C closure and delivery of all four 5D
slices. Some older continuity text still calls 5C the first blocker; use the
roadmap, ADRs, current code and latest review evidence ahead of that text.
The historical **58/100** is not an updated percentage of implemented code or
a measured estimate of remaining time. It must not be increased for this
deployment preparation. Report delivered slices and open closure gates beside
that baseline until a consistent product-wide denominator is established.
