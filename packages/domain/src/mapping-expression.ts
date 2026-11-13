/**
 * FR-5.5 — how a mapping's `from` path becomes the expression n8n evaluates against the item.
 *
 * The sample parser emits bracket notation for keys that are not identifiers (`["first name"]`,
 * `lead["odd.key"]`) because `$json.first name` is not JavaScript. The compiler used to prefix
 * `$json.` unconditionally, so exactly those paths — the ones the sample offers when a product uses a
 * spaced or dotted key — became `$json.["first name"]`. n8n accepts that definition, activates it,
 * and fails when it evaluates the expression, which is the most expensive place to find out.
 *
 * `$` is the whole item; an empty path means the same thing here and is refused by
 * `FieldMappingSchema` long before this helper is reached.
 */
export function mappingExpression(from: string): string {
  const path = from.trim();
  if (path.length === 0 || path === '$') return '{{ $json }}';
  return `{{ $json${path.startsWith('[') ? path : `.${path}`} }}`;
}
