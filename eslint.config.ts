import { totvibe } from '@totvibe/eslint-config';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  ...totvibe({
    ignores: ['**/.tsbuild/**'],
    react: true,
    tanstack: true,
    tsconfigRootDir: import.meta.dirname,
  }),
  { settings: { react: { version: '19.0' } } },
);
