import type { ESLint } from 'eslint';

import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type ConfigWithExtends = Parameters<typeof defineConfig>[number];
import totvibe from '@totvibe/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';
import perfectionist from 'eslint-plugin-perfectionist';
import preferArrowFunctions from 'eslint-plugin-prefer-arrow-functions';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import unicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';

// `eslint/config`'s `defineConfig` requires `ESLint.Plugin` whose `rules` index
// is `RuleDefinition<RuleDefinitionTypeOptions>`. typescript-eslint plugins
// (ours and upstream) use `LooseRuleDefinition` which carries richer context
// type parameters. The two are runtime-equivalent and structurally compatible
// at the JS boundary; the type incompatibility is cosmetic. This is the only
// place we cross that boundary.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const asEslintPlugin = (plugin: { rules?: unknown }) => plugin as ESLint.Plugin;

const catalogVersion = (pkg: string) => {
  const workspace = readFileSync(fileURLToPath(new URL('pnpm-workspace.yaml', import.meta.url)), 'utf8');
  const pattern = new RegExp(
    String.raw`^\s*['"]?${pkg.replaceAll(/[/@]/g, String.raw`\$&`)}['"]?:\s*\^?([\d.]+)\s*$`,
    'm',
  );
  const match = pattern.exec(workspace);
  if (!match?.[1]) throw new Error(`pnpm-workspace.yaml: catalog entry for "${pkg}" not found`);
  return match[1];
};

const arrowFunctionsPlugin = asEslintPlugin({ rules: preferArrowFunctions.rules });

const reactRecommended = react.configs.flat.recommended;
if (!reactRecommended) {
  throw new Error('eslint-plugin-react: configs.flat.recommended is missing');
}
const reactJsxRuntime = react.configs.flat['jsx-runtime'];
if (!reactJsxRuntime) {
  throw new Error('eslint-plugin-react: configs.flat[jsx-runtime] is missing');
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
    'no-restricted-syntax': [
      'error',
      { message: arrowOnlyMessage, selector: 'FunctionDeclaration' },
      {
        message: arrowOnlyMessage,
        selector: ':not(MethodDefinition, Property[method=true]) > FunctionExpression',
      },
    ],
    'prefer-arrow-functions/prefer-arrow-functions': ['error', { returnStyle: 'implicit' }],
  },
} satisfies ConfigWithExtends;

const typescriptConfig = {
  extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
  files: ['**/*.{ts,tsx}'],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
    '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
    '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
  },
} satisfies ConfigWithExtends;

const reactConfig = {
  extends: [reactRecommended, reactJsxRuntime, reactHooks.configs.flat['recommended-latest']],
  files: ['**/src/**/*.{ts,tsx}'],
  settings: { react: { version: catalogVersion('react') } },
} satisfies ConfigWithExtends;

const perfectionistConfig = {
  extends: [perfectionist.configs['recommended-natural']],
  files: ['**/*.{ts,tsx,js,mjs,cjs}'],
} satisfies ConfigWithExtends;

const unicornConfig = {
  extends: [unicorn.configs.recommended],
  files: ['**/*.{ts,tsx,js,mjs,cjs}'],
  rules: {
    'unicorn/catch-error-name': 'off',
    'unicorn/prevent-abbreviations': 'off',
  },
} satisfies ConfigWithExtends;

const tanstackRoutesConfig = {
  files: ['**/routes/**/*.{ts,tsx}'],
  rules: {
    'unicorn/filename-case': [
      'error',
      {
        case: 'kebabCase',
        ignore: [/^\$[a-z][\dA-Za-z]*\.tsx?$/],
      },
    ],
  },
} satisfies ConfigWithExtends;

const totvibeConfig = {
  files: ['**/*.{ts,tsx}'],
  plugins: { '@totvibe': asEslintPlugin(totvibe) },
  rules: {
    '@totvibe/no-inferrable-return-type': 'error',
  },
} satisfies ConfigWithExtends;

export default defineConfig(
  ignoresConfig,
  baseConfig,
  typescriptConfig,
  reactConfig,
  perfectionistConfig,
  unicornConfig,
  tanstackRoutesConfig,
  totvibeConfig,
  // Disables stylistic rules that overlap with prettier (we run prettier
  // separately via `pnpm format`). Must come last so it overrides preceding
  // configs. Source: https://github.com/prettier/eslint-config-prettier
  prettierConfig,
);
