import { describe, expect, it } from 'vitest';
import { mappingExpression } from '../../src/mapping-expression';

/**
 * The sample parser offers bracket notation for keys that are not identifiers (`["first name"]`),
 * because `$json.first name` is not JavaScript. The failure this suite pins is the compile step
 * prefixing `$json.` unconditionally: `$json.["first name"]` activates, then fails at evaluation —
 * the most expensive place to discover a mapping was never going to work.
 */
describe('mappingExpression', () => {
  it('dereferences a plain path from the item', () => {
    expect(mappingExpression('id')).toBe('{{ $json.id }}');
    expect(mappingExpression('contact.emailAddress')).toBe('{{ $json.contact.emailAddress }}');
  });

  it('does not put a dot in front of a bracket path', () => {
    expect(mappingExpression('["first name"]')).toBe('{{ $json["first name"] }}');
    expect(mappingExpression('contact["odd.key"]')).toBe('{{ $json.contact["odd.key"] }}');
  });

  it('passes the whole item through for `$` and for an empty path', () => {
    expect(mappingExpression('$')).toBe('{{ $json }}');
    expect(mappingExpression('')).toBe('{{ $json }}');
    expect(mappingExpression('   ')).toBe('{{ $json }}');
  });

  it('trims the path before deciding where the dot belongs', () => {
    expect(mappingExpression('  id  ')).toBe('{{ $json.id }}');
    expect(mappingExpression('  ["first name"]  ')).toBe('{{ $json["first name"] }}');
  });

  it('wraps the expression exactly once, whatever the path', () => {
    for (const from of ['id', 'contact.id', '["first name"]', '$', '']) {
      const expression = mappingExpression(from);
      expect(expression.startsWith('{{ $json'), from).toBe(true);
      expect(expression.endsWith(' }}'), from).toBe(true);
      expect(expression, from).not.toContain('.{{');
    }
  });
});
