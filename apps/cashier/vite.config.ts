import { defineConfig } from 'vite';

const sourceSha = process.env['GITHUB_SHA'] ?? process.env['KORVI_SOURCE_SHA'] ?? 'development';

export default defineConfig({
  define: {
    __KORVI_SOURCE_SHA__: JSON.stringify(sourceSha),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    manifest: true,
  },
});
