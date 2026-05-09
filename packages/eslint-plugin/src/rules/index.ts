import type { TSESLint } from '@typescript-eslint/utils';

import { noInferrableReturnType } from './no-inferrable-return-type';

export const rules = {
  'no-inferrable-return-type': noInferrableReturnType,
} satisfies TSESLint.FlatConfig.Plugin['rules'];
