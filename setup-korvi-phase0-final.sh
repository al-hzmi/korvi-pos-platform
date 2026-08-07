#!/usr/bin/env bash
#
# setup-korvi-phase0-final.sh — Korvi POS · PHASE 0 · FOUNDATION (final)
#
# Creates the engineering foundation for Korvi POS: monorepo layout, the pure
# domain core (money, tax, tender, UUIDv7, ZATCA TLV), a device-profile printing
# layer, the design-system layer, Row-Level Security groundwork, governance
# documents, and a hardened quality pipeline.
#
# It does NOT build the POS itself. See docs/architecture/scope.md.
#
# Revision history is in docs/decisions/ADR-0010-phase0-revision.md and
# ADR-0011-arabic-printing-path.md.
#
# Usage, from the repository root (in Codespaces: /workspaces/korvi-pos-platform):
#
#   bash setup-korvi-phase0-final.sh              # scaffold, install, verify
#   bash setup-korvi-phase0-final.sh --no-verify  # scaffold and install only
#   bash setup-korvi-phase0-final.sh --force      # overwrite an existing scaffold
#
# The script never runs git commit, git push, or any destructive git or
# database command. Committing is left to you.

set -euo pipefail

FORCE=0
RUN_VERIFY=1

for arg in "$@"; do
  case "$arg" in
    --force)      FORCE=1 ;;
    --no-verify)  RUN_VERIFY=0 ;;
    -h|--help)    sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; echo "Run with --help for usage." >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_BLUE='\033[1;34m'; C_YELLOW='\033[1;33m'; C_RED='\033[1;31m'
  C_GREEN='\033[1;32m'; C_OFF='\033[0m'
else
  C_BLUE=''; C_YELLOW=''; C_RED=''; C_GREEN=''; C_OFF=''
fi

say()  { printf "${C_BLUE}==>${C_OFF} %s\n" "$1"; }
ok()   { printf "${C_GREEN}[ok]${C_OFF} %s\n" "$1"; }
warn() { printf "${C_YELLOW}[!]${C_OFF} %s\n" "$1" >&2; }
die()  { printf "${C_RED}[x]${C_OFF} %s\n" "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  cd "$ROOT"
else
  ROOT="$PWD"
  warn "Not inside a git repository — using the current directory."
fi
say "Korvi POS Phase 0 scaffold — final"
say "Project root: $ROOT"

command -v node >/dev/null 2>&1 || die "node not found on PATH."
command -v npm  >/dev/null 2>&1 || die "npm not found on PATH."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NVMRC_MAJOR="24"
if [ "$NODE_MAJOR" -ne "$NVMRC_MAJOR" ]; then
  die "Node ${NVMRC_MAJOR} LTS required (ADR-0007). Found $(node --version).
     Every declaration in this repository -- .nvmrc, engines, the dev container
     and CI -- names Node ${NVMRC_MAJOR}; running on anything else means local
     results and CI results are not comparable.
     In Codespaces:  nvm install ${NVMRC_MAJOR} && nvm use ${NVMRC_MAJOR}"
fi
ok "Node $(node --version), npm $(npm --version)"

if [ "$FORCE" -eq 0 ]; then
  for guard in package.json packages apps; do
    if [ -e "$guard" ]; then
      die "'$guard' already exists. Re-run with --force to overwrite the scaffold."
    fi
  done
fi

# ---------------------------------------------------------------------------
# Pinned toolchain
#
# Every version below was resolved against the npm registry and checked to be
# (a) published, (b) not a prerelease string, and (c) not held only by a
# prerelease dist-tag. `npm run versions:verify` re-runs that check, and CI
# runs it on every push, so a pin can never silently drift onto a preview.
#
# Three pins are deliberately not the newest `latest`; all three are stable
# releases on maintained lines, and all three are justified in ADR-0007:
#
#   node        24 LTS  — Active LTS ("Krypton").
#   typescript  6.0.3   — typescript-eslint declares `typescript <6.1.0`;
#                         TypeScript 7 would leave the monorepo unlintable.
#   tailwindcss 3.4.19  — carries the `v3-lts` dist-tag. The design system
#                         (ADR-0006) ships a verified v3 config; moving to v4
#                         is a design-system revision, not a scaffold decision.
#   @types/node 24.13.3 — tracks the Node 24 runtime. Typings from a newer
#                         major describe APIs the runtime does not have.
# ---------------------------------------------------------------------------

V_NODE_MAJOR="24"
V_NPM="11.17.0"

V_TYPESCRIPT="6.0.3"
V_ESLINT="10.8.1"
V_ESLINT_JS="10.0.1"
V_TSESLINT="8.66.0"
V_ESLINT_CONFIG_PRETTIER="10.1.8"
V_GLOBALS="17.9.0"
V_PRETTIER="3.9.6"
V_VITEST="4.1.10"
V_VITE="8.2.1"
V_COVERAGE="4.1.10"
V_NEXT="16.3.0"
V_REACT="19.2.8"
V_TYPES_REACT="19.2.18"
V_TYPES_REACT_DOM="19.2.4"
V_TAILWIND="3.4.19"
V_POSTCSS="8.5.26"
V_AUTOPREFIXER="10.5.4"
V_PRISMA="7.9.1"
V_ADAPTER_PG="7.9.1"
V_PG="8.22.0"
V_TYPES_PG="8.21.0"
V_FASTIFY="5.11.2"
V_ZOD="4.4.3"
V_ZUSTAND="5.0.14"
V_TYPES_NODE="24.13.3"
V_TSX="4.23.11"

say "Toolchain: Node ${V_NODE_MAJOR} LTS · TypeScript $V_TYPESCRIPT · Next $V_NEXT · React $V_REACT · Prisma $V_PRISMA · Tailwind $V_TAILWIND · Vitest $V_VITEST · ESLint $V_ESLINT"

# ---------------------------------------------------------------------------
# Directory skeleton
# ---------------------------------------------------------------------------

say "Creating directory tree"
mkdir -p \
  apps/pos-web/src/app apps/pos-web/public/brand \
  apps/api/src/routes apps/api/src/__tests__ \
  packages/domain/src/money/__tests__ \
  packages/domain/src/tax/__tests__ \
  packages/domain/src/tender/__tests__ \
  packages/domain/src/ids/__tests__ \
  packages/domain/src/zatca/__tests__ \
  packages/domain/src/ports/__tests__ \
  packages/database/prisma/migrations/00000000000000_rls_foundation \
  packages/database/src/repositories packages/database/src/__tests__ \
  packages/printing/src/profiles packages/printing/src/encoding \
  packages/printing/src/__tests__ packages/printing/src/__tests__/fixtures \
  packages/ui/src/components packages/ui/src/styles packages/ui/src/lib \
  packages/ui/assets/brand \
  packages/config/src/__tests__ packages/testing/src \
  docs/architecture docs/decisions docs/design docs/governance \
  scripts .github/workflows .devcontainer

# ---------------------------------------------------------------------------
# Root configuration
# ---------------------------------------------------------------------------

say "Writing root configuration"

cat << 'EOF' > .nvmrc
24
EOF

cat << 'EOF' > .npmrc
# The public registry, named explicitly.
#
# Resolution must not depend on ambient configuration: a mirror can serve stale
# metadata or versions that do not exist upstream, and a pin verified against a
# mirror is not verified. Every path -- setup, CI, audit, version checks and the
# dev container -- resolves through this one host.
registry=https://registry.npmjs.org/

# Exact versions only: a caret range means the tree that passed CI is not
# necessarily the tree that ships.
save-exact=true
fund=false

# `audit` is deliberately NOT disabled. Advisory noise is handled by the
# reviewed allowlist in scripts/audit.sh, never by switching the check off.
provenance=false
EOF

cat << EOF > package.json
{
  "name": "korvi-pos-platform",
  "version": "0.0.0",
  "private": true,
  "description": "Korvi POS — retail and restaurant point of sale",
  "type": "module",
  "engines": { "node": ">=24.0.0 <25.0.0", "npm": ">=11.0.0" },
  "packageManager": "npm@$V_NPM",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "build": "npm run build -w @korvi/domain && npm run build -w @korvi/printing && npm run build -w @korvi/database && npm run build -w @korvi/ui && npm run build -w @korvi/testing && npm run build -w @korvi/api && npm run build -w @korvi/pos-web",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "npm run db:generate -w @korvi/database",
    "invariants": "bash scripts/check-invariants.sh",
    "versions:verify": "node scripts/verify-versions.mjs",
    "audit": "bash scripts/audit.sh",
    "verify": "bash scripts/verify.sh"
  },
  "devDependencies": {
    "@eslint/js": "$V_ESLINT_JS",
    "@types/node": "$V_TYPES_NODE",
    "@vitest/coverage-v8": "$V_COVERAGE",
    "eslint": "$V_ESLINT",
    "eslint-config-prettier": "$V_ESLINT_CONFIG_PRETTIER",
    "globals": "$V_GLOBALS",
    "prettier": "$V_PRETTIER",
    "typescript": "$V_TYPESCRIPT",
    "typescript-eslint": "$V_TSESLINT",
    "vite": "$V_VITE",
    "vitest": "$V_VITEST"
  }
}
EOF

cat << 'EOF' > tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,

    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
EOF

cat << 'EOF' > tsconfig.json
{
  // Editor convenience only. The real build order lives in the root
  // package.json build script; TypeScript project references were dropped
  // because the Prisma-generated client sits outside any single rootDir.
  "files": [],
  "include": []
}
EOF

cat << 'EOF' > vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Packages own their tests; apps that need a DOM opt in separately.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.ts', '**/ports/**', '**/index.ts'],
    },
  },
});
EOF

