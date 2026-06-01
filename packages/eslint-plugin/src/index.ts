import type { ESLint } from 'eslint';

import { rules } from './rules/index';

const plugin = {
  meta: {
    name: '@totvibe/eslint-plugin',
    version: '0.0.0',
  },
  rules,
} satisfies ESLint.Plugin;

export default plugin;
