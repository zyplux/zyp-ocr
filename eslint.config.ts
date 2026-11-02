import { zyplux } from '@zyplux/eslint-config';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  ...zyplux({
    ignores: ['**/.tsbuild/**'],
    react: true,
    tanstack: true,
    testApis: {
      'apps/web/tests/client/*.test.{ts,tsx}': 'apps/web/tests/client/fixtures.tsx',
      'apps/web/tests/durable-objects/*.test.ts': 'apps/web/tests/durable-objects/_fixtures.ts',
      'apps/web/tests/lib/*.test.ts': 'apps/web/tests/lib/fixtures.ts',
      'apps/web/tests/runtime/*.test.ts': 'apps/web/tests/runtime/fixtures.ts',
      'apps/web/tests/stories/*.test.ts': 'apps/web/tests/durable-objects/_fixtures.ts',
    },
    tsconfigRootDir: import.meta.dirname,
  }),
  { settings: { react: { version: '19.0' }, vitest: { vitestImports: [/(?:^|\/)_?fixtures$/] } } },
);
