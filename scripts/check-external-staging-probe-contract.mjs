import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [workflow, probe] = await Promise.all([
  readFile(new URL('../.github/workflows/external-staging-surface-probe.yml', import.meta.url), 'utf8'),
  readFile(new URL('./external-staging-probe.mjs', import.meta.url), 'utf8'),
]);

assert.ok(
  workflow.includes('review/operations-50-production-readiness'),
  'external staging probe must run when its review surface changes',
);
assert.ok(workflow.includes('workflow_dispatch:'), 'external staging probe must be manually runnable');
assert.match(
  workflow,
  /schedule:\n\s+- cron: '[^']+'/,
  'external staging probe must retain an independent scheduled execution path',
);
assert.ok(
  workflow.includes('- apps/api/package.json'),
  'external staging probe must run when API runtime dependencies change',
);
assert.ok(
  workflow.includes('- package-lock.json'),
  'external staging probe must run when the exact runtime dependency graph changes',
);
assert.ok(
  workflow.includes('https://korvi-staging-api.onrender.com'),
  'external probe must target the canonical staging API origin',
);
assert.ok(
  workflow.includes('https://korvi-staging-web.onrender.com'),
  'external probe must target the canonical staging web origin',
);
assert.match(
  workflow,
  /actions\/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09/,
  'external probe checkout action must remain commit-pinned',
);
assert.match(
  workflow,
  /actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444/,
  'external probe Node setup action must remain commit-pinned',
);
assert.match(
  workflow,
  /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
  'external probe artifact action must remain commit-pinned',
);
assert.ok(
  workflow.includes('if: always()'),
  'failed external probes must still retain sanitized failure evidence',
);
assert.doesNotMatch(
  workflow,
  /\$\{\{\s*secrets\./,
  'anonymous public-surface probe must not receive repository secrets',
);
assert.doesNotMatch(
  workflow,
  /Authorization:|Bearer\s/i,
  'external public-surface workflow must not inject authorization material',
);

assert.match(probe, /url\.protocol !== 'https:'/, 'probe must reject non-TLS origins');
assert.match(probe, /url\.username !== ''/, 'probe must reject URL userinfo');
assert.match(probe, /url\.password !== ''/, 'probe must reject URL credentials');
assert.ok(probe.includes("'/health'"), 'probe must exercise process liveness');
assert.ok(probe.includes("'/ready'"), 'probe must exercise database-backed readiness');
assert.ok(probe.includes("'/metrics'"), 'probe must exercise the protected metrics surface');
assert.match(probe, /response\.status !== 401/, 'anonymous metrics access must require HTTP 401');
assert.match(probe, /includes\('no-store'\)/, 'metrics refusal must remain non-cacheable');
assert.match(probe, /UUID_V7/, 'public API probes must prove request correlation headers');
assert.match(
  probe,
  /deploymentIdentityBound: false/,
  'environment availability evidence must not be misrepresented as deployment identity proof',
);
assert.doesNotMatch(
  probe,
  /authorization\s*:/i,
  'probe implementation must remain anonymous and secret-free',
);

console.log('[ok] external staging probe contract: public TLS, liveness, readiness, protected metrics, web');
