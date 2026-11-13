/**
 * A `pool.query` inside a `withTransaction` callback takes a **second** connection.
 *
 * The transaction already holds one. Two consequences, both observed in this codebase:
 *
 *   - the statement cannot see the transaction's own uncommitted writes, so a read inside a loop
 *     reports the pre-update value;
 *   - the caller holds one client and waits for another. With `DATABASE_POOL_MAX` concurrent
 *     requests, every one of them holds one connection and waits for a second that can never be
 *     released — a stall that `statement_timeout` cannot end, because no statement reaches the
 *     server.
 *
 * The fix is always the same: use the `tx` the callback was given. A statement that must run
 * outside the transaction is rare enough to deserve an explicit disable comment.
 *
 * **What this rule does not check** — stated so nobody trusts it further than it goes. It matches a
 * `pool.query` whose *ancestors* include the helper call, in the same function, with the receiver
 * spelled `pool`, `this.pool` or `<something>.pool`. It therefore misses:
 *
 *   - a helper method called from inside the transaction that uses `this.pool` itself — one call
 *     frame away, the same defect, invisible here;
 *   - a pool held under another name (`this.db`, a destructured `const { pool } = deps`, an alias);
 *   - `withAdvisoryLock`, or any helper not listed in `TRANSACTION_HELPERS`.
 *
 * Catching the first case needs type information (a `Pool` reached inside a callback that received
 * a `PoolClient`), which is what a type-aware query checker would supply; ADR-BE-04 Amendment 1
 * records that as still open. This is a cheap guard for the common shape, not a proof.
 */

const TRANSACTION_HELPERS = new Set(['withTransaction', 'withAuditedMutation']);

function calleeName(node) {
  if (node === undefined || node === null) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    return node.property.name;
  }
  return null;
}

/** The nearest enclosing transaction helper call, or `null`. */
function enclosingTransaction(node) {
  let current = node.parent;
  while (current !== undefined && current !== null) {
    if (current.type === 'CallExpression' && TRANSACTION_HELPERS.has(calleeName(current.callee))) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * `this.pool.query(...)`, `pool.query(...)`, `this.db.query(...)` — anything that is not the
 * transaction handle. A receiver named `tx` or `client` is how a transaction client is spelled in
 * this repo, so those are allowed.
 */
function isPoolQuery(node) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return false;
  if (callee.property.name !== 'query') return false;

  const receiver = callee.object;
  if (receiver.type === 'Identifier') return receiver.name === 'pool';
  // `this.pool.query(...)` — the receiver is `this.pool`, so the member name is what identifies it.
  if (receiver.type === 'MemberExpression' && receiver.property.type === 'Identifier') {
    return receiver.property.name === 'pool';
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid pool.query inside a withTransaction callback: it takes a second connection and reads outside the transaction snapshot',
    },
    schema: [],
    messages: {
      secondConnection:
        "`pool.query` inside `{{helper}}` checks out a second connection: it cannot see this transaction's writes, and concurrent callers deadlock the pool. Pass the `tx` the callback received.",
    },
  },

  create(context) {
    return {
      'CallExpression[callee.property.name="query"]'(node) {
        if (!isPoolQuery(node)) return;
        const transaction = enclosingTransaction(node);
        if (transaction === null) return;
        context.report({
          node,
          messageId: 'secondConnection',
          data: { helper: calleeName(transaction.callee) ?? 'withTransaction' },
        });
      },
    };
  },
};
