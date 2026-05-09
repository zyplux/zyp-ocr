import type { TSESTree } from '@typescript-eslint/utils';

import { AST_NODE_TYPES } from '@typescript-eslint/utils';

import { createRule } from '../create-rule';

type FunctionWithReturnType =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

const getFunctionName = (node: FunctionWithReturnType) => {
  if (
    (node.type === AST_NODE_TYPES.FunctionDeclaration || node.type === AST_NODE_TYPES.FunctionExpression) &&
    node.id
  ) {
    return node.id.name;
  }
  const parent = node.parent;
  if (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.id.type === AST_NODE_TYPES.Identifier) {
    return parent.id.name;
  }
  return;
};

const isAstNode = (x: unknown): x is TSESTree.Node =>
  x !== null && typeof x === 'object' && 'type' in x && typeof x.type === 'string';

const traverse = (node: TSESTree.Node, visit: (n: TSESTree.Node) => boolean): boolean => {
  if (visit(node)) return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item) && traverse(item, visit)) return true;
      }
    } else if (isAstNode(value) && traverse(value, visit)) {
      return true;
    }
  }
  return false;
};

const bodyReferencesIdentifier = (body: TSESTree.Node, name: string) =>
  traverse(body, n => n.type === AST_NODE_TYPES.Identifier && n.name === name);

const collectTypeParamNames = (node: FunctionWithReturnType) => {
  const names = new Set<string>();
  if (node.typeParameters) {
    for (const param of node.typeParameters.params) {
      names.add(param.name.name);
    }
  }
  return names;
};

const returnTypeReferencesAny = (typeNode: TSESTree.Node, names: Set<string>) => {
  if (names.size === 0) return false;
  return traverse(typeNode, n => {
    if (n.type !== AST_NODE_TYPES.TSTypeReference) return false;
    if (n.typeName.type !== AST_NODE_TYPES.Identifier) return false;
    return names.has(n.typeName.name);
  });
};

export const noInferrableReturnType = createRule({
  create: context => {
    const checkFunction = (node: FunctionWithReturnType) => {
      const returnTypeNode = node.returnType;
      if (!returnTypeNode) return;

      if (returnTypeNode.typeAnnotation.type === AST_NODE_TYPES.TSTypePredicate) return;

      const typeParamNames = collectTypeParamNames(node);
      if (returnTypeReferencesAny(returnTypeNode.typeAnnotation, typeParamNames)) return;

      const functionName = getFunctionName(node);
      if (functionName && bodyReferencesIdentifier(node.body, functionName)) return;

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
