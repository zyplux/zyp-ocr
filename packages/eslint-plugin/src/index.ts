import type { TSESLint } from '@typescript-eslint/utils';

import { rules as importedRules } from './rules/index';

const plugin = {
  meta: {
    name: '@totvibe/eslint-plugin',
    version: '0.0.0',
  },
  rules: importedRules,
} satisfies TSESLint.FlatConfig.Plugin;

export { rules } from './rules/index';
export default plugin;
