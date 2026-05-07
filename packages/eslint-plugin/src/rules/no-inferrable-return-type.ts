import type { TSESTree } from '@typescript-eslint/utils';

import { AST_NODE_TYPES } from '@typescript-eslint/utils';

import { createRule } from '../create-rule';

type FunctionWithReturnType =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

export const noInferrableReturnType = createRule({
  create: context => {
    const checkFunction = (node: FunctionWithReturnType) => {
      const returnTypeNode = node.returnType;
      if (!returnTypeNode) return;

      if (returnTypeNode.typeAnnotation.type === AST_NODE_TYPES.TSTypePredicate) return;

      const tokenBefore = context.sourceCode.getTokenBefore(returnTypeNode);
      context.report({
        ...(tokenBefore && {
          fix: fixer => fixer.removeRange([tokenBefore.range[1], returnTypeNode.range[1]]),
        }),
        messageId: 'removeReturnType',
        node: returnTypeNode,
      });
    };

    return {
      ArrowFunctionExpression: checkFunction,
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
    };
  },
  defaultOptions: [],
  meta: {
    docs: {
      description: 'Disallow explicit return type annotations on functions; let TypeScript infer them.',
    },
    fixable: 'code',
    messages: {
      removeReturnType: 'Explicit return type annotation is unnecessary; let TypeScript infer it.',
    },
    schema: [],
    type: 'suggestion',
  },
  name: 'no-inferrable-return-type',
});
