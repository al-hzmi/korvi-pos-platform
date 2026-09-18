import { readFileSync } from 'node:fs';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const npmrc = readFileSync('.npmrc', 'utf8');

function packageNameFromLockPath(path) {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index < 0) return null;
  const tail = path.slice(index + marker.length);
  const parts = tail.split('/');
  if (parts[0]?.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] ?? null;
}

const expected = new Set();
for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  if (meta === null || typeof meta !== 'object' || meta.hasInstallScript !== true) continue;
  const name = packageNameFromLockPath(path);
  if (name === null || typeof meta.version !== 'string') {
    console.error(`FAIL  cannot derive pinned install-script identity from lock entry: ${path}`);
    process.exit(1);
  }
  expected.add(`${name}@${meta.version}`);
}

const policy = root.allowScripts;
if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
  console.error('FAIL  package.json#allowScripts must be an object of exact approvals.');
  process.exit(1);
}

const approved = Object.entries(policy);
let failures = 0;
for (const [key, value] of approved) {
  if (value !== true) {
    console.error(`FAIL  allowScripts approval must be true for reviewed identity: ${key}`);
    failures += 1;
  }
  if (!expected.has(key)) {
    console.error(`FAIL  broad, stale, or unknown install-script approval: ${key}`);
    failures += 1;
  }
}
for (const key of [...expected].sort()) {
  if (!Object.hasOwn(policy, key)) {
    console.error(`FAIL  unreviewed dependency install script: ${key}`);
    failures += 1;
  }
}

if (!/^strict-allow-scripts=true$/mu.test(npmrc)) {
  console.error('FAIL  .npmrc must set strict-allow-scripts=true.');
  failures += 1;
}
if (/^dangerously-allow-all-scripts=true$/mu.test(npmrc)) {
  console.error('FAIL  dangerously-allow-all-scripts must never be enabled.');
  failures += 1;
}

if (failures > 0) process.exit(1);
console.log(
  `[ok] install-script policy: ${String(expected.size)} exact lockfile approvals; strict fail-closed enabled`,
);
