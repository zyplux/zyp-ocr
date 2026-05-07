import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/.output',
    '**/.nitro',
    '**/.vinxi',
    '**/.tanstack',
    '**/.wrangler',
    '**/.venv',
    '**/dist',
    '**/node_modules',
    '**/routeTree.gen.ts',
    '**/worker-configuration.d.ts',
  ]),
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/src/**/*.{ts,tsx}'],
    extends: [react.configs.flat.recommended, reactHooks.configs.flat['recommended-latest']],
    settings: { react: { version: '19.0' } },
    rules: {
      'react/react-in-jsx-scope': 'off',
    },
  },
);
