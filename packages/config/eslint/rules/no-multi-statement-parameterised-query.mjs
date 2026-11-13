/**
 * A parameterised query can carry exactly **one** statement.
 *
 * `node-postgres` switches to the extended query protocol as soon as a `values` array is passed
 * (`Parse`/`Bind`/`Execute`), and that protocol accepts one command per message. PostgreSQL rejects
 * two with `42601: cannot insert multiple commands into a prepared statement`.
 *
 * This is a build-time error rather than a runtime one because it is invisible in review: the SQL
 * reads as two ordinary `UPDATE`s, the types check, and the endpoint fails on the first real call.
 * `authoring.service.ts` shipped exactly that in the workflow activation path.
 *
 * A trailing `;` after a single statement is fine and is not reported — only a `;` followed by more
 * SQL. Comments and quoted literals are stripped first so `WHERE x = 'a;b'` does not trip it.
 *
 * **What this rule does not check.** It requires the SQL to be a literal at the call site and the
 * values array to be a second syntactic argument, so it misses:
 *
 *   - `pool.query(buildSql(), params)` — assembled elsewhere;
 *   - the object form `pool.query({ text, values })`;
 *   - a `;` inside a dollar-quoted body (`$$ ... $$`), which is not stripped;
 *   - a `values` array passed as an identifier that is empty at runtime (reported: the driver still
 *     chooses the extended protocol, so the report is correct in that case).
 *
 * A statement assembled from user input is not detectable by shape at all; that is a different
 * review question, and `starts_with`/parameterised builders are how this repository already answers
 * it. Treat this as a net for the copied-and-edited query, not for every query.
 */

const SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE|WITH|MERGE)\b/i;
const PARAMETER = /\$\d/;

/** Removes comments and single-quoted literals, so a `;` inside either is not counted. */
function stripNonCode(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

function stringValue(node) {
  if (node === undefined || node === null) return null;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
  }
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/** A `;` that is followed by something other than whitespace or a closing bracket. */
function hasSecondStatement(sql) {
  return /;[ \t\r\n]*[^\s)\]]/.test(stripNonCode(sql));
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid more than one SQL statement in a parameterised query: the extended protocol accepts exactly one command',
    },
    schema: [],
    messages: {
      multipleStatements:
        'A parameterised query accepts one statement. The extended protocol rejects this with 42601 at runtime. Split it into separate `query` calls inside one `withTransaction`.',
    },
  },

  create(context) {
    return {
      'CallExpression[callee.property.name="query"]'(node) {
        // Without a values array the driver uses the simple protocol, which does allow several.
        if (node.arguments.length < 2) return;
        const values = node.arguments[1];
        if (values.type === 'Identifier' && values.name === 'undefined') return;

        const sql = stringValue(node.arguments[0]);
        if (sql === null) return;
        if (!PARAMETER.test(sql) && !SQL_KEYWORD.test(sql)) return;
        if (!hasSecondStatement(sql)) return;

        context.report({ node, messageId: 'multipleStatements' });
      },
    };
  },
};
