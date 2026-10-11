import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [workflow, verifier, runbook, gate, schema, zatca] = await Promise.all([
  readFile(new URL('../.github/workflows/acquisition-final-gate.yml', import.meta.url), 'utf8'),
  readFile(new URL('./verify-acquisition-final-gate.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../docs/acquisition/MERCHANT-PILOT-RUNBOOK.md', import.meta.url), 'utf8'),
  readFile(new URL('../docs/acquisition/FINAL-ACQUISITION-GATE.md', import.meta.url), 'utf8'),
  readFile(
    new URL('../docs/acquisition/schemas/final-acquisition-evidence.schema.json', import.meta.url),
    'utf8',
  ),
  readFile(new URL('../docs/acquisition/ZATCA-PRODUCTION-ACTIVATION.md', import.meta.url), 'utf8'),
]);

assert.match(workflow, /workflow_dispatch:/);
assert.doesNotMatch(workflow, /^\s*(push|pull_request):/m);
assert.match(workflow, /verify-acquisition-final-gate\.mjs/);
assert.match(workflow, /evidence_manifest_path/);
assert.match(verifier, /realMerchant/);
assert.match(verifier, /productionEnvironment/);
assert.match(verifier, /synthetic/);
assert.match(verifier, /simulationUsed/);
assert.match(verifier, /measuredRpoMinutes/);
assert.match(verifier, /measuredRtoMinutes/);
assert.match(verifier, /GITHUB_SHA/);
assert.match(runbook, /synthetic tenants/i);
assert.match(runbook, /not Merchant Pilot evidence/i);
assert.match(gate, /FAIL-CLOSED/);
assert.match(gate, /No final evidence manifest is created/i);
assert.match(schema, /"canonicalSha"/);
assert.match(schema, /"merchantPilot"/);
assert.match(schema, /"realProductionActivation"/);
assert.match(zatca, /INTERNAL ENGINEERING COMPLETE/);

console.log('[ok] acquisition final-gate contract is manual, exact-SHA and fail-closed');
