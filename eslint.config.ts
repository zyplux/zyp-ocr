import { zyplux } from '@zyplux/eslint-config';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  ...zyplux({
    ignores: ['**/.tsbuild/**'],
    react: true,
    tanstack: true,
    tsconfigRootDir: import.meta.dirname,
  }),
  { settings: { react: { version: '19.0' } } },
);
