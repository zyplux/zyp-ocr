import type { ESLint } from 'eslint';

import { rules as importedRules } from './rules/index';

const plugin: ESLint.Plugin = {
  meta: {
    name: '@totvibe/eslint-plugin',
    version: '0.0.0',
  },
  rules: importedRules as unknown as ESLint.Plugin['rules'],
};

export { rules } from './rules/index';
export default plugin;
