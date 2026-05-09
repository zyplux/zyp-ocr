import type { ESLintUtils } from '@typescript-eslint/utils';
import type { LooseRuleDefinition } from '@typescript-eslint/utils/ts-eslint';
import type { ESLint } from 'eslint';

export type EslintRule = NonNullable<ESLint.Plugin['rules']>[string];

type TSEslintRule = ReturnType<TSEslintRuleCreator>;
type TSEslintRuleCreator = ReturnType<typeof ESLintUtils.RuleCreator>;

export const widenTsRuleToEslintRule = (r: TSEslintRule) => {
  const { defaultOptions, ...meta } = r.meta;
  const create = r.create.bind(r) as unknown as EslintRule['create'];
  return {
    ...r,
    create,
    meta: defaultOptions ? { ...meta, defaultOptions: [...defaultOptions] } : meta,
  } satisfies EslintRule;
};

export const widenLooseRuleToEslintRule = (r: LooseRuleDefinition) => {
  const looseRule = typeof r === 'function' ? { create: r, meta: undefined } : r;
  const create = looseRule.create.bind(looseRule) as unknown as EslintRule['create'];
  return {
    create,
    ...(looseRule.meta && { meta: looseRule.meta }),
  } satisfies EslintRule;
};
