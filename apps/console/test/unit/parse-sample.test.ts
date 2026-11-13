import { describe, expect, it } from 'vitest';
import {
  parseSample,
  targetGuessFor,
  type ParsedSample,
  type SampleField,
} from '../../src/features/workflows/field-mapping/parse-sample';

/**
 * FR-5.5 — the three shapes people actually paste into the mapper's sample box, and the limits that
 * keep a 40-row payload from burying the field list the author is choosing from.
 *
 * The paths this returns are the left-hand side of a mapping (`{{ $json.<path> }}`), so a wrong
 * quote or a missing index is not a cosmetic bug: the saved expression does not evaluate.
 */
function fieldsOf(sample: ParsedSample): readonly SampleField[] {
  if (!sample.ok) throw new Error(`expected a parsed sample, got: ${sample.error}`);
  return sample.fields;
}

function pathsOf(text: string): readonly string[] {
  return fieldsOf(parseSample(text)).map((field) => field.path);
}

describe('parseSample rejections', () => {
  it('asks for an item when the box is empty or only whitespace', () => {
    expect(parseSample('')).toEqual({ ok: false, error: 'Paste an item to read its fields.' });
    expect(parseSample('  \n\t ')).toEqual({
      ok: false,
      error: 'Paste an item to read its fields.',
    });
  });

  it('names invalid JSON instead of guessing at a broken paste', () => {
    expect(parseSample('{ "lastName": ')).toEqual({
      ok: false,
      error: 'That is not valid JSON. Paste the item exactly as the run shows it.',
    });
  });

  it('refuses a payload with no object to read paths from', () => {
    const error = { ok: false, error: 'The sample has no object to read fields from.' };
    expect(parseSample('42')).toEqual(error);
    expect(parseSample('"Mei Chen"')).toEqual(error);
    expect(parseSample('null')).toEqual(error);
    expect(parseSample('[]')).toEqual(error);
  });
});

describe('parseSample shapes', () => {
  it('reads the item itself, relative to the item and not to n8n’s wrapper', () => {
    const fields = fieldsOf(
      parseSample(JSON.stringify({ lastName: 'Chen', age: 41, subscribed: true, note: null })),
    );

    expect(fields).toEqual([
      { path: 'lastName', value: 'Chen', type: 'string' },
      { path: 'age', value: '41', type: 'number' },
      { path: 'subscribed', value: 'true', type: 'boolean' },
      { path: 'note', value: 'null', type: 'null' },
    ]);
  });

  it('unwraps n8n’s items array and a single n8n item', () => {
    expect(pathsOf('[{"json":{"lastName":"Chen"}}]')).toEqual(['lastName']);
    expect(pathsOf('{"json":{"lastName":"Chen"}}')).toEqual(['lastName']);
  });

  it('indexes an array by its first element and admits it dropped the rest', () => {
    const text = JSON.stringify({
      rows: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
    });
    const parsed = parseSample(text);

    expect(pathsOf(text)).toEqual(['rows[0].email']);
    expect(parsed.ok && parsed.truncated).toBe(true);
  });

  it('writes an empty array and an empty object as their own field', () => {
    expect(fieldsOf(parseSample(JSON.stringify({ tags: [], meta: {} })))).toEqual([
      { path: 'tags[0]', value: '[]', type: 'array' },
      { path: 'meta', value: '{}', type: 'object' },
    ]);
  });

  it('records an empty root object rather than claiming there is nothing to map', () => {
    expect(fieldsOf(parseSample('{}'))).toEqual([{ path: '', value: '{}', type: 'object' }]);
  });

  it('quotes a key that is not an identifier, at the root and below one', () => {
    expect(pathsOf(JSON.stringify({ 'first name': 'Mei' }))).toEqual(['["first name"]']);
    expect(pathsOf(JSON.stringify({ lead: { 'first name': 'Mei' } }))).toEqual([
      'lead["first name"]',
    ]);
  });
});

describe('parseSample limits', () => {
  it('caps the field list at 200 entries and says it truncated', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [`field${index}`, index]),
    );
    const parsed = parseSample(JSON.stringify(wide));

    expect(fieldsOf(parsed)).toHaveLength(200);
    expect(parsed.ok && parsed.truncated).toBe(true);
  });

  it('stops at the depth limit, and says so when nothing shallower is a leaf', () => {
    // Six nested objects are the ceiling; the leaf on the seventh level is never reached, so the
    // sample has no path at all to offer.
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };

    expect(parseSample(JSON.stringify(deep))).toEqual({
      ok: false,
      error: 'The sample has no leaf fields to map.',
    });
  });

  it('collapses whitespace and shortens a long preview', () => {
    const long = 'x'.repeat(120);
    const fields = fieldsOf(parseSample(JSON.stringify({ note: 'a\n  b', long })));

    expect(fields[0]?.value).toBe('a b');
    expect(fields[1]?.value).toBe(`${'x'.repeat(72)}…`);
  });
});

describe('targetGuessFor', () => {
  it('offers the leaf name of a path', () => {
    expect(targetGuessFor('lead.email')).toBe('email');
    expect(targetGuessFor('$')).toBe('$');
  });

  it('offers nothing for an index, because there is no name to offer', () => {
    expect(targetGuessFor('data[0]')).toBe('');
    expect(targetGuessFor('["first name"]')).toBe('');
  });
});
