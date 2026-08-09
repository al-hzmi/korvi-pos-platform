import { defineConfig } from 'vitest/config';

export default defineConfig({
  // apps/pos-web/tsconfig.json sets `jsx: preserve`, because Next does its own
  // transform. Vite's would honour that and hand raw JSX to Node, so the test
  // runner is told to compile it. This changes nothing about the build.
  oxc: { jsx: { runtime: 'automatic' } },
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
