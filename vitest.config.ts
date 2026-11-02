import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      include: ['apps/web/src/**'],
      provider: 'istanbul',
      thresholds: { branches: 90, functions: 90, lines: 90, statements: 90 },
    },
    projects: ['apps/web/vitest.config.ts', 'apps/web/vitest.worker.config.ts'],
  },
});