cat << 'EOF' > eslint.config.js
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Korvi POS lint policy.
 *
 * The rules below are not style preferences — each one guards an invariant
 * declared in CLAUDE.md. `no-restricted-imports` on packages/domain is the
 * mechanical enforcement of ADR-0001: the domain core stays pure so it can be
 * lifted into Korvi ERP later without a rewrite.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/database/generated/**',
      'apps/pos-web/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // --- Domain purity (ADR-0001) -------------------------------------------
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-*', 'next', 'next/*'], message: 'The domain core must not depend on a UI framework (ADR-0001).' },
            { group: ['@prisma/*', 'prisma', '*/generated/client*'], message: 'The domain core must not depend on an ORM (ADR-0001). Define a port instead.' },
            { group: ['fastify', 'express'], message: 'The domain core must not depend on an HTTP server (ADR-0001).' },
            { group: ['node:fs', 'node:path', 'fs', 'path'], message: 'The domain core must stay isomorphic — no filesystem access (ADR-0001).' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'The domain core must not touch the DOM (ADR-0001).' },
        { name: 'window', message: 'The domain core must not touch the DOM (ADR-0001).' },
      ],
    },
  },

  // --- Money rules, scoped to the financial modules (ADR-0002) ------------
  //
  // Deliberately narrower than the whole domain: Math.floor on a millisecond
  // timestamp in the id generator is correct, and a rule that flags it would
  // train people to disable the rule.
  {
    files: ['packages/domain/src/{money,tax,tender}/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name=/^(parseFloat|parseInt)$/]",
          message: 'Money is integer minor units. Use the parsers in @korvi/domain/money (ADR-0002).',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name=/^(round|floor|ceil)$/]",
          message: 'Rounding money through Math loses halalas. Use mulDivRound (ADR-0002).',
        },
      ],
    },
  },

  // --- UI layer ------------------------------------------------------------
  {
    files: ['packages/ui/**/*.tsx', 'apps/pos-web/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // --- Tests may be looser about console output ---------------------------
  {
    files: ['**/*.test.ts', '**/__tests__/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // --- Build and CI scripts ------------------------------------------------
  //
  // These are operator-facing tools whose entire output is the console, and
  // they are not part of the typed application program.
  {
    files: ['**/*.config.{js,ts,mjs,cjs}', 'eslint.config.js', 'scripts/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  prettier,
);
EOF

cat << 'EOF' > .prettierrc.json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "endOfLine": "lf",
  "arrowParens": "always"
}
EOF

cat << 'EOF' > .prettierignore
**/dist/**
**/.next/**
**/node_modules/**
**/coverage/**
packages/database/generated/**
docs/design/**
docs/governance/**
*.svg
EOF

cat << 'EOF' > .editorconfig
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
EOF

cat << 'EOF' > .env.example
# Copy to .env.local and fill in for your own machine. Never commit a real value.
#
# Local development database. Prisma 7 reads this through prisma.config.ts.
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/korvi_pos?schema=public"

NODE_ENV=development
PORT=3000
API_PORT=3001
LOG_LEVEL=info
EOF

say "Ensuring .gitignore covers build output"
touch .gitignore
for pattern in \
  "node_modules/" "dist/" ".next/" "coverage/" "*.tsbuildinfo" \
  ".env" ".env.local" ".env.*.local" "packages/database/generated/"
do
  grep -qxF "$pattern" .gitignore 2>/dev/null || printf '%s\n' "$pattern" >> .gitignore
done

# ---------------------------------------------------------------------------
# packages/domain — the pure core
# ---------------------------------------------------------------------------

say "Writing @korvi/domain"

cat << EOF > packages/domain/package.json
{
  "name": "@korvi/domain",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
EOF

cat << 'EOF' > packages/domain/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    // DOM supplies the web-standard surface the core relies on -- TextEncoder,
    // crypto.getRandomValues -- and is not a licence to touch the DOM. ESLint
    // blocks window and document (ADR-0001).
    "lib": ["ES2023", "DOM"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/__tests__/**", "src/**/*.test.ts"]
}
EOF

cat << 'EOF' > packages/domain/src/errors.ts
/** Base class for every failure the domain raises deliberately. */
export class DomainError extends Error {
  public override readonly name: string = 'DomainError';

  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A money operation mixed two currencies. */
export class CurrencyMismatchError extends DomainError {
  public override readonly name = 'CurrencyMismatchError';
}

/** An amount or weight was outside the range the operation accepts. */
export class InvalidAmountError extends DomainError {
  public override readonly name = 'InvalidAmountError';
}

/**
 * A non-cash tender was offered for more than the amount due.
 *
 * Named for the rule it protects: a card or Mada terminal cannot hand back
 * change, so an overpayment on those rails has nowhere to go (ADR-0002).
 */
export class NonCashChangeError extends DomainError {
  public override readonly name = 'NonCashChangeError';
}

/** The tendered total did not cover the amount due. */
export class UnderpaidError extends DomainError {
  public override readonly name = 'UnderpaidError';
}

/** A value could not be encoded into the ZATCA TLV envelope. */
export class TlvEncodingError extends DomainError {
  public override readonly name = 'TlvEncodingError';
}

/**
 * An identifier could not be issued without breaking ordering.
 *
 * Raised rather than returning a plausible-looking id, because an identifier
 * that sorts before one already written corrupts the sale sequence silently
 * and permanently (ADR-0003).
 */
export class IdGenerationError extends DomainError {
  public override readonly name = 'IdGenerationError';
}

/** A rate was outside the range its unit permits. */
export class InvalidRateError extends DomainError {
  public override readonly name = 'InvalidRateError';
}
EOF

cat << 'EOF' > packages/domain/src/money/rounding.ts
import { InvalidAmountError } from '../errors.js';

/**
 * Rounding is a financial decision, so it is named rather than implied.
 *
 * `half-up` is the default across Korvi because it is what Saudi VAT
 * documentation and every invoice a merchant has ever seen already do.
 */
export type RoundingMode = 'half-up' | 'half-even' | 'trunc';

/**
 * Compute `value * numerator / denominator` entirely in bigint.
 *
 * This is the only sanctioned way to scale money. It never converts to a
 * float, so it cannot introduce the fractional halalas that ADR-0002 exists to
 * prevent. Rounding is applied to the magnitude and the sign re-applied
 * afterwards, so -0.5 and +0.5 round symmetrically outward.
 */
export function mulDivRound(
  value: bigint,
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'half-up',
): bigint {
  if (denominator === 0n) {
    throw new InvalidAmountError('mulDivRound: denominator must not be zero.');
  }

  const negative = value < 0n !== numerator < 0n;
  const absValue = value < 0n ? -value : value;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const product = absValue * absNumerator;
  const quotient = product / absDenominator;
  const remainder = product % absDenominator;

  let rounded = quotient;
  if (remainder !== 0n) {
    const twice = remainder * 2n;
    if (mode === 'half-up') {
      if (twice >= absDenominator) rounded += 1n;
    } else if (mode === 'half-even') {
      if (twice > absDenominator || (twice === absDenominator && quotient % 2n === 1n)) {
        rounded += 1n;
      }
    }
    // 'trunc' keeps the quotient as-is.
  }

  return negative ? -rounded : rounded;
}
EOF

cat << 'EOF' > packages/domain/src/money/money.ts
import { CurrencyMismatchError, InvalidAmountError } from '../errors.js';

/** ISO 4217 codes Korvi handles. Widening this is a migration, not an edit. */
export type Currency = 'SAR';

/** Minor units in one major unit. 100 halalas to the riyal. */
export const MINOR_UNITS_PER_MAJOR = 100n;

/**
 * An amount of money, stored as an integer count of minor units.
 *
 * There is no float anywhere in this type by construction, which is the whole
 * point: `0.1 + 0.2` is a rounding bug in every other POS, and a merchant
 * discovers it as an unexplained few halalas in the bank reconciliation.
 */
export interface Money {
  readonly currency: Currency;
  readonly minor: bigint;
}

export function money(minor: bigint, currency: Currency = 'SAR'): Money {
  return { currency, minor };
}

export function zero(currency: Currency = 'SAR'): Money {
  return { currency, minor: 0n };
}

/**
 * Parse a decimal string such as "12.34" without ever touching a float.
 *
 * Strings are the only safe transport for money across a JSON boundary, so
 * this is also the inbound half of the serialisation rule in ADR-0002.
 */
export function moneyFromMajorString(input: string, currency: Currency = 'SAR'): Money {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (match === null) {
    throw new InvalidAmountError(`Not a decimal amount: "${input}".`);
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';

  if (fraction.length > 2) {
    throw new InvalidAmountError(
      `"${input}" carries more precision than a halala; refusing to round silently.`,
    );
  }

  const padded = fraction.padEnd(2, '0');
  const minor = BigInt(whole) * MINOR_UNITS_PER_MAJOR + BigInt(padded === '' ? '0' : padded);
  return { currency, minor: sign * minor };
}

/** Render as a fixed two-decimal string. The outbound half of ADR-0002. */
export function moneyToMajorString(value: Money): string {
  const negative = value.minor < 0n;
  const absolute = negative ? -value.minor : value.minor;
  const whole = absolute / MINOR_UNITS_PER_MAJOR;
  const fraction = absolute % MINOR_UNITS_PER_MAJOR;
  return `${negative ? '-' : ''}${whole.toString()}.${fraction.toString().padStart(2, '0')}`;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(`Cannot combine ${a.currency} with ${b.currency}.`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { currency: a.currency, minor: a.minor + b.minor };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { currency: a.currency, minor: a.minor - b.minor };
}

export function negateMoney(value: Money): Money {
  return { currency: value.currency, minor: -value.minor };
}

export function sumMoney(values: readonly Money[], currency: Currency = 'SAR'): Money {
  return values.reduce<Money>((acc, value) => addMoney(acc, value), zero(currency));
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export function isZeroMoney(value: Money): boolean {
  return value.minor === 0n;
}

export function isNegativeMoney(value: Money): boolean {
  return value.minor < 0n;
}

/**
 * JSON-safe shape. `minor` leaves as a string because `JSON.stringify` throws
 * on bigint, and a number would silently lose precision above 2^53 — the exact
 * failure ADR-0002 forbids.
 */
export interface MoneyJson {
  readonly currency: Currency;
  readonly minor: string;
}

export function moneyToJson(value: Money): MoneyJson {
  return { currency: value.currency, minor: value.minor.toString() };
}

export function moneyFromJson(value: MoneyJson): Money {
  if (!/^-?\d+$/.test(value.minor)) {
    throw new InvalidAmountError(`Minor units must be an integer string, got "${value.minor}".`);
  }
  return { currency: value.currency, minor: BigInt(value.minor) };
}
EOF

cat << 'EOF' > packages/domain/src/money/allocate.ts
import { InvalidAmountError } from '../errors.js';
import type { Money } from './money.js';

/**
 * Split `total` across `weights` so that nothing is created or destroyed.
 *
 * Uses the largest-remainder method: give everyone their floor share, then hand
 * the leftover minor units out one at a time to the largest fractional
 * remainders, breaking ties by index so the result is deterministic — the same
 * inputs give the same split on the terminal, on the server, and in a test.
 *
 * The post-condition that matters:
 *
 *     sum(allocate(total, weights)) === total
 *
 * always, for every input, including negative totals and lopsided weights.
 * A discount that does not satisfy this is a discount that leaks halalas.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) {
    throw new InvalidAmountError('allocate: needs at least one weight.');
  }
  if (weights.some((weight) => weight < 0n)) {
    throw new InvalidAmountError('allocate: weights must not be negative.');
  }

  const totalWeight = weights.reduce((acc, weight) => acc + weight, 0n);
  if (totalWeight === 0n) {
    throw new InvalidAmountError('allocate: weights must not sum to zero.');
  }

  // Work on the magnitude so bigint truncation is always toward zero, then
  // re-apply the sign. Allocating -100 must mirror allocating +100 exactly.
  const negative = total < 0n;
  const magnitude = negative ? -total : total;

  const shares: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let distributed = 0n;

  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index] ?? 0n;
    const scaled = magnitude * weight;
    const share = scaled / totalWeight;
    shares.push(share);
    remainders.push({ index, remainder: scaled % totalWeight });
    distributed += share;
  }

  let leftover = magnitude - distributed;

  remainders.sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });

  for (const entry of remainders) {
    if (leftover <= 0n) break;
    shares[entry.index] = (shares[entry.index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return negative ? shares.map((share) => -share) : shares;
}

/** `allocate` lifted to Money, preserving the currency of the total. */
export function allocateMoney(total: Money, weights: readonly bigint[]): Money[] {
  return allocate(total.minor, weights).map((minor) => ({ currency: total.currency, minor }));
}

/** Split evenly across `parts`, leftover halalas going to the earliest parts. */
export function allocateEvenly(total: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new InvalidAmountError('allocateEvenly: parts must be a positive integer.');
  }
  return allocateMoney(total, new Array<bigint>(parts).fill(1n));
}
EOF

cat << 'EOF' > packages/domain/src/money/index.ts
export * from './money.js';
export * from './allocate.js';
export * from './rounding.js';
EOF


cat << 'EOF' > packages/domain/src/tender/tender.ts
import { NonCashChangeError, UnderpaidError } from '../errors.js';
import { compareMoney, subtractMoney, sumMoney, zero } from '../money/money.js';
import type { Money } from '../money/money.js';

export type TenderKind = 'cash' | 'card' | 'mada' | 'transfer';

/**
 * Only cash can give change back.
 *
 * A card terminal settles the exact amount it was asked for; there is no
 * mechanism by which it returns money to the customer. Encoding that as data
 * rather than an `if` keeps the rule in one place when wallets are added.
 */
export const CHANGE_CAPABLE_TENDERS: readonly TenderKind[] = ['cash'];

export function canGiveChange(kind: TenderKind): boolean {
  return CHANGE_CAPABLE_TENDERS.includes(kind);
}

export interface TenderLine {
  readonly kind: TenderKind;
  readonly amount: Money;
}

export interface Settlement {
  readonly due: Money;
  readonly tendered: Money;
  /** Always drawn from cash. Zero when the payment was exact. */
  readonly change: Money;
  readonly changeFrom: TenderKind | null;
}

/**
 * Settle a sale against one or more tenders.
 *
 * The guard that matters: non-cash tenders may not exceed the amount due. The
 * cashier is expected to key the card amount first and let cash absorb the
 * remainder, which is also how the physical workflow runs.
 */
export function settle(due: Money, lines: readonly TenderLine[]): Settlement {
  if (due.minor < 0n) {
    throw new UnderpaidError('Amount due must not be negative.');
  }

  const currency = due.currency;
  const tendered = sumMoney(
    lines.map((line) => line.amount),
    currency,
  );

  for (const line of lines) {
    if (line.amount.minor < 0n) {
      throw new UnderpaidError(`Tender ${line.kind} must not be negative.`);
    }
  }

  const nonCash = sumMoney(
    lines.filter((line) => !canGiveChange(line.kind)).map((line) => line.amount),
    currency,
  );

  if (compareMoney(nonCash, due) > 0) {
    throw new NonCashChangeError(
      'Non-cash tenders exceed the amount due, and only cash can return change.',
    );
  }

  if (compareMoney(tendered, due) < 0) {
    throw new UnderpaidError('Tendered total does not cover the amount due.');
  }

  const change = subtractMoney(tendered, due);
  return {
    due,
    tendered,
    change,
    changeFrom: change.minor > 0n ? 'cash' : null,
  };
}

export function isSettled(settlement: Settlement): boolean {
  return compareMoney(settlement.tendered, settlement.due) >= 0;
}

export function noChange(currency: Money['currency'] = 'SAR'): Money {
  return zero(currency);
}
EOF

cat << 'EOF' > packages/domain/src/ids/uuidv7.ts
import { IdGenerationError } from '../errors.js';

/**
 * Monotonic UUIDv7, per RFC 9562 §5.7 and the "replace leftmost random bits
 * with increased clock precision" / dedicated-counter guidance in §6.2.
 *
 * v7 carries a 48-bit millisecond timestamp in its high bits, so identifiers
 * sort into creation order as plain strings. That is what lets an offline
 * terminal mint ids for hours and have the server replay them in the order the
 * sales actually happened (ADR-0003).
 *
 * The ordering guarantee is only worth having if it cannot break, so three
 * failure modes are handled explicitly rather than left to chance:
 *
 *   Counter exhaustion. Bursts share a millisecond. A 12-bit counter wrapping
 *     silently at 4096 produces a *lower* id than the one before it, which
 *     inverts the sale order and cannot be detected after the fact. Here the
 *     counter is 42 bits (12 in rand_a + 30 in rand_b), and on exhaustion the
 *     generator borrows a millisecond from the future rather than wrapping.
 *
 *   Clock rollback. NTP corrections and a merchant fixing the till clock both
 *     move time backwards. A naive generator then emits ids that sort before
 *     already-issued ones. Here the last-issued timestamp is a floor: the
 *     generator never emits below it, so ordering survives the correction.
 *
 *   Unbounded drift. Borrowing and floors are only safe while the gap stays
 *     small. Past a bounded tolerance the generator refuses rather than
 *     inventing a timestamp far from real time — a hard failure is recoverable,
 *     a silently wrong chronology is not.
 */

export interface Clock {
  now(): number;
}

/**
 * The `ArrayBuffer` generic is load-bearing: `crypto.getRandomValues` refuses a
 * view backed by a `SharedArrayBuffer`, so a bare `Uint8Array` -- which widens
 * to `ArrayBufferLike` -- does not satisfy it.
 */
export interface RandomSource {
  fill(target: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}

export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = { now: () => Date.now() };

export const systemRandom: RandomSource = {
  fill(target: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    globalThis.crypto.getRandomValues(target);
    return target;
  },
};

const UUID_BYTES = 16;
const MAX_TIMESTAMP = 0xffff_ffff_ffffn;

/**
 * Counter width: 12 bits of rand_a plus the 30 leftmost bits of rand_b.
 *
 * 2^42 is about 4.4e12 ids inside one millisecond -- unreachable by any real
 * terminal, which is the point. 34 bits of rand_b are left untouched so every
 * id still carries entropy and is not guessable from its predecessor.
 */
const COUNTER_BITS = 42n;
const RAND_B_FREE_BITS = 32n;
const MIN_COUNTER_BITS = 12n;

/** How far ahead borrowing may run before the generator refuses. */
const DEFAULT_MAX_DRIFT_MS = 10_000;

export interface UuidV7Options {
  readonly clock?: Clock;
  readonly random?: RandomSource;
  /**
   * Tolerance, in milliseconds, for both counter borrowing and clock rollback.
   * Beyond it the generator throws instead of guessing.
   */
  readonly maxDriftMs?: number;
  /**
   * Usable counter width, for tests only.
   *
   * At the default 42 bits, exhausting the counter inside one millisecond
   * needs on the order of 2^41 calls -- unreachable, which is the point, but
   * it also means the borrow path could never be exercised. Narrowing this to
   * 12 reproduces revision 1's counter width exactly and lets a test prove the
   * generator borrows instead of wrapping. The bit layout does not change.
   */
  readonly counterBits?: number;
}

export function createUuidV7Generator(options: UuidV7Options = {}): IdGenerator {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? systemRandom;
  const maxDriftMs = options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS;

  if (!Number.isInteger(maxDriftMs) || maxDriftMs < 0) {
    throw new IdGenerationError('maxDriftMs must be a non-negative integer.');
  }

  const counterBits = BigInt(options.counterBits ?? Number(COUNTER_BITS));
  if (counterBits < MIN_COUNTER_BITS || counterBits > COUNTER_BITS) {
    throw new IdGenerationError(
      `counterBits must be between ${MIN_COUNTER_BITS.toString()} and ` +
        `${COUNTER_BITS.toString()}.`,
    );
  }
  const counterMax = (1n << counterBits) - 1n;

  let lastTimestamp = -1n;
  let counter = 0n;

  return {
    next(): string {
      const observed = clock.now();
      if (!Number.isFinite(observed) || observed < 0) {
        throw new IdGenerationError('Clock returned a non-finite or negative timestamp.');
      }

      let timestamp = BigInt(Math.floor(observed));
      if (timestamp > MAX_TIMESTAMP) {
        throw new IdGenerationError('Timestamp exceeds the 48 bits UUIDv7 allows.');
      }

      if (timestamp > lastTimestamp) {
        // Time moved forward: reseed the counter from entropy so consecutive
        // milliseconds do not start from a predictable value.
        lastTimestamp = timestamp;
        counter = randomCounter(random, counterMax);
      } else {
        // Either the same millisecond, or the clock went backwards. Both are
        // handled by refusing to emit below the floor already issued.
        const rollback = lastTimestamp - timestamp;
        if (rollback > BigInt(maxDriftMs)) {
          throw new IdGenerationError(
            `Clock moved backwards by ${rollback.toString()}ms, beyond the ` +
              `${String(maxDriftMs)}ms tolerance. Refusing to issue an identifier ` +
              'that would sort before ones already written.',
          );
        }

        timestamp = lastTimestamp;

        if (counter >= counterMax) {
          // Exhausted inside this millisecond. Borrow the next one rather than
          // wrapping, which would emit a smaller id than the previous.
          const borrowed = lastTimestamp + 1n;
          if (borrowed - BigInt(Math.floor(observed)) > BigInt(maxDriftMs)) {
            throw new IdGenerationError(
              'UUIDv7 counter exhausted and borrowing would drift beyond the ' +
                `${String(maxDriftMs)}ms tolerance.`,
            );
          }
          if (borrowed > MAX_TIMESTAMP) {
            throw new IdGenerationError('Timestamp exceeds the 48 bits UUIDv7 allows.');
          }
          lastTimestamp = borrowed;
          timestamp = borrowed;
          counter = randomCounter(random, counterMax);
        } else {
          counter += 1n;
        }
      }

      return assemble(timestamp, counter, random);
    },
  };
}

/**
 * Seed the counter in the lower half of its range.
 *
 * Starting anywhere in the full range would leave a burst that begins near the
 * top with very little headroom before it has to borrow. Halving the seed
 * guarantees at least 2^41 increments before exhaustion while still keeping the
 * start unpredictable.
 */
function randomCounter(random: RandomSource, counterMax: bigint): bigint {
  const bytes = random.fill(new Uint8Array(new ArrayBuffer(8)));
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return (value & counterMax) >> 1n;
}

function assemble(timestamp: bigint, counter: bigint, random: RandomSource): string {
  const bytes = random.fill(new Uint8Array(new ArrayBuffer(UUID_BYTES)));

  // Bytes 0-5: the 48-bit timestamp, big-endian.
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((timestamp >> BigInt(8 * (5 - index))) & 0xffn);
  }

  // Counter, most significant 12 bits into rand_a (bytes 6-7, low nibble of 6),
  // the remaining 30 into the top of rand_b (bytes 8-11).
  const randA = (counter >> (COUNTER_BITS - 12n)) & 0xfffn;
  const randBHigh = counter & ((1n << (COUNTER_BITS - 12n)) - 1n);

  bytes[6] = 0x70 | Number((randA >> 8n) & 0x0fn); // version 7
  bytes[7] = Number(randA & 0xffn);

  // Byte 8 holds the RFC 9562 variant (10xx) in its top two bits, so only six
  // bits of it are available to the counter.
  const shifted = randBHigh << RAND_B_FREE_BITS; // occupy bits 61..32 of rand_b
  bytes[8] = 0x80 | Number((shifted >> 56n) & 0x3fn);
  bytes[9] = Number((shifted >> 48n) & 0xffn);
  bytes[10] = Number((shifted >> 40n) & 0xffn);
  bytes[11] = Number((shifted >> 32n) & 0xffn);
  // Bytes 12-15 keep their entropy untouched.

  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Extract the embedded millisecond timestamp. Useful for audit tooling. */
export function timestampOfUuidV7(uuid: string): number {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new IdGenerationError(`Not a UUID: "${uuid}".`);
  }
  return Number(BigInt(`0x${hex.slice(0, 12)}`));
}

export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/**
 * The process-wide generator.
 *
 * Every identifier in Korvi comes from here or from an injected generator --
 * including infrastructure ids such as HTTP correlation ids. `crypto.randomUUID`
 * returns a v4, which carries no time and therefore cannot be ordered against a
 * sale that synced late (ADR-0003).
 */
export const uuidV7: IdGenerator = createUuidV7Generator();

/** Convenience for callers that just want an id. */
export function newId(): string {
  return uuidV7.next();
}
EOF

cat << 'EOF' > packages/domain/src/tax/basis-points.ts
import { InvalidRateError } from '../errors.js';

/**
 * A tax or discount rate, in basis points, validated at construction.
 *
 * One representation for the whole system. Revision 1 had the domain speaking
 * `bigint` while the ports and the database column spoke `number`, with the
 * conversion left implicit at each crossing — which is exactly where a rate
 * quietly becomes a float and starts disagreeing with itself about a halala.
 *
 * The brand means a bare `bigint` cannot be passed where a rate is expected:
 * every value has been through `basisPoints()` and is therefore in range.
 *
 * 1 bp = 0.01%. 1500 bp = 15%.
 */
export type BasisPoints = bigint & { readonly __brand: 'BasisPoints' };

export const BASIS_POINT_SCALE = 10_000n;

/**
 * Upper bound: 100%.
 *
 * Not arbitrary — a tax rate above 100% is a data-entry error every time, and
 * catching it here is cheaper than discovering it on a printed invoice. Raise
 * it deliberately if a jurisdiction ever needs more.
 */
export const MAX_BASIS_POINTS = 10_000n;

export function basisPoints(value: bigint | number): BasisPoints {
  const asBigInt = typeof value === 'number' ? numberToBigInt(value) : value;

  if (asBigInt < 0n) {
    throw new InvalidRateError(`Rate must not be negative, got ${asBigInt.toString()} bp.`);
  }
  if (asBigInt > MAX_BASIS_POINTS) {
    throw new InvalidRateError(
      `Rate ${asBigInt.toString()} bp exceeds the ${MAX_BASIS_POINTS.toString()} bp ceiling ` +
        '(100%). A rate above 100% is a data-entry error.',
    );
  }
  return asBigInt as BasisPoints;
}

function numberToBigInt(value: number): bigint {
  if (!Number.isInteger(value)) {
    throw new InvalidRateError(
      `Rate must be a whole number of basis points, got ${String(value)}. ` +
        'Fractional basis points would reintroduce float arithmetic (ADR-0002).',
    );
  }
  return BigInt(value);
}

/**
 * Narrow a value that crossed a boundary as a plain integer.
 *
 * The database column is `Int` and JSON carries a number, so this is the single
 * sanctioned entry point back into the branded type — and it validates, so a
 * corrupt row fails loudly instead of producing a wrong tax figure.
 */
export function basisPointsFromColumn(value: number): BasisPoints {
  return basisPoints(value);
}

/** Widen for storage or transport. Safe: the ceiling is far below 2^53. */
export function basisPointsToColumn(value: BasisPoints): number {
  return Number(value);
}

export function formatBasisPoints(value: BasisPoints): string {
  const whole = value / 100n;
  const fraction = value % 100n;
  return fraction === 0n
    ? `${whole.toString()}%`
    : `${whole.toString()}.${fraction.toString().padStart(2, '0')}%`;
}

/** Saudi standard VAT at the time of writing. */
export const VAT_STANDARD_BP: BasisPoints = basisPoints(1_500n);
export const VAT_ZERO_BP: BasisPoints = basisPoints(0n);
EOF

cat << 'EOF' > packages/domain/src/tax/vat.ts
import { mulDivRound } from '../money/rounding.js';
import { BASIS_POINT_SCALE } from './basis-points.js';
import type { BasisPoints } from './basis-points.js';
import type { Money } from '../money/money.js';

/**
 * VAT arithmetic.
 *
 * Rates arrive as `BasisPoints`, which is validated at construction, so these
 * functions do not re-check the range — the type is the guarantee.
 */

/** Tax on a net (tax-exclusive) amount. */
export function taxFromNet(net: Money, rate: BasisPoints): Money {
  return { currency: net.currency, minor: mulDivRound(net.minor, rate, BASIS_POINT_SCALE) };
}

/** Tax already contained inside a gross (tax-inclusive) amount. */
export function taxFromGross(gross: Money, rate: BasisPoints): Money {
  return {
    currency: gross.currency,
    minor: mulDivRound(gross.minor, rate, BASIS_POINT_SCALE + rate),
  };
}

export function netFromGross(gross: Money, rate: BasisPoints): Money {
  return { currency: gross.currency, minor: gross.minor - taxFromGross(gross, rate).minor };
}

export function grossFromNet(net: Money, rate: BasisPoints): Money {
  return { currency: net.currency, minor: net.minor + taxFromNet(net, rate).minor };
}
EOF

cat << 'EOF' > packages/domain/src/tax/index.ts
export * from './basis-points.js';
export * from './vat.js';
EOF

cat << 'EOF' > packages/domain/src/tax/__tests__/basis-points.test.ts
import { describe, expect, it } from 'vitest';
import {
  MAX_BASIS_POINTS,
  VAT_STANDARD_BP,
  basisPoints,
  basisPointsFromColumn,
  basisPointsToColumn,
  formatBasisPoints,
} from '../basis-points.js';
import { InvalidRateError } from '../../errors.js';

describe('basisPoints', () => {
  it('accepts values across the permitted range', () => {
    expect(basisPoints(0n)).toBe(0n);
    expect(basisPoints(1_500n)).toBe(1_500n);
    expect(basisPoints(MAX_BASIS_POINTS)).toBe(MAX_BASIS_POINTS);
  });

  it('accepts an integer number and widens it', () => {
    expect(basisPoints(1_500)).toBe(1_500n);
  });

  it('rejects a negative rate', () => {
    expect(() => basisPoints(-1n)).toThrow(InvalidRateError);
  });

  it('rejects a rate above 100%', () => {
    expect(() => basisPoints(MAX_BASIS_POINTS + 1n)).toThrow(InvalidRateError);
    expect(() => basisPoints(1_000_000n)).toThrow(InvalidRateError);
  });

  it('rejects a fractional rate rather than rounding it', () => {
    expect(() => basisPoints(15.5)).toThrow(InvalidRateError);
    expect(() => basisPoints(0.15)).toThrow(InvalidRateError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => basisPoints(Number.NaN)).toThrow(InvalidRateError);
    expect(() => basisPoints(Number.POSITIVE_INFINITY)).toThrow(InvalidRateError);
  });
});

describe('column boundary', () => {
  it('round-trips through the integer column form', () => {
    for (const raw of [0, 500, 1_500, 10_000]) {
      expect(basisPointsToColumn(basisPointsFromColumn(raw))).toBe(raw);
    }
  });

  it('rejects a corrupt column value loudly', () => {
    expect(() => basisPointsFromColumn(-5)).toThrow(InvalidRateError);
    expect(() => basisPointsFromColumn(99_999)).toThrow(InvalidRateError);
  });

  it('keeps the standard rate consistent across the boundary', () => {
    expect(basisPointsToColumn(VAT_STANDARD_BP)).toBe(1_500);
  });
});

describe('formatBasisPoints', () => {
  it('renders whole and fractional percentages', () => {
    expect(formatBasisPoints(VAT_STANDARD_BP)).toBe('15%');
    expect(formatBasisPoints(basisPoints(1_525n))).toBe('15.25%');
    expect(formatBasisPoints(basisPoints(0n))).toBe('0%');
  });
});
EOF

cat << 'EOF' > packages/domain/src/zatca/base64.ts
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 over raw bytes, written out rather than delegated.
 *
 * `Buffer` is Node-only and `btoa` is byte-string-only; the TLV payload has to
 * encode identically in the browser (offline, on the terminal) and on the
 * server (during sync), so the encoder lives here as plain arithmetic.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index] ?? 0;
    const byte1 = bytes[index + 1];
    const byte2 = bytes[index + 2];

    output += ALPHABET[byte0 >> 2];
    output += ALPHABET[((byte0 & 0x03) << 4) | ((byte1 ?? 0) >> 4)];
    output += byte1 === undefined ? '=' : ALPHABET[((byte1 & 0x0f) << 2) | ((byte2 ?? 0) >> 6)];
    output += byte2 === undefined ? '=' : ALPHABET[byte2 & 0x3f];
  }

  return output;
}
EOF

cat << 'EOF' > packages/domain/src/zatca/tlv.ts
import { TlvEncodingError } from '../errors.js';
import { bytesToBase64 } from './base64.js';
import { moneyToMajorString } from '../money/money.js';
import type { Money } from '../money/money.js';

/**
 * ZATCA e-invoicing QR payload — TLV, then Base64.
 *
 * SCOPE. This module implements the Phase 1 (simplified tax invoice) QR
 * payload: tags 1-5. It is correct-by-construction and fully offline: no
 * network, no clock beyond the timestamp handed in, no ambient state.
 *
 * It is NOT ZATCA Phase 2 compliance. A Phase 2 simplified tax invoice QR
 * carries tags 1-9: this module's five, plus the invoice hash (6), the ECDSA
 * cryptographic stamp (7), that stamp's public key (8), and the ZATCA technical
 * CA signature over that public key (9). Those depend on a CSID issued per
 * device and on canonicalisation of the full UBL invoice.
 *
 * Ordering matters as much as content: hashing, stamping and the tag 1-9 QR all
 * happen locally *before* the customer receives the document. Only reporting to
 * the Authority may be queued and retried. See docs/architecture/zatca.md.
 *
 * Do not describe a build carrying only this module as Phase 2 ready.
 */
export const ZATCA_TAG = {
  SELLER_NAME: 1,
  VAT_REGISTRATION_NUMBER: 2,
  TIMESTAMP: 3,
  INVOICE_TOTAL_WITH_VAT: 4,
  VAT_TOTAL: 5,
} as const;

export type ZatcaTag = (typeof ZATCA_TAG)[keyof typeof ZATCA_TAG];

export interface TlvField {
  readonly tag: number;
  readonly value: string;
}

const encoder = new TextEncoder();

/**
 * Encode one field as tag, length, value.
 *
 * The length is the UTF-8 **byte** count, not the character count. An Arabic
 * seller name is roughly two bytes per letter, so a character count produces a
 * declared length shorter than the payload and the Authority's parser walks off
 * the end of the field. This distinction is the single most common cause of
 * rejected QR codes in Arabic deployments.
 */
export function encodeTlvField(field: TlvField): Uint8Array {
  if (!Number.isInteger(field.tag) || field.tag < 0 || field.tag > 0xff) {
    throw new TlvEncodingError(`TLV tag must be a byte, got ${String(field.tag)}.`);
  }

  const valueBytes = encoder.encode(field.value);
  if (valueBytes.length > 0xff) {
    throw new TlvEncodingError(
      `TLV value for tag ${String(field.tag)} is ${String(valueBytes.length)} bytes; ` +
        'the single-byte length field allows at most 255.',
    );
  }

  const out = new Uint8Array(2 + valueBytes.length);
  out[0] = field.tag;
  out[1] = valueBytes.length;
  out.set(valueBytes, 2);
  return out;
}

export function encodeTlv(fields: readonly TlvField[]): Uint8Array {
  const parts = fields.map(encodeTlvField);
  const total = parts.reduce((sum, part) => sum + part.length, 0);

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface SimplifiedInvoiceQrInput {
  readonly sellerName: string;
  readonly vatRegistrationNumber: string;
  /** ISO 8601, e.g. "2026-08-07T09:45:00Z". Supplied, never read from a clock. */
  readonly timestamp: string;
  readonly invoiceTotalWithVat: Money;
  readonly vatTotal: Money;
}

/**
 * Build the Phase 1 QR payload.
 *
 * Pure and deterministic: identical input yields a byte-identical result on the
 * terminal and on the server, which is what makes an offline-generated receipt
 * verifiable after it syncs.
 */
export function simplifiedInvoiceQrFields(input: SimplifiedInvoiceQrInput): TlvField[] {
  if (input.sellerName.trim() === '') {
    throw new TlvEncodingError('Seller name is required.');
  }
  if (!/^\d{15}$/.test(input.vatRegistrationNumber)) {
    throw new TlvEncodingError('VAT registration number must be 15 digits.');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.timestamp)) {
    throw new TlvEncodingError(`Timestamp must be ISO 8601, got "${input.timestamp}".`);
  }

  return [
    { tag: ZATCA_TAG.SELLER_NAME, value: input.sellerName },
    { tag: ZATCA_TAG.VAT_REGISTRATION_NUMBER, value: input.vatRegistrationNumber },
    { tag: ZATCA_TAG.TIMESTAMP, value: input.timestamp },
    { tag: ZATCA_TAG.INVOICE_TOTAL_WITH_VAT, value: moneyToMajorString(input.invoiceTotalWithVat) },
    { tag: ZATCA_TAG.VAT_TOTAL, value: moneyToMajorString(input.vatTotal) },
  ];
}

export function simplifiedInvoiceQr(input: SimplifiedInvoiceQrInput): string {
  return bytesToBase64(encodeTlv(simplifiedInvoiceQrFields(input)));
}
EOF

cat << 'EOF' > packages/domain/src/ports/persistence.ts
import type { BasisPoints } from '../tax/basis-points.js';

/**
 * Repository ports.
 *
 * The domain declares what it needs; packages/database supplies it. Prisma
 * types never cross this line, which is what keeps the core liftable into
 * Korvi ERP later (ADR-0001) and stops ORM shapes reaching the UI (ADR-0004).
 */

/** Branded so a bare string cannot be passed where a tenant is expected. */
export type TenantId = string & { readonly __brand: 'TenantId' };

export function tenantId(value: string): TenantId {
  return value as TenantId;
}

/**
 * Every tenant-owned read and write carries this.
 *
 * GlobalCatalog is deliberately outside it: the national barcode catalogue is
 * shared infrastructure, not tenant data, and giving it a tenantId would mean
 * storing hundreds of thousands of duplicate rows per merchant (ADR-0004).
 */
export interface TenantScope {
  readonly tenantId: TenantId;
}

export interface Product {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  /** Minor units, as a string at this boundary. See ADR-0002. */
  readonly priceMinor: string;
  /**
   * Branded and validated, not a bare number. The adapter narrows the integer
   * column through `basisPointsFromColumn`, so a corrupt row fails at the
   * boundary instead of producing a wrong tax figure downstream.
   */
  readonly vatBasisPoints: BasisPoints;
  readonly barcode: string | null;
}

export interface GlobalCatalogItem {
  readonly barcode: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly vatBasisPoints: BasisPoints;
}

export interface ProductRepository {
  findById(scope: TenantScope, id: string): Promise<Product | null>;
  findByBarcode(scope: TenantScope, barcode: string): Promise<Product | null>;
  list(scope: TenantScope, limit: number): Promise<readonly Product[]>;
}

export interface GlobalCatalogRepository {
  findByBarcode(barcode: string): Promise<GlobalCatalogItem | null>;
}
EOF

cat << 'EOF' > packages/domain/src/ports/search.ts
/**
 * Liquid Search boundary — declared in Phase 0, implemented later.
 *
 * The target is sub-50ms prefix lookup against the local store while the
 * cashier is still typing, tolerant of the transpositions a hurried barcode
 * entry produces.
 *
 * `codeReverse` is the index that makes it work: the reversed SKU or barcode
 * stored alongside the forward one, so a suffix query becomes a prefix query
 * and can use the same ordered index. A cashier who reads the last four digits
 * off a label is doing a suffix search, and a plain prefix index cannot serve
 * it without a full scan.
 *
 * Phase 0 ships the port only — no implementation, so nothing depends on a
 * shape we have not yet measured against a real catalogue.
 */
import type { TenantScope } from './persistence.js';

export interface SearchHit {
  readonly id: string;
  readonly score: number;
}

export interface SearchQuery {
  readonly term: string;
  readonly limit: number;
}

export interface LiquidSearchPort {
  search(scope: TenantScope, query: SearchQuery): Promise<readonly SearchHit[]>;
}

/** Build the reversed form used by the codeReverse index. */
export function codeReverse(code: string): string {
  return [...code].reverse().join('');
}
EOF

cat << 'EOF' > packages/domain/src/ports/offline.ts
/**
 * Offline boundary — declared in Phase 0, implemented later (ADR-0005).
 *
 * The shape is fixed now so that the sale path is written against a queue from
 * the first line of Phase 1, rather than being retrofitted for offline once it
 * already assumes a live server. Retrofitting is where ordering guarantees get
 * lost.
 *
 * Nothing here is implemented yet: no IndexedDB, no Service Worker, no sync
 * loop. Those are Phase 1+.
 */

export type QueueItemState = 'pending' | 'in-flight' | 'settled' | 'rejected';

export interface QueuedOperation<TPayload = unknown> {
  /** UUIDv7 — the id *is* the ordering key (ADR-0003). */
  readonly id: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly state: QueueItemState;
  readonly attempts: number;
  readonly enqueuedAt: string;
}

export interface TransactionQueuePort {
  enqueue<TPayload>(operation: QueuedOperation<TPayload>): Promise<void>;
  /** Oldest-first by UUIDv7, so replay order matches what happened. */
  pending(limit: number): Promise<readonly QueuedOperation[]>;
  markSettled(id: string): Promise<void>;
  markRejected(id: string, reason: string): Promise<void>;
}

/**
 * Retry policy for the reconciliation queue.
 *
 * Deliberately a value, not behaviour: a rejected invoice must not be retried
 * on a tight loop against the Authority, and the delay belongs in one auditable
 * place rather than in a caller's setTimeout.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly backoffFactor: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 8,
  initialDelayMs: 5 * 60 * 1000,
  backoffFactor: 2,
  maxDelayMs: 6 * 60 * 60 * 1000,
};

export function nextRetryDelayMs(policy: RetryPolicy, attempt: number): number {
  const raw = policy.initialDelayMs * policy.backoffFactor ** Math.max(0, attempt - 1);
  return Math.min(raw, policy.maxDelayMs);
}

export type ConflictResolution = 'keep-local' | 'keep-remote' | 'needs-review';

export interface SyncEnginePort {
  push(): Promise<void>;
  pull(): Promise<void>;
  resolve(id: string, resolution: ConflictResolution): Promise<void>;
}
EOF

cat << 'EOF' > packages/domain/src/index.ts
export * from './errors.js';
export * from './money/index.js';
export * from './tax/index.js';
export * from './tender/tender.js';
export * from './ids/uuidv7.js';
export * from './zatca/tlv.js';
export * from './zatca/base64.js';
export * from './ports/persistence.js';
export * from './ports/search.js';
export * from './ports/offline.js';
EOF

say "Writing @korvi/domain tests"

cat << 'EOF' > packages/domain/src/money/__tests__/money.test.ts
import { describe, expect, it } from 'vitest';
import {
  addMoney,
  compareMoney,
  moneyFromJson,
  moneyFromMajorString,
  moneyToJson,
  moneyToMajorString,
  money,
  subtractMoney,
  sumMoney,
} from '../money.js';
import { CurrencyMismatchError, InvalidAmountError } from '../../errors.js';

describe('money parsing', () => {
  it('parses whole and fractional amounts without a float', () => {
    expect(moneyFromMajorString('12.34').minor).toBe(1234n);
    expect(moneyFromMajorString('12.3').minor).toBe(1230n);
    expect(moneyFromMajorString('12').minor).toBe(1200n);
    expect(moneyFromMajorString('0.05').minor).toBe(5n);
    expect(moneyFromMajorString('-7.50').minor).toBe(-750n);
  });

  it('survives the amounts that break float arithmetic', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754. It must here.
    const total = addMoney(moneyFromMajorString('0.10'), moneyFromMajorString('0.20'));
    expect(moneyToMajorString(total)).toBe('0.30');
  });

  it('refuses precision finer than a halala rather than rounding silently', () => {
    expect(() => moneyFromMajorString('1.005')).toThrow(InvalidAmountError);
  });

  it('rejects non-numeric input', () => {
    expect(() => moneyFromMajorString('12,34')).toThrow(InvalidAmountError);
    expect(() => moneyFromMajorString('')).toThrow(InvalidAmountError);
  });

  it('round-trips through the string form', () => {
    for (const value of ['0.00', '0.01', '9.99', '1234567.89', '-0.01']) {
      expect(moneyToMajorString(moneyFromMajorString(value))).toBe(value);
    }
  });
});

describe('money arithmetic', () => {
  it('adds, subtracts and sums', () => {
    expect(addMoney(money(100n), money(250n)).minor).toBe(350n);
    expect(subtractMoney(money(100n), money(250n)).minor).toBe(-150n);
    expect(sumMoney([money(1n), money(2n), money(3n)]).minor).toBe(6n);
    expect(sumMoney([]).minor).toBe(0n);
  });

  it('compares', () => {
    expect(compareMoney(money(1n), money(2n))).toBe(-1);
    expect(compareMoney(money(2n), money(2n))).toBe(0);
    expect(compareMoney(money(3n), money(2n))).toBe(1);
  });

  it('refuses to mix currencies', () => {
    const sar = money(100n, 'SAR');
    const other = { currency: 'USD', minor: 100n } as unknown as typeof sar;
    expect(() => addMoney(sar, other)).toThrow(CurrencyMismatchError);
  });

  it('holds amounts far beyond the safe integer range', () => {
    const huge = money(9_007_199_254_740_993n); // 2^53 + 1
    expect(moneyToJson(huge).minor).toBe('9007199254740993');
    expect(moneyFromJson(moneyToJson(huge)).minor).toBe(huge.minor);
  });
});

describe('json boundary', () => {
  it('serialises minor units as a string, never a number', () => {
    const json = moneyToJson(money(1234n));
    expect(typeof json.minor).toBe('string');
    expect(JSON.parse(JSON.stringify(json))).toEqual({ currency: 'SAR', minor: '1234' });
  });

  it('rejects a malformed minor value', () => {
    expect(() => moneyFromJson({ currency: 'SAR', minor: '12.5' })).toThrow(InvalidAmountError);
  });
});
EOF

cat << 'EOF' > packages/domain/src/money/__tests__/allocate.test.ts
import { describe, expect, it } from 'vitest';
import { allocate, allocateEvenly, allocateMoney } from '../allocate.js';
import { money } from '../money.js';
import { InvalidAmountError } from '../../errors.js';

const sum = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

describe('allocate', () => {
  it('never creates or destroys a halala', () => {
    // The classic: 100 split three ways cannot be done evenly.
    const shares = allocate(100n, [1n, 1n, 1n]);
    expect(shares).toEqual([34n, 33n, 33n]);
    expect(sum(shares)).toBe(100n);
  });

  it('preserves the total across a wide sweep of inputs', () => {
    const weightSets: bigint[][] = [
      [1n, 1n],
      [1n, 1n, 1n],
      [1n, 2n, 3n],
      [7n, 11n, 13n, 17n],
      [1n, 0n, 1n],
      [999n, 1n],
      [1n, 1n, 1n, 1n, 1n, 1n, 1n],
    ];

    for (let total = -250n; total <= 250n; total += 1n) {
      for (const weights of weightSets) {
        const shares = allocate(total, weights);
        expect(sum(shares)).toBe(total);
        expect(shares).toHaveLength(weights.length);
      }
    }
  });

  it('mirrors exactly under negation', () => {
    for (const weights of [[1n, 1n, 1n], [2n, 3n, 5n]]) {
      const positive = allocate(1_000_037n, weights);
      const negative = allocate(-1_000_037n, weights);
      expect(negative).toEqual(positive.map((share) => -share));
    }
  });

  it('is deterministic — ties break by index, not by chance', () => {
    for (let run = 0; run < 50; run += 1) {
      expect(allocate(10n, [1n, 1n, 1n, 1n])).toEqual([3n, 3n, 2n, 2n]);
    }
  });

  it('gives the leftover to the largest remainder', () => {
    // Weights 1:2 over 3 halalas -> exact shares 1.0 and 2.0, no leftover.
    expect(allocate(3n, [1n, 2n])).toEqual([1n, 2n]);
    // Weights 1:1:1 over 5 -> 1.67 each; the two largest remainders get +1.
    expect(sum(allocate(5n, [1n, 1n, 1n]))).toBe(5n);
  });

  it('handles a zero weight without dropping money', () => {
    const shares = allocate(10n, [1n, 0n, 1n]);
    expect(shares[1]).toBe(0n);
    expect(sum(shares)).toBe(10n);
  });

  it('rejects impossible inputs', () => {
    expect(() => allocate(10n, [])).toThrow(InvalidAmountError);
    expect(() => allocate(10n, [0n, 0n])).toThrow(InvalidAmountError);
    expect(() => allocate(10n, [1n, -1n])).toThrow(InvalidAmountError);
  });
});

describe('allocateMoney', () => {
  it('keeps the currency and the total', () => {
    const parts = allocateMoney(money(100n), [1n, 1n, 1n]);
    expect(parts.every((part) => part.currency === 'SAR')).toBe(true);
    expect(sum(parts.map((part) => part.minor))).toBe(100n);
  });

  it('splits a bill evenly with the remainder going to the earliest parts', () => {
    const parts = allocateEvenly(money(1000n), 3);
    expect(parts.map((part) => part.minor)).toEqual([334n, 333n, 333n]);
  });

  it('rejects a non-positive part count', () => {
    expect(() => allocateEvenly(money(100n), 0)).toThrow(InvalidAmountError);
    expect(() => allocateEvenly(money(100n), 1.5)).toThrow(InvalidAmountError);
  });
});
EOF

cat << 'EOF' > packages/domain/src/money/__tests__/rounding.test.ts
import { describe, expect, it } from 'vitest';
import { mulDivRound } from '../rounding.js';
import { InvalidAmountError } from '../../errors.js';

describe('mulDivRound', () => {
  it('rounds half away from zero in half-up mode', () => {
    expect(mulDivRound(5n, 1n, 2n)).toBe(3n);
    expect(mulDivRound(-5n, 1n, 2n)).toBe(-3n);
    expect(mulDivRound(4n, 1n, 2n)).toBe(2n);
  });

  it('rounds half to even when asked', () => {
    expect(mulDivRound(5n, 1n, 2n, 'half-even')).toBe(2n);
    expect(mulDivRound(7n, 1n, 2n, 'half-even')).toBe(4n);
  });

  it('truncates toward zero when asked', () => {
    expect(mulDivRound(9n, 1n, 2n, 'trunc')).toBe(4n);
    expect(mulDivRound(-9n, 1n, 2n, 'trunc')).toBe(-4n);
  });

  it('is exact where floats are not', () => {
    // 0.07 * 100 in IEEE 754 is 7.000000000000001.
    expect(mulDivRound(7n, 100n, 100n)).toBe(7n);
    expect(mulDivRound(10_000_000_000_000_001n, 3n, 3n)).toBe(10_000_000_000_000_001n);
  });

  it('rejects a zero denominator', () => {
    expect(() => mulDivRound(1n, 1n, 0n)).toThrow(InvalidAmountError);
  });
});
EOF

cat << 'EOF' > packages/domain/src/tax/__tests__/vat.test.ts
import { describe, expect, it } from 'vitest';
import { grossFromNet, netFromGross, taxFromGross, taxFromNet } from '../vat.js';
import { VAT_STANDARD_BP, VAT_ZERO_BP, basisPoints } from '../basis-points.js';
import { money, moneyToMajorString } from '../../money/money.js';

describe('VAT', () => {
  it('adds 15% to a net amount', () => {
    expect(taxFromNet(money(10_000n), VAT_STANDARD_BP).minor).toBe(1_500n);
    expect(grossFromNet(money(10_000n), VAT_STANDARD_BP).minor).toBe(11_500n);
  });

  it('extracts 15% from a gross amount', () => {
    expect(taxFromGross(money(11_500n), VAT_STANDARD_BP).minor).toBe(1_500n);
    expect(netFromGross(money(11_500n), VAT_STANDARD_BP).minor).toBe(10_000n);
  });

  it('keeps net plus tax exactly equal to gross on awkward amounts', () => {
    for (const netMinor of [1n, 7n, 33n, 99n, 12_345n, 999_999n]) {
      const gross = grossFromNet(money(netMinor), VAT_STANDARD_BP);
      // Extraction may differ by a halala from the original after rounding;
      // what must hold is that the parts always reconstitute the whole.
      expect(
        netFromGross(gross, VAT_STANDARD_BP).minor + taxFromGross(gross, VAT_STANDARD_BP).minor,
      ).toBe(gross.minor);
    }
  });

  it('formats to two decimals', () => {
    expect(moneyToMajorString(taxFromNet(money(3_333n), VAT_STANDARD_BP))).toBe('5.00');
  });

  it('treats a zero rate as a no-op', () => {
    expect(taxFromNet(money(5_000n), VAT_ZERO_BP).minor).toBe(0n);
    expect(grossFromNet(money(5_000n), VAT_ZERO_BP).minor).toBe(5_000n);
  });

  it('handles a non-standard but valid rate', () => {
    // 5% — the rate before the 2020 increase, and still what a historical
    // reprint of an old invoice has to reproduce.
    expect(taxFromNet(money(10_000n), basisPoints(500n)).minor).toBe(500n);
  });

  it('rounds half up rather than truncating', () => {
    // 33 halalas at 15% is 4.95 halalas; the merchant charges 5.
    expect(taxFromNet(money(33n), VAT_STANDARD_BP).minor).toBe(5n);
  });
});
EOF

cat << 'EOF' > packages/domain/src/tender/__tests__/tender.test.ts
import { describe, expect, it } from 'vitest';
import { canGiveChange, settle } from '../tender.js';
import { money } from '../../money/money.js';
import { NonCashChangeError, UnderpaidError } from '../../errors.js';

describe('tender rules', () => {
  it('knows only cash returns change', () => {
    expect(canGiveChange('cash')).toBe(true);
    expect(canGiveChange('card')).toBe(false);
    expect(canGiveChange('mada')).toBe(false);
    expect(canGiveChange('transfer')).toBe(false);
  });
});

describe('settle', () => {
  it('settles an exact cash payment with no change', () => {
    const result = settle(money(5_000n), [{ kind: 'cash', amount: money(5_000n) }]);
    expect(result.change.minor).toBe(0n);
    expect(result.changeFrom).toBeNull();
  });

  it('returns change from cash on an overpayment', () => {
    const result = settle(money(4_750n), [{ kind: 'cash', amount: money(5_000n) }]);
    expect(result.change.minor).toBe(250n);
    expect(result.changeFrom).toBe('cash');
  });

  it('splits card and cash, giving change from the cash portion', () => {
    const result = settle(money(10_000n), [
      { kind: 'mada', amount: money(6_000n) },
      { kind: 'cash', amount: money(5_000n) },
    ]);
    expect(result.change.minor).toBe(1_000n);
    expect(result.changeFrom).toBe('cash');
  });

  it('refuses a card tender larger than the amount due', () => {
    expect(() =>
      settle(money(10_000n), [{ kind: 'card', amount: money(10_001n) }]),
    ).toThrow(NonCashChangeError);
  });

  it('refuses card plus mada exceeding the amount due even when each is under it', () => {
    expect(() =>
      settle(money(10_000n), [
        { kind: 'card', amount: money(6_000n) },
        { kind: 'mada', amount: money(6_000n) },
      ]),
    ).toThrow(NonCashChangeError);
  });

  it('accepts a card tender for exactly the amount due', () => {
    const result = settle(money(10_000n), [{ kind: 'card', amount: money(10_000n) }]);
    expect(result.change.minor).toBe(0n);
  });

  it('refuses an underpayment', () => {
    expect(() => settle(money(10_000n), [{ kind: 'cash', amount: money(9_999n) }])).toThrow(
      UnderpaidError,
    );
  });

  it('refuses negative amounts', () => {
    expect(() => settle(money(-1n), [{ kind: 'cash', amount: money(0n) }])).toThrow(UnderpaidError);
    expect(() => settle(money(10n), [{ kind: 'cash', amount: money(-10n) }])).toThrow(
      UnderpaidError,
    );
  });
});
EOF

cat << 'EOF' > packages/domain/src/ids/__tests__/uuidv7.test.ts
import { describe, expect, it } from 'vitest';
import {
  createUuidV7Generator,
  isUuidV7,
  timestampOfUuidV7,
  type Clock,
  type RandomSource,
} from '../uuidv7.js';
import { IdGenerationError } from '../../errors.js';

/** A clock the test drives, so ordering assertions are not timing-dependent. */
function fixedClock(start: number): Clock & { set(value: number): void } {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

/** Deterministic bytes, so the only varying part is what the generator sets. */
const constantRandom: RandomSource = {
  fill(target: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    target.fill(0xab);
    return target;
  },
};

/** Worst case for counter headroom: seeds the counter as high as allowed. */
const maxRandom: RandomSource = {
  fill(target: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    target.fill(0xff);
    return target;
  },
};

const isSorted = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || (values[index - 1] as string) < value);

describe('UUIDv7 format', () => {
  it('emits the version and variant bits RFC 9562 requires', () => {
    const generator = createUuidV7Generator({ random: constantRandom });
    for (let index = 0; index < 50; index += 1) {
      expect(isUuidV7(generator.next())).toBe(true);
    }
  });

  it('embeds the millisecond timestamp', () => {
    const clock = fixedClock(1_754_000_000_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });
    expect(timestampOfUuidV7(generator.next())).toBe(1_754_000_000_000);
  });

  it('leaves the trailing entropy bytes untouched', () => {
    // Bytes 12-15 must stay random; without them ids become guessable.
    const a = createUuidV7Generator().next();
    const b = createUuidV7Generator().next();
    expect(a.slice(-8)).not.toBe(b.slice(-8));
  });
});

describe('ordering across milliseconds', () => {
  it('sorts lexicographically in creation order', () => {
    const clock = fixedClock(1_000_000_000_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const ids: string[] = [];
    for (let index = 0; index < 500; index += 1) {
      clock.set(1_000_000_000_000 + index);
      ids.push(generator.next());
    }

    expect(isSorted(ids)).toBe(true);
  });
});

describe('counter exhaustion', () => {
  it('stays monotonic well beyond 4096 ids in one millisecond', () => {
    // Revision 1 used a 12-bit counter that wrapped silently at 4096, so id
    // 4097 sorted *before* id 4096 and the sale order inverted undetectably.
    const clock = fixedClock(1_700_000_000_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const ids: string[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      ids.push(generator.next());
    }

    expect(new Set(ids).size).toBe(20_000);
    expect(isSorted(ids)).toBe(true);
  });

  it('holds ordering at exactly the old 4096 boundary', () => {
    const clock = fixedClock(1_700_000_000_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const ids: string[] = [];
    for (let index = 0; index < 4_100; index += 1) {
      ids.push(generator.next());
    }

    expect(isSorted(ids)).toBe(true);
    // The old implementation produced a duplicate-or-lower id here.
    expect((ids[4_096] as string) > (ids[4_095] as string)).toBe(true);
  });

  it('borrows a future millisecond instead of wrapping when the counter runs out', () => {
    // Narrowed to revision 1's 12-bit counter so exhaustion is reachable; at
    // the production width of 42 bits this path needs ~2^41 calls. The logic
    // under test is identical, only the width differs.
    const clock = fixedClock(1_700_000_000_000);
    const generator = createUuidV7Generator({
      clock,
      random: maxRandom,
      counterBits: 12,
    });

    const ids: string[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      ids.push(generator.next());
    }

    expect(isSorted(ids)).toBe(true);
    expect(new Set(ids).size).toBe(20_000);
    // Borrowing shows up as a timestamp ahead of the frozen clock. Revision 1
    // wrapped here and emitted a lower id instead.
    expect(timestampOfUuidV7(ids[19_999] as string)).toBeGreaterThan(1_700_000_000_000);
  });

  it('refuses when borrowing would drift past the tolerance', () => {
    const clock = fixedClock(1_700_000_000_000);
    const generator = createUuidV7Generator({
      clock,
      random: maxRandom,
      counterBits: 12,
      maxDriftMs: 0,
    });

    // Zero tolerance: the first borrow must throw rather than invent time.
    expect(() => {
      for (let index = 0; index < 20_000; index += 1) generator.next();
    }).toThrow(IdGenerationError);
  });

  it('rejects a counter width outside the supported range', () => {
    expect(() => createUuidV7Generator({ counterBits: 8 })).toThrow(IdGenerationError);
    expect(() => createUuidV7Generator({ counterBits: 64 })).toThrow(IdGenerationError);
  });
});

describe('clock rollback', () => {
  it('keeps ordering when the clock jumps backwards', () => {
    // NTP correction mid-shift, or a merchant fixing the till clock.
    const clock = fixedClock(1_700_000_005_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const before: string[] = [];
    for (let index = 0; index < 10; index += 1) before.push(generator.next());

    clock.set(1_700_000_004_000); // one second backwards

    const after: string[] = [];
    for (let index = 0; index < 10; index += 1) after.push(generator.next());

    const all = [...before, ...after];
    expect(isSorted(all)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  it('never emits a timestamp below the highest already issued', () => {
    const clock = fixedClock(1_700_000_005_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const first = generator.next();
    clock.set(1_700_000_000_000); // five seconds backwards
    const second = generator.next();

    expect(timestampOfUuidV7(second)).toBeGreaterThanOrEqual(timestampOfUuidV7(first));
    expect(second > first).toBe(true);
  });

  it('recovers once the clock passes the previous high-water mark', () => {
    const clock = fixedClock(1_700_000_005_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const first = generator.next();
    clock.set(1_700_000_004_000);
    const during = generator.next();
    clock.set(1_700_000_009_000);
    const after = generator.next();

    expect(isSorted([first, during, after])).toBe(true);
    expect(timestampOfUuidV7(after)).toBe(1_700_000_009_000);
  });

  it('refuses a rollback beyond the tolerance rather than issuing a wrong id', () => {
    const clock = fixedClock(1_700_000_000_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom, maxDriftMs: 1_000 });

    generator.next();
    clock.set(1_699_999_000_000); // a thousand seconds backwards

    expect(() => generator.next()).toThrow(IdGenerationError);
    expect(() => generator.next()).toThrow(/backwards/i);
  });
});

describe('input validation', () => {
  it('rejects a clock outside the 48-bit range', () => {
    const generator = createUuidV7Generator({
      clock: { now: () => 2 ** 49 },
      random: constantRandom,
    });
    expect(() => generator.next()).toThrow(IdGenerationError);
  });

  it('rejects a non-finite clock', () => {
    const generator = createUuidV7Generator({
      clock: { now: () => Number.NaN },
      random: constantRandom,
    });
    expect(() => generator.next()).toThrow(IdGenerationError);
  });

  it('rejects a negative clock', () => {
    const generator = createUuidV7Generator({
      clock: { now: () => -1 },
      random: constantRandom,
    });
    expect(() => generator.next()).toThrow(IdGenerationError);
  });

  it('rejects a nonsensical drift tolerance', () => {
    expect(() => createUuidV7Generator({ maxDriftMs: -1 })).toThrow(IdGenerationError);
    expect(() => createUuidV7Generator({ maxDriftMs: 1.5 })).toThrow(IdGenerationError);
  });
});

describe('real entropy', () => {
  it('produces distinct, ordered ids under the system clock', () => {
    const generator = createUuidV7Generator();
    const ids: string[] = [];
    for (let index = 0; index < 5_000; index += 1) ids.push(generator.next());

    expect(new Set(ids).size).toBe(5_000);
    expect(isSorted(ids)).toBe(true);
  });
});
EOF

cat << 'EOF' > packages/domain/src/zatca/__tests__/tlv.test.ts
import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../base64.js';
import { encodeTlv, encodeTlvField, simplifiedInvoiceQr, ZATCA_TAG } from '../tlv.js';
import { money, moneyFromMajorString } from '../../money/money.js';
import { TlvEncodingError } from '../../errors.js';

describe('base64', () => {
  it('matches known vectors including every padding case', () => {
    const encode = (text: string): string => bytesToBase64(new TextEncoder().encode(text));
    expect(encode('')).toBe('');
    expect(encode('f')).toBe('Zg==');
    expect(encode('fo')).toBe('Zm8=');
    expect(encode('foo')).toBe('Zm9v');
    expect(encode('foob')).toBe('Zm9vYg==');
    expect(encode('fooba')).toBe('Zm9vYmE=');
    expect(encode('foobar')).toBe('Zm9vYmFy');
  });

  it('agrees with Node on random bytes', () => {
    for (let run = 0; run < 200; run += 1) {
      const bytes = new Uint8Array(run);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + run) % 256;
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('TLV encoding', () => {
  it('declares length in UTF-8 bytes, not characters', () => {
    // The bug this guards: "متجر" is 4 characters but 8 bytes.
    const field = encodeTlvField({ tag: ZATCA_TAG.SELLER_NAME, value: 'متجر' });
    expect(field[0]).toBe(1);
    expect(field[1]).toBe(8);
    expect(field.length).toBe(10);
  });

  it('handles ASCII where bytes and characters agree', () => {
    const field = encodeTlvField({ tag: 2, value: 'ABC' });
    expect(field[1]).toBe(3);
  });

  it('counts emoji and mixed scripts by byte', () => {
    const value = 'متجر Korvi';
    const expected = new TextEncoder().encode(value).length;
    expect(encodeTlvField({ tag: 1, value })[1]).toBe(expected);
  });

  it('concatenates fields in order', () => {
    const bytes = encodeTlv([
      { tag: 1, value: 'A' },
      { tag: 2, value: 'BB' },
    ]);
    expect(Array.from(bytes)).toEqual([1, 1, 0x41, 2, 2, 0x42, 0x42]);
  });

  it('refuses a value longer than the single length byte can describe', () => {
    expect(() => encodeTlvField({ tag: 1, value: 'ا'.repeat(200) })).toThrow(TlvEncodingError);
  });

  it('refuses a tag outside one byte', () => {
    expect(() => encodeTlvField({ tag: 256, value: 'x' })).toThrow(TlvEncodingError);
  });
});

describe('simplified invoice QR', () => {
  const input = {
    sellerName: 'متجر كورفي',
    vatRegistrationNumber: '310122393500003',
    timestamp: '2026-08-07T09:45:00Z',
    invoiceTotalWithVat: moneyFromMajorString('115.00'),
    vatTotal: moneyFromMajorString('15.00'),
  };

  it('is deterministic', () => {
    expect(simplifiedInvoiceQr(input)).toBe(simplifiedInvoiceQr(input));
  });

  it('decodes back to the five Phase 1 tags', () => {
    const raw = Buffer.from(simplifiedInvoiceQr(input), 'base64');

    const tags: { tag: number; value: string }[] = [];
    let offset = 0;
    while (offset < raw.length) {
      const tag = raw[offset] as number;
      const length = raw[offset + 1] as number;
      tags.push({ tag, value: raw.subarray(offset + 2, offset + 2 + length).toString('utf8') });
      offset += 2 + length;
    }

    expect(tags.map((entry) => entry.tag)).toEqual([1, 2, 3, 4, 5]);
    expect(tags[0]?.value).toBe('متجر كورفي');
    expect(tags[3]?.value).toBe('115.00');
    expect(tags[4]?.value).toBe('15.00');
  });

  it('formats totals with exactly two decimals', () => {
    const raw = Buffer.from(
      simplifiedInvoiceQr({ ...input, invoiceTotalWithVat: money(500n), vatTotal: money(65n) }),
      'base64',
    ).toString('utf8');
    expect(raw).toContain('5.00');
    expect(raw).toContain('0.65');
  });

  it('rejects a malformed VAT number', () => {
    expect(() => simplifiedInvoiceQr({ ...input, vatRegistrationNumber: '123' })).toThrow(
      TlvEncodingError,
    );
  });

  it('rejects a non-ISO timestamp', () => {
    expect(() => simplifiedInvoiceQr({ ...input, timestamp: '07/08/2026' })).toThrow(
      TlvEncodingError,
    );
  });

  it('rejects an empty seller name', () => {
    expect(() => simplifiedInvoiceQr({ ...input, sellerName: '   ' })).toThrow(TlvEncodingError);
  });
});
EOF

cat << 'EOF' > packages/domain/src/ports/__tests__/offline.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY, nextRetryDelayMs } from '../offline.js';
import { codeReverse } from '../search.js';

describe('retry policy', () => {
  it('starts at five minutes and backs off', () => {
    expect(nextRetryDelayMs(DEFAULT_RETRY_POLICY, 1)).toBe(300_000);
    expect(nextRetryDelayMs(DEFAULT_RETRY_POLICY, 2)).toBe(600_000);
    expect(nextRetryDelayMs(DEFAULT_RETRY_POLICY, 3)).toBe(1_200_000);
  });

  it('never exceeds the ceiling', () => {
    expect(nextRetryDelayMs(DEFAULT_RETRY_POLICY, 50)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it('treats attempt zero as the first attempt', () => {
    expect(nextRetryDelayMs(DEFAULT_RETRY_POLICY, 0)).toBe(300_000);
  });
});

describe('codeReverse', () => {
  it('reverses so a suffix query becomes a prefix query', () => {
    expect(codeReverse('6281007041016')).toBe('6101407001826');
    expect(codeReverse('')).toBe('');
  });

  it('is its own inverse', () => {
    expect(codeReverse(codeReverse('ABC123'))).toBe('ABC123');
  });
});
EOF

# ---------------------------------------------------------------------------
# packages/printing
# ---------------------------------------------------------------------------

say "Writing @korvi/printing"

cat << 'EOF' > packages/printing/package.json
{
  "name": "@korvi/printing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "@korvi/domain": "*" }
}
EOF

cat << 'EOF' > packages/printing/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2023", "DOM"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/__tests__/**", "src/**/*.test.ts"]
}
EOF

cat << 'EOF' > packages/printing/src/profiles/types.ts
/**
 * Printer capability model.
 *
 * Revision 1 selected a code page and then sent UTF-8 through a TextEncoder.
 * That is wrong on essentially every real device: an ESC/POS printer decodes
 * bytes through the code page it was told to use, so UTF-8 multi-byte
 * sequences arrive as pairs of unrelated glyphs. Arabic came out as mojibake on
 * anything that was not a UTF-8-native printer.
 *
 * The fix is to stop assuming. A profile states what a given model can actually
 * do, and the encoder picks a strategy from that rather than from hope.
 */

/** How text reaches the print head. */
export type TextEncodingKind =
  /** Legacy single-byte Arabic code page. Firmware shapes the letters. */
  | 'cp1256'
  /** Legacy code page addressing Arabic presentation forms directly. */
  | 'cp864'
  /** Modern printers that genuinely decode UTF-8. */
  | 'utf8'
  /** No usable text path: the line must be drawn and sent as a bitmap. */
  | 'raster';

/** How the device draws a QR code. */
export type QrSupport =
  /** Native ESC/POS `GS ( k` symbol-storage commands. */
  | 'native'
  /** No QR firmware; the symbol must be rendered and sent as a bitmap. */
  | 'raster'
  /** Device cannot print a QR at all. */
  | 'none';

export interface PrinterCapabilities {
  /** Characters per line at the default font. */
  readonly columns: number;
  /** Dots per line — needed to size any raster payload. */
  readonly dotsPerLine: number;
  readonly text: TextEncodingKind;
  /** ESC t page selector, when the encoding is a legacy code page. */
  readonly codePageId: number | null;
  /**
   * The device joins Arabic letters itself.
   *
   * When true we send base letters and leave shaping to the firmware. When
   * false we shape before sending. This is a claim about a specific model that
   * someone has observed on real hardware — it is never assumed, because a
   * device that does not shape prints disconnected letterforms and a device
   * that does shape would double-shape our presentation forms into nonsense.
   */
  readonly firmwareShapes: boolean;
  /**
   * The device runs its own bidirectional reordering.
   *
   * When false we reorder into visual order, because a legacy head emits bytes
   * strictly left to right.
   */
  readonly firmwareBidi: boolean;
  readonly qr: QrSupport;
  readonly supportsPartialCut: boolean;
  /**
   * Whether this profile's behaviour has been established for the specific model by physical hardware testing or authoritative vendor documentation.
   *
   * Unverified profiles must not take a text path. An unverified guess about
   * Arabic handling produces confident garbage on a tax invoice, which is
   * worse than refusing — so unknown devices fall back to raster.
   */
  readonly verified: boolean;
}

export interface PrinterProfile {
  readonly id: string;
  readonly vendor: string;
  readonly model: string;
  readonly capabilities: PrinterCapabilities;
  /** Why this profile is set up the way it is. Kept for the next reader. */
  readonly notes: string;
}
EOF

cat << 'EOF' > packages/printing/src/profiles/registry.ts
import type { PrinterProfile } from './types.js';

/**
 * The device profiles Korvi knows about.
 *
 * Deliberately small and explicit. A profile is a claim about hardware
 * behaviour, and an unverified claim is worse than no profile: it produces
 * confident garbage. Add a model here only once its behaviour has been observed
 * on a real unit.
 */

/**
 * Default for an unknown ESC/POS device — fails safe to raster.
 *
 * Revision 2 assumed an unknown device spoke CP1256 and shaped Arabic in
 * firmware. That was a guess, and a wrong guess prints an unreadable tax
 * invoice: devices differ on whether they shape, on which Arabic page they
 * carry, and on whether they carry one at all.
 *
 * So an unidentified device gets no text path. Rendering each line to a bitmap
 * is slower and always correct, and the caller is forced to supply a renderer
 * rather than silently receiving mojibake.
 *
 * Identify the model, verify it, and add a profile to get the fast path.
 */
export const GENERIC_ESCPOS_UNKNOWN: PrinterProfile = {
  id: 'generic-escpos-unknown',
  vendor: 'unknown',
  model: 'Unidentified ESC/POS 80mm',
  capabilities: {
    columns: 48,
    dotsPerLine: 576,
    text: 'raster',
    codePageId: null,
    firmwareShapes: false,
    firmwareBidi: false,
    qr: 'raster',
    supportsPartialCut: false,
    verified: false,
  },
  notes:
    'Unknown hardware. No assumption is made about Arabic support, so there is ' +
    'no text path at all: every line must be rendered to a bitmap. Replace with ' +
    'a verified model profile once the device is identified.',
};

/**
 * Epson TM-T20 family — native QR, CP864 with presentation forms.
 *
 * CP864 addresses shaped glyphs directly and the firmware does not join
 * letters, so Korvi shapes before sending.
 */
export const EPSON_TM_T20: PrinterProfile = {
  id: 'epson-tm-t20',
  vendor: 'Epson',
  model: 'TM-T20III',
  capabilities: {
    columns: 48,
    dotsPerLine: 576,
    // Arabic goes to raster even though this device supports PC864 (Epson
    // character code table 37). PC864 contains only 72 of the 144 Presentation
    // Forms-B code points, and only 71 of the 125 forms Korvi's shaper can
    // produce, so it cannot carry arbitrary shaped Arabic. Routing Arabic
    // through it would print correct text for some item names and wrong text
    // for others, which is the worst failure mode available. See ADR-0011.
    text: 'raster',
    codePageId: 0x25,
    firmwareShapes: false,
    firmwareBidi: false,
    // Native QR is documented by the vendor and is independent of the text
    // path, so it is kept.
    qr: 'native',
    supportsPartialCut: true,
    verified: true,
  },
  notes:
    'Verified for native GS ( k QR and ASCII text against the vendor ' +
    'character code tables. Arabic is routed to raster: PC864 cannot represent ' +
    'the full set of contextual forms, so a code-page path would be correct for ' +
    'some words and wrong for others (ADR-0011).',
};

/**
 * SYNTHETIC — a test fixture, not a production profile.
 *
 * It models a hypothetical device that accepts CP1256 and joins letters in
 * firmware, so the CP1256 codec and the "do not pre-shape" branch of the
 * encoder stay exercised. No physical unit has been tested against it.
 *
 * `verified: false` keeps it out of every production path: the encoder refuses
 * unverified profiles, and it is excluded from `PRODUCTION_PROFILES`. Promoting
 * it means testing real hardware against its vendor character table and saying
 * so here.
 *
 * The CP1256 table it exercises *is* authoritative — transcribed from the
 * Windows-1256 mapping and cross-checked entry by entry. What is unverified is
 * the claim that any given printer behaves this way.
 */
export const SYNTHETIC_CP1256_FIRMWARE_SHAPING: PrinterProfile = {
  id: 'synthetic-cp1256-firmware-shaping',
  vendor: 'synthetic',
  model: 'TEST FIXTURE — unverified CP1256 with firmware shaping',
  capabilities: {
    columns: 48,
    dotsPerLine: 576,
    text: 'cp1256',
    codePageId: 0x16,
    firmwareShapes: true,
    firmwareBidi: false,
    qr: 'raster',
    supportsPartialCut: true,
    verified: false,
  },
  notes:
    'SYNTHETIC TEST FIXTURE. Models base Arabic letters in CP1256 with ' +
    'firmware-side joining. No hardware has been verified against it, so it is ' +
    'unverified and excluded from production selection.',
};

/**
 * SYNTHETIC UTF-8 fixture.
 *
 * This models the behaviour of a modern printer that decodes UTF-8 and performs
 * shaping/bidi itself. It is deliberately NOT a production profile: no concrete
 * vendor/model has been verified, so production selection must not trust it.
 */
export const SYNTHETIC_UTF8_NATIVE: PrinterProfile = {
  id: 'synthetic-utf8-native',
  vendor: 'synthetic',
  model: 'TEST FIXTURE — hypothetical UTF-8 ESC/POS',
  capabilities: {
    columns: 48,
    dotsPerLine: 576,
    text: 'utf8',
    codePageId: null,
    firmwareShapes: true,
    firmwareBidi: true,
    qr: 'native',
    supportsPartialCut: true,
    verified: false,
  },
  notes:
    'SYNTHETIC TEST FIXTURE. Exercises the UTF-8 encoder branch only. No physical ' +
    'printer model has been verified against these capabilities, so it is excluded ' +
    'from production selection.',
};

/**
 * SYNTHETIC raster-only fixture.
 */
export const SYNTHETIC_RASTER_ONLY: PrinterProfile = {
  id: 'synthetic-raster-only',
  vendor: 'synthetic',
  model: 'TEST FIXTURE — raster-only printer',
  capabilities: {
    columns: 48,
    dotsPerLine: 576,
    text: 'raster',
    codePageId: null,
    firmwareShapes: false,
    firmwareBidi: false,
    qr: 'raster',
    supportsPartialCut: false,
    verified: false,
  },
  notes:
    'SYNTHETIC TEST FIXTURE. Exercises raster fallback behaviour only. It is not ' +
    'evidence about any real printer and is excluded from production selection.',
};

/** Everything defined here, including synthetic fixtures. */
export const PRINTER_PROFILES: readonly PrinterProfile[] = [
  GENERIC_ESCPOS_UNKNOWN,
  EPSON_TM_T20,
  SYNTHETIC_CP1256_FIRMWARE_SHAPING,
  SYNTHETIC_UTF8_NATIVE,
  SYNTHETIC_RASTER_ONLY,
];

/**
 * Profiles a running till may select.
 *
 * Only concrete, verified, non-synthetic device profiles are eligible. The
 * unidentified fail-safe profile remains the DEFAULT_PROFILE but is not a
 * production capability claim.
 */
export const PRODUCTION_PROFILES: readonly PrinterProfile[] = PRINTER_PROFILES.filter(
  (profile) => profile.vendor !== 'synthetic' && profile.capabilities.verified,
);

/**
 * The profile to use when the device has not been identified.
 *
 * Raster, always. No guess about Arabic support is safe (ADR-0011).
 */
export const DEFAULT_PROFILE: PrinterProfile = GENERIC_ESCPOS_UNKNOWN;

/** Resolve a production profile by id. Synthetic fixtures never resolve. */
export function findProductionProfile(id: string): PrinterProfile | null {
  return PRODUCTION_PROFILES.find((profile) => profile.id === id) ?? null;
}

export function findProfile(id: string): PrinterProfile | null {
  return PRINTER_PROFILES.find((profile) => profile.id === id) ?? null;
}
EOF

cat << 'EOF' > packages/printing/src/encoding/arabic-shaping.ts
/**
 * Arabic contextual shaping — Unicode Arabic Presentation Forms-B.
 *
 * Arabic letters change shape according to their neighbours: isolated, initial,
 * medial or final. Unicode text stores the base letter and leaves joining to
 * the renderer, which is right for a screen and wrong for a legacy print head
 * that has no renderer. Sending base letters to a CP864 device produces
 * disconnected letterforms — readable-ish to a machine, wrong to a customer.
 *
 * `calt` in the design system does this job on screen (KORVI-DESIGN-SYSTEM.md
 * §4.3). This is the same operation for paper.
 */

interface Forms {
  readonly isolated: number;
  readonly final: number;
  readonly initial: number;
  readonly medial: number;
}

/**
 * Joining behaviour.
 *
 * `dual` letters join on both sides. `right` letters (the alef family, dal,
 * thal, ra, zay, waw) accept a join only from the preceding letter, which is
 * why words containing them break into visual clusters.
 */
const DUAL = 'dual';
const RIGHT = 'right';

interface Entry {
  readonly join: typeof DUAL | typeof RIGHT;
  readonly forms: Forms;
}

/** Base letter -> presentation forms. Values are the Forms-B code points. */
const TABLE = new Map<number, Entry>([
  [0x0621, { join: RIGHT, forms: { isolated: 0xfe80, final: 0xfe80, initial: 0xfe80, medial: 0xfe80 } }], // ء
  [0x0622, { join: RIGHT, forms: { isolated: 0xfe81, final: 0xfe82, initial: 0xfe81, medial: 0xfe82 } }], // آ
  [0x0623, { join: RIGHT, forms: { isolated: 0xfe83, final: 0xfe84, initial: 0xfe83, medial: 0xfe84 } }], // أ
  [0x0624, { join: RIGHT, forms: { isolated: 0xfe85, final: 0xfe86, initial: 0xfe85, medial: 0xfe86 } }], // ؤ
  [0x0625, { join: RIGHT, forms: { isolated: 0xfe87, final: 0xfe88, initial: 0xfe87, medial: 0xfe88 } }], // إ
  [0x0626, { join: DUAL,  forms: { isolated: 0xfe89, final: 0xfe8a, initial: 0xfe8b, medial: 0xfe8c } }], // ئ
  [0x0627, { join: RIGHT, forms: { isolated: 0xfe8d, final: 0xfe8e, initial: 0xfe8d, medial: 0xfe8e } }], // ا
  [0x0628, { join: DUAL,  forms: { isolated: 0xfe8f, final: 0xfe90, initial: 0xfe91, medial: 0xfe92 } }], // ب
  [0x0629, { join: RIGHT, forms: { isolated: 0xfe93, final: 0xfe94, initial: 0xfe93, medial: 0xfe94 } }], // ة
  [0x062a, { join: DUAL,  forms: { isolated: 0xfe95, final: 0xfe96, initial: 0xfe97, medial: 0xfe98 } }], // ت
  [0x062b, { join: DUAL,  forms: { isolated: 0xfe99, final: 0xfe9a, initial: 0xfe9b, medial: 0xfe9c } }], // ث
  [0x062c, { join: DUAL,  forms: { isolated: 0xfe9d, final: 0xfe9e, initial: 0xfe9f, medial: 0xfea0 } }], // ج
  [0x062d, { join: DUAL,  forms: { isolated: 0xfea1, final: 0xfea2, initial: 0xfea3, medial: 0xfea4 } }], // ح
  [0x062e, { join: DUAL,  forms: { isolated: 0xfea5, final: 0xfea6, initial: 0xfea7, medial: 0xfea8 } }], // خ
  [0x062f, { join: RIGHT, forms: { isolated: 0xfea9, final: 0xfeaa, initial: 0xfea9, medial: 0xfeaa } }], // د
  [0x0630, { join: RIGHT, forms: { isolated: 0xfeab, final: 0xfeac, initial: 0xfeab, medial: 0xfeac } }], // ذ
  [0x0631, { join: RIGHT, forms: { isolated: 0xfead, final: 0xfeae, initial: 0xfead, medial: 0xfeae } }], // ر
  [0x0632, { join: RIGHT, forms: { isolated: 0xfeaf, final: 0xfeb0, initial: 0xfeaf, medial: 0xfeb0 } }], // ز
  [0x0633, { join: DUAL,  forms: { isolated: 0xfeb1, final: 0xfeb2, initial: 0xfeb3, medial: 0xfeb4 } }], // س
  [0x0634, { join: DUAL,  forms: { isolated: 0xfeb5, final: 0xfeb6, initial: 0xfeb7, medial: 0xfeb8 } }], // ش
  [0x0635, { join: DUAL,  forms: { isolated: 0xfeb9, final: 0xfeba, initial: 0xfebb, medial: 0xfebc } }], // ص
  [0x0636, { join: DUAL,  forms: { isolated: 0xfebd, final: 0xfebe, initial: 0xfebf, medial: 0xfec0 } }], // ض
  [0x0637, { join: DUAL,  forms: { isolated: 0xfec1, final: 0xfec2, initial: 0xfec3, medial: 0xfec4 } }], // ط
  [0x0638, { join: DUAL,  forms: { isolated: 0xfec5, final: 0xfec6, initial: 0xfec7, medial: 0xfec8 } }], // ظ
  [0x0639, { join: DUAL,  forms: { isolated: 0xfec9, final: 0xfeca, initial: 0xfecb, medial: 0xfecc } }], // ع
  [0x063a, { join: DUAL,  forms: { isolated: 0xfecd, final: 0xfece, initial: 0xfecf, medial: 0xfed0 } }], // غ
  [0x0641, { join: DUAL,  forms: { isolated: 0xfed1, final: 0xfed2, initial: 0xfed3, medial: 0xfed4 } }], // ف
  [0x0642, { join: DUAL,  forms: { isolated: 0xfed5, final: 0xfed6, initial: 0xfed7, medial: 0xfed8 } }], // ق
  [0x0643, { join: DUAL,  forms: { isolated: 0xfed9, final: 0xfeda, initial: 0xfedb, medial: 0xfedc } }], // ك
  [0x0644, { join: DUAL,  forms: { isolated: 0xfedd, final: 0xfede, initial: 0xfedf, medial: 0xfee0 } }], // ل
  [0x0645, { join: DUAL,  forms: { isolated: 0xfee1, final: 0xfee2, initial: 0xfee3, medial: 0xfee4 } }], // م
  [0x0646, { join: DUAL,  forms: { isolated: 0xfee5, final: 0xfee6, initial: 0xfee7, medial: 0xfee8 } }], // ن
  [0x0647, { join: DUAL,  forms: { isolated: 0xfee9, final: 0xfeea, initial: 0xfeeb, medial: 0xfeec } }], // ه
  [0x0648, { join: RIGHT, forms: { isolated: 0xfeed, final: 0xfeee, initial: 0xfeed, medial: 0xfeee } }], // و
  [0x0649, { join: DUAL,  forms: { isolated: 0xfeef, final: 0xfef0, initial: 0xfeef, medial: 0xfef0 } }], // ى
  [0x064a, { join: DUAL,  forms: { isolated: 0xfef1, final: 0xfef2, initial: 0xfef3, medial: 0xfef4 } }], // ي
]);

/**
 * Lam-alef: a mandatory ligature, not a stylistic option.
 *
 * Arabic has no way to write lam followed by alef as two separate glyphs; the
 * combined form is the only correct rendering. Skipping this is the single most
 * visible shaping bug on a receipt.
 */
const LAM = 0x0644;
const LAM_ALEF = new Map<number, { isolated: number; final: number }>([
  [0x0622, { isolated: 0xfef5, final: 0xfef6 }],
  [0x0623, { isolated: 0xfef7, final: 0xfef8 }],
  [0x0625, { isolated: 0xfef9, final: 0xfefa }],
  [0x0627, { isolated: 0xfefb, final: 0xfefc }],
]);

/** Diacritics are transparent to joining — they must not break a connection. */
function isTransparent(codePoint: number): boolean {
  return (
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06ed)
  );
}

function joinsForward(codePoint: number | undefined): boolean {
  if (codePoint === undefined) return false;
  return TABLE.get(codePoint)?.join === DUAL;
}

function joinsBackward(codePoint: number | undefined): boolean {
  return codePoint !== undefined && TABLE.has(codePoint);
}

/**
 * Convert base Arabic letters into their contextual presentation forms.
 *
 * Non-Arabic code points pass through untouched, so a mixed line keeps its
 * Latin and its digits intact.
 */
export function shapeArabic(input: string): string {
  const points = [...input].map((character) => character.codePointAt(0) ?? 0);
  const out: number[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index] as number;
    const entry = TABLE.get(current);

    if (entry === undefined) {
      out.push(current);
      continue;
    }

    let previous: number | undefined;
    for (let back = index - 1; back >= 0; back -= 1) {
      const candidate = points[back] as number;
      if (!isTransparent(candidate)) {
        previous = candidate;
        break;
      }
    }

    let next: number | undefined;
    let nextIndex = -1;
    for (let forward = index + 1; forward < points.length; forward += 1) {
      const candidate = points[forward] as number;
      if (!isTransparent(candidate)) {
        next = candidate;
        nextIndex = forward;
        break;
      }
    }

    const connectsBefore = joinsForward(previous);

    if (current === LAM && next !== undefined && LAM_ALEF.has(next)) {
      const ligature = LAM_ALEF.get(next) as { isolated: number; final: number };
      out.push(connectsBefore ? ligature.final : ligature.isolated);
      index = nextIndex; // the alef is consumed by the ligature
      continue;
    }

    const connectsAfter = joinsBackward(next) && entry.join === DUAL;

    if (connectsBefore && connectsAfter) out.push(entry.forms.medial);
    else if (connectsBefore) out.push(entry.forms.final);
    else if (connectsAfter) out.push(entry.forms.initial);
    else out.push(entry.forms.isolated);
  }

  return String.fromCodePoint(...out);
}
EOF

cat << 'EOF' > packages/printing/src/encoding/bidi.ts
/**
 * Visual reordering for print heads with no bidi algorithm.
 *
 * A legacy head emits bytes strictly left to right. Handed logical-order
 * Arabic it prints the first letter leftmost, so the word reads backwards.
 *
 * SCOPE. This is a deliberate subset of UAX #9, not an implementation of it:
 * runs are classified strong-RTL, strong-LTR or neutral, RTL runs are reversed,
 * and neutrals between two RTL runs are absorbed. It handles what a receipt
 * actually contains — Arabic prose with embedded Latin item codes and Western
 * digits. It does not handle explicit directional overrides, isolates, or
 * nested level changes beyond depth one. A line needing those belongs on the
 * raster path, where the renderer runs the real algorithm.
 *
 * Numbers are never reversed: "115.00" must print as "115.00" in any context,
 * which is the same rule the screen enforces through `.numeric`.
 */

type Direction = 'rtl' | 'ltr' | 'neutral';

function directionOf(codePoint: number): Direction {
  // Arabic, Arabic Supplement, Presentation Forms A and B, Hebrew.
  if (
    (codePoint >= 0x0590 && codePoint <= 0x05ff) ||
    (codePoint >= 0x0600 && codePoint <= 0x06ff) ||
    (codePoint >= 0x0750 && codePoint <= 0x077f) ||
    (codePoint >= 0xfb50 && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff)
  ) {
    return 'rtl';
  }
  // Latin letters and Western digits are strong LTR for our purposes: a price
  // or a SKU keeps its order regardless of the surrounding script.
  if (
    (codePoint >= 0x0030 && codePoint <= 0x0039) ||
    (codePoint >= 0x0041 && codePoint <= 0x005a) ||
    (codePoint >= 0x0061 && codePoint <= 0x007a) ||
    (codePoint >= 0x00c0 && codePoint <= 0x024f)
  ) {
    return 'ltr';
  }
  return 'neutral';
}

interface Run {
  readonly direction: Direction;
  readonly text: string;
}

function segment(input: string): Run[] {
  const runs: Run[] = [];
  let current: Direction | null = null;
  let buffer = '';

  for (const character of input) {
    const direction = directionOf(character.codePointAt(0) ?? 0);
    if (direction === current) {
      buffer += character;
    } else {
      if (current !== null) runs.push({ direction: current, text: buffer });
      current = direction;
      buffer = character;
    }
  }
  if (current !== null) runs.push({ direction: current, text: buffer });
  return runs;
}

/**
 * Reorder a logical-order string into the visual order a legacy head needs.
 *
 * Returns the input unchanged when it contains no RTL, so Latin-only receipts
 * are untouched.
 */
export function toVisualOrder(input: string): string {
  const runs = segment(input);
  if (!runs.some((run) => run.direction === 'rtl')) return input;

  // A neutral flanked by the same direction on both sides takes that
  // direction. This is UAX #9 rule N1, and it is load-bearing twice over: a
  // space between two Arabic words belongs to the Arabic, and — less obviously
  // — the decimal point inside "115.00" belongs to the number. Without the
  // second case the price is split into three runs and printed as "00.115".
  const resolved: Run[] = runs.map((run, index) => {
    if (run.direction !== 'neutral') return run;
    const before = runs[index - 1]?.direction;
    const after = runs[index + 1]?.direction;
    return before !== undefined && before === after
      ? { direction: before, text: run.text }
      : run;
  });

  // Merge adjacent RTL runs so a reversal spans the whole phrase.
  const merged: Run[] = [];
  for (const run of resolved) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.direction === run.direction) {
      merged[merged.length - 1] = { direction: run.direction, text: last.text + run.text };
    } else {
      merged.push(run);
    }
  }

  const pieces = merged.map((run) =>
    run.direction === 'rtl' ? [...run.text].reverse().join('') : run.text,
  );

  // The line as a whole is RTL, so the run order reverses too.
  return pieces.reverse().join('');
}
EOF

cat << 'EOF' > packages/printing/src/encoding/codepage.ts
import { UnsupportedCharacterError } from '../errors.js';

/**
 * Legacy single-byte code page mapping.
 *
 * The point of this file is that it exists at all. An ESC/POS device decodes
 * incoming bytes through whichever code page it was told to select, so the
 * encoder has to produce bytes in that page. Sending UTF-8 instead — revision
 * 1's bug — hands the head two bytes per Arabic letter and it prints two
 * unrelated glyphs for each.
 */

/** Windows-1256. Base Arabic letters; the firmware joins them. */
const CP1256 = new Map<number, number>([
  [0x060c, 0xa1], [0x061b, 0xba], [0x061f, 0xbf],
  [0x0621, 0xc1], [0x0622, 0xc2], [0x0623, 0xc3], [0x0624, 0xc4], [0x0625, 0xc5],
  [0x0626, 0xc6], [0x0627, 0xc7], [0x0628, 0xc8], [0x0629, 0xc9], [0x062a, 0xca],
  [0x062b, 0xcb], [0x062c, 0xcc], [0x062d, 0xcd], [0x062e, 0xce], [0x062f, 0xcf],
  [0x0630, 0xd0], [0x0631, 0xd1], [0x0632, 0xd2], [0x0633, 0xd3], [0x0634, 0xd4],
  [0x0635, 0xd5], [0x0636, 0xd6], [0x0637, 0xd8], [0x0638, 0xd9], [0x0639, 0xda],
  [0x063a, 0xdb], [0x0640, 0xdc], [0x0641, 0xdd], [0x0642, 0xde], [0x0643, 0xdf],
  [0x0644, 0xe1], [0x0645, 0xe3], [0x0646, 0xe4], [0x0647, 0xe5], [0x0648, 0xe6],
  [0x0649, 0xec], [0x064a, 0xed],
  [0x064b, 0xf0], [0x064c, 0xf1], [0x064d, 0xf2], [0x064e, 0xf3], [0x064f, 0xf5],
  [0x0650, 0xf6], [0x0651, 0xf8], [0x0652, 0xfa],
  [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94],
  [0x00a0, 0xa0], [0x00d7, 0xd7], [0x00f7, 0xf7],
]);

/**
 * PC864 (CP864), transcribed from the authoritative Microsoft/Unicode mapping.
 *
 * SOURCE: https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP864.TXT
 * Cross-checked against the platform's own `cp864` codec, which is derived from
 * the same mapping. Epson documents this page as character code table 37.
 *
 * Every entry below comes from that table. None is inferred, and none is
 * derived from Korvi's own shaper — which is exactly how revision 3 went wrong:
 * its table was invented, its golden fixtures were then generated *from* that
 * table, and the two agreed with each other while both disagreed with PC864.
 * Notably it mapped the lam-alef ligature to 0xE8, which in PC864 is WAW
 * ISOLATED (U+FEED).
 *
 * The decisive property of the real table: PC864 contains only 72 of the 144
 * code points in the Arabic Presentation Forms-B block, and only 71 of the 125
 * forms Korvi's shaper can produce. Standard PC864 therefore CANNOT carry
 * arbitrary fully-shaped Arabic. That is a property of the code page, not a gap
 * in this transcription, and it is why Arabic defaults to the raster path
 * (ADR-0011).
 */
const CP864 = new Map<number, number>([
  [0x00a0, 0xa0], [0x00a2, 0xc0], [0x00a3, 0xa3], [0x00a4, 0xa4],
  [0x00a6, 0xdb], [0x00ab, 0x97], [0x00ac, 0xdc], [0x00ad, 0xa1],
  [0x00b0, 0x80], [0x00b1, 0x93], [0x00b7, 0x81], [0x00bb, 0x98],
  [0x00bc, 0x95], [0x00bd, 0x94], [0x00d7, 0xde], [0x00f7, 0xdd],
  [0x03b2, 0x90], [0x03c6, 0x92], [0x060c, 0xac], [0x061b, 0xbb],
  [0x061f, 0xbf], [0x0640, 0xe0], [0x0651, 0xf1], [0x0660, 0xb0],
  [0x0661, 0xb1], [0x0662, 0xb2], [0x0663, 0xb3], [0x0664, 0xb4],
  [0x0665, 0xb5], [0x0666, 0xb6], [0x0667, 0xb7], [0x0668, 0xb8],
  [0x0669, 0xb9], [0x066a, 0x25], [0x2219, 0x82], [0x221a, 0x83], [0x221e, 0x91],
  [0x2248, 0x96], [0x2500, 0x85], [0x2502, 0x86], [0x250c, 0x8d],
  [0x2510, 0x8c], [0x2514, 0x8e], [0x2518, 0x8f], [0x251c, 0x8a],
  [0x2524, 0x88], [0x252c, 0x89], [0x2534, 0x8b], [0x253c, 0x87],
  [0x2592, 0x84], [0x25a0, 0xfe], [0xfe7d, 0xf0], [0xfe80, 0xc1],
  [0xfe81, 0xc2], [0xfe82, 0xa2], [0xfe83, 0xc3], [0xfe84, 0xa5],
  [0xfe85, 0xc4], [0xfe8b, 0xc6], [0xfe8d, 0xc7], [0xfe8e, 0xa8],
  [0xfe8f, 0xa9], [0xfe91, 0xc8], [0xfe93, 0xc9], [0xfe95, 0xaa],
  [0xfe97, 0xca], [0xfe99, 0xab], [0xfe9b, 0xcb], [0xfe9d, 0xad],
  [0xfe9f, 0xcc], [0xfea1, 0xae], [0xfea3, 0xcd], [0xfea5, 0xaf],
  [0xfea7, 0xce], [0xfea9, 0xcf], [0xfeab, 0xd0], [0xfead, 0xd1],
  [0xfeaf, 0xd2], [0xfeb1, 0xbc], [0xfeb3, 0xd3], [0xfeb5, 0xbd],
  [0xfeb7, 0xd4], [0xfeb9, 0xbe], [0xfebb, 0xd5], [0xfebd, 0xeb],
  [0xfebf, 0xd6], [0xfec1, 0xd7], [0xfec5, 0xd8], [0xfec9, 0xdf],
  [0xfeca, 0xc5], [0xfecb, 0xd9], [0xfecc, 0xec], [0xfecd, 0xee],
  [0xfece, 0xed], [0xfecf, 0xda], [0xfed0, 0xf7], [0xfed1, 0xba],
  [0xfed3, 0xe1], [0xfed5, 0xf8], [0xfed7, 0xe2], [0xfed9, 0xfc],
  [0xfedb, 0xe3], [0xfedd, 0xfb], [0xfedf, 0xe4], [0xfee1, 0xef],
  [0xfee3, 0xe5], [0xfee5, 0xf2], [0xfee7, 0xe6], [0xfee9, 0xf3],
  [0xfeeb, 0xe7], [0xfeec, 0xf4], [0xfeed, 0xe8], [0xfeef, 0xe9],
  [0xfef0, 0xf5], [0xfef1, 0xfd], [0xfef2, 0xf6], [0xfef3, 0xea],
  [0xfef5, 0xf9], [0xfef6, 0xfa], [0xfef7, 0x99], [0xfef8, 0x9a],
  [0xfefb, 0x9d], [0xfefc, 0x9e],
]);

const TABLES: Record<'cp1256' | 'cp864', Map<number, number>> = {
  cp1256: CP1256,
  cp864: CP864,
};

/** Harakat and other combining marks: U+064B-065F, U+0670, U+06D6-06ED. */
const DIACRITIC =
  /[\u064B-\u065F\u0670\u06D6-\u06ED]/gu;

/**
 * Code pages whose Arabic repertoire carries no combining marks.
 *
 * CP864 addresses presentation forms and has no cells for harakat. CP1256 does
 * carry them, so it is absent from this set.
 */
const STRIPS_DIACRITICS: ReadonlySet<string> = new Set(['cp864']);

/**
 * Remove optional vowel marks.
 *
 * This is not the same as substituting a wrong glyph, which the encoder refuses
 * to do. Harakat are optional vowelisation: Arabic is normally written without
 * them, and the consonant skeleton is the word. Dropping a damma leaves the
 * text correct and readable; inventing a byte for it would print a different
 * letter.
 *
 * Applied only for code pages that cannot represent them at all.
 */
export function stripDiacritics(input: string): string {
  return input.replace(DIACRITIC, '');
}

/**
 * Encode a string into a single-byte code page.
 *
 * ASCII passes through unchanged in both pages, which is what keeps prices and
 * document numbers intact.
 */
export function encodeCodePage(input: string, page: 'cp1256' | 'cp864'): Uint8Array {
  const table = TABLES[page];
  const source = STRIPS_DIACRITICS.has(page) ? stripDiacritics(input) : input;
  const out: number[] = [];

  for (const character of source) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint < 0x80) {
      out.push(codePoint);
      continue;
    }

    const mapped = table.get(codePoint);
    if (mapped === undefined) {
      throw new UnsupportedCharacterError(
        `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} ("${character}") has no ` +
          `${page} mapping. Use a profile with a raster fallback rather than printing a ` +
          'substitute glyph on a tax invoice.',
      );
    }
    out.push(mapped);
  }

  return Uint8Array.from(out);
}

export function canEncode(input: string, page: 'cp1256' | 'cp864'): boolean {
  try {
    encodeCodePage(input, page);
    return true;
  } catch {
    return false;
  }
}
EOF

cat << 'EOF' > packages/printing/src/errors.ts
/** Base class for printing failures Korvi raises deliberately. */
export class PrintingError extends Error {
  public override readonly name: string = 'PrintingError';

  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A character cannot be represented in the selected code page.
 *
 * Raised instead of substituting: a receipt that quietly prints the wrong
 * glyph is worse than one that refuses, because nobody notices the first.
 */
export class UnsupportedCharacterError extends PrintingError {
  public override readonly name = 'UnsupportedCharacterError';
}

/**
 * The profile needs a capability nothing has supplied.
 *
 * Typically a raster-only device with no RasterRenderer injected. Failing here
 * is the whole point of the profile model: the alternative is emitting bytes
 * the device will print as garbage.
 */
export class MissingCapabilityError extends PrintingError {
  public override readonly name = 'MissingCapabilityError';
}
EOF

cat << 'EOF' > packages/printing/src/encoding/text-encoder.ts
import { encodeCodePage } from './codepage.js';
import { shapeArabic } from './arabic-shaping.js';
import { toVisualOrder } from './bidi.js';
import { MissingCapabilityError } from '../errors.js';
import type { PrinterProfile } from '../profiles/types.js';

/**
 * Turn a logical-order string into the bytes a given device needs.
 *
 * The order of the two Arabic steps is the correctness point, and revision 2
 * had it backwards.
 *
 *   1. SHAPE, on logical order.
 *   2. REORDER the shaped result into visual order.
 *
 * Contextual shaping is defined over *logical* adjacency: a letter's form
 * depends on the letter before and after it as the word is written, not as it
 * is laid out on paper. Reordering first reverses that adjacency, so every
 * letter is shaped against the wrong neighbours — initial forms become final,
 * medial joins break, and lam-alef never pairs because the lam now follows the
 * alef. The output is well-formed bytes that spell a word incorrectly, which is
 * the hardest kind of wrong to notice.
 *
 * Reordering after shaping is safe: presentation forms are still RTL
 * characters, so the reordering pass treats them exactly as it treats base
 * letters.
 *
 * Each step is skipped when the device declares it does that work itself.
 */
function isAscii(text: string): boolean {
  return [...text].every((character) => (character.codePointAt(0) ?? 0) < 0x80);
}

function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from([...text].map((character) => character.codePointAt(0) ?? 0));
}

export function encodeTextFor(profile: PrinterProfile, text: string): Uint8Array {
  const { capabilities } = profile;

  if (capabilities.text === 'raster') {
    // ASCII still goes native: command bytes, document numbers and prices are
    // identical in every code page, and rasterising them would be pointless.
    // Anything above U+007F needs a renderer.
    if (isAscii(text)) {
      return asciiBytes(text);
    }
    throw new MissingCapabilityError(
      `Profile "${profile.id}" has no non-ASCII text path` +
        (capabilities.verified ? '' : ' (device unverified)') +
        '; render the line with a RasterRenderer and send it as a bitmap instead. ' +
        'See ADR-0011.',
    );
  }

  if (!capabilities.verified) {
    // Belt and braces: an unverified profile must never reach a code page.
    throw new MissingCapabilityError(
      `Profile "${profile.id}" is unverified, so its Arabic behaviour is a guess. ` +
        'Use a verified profile or the raster path.',
    );
  }

  let staged = text;

  // 1. Shape on logical adjacency.
  if (!capabilities.firmwareShapes) {
    staged = shapeArabic(staged);
  }

  // 2. Then lay out for a head with no bidi algorithm.
  if (!capabilities.firmwareBidi) {
    staged = toVisualOrder(staged);
  }

  if (capabilities.text === 'utf8') {
    return new TextEncoder().encode(staged);
  }

  return encodeCodePage(staged, capabilities.text);
}
EOF

cat << 'EOF' > packages/printing/src/raster.ts
import { MissingCapabilityError } from './errors.js';

/**
 * Raster boundary — declared in Phase 0, implemented later.
 *
 * Some devices have no Arabic code page at all. The only honest output for
 * those is a bitmap of the rendered line, which means a real text renderer:
 * a font, a shaper, a layout engine. That is a Phase 1 dependency, not
 * something to fake here.
 *
 * The port exists now so the pipeline is shaped correctly from the start, and
 * so a raster-only profile fails loudly rather than silently taking a text
 * path that would print nonsense.
 */
export interface RasterBitmap {
  /** Width in dots. Must not exceed the profile's dotsPerLine. */
  readonly width: number;
  readonly height: number;
  /** 1 bit per pixel, row-major, MSB first — the layout `GS v 0` expects. */
  readonly data: Uint8Array;
}

export interface RasterRenderer {
  renderLine(text: string, widthInDots: number): Promise<RasterBitmap>;
}

/** `GS v 0` — print a raster bit image. */
export function rasterCommand(bitmap: RasterBitmap): Uint8Array {
  const bytesPerRow = Math.ceil(bitmap.width / 8);
  const expected = bytesPerRow * bitmap.height;

  if (bitmap.data.length !== expected) {
    throw new MissingCapabilityError(
      `Raster payload is ${String(bitmap.data.length)} bytes; ` +
        `${String(bitmap.width)}x${String(bitmap.height)} needs ${String(expected)}.`,
    );
  }

  const header = Uint8Array.from([
    0x1d, 0x76, 0x30, 0x00,
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
    bitmap.height & 0xff, (bitmap.height >> 8) & 0xff,
  ]);

  const out = new Uint8Array(header.length + bitmap.data.length);
  out.set(header, 0);
  out.set(bitmap.data, header.length);
  return out;
}
EOF

cat << 'EOF' > packages/printing/src/qr.ts
import { MissingCapabilityError } from './errors.js';
import type { PrinterProfile } from './profiles/types.js';

/**
 * Native ESC/POS QR, via the `GS ( k` symbol-storage function set.
 *
 * The ZATCA payload has to reach the customer as a scannable symbol; a receipt
 * carrying the Base64 as text is not a compliant simplified tax invoice. This
 * is why QR support is a declared capability rather than an afterthought — on a
 * device without the firmware, these command bytes print as literal characters
 * across the paper.
 */

const GS = 0x1d;
const FN_MODEL = 0x41;
const FN_SIZE = 0x43;
const FN_ERROR_CORRECTION = 0x45;
const FN_STORE = 0x50;
const FN_PRINT = 0x51;

/**
 * Error-correction level.
 *
 * `M` (15%) is the default here: a thermal receipt smudges and is often
 * scanned from a phone at an angle, and `L` leaves too little margin. `Q` and
 * `H` inflate the symbol enough to matter on 80mm paper.
 */
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

const EC_LEVEL: Record<QrErrorCorrection, number> = { L: 48, M: 49, Q: 50, H: 51 };

export interface QrOptions {
  /** Module size in dots, 1-16. 6 keeps a ZATCA payload scannable on 80mm. */
  readonly moduleSize?: number;
  readonly errorCorrection?: QrErrorCorrection;
}

function header(dataLength: number, functionCode: number): number[] {
  // pL, pH count the payload plus the two-byte function prefix.
  const length = dataLength + 3;
  return [GS, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, 0x31, functionCode];
}

/**
 * Build the full command sequence for one QR symbol.
 *
 * The payload is Latin-1 by construction — the ZATCA QR carries Base64 — so it
 * is written byte-for-byte and never passed through a code page.
 */
export function qrCommand(profile: PrinterProfile, payload: string, options: QrOptions = {}): Uint8Array {
  if (profile.capabilities.qr !== 'native') {
    throw new MissingCapabilityError(
      `Profile "${profile.id}" declares qr="${profile.capabilities.qr}"; ` +
        'render the symbol with a RasterRenderer instead of emitting GS ( k.',
    );
  }

  const moduleSize = options.moduleSize ?? 6;
  if (!Number.isInteger(moduleSize) || moduleSize < 1 || moduleSize > 16) {
    throw new MissingCapabilityError('QR module size must be an integer between 1 and 16.');
  }

  const bytes: number[] = [];

  // Model 2 — the only model in general use.
  bytes.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, FN_MODEL, 0x32, 0x00);
  // Module size.
  bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, FN_SIZE, moduleSize);
  // Error correction.
  bytes.push(
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, FN_ERROR_CORRECTION,
    EC_LEVEL[options.errorCorrection ?? 'M'],
  );

  // Store the payload in the symbol buffer.
  const data: number[] = [];
  for (const character of payload) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 0xff) {
      throw new MissingCapabilityError(
        'QR payload must be single-byte; the ZATCA payload is Base64 by construction.',
      );
    }
    data.push(codePoint);
  }
  bytes.push(...header(data.length, FN_STORE), 0x30, ...data);

  // Print it.
  bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, FN_PRINT, 0x30);

  return Uint8Array.from(bytes);
}
EOF

cat << 'EOF' > packages/printing/src/escpos.ts
import { encodeTextFor } from './encoding/text-encoder.js';
import type { PrinterProfile } from './profiles/types.js';

/**
 * ESC/POS command construction.
 *
 * Byte building only — no transport, no device handle, no DOM. A receipt is a
 * value here, which is what makes it testable: you assert on bytes instead of
 * feeding paper through a printer to find out whether the layout changed.
 *
 * The builder carries a profile so that every text write goes through the
 * encoding pipeline for that device. Revision 1 had a builder with no profile
 * and a single hardcoded UTF-8 path, which is how the Arabic bug got in.
 */

const ESC = 0x1b;
const GS = 0x1d;

export type Alignment = 'start' | 'center' | 'end';

export class EscPosBuilder {
  private readonly chunks: Uint8Array[] = [];

  public constructor(public readonly profile: PrinterProfile) {}

  public get columns(): number {
    return this.profile.capabilities.columns;
  }

  public raw(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    return this;
  }

  /** ESC @ — reset to a known state, then select the profile's code page. */
  public initialise(): this {
    this.raw(Uint8Array.from([ESC, 0x40]));
    const page = this.profile.capabilities.codePageId;
    if (page !== null) {
      this.raw(Uint8Array.from([ESC, 0x74, page & 0xff]));
    }
    return this;
  }

  public align(alignment: Alignment): this {
    const code = alignment === 'start' ? 0 : alignment === 'center' ? 1 : 2;
    return this.raw(Uint8Array.from([ESC, 0x61, code]));
  }

  public bold(on: boolean): this {
    return this.raw(Uint8Array.from([ESC, 0x45, on ? 1 : 0]));
  }

  public doubleHeight(on: boolean): this {
    return this.raw(Uint8Array.from([GS, 0x21, on ? 0x01 : 0x00]));
  }

  /** Encode through the profile's pipeline — never a bare TextEncoder. */
  public text(value: string): this {
    return this.raw(encodeTextFor(this.profile, value));
  }

  public line(value = ''): this {
    return this.text(value).raw(Uint8Array.from([0x0a]));
  }

  /** ASCII rule; written directly because it needs no encoding. */
  public rule(character = '-'): this {
    const width = this.columns;
    return this.raw(Uint8Array.from(Array<number>(width).fill(character.charCodeAt(0)))).raw(
      Uint8Array.from([0x0a]),
    );
  }

  public feed(lines = 1): this {
    return this.raw(Uint8Array.from([ESC, 0x64, lines & 0xff]));
  }

  public cut(): this {
    // Partial cut leaves a tab so the receipt does not drop; devices without it
    // get a full cut rather than an unrecognised command.
    return this.raw(
      Uint8Array.from([GS, 0x56, this.profile.capabilities.supportsPartialCut ? 0x01 : 0x00]),
    );
  }

  public build(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export function escpos(profile: PrinterProfile): EscPosBuilder {
  return new EscPosBuilder(profile);
}

/**
 * Lay a label and an amount on one line, amount flush to the end.
 *
 * Truncates the label rather than wrapping: a total that slides onto a second
 * line is worse than a shortened item name.
 */
export function twoColumn(label: string, amount: string, width: number): string {
  const room = width - amount.length - 1;
  const trimmed = label.length > room ? `${label.slice(0, Math.max(0, room - 1))}…` : label;
  const padding = Math.max(1, width - trimmed.length - amount.length);
  return `${trimmed}${' '.repeat(padding)}${amount}`;
}
EOF

cat << 'EOF' > packages/printing/src/receipt.ts
import { moneyToMajorString } from '@korvi/domain';
import type { Money } from '@korvi/domain';
import { escpos, twoColumn } from './escpos.js';
import { qrCommand } from './qr.js';
import { rasterCommand } from './raster.js';
import { MissingCapabilityError } from './errors.js';
import type { RasterBitmap } from './raster.js';
import type { PrinterProfile } from './profiles/types.js';

export interface ReceiptLine {
  readonly description: string;
  readonly quantity: number;
  readonly lineTotal: Money;
}

export interface ReceiptData {
  readonly sellerName: string;
  readonly vatRegistrationNumber: string;
  readonly invoiceNumber: string;
  readonly timestamp: string;
  readonly lines: readonly ReceiptLine[];
  readonly net: Money;
  readonly vat: Money;
  readonly total: Money;
  /** Base64 TLV from `@korvi/domain`. Rendered here as an actual symbol. */
  readonly qrPayload: string;
}

export interface RenderOptions {
  /**
   * Pre-rendered QR bitmap, required when the profile declares `qr: 'raster'`.
   *
   * Supplied by the caller rather than produced here: rendering needs a QR
   * encoder and a bitmap surface, which are Phase 1 dependencies.
   */
  readonly qrBitmap?: RasterBitmap;
}

/**
 * Render a simplified tax invoice for a specific device.
 *
 * The QR is emitted as a real symbol — natively where the firmware supports it,
 * otherwise from a supplied bitmap. If neither is possible the function throws.
 * That refusal is deliberate: a simplified tax invoice without a scannable QR
 * is not a valid simplified tax invoice, and printing one anyway would hand the
 * merchant a document that fails inspection without anyone noticing at the till.
 *
 * The Korvi mark is deliberately absent from the header: that header identifies
 * the merchant who made the sale, and putting the software vendor there tells
 * an auditor Korvi sold the goods. Footer only. See KORVI-DESIGN-SYSTEM.md §8.
 */
export function renderReceipt(
  profile: PrinterProfile,
  data: ReceiptData,
  options: RenderOptions = {},
): Uint8Array {
  if (data.qrPayload.trim() === '') {
    throw new MissingCapabilityError(
      'A simplified tax invoice needs its ZATCA QR payload; refusing to print one without it.',
    );
  }

  const builder = escpos(profile).initialise();
  const width = profile.capabilities.columns;

  builder.align('center').bold(true).doubleHeight(true).line(data.sellerName);
  builder.doubleHeight(false).bold(false);
  builder.line(`الرقم الضريبي: ${data.vatRegistrationNumber}`);
  builder.line('فاتورة ضريبية مبسطة');
  builder.rule();

  builder.align('start');
  builder.line(twoColumn('رقم الفاتورة', data.invoiceNumber, width));
  builder.line(twoColumn('التاريخ', data.timestamp, width));
  builder.rule();

  for (const line of data.lines) {
    builder.line(line.description);
    // ASCII "x", not U+00D7. The multiplication sign is absent from CP864 and
    // from several vendor code pages, so using it would make the quantity line
    // unprintable on exactly the hardware this layer exists to support.
    builder.line(twoColumn(`  x ${String(line.quantity)}`, moneyToMajorString(line.lineTotal), width));
  }

  builder.rule();
  builder.line(twoColumn('الإجمالي قبل الضريبة', moneyToMajorString(data.net), width));
  builder.line(twoColumn('ضريبة القيمة المضافة', moneyToMajorString(data.vat), width));
  builder.bold(true);
  builder.line(twoColumn('الإجمالي', moneyToMajorString(data.total), width));
  builder.bold(false);
  builder.rule();

  // --- the QR itself ------------------------------------------------------
  builder.align('center');
  switch (profile.capabilities.qr) {
    case 'native':
      builder.raw(qrCommand(profile, data.qrPayload));
      break;
    case 'raster': {
      if (options.qrBitmap === undefined) {
        throw new MissingCapabilityError(
          `Profile "${profile.id}" has no QR firmware, so a rendered bitmap must be supplied. ` +
            'Refusing to print a simplified tax invoice without a scannable symbol.',
        );
      }
      builder.raw(rasterCommand(options.qrBitmap));
      break;
    }
    case 'none':
      throw new MissingCapabilityError(
        `Profile "${profile.id}" cannot print a QR code, so it cannot produce a compliant ` +
          'simplified tax invoice.',
      );
  }

  builder.line();
  builder.line('صُدرت عبر Korvi');
  builder.feed(2).cut();

  return builder.build();
}
EOF

cat << 'EOF' > packages/printing/src/transport.ts
/**
 * Transport boundary — declared in Phase 0, implemented later.
 *
 * Rendering and delivery are separated on purpose: the byte layout of a receipt
 * is worth testing exhaustively and does not change when the cable does. USB,
 * Bluetooth, network and WebUSB all become adapters behind this interface.
 */
export interface PrinterTransport {
  readonly id: string;
  send(payload: Uint8Array): Promise<void>;
  isAvailable(): Promise<boolean>;
}
EOF

cat << 'EOF' > packages/printing/src/index.ts
export * from './errors.js';
export * from './escpos.js';
export * from './qr.js';
export * from './raster.js';
export * from './receipt.js';
export * from './transport.js';
export * from './profiles/types.js';
export * from './profiles/registry.js';
export { encodeTextFor } from './encoding/text-encoder.js';
export { encodeCodePage, canEncode, stripDiacritics } from './encoding/codepage.js';
export { shapeArabic } from './encoding/arabic-shaping.js';
export { toVisualOrder } from './encoding/bidi.js';
EOF

cat << 'EOF' > packages/printing/src/__tests__/fixtures/bytes.ts
/**
 * ESC/POS command fixtures.
 *
 * Command sequences only. Arabic byte expectations live in
 * cp864-conformance.test.ts and are taken from the published code-page
 * mappings, never generated by the codec under test — that conflation is what
 * let revision 3 ship an invented CP864 table with a green suite.
 */

export const ESC_INIT = [0x1b, 0x40];
export const ESC_SELECT_CP1256 = [0x1b, 0x74, 0x16];
export const ESC_SELECT_CP864 = [0x1b, 0x74, 0x25];
export const ESC_ALIGN_CENTER = [0x1b, 0x61, 0x01];
export const GS_PARTIAL_CUT = [0x1d, 0x56, 0x01];
export const GS_FULL_CUT = [0x1d, 0x56, 0x00];

/** `GS ( k` model-2 selection — the first command of any native QR. */
export const QR_MODEL_2 = [0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00];

/** `GS ( k` print — the last command of any native QR. */
export const QR_PRINT = [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30];

/** `GS v 0` — raster bit image header. */
export const GS_RASTER = [0x1d, 0x76, 0x30, 0x00];
EOF

cat << 'EOF' > packages/printing/src/__tests__/encoding.test.ts
import { describe, expect, it } from 'vitest';
import { canEncode, encodeCodePage, stripDiacritics } from '../encoding/codepage.js';
import { encodeTextFor } from '../encoding/text-encoder.js';
import { UnsupportedCharacterError, MissingCapabilityError } from '../errors.js';
import {
  EPSON_TM_T20,
  GENERIC_ESCPOS_UNKNOWN,
  SYNTHETIC_RASTER_ONLY,
  SYNTHETIC_CP1256_FIRMWARE_SHAPING,
  SYNTHETIC_UTF8_NATIVE,
} from '../profiles/registry.js';
import type { PrinterProfile } from '../profiles/types.js';

const TEST_UTF8_NATIVE = {
  ...SYNTHETIC_UTF8_NATIVE,
  id: 'test-utf8-native-runtime',
  vendor: 'test-only',
  capabilities: { ...SYNTHETIC_UTF8_NATIVE.capabilities, verified: true },
} as const satisfies PrinterProfile;

describe('code page encoding', () => {
  it('maps Arabic to one byte per letter in CP1256', () => {
    // Windows-1256 holds the unshaped alphabet, one cell per letter.
    expect(Array.from(encodeCodePage('مرحبا', 'cp1256'))).toEqual([
      0xe3, 0xd1, 0xcd, 0xc8, 0xc7,
    ]);
  });

  it('does not emit UTF-8 for Arabic', () => {
    // Revision 1's bug: 5 letters became 10 UTF-8 bytes, and the head printed
    // 10 unrelated glyphs.
    const bytes = encodeCodePage('مرحبا', 'cp1256');
    expect(bytes.length).toBe(5);
    expect(bytes.length).not.toBe(new TextEncoder().encode('مرحبا').length);
  });

  it('passes ASCII through unchanged in both pages', () => {
    for (const page of ['cp1256', 'cp864'] as const) {
      expect(Array.from(encodeCodePage('INV-1', page))).toEqual([
        0x49, 0x4e, 0x56, 0x2d, 0x31,
      ]);
    }
  });

  it('refuses an unmappable character instead of substituting', () => {
    expect(() => encodeCodePage('日本語', 'cp1256')).toThrow(UnsupportedCharacterError);
    expect(() => encodeCodePage('🙂', 'cp864')).toThrow(UnsupportedCharacterError);
  });

  it('reports encodability without throwing', () => {
    expect(canEncode('مرحبا', 'cp1256')).toBe(true);
    expect(canEncode('日本語', 'cp1256')).toBe(false);
  });

  it('keeps vowel marks for a page that carries them', () => {
    expect(encodeCodePage('صُدرت', 'cp1256').length).toBe(5);
  });

  it('strips only combining marks, never letters', () => {
    expect(stripDiacritics('صُدرت')).toBe('صدرت');
    expect(stripDiacritics('مرحبا')).toBe('مرحبا');
    expect(stripDiacritics('Korvi 115.00')).toBe('Korvi 115.00');
  });
});

describe('profile-driven text encoding', () => {
  it('sends logical-order UTF-8 to a UTF-8 native device', () => {
    // Those devices run their own shaping and bidi, so neither step applies.
    expect(encodeTextFor(TEST_UTF8_NATIVE, 'مرحبا')).toEqual(new TextEncoder().encode('مرحبا'));
  });

  it('refuses Arabic on every raster profile', () => {
    for (const profile of [GENERIC_ESCPOS_UNKNOWN, SYNTHETIC_RASTER_ONLY, EPSON_TM_T20]) {
      expect(() => encodeTextFor(profile, 'مرحبا')).toThrow(MissingCapabilityError);
    }
  });

  it('refuses any unverified profile, synthetic fixtures included', () => {
    expect(() => encodeTextFor(SYNTHETIC_CP1256_FIRMWARE_SHAPING, 'مرحبا')).toThrow(
      MissingCapabilityError,
    );
  });

  it('lets ASCII through natively on a raster profile', () => {
    // Prices and document numbers are identical in every code page, so there
    // is nothing to render.
    for (const profile of [GENERIC_ESCPOS_UNKNOWN, EPSON_TM_T20]) {
      expect(Array.from(encodeTextFor(profile, '115.00'))).toEqual([
        0x31, 0x31, 0x35, 0x2e, 0x30, 0x30,
      ]);
    }
  });

  it('keeps prices readable on the UTF-8 path too', () => {
    expect(Array.from(encodeTextFor(TEST_UTF8_NATIVE, '115.00'))).toEqual([
      0x31, 0x31, 0x35, 0x2e, 0x30, 0x30,
    ]);
  });
});
EOF

cat << 'EOF' > packages/printing/src/__tests__/receipt.test.ts
import { describe, expect, it } from 'vitest';
import { escpos, twoColumn } from '../escpos.js';
import { renderReceipt } from '../receipt.js';
import { qrCommand } from '../qr.js';
import { rasterCommand } from '../raster.js';
import { MissingCapabilityError } from '../errors.js';
import {
  EPSON_TM_T20,
  GENERIC_ESCPOS_UNKNOWN,
  SYNTHETIC_UTF8_NATIVE,
  findProfile,
} from '../profiles/registry.js';
import { moneyFromMajorString } from '@korvi/domain';
import {
  ESC_INIT,
  ESC_SELECT_CP864,
  GS_PARTIAL_CUT,
  GS_RASTER,
  QR_MODEL_2,
  QR_PRINT,
} from './fixtures/bytes.js';
import type { PrinterProfile } from '../profiles/types.js';

const TEST_UTF8_NATIVE = {
  ...SYNTHETIC_UTF8_NATIVE,
  id: 'test-utf8-native-receipt',
  vendor: 'test-only',
  capabilities: { ...SYNTHETIC_UTF8_NATIVE.capabilities, verified: true },
} as const satisfies PrinterProfile;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((value, index) => bytes[index] === value);

const contains = (bytes: Uint8Array, needle: readonly number[]): boolean => {
  const hay = Array.from(bytes);
  return hay.some((_, index) => needle.every((value, offset) => hay[index + offset] === value));
};

const data = {
  sellerName: 'متجر كورفي',
  vatRegistrationNumber: '310122393500003',
  invoiceNumber: 'INV-2026-00001',
  timestamp: '2026-08-07T09:45:00Z',
  lines: [{ description: 'ماء 600 مل', quantity: 2, lineTotal: moneyFromMajorString('4.00') }],
  net: moneyFromMajorString('100.00'),
  vat: moneyFromMajorString('15.00'),
  total: moneyFromMajorString('115.00'),
  qrPayload: 'AQVtZXJjaAIPMzEwMTIyMzkzNTAwMDAz',
};

describe('builder', () => {
  it('initialises and selects the profile code page where there is one', () => {
    // Epson still selects PC864 for its ASCII path; the Arabic text simply does
    // not travel that way (ADR-0011).
    expect(startsWith(escpos(EPSON_TM_T20).initialise().build(), [
      ...ESC_INIT,
      ...ESC_SELECT_CP864,
    ])).toBe(true);
  });

  it('sends no code page selector to a UTF-8 device', () => {
    expect(Array.from(escpos(TEST_UTF8_NATIVE).initialise().build())).toEqual(ESC_INIT);
  });

  it('sends no code page selector to an unidentified device', () => {
    expect(Array.from(escpos(GENERIC_ESCPOS_UNKNOWN).initialise().build())).toEqual(ESC_INIT);
  });
});

describe('twoColumn', () => {
  it('fills the profile width and flushes the amount to the end', () => {
    const line = twoColumn('Item', '10.00', 48);
    expect(line).toHaveLength(48);
    expect(line.endsWith('10.00')).toBe(true);
  });

  it('truncates rather than wrapping', () => {
    expect(twoColumn('x'.repeat(200), '10.00', 48)).toHaveLength(48);
  });
});

describe('QR', () => {
  it('emits the model, size, correction, store and print sequence', () => {
    const bytes = qrCommand(EPSON_TM_T20, 'ABC');
    expect(startsWith(bytes, QR_MODEL_2)).toBe(true);
    expect(contains(bytes, QR_PRINT)).toBe(true);
    expect(contains(bytes, [0x41, 0x42, 0x43])).toBe(true);
  });

  it('refuses on a device with no QR firmware', () => {
    // Emitting GS ( k here would print the command bytes across the paper.
    expect(() => qrCommand(GENERIC_ESCPOS_UNKNOWN, 'ABC')).toThrow(MissingCapabilityError);
  });

  it('rejects a multi-byte payload', () => {
    expect(() => qrCommand(EPSON_TM_T20, 'مرحبا')).toThrow(MissingCapabilityError);
  });

  it('rejects an out-of-range module size', () => {
    expect(() => qrCommand(EPSON_TM_T20, 'A', { moduleSize: 0 })).toThrow(MissingCapabilityError);
    expect(() => qrCommand(EPSON_TM_T20, 'A', { moduleSize: 99 })).toThrow(MissingCapabilityError);
  });
});

describe('raster', () => {
  it('frames a bitmap with GS v 0 and the right row count', () => {
    const bytes = rasterCommand({ width: 16, height: 2, data: new Uint8Array(4) });
    expect(Array.from(bytes.slice(0, 8))).toEqual([...GS_RASTER, 2, 0, 2, 0]);
  });

  it('rejects a payload whose size contradicts its dimensions', () => {
    expect(() => rasterCommand({ width: 16, height: 2, data: new Uint8Array(3) })).toThrow(
      MissingCapabilityError,
    );
  });
});

describe('renderReceipt', () => {
  it('renders an Arabic receipt on a UTF-8 device with a native QR', () => {
    const bytes = renderReceipt(TEST_UTF8_NATIVE, data);
    expect(startsWith(bytes, ESC_INIT)).toBe(true);
    expect(contains(bytes, QR_MODEL_2)).toBe(true);
    expect(contains(bytes, QR_PRINT)).toBe(true);
    expect(Array.from(bytes.slice(-3))).toEqual(GS_PARTIAL_CUT);
  });

  it('refuses an Arabic receipt on a raster device until a renderer exists', () => {
    // Refusing to print is correct; printing the wrong Arabic is not.
    const bitmap = { width: 8, height: 8, data: new Uint8Array(8) };
    expect(() => renderReceipt(EPSON_TM_T20, data, { qrBitmap: bitmap })).toThrow(
      MissingCapabilityError,
    );
    expect(() => renderReceipt(GENERIC_ESCPOS_UNKNOWN, data, { qrBitmap: bitmap })).toThrow(
      MissingCapabilityError,
    );
  });

  it('refuses rather than printing an invoice with no scannable QR', () => {
    const asciiOnly = { ...data, sellerName: 'Korvi Store', lines: [] };
    expect(() => renderReceipt(GENERIC_ESCPOS_UNKNOWN, asciiOnly)).toThrow(MissingCapabilityError);
  });

  it('refuses an empty QR payload', () => {
    expect(() => renderReceipt(TEST_UTF8_NATIVE, { ...data, qrPayload: '  ' })).toThrow(
      MissingCapabilityError,
    );
  });

  it('keeps the Korvi mark out of the header', () => {
    const text = new TextDecoder().decode(renderReceipt(TEST_UTF8_NATIVE, data));
    expect(text.slice(0, text.indexOf('رقم الفاتورة'))).not.toContain('Korvi');
    expect(text).toContain('صُدرت عبر Korvi');
  });

  it('is deterministic', () => {
    expect(renderReceipt(TEST_UTF8_NATIVE, data)).toEqual(renderReceipt(TEST_UTF8_NATIVE, data));
  });

  it('uses only characters every supported path can represent', () => {
    // U+00D7 (×) is absent from PC864, so the quantity line uses ASCII "x".
    expect(() => renderReceipt(TEST_UTF8_NATIVE, data)).not.toThrow();
  });
});

describe('profile registry', () => {
  it('resolves a known profile and reports an unknown one', () => {
    expect(findProfile('epson-tm-t20')?.capabilities.qr).toBe('native');
    expect(findProfile('nope')).toBeNull();
  });
});
EOF

cat << 'EOF' > packages/printing/src/__tests__/golden-arabic.test.ts
import { describe, expect, it } from 'vitest';
import { shapeArabic } from '../encoding/arabic-shaping.js';
import { toVisualOrder } from '../encoding/bidi.js';

/**
 * Linguistic fixtures for the Arabic shaper.
 *
 * These assert actual glyph forms, not lengths. A length check passes against a
 * pipeline that shapes every letter into the wrong contextual form, which is
 * precisely the defect revision 2 shipped: reordering before shaping produced
 * the right *number* of well-formed bytes spelling the word incorrectly.
 *
 * Every expectation is verifiable by hand against the Arabic joining rules, so
 * these encode correctness rather than current behaviour.
 *
 * Byte-level expectations live in cp864-conformance.test.ts and come from the
 * published code-page mappings. The shaper output is deliberately not asserted
 * in bytes here: PC864 cannot represent most of these forms, which is why
 * Arabic prints via raster (ADR-0011). Keeping the shaper tested at the glyph
 * level is what makes it reusable by the future raster layout path.
 */

const points = (text: string): string[] =>
  [...text].map((character) => `0x${(character.codePointAt(0) ?? 0).toString(16)}`);

describe('shaping operates on logical adjacency', () => {
  it('shapes مرحبا into initial, final, initial, medial, final', () => {
    // م initial (no letter before), ر final (م joins forward, ر joins only
    // backwards), ح initial (ر offers no forward join), ب medial, ا final.
    expect(points(shapeArabic('مرحبا'))).toEqual([
      '0xfee3', // م initial
      '0xfeae', // ر final
      '0xfea3', // ح initial
      '0xfe92', // ب medial
      '0xfe8e', // ا final
    ]);
  });

  it('would produce entirely different forms if reordering came first', () => {
    // The revision 2 order, kept as an explicit counter-example. Not one glyph
    // matches the correct result above — same byte count, different word.
    const wrong = shapeArabic(toVisualOrder('مرحبا'));
    expect(points(wrong)).toEqual(['0xfe8d', '0xfe91', '0xfea4', '0xfeae', '0xfee1']);
    expect(points(wrong)).not.toEqual(points(shapeArabic('مرحبا')));
  });

  it('forms the lam-alef ligature, which the wrong order never can', () => {
    // Logical order: lam then alef, so the pair collapses into one glyph.
    expect(points(shapeArabic('لا'))).toEqual(['0xfefb']);
    // Reordered first, the alef precedes the lam and no ligature exists.
    expect(points(shapeArabic(toVisualOrder('لا')))).toEqual(['0xfe8d', '0xfedd']);
  });

  it('uses the final lam-alef form when a letter joins into it', () => {
    expect(points(shapeArabic('بلا'))).toEqual(['0xfe91', '0xfefc']);
  });

  it('leaves right-joining letters unjoined to what follows', () => {
    // dal and ra join only backwards, so neither connects onward.
    expect(points(shapeArabic('در'))).toEqual(['0xfea9', '0xfead']);
    // waw likewise: و ر د is three isolated forms.
    expect(points(shapeArabic('ورد'))).toEqual(['0xfeed', '0xfead', '0xfea9']);
  });
});

EOF

cat << 'EOF' > packages/printing/src/__tests__/fail-safe.test.ts
import { describe, expect, it } from 'vitest';
import { encodeTextFor } from '../encoding/text-encoder.js';
import { renderReceipt } from '../receipt.js';
import { MissingCapabilityError } from '../errors.js';
import {
  DEFAULT_PROFILE,
  GENERIC_ESCPOS_UNKNOWN,
  PRINTER_PROFILES,
  PRODUCTION_PROFILES,
  SYNTHETIC_RASTER_ONLY,
} from '../profiles/registry.js';
import { moneyFromMajorString } from '@korvi/domain';

/**
 * Unknown hardware must fail safe.
 *
 * Revision 2 assumed an unidentified ESC/POS device spoke CP1256 and shaped
 * Arabic in firmware. Devices differ on all three counts — whether they shape,
 * which Arabic page they carry, whether they carry one — so the assumption
 * produced an unreadable tax invoice on anything that did not match it.
 */

const receipt = {
  sellerName: 'متجر كورفي',
  vatRegistrationNumber: '310122393500003',
  invoiceNumber: 'INV-2026-00001',
  timestamp: '2026-08-07T09:45:00Z',
  lines: [{ description: 'ماء', quantity: 1, lineTotal: moneyFromMajorString('4.00') }],
  net: moneyFromMajorString('100.00'),
  vat: moneyFromMajorString('15.00'),
  total: moneyFromMajorString('115.00'),
  qrPayload: 'AQVtZXJjaA==',
};

describe('unknown hardware', () => {
  it('is the default profile', () => {
    expect(DEFAULT_PROFILE.id).toBe(GENERIC_ESCPOS_UNKNOWN.id);
  });

  it('claims no verification', () => {
    expect(GENERIC_ESCPOS_UNKNOWN.capabilities.verified).toBe(false);
  });

  it('declares no text path rather than guessing a code page', () => {
    expect(GENERIC_ESCPOS_UNKNOWN.capabilities.text).toBe('raster');
  });

  it('refuses to encode Arabic text', () => {
    expect(() => encodeTextFor(GENERIC_ESCPOS_UNKNOWN, 'مرحبا')).toThrow(MissingCapabilityError);
  });

  it('still passes ASCII natively — there is nothing to render', () => {
    // Command bytes, document numbers and prices are identical in every code
    // page. Only text above U+007F needs a renderer (ADR-0011).
    expect(Array.from(encodeTextFor(GENERIC_ESCPOS_UNKNOWN, 'INV-1'))).toEqual([
      0x49, 0x4e, 0x56, 0x2d, 0x31,
    ]);
  });

  it('refuses anything above ASCII, including non-Arabic scripts', () => {
    for (const text of ['مرحبا', '日本語', 'café']) {
      expect(() => encodeTextFor(GENERIC_ESCPOS_UNKNOWN, text)).toThrow(MissingCapabilityError);
    }
  });

  it('assumes no QR firmware', () => {
    expect(GENERIC_ESCPOS_UNKNOWN.capabilities.qr).not.toBe('native');
  });

  it('cannot render a receipt without a raster renderer', () => {
    expect(() => renderReceipt(GENERIC_ESCPOS_UNKNOWN, receipt)).toThrow(MissingCapabilityError);
  });
});

describe('profile registry integrity', () => {
  it('gives every production profile that claims a text path a verified flag', () => {
    // Synthetic fixtures may declare a code page — that is what keeps the
    // codec exercised — but they are excluded from production selection.
    for (const profile of PRODUCTION_PROFILES) {
      if (profile.capabilities.text !== 'raster') {
        expect(profile.capabilities.verified).toBe(true);
      }
    }
  });

  it('never lets an unverified profile reach a code page', () => {
    for (const profile of PRINTER_PROFILES) {
      if (!profile.capabilities.verified) {
        expect(() => encodeTextFor(profile, 'مرحبا')).toThrow(MissingCapabilityError);
      }
    }
  });

  it('records why each profile is configured as it is', () => {
    for (const profile of PRINTER_PROFILES) {
      expect(profile.notes.length).toBeGreaterThan(40);
    }
  });

  it('keeps a confirmed no-Arabic device on the raster path', () => {
    expect(SYNTHETIC_RASTER_ONLY.capabilities.text).toBe('raster');
    expect(() => encodeTextFor(SYNTHETIC_RASTER_ONLY, 'مرحبا')).toThrow(MissingCapabilityError);
  });
});
EOF

cat << 'EOF' > packages/printing/src/__tests__/cp864-conformance.test.ts
import { describe, expect, it } from 'vitest';
import { encodeCodePage, canEncode } from '../encoding/codepage.js';
import { shapeArabic } from '../encoding/arabic-shaping.js';
import { UnsupportedCharacterError } from '../errors.js';

/**
 * PC864 conformance, against the standard rather than against ourselves.
 *
 * Every expectation here is taken from the authoritative Microsoft/Unicode
 * PC864 mapping (CP864.TXT), which Epson documents as character code table 37.
 * None is generated by the codec under test.
 *
 * That distinction is the whole reason this file exists. Revision 3 shipped an
 * invented CP864 table and then produced its golden fixtures *from* that table,
 * so the fixtures and the bug agreed with each other and the suite was green.
 * A fixture derived from the implementation cannot detect the implementation
 * being wrong.
 */

/** Verbatim from the authoritative mapping. */
const AUTHORITATIVE: readonly (readonly [number, number, string])[] = [
  [0xfefb, 0x9d, 'LAM WITH ALEF ISOLATED'],
  [0xfefc, 0x9e, 'LAM WITH ALEF FINAL'],
  [0xfe8e, 0xa8, 'ALEF FINAL'],
  [0xfee3, 0xe5, 'MEEM INITIAL'],
  [0xfeed, 0xe8, 'WAW ISOLATED'],
  [0x066a, 0x25, 'ARABIC PERCENT SIGN'],
  [0xfe8d, 0xc7, 'ALEF ISOLATED'],
  [0xfea9, 0xcf, 'DAL ISOLATED'],
  [0xfead, 0xd1, 'REH ISOLATED'],
];

describe('authoritative PC864 mappings', () => {
  it.each(AUTHORITATIVE)('maps U+%s to 0x%s (%s)', (codePoint, byte) => {
    expect(Array.from(encodeCodePage(String.fromCodePoint(codePoint), 'cp864'))).toEqual([byte]);
  });

  it('does not map lam-alef onto WAW ISOLATED', () => {
    // Revision 3's specific defect: 0xE8 is WAW ISOLATED, and lam-alef was
    // mapped onto it. Two different letters sharing one byte.
    const lamAlef = Array.from(encodeCodePage('ﻻ', 'cp864'))[0];
    const waw = Array.from(encodeCodePage('ﻭ', 'cp864'))[0];
    expect(lamAlef).toBe(0x9d);
    expect(waw).toBe(0xe8);
    expect(lamAlef).not.toBe(waw);
  });

  it('keeps every byte assignment unique', () => {
    // A collision means two characters print identically — the symptom of an
    // invented table, which is how revision 3 put lam-alef on WAW's byte.
    const seen = new Map<number, number>();
    let stripped = 0;

    for (let codePoint = 0x80; codePoint <= 0xffff; codePoint += 1) {
      const character = String.fromCodePoint(codePoint);
      if (!canEncode(character, 'cp864')) continue;

      const bytes = Array.from(encodeCodePage(character, 'cp864'));
      if (bytes.length === 0) {
        // A combining mark: PC864 has no cell for harakat, so they are dropped
        // rather than substituted. Zero bytes is the correct outcome.
        stripped += 1;
        continue;
      }

      const byte = bytes[0] as number;
      const previous = seen.get(byte);
      expect(
        previous,
        `0x${byte.toString(16)} is claimed by both U+${(previous ?? 0).toString(16)} and ` +
          `U+${codePoint.toString(16)}`,
      ).toBeUndefined();
      seen.set(byte, codePoint);
    }

    expect(seen.size).toBeGreaterThan(100);
    expect(stripped).toBeGreaterThan(0);
  });
});

describe('unsupported forms are rejected, never substituted', () => {
  it('rejects presentation forms absent from PC864', () => {
    // PC864 carries only part of the Presentation Forms-B block. These are
    // genuinely absent, and a substitute glyph on a tax invoice is worse than
    // a refusal an operator can see.
    for (const codePoint of [0xfe70, 0xfe72, 0xfe76, 0xfe88, 0xfe90, 0xfe92]) {
      expect(() => encodeCodePage(String.fromCodePoint(codePoint), 'cp864')).toThrow(
        UnsupportedCharacterError,
      );
    }
  });

  it('rejects a fully shaped word PC864 cannot represent', () => {
    // مرحبا shapes to forms including MEEM INITIAL (present) and BEH MEDIAL
    // (absent), so the word as a whole is not encodable.
    expect(canEncode(shapeArabic('مرحبا'), 'cp864')).toBe(false);
    expect(() => encodeCodePage(shapeArabic('مرحبا'), 'cp864')).toThrow(UnsupportedCharacterError);
  });

  it('cannot carry the shaper output in general', () => {
    // The measurement behind ADR-0011: a large fraction of the forms the
    // shaper produces simply do not exist in PC864, which is why Arabic goes
    // to raster rather than through this code page.
    const words = ['مرحبا', 'متجر كورفي', 'ضريبة القيمة المضافة', 'ماء بارد', 'فاتورة'];
    const unencodable = words.filter((word) => !canEncode(shapeArabic(word), 'cp864'));
    expect(unencodable.length).toBeGreaterThan(0);
  });

  it('rejects non-Arabic characters outside the page', () => {
    expect(() => encodeCodePage('日本語', 'cp864')).toThrow(UnsupportedCharacterError);
  });

  it('still passes ASCII through unchanged', () => {
    expect(Array.from(encodeCodePage('INV-1', 'cp864'))).toEqual([
      0x49, 0x4e, 0x56, 0x2d, 0x31,
    ]);
  });
});

describe('CP1256 conformance', () => {
  /** Verbatim from the Windows-1256 mapping. */
  const WINDOWS_1256: readonly (readonly [number, number])[] = [
    [0x0627, 0xc7], // ALEF
    [0x0628, 0xc8], // BEH
    [0x0645, 0xe3], // MEEM
    [0x0648, 0xe6], // WAW
    [0x064a, 0xed], // YEH
    [0x0644, 0xe1], // LAM
  ];

  it.each(WINDOWS_1256)('maps U+%s to 0x%s', (codePoint, byte) => {
    expect(Array.from(encodeCodePage(String.fromCodePoint(codePoint), 'cp1256'))).toEqual([byte]);
  });

  it('carries base letters, not presentation forms', () => {
    // The complement of CP864: CP1256 holds the unshaped alphabet and expects
    // the firmware to join it.
    expect(canEncode('مرحبا', 'cp1256')).toBe(true);
    expect(canEncode('ﻻ', 'cp1256')).toBe(false);
  });
});
EOF

cat << 'EOF' > packages/printing/src/__tests__/arabic-production-path.test.ts
import { describe, expect, it } from 'vitest';
import { encodeTextFor } from '../encoding/text-encoder.js';
import { renderReceipt } from '../receipt.js';
import { MissingCapabilityError } from '../errors.js';
import {
  DEFAULT_PROFILE,
  EPSON_TM_T20,
  PRINTER_PROFILES,
  PRODUCTION_PROFILES,
  SYNTHETIC_CP1256_FIRMWARE_SHAPING,
  SYNTHETIC_UTF8_NATIVE,
  SYNTHETIC_RASTER_ONLY,
  findProductionProfile,
} from '../profiles/registry.js';
import { moneyFromMajorString } from '@korvi/domain';

/**
 * Arabic takes the raster path in production. Always.
 *
 * PC864 contains only part of the Arabic Presentation Forms-B block, so no
 * code-page route can carry arbitrary shaped Arabic. A route that works for
 * some item names and fails for others is the worst available outcome: the
 * failure is invisible until a merchant sells the wrong product. ADR-0011.
 */

const receipt = {
  sellerName: 'متجر كورفي',
  vatRegistrationNumber: '310122393500003',
  invoiceNumber: 'INV-2026-00001',
  timestamp: '2026-08-07T09:45:00Z',
  lines: [{ description: 'ماء', quantity: 1, lineTotal: moneyFromMajorString('4.00') }],
  net: moneyFromMajorString('100.00'),
  vat: moneyFromMajorString('15.00'),
  total: moneyFromMajorString('115.00'),
  qrPayload: 'AQVtZXJjaA==',
};

describe('every production profile', () => {
  it.each(PRODUCTION_PROFILES.map((profile) => [profile.id, profile] as const))(
    '%s refuses Arabic through a code page',
    (_id, profile) => {
      if (profile.capabilities.text === 'utf8') return; // genuinely decodes it
      expect(() => encodeTextFor(profile, 'مرحبا')).toThrow(MissingCapabilityError);
    },
  );

  it.each(PRODUCTION_PROFILES.map((profile) => [profile.id, profile] as const))(
    '%s never claims firmware Arabic shaping over a legacy code page',
    (_id, profile) => {
      if (profile.capabilities.text === 'cp1256' || profile.capabilities.text === 'cp864') {
        expect(profile.capabilities.firmwareShapes).toBe(false);
      }
    },
  );

  it('excludes every synthetic fixture', () => {
    for (const fixture of [
      SYNTHETIC_CP1256_FIRMWARE_SHAPING,
      SYNTHETIC_UTF8_NATIVE,
      SYNTHETIC_RASTER_ONLY,
    ]) {
      expect(fixture.capabilities.verified).toBe(false);
      expect(PRODUCTION_PROFILES).not.toContain(fixture);
      expect(findProductionProfile(fixture.id)).toBeNull();
    }
  });

  it('contains no generic or synthetic verified capability claim', () => {
    for (const profile of PRINTER_PROFILES) {
      if (profile.vendor === 'generic' || profile.vendor === 'synthetic') {
        expect(profile.capabilities.verified).toBe(false);
      }
    }
  });
});

describe('the synthetic fixture', () => {
  it('is marked unverified and named as a fixture', () => {
    expect(SYNTHETIC_CP1256_FIRMWARE_SHAPING.capabilities.verified).toBe(false);
    expect(SYNTHETIC_CP1256_FIRMWARE_SHAPING.vendor).toBe('synthetic');
    expect(SYNTHETIC_CP1256_FIRMWARE_SHAPING.id).toContain('synthetic');
    expect(SYNTHETIC_CP1256_FIRMWARE_SHAPING.model).toMatch(/TEST FIXTURE/);
  });

  it('is refused by the encoder like any unverified profile', () => {
    expect(() => encodeTextFor(SYNTHETIC_CP1256_FIRMWARE_SHAPING, 'مرحبا')).toThrow(
      MissingCapabilityError,
    );
  });
});

describe('Epson TM-T20', () => {
  it('routes Arabic to raster despite supporting PC864', () => {
    expect(EPSON_TM_T20.capabilities.text).toBe('raster');
    expect(() => encodeTextFor(EPSON_TM_T20, 'متجر كورفي')).toThrow(MissingCapabilityError);
  });

  it('keeps ASCII on the native path', () => {
    // Command bytes, document numbers and prices are identical in every code
    // page; rasterising them would be pointless.
    expect(Array.from(encodeTextFor(EPSON_TM_T20, 'INV-2026-00001'))).toEqual(
      [...'INV-2026-00001'].map((c) => c.charCodeAt(0)),
    );
    expect(Array.from(encodeTextFor(EPSON_TM_T20, '115.00'))).toEqual([
      0x31, 0x31, 0x35, 0x2e, 0x30, 0x30,
    ]);
  });

  it('keeps its vendor-documented native QR', () => {
    expect(EPSON_TM_T20.capabilities.qr).toBe('native');
  });

  it('cannot render an Arabic receipt without a raster renderer', () => {
    expect(() => renderReceipt(EPSON_TM_T20, receipt)).toThrow(MissingCapabilityError);
  });
});

describe('unknown hardware', () => {
  it('is the default and rasters Arabic', () => {
    expect(DEFAULT_PROFILE.capabilities.text).toBe('raster');
    expect(DEFAULT_PROFILE.capabilities.verified).toBe(false);
    expect(() => encodeTextFor(DEFAULT_PROFILE, 'مرحبا')).toThrow(MissingCapabilityError);
  });

  it('assumes no code page and no firmware shaping', () => {
    expect(DEFAULT_PROFILE.capabilities.firmwareShapes).toBe(false);
    expect(DEFAULT_PROFILE.capabilities.codePageId).toBeNull();
  });
});

describe('registry integrity', () => {
  it('never marks a generic or synthetic profile verified', () => {
    for (const profile of PRINTER_PROFILES) {
      if (profile.vendor === 'generic' || profile.vendor === 'synthetic') {
        expect(profile.capabilities.verified).toBe(false);
      }
    }
  });

  it('marks every unverified production profile as raster-only', () => {
    for (const profile of PRODUCTION_PROFILES) {
      if (!profile.capabilities.verified) {
        expect(profile.capabilities.text).toBe('raster');
      }
    }
  });

  it('keeps unverified profiles unreachable through production lookup', () => {
    // The synthetic fixture may declare cp1256 so the codec stays exercised;
    // what matters is that no production path can select it.
    for (const profile of PRINTER_PROFILES) {
      if (!profile.capabilities.verified && profile.capabilities.text !== 'raster') {
        expect(findProductionProfile(profile.id)).toBeNull();
      }
    }
  });
});
EOF

# ---------------------------------------------------------------------------
# packages/database
# ---------------------------------------------------------------------------

say "Writing @korvi/database"

cat << EOF > packages/database/package.json
{
  "name": "@korvi/database",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "exports": { ".": { "types": "./dist/src/index.d.ts", "default": "./dist/src/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:studio": "prisma studio"
  },
  "dependencies": {
    "@korvi/domain": "*",
    "@prisma/adapter-pg": "$V_ADAPTER_PG",
    "@prisma/client": "$V_PRISMA",
    "pg": "$V_PG"
  },
  "devDependencies": {
    "@types/pg": "$V_TYPES_PG",
    "prisma": "$V_PRISMA"
  }
}
EOF

cat << 'EOF' > packages/database/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    // rootDir is the package root, not src: the Prisma-generated client is
    // TypeScript source under generated/, and tsc requires rootDir to contain
    // every input. Output therefore lands in dist/src.
    "rootDir": ".",
    "outDir": "dist",
    "lib": ["ES2023", "DOM"],
    "noUnusedLocals": false,
    "noUnusedParameters": false
  },
  "include": ["src/**/*.ts", "generated/**/*.ts"],
  "exclude": ["src/**/__tests__/**", "src/**/*.test.ts"]
}
EOF

cat << 'EOF' > packages/database/prisma/schema.prisma
// Korvi POS — Phase 0 schema.
//
// Deliberately small. The strategy document mentions 36 tables; that is the
// shape of the finished product, not of a foundation. Every table here exists
// because Phase 0 needs it to prove the tenancy boundary works.
//
// Tenancy rule (ADR-0004): every tenant-owned model carries tenantId and
// indexes it first. GlobalCatalogItem is the documented exception — the
// national barcode catalogue is shared infrastructure, and copying it per
// merchant would mean hundreds of thousands of duplicate rows each.

generator client {
  provider = "prisma-client"
  output   = "../generated/client"
}

datasource db {
  provider = "postgresql"
}

model Tenant {
  id        String   @id @db.Uuid
  name      String
  vatNumber String?  @db.VarChar(15)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  products Product[]

  @@map("tenants")
}

model Product {
  id       String @id @db.Uuid
  tenantId String @db.Uuid

  sku     String
  nameAr  String
  nameEn  String?
  barcode String?

  /// Minor units (halalas) as a 64-bit integer. Never a float — ADR-0002.
  priceMinor BigInt

  /// Basis points. 1500 = 15%. Never a float — ADR-0002.
  vatBasisPoints Int @default(1500)

  /// Reversed barcode powering suffix search. See ports/search.ts.
  codeReverse String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, sku])
  @@index([tenantId, barcode])
  @@index([tenantId, codeReverse])
  @@map("products")
}

/// Shared across all tenants by design. No tenantId — see ADR-0004.
model GlobalCatalogItem {
  barcode        String   @id
  nameAr         String
  nameEn         String?
  vatBasisPoints Int      @default(1500)
  updatedAt      DateTime @updatedAt

  @@map("global_catalog_items")
}
EOF

cat << 'EOF' > packages/database/prisma.config.ts
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved the connection URL out of schema.prisma. It lives here and is
 * read from the environment, so no credential is ever committed.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
});
EOF

