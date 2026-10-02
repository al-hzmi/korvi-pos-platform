import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  handoff: new URL('../docs/acquisition/KORVI-ACQUISITION-HANDOFF.md', import.meta.url),
  env: new URL('../docs/acquisition/ENVIRONMENT-INVENTORY.md', import.meta.url),
  ownership: new URL('../docs/acquisition/OWNERSHIP-IP-LICENSING.md', import.meta.url),
  supply: new URL('../docs/acquisition/DEPENDENCY-SUPPLY-CHAIN.md', import.meta.url),
  deferred: new URL('../docs/acquisition/DEFERRED-ACTIVATION-GATES.md', import.meta.url),
  deployment: new URL('../docs/operations/PRODUCTION-DEPLOYMENT.md', import.meta.url),
  monitoring: new URL('../docs/operations/MONITORING-ALERTING.md', import.meta.url),
  rollback: new URL('../docs/operations/RELEASE-ROLLBACK.md', import.meta.url),
  config: new URL('../apps/api/src/config.ts', import.meta.url),
  drWorkflow: new URL('../.github/workflows/operations-dr-postgres.yml', import.meta.url),
  incidentWorkflow: new URL('../.github/workflows/operations-incident-proof.yml', import.meta.url),
};

const entries = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, url]) => [key, await readFile(url, 'utf8')]),
  ),
);

for (const key of [
  'BOOTSTRAP_SIGNING_KEY',
  'METRICS_AUTH_TOKEN',
  'OFFLINE_LEASE_SIGNING_SEED_B64',
]) {
  assert.ok(entries.config.includes(`'${key}'`), `runtime config no longer declares ${key}`);
  assert.ok(entries.env.includes(`\`${key}\``), `handoff env inventory missing ${key}`);
}

for (const key of [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'PRODUCTION_RUNTIME_DB_ROLE',
  'KORVI_API_ORIGIN',
  'PLATFORM_ADMIN_ACCESS_KEY',
  'PLATFORM_SESSION_SIGNING_KEY',
  'AZURE_KEY_VAULT_NAME',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'ZATCA_TRUST_ANCHOR_SHA256_HEX',
  'ZATCA_FATOORA_VAULT_ACTIVE_KEY_ID',
  'ZATCA_FATOORA_VAULT_KEYS',
]) {
  assert.ok(entries.env.includes(`\`${key}\``), `handoff env inventory missing ${key}`);
}

assert.match(entries.deployment, /RPO target: ≤ 15 minutes/);
assert.match(entries.deployment, /RTO target: ≤ 60 minutes/);
assert.match(entries.monitoring, /availability/);
assert.match(entries.monitoring, /readiness/);
assert.match(entries.monitoring, /5xx/);
assert.match(entries.monitoring, /latency/);
assert.match(entries.ownership, /no root `LICENSE`/i);
assert.match(entries.deferred, /Production ZATCA/);
assert.match(entries.deferred, /real merchant/i);
assert.match(entries.handoff, /RELEASE-ROLLBACK/);

for (const workflow of [entries.drWorkflow, entries.incidentWorkflow]) {
  assert.ok(
    workflow.includes('integration/acquisition-ar4-ar6'),
    'operations proof workflow must run on the AR-4/AR-6 integration branch',
  );
  assert.ok(
    workflow.includes('release/canonical-acquisition-v1'),
    'operations proof workflow must run on the canonical acquisition branch',
  );
}

const combinedDocs = [
  entries.handoff,
  entries.env,
  entries.ownership,
  entries.supply,
  entries.deferred,
  entries.deployment,
  entries.monitoring,
  entries.rollback,
].join('\n');

for (const pattern of [
  /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk_live_[A-Za-z0-9]+\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
]) {
  assert.doesNotMatch(
    combinedDocs,
    pattern,
    'acquisition handoff must not contain secret material',
  );
}

console.log(
  '[ok] acquisition handoff: deployment, RPO/RTO, monitoring, rollback, env, IP/licensing, supply-chain and deferred activation contracts present',
);
