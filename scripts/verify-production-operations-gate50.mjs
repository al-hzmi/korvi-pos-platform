#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const FORBIDDEN_SECRET_KEY_RE =
  /^(?:password|secret|token|apiToken|accessToken|refreshToken|privateKey|connectionString|databaseUrl|authorization|cookie)$/i;
const FORBIDDEN_SECRET_VALUE_RE =
  /(postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk_live_[A-Za-z0-9]+\b|\bAKIA[0-9A-Z]{16}\b)/i;
const PLACEHOLDER_RE = /^(?:tbd|todo|pending|unknown|n\/a|na|null|none|placeholder)$/i;

const REQUIRED_RELEASE_GREEN_CHECKS = [
  'ci',
  'postgres-live',
  'browser-sale',
  'browser-stage5d',
  'dr',
  'incident',
];
const REQUIRED_ALERT_CLASSES = ['availability', 'readiness', '5xx', 'latency'];
const REQUIRED_ROTATED_SECRET_CLASSES = [
  'database-runtime',
  'session',
  'metrics-auth',
  'bootstrap',
];
const REQUIRED_FIELD_WORKFLOWS = [
  'sale',
  'return',
  'shift',
  'inventory',
  'purchase-receipt',
  'offline-sync',
];

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}

function string(value, label, { min = 1 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min)
    fail(`${label} must be a non-empty string`);
  if (PLACEHOLDER_RE.test(value.trim())) fail(`${label} may not be a placeholder`);
  return value.trim();
}

function number(value, label, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
    fail(`${label} must be a finite number >= ${min}`);
  return value;
}

function boolean(value, label, expected = undefined) {
  if (typeof value !== 'boolean') fail(`${label} must be boolean`);
  if (expected !== undefined && value !== expected) fail(`${label} must be ${expected}`);
  return value;
}

function iso(value, label) {
  const text = string(value, label);
  if (!ISO_RE.test(text) || Number.isNaN(Date.parse(text)))
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  return text;
}

function sha(value, label) {
  const text = string(value, label).toLowerCase();
  if (!SHA_RE.test(text)) fail(`${label} must be a full 40-character git SHA`);
  return text;
}

function stringArray(value, label, { min = 1 } = {}) {
  if (!Array.isArray(value) || value.length < min)
    fail(`${label} must contain at least ${min} item(s)`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}

function requiredStringSet(value, label, required) {
  const values = stringArray(value, label, { min: required.length });
  const normalized = values.map((entry) => entry.toLowerCase());
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) fail(`${label} may not contain duplicate items`);
  for (const requiredItem of required) {
    if (!unique.has(requiredItem)) fail(`${label} missing required item: ${requiredItem}`);
  }
  return values;
}