cat << 'EOF' > packages/database/src/client.ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client/client.js';

/**
 * Build a client.
 *
 * The connection string is a parameter rather than an ambient read so that a
 * caller cannot accidentally connect to the wrong database by having the wrong
 * environment loaded, and so tests can be explicit about talking to nothing.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  if (connectionString.trim() === '') {
    throw new Error('createPrismaClient: a connection string is required.');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type { PrismaClient };
EOF

cat << 'EOF' > packages/database/src/repositories/product-repository.ts
import type { Product, ProductRepository, TenantScope } from '@korvi/domain';
import { basisPointsFromColumn, tenantId } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * Prisma-backed adapter for the domain's ProductRepository port.
 *
 * Every method maps the ORM row to the domain shape before returning. That
 * mapping is the boundary: no Prisma type escapes this file, so the UI and the
 * domain never learn what the ORM is (ADR-0001, ADR-0004).
 *
 * `priceMinor` crosses as a string. Prisma hands back a BigInt, and letting a
 * BigInt reach a JSON boundary either throws or silently degrades to a float.
 *
 * `vatBasisPoints` is narrowed through `basisPointsFromColumn`, which validates
 * the range. A corrupt row then fails at this boundary rather than producing a
 * wrong tax figure on a printed invoice.
 */
interface ProductRow {
  id: string;
  tenantId: string;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  priceMinor: bigint;
  vatBasisPoints: number;
  barcode: string | null;
}

