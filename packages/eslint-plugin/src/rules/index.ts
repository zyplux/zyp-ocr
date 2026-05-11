import preferArrowFunctions from 'eslint-plugin-prefer-arrow-functions';

import { castLooseToEslintRule, castTsToEslintRule } from '../cast-to-eslint-rule';
import { noInferrableReturnType } from './no-inferrable-return-type';

const upstreamPreferArrowFunctions = preferArrowFunctions.rules?.['prefer-arrow-functions'];
if (!upstreamPreferArrowFunctions) {
  throw new Error('eslint-plugin-prefer-arrow-functions: "prefer-arrow-functions" rule missing');
}

export const rules = {
  'no-inferrable-return-type': castTsToEslintRule(noInferrableReturnType),
  'prefer-arrow-functions': castLooseToEslintRule(upstreamPreferArrowFunctions),
};
