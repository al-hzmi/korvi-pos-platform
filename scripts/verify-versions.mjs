/**
 * Assert every pinned dependency is a real, published, production-stable version.
 *
 * A pin is only a guarantee if something checks it. This runs in `verify` and
 * in CI, so a dependency can never quietly drift onto a preview, beta or canary
 * build — including through a transitive bump or a hand edit.
 *
 * Deliberate departures from the newest production-stable release are listed in
 * ALLOWED_BEHIND with the ADR that justifies each. Anything else lagging the
 * newest stable release FAILS.
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

const EXACT_STABLE = /^\d+\.\d+\.\d+$/;
const PRERELEASE = /-(alpha|beta|rc|canary|preview|next|dev|insiders|experimental|nightly)/i;

/**
 * The public registry, named explicitly.
 *
 * Never `npm config get registry`: a mirror can serve stale metadata, or
 * versions that do not exist upstream. A pin verified against a mirror is not
 * verified. Overridable only for an air-gapped build, and then deliberately.
 */
const REGISTRY = process.env.NPM_PUBLIC_REGISTRY ?? 'https://registry.npmjs.org';

/** Pin -> the ADR explaining why it is not the newest production-stable version. */
const ALLOWED_BEHIND = {
  typescript: 'ADR-0007: typescript-eslint declares `typescript <6.1.0`.',
  tailwindcss: 'ADR-0007: the design system ships a verified v3 config (v3-lts).',
  '@types/node':
    'ADR-0007: typings track the Node 24 runtime. A newer major describes APIs ' +
    'the runtime does not have, so code typechecks and then fails at run time.',
};

const manifests = [
  'package.json',
  ...globSync('packages/*/package.json'),
  ...globSync('apps/*/package.json'),
];

function compareStableVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index] - right[index];
    if (delta !== 0) return delta;
  }
  return 0;
}

function newestPublishedStable(versions) {
  return Object.keys(versions ?? {})
    .filter((version) => EXACT_STABLE.test(version))
    .sort(compareStableVersions)
    .at(-1);
}

const pins = new Map();
for (const file of manifests) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(json[field] ?? {})) {
      if (range === '*' || name.startsWith('@korvi/')) continue; // workspace links
      pins.set(name, range);
    }
  }
}

let failures = 0;

for (const [name, pin] of [...pins].sort()) {
  if (!EXACT_STABLE.test(pin)) {
    console.error(`FAIL  ${name}: "${pin}" is not an exact production-stable version.`);
    failures += 1;
    continue;
  }

  if (PRERELEASE.test(pin)) {
    console.error(`FAIL  ${name}@${pin} is a prerelease.`);
    failures += 1;
    continue;
  }

  const response = await fetch(`${REGISTRY}/${name}`);
  if (!response.ok) {
    console.error(`FAIL  ${name}: not found in the registry.`);
    failures += 1;
    continue;
  }

  const meta = await response.json();
  if (!Object.hasOwn(meta.versions ?? {}, pin)) {
    console.error(`FAIL  ${name}@${pin} is not published.`);
    failures += 1;
    continue;
  }

  const tags = meta['dist-tags'] ?? {};
  const holding = Object.entries(tags)
    .filter(([, version]) => version === pin)
    .map(([tag]) => tag);

  if (holding.some((tag) => PRERELEASE.test(`-${tag}`))) {
    console.error(
      `FAIL  ${name}@${pin} is only carried by a prerelease tag: ${holding.join(', ')}`,
    );
    failures += 1;
    continue;
  }

  // Registry publishers can temporarily point `latest` at an RC/preview. Korvi's
  // policy is production-stable, so a prerelease/non-triplet latest tag is never
  // an upgrade target. In that case compare against the newest published stable
  // x.y.z instead of teaching CI to chase a prerelease.
  const taggedLatest = tags.latest;
  const latestStable =
    typeof taggedLatest === 'string' && EXACT_STABLE.test(taggedLatest)
      ? taggedLatest
      : newestPublishedStable(meta.versions);

  if (latestStable === undefined) {
    console.error(`FAIL  ${name}: registry exposes no production-stable release.`);
    failures += 1;
    continue;
  }

  if (taggedLatest !== latestStable) {
    console.log(
      `note  ${name}: latest dist-tag is ${String(taggedLatest)}; production-stable target is ${latestStable}.`,
    );
  }

  if (latestStable !== pin) {
    const reason = ALLOWED_BEHIND[name];
    if (reason === undefined) {
      console.error(
        `FAIL  ${name}@${pin} is behind newest stable (${latestStable}) with no recorded reason.\n` +
          '      Upgrade it, or add an ALLOWED_BEHIND entry naming the ADR that justifies the pin.',
      );
      failures += 1;
    } else {
      console.log(`ok    ${name}@${pin} — behind ${latestStable} on purpose. ${reason}`);
    }
    continue;
  }

  console.log(`ok    ${name}@${pin}`);
}

if (failures > 0) {
  console.error(`\n${failures} version check(s) failed.`);
  process.exit(1);
}
console.log('\nAll pins verified: published, production-stable, no prerelease targets.');