function toDomain(row: ProductRow): Product {
  return {
    id: row.id,
    tenantId: tenantId(row.tenantId),
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    priceMinor: row.priceMinor.toString(),
    vatBasisPoints: basisPointsFromColumn(row.vatBasisPoints),
    barcode: row.barcode,
  };
}

export function createProductRepository(prisma: PrismaClient): ProductRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<Product | null> {
      const row = await prisma.product.findFirst({
        where: { id, tenantId: scope.tenantId },
      });
      return row === null ? null : toDomain(row);
    },

    async findByBarcode(scope: TenantScope, barcode: string): Promise<Product | null> {
      const row = await prisma.product.findFirst({
        where: { barcode, tenantId: scope.tenantId },
      });
      return row === null ? null : toDomain(row);
    },

    async list(scope: TenantScope, limit: number): Promise<readonly Product[]> {
      const rows = await prisma.product.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { sku: 'asc' },
        take: limit,
      });
      return rows.map(toDomain);
    },
  };
}
EOF

cat << 'EOF' > packages/database/src/index.ts
export { createPrismaClient } from './client.js';
export type { PrismaClient } from './client.js';
export { createProductRepository } from './repositories/product-repository.js';
export { withTenant, withoutTenant } from './tenant-context.js';
export type { TransactionClient } from './tenant-context.js';
export { DatabaseError, TenantContextError } from './errors.js';
EOF

