import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifestPath = process.argv[2];
if (manifestPath === undefined || manifestPath.trim() === '') {
  console.error('[blocked] final acquisition evidence manifest path is required');
  process.exit(2);
}

const raw = await readFile(manifestPath, 'utf8');
const evidence = JSON.parse(raw);

const requiredText = (value, label) => {
  assert.equal(typeof value, 'string', `${label} must be a string evidence reference`);
  assert.ok(value.trim().length > 0, `${label} must not be empty`);
  return value.trim();
};

assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.canonicalBranch, 'release/canonical-acquisition-v1');
assert.match(evidence.canonicalSha, /^[0-9a-f]{40}$/);
assert.ok(Number.isFinite(Date.parse(evidence.recordedAt)), 'recordedAt must be an ISO date-time');

const workflowSha = process.env.GITHUB_SHA;
if (workflowSha !== undefined && workflowSha !== '') {
  assert.equal(
    evidence.canonicalSha,
    workflowSha,
    'final evidence must be run on the exact candidate canonical SHA',
  );
}

const ops = evidence.productionOperations;
assert.equal(ops.realProductionEnvironment, true);
assert.equal(ops.stagingOrSynthetic, false);
assert.ok(Number.isFinite(ops.measuredRpoMinutes));
assert.ok(Number.isFinite(ops.measuredRtoMinutes));
assert.ok(ops.measuredRpoMinutes >= 0 && ops.measuredRpoMinutes <= 15, 'measured RPO exceeds 15m');
assert.ok(ops.measuredRtoMinutes >= 0 && ops.measuredRtoMinutes <= 60, 'measured RTO exceeds 60m');
for (const key of [
  'providerEvidenceRef',
  'haFailoverEvidenceRef',
  'backupRetentionEvidenceRef',
  'restoreEvidenceRef',
  'externalMonitoringEvidenceRef',
  'alertDrillEvidenceRef',
  'onCallAcknowledgementEvidenceRef',
  'secretRotationEvidenceRef',
])
  requiredText(ops[key], `productionOperations.${key}`);

const zatca = evidence.zatca;
assert.equal(zatca.realProductionActivation, true);
assert.equal(zatca.simulationUsed, false);
assert.equal(zatca.hsmNonExportable, true);
for (const key of [
  'hsmSignVerifyEvidenceRef',
  'merchantProductionIdentityEvidenceRef',
  'productionCsidEvidenceRef',
  'reportingClearanceEvidenceRef',
  'reconciliationEvidenceRef',
  'rotationRecoveryEvidenceRef',
])
  requiredText(zatca[key], `zatca.${key}`);

const transaction = evidence.transactionHandoff;
for (const key of [
  'ipAssignmentOrLicenseEvidenceRef',
  'chainOfTitleEvidenceRef',
  'thirdPartyLicenseReviewEvidenceRef',
  'accountDomainCredentialTransferEvidenceRef',
  'repositoryGovernanceEvidenceRef',
])
  requiredText(transaction[key], `transactionHandoff.${key}`);

const pilot = evidence.merchantPilot;
assert.equal(pilot.realMerchant, true);
assert.equal(pilot.productionEnvironment, true);
assert.equal(pilot.synthetic, false);
assert.equal(pilot.staging, false);
for (const key of [
  'merchantEvidenceRef',
  'onboardingImportEvidenceRef',
  'branchTerminalProvisioningEvidenceRef',
  'operatorWorkflowEvidenceRef',
  'shiftLifecycleEvidenceRef',
  'paymentTenderEvidenceRef',
  'returnRefundEvidenceRef',
  'stockEffectsEvidenceRef',
  'receiptEvidenceRef',
  'offlineReconnectEvidenceRef',
  'backupRollbackReadinessEvidenceRef',
  'merchantAcceptanceEvidenceRef',
])
  requiredText(pilot[key], `merchantPilot.${key}`);
assert.equal(typeof pilot.restaurantApplicable, 'boolean');
if (pilot.restaurantApplicable) {
  requiredText(pilot.restaurantFlowEvidenceRef, 'merchantPilot.restaurantFlowEvidenceRef');
}

const approvals = evidence.reviewApprovals;
for (const key of [
  'productionOperationsReviewRef',
  'zatcaReviewRef',
  'transactionReviewRef',
  'merchantPilotReviewRef',
  'executiveReleaseDecisionRef',
])
  requiredText(approvals[key], `reviewApprovals.${key}`);

for (const pattern of [
  /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk_live_[A-Za-z0-9]+\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /"clientSecret"\s*:\s*"[^"]+"/i,
  /"password"\s*:\s*"[^"]+"/i,
]) {
  assert.doesNotMatch(raw, pattern, 'final evidence manifest must not contain secret material');
}

console.log('[eligible] acquisition evidence manifest is structurally complete for exact SHA');
console.log('[note] human reviewers must authenticate the external evidence before AR-8 closure');
