import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', '../test/**/*.test.mjs'],
    exclude: ['dist/**'],
    environment: 'node',
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
    setupFiles: ['./src/__tests__/setup.ts'],
    // Each PBKDF2 derivation at 600K iterations takes ~1-2s on typical hardware.
    // Tests involving reEncrypt or multiple round-trips need a longer budget.
    testTimeout: 10_000,
  },
});