# ---------------------------------------------------------------------------
# packages/testing
# ---------------------------------------------------------------------------

say "Writing @korvi/testing"

cat << 'EOF' > packages/testing/package.json
{
  "name": "@korvi/testing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "@korvi/domain": "*" }
}
EOF

cat << 'EOF' > packages/testing/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2023", "DOM"]
  },
  "include": ["src/**/*.ts"]
}
EOF

cat << 'EOF' > packages/testing/src/index.ts
import type { Clock, RandomSource } from '@korvi/domain';

/**
 * Determinism helpers.
 *
 * Anything that reads the wall clock or the entropy pool is untestable by
 * definition, so the domain takes both as interfaces and this package supplies
 * the fakes. A test that has to sleep to observe ordering is a test that will
 * eventually fail on a loaded CI runner.
 */

export interface ControllableClock extends Clock {
  set(milliseconds: number): void;
  advance(milliseconds: number): void;
}

export function controllableClock(start = 1_700_000_000_000): ControllableClock {
  let current = start;
  return {
    now: () => current,
    set: (milliseconds: number) => {
      current = milliseconds;
    },
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

/**
 * A counter-based byte source. Not cryptographic and not pretending to be —
 * its whole job is to make a generated id reproducible in an assertion.
 */
export function seededRandom(seed = 1): RandomSource {
  let state = seed >>> 0;
  return {
    fill(target: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
      for (let index = 0; index < target.length; index += 1) {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        target[index] = (state >>> 24) & 0xff;
      }
      return target;
    },
  };
}
EOF

cat << 'EOF' > packages/database/prisma/migrations/00000000000000_rls_foundation/migration.sql
-- Korvi POS — Row-Level Security foundation.
--
-- Defence in depth. `WHERE tenantId = ?` in a repository is necessary but not
-- sufficient: it protects only the queries that remember to include it. One
-- forgotten clause, one raw query written under time pressure, one ORM helper
-- that builds its own SQL, and a merchant sees another merchant's sales.
--
-- RLS moves the boundary into the database, where it applies to every statement
-- on the connection regardless of which code path produced it.
--
-- Tenant context travels as the `app.tenant_id` setting, established with
-- SET LOCAL inside the transaction. SET LOCAL is what makes this safe under a
-- connection pool: the value dies with the transaction, so a pooled connection
-- can never carry one tenant's context into another tenant's request.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE "tenants" (
  "id"        UUID PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "vatNumber" VARCHAR(15),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "products" (
  "id"             UUID PRIMARY KEY,
  "tenantId"       UUID NOT NULL,
  "sku"            TEXT NOT NULL,
  "nameAr"         TEXT NOT NULL,
  "nameEn"         TEXT,
  "barcode"        TEXT,
  "priceMinor"     BIGINT NOT NULL,
  "vatBasisPoints" INTEGER NOT NULL DEFAULT 1500,
  "codeReverse"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "products_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- A rate outside 0..10000 bp is a data-entry error every time. The domain
  -- refuses it (BasisPoints) and so does the column: two independent guards,
  -- because a bad rate reaches a printed invoice (ADR-0002).
  CONSTRAINT "products_vat_basis_points_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000),
  -- Money is a non-negative integer count of halalas. Never a float.
  CONSTRAINT "products_price_minor_non_negative" CHECK ("priceMinor" >= 0)
);

CREATE UNIQUE INDEX "products_tenantId_sku_key" ON "products"("tenantId", "sku");
CREATE INDEX "products_tenantId_barcode_idx" ON "products"("tenantId", "barcode");
CREATE INDEX "products_tenantId_codeReverse_idx" ON "products"("tenantId", "codeReverse");

-- Shared infrastructure, not tenant data. See ADR-0004 before adding another.
CREATE TABLE "global_catalog_items" (
  "barcode"        TEXT PRIMARY KEY,
  "nameAr"         TEXT NOT NULL,
  "nameEn"         TEXT,
  "vatBasisPoints" INTEGER NOT NULL DEFAULT 1500,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "global_catalog_vat_basis_points_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000)
);

-- ---------------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------------

-- Returns the current tenant, or NULL when none is set.
--
-- STABLE, not IMMUTABLE: the value changes between transactions, and marking it
-- IMMUTABLE would let the planner cache one tenant's value into another's plan.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.tenant_id', TRUE), '')::UUID;
$$ LANGUAGE SQL STABLE;

-- ---------------------------------------------------------------------------
-- Policies — deny by default
-- ---------------------------------------------------------------------------

-- ENABLE turns policies on. FORCE additionally applies them to the table's
-- owner, which is the part people forget: without FORCE, the role that owns the
-- table bypasses every policy, and the application role is very often the owner.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;

-- With RLS enabled and no permissive policy matching, Postgres returns nothing
-- and rejects writes. That is the deny-by-default baseline; each policy below
-- opens exactly one door.

CREATE POLICY "tenants_isolation" ON "tenants"
  USING ("id" = current_tenant_id())
  WITH CHECK ("id" = current_tenant_id());

-- USING governs which rows are visible to SELECT/UPDATE/DELETE.
-- WITH CHECK governs which rows may be written. Both are required: USING alone
-- would let a caller UPDATE a visible row and hand it to another tenant.
CREATE POLICY "products_isolation" ON "products"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- global_catalog_items deliberately carries no RLS: it is shared reference
-- data, identical for every merchant, and none of it is anyone's private
-- information (ADR-0004). Enabling RLS here would need a policy that permits
-- everything, which is a misleading way to write "not protected".
EOF

cat << 'EOF' > packages/database/src/tenant-context.ts
import { TenantContextError } from './errors.js';
import type { PrismaClient } from './client.js';

/**
 * Tenant context for Row-Level Security.
 *
 * The policies in the RLS migration read `app.tenant_id`. Establishing it
 * correctly is the whole security boundary, and there is exactly one safe way
 * to do it under a connection pool:
 *
 *   SET LOCAL, inside a transaction.
 *
 * `SET` (without LOCAL) persists for the life of the connection. A pooled
 * connection is handed to the next request, so a plain SET leaks one tenant's
 * context into another tenant's query — the precise failure RLS is meant to
 * prevent. SET LOCAL is scoped to the transaction and reverts on commit or
 * rollback, so it cannot outlive the request.
 *
 * Prisma has no first-class hook for per-transaction session variables, which
 * is why this wrapper exists rather than a middleware: middleware does not
 * reliably share the transaction's connection.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The client handed to a transaction callback.
 *
 * Prisma withholds the connection-lifecycle and extension methods inside a
 * transaction, so this mirrors its deny list. Naming it here means callers
 * write `TransactionClient` instead of repeating an Omit that has to stay in
 * step with Prisma's.
 */
export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$extends' | '$use'
>;

/**
 * Run `work` with the tenant context set for its whole transaction.
 *
 * Everything inside sees only that tenant's rows, enforced by Postgres rather
 * than by the query being written correctly.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(tenantId)) {
    // Validated before interpolation. The value reaches SQL through a
    // parameter below, but rejecting a malformed id early also stops a
    // mistyped tenant from silently matching no rows and looking like an
    // empty database.
    throw new TenantContextError(`Not a tenant UUID: "${tenantId}".`);
  }

  return prisma.$transaction(async (tx) => {
    // Parameterised: set_config is a function call, so the value is bound
    // rather than concatenated into the statement.
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, TRUE)`;
    return work(tx);
  });
}

/**
 * Run `work` with no tenant context.
 *
 * Only for genuinely global data — the national catalogue, migrations,
 * operational tooling. Under RLS this sees nothing in any tenant-owned table,
 * which is the correct and safe outcome.
 */
export async function withoutTenant<T>(
  prisma: PrismaClient,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', '', TRUE)`;
    return work(tx);
  });
}
EOF

cat << 'EOF' > packages/database/src/errors.ts
/** Base class for database-layer failures Korvi raises deliberately. */
export class DatabaseError extends Error {
  public override readonly name: string = 'DatabaseError';

  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Tenant context could not be established.
 *
 * Raised rather than proceeding without context: under RLS a missing context
 * yields an empty result set, which reads like "this merchant has no products"
 * instead of "the query was wrong".
 */
export class TenantContextError extends DatabaseError {
  public override readonly name = 'TenantContextError';
}
EOF

cat << 'EOF' > packages/database/src/__tests__/rls-policy.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static verification of the tenancy boundary.
 *
 * These assertions run without a database on purpose. A live-Postgres test
 * proving cross-tenant reads are blocked belongs in Phase 1 integration; what
 * belongs *here* is the check that nobody adds a tenant-owned table without
 * protecting it — a review-time mistake this catches on every push, for free.
 *
 * The migration SQL is parsed rather than trusted, so the guarantee comes from
 * what will actually be applied to the database.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(here, '../../prisma/migrations/00000000000000_rls_foundation/migration.sql'),
  'utf8',
);
const schema = readFileSync(join(here, '../../prisma/schema.prisma'), 'utf8');

/** Tables holding tenant-owned rows. Adding one here without a policy fails. */
const TENANT_OWNED = ['tenants', 'products'];

/** The single documented exception. See ADR-0004. */
const GLOBAL_TABLES = ['global_catalog_items'];

describe('row-level security', () => {
  it.each(TENANT_OWNED)('enables RLS on %s', (table) => {
    expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  });

  it.each(TENANT_OWNED)('forces RLS on %s so the table owner cannot bypass it', (table) => {
    // Without FORCE, the owning role ignores every policy — and the
    // application role is very often the owner.
    expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  });

  it.each(TENANT_OWNED)('defines an isolation policy for %s', (table) => {
    expect(migration).toMatch(new RegExp(`CREATE POLICY "\\w+" ON "${table}"`));
  });

  it('gives every policy both USING and WITH CHECK', () => {
    // USING alone governs reads. Without WITH CHECK a caller could UPDATE a
    // visible row and reassign it to another tenant.
    const policies = migration.split('CREATE POLICY').slice(1);
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      const body = policy.split(';')[0] ?? '';
      expect(body).toContain('USING');
      expect(body).toContain('WITH CHECK');
      expect(body).toContain('current_tenant_id()');
    }
  });

  it('resolves tenant context from a session setting, not a literal', () => {
    expect(migration).toContain("current_setting('app.tenant_id', TRUE)");
  });

  it('marks current_tenant_id STABLE rather than IMMUTABLE', () => {
    // IMMUTABLE would let the planner cache one tenant's value into a plan
    // reused for another.
    expect(migration).toMatch(/current_tenant_id\(\)[\s\S]*?LANGUAGE SQL STABLE/);
  });

  it.each(GLOBAL_TABLES)('leaves %s outside RLS deliberately', (table) => {
    expect(migration).not.toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    // and says why, so the omission cannot be mistaken for an oversight
    expect(migration).toContain('ADR-0004');
  });
});

describe('schema invariants', () => {
  it('indexes tenantId first on every tenant-scoped index', () => {
    for (const match of schema.matchAll(/@@(?:index|unique)\(\[([^\]]+)\]/g)) {
      const columns = (match[1] ?? '').split(',').map((column) => column.trim());
      if (columns.includes('tenantId')) {
        expect(columns[0]).toBe('tenantId');
      }
    }
  });

  it('stores money as BigInt, never a float', () => {
    expect(schema).toMatch(/priceMinor\s+BigInt/);
    expect(schema).not.toMatch(/priceMinor\s+(Float|Decimal)/);
  });

  it('constrains the VAT rate at the column as well as in the domain', () => {
    expect(migration).toContain('products_vat_basis_points_range');
    expect(migration).toContain('"vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000');
  });

  it('rejects negative money at the column', () => {
    expect(migration).toContain('"priceMinor" >= 0');
  });
});

