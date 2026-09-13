#!/usr/bin/env node
import fs from 'node:fs';
import { validateGate50Evidence } from './verify-production-operations-gate50.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const base = {
  schemaVersion: 1,
  gate: 'production-operations-50',
  environment: 'production',
  synthetic: false,
  launchApproved: true,
  release: {
    sha: SHA,
    verifiedAtUtc: '2026-09-13T10:00:00Z',
    requiredGreenChecks: [
      'ci',
      'postgres-live',
      'browser-sale',
      'browser-stage5d',
      'dr',
      'incident',
    ],
  },
  database: {
    provider: 'ExampleProvider',
    plan: 'production-ha',
    region: 'sa-central-1',
    postgresMajor: 17,
    highAvailability: true,
    failoverTopology: 'multi-zone managed failover',
    backups: {
      mechanism: 'managed continuous backups',
      frequencyMinutes: 5,
      retentionDays: 30,
      encryptedAtRest: true,
      encryptedInTransit: true,
      runtimeAuthoritySeparated: true,
      evidenceRef: 'provider-evidence:backup-policy-001',
    },
  },
  recovery: {
    targetRpoMinutes: 15,
    targetRtoMinutes: 60,
    measuredRpoMinutes: 4,
    measuredRtoMinutes: 18,
    rehearsedAtUtc: '2026-09-13T09:00:00Z',
    backupTimestampRef: 'provider-evidence:backup-point-001',
    restoreEvidenceRef: 'artifact:restore-proof-001',
    businessOwnerAcceptanceRef: 'approval:business-owner-001',
  },
  monitoring: {
    provider: 'ExampleMonitor',
    alertClasses: ['availability', 'readiness', '5xx', 'latency', 'database'],
    routingRef: 'ops-routing:primary-001',
    onCallRole: 'Korvi production primary',
    escalationRef: 'ops-escalation:sev0-sev1-001',
    drillAtUtc: '2026-09-13T09:30:00Z',
    acknowledgementSeconds: 45,
    drillEvidenceRef: 'artifact:alert-drill-001',
  },
  secretManagement: {
    provider: 'ExampleSecretManager',
    runtimeSecretsExternalized: true,
    leastPrivilege: true,
    rotatedClasses: ['database-runtime', 'session', 'metrics-auth', 'bootstrap'],
    rotationTestAtUtc: '2026-09-13T08:30:00Z',
    rotationEvidenceRef: 'artifact:secret-rotation-001',
  },
  merchantFieldValidation: {
    cohortRef: 'cohort:pilot-hash-001',
    releaseSha: SHA,
    workflowsVerified: ['sale', 'return', 'shift', 'inventory', 'purchase-receipt', 'offline-sync'],
    rollbackCriteriaRef: 'field-plan:rollback-001',
    completedAtUtc: '2026-09-13T10:30:00Z',
    result: 'PASS',
    humanApprovalRef: 'approval:field-owner-001',
  },
  evidence: {
    exactShaCiRef: 'gha:ci-001',
    postgresLiveRef: 'gha:postgres-001',
    drRef: 'gha:dr-001',
    incidentRef: 'gha:incident-001',
    externalSurfaceRef: 'gha:surface-001',
    providerProductionRef: 'provider:deployment-001',
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectPass(name, mutate = () => {}) {
  const value = clone(base);
  mutate(value);
  try {
    validateGate50Evidence(value, { expectedSha: SHA });
  } catch (error) {
    throw new Error(
      `${name} unexpectedly failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function expectFail(name, mutate) {
  const value = clone(base);
  mutate(value);
  let failed = false;
  try {
    validateGate50Evidence(value, { expectedSha: SHA });
  } catch {
    failed = true;
  }
  if (!failed) throw new Error(`${name} unexpectedly passed`);
}

expectPass('complete production evidence');
expectFail('staging evidence', (v) => {
  v.environment = 'staging';
});
expectFail('synthetic evidence', (v) => {
  v.synthetic = true;
});
expectFail('free database plan', (v) => {
  v.database.plan = 'free';
});
expectFail('missing HA', (v) => {
  v.database.highAvailability = false;
});
expectFail('RPO miss', (v) => {
  v.recovery.measuredRpoMinutes = 16;
});
expectFail('RTO miss', (v) => {
  v.recovery.measuredRtoMinutes = 61;
});
expectFail('secret-like field name', (v) => {
  v.monitoring.apiToken = 'redacted';
});
expectFail('secret-like value', (v) => {
  v.database.backups.evidenceRef = 'postgresql://user:pass@example/db';
});
expectFail('release SHA mismatch', (v) => {
  v.release.sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
});
expectFail('field-validation SHA mismatch', (v) => {
  v.merchantFieldValidation.releaseSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
});
expectFail('field validation not passed', (v) => {
  v.merchantFieldValidation.result = 'FAIL';
});
expectFail('placeholder evidence', (v) => {
  v.monitoring.routingRef = 'TBD';
});
expectFail('release checks cannot be padded with unrelated checks', (v) => {
  v.release.requiredGreenChecks = [
    'ci',
    'postgres-live',
    'browser-sale',
    'browser-stage5d',
    'dr',
    'unrelated-check',
  ];
});
expectFail('monitoring classes must include latency', (v) => {
  v.monitoring.alertClasses = ['availability', 'readiness', '5xx', 'database'];
});
expectFail('secret rotation classes must include bootstrap', (v) => {
  v.secretManagement.rotatedClasses = [
    'database-runtime',
    'session',
    'metrics-auth',
    'other-secret',
  ];
});
expectFail('field workflows must include offline sync', (v) => {
  v.merchantFieldValidation.workflowsVerified = [
    'sale',
    'return',
    'shift',
    'inventory',
    'purchase-receipt',
    'unrelated-workflow',
  ];
});
expectFail('critical evidence sets cannot contain duplicates', (v) => {
  v.release.requiredGreenChecks.push('ci');
});

const workflow = fs.readFileSync(
  '.github/workflows/operations-gate-50-production-proof.yml',
  'utf8',
);
const requiredWorkflowFragments = [
  'workflow_dispatch:',
  'permissions:\n  contents: read',
  'GATE50_EVIDENCE_JSON: ${{ secrets.GATE50_EVIDENCE_JSON }}',
  'verify-production-operations-gate50.mjs',
  '"$GITHUB_SHA"',
  'Reject secret-bearing proof output',
  'production-operations-gate-50-${{ github.sha }}',
];
for (const fragment of requiredWorkflowFragments) {
  if (!workflow.includes(fragment))
    throw new Error(`Gate 50 workflow contract missing: ${fragment}`);
}
if (/\bpull_request\s*:/.test(workflow) || /\bpush\s*:/.test(workflow)) {
  throw new Error('Gate 50 production proof must remain manually dispatched');
}
if (/cat\s+[^\n]*gate50-evidence\.json/.test(workflow)) {
  throw new Error('Gate 50 workflow must never print the raw evidence bundle');
}

console.log('[ok] Gate 50 production-operations evidence contract');
