import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const RELEASE_BRANCH = 'review/operations-50-production-readiness';
const API_SERVICE = 'korvi-staging-api';
const WEB_SERVICE = 'korvi-staging-web';

const [configSource, blueprint] = await Promise.all([
  readFile(new URL('../apps/api/src/config.ts', import.meta.url), 'utf8'),
  readFile(new URL('../render.yaml', import.meta.url), 'utf8'),
]);

const secretDeclaration = configSource.match(
  /export const PRODUCTION_REQUIRED_SECRET_ENV_KEYS = \[([\s\S]*?)\] as const;/,
);
assert.ok(secretDeclaration, 'config.ts must export PRODUCTION_REQUIRED_SECRET_ENV_KEYS');

const requiredSecrets = [...secretDeclaration[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map(
  (match) => match[1],
);
assert.ok(requiredSecrets.length > 0, 'production required-secret list must not be empty');
assert.equal(
  new Set(requiredSecrets).size,
  requiredSecrets.length,
  'production required-secret list must not contain duplicates',
);

function serviceBlock(name) {
  const marker = `    name: ${name}\n`;
  const markerIndex = blueprint.indexOf(marker);
  assert.notEqual(markerIndex, -1, `render.yaml must define ${name}`);

  const serviceStart = blueprint.lastIndexOf('  - type:', markerIndex);
  assert.notEqual(serviceStart, -1, `render.yaml service ${name} must have a service boundary`);

  const nextService = blueprint.indexOf('\n  - type:', markerIndex + marker.length);
  const databases = blueprint.indexOf('\ndatabases:', markerIndex + marker.length);
  const candidates = [nextService, databases].filter((index) => index !== -1);
  const serviceEnd = candidates.length === 0 ? blueprint.length : Math.min(...candidates);
  return blueprint.slice(serviceStart, serviceEnd);
}

function scalar(block, key) {
  const matches = [...block.matchAll(new RegExp(`^    ${key}: (.+)$`, 'gm'))];
  assert.equal(matches.length, 1, `${key} must appear exactly once in service block`);
  return matches[0][1].replace(/^['"]|['"]$/g, '');
}

function envEntries(block) {
  const envIndex = block.indexOf('    envVars:\n');
  assert.notEqual(envIndex, -1, 'service must define envVars');
  const envBlock = block.slice(envIndex + '    envVars:\n'.length);
  const entryPattern = /^ {6}- key: ([A-Z][A-Z0-9_]*)\n((?: {8}.+\n?)*)/gm;
  const entries = new Map();

  for (const match of envBlock.matchAll(entryPattern)) {
    const key = match[1];
    assert.ok(!entries.has(key), `env var ${key} must not be duplicated`);
    entries.set(key, match[2]);
  }
  return entries;
}

const api = serviceBlock(API_SERVICE);
const web = serviceBlock(WEB_SERVICE);

for (const [name, block] of [
  [API_SERVICE, api],
  [WEB_SERVICE, web],
]) {
  assert.equal(
    scalar(block, 'branch'),
    RELEASE_BRANCH,
    `${name} must deploy the release-candidate branch`,
  );
  assert.equal(
    scalar(block, 'autoDeployTrigger'),
    'off',
    `${name} must require a controlled deploy`,
  );
}

const apiEnv = envEntries(api);
assert.match(apiEnv.get('NODE_ENV') ?? '', /^ {8}value: production$/m);
assert.match(apiEnv.get('KORVI_ENVIRONMENT') ?? '', /^ {8}value: staging$/m);

for (const key of requiredSecrets) {
  const definition = apiEnv.get(key);
  assert.ok(definition, `staging API must provision production secret ${key}`);
  assert.match(definition, /^ {8}generateValue: true$/m, `${key} must be provider-generated`);
  assert.doesNotMatch(definition, /^ {8}value:/m, `${key} must never be hardcoded`);
  assert.doesNotMatch(
    definition,
    /^ {8}sync:/m,
    `${key} must not depend on an ignored Blueprint sync`,
  );
}

assert.ok(apiEnv.has('DATABASE_URL'), 'staging API must declare DATABASE_URL');
assert.ok(apiEnv.has('APP_ORIGINS'), 'staging API must declare APP_ORIGINS');
assert.match(apiEnv.get('DATABASE_URL') ?? '', /^ {8}sync: false$/m);
assert.match(apiEnv.get('APP_ORIGINS') ?? '', /^ {8}sync: false$/m);

console.log(
  `[ok] deployment contract: ${requiredSecrets.length} production secrets, controlled same-branch staging`,
);
