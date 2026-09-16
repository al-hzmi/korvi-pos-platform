#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const declaration = pkg.packageManager;

if (typeof declaration !== 'string') {
  console.error('[fail] package.json must declare an exact npm packageManager');
  process.exit(1);
}

const match = /^npm@(\d+\.\d+\.\d+)$/.exec(declaration);
if (match === null) {
  console.error(
    `[fail] packageManager must be an exact npm version, got ${JSON.stringify(declaration)}`,
  );
  process.exit(1);
}

const expected = match[1];
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let actual;
try {
  // Windows command shims such as npm.cmd are batch files rather than native
  // executables. Node 24 rejects direct spawnSync of .cmd files with EINVAL,
  // so only that platform uses its command interpreter. The command and
  // argument are fixed constants; no user-controlled value reaches the shell.
  actual = execFileSync(command, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim();
} catch (error) {
  console.error('[fail] npm is not executable in this environment');
  throw error;
}

if (actual !== expected) {
  console.error(
    `[fail] npm ${actual} does not match package.json packageManager npm@${expected}. ` +
      'Use the declared package manager before installing, building, migrating, or testing Korvi.',
  );
  process.exit(1);
}

console.log(`[ok] npm ${actual} matches packageManager`);
