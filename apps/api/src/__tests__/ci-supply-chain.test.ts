import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const workflowsDirectory = join(here, '../../../../.github/workflows');

function workflowFiles(): readonly string[] {
  return readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

function workflowSource(name: string): string {
  return readFileSync(join(workflowsDirectory, name), 'utf8');
}

describe('GitHub Actions supply-chain authority', () => {
  it('pins every external action to an immutable 40-character commit SHA', () => {
    for (const name of workflowFiles()) {
      const source = workflowSource(name);
      for (const line of source.split('\n')) {
        const match = /^\s*uses:\s*([^\s#]+)/.exec(line);
        if (match === null) continue;
        expect(match[1], `${name}: ${line.trim()}`).toMatch(/@[0-9a-f]{40}$/i);
      }
    }
  });

  it('never grants fork-controlled pull_request_target code a privileged workflow context', () => {
    for (const name of workflowFiles()) {
      expect(workflowSource(name), name).not.toMatch(/^\s{2}pull_request_target:\s*$/m);
    }
  });

  it('keeps OIDC-bearing workflows operator-triggered instead of push or pull-request triggered', () => {
    for (const name of workflowFiles()) {
      const source = workflowSource(name);
      if (!/^\s*id-token:\s*write\s*$/m.test(source)) continue;

      expect(source, name).toMatch(/^\s{2}workflow_dispatch:\s*$/m);
      expect(source, name).not.toMatch(/^\s{2}(?:push|pull_request|pull_request_target):\s*$/m);
    }
  });
});
