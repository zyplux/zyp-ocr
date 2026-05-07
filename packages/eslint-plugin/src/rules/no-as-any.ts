import { AST_NODE_TYPES } from '@typescript-eslint/utils';

import { createRule } from '../create-rule';

export const noAsAny = createRule({
  create: context => ({
    TSAsExpression: node => {
      if (node.typeAnnotation.type === AST_NODE_TYPES.TSAnyKeyword) {
        context.report({ messageId: 'noAsAny', node });
      }
    },
  }),
  defaultOptions: [],
  meta: {
    docs: {
      description: 'Disallow `as any` type assertions; use a precise type or `unknown`.',
    },
    messages: {
      noAsAny: 'Avoid `as any`; use a precise type or `unknown`.',
    },
    schema: [],
    type: 'problem',
  },
  name: 'no-as-any',
});
