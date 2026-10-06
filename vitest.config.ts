import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Pure-logic unit tests run in Node; no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    globals: true,
  },
});
