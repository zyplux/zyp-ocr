import type { AnyRuleModule, LooseRuleDefinition } from '@typescript-eslint/utils/ts-eslint';
import type { ESLint } from 'eslint';

export type EslintRule = NonNullable<ESLint.Plugin['rules']>[string];

type RuleSource = { create: (...args: never[]) => unknown; meta?: object | undefined };

const isEslintRule = (value: unknown): value is EslintRule =>
  value !== null &&
  typeof value === 'object' &&
  'create' in value &&
  typeof value.create === 'function';

export const castToEslintRule = (rule: AnyRuleModule | LooseRuleDefinition) => {
  const source: RuleSource = typeof rule === 'function' ? { create: rule } : rule;
  const result: { create: typeof source.create; meta?: object } = {
    create: source.create.bind(source),
  };
  if (source.meta !== undefined) result.meta = source.meta;
  if (!isEslintRule(result)) {
    throw new TypeError('Expected an ESLint rule with a `create` method');
  }
  return result;
};
