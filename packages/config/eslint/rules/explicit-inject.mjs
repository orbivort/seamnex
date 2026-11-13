/**
 * ADR-BE-17: `tsx` transpiles with esbuild, which does not emit `design:paramtypes`.
 *
 * Nest therefore has nothing to resolve a class-typed constructor parameter from, and an
 * undecorated parameter does not fail — it becomes `undefined`, and the failure surfaces as
 * `Cannot read properties of undefined` on the first request that touches it. TypeScript cannot
 * see the problem either: a constructor parameter is "used" by virtue of being declared.
 *
 * The rule checks classes that carry a decorator (the ones Nest constructs) and reports every
 * constructor parameter without one, which is exactly the set of parameters that must name a token.
 */

function enclosingClass(node) {
  let current = node.parent;
  while (current !== undefined && current !== null) {
    if (current.type === 'ClassDeclaration' || current.type === 'ClassExpression') return current;
    current = current.parent;
  }
  return null;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a decorator on every constructor parameter of a Nest-managed class (ADR-BE-17)',
    },
    schema: [],
    messages: {
      missing:
        '"{{parameter}}" has no decorator. tsx emits no design:paramtypes, so Nest resolves this parameter to undefined at runtime. Annotate it with @Inject(Token), @Inject(Service) or @Optional().',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      'MethodDefinition[kind="constructor"]'(node) {
        const owner = enclosingClass(node);
        // Only Nest-managed classes: an undecorated helper class may hold a parameter property
        // for plain reasons and has no container to satisfy.
        if (owner === null || (owner.decorators?.length ?? 0) === 0) return;

        for (const parameter of node.value.params) {
          if ((parameter.decorators?.length ?? 0) > 0) continue;
          if (parameter.type === 'RestElement') continue;
          context.report({
            node: parameter,
            messageId: 'missing',
            data: { parameter: sourceCode.getText(parameter) },
          });
        }
      },
    };
  },
};
