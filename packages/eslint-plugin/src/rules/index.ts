import preferArrowFunctions from 'eslint-plugin-prefer-arrow-functions';

import { widenLooseRuleToEslintRule, widenTsRuleToEslintRule } from '../eslint-rule';
import { noInferrableReturnType } from './no-inferrable-return-type';

const upstreamPreferArrowFunctions = preferArrowFunctions.rules?.['prefer-arrow-functions'];
if (!upstreamPreferArrowFunctions) {
  throw new Error('eslint-plugin-prefer-arrow-functions: "prefer-arrow-functions" rule missing');
}

export const rules = {
  'no-inferrable-return-type': widenTsRuleToEslintRule(noInferrableReturnType),
  'prefer-arrow-functions': widenLooseRuleToEslintRule(upstreamPreferArrowFunctions),
};
