/**
 * Assert every pinned dependency is a real, published, non-prerelease version.
 *
 * A pin is only a guarantee if something checks it. This runs in `verify` and
 * in CI, so a dependency can never quietly drift onto a preview, beta or canary
 * build — including through a transitive bump or a hand edit.
 *
 * Deliberate departures from `latest` are listed in ALLOWED_BEHIND with the ADR
 * that justifies each. Anything else lagging `latest` FAILS: an undocumented
 * stale pin is how a project drifts onto an unmaintained line without anyone
 * deciding to, and "review when convenient" is a message nobody acts on.
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

const PRERELEASE = /-(alpha|beta|rc|canary|preview|next|dev|insiders|experimental|nightly)/i;

/**
 * The public registry, named explicitly.
 *
 * Never `npm config get registry`: a mirror can serve stale metadata, or
 * versions that do not exist upstream. A pin verified against a mirror is not
 * verified. Overridable only for an air-gapped build, and then deliberately.
 */
const REGISTRY = process.env.NPM_PUBLIC_REGISTRY ?? 'https://registry.npmjs.org';

/** Pin -> the ADR explaining why it is not `latest`. */
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
  if (!/^\d+\.\d+\.\d+$/.test(pin)) {
    console.error(`FAIL  ${name}: "${pin}" is not an exact version.`);
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

  if (tags.latest !== pin) {
    const reason = ALLOWED_BEHIND[name];
    if (reason === undefined) {
      console.error(
        `FAIL  ${name}@${pin} is behind latest (${tags.latest}) with no recorded reason.\n` +
          '      Upgrade it, or add an ALLOWED_BEHIND entry naming the ADR that justifies the pin.',
      );
      failures += 1;
    } else {
      console.log(`ok    ${name}@${pin} — behind ${tags.latest} on purpose. ${reason}`);
    }
    continue;
  }

  console.log(`ok    ${name}@${pin}`);
}

if (failures > 0) {
  console.error(`\n${failures} version check(s) failed.`);
  process.exit(1);
}
console.log('\nAll pins verified: published, stable, no prerelease tags.');
