import type { LooseRuleDefinition } from '@typescript-eslint/utils/ts-eslint';
import type { ESLint } from 'eslint';

export type EslintRule = NonNullable<ESLint.Plugin['rules']>[string];

const hasCallableCreate = (value: object): value is EslintRule =>
  'create' in value && typeof value.create === 'function';

export const castToEslintRule = (rule: LooseRuleDefinition) => {
  const source = typeof rule === 'function' ? { create: rule } : rule;
  const normalized = {
    create: source.create.bind(source),
    ...(source.meta !== undefined && { meta: source.meta }),
  };
  if (!hasCallableCreate(normalized)) {
    throw new TypeError('castToEslintRule: rule is missing a callable `create` method');
  }
  return normalized;
};
