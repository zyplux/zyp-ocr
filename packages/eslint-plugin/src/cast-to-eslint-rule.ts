import type { ESLintUtils } from '@typescript-eslint/utils';
import type { LooseRuleDefinition } from '@typescript-eslint/utils/ts-eslint';
import type { ESLint } from 'eslint';

export type EslintRule = NonNullable<ESLint.Plugin['rules']>[string];

type TSEslintRule = ReturnType<ReturnType<typeof ESLintUtils.RuleCreator>>;

const isEslintRule = (value: unknown): value is EslintRule =>
  value !== null && typeof value === 'object' && 'create' in value && typeof value.create === 'function';

const narrowToEslintRule = (rule: object) => {
  const widened: unknown = rule;
  if (!isEslintRule(widened)) throw new Error('Rule does not match EslintRule shape');
  return widened;
};

export const castTsToEslintRule = (r: TSEslintRule) => narrowToEslintRule({ ...r, create: r.create.bind(r) });

export const castLooseToEslintRule = (r: LooseRuleDefinition) => {
  const looseRule = typeof r === 'function' ? { create: r } : r;
  return narrowToEslintRule({
    create: looseRule.create.bind(looseRule),
    ...(looseRule.meta && { meta: looseRule.meta }),
  });
};
