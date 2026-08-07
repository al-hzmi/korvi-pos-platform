import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Toolchain consistency.
 *
 * Revision 2 required Node 24 in its runtime guard and then wrote `22` into
 * `.nvmrc`, so CI — which reads `.nvmrc` — ran the whole suite on Node 22 while
 * developers ran it on 24. Two different runtimes, one green tick, and nothing
 * in the repository noticed.
 *
 * These assertions read the files rather than trusting them to agree.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../..');

const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');
const json = (relative: string): Record<string, unknown> =>
  JSON.parse(read(relative)) as Record<string, unknown>;

const NVMRC_MAJOR = Number.parseInt(read('.nvmrc').trim(), 10);

describe('Node version is declared consistently', () => {
  it('has a parseable .nvmrc', () => {
    expect(Number.isInteger(NVMRC_MAJOR)).toBe(true);
    expect(NVMRC_MAJOR).toBeGreaterThanOrEqual(24);
  });

  it('matches the runtime actually executing this test', () => {
    // The check revision 2 lacked: a mismatch here means local and CI results
    // are not comparable, whatever the tick says.
    const runtimeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    expect(runtimeMajor).toBe(NVMRC_MAJOR);
  });

  it('matches package.json engines', () => {
    const engines = json('package.json').engines as { node?: string } | undefined;
    expect(engines?.node).toBeDefined();
    const declared = Number.parseInt((engines?.node ?? '').replace(/[^0-9]/g, '').slice(0, 2), 10);
    expect(declared).toBe(NVMRC_MAJOR);
  });

  it('matches the dev container image', () => {
    const devcontainer = json('.devcontainer/devcontainer.json') as { image?: string };
    expect(devcontainer.image).toContain(`-${String(NVMRC_MAJOR)}-`);
  });

  it('is what CI resolves, via node-version-file', () => {
    // Reading .nvmrc is what makes CI follow this file rather than drift.
    expect(read('.github/workflows/ci.yml')).toContain('node-version-file: .nvmrc');
  });

  it('is what the setup guard enforces', () => {
    expect(read('README.md')).toContain(`Node ${String(NVMRC_MAJOR)} LTS`);
  });
});

describe('@types/node tracks the runtime', () => {
  it('is pinned to the same major as the runtime', () => {
    // Typings from a newer major describe APIs the runtime does not have, so
    // code typechecks and then fails at run time.
    const devDeps = json('package.json').devDependencies as Record<string, string>;
    const pin = devDeps['@types/node'] ?? '';
    const typesMajor = Number.parseInt(pin.split('.')[0] ?? '0', 10);
    expect(typesMajor).toBe(NVMRC_MAJOR);
  });
});

describe('dependency pins', () => {
  const rootPkg = json('package.json');
  const devDeps = rootPkg.devDependencies as Record<string, string>;

  it('are exact, never ranges', () => {
    for (const [name, range] of Object.entries(devDeps)) {
      expect(range, `${name} must be an exact version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('carry no prerelease identifiers', () => {
    for (const [name, range] of Object.entries(devDeps)) {
      expect(range, `${name} must not be a prerelease`).not.toMatch(
        /-(alpha|beta|rc|canary|preview|next|dev)/i,
      );
    }
  });

  it('verify against the public registry, not whatever npm is configured with', () => {
    // A mirror can serve stale or non-existent metadata; a pin checked against
    // one is not checked.
    const verifier = read('scripts/verify-versions.mjs');
    expect(verifier).toContain("'https://registry.npmjs.org'");
    // The default registry is never *read* — only mentioned in the comment
    // explaining why it is not used.
    expect(verifier).not.toMatch(/execSync[^\n]*npm config get registry/);
  });

  it('installs and audits from that same public registry in CI', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('registry.npmjs.org');
  });
});

describe('supply-chain posture', () => {
  it('never disables npm audit', () => {
    expect(read('.npmrc')).not.toMatch(/^\s*audit\s*=\s*false/m);
  });

  it('uses npm ci with no fallback to npm install', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/run: npm ci(\s|--)/);
    expect(ci).not.toContain('npm ci || npm install');
    expect(ci).not.toMatch(/npm ci[^\n]*\|\|/);
  });

  it('pins every action to a commit SHA', () => {
    for (const match of read('.github/workflows/ci.yml').matchAll(/uses: (\S+)/g)) {
      expect(match[1], `${match[1] ?? ''} must be pinned to a 40-character SHA`).toMatch(
        /@[0-9a-f]{40}$/,
      );
    }
  });

  it('grants least privilege by default', () => {
    expect(read('.github/workflows/ci.yml')).toMatch(/permissions:\s+contents: read/);
  });
});
