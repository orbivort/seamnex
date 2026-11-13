import { describe, expect, it } from 'vitest';
import type { FieldDescriptor, FieldMapping } from '@seamnex/domain';
import {
  bodyPreview,
  requiredCoverage,
  validateRows,
} from '../../src/features/workflows/field-mapping/use-mapping-draft';

/**
 * FR-5.5 — the rules the mapping ledger enforces before it offers to save.
 *
 * These are the errors an author fixes in place instead of discovering from a failed run: a row with
 * one side missing, two rows claiming one source path, and a target the product does not accept. The
 * last one is deliberately conditional — no schema means no error, because the platform cannot know.
 */
function mapping(from: string, to: string): FieldMapping {
  return { from, to, transform: null };
}

const ESPO: readonly FieldDescriptor[] = [
  { name: 'emailAddress', label: 'Email', type: 'string', required: true },
  { name: 'lastName', label: 'Last name', type: 'string', required: true },
  { name: 'description', label: null, type: 'string', required: false },
];

describe('validateRows', () => {
  it('passes a complete row whose target the product publishes', () => {
    expect(
      validateRows([mapping('lead.email', 'emailAddress')], new Set(['emailAddress'])),
    ).toEqual([null]);
  });

  it('names the missing side instead of one generic "invalid row"', () => {
    const issues = validateRows([mapping('', 'emailAddress'), mapping('lead.email', '')], null);

    expect(issues[0]?.from).toBe('Source path is required.');
    expect(issues[0]?.to).toBeNull();
    expect(issues[1]?.from).toBeNull();
    expect(issues[1]?.to).toBe('Target field is required.');
  });

  it('refuses two rows that read the same path or write the same field', () => {
    const issues = validateRows(
      [mapping('lead.email', 'emailAddress'), mapping('lead.email', 'lastName')],
      null,
    );

    expect(issues[0]?.from).toBe('Another row already uses this source path.');
    expect(issues[1]?.from).toBe('Another row already uses this source path.');

    const targets = validateRows(
      [mapping('lead.email', 'emailAddress'), mapping('lead.workEmail', 'emailAddress')],
      null,
    );
    expect(targets[0]?.to).toBe('Another row already writes this field.');
  });

  it('compares the trimmed value, because that is what the save sends', () => {
    // `' lead.email'` and `'lead.email'` used to look like two sources here and arrived at the
    // product as one field written twice.
    const issues = validateRows(
      [mapping(' lead.email ', 'emailAddress'), mapping('lead.email', 'lastName')],
      null,
    );

    expect(issues[0]?.from).toBe('Another row already uses this source path.');
    expect(issues[1]?.from).toBe('Another row already uses this source path.');
  });

  it('reports a target the product does not accept when the schema is known', () => {
    const issues = validateRows(
      [mapping('lead.email', 'contact.emailAddress')],
      new Set(['emailAddress']),
    );

    expect(issues[0]?.to).toBe('Not a field this operation accepts.');
  });

  it('accepts any target when no schema was published', () => {
    // `null` is "the product told us nothing", which is not the author's mistake.
    expect(validateRows([mapping('lead.email', 'whatever')], null)).toEqual([null]);
  });
});

describe('requiredCoverage', () => {
  it('counts the product-required fields the draft writes and names the rest', () => {
    const coverage = requiredCoverage([mapping('lead.email', 'emailAddress')], ESPO);

    expect(coverage.required).toBe(2);
    expect(coverage.covered).toBe(1);
    expect(coverage.missing).toEqual(['lastName']);
  });

  it('reports nothing missing for an operation that marks no field required', () => {
    expect(requiredCoverage([], [])).toEqual({ required: 0, covered: 0, missing: [] });
  });
});

describe('bodyPreview', () => {
  it('compiles each mapping into the expression the runner sends', () => {
    const preview = bodyPreview([
      mapping('lead.email', 'emailAddress'),
      mapping('lead.consentSource', 'description'),
    ]);

    expect(JSON.parse(preview)).toEqual({
      emailAddress: '{{ $json.lead.email }}',
      description: '{{ $json.lead.consentSource }}',
    });
  });

  it('leaves an unfinished row out rather than previewing a broken expression', () => {
    expect(JSON.parse(bodyPreview([mapping('lead.email', '')]))).toEqual({});
    expect(JSON.parse(bodyPreview([mapping('', 'emailAddress')]))).toEqual({});
  });

  it('reads a bracket path the way the compiler does, not as $json.[…]', () => {
    /*
     * The sample parser emits `["first name"]` for a key that is not an identifier. Prefixing it with
     * `$json.` produced `$json.["first name"]`, which n8n rejects when it evaluates the expression —
     * so the preview has to show the form that actually runs.
     */
    const preview = JSON.parse(bodyPreview([mapping('["first name"]', 'firstName')]));

    expect(preview).toEqual({ firstName: '{{ $json["first name"] }}' });
    expect(bodyPreview([mapping('$', 'payload')]).includes('$json.')).toBe(false);
  });
});
