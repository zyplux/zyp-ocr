import eslint from '@eslint/js';
import type { ESLint } from 'eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

type ConfigWithExtends = Parameters<typeof defineConfig>[number];
import preferArrowFunctions from 'eslint-plugin-prefer-arrow-functions';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const arrowFunctionsPlugin: ESLint.Plugin = {
  rules: preferArrowFunctions.rules as ESLint.Plugin['rules'],
};

const reactRecommended = react.configs.flat.recommended;
if (!reactRecommended) {
  throw new Error('eslint-plugin-react: configs.flat.recommended is missing');
}

const ignoresConfig = globalIgnores([
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
]);

const arrowOnlyMessage = 'Use an arrow function. If `this`/`arguments`/`new.target`/generators are needed, redesign.';

const baseConfig = {
  extends: [eslint.configs.recommended],
  plugins: { 'prefer-arrow-functions': arrowFunctionsPlugin },
  rules: {
    'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }],
    'prefer-arrow-functions/prefer-arrow-functions': ['error', { returnStyle: 'implicit' }],
    'no-restricted-syntax': [
      'error',
      { selector: 'FunctionDeclaration', message: arrowOnlyMessage },
      {
        selector: ':not(MethodDefinition, Property[method=true]) > FunctionExpression',
        message: arrowOnlyMessage,
      },
    ],
  },
} satisfies ConfigWithExtends;

const typescriptConfig = {
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
} satisfies ConfigWithExtends;

const reactConfig = {
  files: ['**/src/**/*.{ts,tsx}'],
  extends: [reactRecommended, reactHooks.configs.flat['recommended-latest']],
  settings: { react: { version: '19.0' } },
  rules: {
    'react/react-in-jsx-scope': 'off',
  },
} satisfies ConfigWithExtends;

export default defineConfig(ignoresConfig, baseConfig, typescriptConfig, reactConfig);
