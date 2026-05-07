import { ESLintUtils } from '@typescript-eslint/utils';

export const createRule = ESLintUtils.RuleCreator(
  name => `https://github.com/realSergiy/totvibe-ocr/blob/main/packages/eslint-plugin/src/rules/${name}.ts`,
);
