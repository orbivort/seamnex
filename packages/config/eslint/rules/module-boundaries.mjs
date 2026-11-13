import { checkSpecifier, loadManifest } from '../../module-boundaries.mjs';

/**
 * ADR-BE-03, enforced by the same predicate the boundary test uses.
 *
 * This replaced 23 generated `no-restricted-imports` blocks: `no-restricted-imports` can only
 * match a glob, so it could not express "a declared edge is fine, but only through the contract
 * file" — and the test, which could, therefore disagreed with it.
 */

const manifest = loadManifest();

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Enforce the design §6.1 module boundaries declared in packages/config/module-boundaries.json',
    },
    schema: [],
    messages: {
      boundary: '{{reason}}',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (filename === '<input>' || filename === '<text>') return {};

    function check(node, specifier) {
      if (typeof specifier !== 'string') return;
      const verdict = checkSpecifier(filename, specifier, manifest);
      if (verdict.ok) return;
      context.report({ node, messageId: 'boundary', data: { reason: verdict.reason } });
    }

    return {
      ImportDeclaration(node) {
        check(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) check(node.source, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node.source, node.source.value);
      },
    };
  },
};
