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
let actual;
try {
  if (process.platform === 'win32') {
    // npm.cmd is a batch shim. Node 24 rejects executing it directly with
    // spawnSync/execFileSync, so invoke the Windows command interpreter with a
    // fixed command string. No user-controlled value reaches cmd.exe.
    actual = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd --version'], {
      encoding: 'utf8',
    }).trim();
  } else {
    actual = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  }
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
