import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.output',
      '.nitro',
      '.vinxi',
      '.tanstack',
      '.wrangler',
      'dist',
      'node_modules',
      'src/routeTree.gen.ts',
      'worker-configuration.d.ts',
    ],
  },
  js.configs.recommended,
  // Type-aware rules apply only to source files in the TS project.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: { react: { version: '19.0' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  // Config files use plain JS — type-aware rules off.
  {
    files: ['*.config.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
