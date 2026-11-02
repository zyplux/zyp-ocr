import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/durable-objects/user-do.ts',
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('src', import.meta.url)),
      '~tests': fileURLToPath(new URL('tests', import.meta.url)),
    },
  },
  test: { include: ['tests/runtime/*.test.ts'], name: 'worker' },
});
