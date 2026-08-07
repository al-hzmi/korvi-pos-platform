import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The security gate must fail closed.
 *
 * Revision 2's gate could report PASS when it had not actually established
 * anything: a network failure, an empty file or malformed JSON all fell through
 * to "no advisories". A gate that passes when it could not run is worse than no
 * gate, because it reports safety it never checked.
 *
 * Each case below feeds the gate a report and asserts on the exit code.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../..');
const script = join(root, 'scripts/audit.sh');

interface Result {
  readonly code: number;
  readonly output: string;
}

/** Run the gate against a prepared report without invoking npm. */
function runGate(reportBody: string | null, allowlist = ''): Result {
  const dir = mkdtempSync(join(tmpdir(), 'korvi-audit-'));
  const reportPath = join(dir, 'report.json');
  const allowlistPath = join(dir, 'allowlist.txt');

  if (reportBody !== null) writeFileSync(reportPath, reportBody);
  writeFileSync(allowlistPath, allowlist);

  try {
    const output = execFileSync('bash', [script], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AUDIT_REPORT: reportPath,
        AUDIT_ALLOWLIST: allowlistPath,
        KORVI_AUDIT_SKIP_NPM: '1',
      },
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

const CLEAN = JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: {} } });

const withAdvisory = (id: string, severity = 'high'): string =>
  JSON.stringify({
    vulnerabilities: {
      somepkg: {
        name: 'somepkg',
        severity,
        via: [{ severity, title: 'Example', url: `https://github.com/advisories/${id}` }],
      },
    },
    metadata: { vulnerabilities: { [severity]: 1 } },
  });

describe('fail-closed behaviour', () => {
  it('passes only on a valid, clean report', () => {
    expect(runGate(CLEAN).code).toBe(0);
  });

  it('fails when the report is missing entirely', () => {
    expect(runGate(null).code).not.toBe(0);
  });

  it('fails on an empty report', () => {
    expect(runGate('').code).not.toBe(0);
  });

  it('fails on malformed JSON', () => {
    const result = runGate('{ not json');
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/not valid JSON|no output/i);
  });

  it('fails on an unexpected schema', () => {
    // npm has changed this shape between majors; reading an unknown structure
    // as "no vulnerabilities" is the false pass this guards.
    const result = runGate(JSON.stringify({ something: 'else' }));
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/schema|vulnerabilities/i);
  });

  it('fails when npm reports an error object', () => {
    const result = runGate(JSON.stringify({ error: { code: 'ENETUNREACH' } }));
    expect(result.code).not.toBe(0);
  });

  it('fails on a JSON array rather than an object', () => {
    expect(runGate('[]').code).not.toBe(0);
  });
});

describe('advisory handling', () => {
  it('fails on an unknown advisory', () => {
    expect(runGate(withAdvisory('GHSA-aaaa-bbbb-cccc')).code).not.toBe(0);
  });

  it('fails closed on a high vulnerability represented only by a string via', () => {
    const report = JSON.stringify({
      vulnerabilities: {
        top: { name: 'top', severity: 'high', via: ['dependency'] },
      },
      metadata: { vulnerabilities: { high: 1 } },
    });
    expect(runGate(report).code).not.toBe(0);
  });

  it('fails when metadata reports a high vulnerability but no entry is resolvable', () => {
    const report = JSON.stringify({
      vulnerabilities: {},
      metadata: { vulnerabilities: { high: 1 } },
    });
    expect(runGate(report).code).not.toBe(0);
  });

  it('passes a fully specified, unexpired exception', () => {
    const allow = 'GHSA-aaaa-bbbb-cccc  not reachable | reviewer | expires 2099-01-01';
    expect(runGate(withAdvisory('GHSA-aaaa-bbbb-cccc'), allow).code).toBe(0);
  });

  it('fails an expired exception', () => {
    const allow = 'GHSA-aaaa-bbbb-cccc  not reachable | reviewer | expires 2020-01-01';
    const result = runGate(withAdvisory('GHSA-aaaa-bbbb-cccc'), allow);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/expired/i);
  });

  it('rejects an allowlist entry with no expiry', () => {
    const allow = 'GHSA-aaaa-bbbb-cccc  not reachable | reviewer';
    const result = runGate(withAdvisory('GHSA-aaaa-bbbb-cccc'), allow);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/mandatory|Malformed/i);
  });

  it('rejects an allowlist entry with no owner', () => {
    const allow = 'GHSA-aaaa-bbbb-cccc  expires 2099-01-01';
    expect(runGate(withAdvisory('GHSA-aaaa-bbbb-cccc'), allow).code).not.toBe(0);
  });

  it('rejects an allowlist entry with an empty technical justification', () => {
    const allow = 'GHSA-aaaa-bbbb-cccc   | reviewer | expires 2099-01-01';
    expect(runGate(withAdvisory('GHSA-aaaa-bbbb-cccc'), allow).code).not.toBe(0);
  });

  it('does not let an exception for one advisory cover another', () => {
    const allow = 'GHSA-aaaa-bbbb-cccc  reviewed | reviewer | expires 2099-01-01';
    expect(runGate(withAdvisory('GHSA-dddd-eeee-ffff'), allow).code).not.toBe(0);
  });
});

describe('the shipped allowlist', () => {
  it('is empty, because next 16.3.0 needs no exceptions', () => {
    const entries = readFileSync(join(root, 'scripts/audit-allowlist.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(entries).toEqual([]);
  });
});