function scanForSecrets(value, trail = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForSecrets(entry, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_SECRET_KEY_RE.test(key))
        fail(`${trail}.${key} is a forbidden secret-bearing field name`);
      scanForSecrets(entry, `${trail}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && FORBIDDEN_SECRET_VALUE_RE.test(value)) {
    fail(`${trail} appears to contain secret material`);
  }
}

export function validateGate50Evidence(payload, { expectedSha } = {}) {
  const root = object(payload, 'evidence');
  scanForSecrets(root);

  if (root.schemaVersion !== 1) fail('schemaVersion must equal 1');
  if (string(root.gate, 'gate') !== 'production-operations-50')
    fail('gate must equal production-operations-50');
  if (string(root.environment, 'environment').toLowerCase() !== 'production')
    fail('environment must equal production');
  boolean(root.synthetic, 'synthetic', false);
  boolean(root.launchApproved, 'launchApproved', true);

  const release = object(root.release, 'release');
  const releaseSha = sha(release.sha, 'release.sha');
  if (expectedSha && releaseSha !== sha(expectedSha, 'expectedSha'))
    fail(`release.sha ${releaseSha} does not match expected SHA ${expectedSha}`);
  iso(release.verifiedAtUtc, 'release.verifiedAtUtc');
  requiredStringSet(
    release.requiredGreenChecks,
    'release.requiredGreenChecks',
    REQUIRED_RELEASE_GREEN_CHECKS,
  );

  const database = object(root.database, 'database');
  const provider = string(database.provider, 'database.provider');
  const plan = string(database.plan, 'database.plan');
  if (/render/i.test(provider) && /free/i.test(plan))
    fail('database.plan may not be Render Free for production Gate 50');
  if (/free|trial|staging|ephemeral|disposable/i.test(plan))
    fail('database.plan must be a durable production plan, not free/trial/staging/ephemeral');
  string(database.region, 'database.region');
  number(database.postgresMajor, 'database.postgresMajor', { min: 17 });
  boolean(database.highAvailability, 'database.highAvailability', true);
  string(database.failoverTopology, 'database.failoverTopology');

  const backups = object(database.backups, 'database.backups');
  string(backups.mechanism, 'database.backups.mechanism');
  number(backups.frequencyMinutes, 'database.backups.frequencyMinutes', { min: 1 });
  number(backups.retentionDays, 'database.backups.retentionDays', { min: 1 });
  boolean(backups.encryptedAtRest, 'database.backups.encryptedAtRest', true);
  boolean(backups.encryptedInTransit, 'database.backups.encryptedInTransit', true);
  boolean(backups.runtimeAuthoritySeparated, 'database.backups.runtimeAuthoritySeparated', true);
  string(backups.evidenceRef, 'database.backups.evidenceRef');

  const recovery = object(root.recovery, 'recovery');
  const targetRpo = number(recovery.targetRpoMinutes, 'recovery.targetRpoMinutes', { min: 1 });
  const targetRto = number(recovery.targetRtoMinutes, 'recovery.targetRtoMinutes', { min: 1 });
  const measuredRpo = number(recovery.measuredRpoMinutes, 'recovery.measuredRpoMinutes', {
    min: 0,
  });
  const measuredRto = number(recovery.measuredRtoMinutes, 'recovery.measuredRtoMinutes', {
    min: 0,
  });
  if (measuredRpo > targetRpo)
    fail(`measured RPO ${measuredRpo}m exceeds accepted target ${targetRpo}m`);
  if (measuredRto > targetRto)
    fail(`measured RTO ${measuredRto}m exceeds accepted target ${targetRto}m`);
  iso(recovery.rehearsedAtUtc, 'recovery.rehearsedAtUtc');
  string(recovery.backupTimestampRef, 'recovery.backupTimestampRef');
  string(recovery.restoreEvidenceRef, 'recovery.restoreEvidenceRef');
  string(recovery.businessOwnerAcceptanceRef, 'recovery.businessOwnerAcceptanceRef');

  const monitoring = object(root.monitoring, 'monitoring');
  string(monitoring.provider, 'monitoring.provider');
  requiredStringSet(monitoring.alertClasses, 'monitoring.alertClasses', REQUIRED_ALERT_CLASSES);
  string(monitoring.routingRef, 'monitoring.routingRef');
  string(monitoring.onCallRole, 'monitoring.onCallRole');
  string(monitoring.escalationRef, 'monitoring.escalationRef');
  iso(monitoring.drillAtUtc, 'monitoring.drillAtUtc');
  number(monitoring.acknowledgementSeconds, 'monitoring.acknowledgementSeconds', { min: 0 });
  string(monitoring.drillEvidenceRef, 'monitoring.drillEvidenceRef');

  const secretManagement = object(root.secretManagement, 'secretManagement');
  string(secretManagement.provider, 'secretManagement.provider');
  boolean(
    secretManagement.runtimeSecretsExternalized,
    'secretManagement.runtimeSecretsExternalized',
    true,
  );
  boolean(secretManagement.leastPrivilege, 'secretManagement.leastPrivilege', true);
  requiredStringSet(
    secretManagement.rotatedClasses,
    'secretManagement.rotatedClasses',
    REQUIRED_ROTATED_SECRET_CLASSES,
  );
  iso(secretManagement.rotationTestAtUtc, 'secretManagement.rotationTestAtUtc');
  string(secretManagement.rotationEvidenceRef, 'secretManagement.rotationEvidenceRef');

  const field = object(root.merchantFieldValidation, 'merchantFieldValidation');
  string(field.cohortRef, 'merchantFieldValidation.cohortRef');
  sha(field.releaseSha, 'merchantFieldValidation.releaseSha');
  if (field.releaseSha.toLowerCase() !== releaseSha)
    fail('merchantFieldValidation.releaseSha must equal release.sha');
  requiredStringSet(
    field.workflowsVerified,
    'merchantFieldValidation.workflowsVerified',
    REQUIRED_FIELD_WORKFLOWS,
  );
  string(field.rollbackCriteriaRef, 'merchantFieldValidation.rollbackCriteriaRef');
  iso(field.completedAtUtc, 'merchantFieldValidation.completedAtUtc');
  if (string(field.result, 'merchantFieldValidation.result').toUpperCase() !== 'PASS')
    fail('merchantFieldValidation.result must equal PASS');
  string(field.humanApprovalRef, 'merchantFieldValidation.humanApprovalRef');

  const evidence = object(root.evidence, 'evidence');
  string(evidence.exactShaCiRef, 'evidence.exactShaCiRef');
  string(evidence.postgresLiveRef, 'evidence.postgresLiveRef');
  string(evidence.drRef, 'evidence.drRef');
  string(evidence.incidentRef, 'evidence.incidentRef');
  string(evidence.externalSurfaceRef, 'evidence.externalSurfaceRef');
  string(evidence.providerProductionRef, 'evidence.providerProductionRef');

  return {
    gate: 'production-operations-50',
    releaseSha,
    environment: 'production',
    productionDatabase: `${provider}/${plan}`,
    targetRpoMinutes: targetRpo,
    measuredRpoMinutes: measuredRpo,
    targetRtoMinutes: targetRto,
    measuredRtoMinutes: measuredRto,
    result: 'PASS',
  };
}

function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) {
    console.error(
      'Usage: node scripts/verify-production-operations-gate50.mjs <evidence.json> [expected-sha]',
    );
    process.exit(2);
  }
  const expectedSha = process.argv[3] || process.env.EXPECTED_RELEASE_SHA || undefined;
  const absolute = path.resolve(process.cwd(), evidencePath);
  const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const summary = validateGate50Evidence(parsed, { expectedSha });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`[gate50] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
