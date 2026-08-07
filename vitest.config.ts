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
