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
            {
              group: ['react', 'react-*', 'next', 'next/*'],
              message: 'The domain core must not depend on a UI framework (ADR-0001).',
            },
            {
              group: ['@prisma/*', 'prisma', '*/generated/client*'],
              message:
                'The domain core must not depend on an ORM (ADR-0001). Define a port instead.',
            },
            {
              group: ['fastify', 'express'],
              message: 'The domain core must not depend on an HTTP server (ADR-0001).',
            },
            {
              group: ['node:fs', 'node:path', 'fs', 'path'],
              message: 'The domain core must stay isomorphic — no filesystem access (ADR-0001).',
            },
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
    files: ['packages/domain/src/{money,tax,tender,quantity,pricing,sale}/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name=/^(parseFloat|parseInt)$/]',
          message:
            'Money is integer minor units. Use the parsers in @korvi/domain/money (ADR-0002).',
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