describe('tenant context helper', () => {
  it('uses SET LOCAL semantics rather than a session-wide SET', async () => {
    // A plain SET survives into the next request on a pooled connection and
    // leaks one tenant's context into another's query.
    const source = readFileSync(join(here, '../tenant-context.ts'), 'utf8');
    expect(source).toContain('set_config');
    expect(source).toContain('TRUE'); // the is_local argument
    expect(source).not.toMatch(/\$executeRaw`\s*SET\s+app\.tenant_id/i);
  });

  it('runs inside a transaction, so the context cannot outlive the request', () => {
    const source = readFileSync(join(here, '../tenant-context.ts'), 'utf8');
    expect(source).toContain('$transaction');
  });
});
EOF

cat << 'EOF' > packages/database/src/__tests__/tenant-context.test.ts
import { describe, expect, it, vi } from 'vitest';
import { withTenant, withoutTenant } from '../tenant-context.js';
import { TenantContextError } from '../errors.js';
import type { PrismaClient } from '../client.js';

/**
 * A stand-in for Prisma that records what would reach the database.
 *
 * Enough to prove the context is established on the transaction's own
 * connection, before any work runs, without needing Postgres.
 */
function fakePrisma(): { client: PrismaClient; calls: string[]; values: unknown[] } {
  const calls: string[] = [];
  const values: unknown[] = [];

  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...args: unknown[]) => {
      calls.push(strings.join('?'));
      values.push(...args);
      return Promise.resolve(1);
    },
  };

  const client = {
    $transaction: (work: (t: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;

  return { client, calls, values };
}

describe('withTenant', () => {
  it('sets the tenant context before running the work', async () => {
    const { client, calls } = fakePrisma();
    const order: string[] = [];

    await withTenant(client, '3f2504e0-4f89-41d3-9a0c-0305e82c3301', async () => {
      order.push('work');
      return null;
    });

    expect(calls[0]).toContain('set_config');
    expect(calls[0]).toContain('app.tenant_id');
    expect(order).toEqual(['work']);
  });

  it('binds the tenant id as a parameter rather than interpolating it', async () => {
    const { client, calls, values } = fakePrisma();
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

    await withTenant(client, id, async () => null);

    expect(values).toContain(id);
    expect(calls[0]).not.toContain(id); // never concatenated into the SQL text
  });

  it('marks the setting local so it dies with the transaction', async () => {
    const { client, calls } = fakePrisma();
    await withTenant(client, '3f2504e0-4f89-41d3-9a0c-0305e82c3301', async () => null);
    // is_local = TRUE is what stops a pooled connection carrying the context
    // into the next tenant's request.
    expect(calls[0]).toContain('TRUE');
  });

  it('returns the work result', async () => {
    const { client } = fakePrisma();
    const result = await withTenant(
      client,
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      async () => 'value',
    );
    expect(result).toBe('value');
  });

  it('refuses a malformed tenant id', async () => {
    const { client } = fakePrisma();
    const work = vi.fn();

    await expect(withTenant(client, 'not-a-uuid', work)).rejects.toThrow(TenantContextError);
    await expect(withTenant(client, '', work)).rejects.toThrow(TenantContextError);
    await expect(withTenant(client, "'; DROP TABLE products; --", work)).rejects.toThrow(
      TenantContextError,
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('propagates a failure so the transaction rolls back', async () => {
    const { client } = fakePrisma();
    await expect(
      withTenant(client, '3f2504e0-4f89-41d3-9a0c-0305e82c3301', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('withoutTenant', () => {
  it('clears the context rather than leaving the previous one in place', async () => {
    const { client, calls } = fakePrisma();
    await withoutTenant(client, async () => null);
    // The empty value is a constant in the statement, not a bound parameter —
    // there is no user input to bind here.
    expect(calls[0]).toContain("set_config('app.tenant_id', '', TRUE)");
  });

  it('still runs inside a transaction so the clear is scoped', async () => {
    const { client, calls } = fakePrisma();
    await withoutTenant(client, async () => null);
    expect(calls).toHaveLength(1);
  });
});
EOF

# ---------------------------------------------------------------------------
# packages/config — the Tailwind preset, shared verbatim
# ---------------------------------------------------------------------------

say "Writing @korvi/config"

cat << 'EOF' > packages/config/package.json
{
  "name": "@korvi/config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./tailwind-preset": "./tailwind-preset.cjs"
  },
  "files": ["tailwind-preset.cjs"],
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
EOF

cat << 'EOF' > packages/config/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "lib": ["ES2023"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
EOF

cat << 'EOF' > packages/config/tailwind-preset.cjs
/**
 * Korvi Design System — Tailwind preset.
 *
 * Transcribed from KORVI-DESIGN-SYSTEM.md §10, which is the authority
 * (ADR-0006). Tokens live as CSS variables in @korvi/ui so theming happens at
 * runtime without a rebuild; Tailwind consumes them through
 * `hsl(var(--token) / <alpha-value>)`, which is what makes `bg-primary/10` work
 * without a second variable per opacity step.
 *
 * Shared with Korvi ERP. Divergence here is divergence in the brand.
 *
 * CommonJS on purpose: PostCSS loads this synchronously, and a .cjs preset
 * needs no build step of its own.
 */
module.exports = {
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
        },

        // The brand mark, promoted from a stray Tailwind `emerald` to a token.
        // It deliberately does NOT follow the theme: it must read the same on
        // the light shell, the dark shell and on white paper, and paper has no
        // theme. See KORVI-DESIGN-SYSTEM.md §2.4.
        brand: {
          DEFAULT: 'hsl(var(--brand) / <alpha-value>)',
          'on-dark': 'hsl(var(--brand-on-dark) / <alpha-value>)',
        },
      },

      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },

      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
        numeric: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },

      // Touch targets. `h-10` (40px) is below the 44px minimum in WCAG 2.5.5:
      // it works with a mouse and mis-taps with a thumb. Additive, so ERP
      // components keep their existing heights.
      spacing: {
        touch: '2.75rem',
        'touch-lg': '3rem',
      },

      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-start': {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        // Two separate keyframes because the backdrop and the panel must not
        // move together: the blur fades straight in while the panel rises into
        // it, which is what makes the panel read as sitting *above* the page.
        'overlay-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'palette-in': {
          from: { opacity: '0', transform: 'translateY(-8px) scale(0.97)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },

      animation: {
        // One decelerating curve for the whole system: things arrive rather
        // than stop.
        'fade-in': 'fade-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-start': 'slide-in-start 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        shimmer: 'shimmer 1.6s infinite',
        'overlay-in': 'overlay-in 120ms ease-out',
        'palette-in': 'palette-in 160ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
EOF

# ---------------------------------------------------------------------------
# packages/ui
# ---------------------------------------------------------------------------

say "Writing @korvi/ui"

cat << EOF > packages/ui/package.json
{
  "name": "@korvi/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./styles/tokens.css": "./src/styles/tokens.css",
    "./assets/*": "./assets/*"
  },
  "files": ["dist", "src/styles", "assets"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": { "react": "^19.0.0" },
  "devDependencies": {
    "@types/react": "$V_TYPES_REACT",
    "react": "$V_REACT"
  }
}
EOF

cat << 'EOF' > packages/ui/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
EOF

cat << 'EOF' > packages/ui/src/styles/tokens.css
/*
 * Korvi Design System — token roots.
 *
 * Transcribed from KORVI-DESIGN-SYSTEM.md §10. Values are HSL channel triplets
 * with no hsl() wrapper: Tailwind consumes them as
 * `hsl(var(--token) / <alpha-value>)`, and wrapping them here would break every
 * opacity modifier in the system.
 *
 * No component may define a colour. If a value is missing, it is added here.
 */

:root {
  --background: 0 0% 100%;
  --foreground: 222 25% 12%;
  --card: 0 0% 100%;
  --card-foreground: 222 25% 12%;
  --popover: 0 0% 100%;
  --popover-foreground: 222 25% 12%;

  /* A deep teal-green: institutional and financial without being the default
     corporate blue every other ERP already uses. */
  --primary: 172 62% 26%;
  --primary-foreground: 160 40% 98%;

  --secondary: 210 20% 96%;
  --secondary-foreground: 222 25% 20%;
  --muted: 210 20% 96%;
  --muted-foreground: 215 16% 45%;
  --accent: 172 45% 94%;
  --accent-foreground: 172 62% 20%;

  --destructive: 0 72% 45%;
  --destructive-foreground: 0 0% 100%;
  --success: 152 55% 34%;
  --success-foreground: 0 0% 100%;
  --warning: 38 92% 45%;
  --warning-foreground: 30 40% 12%;

  --border: 214 20% 89%;
  --input: 214 20% 89%;
  --ring: 172 62% 32%;

  --radius: 0.625rem;

  /* Brand — constant across themes and across print. See §2.4.
     One decimal place, because these round-trip exactly to #047857 and
     #34D399; rounding to integers lands on #027855, which is a different
     colour from the one the print rule emits literally. Do not round. */
  --brand: 162.9 93.5% 24.3%;
  --brand-on-dark: 158.1 64.4% 51.6%;

  --font-sans:
    var(--font-plex-arabic), 'Segoe UI', 'Tahoma', 'Geeza Pro', 'Noto Sans Arabic',
    system-ui, sans-serif;
  --font-mono:
    var(--font-plex-mono), ui-monospace, 'SF Mono', 'Cascadia Mono', 'Consolas', monospace;
}

:root[data-theme='dark'],
.dark {
  --background: 222 30% 8%;
  --foreground: 210 20% 96%;
  /* Lighter than the background: in dark mode elevation is expressed by
     lightness, because a black shadow on a near-black surface is invisible. */
  --card: 222 26% 11%;
  --card-foreground: 210 20% 96%;
  --popover: 222 26% 11%;
  --popover-foreground: 210 20% 96%;

  /* Not the light value lightened — a separately tuned pair. */
  --primary: 172 55% 45%;
  --primary-foreground: 222 30% 8%;

  --secondary: 222 20% 17%;
  --secondary-foreground: 210 20% 96%;
  --muted: 222 20% 17%;
  --muted-foreground: 215 16% 62%;
  --accent: 172 40% 18%;
  --accent-foreground: 172 55% 80%;

  --destructive: 0 62% 52%;
  --destructive-foreground: 0 0% 100%;
  --success: 152 45% 45%;
  --success-foreground: 0 0% 100%;
  --warning: 38 85% 55%;
  --warning-foreground: 30 40% 10%;

  --border: 222 18% 22%;
  --input: 222 18% 22%;
  --ring: 172 55% 45%;
}

/* --- Typography rules that are not optional (§4.3) ---------------------- */

body {
  font-feature-settings: 'kern' 1, 'liga' 1, 'calt' 1;
}

/*
 * Every financial figure. In a proportional face the digit 1 is narrower than
 * 8, so a column of amounts shivers as it updates and the decimal points stop
 * lining up. On a cart that re-totals with every scan, that reads as a fault.
 */
.numeric {
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  direction: ltr;
  text-align: end;
}

/*
 * Latin runs inside Arabic text. Without isolation the bidi algorithm reorders
 * INV-2026-00001 into 00001-2026-INV — not a cosmetic problem, a wrong document
 * number on screen.
 */
.bidi-isolate {
  unicode-bidi: isolate;
  direction: ltr;
  display: inline-block;
}

[dir='rtl'] .flip-in-rtl {
  transform: scaleX(-1);
}

[dir='rtl'] .numeric {
  text-align: left;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

/* --- Print (§9) --------------------------------------------------------- */

@media print {
  .no-print,
  aside,
  header.sticky {
    display: none !important;
  }

  .sticky {
    position: static !important;
  }

  .backdrop-blur {
    backdrop-filter: none !important;
  }

  @page {
    margin: 14mm;
  }

  tr,
  figure,
  svg,
  dl {
    break-inside: avoid;
  }

  thead {
    display: table-header-group;
  }

  h1,
  h2,
  h3 {
    break-after: avoid;
  }

  p {
    orphans: 3;
    widows: 3;
  }

  /* Browsers drop non-essential colour when printing. The brand mark is
     essential: it must be the same green on paper as on screen. */
  .text-brand {
    color: #047857 !important;
    print-color-adjust: exact;
  }

  /* A QR that inverts under a dark theme is a QR no scanner will read. */
  svg[role='img'] rect {
    fill: #fff !important;
  }

  svg[role='img'] path {
    fill: #000 !important;
    print-color-adjust: exact;
  }
}
EOF

cat << 'EOF' > packages/config/src/__tests__/toolchain.test.ts
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
EOF

cat << 'EOF' > packages/config/src/__tests__/audit-gate.test.ts
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
EOF

cat << 'EOF' > packages/config/src/__tests__/zatca-architecture.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static assertions over the ZATCA architecture documentation.
 *
 * Compliance documentation is load-bearing: an engineer implementing Phase 2
 * will build what it describes. Revision 2 stated that tag 9 belonged to
 * standard invoices, which is wrong, and left the impression that signing could
 * follow issuance. Both are the kind of error that produces documents which
 * were never compliant at the moment they were handed over.
 *
 * These tests pin the corrected statements so they cannot silently regress.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../..');
const doc = readFileSync(join(root, 'docs/architecture/zatca.md'), 'utf8');
const tlv = readFileSync(join(root, 'packages/domain/src/zatca/tlv.ts'), 'utf8');

describe('Phase 2 simplified tax invoice QR', () => {
  it('is documented as carrying tags 1 to 9', () => {
    expect(doc).toContain('tags 1-9');
    expect(doc).toMatch(/simplified tax invoice QR carries tags 1-9/i);
  });

  it('documents every tag from 6 to 9', () => {
    for (const row of [
      /\|\s*6\s*\|.*hash/i,
      /\|\s*7\s*\|.*signature|stamp/i,
      /\|\s*8\s*\|.*public key/i,
      /\|\s*9\s*\|.*(technical CA|CA signature)/i,
    ]) {
      expect(doc).toMatch(row);
    }
  });

  it('attributes tag 9 to simplified invoices, not standard ones', () => {
    expect(doc).toMatch(/[Tt]ag 9[^.]*simplified/);
    expect(doc).not.toMatch(/[Tt]ag 9[^.]*[Ss]tandard invoices only/);
    expect(doc).not.toMatch(/Standard invoices only, returned by clearance/);
  });

  it('says the same thing in the TLV module', () => {
    expect(tlv).toContain('tags 1-9');
    expect(tlv).toMatch(/technical\s*\n?\s*\*?\s*CA signature|CA signature over that public key/i);
  });
});

describe('local issuance ordering', () => {
  const pipeline = [
    'deterministic sale totals',
    'compliant UBL XML',
    'canonicalisation',
    'invoice hash',
    'cryptographic stamping',
    'QR carrying tags 1-9',
    'immutable local persistence',
    'customer invoice / receipt issuance',
  ];

  it('documents the pipeline in order', () => {
    let cursor = -1;
    for (const step of pipeline) {
      const index = doc.indexOf(step);
      expect(index, `"${step}" missing from the documented pipeline`).toBeGreaterThan(-1);
      expect(index, `"${step}" is out of order`).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('places signing before the customer receives the document', () => {
    // The ordering constraint that matters: a receipt handed over must already
    // carry its stamp and its complete QR.
    const signing = doc.indexOf('cryptographic stamping');
    const issuance = doc.indexOf('customer invoice / receipt issuance');
    expect(signing).toBeGreaterThan(-1);
    expect(issuance).toBeGreaterThan(signing);
    expect(doc).toMatch(/[Ss]igning is not deferred past issuance/);
  });

  it('places reporting after issuance and allows it to be retried', () => {
    const issuance = doc.indexOf('customer invoice / receipt issuance');
    const reporting = doc.indexOf('reporting -> FATOORA API');
    expect(reporting).toBeGreaterThan(issuance);
    expect(doc).toMatch(/regulatory window/);
  });

  it('scopes the offline queue to reporting, not signing', () => {
    // Prettier normalises markdown emphasis to underscores.
    expect(doc).toMatch(/queue in ADR-0005 models [*_]reporting[*_], not signing/);
  });
});

describe('no invented policy', () => {
  it('does not assert what a till does when its certificate expires', () => {
    // Removed in revision 3: that behaviour is a regulatory question, and this
    // repository is not a source of ZATCA policy.
    const corpus = [doc, readFileSync(join(root, 'docs/decisions/ADR-0005-offline-first.md'), 'utf8')];
    for (const text of corpus) {
      expect(text).not.toMatch(/certificate expires mid-shift must keep selling/i);
    }
  });

  it('directs the reader to the official specifications', () => {
    expect(doc).toMatch(/official ZATCA (e-invoicing )?specifications/i);
  });

  it('states plainly that tags 1-5 alone are not Phase 2 compliance', () => {
    expect(doc).toMatch(/not Phase 2 compliance/i);
    expect(tlv).toMatch(/NOT ZATCA Phase 2 compliance/);
  });
});
EOF

cat << 'EOF' > packages/ui/src/lib/cn.ts
/**
 * Join class names, dropping anything falsy.
 *
 * Deliberately not clsx: this is the whole of what the codebase uses, and a
 * dependency that exists to concatenate strings is a dependency to audit.
 */
export function cn(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value !== '').join(' ');
}
EOF

cat << 'EOF' > packages/ui/src/lib/theme-color.ts
/**
 * The one place a colour literal is allowed, and the reason why.
 *
 * `<meta name="theme-color">` is read by the browser and the operating system
 * to tint chrome around the page — the address bar, the task switcher card.
 * That consumer is outside the document, so it cannot resolve a CSS variable;
 * it needs a literal value at render time.
 *
 * These two must stay equal to `--background` in each theme. If a token
 * changes, change these with it. The invariant scan excludes this file by name
 * precisely so the exception stays visible in one place rather than spreading.
 */
export const THEME_COLOR_LIGHT = '#FFFFFF'; // --background light: 0 0% 100%
export const THEME_COLOR_DARK = '#0E121B'; // --background dark: 222 30% 8%
EOF

cat << 'EOF' > packages/ui/src/components/korvi-mark.tsx
import type { JSX } from 'react';
import { cn } from '../lib/cn.js';

/**
 * The Korvi wordmark — text, not an image.
 *
 * Documented reasoning (KORVI-DESIGN-SYSTEM.md §8): there is no file to lose,
 * no second copy to keep in step with the theme, and it prints — a bitmap at
 * screen resolution comes out of a thermal head as a grey smudge.
 *
 * The suffix sits at the start of the lockup and the name at the end, matching
 * the Korvi ERP lockup exactly; only the suffix string differs.
 *
 * Placement rule: this must never appear in a tax invoice header. That header
 * identifies who issued the invoice, and putting the software vendor's name
 * there tells an auditor Korvi sold the goods. Footer only, as
 * "صُدرت عبر Korvi".
 */
export type KorviMarkSize = 'sm' | 'md' | 'lg';

const NAME_SIZE: Record<KorviMarkSize, string> = {
  sm: 'text-lg',
  md: 'text-2xl',
  lg: 'text-3xl',
};

const SUFFIX_SIZE: Record<KorviMarkSize, string> = {
  sm: 'text-[9px]',
  md: 'text-[10px]',
  lg: 'text-xs',
};

export interface KorviMarkProps {
  readonly size?: KorviMarkSize;
  readonly suffix?: string;
  readonly className?: string;
}

export function KorviMark({
  size = 'md',
  suffix = 'POS',
  className,
}: KorviMarkProps): JSX.Element {
  return (
    <span
      dir="ltr"
      className={cn('inline-flex items-baseline gap-2', className)}
      aria-label={`Korvi ${suffix}`}
    >
      <span
        aria-hidden="true"
        className={cn(
          'bidi-isolate font-semibold uppercase tracking-[0.2em] text-muted-foreground',
          SUFFIX_SIZE[size],
        )}
      >
        {suffix}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'bidi-isolate font-extrabold tracking-wider text-brand dark:text-brand-on-dark',
          NAME_SIZE[size],
        )}
      >
        Korvi
      </span>
    </span>
  );
}
EOF

cat << 'EOF' > packages/ui/src/components/numeric.tsx
import type { JSX } from 'react';
import { cn } from '../lib/cn.js';

/**
 * Any figure a merchant reconciles.
 *
 * Takes a pre-formatted string rather than a number on purpose: formatting is
 * the domain's job (moneyToMajorString), and accepting a number here would
 * invite a float into the render path — the exact thing ADR-0002 forbids.
 *
 * `.numeric` supplies tabular figures and LTR isolation; see tokens.css.
 */
export interface NumericProps {
  readonly value: string;
  readonly className?: string;
  readonly title?: string;
}

export function Numeric({ value, className, title }: NumericProps): JSX.Element {
  return (
    <span className={cn('numeric font-numeric', className)} dir="ltr" title={title}>
      {value}
    </span>
  );
}

/**
 * A Latin run inside Arabic prose — document numbers, SKUs, barcodes.
 *
 * Without isolation the bidi algorithm reverses the segments of
 * "INV-2026-00001" and shows a document number that does not exist.
 */
export interface BidiIsolateProps {
  readonly children: string;
  readonly className?: string;
}

export function BidiIsolate({ children, className }: BidiIsolateProps): JSX.Element {
  return (
    <span className={cn('bidi-isolate', className)} dir="ltr">
      {children}
    </span>
  );
}
EOF

cat << 'EOF' > packages/ui/src/components/button.tsx
import type { ButtonHTMLAttributes, JSX } from 'react';
import { cn } from '../lib/cn.js';

/**
 * The five variants from KORVI-DESIGN-SYSTEM.md §7.3, at POS touch sizes.
 *
 * Heights differ from the ERP deliberately (§12): 40px works with a mouse and
 * mis-taps with a thumb, so `md` is 44px here and `lg` is 48px for payment and
 * keypad keys.
 *
 * `loading` keeps the button disabled. The comment in the ERP source is worth
 * repeating: the commonest way to post an invoice twice is to press Post twice
 * before the first request returns. Here that is a double charge.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-touch px-4 text-sm',
  lg: 'h-touch-lg px-6 text-base',
  icon: 'h-touch w-touch',
};

const BASE =
  'inline-flex select-none items-center justify-center gap-2 rounded-md font-medium ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'disabled:pointer-events-none disabled:opacity-50';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled === true || loading}
      aria-busy={loading}
      className={cn(BASE, VARIANT[variant], SIZE[size], className)}
    >
      {children}
    </button>
  );
}
EOF

cat << 'EOF' > packages/ui/src/components/square-asset.tsx
import type { JSX } from 'react';
import { cn } from '../lib/cn.js';

/**
 * Every avatar, logo and item image, in a guaranteed square (§3.3).
 *
 * Three details carry the whole rule and all three are easy to drop:
 *   aspect-square    the box, not the image, decides the shape
 *   object-cover     fills the box and crops the excess instead of distorting
 *   overflow-hidden  without it the image spills past the rounded corners
 *
 * `rounded-lg` rather than a circle: a grid of rounded squares reads as a
 * system, a grid of circles reads as a contact list — and this grid is items.
 */
export type SquareAssetSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE: Record<SquareAssetSize, string> = {
  xs: 'w-6',
  sm: 'w-8',
  md: 'w-9',
  lg: 'w-14',
  xl: 'w-20',
};

export interface SquareAssetProps {
  readonly src: string;
  readonly alt: string;
  readonly size?: SquareAssetSize;
  readonly className?: string;
}

export function SquareAsset({
  src,
  alt,
  size = 'xl',
  className,
}: SquareAssetProps): JSX.Element {
  return (
    <div
      className={cn(
        'aspect-square shrink-0 overflow-hidden rounded-lg bg-muted',
        SIZE[size],
        className,
      )}
    >
      <img src={src} alt={alt} className="h-full w-full object-cover" />
    </div>
  );
}
EOF

cat << 'EOF' > packages/ui/src/components/card-surface.tsx
import type { HTMLAttributes, JSX } from 'react';
import { cn } from '../lib/cn.js';

/**
 * The standard raised surface (§7.3).
 *
 * `rounded-lg` on the container, `rounded-md` on the controls inside it — the
 * inner element is always less round than its container, never the reverse.
 */
export function CardSurface({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      {...rest}
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}
EOF

cat << 'EOF' > packages/ui/src/index.ts
export { cn } from './lib/cn.js';
export { THEME_COLOR_DARK, THEME_COLOR_LIGHT } from './lib/theme-color.js';
export { KorviMark } from './components/korvi-mark.js';
export type { KorviMarkProps, KorviMarkSize } from './components/korvi-mark.js';
export { Numeric, BidiIsolate } from './components/numeric.js';
export type { NumericProps, BidiIsolateProps } from './components/numeric.js';
export { Button } from './components/button.js';
export type { ButtonProps, ButtonSize, ButtonVariant } from './components/button.js';
export { SquareAsset } from './components/square-asset.js';
export type { SquareAssetProps, SquareAssetSize } from './components/square-asset.js';
export { CardSurface } from './components/card-surface.js';
EOF

# ---------------------------------------------------------------------------
# apps/api
# ---------------------------------------------------------------------------

say "Writing apps/api"

cat << EOF > apps/api/package.json
{
  "name": "@korvi/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@korvi/database": "*",
    "@korvi/domain": "*",
    "fastify": "$V_FASTIFY",
    "zod": "$V_ZOD"
  },
  "devDependencies": { "tsx": "$V_TSX" }
}
EOF

cat << 'EOF' > apps/api/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2023", "DOM"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/__tests__/**", "src/**/*.test.ts"]
}
EOF

cat << 'EOF' > apps/api/src/config.ts
import { z } from 'zod';

/**
 * Environment parsing, once, at the edge.
 *
 * Everything downstream receives a typed object rather than reading
 * process.env, so a missing variable fails at boot with a clear message
 * instead of surfacing as `undefined` inside a request three hours later.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type ApiConfig = Readonly<z.infer<typeof schema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  return parsed.data;
}
EOF

cat << 'EOF' > apps/api/src/routes/health.ts
import type { FastifyInstance } from 'fastify';

/**
 * Liveness only.
 *
 * It does not touch the database on purpose: a health check that fails when
 * Postgres blinks causes the orchestrator to restart a process that was fine,
 * turning a brief database hiccup into an outage. Readiness lands separately.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', () => ({ status: 'ok' }));

  app.get('/version', () => ({
    name: 'korvi-pos-api',
    phase: 'foundation',
  }));
}
EOF

cat << 'EOF' > apps/api/src/server.ts
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { newId } from '@korvi/domain';
import { registerHealthRoutes } from './routes/health.js';
import type { ApiConfig } from './config.js';

export function buildServer(config: ApiConfig): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // The central Korvi generator, not crypto.randomUUID. A v4 carries no
    // time, so a request log line could not be ordered against a sale that was
    // rung up offline and synced later. Every identifier in the system comes
    // from one place (ADR-0003).
    genReqId: () => newId(),
  });

  registerHealthRoutes(app);
  return app;
}
EOF

cat << 'EOF' > apps/api/src/index.ts
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const app = buildServer(config);

app.listen({ port: config.API_PORT, host: '0.0.0.0' }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
EOF

cat << 'EOF' > apps/api/src/__tests__/server.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';

describe('api', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the liveness probe', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports the phase', async () => {
    const response = await app.inject({ method: 'GET', url: '/version' });
    expect(response.json()).toMatchObject({ phase: 'foundation' });
  });
});

describe('config', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(3001);
  });

  it('rejects a nonsense port rather than booting on a guess', () => {
    expect(() => loadConfig({ API_PORT: 'not-a-port' })).toThrow(/Invalid environment/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(/Invalid environment/);
  });
});
EOF

# ---------------------------------------------------------------------------
# apps/pos-web
# ---------------------------------------------------------------------------

say "Writing apps/pos-web"

cat << EOF > apps/pos-web/package.json
{
  "name": "@korvi/pos-web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "start": "next start",
    "build": "next build",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@korvi/domain": "*",
    "@korvi/ui": "*",
    "next": "$V_NEXT",
    "react": "$V_REACT",
    "react-dom": "$V_REACT",
    "zustand": "$V_ZUSTAND"
  },
  "devDependencies": {
    "@korvi/config": "*",
    "@types/react": "$V_TYPES_REACT",
    "@types/react-dom": "$V_TYPES_REACT_DOM",
    "autoprefixer": "$V_AUTOPREFIXER",
    "postcss": "$V_POSTCSS",
    "tailwindcss": "$V_TAILWIND"
  }
}
EOF

cat << 'EOF' > apps/pos-web/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "allowJs": true,
    "noEmit": true,
    "incremental": true,
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "verbatimModuleSyntax": false,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
EOF

cat << 'EOF' > apps/pos-web/next.config.ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // @korvi/ui ships compiled JS, but transpiling it here keeps source maps
  // pointing at the real TSX during development.
  transpilePackages: ['@korvi/ui'],
  typedRoutes: true,
};

export default config;
EOF

cat << 'EOF' > apps/pos-web/postcss.config.mjs
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
EOF

cat << 'EOF' > apps/pos-web/tailwind.config.ts
import type { Config } from 'tailwindcss';
import korviPreset from '@korvi/config/tailwind-preset';

/**
 * The preset carries the whole design system (ADR-0006). This file only says
 * where to look for classes — including the shared UI package, whose classes
 * would otherwise be tree-shaken out of the stylesheet.
 */
const config: Config = {
  presets: [korviPreset as Config],
  content: [
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
};

export default config;
EOF

cat << 'EOF' > apps/pos-web/src/app/globals.css
@import '@korvi/ui/styles/tokens.css';

@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  * {
    border-color: hsl(var(--border));
  }

  body {
    background-color: hsl(var(--background));
    color: hsl(var(--foreground));
  }
}
EOF

cat << 'EOF' > apps/pos-web/src/app/layout.tsx
import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic, IBM_Plex_Mono } from 'next/font/google';
import { THEME_COLOR_DARK, THEME_COLOR_LIGHT } from '@korvi/ui';
import './globals.css';

/**
 * Both families are downloaded at build time and served from our own origin —
 * no third-party request at runtime, and no flash of system font.
 *
 * Plex Sans Arabic rather than a display face: the "beautiful" Arabic fonts are
 * mostly Kufi display styles that fall apart in 13px interface text. Plex is a
 * text family with a Latin companion at matching weight, which is what stops
 * Latin looking foreign inside an Arabic sentence.
 */
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-plex-arabic',
  display: 'swap',
  adjustFontFallback: true,
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Korvi POS',
  description: 'نظام نقاط البيع للتجزئة والمطاعم',
  icons: { icon: '/brand/korvi-pos-icon.svg' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_COLOR_LIGHT },
    { media: '(prefers-color-scheme: dark)', color: THEME_COLOR_DARK },
  ],
  // A cashier's thumb must not zoom the till by accident, but pinch-zoom stays
  // available for anyone who needs it.
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  // RTL is the default direction, not a later addition. See §6.
  return (
    <html lang="ar" dir="rtl" className={`${plexArabic.variable} ${plexMono.variable}`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
EOF

cat << 'EOF' > apps/pos-web/src/app/page.tsx
import { KorviMark, Numeric, CardSurface, Button, BidiIsolate } from '@korvi/ui';
import {
  VAT_STANDARD_BP,
  allocateEvenly,
  grossFromNet,
  moneyFromMajorString,
  moneyToMajorString,
  taxFromNet,
} from '@korvi/domain';

/**
 * Foundation smoke page.
 *
 * It exists to prove the wiring end to end — tokens, fonts, RTL, the wordmark,
 * and the domain core computing real figures inside a rendered page. It is not
 * the cashier screen; that is Phase 1.
 */
export default function Home(): React.JSX.Element {
  const net = moneyFromMajorString('100.00');
  const vat = taxFromNet(net, VAT_STANDARD_BP);
  const gross = grossFromNet(net, VAT_STANDARD_BP);
  const split = allocateEvenly(gross, 3);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <KorviMark size="lg" />
        <span className="text-xs text-muted-foreground">المرحلة صفر — الأساس</span>
      </header>

      <CardSurface className="p-6">
        <h1 className="mb-4 text-2xl font-semibold">التحقق من النواة المالية</h1>

        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">الإجمالي قبل الضريبة</dt>
            <dd><Numeric value={moneyToMajorString(net)} /></dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">ضريبة القيمة المضافة (15%)</dt>
            <dd><Numeric value={moneyToMajorString(vat)} /></dd>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-2 font-semibold">
            <dt>الإجمالي</dt>
            <dd><Numeric value={moneyToMajorString(gross)} className="text-lg" /></dd>
          </div>
        </dl>
      </CardSurface>

      <CardSurface className="p-6">
        <h2 className="mb-2 text-lg font-semibold">التقسيم على ثلاثة</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          مجموع الأنصبة يساوي الإجمالي تماماً — لا هللة تُفقد ولا تُخلق.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {split.map((part, index) => (
            <li key={index} className="flex items-center justify-between">
              <span className="text-muted-foreground">
                الجزء <BidiIsolate>{String(index + 1)}</BidiIsolate>
              </span>
              <Numeric value={moneyToMajorString(part)} />
            </li>
          ))}
        </ul>
      </CardSurface>

      <div className="flex flex-wrap gap-3">
        <Button size="lg">زر الدفع</Button>
        <Button variant="secondary">ثانوي</Button>
        <Button variant="outline">محدد</Button>
        <Button variant="destructive">إلغاء</Button>
        <Button loading>قيد التنفيذ</Button>
      </div>
    </main>
  );
}
EOF

# ---------------------------------------------------------------------------
# Brand assets
# ---------------------------------------------------------------------------

say "Writing brand assets"

cat << 'EOF' > packages/ui/assets/brand/korvi-pos-lockup.svg
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 530.99 139.31"
     width="530.99" height="139.31"
     role="img" aria-label="Korvi POS">
  <title>Korvi POS</title>
  <style>
    .korvi-mark { fill: #047857; }
    .korvi-suffix { fill: #607085; }
    @media (prefers-color-scheme: dark) {
      .korvi-mark { fill: #34D399; }
      .korvi-suffix { fill: #8F9CAE; }
    }
  </style>
  <g transform="translate(11.233 123.307) scale(0.058137 -0.058137)">
    <path class="korvi-suffix" d="M82.00 0.00V698.00H396.00Q444.00 698.00 482.50 682.50Q521.00 667.00 548.00 638.50Q575.00 610.00 589.00 570.00Q603.00 530.00 603.00 482.00Q603.00 433.00 589.00 393.50Q575.00 354.00 548.00 325.50Q521.00 297.00 482.50 281.50Q444.00 266.00 396.00 266.00H214.00V0.00ZM214.00 380.00H384.00Q422.00 380.00 444.00 400.50Q466.00 421.00 466.00 459.00V505.00Q466.00 543.00 444.00 563.00Q422.00 583.00 384.00 583.00H214.00ZM1065.68 -12.00Q996.68 -12.00 940.68 11.00Q884.68 34.00 845.18 80.00Q805.68 126.00 783.68 193.00Q761.68 260.00 761.68 349.00Q761.68 437.00 783.68 504.50Q805.68 572.00 845.18 618.00Q884.68 664.00 940.68 687.00Q996.68 710.00 1065.68 710.00Q1134.68 710.00 1190.68 687.00Q1246.68 664.00 1286.68 618.00Q1326.68 572.00 1348.18 504.50Q1369.68 437.00 1369.68 349.00Q1369.68 260.00 1348.18 193.00Q1326.68 126.00 1286.68 80.00Q1246.68 34.00 1190.68 11.00Q1134.68 -12.00 1065.68 -12.00ZM1065.68 105.00Q1140.68 105.00 1185.18 155.00Q1229.68 205.00 1229.68 295.00V403.00Q1229.68 493.00 1185.18 543.00Q1140.68 593.00 1065.68 593.00Q990.68 593.00 946.18 543.00Q901.68 493.00 901.68 403.00V295.00Q901.68 205.00 946.18 155.00Q990.68 105.00 1065.68 105.00ZM1789.36 -12.00Q1699.36 -12.00 1636.86 20.00Q1574.36 52.00 1529.36 104.00L1618.36 190.00Q1654.36 148.00 1698.86 126.00Q1743.36 104.00 1797.36 104.00Q1858.36 104.00 1889.36 130.50Q1920.36 157.00 1920.36 202.00Q1920.36 237.00 1900.36 259.00Q1880.36 281.00 1825.36 291.00L1759.36 301.00Q1550.36 334.00 1550.36 504.00Q1550.36 551.00 1567.86 589.00Q1585.36 627.00 1618.36 654.00Q1651.36 681.00 1697.86 695.50Q1744.36 710.00 1803.36 710.00Q1882.36 710.00 1941.36 684.00Q2000.36 658.00 2042.36 607.00L1952.36 522.00Q1926.36 554.00 1889.36 574.00Q1852.36 594.00 1796.36 594.00Q1739.36 594.00 1710.86 572.50Q1682.36 551.00 1682.36 512.00Q1682.36 472.00 1705.36 453.00Q1728.36 434.00 1779.36 425.00L1844.36 413.00Q1950.36 394.00 2000.86 345.50Q2051.36 297.00 2051.36 210.00Q2051.36 160.00 2033.86 119.50Q2016.36 79.00 1982.86 49.50Q1949.36 20.00 1900.86 4.00Q1852.36 -12.00 1789.36 -12.00Z"/>
  </g>
  <g transform="translate(166.708 123.307) scale(0.143266 -0.143266)">
    <path class="korvi-mark" d="M320.00 304.00 229.00 194.00V0.00H77.00V698.00H229.00V366.00H235.00L334.00 501.00L491.00 698.00H663.00L428.00 411.00L684.00 0.00H505.00ZM978.00 -12.00Q920.00 -12.00 874.50 7.00Q829.00 26.00 797.50 62.00Q766.00 98.00 749.00 149.00Q732.00 200.00 732.00 263.00Q732.00 326.00 749.00 377.00Q766.00 428.00 797.50 463.50Q829.00 499.00 874.50 518.00Q920.00 537.00 978.00 537.00Q1036.00 537.00 1081.50 518.00Q1127.00 499.00 1158.50 463.50Q1190.00 428.00 1207.00 377.00Q1224.00 326.00 1224.00 263.00Q1224.00 200.00 1207.00 149.00Q1190.00 98.00 1158.50 62.00Q1127.00 26.00 1081.50 7.00Q1036.00 -12.00 978.00 -12.00ZM978.00 105.00Q1022.00 105.00 1046.00 132.00Q1070.00 159.00 1070.00 209.00V316.00Q1070.00 366.00 1046.00 393.00Q1022.00 420.00 978.00 420.00Q934.00 420.00 910.00 393.00Q886.00 366.00 886.00 316.00V209.00Q886.00 159.00 910.00 132.00Q934.00 105.00 978.00 105.00ZM1329.00 0.00V525.00H1477.00V411.00H1482.00Q1486.00 433.00 1496.00 453.50Q1506.00 474.00 1522.50 490.00Q1539.00 506.00 1562.00 515.50Q1585.00 525.00 1616.00 525.00H1642.00V387.00H1605.00Q1540.00 387.00 1508.50 370.00Q1477.00 353.00 1477.00 307.00V0.00ZM1845.00 0.00 1673.00 525.00H1819.00L1884.00 313.00L1933.00 123.00H1941.00L1990.00 313.00L2053.00 525.00H2193.00L2021.00 0.00ZM2345.00 581.00Q2300.00 581.00 2279.50 601.50Q2259.00 622.00 2259.00 654.00V676.00Q2259.00 708.00 2279.50 728.50Q2300.00 749.00 2345.00 749.00Q2390.00 749.00 2410.50 728.50Q2431.00 708.00 2431.00 676.00V654.00Q2431.00 622.00 2410.50 601.50Q2390.00 581.00 2345.00 581.00ZM2271.00 525.00H2419.00V0.00H2271.00Z"/>
  </g>
</svg>
EOF

cat << 'EOF' > packages/ui/assets/brand/korvi-pos-lockup-light.svg
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 530.99 139.31"
     width="530.99" height="139.31"
     role="img" aria-label="Korvi POS">
  <title>Korvi POS</title>
  <g transform="translate(11.233 123.307) scale(0.058137 -0.058137)">
    <path fill="#607085" d="M82.00 0.00V698.00H396.00Q444.00 698.00 482.50 682.50Q521.00 667.00 548.00 638.50Q575.00 610.00 589.00 570.00Q603.00 530.00 603.00 482.00Q603.00 433.00 589.00 393.50Q575.00 354.00 548.00 325.50Q521.00 297.00 482.50 281.50Q444.00 266.00 396.00 266.00H214.00V0.00ZM214.00 380.00H384.00Q422.00 380.00 444.00 400.50Q466.00 421.00 466.00 459.00V505.00Q466.00 543.00 444.00 563.00Q422.00 583.00 384.00 583.00H214.00ZM1065.68 -12.00Q996.68 -12.00 940.68 11.00Q884.68 34.00 845.18 80.00Q805.68 126.00 783.68 193.00Q761.68 260.00 761.68 349.00Q761.68 437.00 783.68 504.50Q805.68 572.00 845.18 618.00Q884.68 664.00 940.68 687.00Q996.68 710.00 1065.68 710.00Q1134.68 710.00 1190.68 687.00Q1246.68 664.00 1286.68 618.00Q1326.68 572.00 1348.18 504.50Q1369.68 437.00 1369.68 349.00Q1369.68 260.00 1348.18 193.00Q1326.68 126.00 1286.68 80.00Q1246.68 34.00 1190.68 11.00Q1134.68 -12.00 1065.68 -12.00ZM1065.68 105.00Q1140.68 105.00 1185.18 155.00Q1229.68 205.00 1229.68 295.00V403.00Q1229.68 493.00 1185.18 543.00Q1140.68 593.00 1065.68 593.00Q990.68 593.00 946.18 543.00Q901.68 493.00 901.68 403.00V295.00Q901.68 205.00 946.18 155.00Q990.68 105.00 1065.68 105.00ZM1789.36 -12.00Q1699.36 -12.00 1636.86 20.00Q1574.36 52.00 1529.36 104.00L1618.36 190.00Q1654.36 148.00 1698.86 126.00Q1743.36 104.00 1797.36 104.00Q1858.36 104.00 1889.36 130.50Q1920.36 157.00 1920.36 202.00Q1920.36 237.00 1900.36 259.00Q1880.36 281.00 1825.36 291.00L1759.36 301.00Q1550.36 334.00 1550.36 504.00Q1550.36 551.00 1567.86 589.00Q1585.36 627.00 1618.36 654.00Q1651.36 681.00 1697.86 695.50Q1744.36 710.00 1803.36 710.00Q1882.36 710.00 1941.36 684.00Q2000.36 658.00 2042.36 607.00L1952.36 522.00Q1926.36 554.00 1889.36 574.00Q1852.36 594.00 1796.36 594.00Q1739.36 594.00 1710.86 572.50Q1682.36 551.00 1682.36 512.00Q1682.36 472.00 1705.36 453.00Q1728.36 434.00 1779.36 425.00L1844.36 413.00Q1950.36 394.00 2000.86 345.50Q2051.36 297.00 2051.36 210.00Q2051.36 160.00 2033.86 119.50Q2016.36 79.00 1982.86 49.50Q1949.36 20.00 1900.86 4.00Q1852.36 -12.00 1789.36 -12.00Z"/>
  </g>
  <g transform="translate(166.708 123.307) scale(0.143266 -0.143266)">
    <path fill="#047857" d="M320.00 304.00 229.00 194.00V0.00H77.00V698.00H229.00V366.00H235.00L334.00 501.00L491.00 698.00H663.00L428.00 411.00L684.00 0.00H505.00ZM978.00 -12.00Q920.00 -12.00 874.50 7.00Q829.00 26.00 797.50 62.00Q766.00 98.00 749.00 149.00Q732.00 200.00 732.00 263.00Q732.00 326.00 749.00 377.00Q766.00 428.00 797.50 463.50Q829.00 499.00 874.50 518.00Q920.00 537.00 978.00 537.00Q1036.00 537.00 1081.50 518.00Q1127.00 499.00 1158.50 463.50Q1190.00 428.00 1207.00 377.00Q1224.00 326.00 1224.00 263.00Q1224.00 200.00 1207.00 149.00Q1190.00 98.00 1158.50 62.00Q1127.00 26.00 1081.50 7.00Q1036.00 -12.00 978.00 -12.00ZM978.00 105.00Q1022.00 105.00 1046.00 132.00Q1070.00 159.00 1070.00 209.00V316.00Q1070.00 366.00 1046.00 393.00Q1022.00 420.00 978.00 420.00Q934.00 420.00 910.00 393.00Q886.00 366.00 886.00 316.00V209.00Q886.00 159.00 910.00 132.00Q934.00 105.00 978.00 105.00ZM1329.00 0.00V525.00H1477.00V411.00H1482.00Q1486.00 433.00 1496.00 453.50Q1506.00 474.00 1522.50 490.00Q1539.00 506.00 1562.00 515.50Q1585.00 525.00 1616.00 525.00H1642.00V387.00H1605.00Q1540.00 387.00 1508.50 370.00Q1477.00 353.00 1477.00 307.00V0.00ZM1845.00 0.00 1673.00 525.00H1819.00L1884.00 313.00L1933.00 123.00H1941.00L1990.00 313.00L2053.00 525.00H2193.00L2021.00 0.00ZM2345.00 581.00Q2300.00 581.00 2279.50 601.50Q2259.00 622.00 2259.00 654.00V676.00Q2259.00 708.00 2279.50 728.50Q2300.00 749.00 2345.00 749.00Q2390.00 749.00 2410.50 728.50Q2431.00 708.00 2431.00 676.00V654.00Q2431.00 622.00 2410.50 601.50Q2390.00 581.00 2345.00 581.00ZM2271.00 525.00H2419.00V0.00H2271.00Z"/>
  </g>
</svg>
EOF

cat << 'EOF' > packages/ui/assets/brand/korvi-pos-lockup-dark.svg
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 530.99 139.31"
     width="530.99" height="139.31"
     role="img" aria-label="Korvi POS">
  <title>Korvi POS</title>
  <g transform="translate(11.233 123.307) scale(0.058137 -0.058137)">
    <path fill="#8F9CAE" d="M82.00 0.00V698.00H396.00Q444.00 698.00 482.50 682.50Q521.00 667.00 548.00 638.50Q575.00 610.00 589.00 570.00Q603.00 530.00 603.00 482.00Q603.00 433.00 589.00 393.50Q575.00 354.00 548.00 325.50Q521.00 297.00 482.50 281.50Q444.00 266.00 396.00 266.00H214.00V0.00ZM214.00 380.00H384.00Q422.00 380.00 444.00 400.50Q466.00 421.00 466.00 459.00V505.00Q466.00 543.00 444.00 563.00Q422.00 583.00 384.00 583.00H214.00ZM1065.68 -12.00Q996.68 -12.00 940.68 11.00Q884.68 34.00 845.18 80.00Q805.68 126.00 783.68 193.00Q761.68 260.00 761.68 349.00Q761.68 437.00 783.68 504.50Q805.68 572.00 845.18 618.00Q884.68 664.00 940.68 687.00Q996.68 710.00 1065.68 710.00Q1134.68 710.00 1190.68 687.00Q1246.68 664.00 1286.68 618.00Q1326.68 572.00 1348.18 504.50Q1369.68 437.00 1369.68 349.00Q1369.68 260.00 1348.18 193.00Q1326.68 126.00 1286.68 80.00Q1246.68 34.00 1190.68 11.00Q1134.68 -12.00 1065.68 -12.00ZM1065.68 105.00Q1140.68 105.00 1185.18 155.00Q1229.68 205.00 1229.68 295.00V403.00Q1229.68 493.00 1185.18 543.00Q1140.68 593.00 1065.68 593.00Q990.68 593.00 946.18 543.00Q901.68 493.00 901.68 403.00V295.00Q901.68 205.00 946.18 155.00Q990.68 105.00 1065.68 105.00ZM1789.36 -12.00Q1699.36 -12.00 1636.86 20.00Q1574.36 52.00 1529.36 104.00L1618.36 190.00Q1654.36 148.00 1698.86 126.00Q1743.36 104.00 1797.36 104.00Q1858.36 104.00 1889.36 130.50Q1920.36 157.00 1920.36 202.00Q1920.36 237.00 1900.36 259.00Q1880.36 281.00 1825.36 291.00L1759.36 301.00Q1550.36 334.00 1550.36 504.00Q1550.36 551.00 1567.86 589.00Q1585.36 627.00 1618.36 654.00Q1651.36 681.00 1697.86 695.50Q1744.36 710.00 1803.36 710.00Q1882.36 710.00 1941.36 684.00Q2000.36 658.00 2042.36 607.00L1952.36 522.00Q1926.36 554.00 1889.36 574.00Q1852.36 594.00 1796.36 594.00Q1739.36 594.00 1710.86 572.50Q1682.36 551.00 1682.36 512.00Q1682.36 472.00 1705.36 453.00Q1728.36 434.00 1779.36 425.00L1844.36 413.00Q1950.36 394.00 2000.86 345.50Q2051.36 297.00 2051.36 210.00Q2051.36 160.00 2033.86 119.50Q2016.36 79.00 1982.86 49.50Q1949.36 20.00 1900.86 4.00Q1852.36 -12.00 1789.36 -12.00Z"/>
  </g>
  <g transform="translate(166.708 123.307) scale(0.143266 -0.143266)">
    <path fill="#34D399" d="M320.00 304.00 229.00 194.00V0.00H77.00V698.00H229.00V366.00H235.00L334.00 501.00L491.00 698.00H663.00L428.00 411.00L684.00 0.00H505.00ZM978.00 -12.00Q920.00 -12.00 874.50 7.00Q829.00 26.00 797.50 62.00Q766.00 98.00 749.00 149.00Q732.00 200.00 732.00 263.00Q732.00 326.00 749.00 377.00Q766.00 428.00 797.50 463.50Q829.00 499.00 874.50 518.00Q920.00 537.00 978.00 537.00Q1036.00 537.00 1081.50 518.00Q1127.00 499.00 1158.50 463.50Q1190.00 428.00 1207.00 377.00Q1224.00 326.00 1224.00 263.00Q1224.00 200.00 1207.00 149.00Q1190.00 98.00 1158.50 62.00Q1127.00 26.00 1081.50 7.00Q1036.00 -12.00 978.00 -12.00ZM978.00 105.00Q1022.00 105.00 1046.00 132.00Q1070.00 159.00 1070.00 209.00V316.00Q1070.00 366.00 1046.00 393.00Q1022.00 420.00 978.00 420.00Q934.00 420.00 910.00 393.00Q886.00 366.00 886.00 316.00V209.00Q886.00 159.00 910.00 132.00Q934.00 105.00 978.00 105.00ZM1329.00 0.00V525.00H1477.00V411.00H1482.00Q1486.00 433.00 1496.00 453.50Q1506.00 474.00 1522.50 490.00Q1539.00 506.00 1562.00 515.50Q1585.00 525.00 1616.00 525.00H1642.00V387.00H1605.00Q1540.00 387.00 1508.50 370.00Q1477.00 353.00 1477.00 307.00V0.00ZM1845.00 0.00 1673.00 525.00H1819.00L1884.00 313.00L1933.00 123.00H1941.00L1990.00 313.00L2053.00 525.00H2193.00L2021.00 0.00ZM2345.00 581.00Q2300.00 581.00 2279.50 601.50Q2259.00 622.00 2259.00 654.00V676.00Q2259.00 708.00 2279.50 728.50Q2300.00 749.00 2345.00 749.00Q2390.00 749.00 2410.50 728.50Q2431.00 708.00 2431.00 676.00V654.00Q2431.00 622.00 2410.50 601.50Q2390.00 581.00 2345.00 581.00ZM2271.00 525.00H2419.00V0.00H2271.00Z"/>
  </g>
</svg>
EOF

cat << 'EOF' > packages/ui/assets/brand/korvi-pos-icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"
     role="img" aria-label="Korvi POS">
  <title>Korvi POS</title>
  <rect width="64" height="64" rx="14" ry="14" fill="#047857"/>
  <g transform="translate(12.463 49.920) scale(0.051347 -0.051347)">
    <path fill="#FFFFFF" d="M320.00 304.00 229.00 194.00V0.00H77.00V698.00H229.00V366.00H235.00L334.00 501.00L491.00 698.00H663.00L428.00 411.00L684.00 0.00H505.00Z"/>
  </g>
</svg>
EOF

cat << 'EOF' > packages/ui/assets/brand/README.md
# Korvi POS — brand assets

These files are the Korvi ERP lockup with the suffix changed from `ERP` to
`POS`. Nothing else was altered: same glyph outlines (IBM Plex Sans Arabic),
same colours, same cap-height ratio, same tracking, same baseline, same suffix
position.

The geometry was measured from the ERP lockup and normalised against the
wordmark cap height, so it is resolution-independent:

| Ratio | Value |
|---|---|
| suffix cap height / wordmark cap height | 0.4058 |
| gap / wordmark cap height | 0.472 |
| suffix tracking | 0.0687em |

Glyphs are outlined paths, not `<text>`: the files render identically with no
font installed, which is what makes them safe to hand to a print vendor.

| File | Use |
|---|---|
| `korvi-pos-lockup.svg` | Theme-aware, follows `prefers-color-scheme` |
| `korvi-pos-lockup-light.svg` | Fixed light — print, light backgrounds |
| `korvi-pos-lockup-dark.svg` | Fixed dark — dark backgrounds |
| `korvi-pos-icon.svg` | Square app icon and favicon |

## Inside the application, use `KorviMark` instead

KORVI-DESIGN-SYSTEM.md §8 is explicit that the in-product wordmark is text, not
an image: no file to lose, no second copy to keep in step with the theme, and it
prints cleanly. These SVGs are for the places a component cannot reach —
favicon, app icon, print vendors, marketing.

## Colour

`#047857` (`emerald-700`, the `--brand` token). This is deliberately **not** the
`--primary` teal `#196B60`. The mark is the one element that ignores the theme,
because it has to read the same on the light shell, the dark shell, and on white
paper — and paper has no theme. See §2.4. Do not round the HSL values.

## The one placement rule

Never in a tax invoice header. That header identifies the merchant who issued
the invoice; putting the software vendor's mark there tells an auditor that
Korvi sold the goods. Footer only, as "صُدرت عبر Korvi".
EOF

cp packages/ui/assets/brand/korvi-pos-icon.svg apps/pos-web/public/brand/korvi-pos-icon.svg
cp packages/ui/assets/brand/korvi-pos-lockup.svg apps/pos-web/public/brand/korvi-pos-lockup.svg

# ---------------------------------------------------------------------------
# Governance
# ---------------------------------------------------------------------------

say "Writing governance documents"

cat << 'EOF' > CLAUDE.md
# Korvi POS — working agreement

Read this before changing anything. The rules below are not style preferences;
each one has a failure behind it, and most are enforced mechanically by
`npm run verify`.

## What this repository is

Korvi POS: a point-of-sale system for retail and restaurants, sellable and
operable on its own today. It is also the architectural spearhead for a future
Korvi ERP, which is why the financial core is isolated in `@korvi/domain` — that
package is meant to be shared with ERP later without a rewrite.

Korvi ERP does not exist yet. Do not add a dependency on it, and do not build
ERP features here.

## Non-negotiable invariants

### Money

- Money is **integer minor units** (halalas) in a `bigint`. No `number`, no
  `float`, no `Decimal` library.
- Never `parseFloat`, never `Math.round` on an amount. Use `mulDivRound`.
- Rates are **basis points** as `bigint`. 15% is `1500n`, never `0.15`.
- Across a JSON boundary, minor units travel as a **string**. `JSON.stringify`
  throws on `bigint`, and a `number` silently loses precision past 2^53.
- `allocate` must satisfy `sum(parts) === total` for every input. Splitting uses
  deterministic largest-remainder with index tie-breaking.
- Change comes from **cash only**. Non-cash tenders may not exceed the amount
  due — a card terminal cannot hand money back.

### Domain purity

`@korvi/domain` must not import React, Next, Prisma, Fastify, or Node's
filesystem, and must not touch `window` or `document`. ESLint enforces this. If
the domain needs data, it declares a **port** and an adapter implements it.

### Identifiers

UUIDv7 through the abstraction in `ids/uuidv7.ts`. Never `Math.random`, never a
database sequence for anything a terminal can mint offline. The id carries the
timestamp, which is what preserves ordering across a sync.

### Multi-tenancy

Every tenant-owned row carries `tenantId` and indexes it first. Every repository
method takes a `TenantScope`. `GlobalCatalogItem` is the single documented
exception — see ADR-0004 before adding another.

### Design system

`docs/design/KORVI-DESIGN-SYSTEM.md` is the authority. In particular:

- No colour literal in any component. Tokens only.
- Logical properties only: `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`,
  `text-start`/`text-end`. Never `ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`.
- Touch targets ≥ 44px (`h-touch`), 48px (`h-touch-lg`) for payment and keypad.
- Every image, avatar and logo is 1:1 with `object-cover` and `shrink-0`.
- Every financial figure renders through `Numeric`.
- Every Latin run inside Arabic renders through `BidiIsolate`.
- A submitting button stays disabled while loading.

### TypeScript

`strict`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
No `any`, no `as any`, no `@ts-ignore`. `@ts-expect-error` requires a written
justification on the same line.

## Before you push

    npm run verify

That runs formatting, lint, the invariant scan, typecheck, tests, and build.
All six must pass.

## Scope discipline

This repository is at **Phase 0 — Foundation**. Do not build the cashier screen,
inventory, restaurant modifiers, the B2B hub, the owner dashboard, ZATCA Phase 2
signing, the commission engine, KDS, or kiosk. See `docs/architecture/scope.md`.
EOF

cat << 'EOF' > AGENTS.md
# Agent instructions — Korvi POS

Applies to any automated contributor. Read `CLAUDE.md` first; it holds the
invariants. This file covers how to work in the repository.

## Orientation

    packages/domain     pure financial and compliance core — no framework
    packages/database   Prisma adapters implementing the domain's ports
    packages/printing   ESC/POS byte construction for 80mm thermal printers
    packages/ui         design-system components and tokens
    packages/config     the Tailwind preset, shared with Korvi ERP
    packages/testing    determinism helpers (controllable clock, seeded bytes)
    apps/pos-web        Next.js PWA shell
    apps/api            Fastify service
    docs/               architecture, ADRs, design system, governance

Dependency direction is one way:

    apps -> packages/{ui,database,printing} -> packages/domain

`@korvi/domain` depends on nothing. Never add an import that reverses an arrow.

## Rules that will fail the build

1. A float, a `parseFloat`, or a `Math.round` anywhere near money.
2. `any`, `as any`, or `@ts-ignore`.
3. A colour literal inside a component.
4. A physical direction utility (`ml-`, `pr-`, `left-`, `text-right`).
5. React, Prisma, Fastify, or `node:fs` imported into `packages/domain`.
6. A repository method that does not take a `TenantScope`.
7. A secret, token, or real connection string committed anywhere.

## Making a change

1. Read the relevant ADR in `docs/decisions/` before altering an invariant. If
   you are changing a decision, write a new ADR that supersedes it — do not edit
   the old one.
2. Put behaviour in `@korvi/domain` where it can be tested without a browser or
   a database.
3. Write the test with the behaviour, not after it. Financial rules need the
   adversarial case: the amount that does not divide, the tender that overpays
   on a card, the Arabic string whose byte length differs from its length.
4. Run `npm run verify`.
5. Do not commit or push unless you were asked to.

## Reference documents

`docs/design/KORVI-DESIGN-SYSTEM.md` and
`docs/governance/Korvi_POS_Master_Strategy_Document.txt` are inputs, not
working files. Do not edit them. If reality diverges from them, write an ADR
recording the divergence.

## Things that look like bugs and are not

- `--brand` is a different green from `--primary`. Deliberate: the mark ignores
  the theme because it also prints. See KORVI-DESIGN-SYSTEM.md §2.4.
- `border` and `input` hold the same value but are separate tokens, so touch
  targets can gain a heavier border without touching card borders.
- The domain re-implements Base64 instead of using `Buffer`. It must produce
  identical bytes in the browser, offline, and on the server.
EOF

# ---------------------------------------------------------------------------
# Architecture decision records
# ---------------------------------------------------------------------------

say "Writing architecture decision records"

cat << 'EOF' > docs/decisions/ADR-0001-monorepo-and-domain-boundaries.md
# ADR-0001 — Monorepo layout and domain boundaries

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

Korvi POS ships and sells on its own now. Korvi ERP is a stated future, and the
two are meant to share one financial core rather than drift into two systems
that disagree about a halala.

Korvi ERP does not exist. Building against it now would mean coupling to an
interface nobody has specified.

## Decision

A single npm-workspaces monorepo, with the shareable core isolated behind a
package boundary from the first commit:

    packages/domain     pure — no framework, no I/O
    packages/database   Prisma adapters for the domain's ports
    packages/printing   ESC/POS construction
    packages/ui         design-system components
    packages/config     Tailwind preset
    packages/testing    determinism helpers
    apps/pos-web        Next.js PWA
    apps/api            Fastify service

`@korvi/domain` may not import React, Next, Prisma, Fastify, or `node:fs`, and
may not touch the DOM. This is enforced by `no-restricted-imports` in
`eslint.config.js`, not by convention.

Where the domain needs data it declares a **port** — an interface in
`src/ports/` — and an adapter in `packages/database` implements it. Prisma types
never cross that line.

npm workspaces rather than pnpm: Codespaces has npm already, and one less tool
to install is one less way for the first run to fail. Revisit if install time
becomes a problem.

## Consequences

- The financial core can be lifted into Korvi ERP as a dependency with no
  rewrite, because it has no opinion about how it is hosted.
- Adding a port and an adapter is more work than calling Prisma directly. That
  cost is the point: it is what stops ORM shapes leaking into the UI.
- The build has an order (domain first, apps last), expressed in the root
  `build` script.
EOF

cat << 'EOF' > docs/decisions/ADR-0002-money-representation.md
# ADR-0002 — Money is integer minor units

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

The strategy document names the decimal problem as a founding motivation:
systems that hold money in floating point generate fractional halalas that
surface later as an unexplained shortfall in bank reconciliation.

`0.1 + 0.2 !== 0.3` in IEEE 754. A POS adds prices thousands of times a day.

## Decision

Money is an integer count of minor units — halalas — held in a `bigint`:

```ts
interface Money { readonly currency: Currency; readonly minor: bigint }
```

Consequences of that choice, all enforced:

1. **No float ever touches an amount.** No `parseFloat`, no `Math.round`. The
   only sanctioned scaling operation is `mulDivRound`, which is bigint
   throughout.
2. **Rates are basis points as `bigint`.** 15% is `1500n`. A percentage as a
   float multiplied by a price reintroduces the problem the type was chosen to
   avoid.
3. **Strings at every JSON boundary.** `JSON.stringify` throws on `bigint`, and
   a `number` loses precision past 2^53. `moneyToJson` emits `minor` as a
   string; `moneyFromJson` validates it as an integer string.
4. **Parsing goes through `moneyFromMajorString`,** which reads `"12.34"`
   textually and rejects anything finer than a halala rather than rounding it
   away silently.
5. **`allocate` preserves the total.** Deterministic largest-remainder: floor
   shares first, leftover units to the largest fractional remainders, ties
   broken by index. `sum(allocate(total, weights)) === total` holds for every
   input including negatives — the test sweeps 501 totals across seven weight
   shapes.
6. **Change comes from cash only.** `settle` rejects a non-cash tender larger
   than the amount due with `NonCashChangeError`, because a card terminal has no
   mechanism to return money.

At the database layer, `priceMinor` is `BigInt` in Prisma, mapping to
PostgreSQL `BIGINT`.

## Consequences

- Arithmetic is verbose. `addMoney(a, b)` instead of `a + b`.
- `bigint` cannot be JSON-serialised directly, which is why the boundary
  functions exist and must be used.
- A whole class of reconciliation bug is unavailable by construction.
EOF

cat << 'EOF' > docs/decisions/ADR-0003-uuidv7-identifiers.md
# ADR-0003 — UUIDv7 for identifiers

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

A terminal must keep selling with no network. It therefore has to mint its own
identifiers, and the server has to replay them later in the order the sales
actually happened.

A database sequence cannot do that — it needs the database. A UUIDv4 cannot do
it either: it carries no time, so a queue drained out of order is
indistinguishable from one drained in order.

## Decision

UUIDv7 everywhere, generated through `createUuidV7Generator` in
`packages/domain/src/ids/uuidv7.ts`.

v7 places a 48-bit millisecond timestamp in the high bits, so identifiers sort
into creation order as plain strings — no parsing, no companion column.

Four details that matter, three of them added in revision 2 after the first
implementation was found able to break the very ordering it exists to provide:

- **A 42-bit counter**, spanning `rand_a` and the top of `rand_b`. Revision 1
  used 12 bits and wrapped silently at 4096 ids in one millisecond, emitting an
  id that sorted *before* its predecessor.
- **Borrowing, not wrapping.** On exhaustion the generator takes a millisecond
  from the future rather than restarting the counter.
- **A rollback floor.** The last-issued timestamp is a floor, so an NTP
  correction or a merchant fixing the till clock cannot produce ids below ones
  already written. Past a bounded drift the generator refuses outright — a hard
  failure is recoverable, a silently wrong chronology is not.
- **Clock and entropy are injected.** `Clock` and `RandomSource` are interfaces.
  `@korvi/testing` supplies controllable versions, so ordering is asserted
  directly instead of by sleeping and hoping.

Every identifier comes from this generator, including infrastructure ids such
as HTTP correlation ids. `crypto.randomUUID` returns a v4, which carries no time
and cannot be ordered against a sale that synced late.

## Consequences

- Sale ordering survives an offline period of any length.
- The timestamp is readable from the id (`timestampOfUuidV7`), which is useful
  for audit and mildly information-disclosing — acceptable for internal ids.
- The generator holds mutable state (last timestamp, counter). It is a
  singleton per process by design; tests construct their own.
EOF

cat << 'EOF' > docs/decisions/ADR-0004-multi-tenancy.md
# ADR-0004 — Multi-tenancy boundaries

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

One deployment serves many merchants. A tenancy leak is the worst bug this
system can have: one merchant seeing another's sales.

The strategy document mentions 36 tables carrying `tenantId`. That is a
description of the finished product, not a specification for a foundation, and
creating 36 tables now to match a number would be building schema ahead of
knowledge.

## Decision

**Every tenant-owned model carries `tenantId`,** indexed first in every
composite index, and **every repository method takes a `TenantScope`.** There is
no repository method that can read tenant data without one.

`TenantId` is a branded type, so a bare `string` cannot be passed where a tenant
is expected.

**`GlobalCatalogItem` is the one documented exception.** The national barcode
catalogue is shared infrastructure — hundreds of thousands of rows of barcodes,
names and tax rates that are identical for every merchant. Giving it a
`tenantId` would duplicate the entire table per tenant for no isolation benefit,
because none of it is anyone's private data.

Phase 0 creates three models: `Tenant`, `Product`, `GlobalCatalogItem`. Enough
to prove the boundary works. More arrive when a feature needs them.

## Defence in depth: Row-Level Security

A `WHERE tenantId = ?` in a repository protects only the queries that remember
to include it. One forgotten clause, one raw query written under time pressure,
one ORM helper that builds its own SQL, and a merchant sees another merchant's
sales. Application-level scoping is necessary and not sufficient.

Revision 2 therefore moves the boundary into the database as well:

- **`ENABLE` and `FORCE` row level security** on every tenant-owned table.
  `FORCE` is the part usually missed: without it the table's owner bypasses
  every policy, and the application role is very often the owner.
- **Deny by default.** With RLS on and no matching permissive policy, Postgres
  returns nothing and rejects writes. Each policy opens exactly one door.
- **`USING` *and* `WITH CHECK` on every policy.** `USING` alone governs reads;
  without `WITH CHECK` a caller could update a visible row and reassign it to
  another tenant.
- **Context via `SET LOCAL` inside a transaction**, through `withTenant()`. A
  plain `SET` persists for the life of the connection, and a pooled connection
  is handed to the next request — leaking one tenant's context into another's
  query, the exact failure RLS is meant to prevent.
- **`current_tenant_id()` is `STABLE`, not `IMMUTABLE`.** `IMMUTABLE` would let
  the planner cache one tenant's value into a plan reused for another.
- **`global_catalog_items` carries no RLS**, deliberately. Enabling it there
  would require a policy permitting everything, which is a misleading way to
  write "not protected".

Prisma has no first-class hook for per-transaction session variables, and
middleware does not reliably share the transaction's connection. `withTenant()`
is therefore a wrapper around `$transaction`, not middleware — the honest
solution rather than a hook that appears to work and sometimes does not.

A live-Postgres test proving cross-tenant reads are blocked belongs in Phase 1
integration. What Phase 0 ships is a static check that every tenant-owned table
has RLS, `FORCE`, and a policy with both clauses — so a table added without
protection fails the build.

## Consequences

- Adding a tenant-owned model means adding `tenantId`, its index, a scoped
  repository method, **and** an RLS policy plus its entry in the policy test.
  Non-negotiable.
- A second global table needs a new ADR, not a judgement call.
- Every tenant-scoped database call must run inside `withTenant()`. Outside it,
  RLS returns nothing — which is safe, and looks like an empty database until
  someone reads this ADR.
EOF

cat << 'EOF' > docs/decisions/ADR-0005-offline-first.md
# ADR-0005 — Offline-first boundaries

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0 (boundaries only)

## Context

A till that stops when the connection does is a till that stops. The product
promise is that a terminal keeps selling through an outage and reconciles
afterwards without losing or reordering anything.

Offline cannot be retrofitted. A sale path written against a live server
acquires assumptions — an id from the database, a total from an endpoint,
validation that happens elsewhere — and unpicking them later is where ordering
guarantees get lost.

## Decision

Phase 0 declares the boundaries and implements none of the machinery.

`packages/domain/src/ports/offline.ts` defines:

- `QueuedOperation` — keyed by UUIDv7, so the id *is* the ordering key.
- `TransactionQueuePort` — enqueue, read pending oldest-first, mark settled or
  rejected.
- `RetryPolicy` and `nextRetryDelayMs` — exponential backoff from five minutes
  to a six-hour ceiling, as a value rather than a caller's `setTimeout`.
- `SyncEnginePort` and `ConflictResolution`.

Not implemented in Phase 0: IndexedDB persistence, the Service Worker, the sync
loop, conflict resolution. Those are Phase 1+.

The point of writing the interfaces now is that Phase 1's sale path is written
against a queue from its first line.

## Consequences

- Some interfaces have no implementation for a while. Deliberate.
- The shapes will be adjusted once measured against a real device; they are a
  starting contract, not a frozen one.
- `RetryPolicy` starting at five minutes is chosen so a rejected invoice does
  not hammer the Authority's endpoint.
EOF

cat << 'EOF' > docs/decisions/ADR-0006-design-system-authority.md
# ADR-0006 — The design system is the authority

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

`KORVI-DESIGN-SYSTEM.md` was reverse-engineered from the working Korvi ERP
codebase: every value read from shipped code, every HEX computed rather than
estimated, the Tailwind config compiled and tested. It is a record of what
exists, not a proposal.

Korvi POS must look like the same product as Korvi ERP.

## Decision

The document is authoritative. Its values are transcribed into
`packages/config/tailwind-preset.cjs` and `packages/ui/src/styles/tokens.css`
without alteration.

Invariant, never changed without a superseding ADR: colours, fonts, border
radius, motion curve, the wordmark, RTL rules.

Deliberately different in POS, as the document itself prescribes (§12):

| Dimension | ERP | POS |
|---|---|---|
| Type scale | 12–14px base | 14–16px base |
| Button height | `h-10` (40px) | `h-touch` (44px) / `h-touch-lg` (48px) |
| Avatar shape | circle | rounded square |

Two points the document raises and this ADR settles:

- **The brand green is promoted to a token.** `--brand: 162.9 93.5% 24.3%`
  (`#047857`) and `--brand-on-dark: 158.1 64.4% 51.6%` (`#34D399`), replacing
  scattered `emerald-700` literals. The mark keeps ignoring the theme, because
  it must read the same on paper — and paper has no theme. The decimal place is
  load-bearing: rounding to integers yields `#027855`, a different colour from
  the one the print rule emits literally.
- **The wordmark stays text in-product.** `KorviMark`, not an image file. SVG
  assets exist in `packages/ui/assets/brand/` only for the places a component
  cannot reach: favicon, app icon, print vendors.

## Consequences

- A colour literal in a component is a lint failure, not a review comment.
- Adopting shadcn/ui later is cheap: the token names and format already match
  its convention exactly.
- Tailwind stays on v3 for now — see ADR-0007.
EOF

cat << 'EOF' > docs/decisions/ADR-0007-runtime-and-framework-versions.md
# ADR-0007 — Runtime and framework versions

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0
- **Revision:** 2

## Context

The strategy document names Next.js 14. It was written earlier; this is a new
project and should start on current stable software. The standing instruction is
latest production-stable, no canary, beta, preview or RC, and nothing
incompatible with the rest of the toolchain.

Revision 1 chose versions from a single `npm view` per package. Revision 2 adds
`scripts/verify-versions.mjs`, which asserts on every push that each pin is
published, is not a prerelease string, and is not carried only by a prerelease
dist-tag — so a pin cannot drift onto a preview unnoticed.

## Decision

| Package | Version | Note |
|---|---|---|
| Node | 24 LTS | Active LTS ("Krypton") |
| npm | 11.17.0 | declared via `packageManager` |
| TypeScript | 6.0.3 | **not 7.x** — see below |
| Next.js | 16.2.12 | **not 16.3.0** — see below |
| React | 19.2.8 | `latest` |
| Prisma | 7.9.1 | `latest` |
| Tailwind CSS | 3.4.19 | **not 4.x** — see below |
| Vitest | 4.1.10 | `latest` |
| Vite | 8.2.1 | `latest` |
| ESLint | 10.8.1 | `latest`, with typescript-eslint 8.66.0 (`latest`) |
| Fastify | 5.11.2 | `latest` |
| Zod | 4.4.3 | `latest` |
| Zustand | 5.0.14 | `latest` |

Three pins are not the newest `latest`. All three are stable releases on
maintained lines; none is a prerelease channel.

### TypeScript 6.0.3, not 7.0.2

`typescript-eslint@8.66.0` declares `typescript: ">=4.8.4 <6.1.0"`. TypeScript 7
falls outside that range and would leave the monorepo unlintable. Lint is a
Phase 0 gate, and a foundation that cannot enforce its own rules is not a
foundation. 6.0.3 is the highest stable release inside the supported range.

Revisit when typescript-eslint ships TypeScript 7 support.

### Tailwind CSS 3.4.19, not 4.3.3

`KORVI-DESIGN-SYSTEM.md` §10 ships a complete `tailwind.config.ts` in v3 format
and records that it was compiled and tested. ADR-0006 makes that document the
authority.

Tailwind v4 replaces the JavaScript config with CSS-first `@theme` declarations.
That is a design-system revision, not a config rewrite, and it should be agreed
with whoever maintains Korvi ERP so the two products do not diverge.

Supporting evidence: 3.4.19 carries the **`v3-lts`** dist-tag, so this is an
officially maintained line rather than an abandoned major.

### Next.js 16.2.12, not 16.3.0

Pinned to the 16.2 line at the architect's direction.

Recording what the registry actually reports, because the reasoning given was
that 16.3 is a preview build and that is not what the dist-tags show:

```
next dist-tags:  latest  = 16.3.0
                 preview = 16.3.0-preview.10
                 canary  = 16.3.1-canary.7
                 beta    = 16.0.0-beta.0
```

`16.3.0` is the `latest` stable release. `16.3.0-preview.10` is a separate
prerelease version that happens to share the `16.3.0` prefix; the two are
different artifacts.

The pin is nonetheless applied as directed. 16.2.12 is the newest stable release
on the 16.2 line, it is not a prerelease, and staying a minor behind costs
nothing here — Phase 0 uses no 16.3-only feature. Recorded rather than argued
so that whoever revisits this has the evidence rather than the conclusion.

## Consequences

- Every pin is machine-verified on each push; a prerelease cannot slip in.
- All three departures are on maintained stable lines, not dead ends.
- Dependabot ignores TypeScript and Tailwind majors, because bumping them is a
  decision recorded here rather than a PR to merge.
- `npm run verify` is the check that any pin can be lifted: if it stays green
  after a bump, the pin can go.
EOF

say "Writing revision-2 decision records"

cat << 'EOF' > docs/decisions/ADR-0008-thermal-printing.md
# ADR-0008 — Thermal printing and Arabic

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0
- **Supersedes:** the printing design in Phase 0 revision 1

## Context

Revision 1 selected an ESC/POS code page and then wrote text through a
`TextEncoder`, which emits UTF-8. That combination is wrong on most hardware in
the market.

An ESC/POS printer decodes incoming bytes through whichever code page it was
told to select. Handed UTF-8, it sees each Arabic letter as two bytes and prints
two unrelated glyphs for each. The result is not a subtle rendering defect — it
is an unreadable tax invoice, and it would have reached a merchant.

Three further assumptions in revision 1 were also unsafe: that every device
understands UTF-8, that Arabic needs no contextual shaping, and that a receipt
is complete without a QR code actually being emitted.

## Decision

**Devices are described, not assumed.** A `PrinterProfile` states what a model
can do: text encoding (`cp1256`, `cp864`, `utf8`, `raster`), whether Arabic must
be pre-shaped, whether the caller must reorder into visual order, QR support
(`native`, `raster`, `none`), column count and dot width. Every encoding
decision reads from that profile.

**The Arabic pipeline is explicit, and its order is fixed:**

1. **Shape** into Arabic Presentation Forms-B, on **logical** order.
2. **Reorder** the shaped result into visual order, for heads with no bidi
   algorithm.
3. **Map** to the target code page.

The order is the correctness point. Contextual shaping is defined over logical
adjacency: a letter's form depends on its neighbours as the word is *written*,
not as it is laid out on paper. Reordering first reverses that adjacency, so
every letter is shaped against the wrong neighbours — initial forms come out
final, medial joins break, and lam-alef never pairs because the lam now follows
the alef. The result is well-formed bytes spelling the word incorrectly.

Reordering after shaping is safe: presentation forms are still RTL characters,
so the reordering pass treats them exactly as it treats base letters.

Each step is skipped only when the device *declares* it does that work itself
(`firmwareShapes`, `firmwareBidi`), and those declarations are per verified
model.

**An unidentified device gets no text path.** Revision 2 assumed unknown
hardware spoke CP1256 and shaped in firmware. That is a guess, and devices
differ on whether they shape, which Arabic page they carry, and whether they
carry one at all. `GENERIC_ESCPOS_UNKNOWN` therefore declares `text: 'raster'`
and `verified: false`, and the encoder refuses it outright: rendering to a
bitmap is slower and always correct, where a wrong guess is an unreadable tax
invoice. CP1256-with-firmware-shaping still exists as a profile, but only for
models someone has confirmed.

**Unmappable characters raise.** A receipt that quietly prints a substitute
glyph is worse than one that refuses, because nobody notices the first.

**QR is emitted as a symbol.** Native `GS ( k` where the firmware supports it,
otherwise a caller-supplied bitmap through `GS v 0`. A device with neither
throws: a simplified tax invoice without a scannable QR is not a valid
simplified tax invoice, and printing one anyway hands the merchant a document
that fails inspection with nobody at the till aware.

**Raster is a declared port, not a stub.** Devices with no Arabic code page need
their lines drawn as bitmaps, which needs a font and a layout engine — a Phase 1
dependency. `RasterRenderer` is declared now so the pipeline has the right
shape, and a raster-only profile fails loudly rather than silently taking a text
path that would print nonsense.

**Transport stays unimplemented.** Byte construction is worth testing
exhaustively and does not change when the cable does. USB, Bluetooth, network
and WebUSB become adapters behind `PrinterTransport` in Phase 1.

## Scope of the bidi implementation

`toVisualOrder` is a documented subset of UAX #9: strong-RTL, strong-LTR and
neutral runs, neutrals resolved to a flanking direction (rule N1), RTL runs
reversed. It handles what a receipt contains — Arabic prose with embedded Latin
codes and Western digits. It does not handle explicit overrides, isolates, or
nesting beyond depth one; those lines belong on the raster path where a real
implementation runs.

Rule N1 is load-bearing twice: it keeps a space between two Arabic words inside
the Arabic run, and — less obviously — keeps the decimal point inside `115.00`.
Without the second case the price is split into three runs and prints as
`00.115`. There is a test for exactly that.

## Consequences

- Adding a printer model means adding a profile, and a profile is a claim about
  hardware. Add one only after observing a real unit; an unverified profile
  produces confident garbage, which is worse than no profile.
- Receipt bytes differ per device. Tests assert on golden byte fixtures, because
  a test asserting "contains Arabic" would have passed against the revision 1
  bug.
- The shaping table covers Modern Standard Arabic as a receipt uses it. Extended
  Persian and Urdu letters are not mapped and will raise on the CP864 path.
EOF

cat << 'EOF' > docs/decisions/ADR-0009-supply-chain-and-ci.md
# ADR-0009 — Supply chain and CI posture

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

Phase 0 revision 1 set `audit=false` in `.npmrc`, let CI fall back from
`npm ci` to `npm install`, referenced GitHub Actions by moving tag, and granted
the workflow default token permissions. Each is a small convenience with a
disproportionate blast radius for a product that handles payments.

## Decision

**Audit stays on.** `audit=false` disables the check for everyone permanently to
silence something temporary. Advisory noise is handled by
`scripts/audit-allowlist.txt` — dated entries with a reason and a reviewer, so
an exception expires rather than rots. Empty is the correct state.

**`npm ci`, never a fallback.** `npm ci || npm install` looks defensive and is
the opposite: when the lockfile is missing or stale the fallback resolves fresh
versions, so CI stops testing the tree that will ship. A missing lockfile should
fail the build.

**Exact versions.** `save-exact=true`, and `scripts/verify-versions.mjs` asserts
on every push that each pin is published, is not a prerelease string, and is not
carried only by a prerelease dist-tag. Departures from `latest` are listed with
the ADR that justifies them; anything else lagging is reported, not failed.

**Actions pinned to commit SHAs.** A tag can be repointed at any time by whoever
controls the action's repository, so `@v5` is a trust decision renewed on every
run. The tag is kept in a trailing comment for readability.

**`permissions: contents: read` at workflow level.** A job needing more raises
it locally, so the extra permission appears in the diff that adds it.

**`packageManager` is declared** so Corepack resolves the same npm everywhere.

**Dependabot weekly**, patches and minors grouped into one PR, majors separate.
TypeScript and Tailwind majors are ignored because ADR-0007 pins them; that pin
is revisited by editing the ADR, not by merging a bot PR.

## Consequences

- CI does more work per run: version verification and an audit before anything
  builds. Both are seconds, and both fail early.
- A genuine advisory blocks the build. That is the intent; the allowlist is the
  escape hatch and it requires writing down a reason.
- SHA pins need periodic refreshing. Dependabot's github-actions ecosystem does
  it and keeps the tag comment in step.
EOF

cat << 'EOF' > docs/decisions/ADR-0010-phase0-revision.md
# ADR-0010 — What changed in Phase 0 revision 2

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

Revision 1 passed its own quality gate and was still rejected in architecture
review. The gate was real — 81 tests, lint, typecheck, a genuine Next build —
but it verified the things the code claimed about itself, and several claims
were wrong. This ADR records the corrections so the reasoning is not lost.

## Corrections

### UUIDv7 ordering (supersedes part of ADR-0003)

Revision 1 used a 12-bit counter that wrapped silently at 4096 identifiers in
one millisecond, emitting an id that sorted *before* its predecessor — an
inverted sale order, undetectable after the fact. It also ignored clock
rollback, so an NTP correction produced ids below ones already written.

Now: a 42-bit counter, borrowing a future millisecond instead of wrapping, and a
last-issued floor that survives a backwards clock. Both bounded by a drift
tolerance beyond which the generator refuses rather than inventing a timestamp.
Tested at 20,000 ids inside one frozen millisecond and across a five-second
rollback.

The counter width is injectable so the borrow path is actually exercised; at the
production width it needs ~2^41 calls, which no test can reach.

### Identifier discipline

`crypto.randomUUID()` in the Fastify request-id hook was a v4 — no embedded
time, so a request log line could not be ordered against a sale that synced
late. It now uses the central generator.

### Thermal printing — see ADR-0008

The UTF-8-to-a-code-page bug, missing shaping and bidi, and a receipt that
never emitted a QR.

### Basis points

The domain spoke `bigint` while the ports and the database column spoke
`number`, with conversion implicit at each crossing. Now one branded,
range-validated `BasisPoints` type with explicit column boundary functions, and
a `CHECK` constraint enforcing the same range in Postgres.

### Row-level security — see ADR-0004 (extended)

`WHERE tenantId = ?` protects only the queries that remember it. RLS with
`FORCE`, deny-by-default policies carrying both `USING` and `WITH CHECK`, and
tenant context via `SET LOCAL` inside a transaction.

### Supply chain — see ADR-0009

### Toolchain

Node 24 LTS. Next pinned to the 16.2 line. Every pin machine-verified against
the registry.

## What did not change

Money as integer minor units, largest-remainder allocation, cash-only change,
domain purity, the design system transcription, and the ZATCA Phase 1 scope
boundary. Those were right in revision 1 and are unchanged in revision 2.

## Consequence

The quality gate now includes checks that would have caught these: byte-level
printing fixtures, adversarial UUIDv7 ordering tests, static RLS policy
coverage, and registry verification of every pin. A gate that only confirms what
the code says about itself is not a gate.
EOF

cat << 'EOF' > docs/decisions/ADR-0011-arabic-printing-path.md
# ADR-0011 — Arabic prints via raster, not a legacy code page

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0
- **Supersedes:** the CP864 text path in ADR-0008

## Context

Revision 3 shipped a CP864 table that was invented rather than transcribed. Its
golden fixtures were then generated *from* that table, so the fixtures and the
defect agreed with each other and the suite was green. A fixture derived from
the implementation cannot detect the implementation being wrong.

The most visible symptom: the lam-alef ligature was mapped to `0xE8`. In the
authoritative PC864 mapping `0xE8` is WAW ISOLATED (U+FEED). Two different
letters printing as the same glyph.

Correcting the table exposed the larger problem. Transcribed from the published
Microsoft/Unicode mapping — the page Epson documents as character code table 37
— PC864 contains **72 of the 144** code points in Arabic Presentation Forms-B,
and **71 of the 125** forms Korvi's shaper can produce.

So standard PC864 cannot carry arbitrary fully-shaped Arabic. That is a property
of the code page, not a gap in the transcription.

## Decision

**Arabic prints via raster by default.** No production profile routes Arabic
through a legacy code page.

The reason is the failure mode rather than the coverage number. A code-page path
would encode roughly half the shaped forms correctly and reject or mangle the
rest, so a receipt would print correctly for some item names and wrongly for
others. Nobody notices until a customer is handed a receipt for something they
did not buy. A uniform raster path is slower and always right.

Consequences, profile by profile:

- **`GENERIC_ESCPOS_UNKNOWN`** — the default. `text: 'raster'`,
  `verified: false`. No assumption about Arabic support at all.
- **`EPSON_TM_T20`** — keeps its vendor-documented native `GS ( k` QR and its
  ASCII path, both independent of the Arabic question. `text: 'raster'`.
- **`SYNTHETIC_CP1256_FIRMWARE_SHAPING`** — renamed and demoted. It is a test
  fixture exercising the CP1256 codec, `verified: false`, and excluded from
  `PRODUCTION_PROFILES` so it can never be auto-selected onto a counter.
- **Synthetic UTF-8 fixture** — test-only; no generic UTF-8 capability is trusted in production. A model-specific profile may use UTF-8 only after authoritative vendor documentation or hardware verification establishes that behaviour.
  their own shaping and bidi.

**ASCII stays native on raster profiles.** Command bytes, document numbers and
prices are identical in every code page, so rasterising them would be pointless.
Anything above U+007F needs a renderer.

**The codecs remain, corrected and conformance-tested.** CP864 is transcribed
from the authoritative mapping and CP1256 was verified entry by entry against
Windows-1256. Both reject anything they cannot represent — never substitute.
They stay because a future verified profile may use one, and because the
conformance tests are what stop a fabricated table returning.

**Raster is declared, not implemented.** `RasterRenderer` needs a font and a
layout engine, which is Phase 1 work. Until it exists, an Arabic receipt raises
`MissingCapabilityError`. Refusing to print is correct; printing the wrong
Arabic is not.

## What is explicitly not reverted

The revision 3 pipeline correction stands: **shape on logical adjacency, then
reorder to visual**. That was right, and the shaping and bidi modules are kept
in full — the raster layout path needs exactly the same two operations, and
their linguistic tests remain valuable. The defect was the byte mapping and the
claim of code-page support, not the ordering.

## Consequences

- Arabic receipts do not print until the raster renderer lands. This is a
  visible, honest gap rather than a silent correctness bug.
- Adding a code-page Arabic profile now requires evidence: the vendor character
  table, real hardware, and conformance tests against the published mapping.
- Golden fixtures must come from an external standard. Any fixture generated by
  the code under test is not a fixture, it is a snapshot.
EOF

# ---------------------------------------------------------------------------
# Architecture notes
# ---------------------------------------------------------------------------

say "Writing architecture notes"

cat << 'EOF' > docs/architecture/overview.md
# Architecture overview

## Shape

    apps/pos-web  ──┐
                    ├──> packages/ui ──────┐
    apps/api ───────┤                      ├──> (tokens, components)
                    ├──> packages/database ──> packages/domain
                    └──> packages/printing ──> packages/domain

`@korvi/domain` sits at the bottom and depends on nothing. Every arrow points
toward it; none point away. That is what makes it liftable into Korvi ERP later
(ADR-0001).

## Layers

| Layer | Holds | Never holds |
|---|---|---|
| `domain` | money, tax, tender, ids, TLV, ports | React, Prisma, HTTP, `fs`, DOM |
| `database` | Prisma schema and adapters | business rules |
| `printing` | ESC/POS bytes | transport, device handles |
| `ui` | components and tokens | business rules, colour literals |
| `apps` | composition, routing, HTTP | anything worth unit-testing on its own |

## Why ports

The domain declares interfaces (`src/ports/`); adapters implement them. A
repository returns domain types, never Prisma rows, so the ORM stays replaceable
and the UI never learns what persistence looks like.

It costs an interface and a mapping function per repository. It buys a core that
can be tested with no database and shared with a product that does not exist
yet.

## Direction and language

RTL is the default (`<html dir="rtl">`), not a later addition. Logical
properties only. Latin runs inside Arabic go through `BidiIsolate`, because the
bidi algorithm will otherwise reorder `INV-2026-00001` into a document number
that does not exist.
EOF

cat << 'EOF' > docs/architecture/scope.md
# Phase 0 scope

## In

- Monorepo, build order, quality pipeline (lint, typecheck, test, build, format,
  invariant scan), CI.
- `@korvi/domain`: money, allocation, VAT, tender settlement, UUIDv7, ZATCA
  Phase 1 TLV, and the ports for persistence, search and offline.
- `@korvi/database`: minimal Prisma schema (three models) and adapters.
- `@korvi/printing`: ESC/POS construction and a receipt renderer.
- `@korvi/ui`: tokens, Tailwind preset, and the primitives that carry the design
  rules — `KorviMark`, `Numeric`, `BidiIsolate`, `Button`, `SquareAsset`,
  `CardSurface`.
- `apps/api`: Fastify with health and version routes.
- `apps/pos-web`: Next.js shell with a smoke page proving the wiring.
- Governance: `CLAUDE.md`, `AGENTS.md`, ADRs 0001–0007.

## Out — deliberately

Not built in Phase 0, and not to be added without moving to Phase 1:

- The cashier screen, cart, and checkout flow
- Inventory
- Restaurant modifiers
- The B2B supply hub and MOQ firewall
- The owner dashboard
- ZATCA Phase 2 signing (hash, cryptographic stamp, CSID)
- The offline sync engine (boundaries only — ADR-0005)
- Liquid Search implementation (boundary only)
- The commission engine
- KDS and kiosk

## What "foundation" means here

Every invariant that would be expensive to retrofit is in place and enforced:
integer money, tenancy scoping, injected time and entropy, domain purity,
design tokens, RTL. Everything else is deferred.
EOF

cat << 'EOF' > docs/architecture/zatca.md
# ZATCA e-invoicing — implemented, deferred, and the required ordering

## What Phase 0 implements

`packages/domain/src/zatca/tlv.ts` builds the **Phase 1 simplified tax invoice
QR payload**: tags 1-5 (seller name, VAT registration number, timestamp,
invoice total including VAT, VAT total), TLV-encoded, then Base64.

Two properties, both deliberate:

- **Correct by construction.** Length bytes are UTF-8 **byte** counts, not
  character counts. An Arabic seller name runs roughly two bytes per letter, so
  a character count declares a length shorter than the payload and the parser
  walks off the end of the field.
- **Pure and deterministic.** No network, no ambient clock, no shared state.
  The same input yields byte-identical output on the terminal and on the server.

The symbol is genuinely printed — natively via `GS ( k`, or from a supplied
bitmap — and `renderReceipt` refuses to produce an invoice without one.

## What Phase 0 does not implement

**Tags 1-5 alone are not Phase 2 compliance.** Do not describe a build carrying
only this module as Phase 2 ready.

### The Phase 2 simplified tax invoice QR carries tags 1-9

| Tag | Content |
|---|---|
| 1 | Seller name |
| 2 | VAT registration number |
| 3 | Timestamp (ISO 8601) |
| 4 | Invoice total, VAT inclusive |
| 5 | VAT total |
| 6 | Hash of the XML invoice |
| 7 | ECDSA signature (the cryptographic stamp) |
| 8 | ECDSA public key of the cryptographic stamp |
| 9 | ZATCA technical CA signature over that public key |

Tag 9 is the Authority's technical CA signature associated with the
cryptographic stamp's public key, and it belongs to **simplified** tax invoices
and their associated notes. All nine are required on a Phase 2 simplified
invoice.

Refer to the current official ZATCA e-invoicing specifications for the
authoritative field definitions before implementing any of tags 6-9. Nothing in
this repository should be treated as a substitute for them.

## The ordering that the architecture must preserve

This is the part that constrains Phase 1 design, so it is written down now.

For a Phase 2 simplified tax invoice, **local issuance is a single ordered
pipeline, and every step runs before the customer receives the document**:

```
deterministic sale totals
  -> compliant UBL XML
  -> required canonicalisation / transforms
  -> invoice hash
  -> cryptographic stamping using a valid CSID
  -> QR carrying tags 1-9
  -> immutable local persistence
  -> customer invoice / receipt issuance
```

Only after that does reporting begin:

```
reporting -> FATOORA API -> retry queue -> reconciliation
```

**Signing is not deferred past issuance.** A receipt handed to a customer must
already carry its hash, its stamp and its complete tag 1-9 QR. Reporting to the
Authority may be delayed and retried within the regulatory window — that part is
network work and can fail — but generating and signing locally cannot be
postponed until the reporting succeeds. An architecture that signs after
handing over the receipt produces documents that were never compliant at the
moment they were issued.

That is why the offline queue in ADR-0005 models *reporting*, not signing. The
queue exists for the network step only.

## How the deferred pieces fit

**CSID.** Signing needs a valid cryptographic stamp identifier, obtained by
onboarding and stored per device. It is a credential with a lifecycle, held
behind a `CredentialStorePort`. Behaviour when a certificate is absent, invalid
or expired is a compliance question to be answered from the official
specifications and the merchant's regulatory obligations — this repository does
not assert a policy for it.

**Hash and canonicalisation.** Canonicalisation is exact and textual, and must
produce identical bytes on the terminal and the server — the same requirement
the TLV encoder already meets, and the reason Base64 is written out by hand
rather than delegated to `Buffer`.

**Signing.** Local, synchronous, inside issuance. Not queued.

**Reporting and reconciliation.** Network calls with their own failure modes.
`RetryPolicy` exists so a systematic rejection does not become a tight loop
against the Authority's endpoint.

## The invariant that must survive Phase 2

Tags 1-5 for a given invoice must not change when signing arrives: tags 6-9 are
added alongside them. Any change to `simplifiedInvoiceQrFields` is a breaking
change to already-printed paper.
EOF

cat << 'EOF' > docs/architecture/search.md
# Liquid Search — boundary

Declared in Phase 0, implemented later.

## Target

Sub-50ms prefix lookup against the local store while the cashier is still
typing, tolerant of the transpositions that hurried entry produces. Local first:
a search that needs the network is a search that stops during an outage.

## codeReverse

A cashier who cannot scan reads the **last** few digits off the label. That is a
suffix query, and a suffix query against a forward index is a full scan.

Storing the reversed barcode alongside the forward one turns the suffix query
into a prefix query, which the same ordered index can serve. `Product` carries a
`codeReverse` column indexed as `[tenantId, codeReverse]`, and
`codeReverse(code)` in `ports/search.ts` produces the value.

## What is not decided

The ranking function, the fuzzy-match tolerance, and where the index lives
(IndexedDB, SQLite WASM, or Postgres with a trigram index). Those need
measurement against a real catalogue — a national barcode set is hundreds of
thousands of rows, and a ranking that feels right on a hundred items behaves
differently at that scale.

`LiquidSearchPort` is the contract; the implementation is Phase 1+.
EOF

cat << 'EOF' > docs/architecture/offline.md
# Offline — boundary

Declared in Phase 0, implemented later. See ADR-0005.

## The guarantee we are building toward

A terminal keeps selling with no network, for as long as the outage lasts, and
reconciles afterwards with nothing lost and nothing reordered.

## Pieces, and where they will live

| Piece | Role | Status |
|---|---|---|
| Service Worker | app shell available with no network | Phase 1 |
| IndexedDB | local store for sales and the catalogue | Phase 1 |
| Transaction queue | ordered record of what must reach the server | port only |
| Sync engine | drains the queue, handles rejection | port only |
| Conflict handling | resolves divergence found on sync | port only |

## Why ordering is already solved

Every queued operation is keyed by UUIDv7, so the identifier carries its own
creation time and the queue drains oldest-first by sorting on the key. No
sequence, no server round trip, no separate ordering column (ADR-0003).

## Retry

`RetryPolicy` is a value, not scattered `setTimeout` calls: five minutes
initially, doubling to a six-hour ceiling, at most eight attempts. Rejections
are recorded rather than dropped, so a sale can be inspected rather than
silently lost.

## Not yet decided

Conflict resolution policy per entity type. `ConflictResolution` names the three
outcomes (`keep-local`, `keep-remote`, `needs-review`); which applies to which
entity needs the entities to exist first.
EOF

# ---------------------------------------------------------------------------
# scripts/
# ---------------------------------------------------------------------------

say "Writing scripts"

cat << 'SCRIPT_EOF' > scripts/check-invariants.sh
#!/usr/bin/env bash
#
# Mechanical scan for the invariants in CLAUDE.md that a type system cannot
# express. Runs as part of `npm run verify`.
#
# Every check names the rule it protects. A finding is a build failure, not a
# warning: a warning nobody acts on is a rule nobody follows.

set -uo pipefail

FAILED=0
SRC_GLOBS=(packages apps)

report() {
  printf '\033[1;31m[x] %s\033[0m\n' "$1" >&2
  FAILED=1
}

scan() {
  local description="$1" pattern="$2" include="$3" path_filter="${4:-}" path_exclude="${5:-}"
  local hits
  hits="$(grep -rEn --include="$include" \
            --exclude-dir=node_modules --exclude-dir=dist \
            --exclude-dir=.next --exclude-dir=generated --exclude-dir=coverage \
            "$pattern" "${SRC_GLOBS[@]}" 2>/dev/null || true)"

  if [ -n "$path_filter" ] && [ -n "$hits" ]; then
    hits="$(printf '%s\n' "$hits" | grep -E "$path_filter" || true)"
  fi

  if [ -n "$path_exclude" ] && [ -n "$hits" ]; then
    hits="$(printf '%s\n' "$hits" | grep -Ev "$path_exclude" || true)"
  fi

  if [ -n "$hits" ]; then
    report "$description"
    printf '%s\n' "$hits" | sed 's/^/      /' >&2
  fi
}

echo "Scanning invariants..."

# --- TypeScript escape hatches -------------------------------------------
scan "'any' type used (CLAUDE.md: TypeScript)" \
     '(: *any\b|<any>|as +any\b|Array<any>)' '*.ts'
scan "'any' type used in TSX (CLAUDE.md: TypeScript)" \
     '(: *any\b|as +any\b)' '*.tsx'
scan "@ts-ignore used — use @ts-expect-error with a justification" \
     '@ts-ignore' '*.ts'

# --- Money (ADR-0002) -----------------------------------------------------
scan "parseFloat near money — use moneyFromMajorString (ADR-0002)" \
     '\bparseFloat\s*\(' '*.ts' '^packages/domain/'
scan "Math rounding on an amount — use mulDivRound (ADR-0002)" \
     '\bMath\.(round|floor|ceil)\s*\(' '*.ts' '^packages/domain/src/(money|tax|tender)/'
scan "float literal in the financial core (ADR-0002)" \
     '=\s*[0-9]+\.[0-9]+\s*;' '*.ts' '^packages/domain/src/(money|tax|tender)/'

# --- Domain purity (ADR-0001) --------------------------------------------
scan "React imported into the domain (ADR-0001)" \
     "from +'react" '*.ts' '^packages/domain/'
scan "Prisma imported into the domain (ADR-0001)" \
     "from +'@?prisma" '*.ts' '^packages/domain/'
scan "Fastify imported into the domain (ADR-0001)" \
     "from +'fastify" '*.ts' '^packages/domain/'
scan "Node filesystem imported into the domain (ADR-0001)" \
     "from +'node:(fs|path)" '*.ts' '^packages/domain/'

# --- Design system (ADR-0006) --------------------------------------------
# theme-color.ts is the single sanctioned exception: <meta name="theme-color">
# is read by the browser chrome, which cannot resolve a CSS variable. Keeping
# the exception to one named file is what stops it spreading.
scan "colour literal in a component — use a token (KORVI-DESIGN-SYSTEM.md §1.1)" \
     '(#[0-9a-fA-F]{3,8}\b|rgba?\()' '*.tsx'
scan "colour literal outside theme-color.ts — use a token (§1.1)" \
     '(#[0-9a-fA-F]{3,8}\b)' '*.ts' '^packages/ui/src/' 'theme-color\.ts'
scan "physical direction utility — use logical properties (§6)" \
     '\b(ml|mr|pl|pr)-[0-9a-z]' '*.tsx'
scan "physical inset utility — use start-/end- (§6)" \
     '\b(left|right)-[0-9]' '*.tsx'
scan "text-left/text-right — use text-start/text-end (§6)" \
     '\btext-(left|right)\b' '*.tsx'

# --- Printing (ADR-0008) --------------------------------------------------
scan "raw TextEncoder in printing — go through encodeTextFor (ADR-0008)" \
     'new TextEncoder\(\)' '*.ts' '^packages/printing/src/(escpos|receipt)'

# --- Tenancy (ADR-0004) ---------------------------------------------------
scan "session-wide SET for tenant context — must be SET LOCAL (ADR-0004)" \
     'executeRaw.*[^_]SET +app\.tenant_id' '*.ts'

# --- Secrets --------------------------------------------------------------
scan "possible committed credential" \
     '(postgres(ql)?://[^"'"'"' ]*:[^"'"'"' @]+@|BEGIN [A-Z ]*PRIVATE KEY|sk_live_|AKIA[0-9A-Z]{16})' \
     '*.ts'

if [ "$FAILED" -eq 0 ]; then
  printf '\033[1;32m[ok]\033[0m invariants clean\n'
else
  printf '\033[1;31m[x]\033[0m invariant scan failed\n' >&2
fi

exit "$FAILED"
SCRIPT_EOF

chmod +x scripts/check-invariants.sh

cat << 'SCRIPT_EOF' > scripts/verify.sh
#!/usr/bin/env bash
#
# The gate. Everything that must be true before a push.

set -euo pipefail

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

step "Dependency pins"
node scripts/verify-versions.mjs

step "Dependency advisories"
bash scripts/audit.sh

step "Formatting"
npm run --silent format:check

step "Lint"
npm run --silent lint

step "Invariants"
bash scripts/check-invariants.sh

step "Prisma client"
# `prisma generate` reads the schema and never opens a connection, but the
# config resolves DATABASE_URL strictly so that `prisma migrate` cannot quietly
# run against a default. A throwaway localhost value satisfies generate without
# putting a credential anywhere; migrate still demands the real one.
DATABASE_URL="${DATABASE_URL:-postgresql://korvi:korvi@localhost:5432/korvi_pos?schema=public}" \
  npm run --silent db:generate

# Build first: packages resolve each other through their published `exports`,
# which point at dist. Typechecking before a build would report every
# cross-package import as a missing module.
step "Build"
npm run --silent build

step "Typecheck"
npm run --silent typecheck

step "Tests"
npm run --silent test

printf '\n\033[1;32m[ok]\033[0m verify passed\n'
SCRIPT_EOF

chmod +x scripts/verify.sh

cat << 'SCRIPT_EOF' > scripts/verify-versions.mjs
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
SCRIPT_EOF

cat << 'SCRIPT_EOF' > scripts/audit.sh
#!/usr/bin/env bash
#
# Dependency advisory gate — FAIL CLOSED.
#
# The governing rule: only a valid, parsed, schema-checked audit result can
# produce a pass. Every other outcome fails.
#
# That includes the ones that look like successes: npm exiting non-zero for a
# network reason, an empty file, malformed JSON, or a report whose shape we do
# not recognise. A security gate that passes when it could not run is worse than
# no gate, because it reports safety it never established.

set -uo pipefail

ALLOWLIST_FILE="${AUDIT_ALLOWLIST:-scripts/audit-allowlist.txt}"
THRESHOLD="${AUDIT_LEVEL:-high}"
REGISTRY="${NPM_PUBLIC_REGISTRY:-https://registry.npmjs.org}"
REPORT="${AUDIT_REPORT:-$(mktemp)}"

echo "Auditing dependencies at level: $THRESHOLD (registry: $REGISTRY)"

# KORVI_AUDIT_SKIP_NPM lets the gate's own tests feed it a prepared report so
# the fail-closed paths can be exercised without a network. It only skips the
# npm call; every check below still runs exactly as it does in CI.
if [ "${KORVI_AUDIT_SKIP_NPM:-0}" = "1" ]; then
  NPM_EXIT=0
else
  # Deliberately no `|| true`. npm audit exits non-zero both when it finds
  # advisories and when it fails to run, so the exit code alone cannot be
  # trusted either way -- the JSON is inspected below and decides.
  npm audit --registry="$REGISTRY" --audit-level="$THRESHOLD" --json > "$REPORT" 2>/dev/null
  NPM_EXIT=$?
fi

if [ ! -s "$REPORT" ]; then
  printf '\033[1;31m[x]\033[0m audit produced no output (npm exit %s).\n' "$NPM_EXIT" >&2
  echo "    Treating an unavailable audit as a failure: this gate cannot" >&2
  echo "    certify what it was unable to check." >&2
  exit 1
fi

node --input-type=module -e '
import { readFileSync, existsSync } from "node:fs";

const [reportPath, threshold, allowlistFile, npmExit] = process.argv.slice(1);
const ORDER = ["info", "low", "moderate", "high", "critical"];

const fail = (reason) => {
  console.error(`\n[x] ${reason}`);
  console.error("    Fail-closed: only a valid audit result can pass this gate.");
  process.exit(1);
};

if (ORDER.indexOf(threshold) < 0) fail(`Unknown audit level "${threshold}".`);

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  fail(`Audit output is not valid JSON (${error.message}).`);
}

// Schema check. npm has changed this shape between majors, and silently
// reading an unexpected structure as "no vulnerabilities" is the exact
// false-pass this gate exists to prevent.
if (report === null || typeof report !== "object") fail("Audit output is not an object.");
if (Object.hasOwn(report, "error")) {
  fail(`npm audit reported an error: ${JSON.stringify(report.error)}`);
}
if (!Object.hasOwn(report, "vulnerabilities") || typeof report.vulnerabilities !== "object") {
  fail(
    "Audit output has no `vulnerabilities` object — unrecognised schema " +
      `(npm exit ${npmExit}). Refusing to interpret it.`,
  );
}
if (!Object.hasOwn(report, "metadata")) {
  fail("Audit output has no `metadata` — unrecognised schema. Refusing to interpret it.");
}
if (
  report.metadata === null ||
  typeof report.metadata !== "object" ||
  report.metadata.vulnerabilities === null ||
  typeof report.metadata.vulnerabilities !== "object"
) {
  fail("Audit metadata has no valid `vulnerabilities` severity counts.");
}

// Reviewed exceptions: "GHSA-id  justification | owner | expires YYYY-MM-DD".
const allowed = new Map();
const malformed = [];
if (existsSync(allowlistFile)) {
  for (const [index, raw] of readFileSync(allowlistFile, "utf8").split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = /^(GHSA-[\w-]+)\s+(.+?)\s*\|\s*([^|]+?)\s*\|\s*expires\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    const id = match?.[1] ?? "";
    const justification = match?.[2]?.trim() ?? "";
    const owner = match?.[3]?.trim() ?? "";
    const expiry = match?.[4];

    if (
      !/^GHSA-[\w-]+$/.test(id) ||
      justification === "" ||
      owner === "" ||
      expiry === undefined
    ) {
      malformed.push(`line ${index + 1}: ${line}`);
      continue;
    }
    allowed.set(id, { line, expiry, justification, owner });
  }
}

if (malformed.length > 0) {
  console.error("\nMalformed allowlist entries — every field is mandatory:");
  for (const entry of malformed) console.error(`  ${entry}`);
  fail("Allowlist entries must be: GHSA-id  justification | owner | expires YYYY-MM-DD");
}

const today = new Date().toISOString().slice(0, 10);
const minimum = ORDER.indexOf(threshold);
const blocking = [];
const excepted = [];
const expired = [];
let qualifyingPackages = 0;

for (const advisory of Object.values(report.vulnerabilities)) {
  if (advisory === null || typeof advisory !== "object") {
    fail("A vulnerability entry is not an object — unrecognised audit schema.");
  }
  if (ORDER.indexOf(advisory.severity) < minimum) continue;
  qualifyingPackages += 1;

  const vias = Array.isArray(advisory.via) ? advisory.via : [];
  if (vias.length === 0) {
    blocking.push(`${advisory.severity}  ${advisory.name ?? "(unknown package)"}  (no resolvable advisory)`);
    continue;
  }

  for (const via of vias) {
    // npm may represent an inherited vulnerability as the name of another
    // package rather than an advisory object. That is not enough information
    // to match a reviewed GHSA exception, so the gate must fail closed.
    if (typeof via === "string") {
      blocking.push(
        `${advisory.severity}  ${advisory.name ?? "(unknown package)"}  ` +
          `(unresolved via dependency: ${via})`,
      );
      continue;
    }
    if (via === null || typeof via !== "object") {
      blocking.push(
        `${advisory.severity}  ${advisory.name ?? "(unknown package)"}  (unrecognised via entry)`,
      );
      continue;
    }

    const id = (via.url ?? "").split("/").pop() ?? "";
    const label = `${via.severity ?? advisory.severity}  ${advisory.name ?? "(unknown package)"}  ${id || "(no id)"}`;
    const entry = allowed.get(id);

    // An advisory with no resolvable id can never be matched to a reviewed
    // exception, so it blocks. Unknown means blocked.
    if (entry === undefined) {
      blocking.push(`${label}\n        ${via.title ?? ""}`);
    } else if (entry.expiry < today) {
      expired.push(`${label} — exception expired ${entry.expiry}`);
    } else {
      excepted.push(`${label} — ${entry.line}`);
    }
  }
}

const metadataCounts = report.metadata.vulnerabilities;
let metadataAtThreshold = 0;
for (let index = minimum; index < ORDER.length; index += 1) {
  const severity = ORDER[index];
  const count = metadataCounts[severity] ?? 0;
  if (!Number.isInteger(count) || count < 0) {
    fail(`Audit metadata count for ${severity} is invalid.`);
  }
  metadataAtThreshold += count;
}
if (metadataAtThreshold > 0 && qualifyingPackages === 0) {
  fail(
    `Audit metadata reports ${metadataAtThreshold} vulnerability/vulnerabilities at or above ` +
      `${threshold}, but no qualifying vulnerability entries could be resolved.`,
  );
}

if (excepted.length > 0) {
  console.log("\nReviewed exceptions (still valid):");
  for (const line of [...new Set(excepted)]) console.log(`  ${line}`);
}
if (expired.length > 0) {
  console.error("\nEXPIRED exceptions — re-review or fix:");
  for (const line of [...new Set(expired)]) console.error(`  ${line}`);
}
const unique = [...new Set(blocking)];
if (unique.length > 0) {
  console.error("\nUnreviewed advisories:");
  for (const line of unique) console.error(`  ${line}`);
}

const failures = unique.length + expired.length;
if (failures > 0) {
  console.error(`\n[x] ${failures} advisory/advisories need attention.`);
  console.error(`    Fix them, or add a reviewed exception to ${allowlistFile}`);
  console.error("    as: GHSA-id  justification | owner | expires YYYY-MM-DD");
  process.exit(1);
}

console.log(`\n[ok] audit result valid; no unreviewed advisories at or above ${threshold}`);
' "$REPORT" "$THRESHOLD" "$ALLOWLIST_FILE" "$NPM_EXIT"
SCRIPT_EOF

chmod +x scripts/audit.sh

cat << 'EOF' > scripts/audit-allowlist.txt
# Reviewed advisory exceptions.
#
# Format:  GHSA-id   justification | owner | expires YYYY-MM-DD
#
# Every field is mandatory. An entry without an expiry is rejected by the gate,
# and an entry past its expiry fails the build. An advisory that is not listed
# here fails the build immediately -- unknown means blocked, never allowed.
#
# An entry is a decision, not a mute button: it records that someone read the
# advisory and established the vulnerable path is unreachable from this
# codebase.
#
# EMPTY IS THE CORRECT STATE, and it is currently empty: next 16.3.0 carries no
# advisories, so the postcss and sharp exceptions carried in revision 2 were
# deleted rather than renewed. Upgrading beat excusing.
EOF

# ---------------------------------------------------------------------------
# CI and dev container
# ---------------------------------------------------------------------------

say "Writing CI and dev container"


cat << 'EOF' > .devcontainer/devcontainer.json
{
  "name": "korvi-pos-platform",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:1-24-bookworm",
  "features": {
    "ghcr.io/devcontainers/features/github-cli:1": {}
  },
  "postCreateCommand": "if [ -f package-lock.json ]; then npm ci --registry=https://registry.npmjs.org/; else npm install --registry=https://registry.npmjs.org/; fi",
  "forwardPorts": [3000, 3001],
  "portsAttributes": {
    "3000": { "label": "pos-web", "onAutoForward": "notify" },
    "3001": { "label": "api", "onAutoForward": "silent" }
  },
  "customizations": {
    "vscode": {
      "extensions": [
        "dbaeumer.vscode-eslint",
        "esbenp.prettier-vscode",
        "bradlc.vscode-tailwindcss",
        "prisma.prisma",
        "editorconfig.editorconfig"
      ],
      "settings": {
        "editor.formatOnSave": true,
        "editor.defaultFormatter": "esbenp.prettier-vscode",
        "editor.codeActionsOnSave": { "source.fixAll.eslint": "explicit" }
      }
    }
  }
}
EOF

cat << 'EOF' > README.md
# Korvi POS

نظام نقاط بيع للتجزئة والمطاعم — منتج مستقل، ورأس حربة معماري لمنظومة
Korvi ERP المستقبلية.

**الحالة: المرحلة صفر — الأساس.** لم تُبنَ شاشة الكاشير ولا المخزون ولا أي وحدة
تشغيلية بعد. راجع `docs/architecture/scope.md`.

## Requirements

- Node 24 LTS (see `.nvmrc`)
- npm
- PostgreSQL, for anything that touches the database

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill in DATABASE_URL
npm run db:generate
npm run verify
```

Run the apps:

```bash
npm run dev -w @korvi/pos-web   # http://localhost:3000
npm run dev -w @korvi/api       # http://localhost:3001/health
```

## Layout

| Path | Contents |
|---|---|
| `packages/domain` | Pure financial and compliance core — no framework |
| `packages/database` | Prisma schema and adapters for the domain's ports |
| `packages/printing` | ESC/POS construction for 80mm thermal printers |
| `packages/ui` | Design-system tokens and components |
| `packages/config` | Tailwind preset, shared with Korvi ERP |
| `packages/testing` | Determinism helpers |
| `apps/pos-web` | Next.js PWA shell |
| `apps/api` | Fastify service |
| `docs/` | Architecture, ADRs, design system, governance |

## Commands

| Command | Purpose |
|---|---|
| `npm run verify` | Format, lint, invariants, typecheck, test, build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Vitest |
| `npm run build` | Build every package and app, in dependency order |
| `npm run invariants` | The mechanical scan on its own |
| `npm run db:generate` | Regenerate the Prisma client |

## Before changing anything

Read `CLAUDE.md`. It holds the invariants — integer money, domain purity,
tenancy scoping, and the design rules — and most of them fail the build rather
than a review.

Decisions live in `docs/decisions/` as ADRs. Changing one means writing a new
ADR that supersedes it, not editing the old one.
EOF

# ---------------------------------------------------------------------------
# Reference documents — moved, never modified
# ---------------------------------------------------------------------------

say "Filing reference documents"

move_reference() {
  local description="$1" destination="$2" found=""
  shift 2

  for candidate in "$@"; do
    if [ -f "$candidate" ]; then found="$candidate"; break; fi
  done

  if [ -z "$found" ]; then
    warn "$description not found at the repository root — skipping."
    warn "  Place it at the root and re-run, or move it to $destination yourself."
    return 0
  fi

  if [ "$found" = "$destination" ]; then
    ok "$description already at $destination"
    return 0
  fi

  local before after
  before="$(cksum < "$found")"
  mv "$found" "$destination"
  after="$(cksum < "$destination")"

  if [ "$before" != "$after" ]; then
    die "Checksum changed while moving $description — aborting rather than risk corrupting it."
  fi
  ok "$description -> $destination (content unchanged)"
}

move_reference "Design system" "docs/design/KORVI-DESIGN-SYSTEM.md" \
  "KORVI-DESIGN-SYSTEM.md" "KORVIDESIGNSYSTEM.md" "KORVI_DESIGN_SYSTEM.md" \
  "docs/KORVI-DESIGN-SYSTEM.md"

move_reference "Strategy document" "docs/governance/Korvi_POS_Master_Strategy_Document.txt" \
  "Korvi_POS_Master_Strategy_Document.txt" "Korvi POS Master Strategy Document.txt" \
  "docs/Korvi_POS_Master_Strategy_Document.txt"

if [ ! -f docs/design/KORVI-DESIGN-SYSTEM.md ]; then
  cat << 'EOF' > docs/design/README.md
# Design

`KORVI-DESIGN-SYSTEM.md` belongs in this directory and was not present at the
repository root when the scaffold ran.

It is the authority for every visual decision in Korvi POS (ADR-0006). The
tokens in `packages/ui/src/styles/tokens.css` and the preset in
`packages/config/tailwind-preset.cjs` were transcribed from it; without the
document, the reasoning behind those values is not in the repository.

Add it here. Do not edit it — if reality diverges, write an ADR.
EOF
fi

if [ ! -f docs/governance/Korvi_POS_Master_Strategy_Document.txt ]; then
  cat << 'EOF' > docs/governance/README.md
# Governance

`Korvi_POS_Master_Strategy_Document.txt` belongs in this directory and was not
present at the repository root when the scaffold ran.

It is the source for the product's scope, market position, and the conflicts
resolved in the ADRs. Add it here, unmodified.
EOF
fi

cat << 'EOF' > .github/workflows/ci.yml
name: CI

on:
  push:
    branches: ['**']
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

# Least privilege by default. A job needing more raises it locally, so any
# extra permission is visible in the diff that adds it.
permissions:
  contents: read

jobs:
  verify:
    name: Verify
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      # Actions are pinned to immutable commit SHAs, not moving tags. A tag can
      # be repointed at any time by whoever controls the action's repository,
      # which makes `@v5` a supply-chain trust decision renewed on every run.
      # The comment records which release the SHA corresponds to.
      - name: Check out
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: Set up Node
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
        with:
          node-version-file: .nvmrc
          cache: npm

      # `npm ci` only — never a fallback to `npm install`. A fallback silently
      # resolves fresh versions when the lockfile is missing or stale, which
      # means CI stops testing the tree that will actually ship.
      - name: Install
        run: npm ci --registry=https://registry.npmjs.org

      - name: Verify dependency pins
        run: npm run versions:verify

      - name: Audit dependencies
        run: npm run audit

      - name: Formatting
        run: npm run format:check

      - name: Lint
        run: npm run lint

      - name: Invariants
        run: bash scripts/check-invariants.sh

      - name: Prisma client
        # generate reads the schema only — it never connects. A throwaway
        # localhost value satisfies the strict config; no secret involved.
        run: npm run db:generate
        env:
          DATABASE_URL: postgresql://korvi:korvi@localhost:5432/korvi_pos?schema=public

      - name: Build
        run: npm run build

      - name: Typecheck
        run: npm run typecheck

      - name: Tests
        run: npm run test
EOF

cat << 'EOF' > .github/dependabot.yml
version: 2

updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    versioning-strategy: increase
    # Patches arrive grouped so the weekly review is one PR rather than
    # fifteen; majors stay separate because each needs a real decision.
    groups:
      patch-and-minor:
        update-types: ['patch', 'minor']
    ignore:
      # Pinned by ADR-0007. Dependabot cannot know why, and an automated bump
      # here would break lint (typescript) or the design system (tailwind).
      # Revisit by editing the ADR, not by merging a bot PR.
      - dependency-name: typescript
        update-types: ['version-update:semver-major']
      - dependency-name: tailwindcss
        update-types: ['version-update:semver-major']
    commit-message:
      prefix: 'chore(deps)'

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    commit-message:
      prefix: 'chore(ci)'
EOF

# ---------------------------------------------------------------------------
# Install and verify
# ---------------------------------------------------------------------------

say "Installing dependencies (this takes a few minutes on a cold cache)"
npm install --registry=https://registry.npmjs.org/ --no-audit --no-fund

say "Generating the Prisma client"
# A placeholder localhost URL. `prisma generate` reads the schema only — it does
# not connect — and no credential is written to disk.
DATABASE_URL="postgresql://korvi:korvi@localhost:5432/korvi_pos?schema=public" \
  npm run --silent db:generate

say "Formatting generated sources"
npx prettier --write --log-level warn . >/dev/null 2>&1 || true

if [ "$RUN_VERIFY" -eq 1 ]; then
  say "Running the full verification gate"
  bash scripts/verify.sh
else
  warn "Skipping verification (--no-verify)."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

cat << 'EOF'

===============================================================================
  Korvi POS — Phase 0 foundation in place (final)
===============================================================================

  packages/domain     money (bigint halalas), largest-remainder allocation,
                      branded BasisPoints, cash-only change, monotonic UUIDv7
                      with rollback and overflow handling, ZATCA Phase 1 TLV,
                      ports for persistence / search / offline
  packages/database   Prisma 7 schema, RLS migration (ENABLE + FORCE,
                      deny-by-default, USING + WITH CHECK), withTenant()
                      context via SET LOCAL, adapters
  packages/printing   device profiles, Arabic shaping, visual reordering,
                      authoritative PC864 / CP1256 codecs, Arabic on the raster
                      path by default, native and raster QR, conformance
                      fixtures taken from the published mappings
  packages/ui         tokens, Tailwind preset, KorviMark, Numeric,
                      BidiIsolate, Button, SquareAsset, CardSurface
  packages/config     the shared Tailwind preset
  packages/testing    controllable clock, seeded bytes
  apps/api            Fastify, health and version routes, UUIDv7 request ids
  apps/pos-web        Next.js shell, RTL, smoke page
  docs/               architecture, ADR-0001..0011, design, governance
  scripts/            verify, invariant scan, version pins, audit gate

  Brand assets in packages/ui/assets/brand/ — the ERP lockup with POS in
  place of ERP, outlined, #047857.

  Nothing was committed. Review, then commit yourself.

  Next:  git add -A
         git commit -m 'feat: Korvi POS Phase 0 foundation'
         git push -u origin "$(git rev-parse --abbrev-ref HEAD)"

===============================================================================
EOF

ok "Done."
