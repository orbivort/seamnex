import { describe, expect, it } from 'vitest';
import {
  defaultValueProblem,
  isMappingTransform,
  MAPPING_TRANSFORMS,
  mappedValueExpression,
  missingPolicy,
  transformNames,
  transformOutput,
} from '../../src/mapping-transform';
import type { FieldMapping } from '../../src/schemas/workflow';

const mapping = (patch: Partial<FieldMapping>): FieldMapping => ({
  from: 'opportunity.amount',
  to: 'budget',
  transform: null,
  ...patch,
});

/**
 * The defect this suite pins is silent: `transform`, `required`, `onMissing` and `defaultValue` were
 * declared, saved, and never read, so a mapping the author asked to convert or to guard compiled to
 * a bare dereference and the product received the unconverted value.
 */
describe('mappedValueExpression', () => {
  it('compiles a mapping that declares nothing exactly as the compiler did before', () => {
    expect(mappedValueExpression(mapping({}))).toBe('={{ $json.opportunity.amount }}');
    expect(mappedValueExpression(mapping({ from: '["first name"]', to: 'name' }))).toBe(
      '={{ $json["first name"] }}',
    );
  });

  it('applies a conversion only to a present value, so a missing one is never coerced', () => {
    const expression = mappedValueExpression(mapping({ transform: 'trim' }));

    expect(expression.startsWith('={{ ')).toBe(true);
    expect(expression).toContain("($json.opportunity.amount ?? '') === ''");
    expect(expression).toContain('String($json.opportunity.amount).trim()');
    // The missing branch keeps the value it found: absent stays absent, and the run does not fail.
    expect(expression).not.toContain('throw');
  });

  it('does not put a dot in front of a bracket path inside the guard', () => {
    const expression = mappedValueExpression(
      mapping({ from: 'contact["odd.key"]', transform: 'number' }),
    );

    expect(expression).not.toContain('.(["');
    expect(expression).not.toContain('$json.[');
    expect(expression).toContain('Number($json.contact["odd.key"])');
  });

  it('treats a required field as fail-to-send unless the author said otherwise', () => {
    const expression = mappedValueExpression(mapping({ required: true }));

    expect(expression).toContain('throw new Error');
    expect(expression).toContain('Missing required value for \\"budget\\"');
    expect(expression).toContain('(opportunity.amount)');
  });

  it('lets an explicit policy override what `required` implies', () => {
    expect(missingPolicy({ required: true, onMissing: 'skip' })).toBe('skip');
    expect(missingPolicy({ required: true })).toBe('fail');
    expect(missingPolicy({ required: false })).toBe('keep');
    expect(missingPolicy({})).toBe('keep');
  });

  it('omits the field when the policy is skip', () => {
    const expression = mappedValueExpression(mapping({ onMissing: 'skip', transform: 'number' }));

    expect(expression).toContain('? undefined :');
  });

  it('substitutes a default typed as the conversion produces', () => {
    expect(
      mappedValueExpression(
        mapping({ onMissing: 'default', defaultValue: '0', transform: 'number' }),
      ),
    ).toContain('? 0 :');
    // A default is the value the product receives, in its own units, so it is never converted.
    expect(
      mappedValueExpression(
        mapping({
          onMissing: 'default',
          defaultValue: '1999',
          transform: 'currency_major_to_minor',
        }),
      ),
    ).toContain('? 1999 :');
    expect(
      mappedValueExpression(
        mapping({ onMissing: 'default', defaultValue: 'yes', transform: 'boolean' }),
      ),
    ).toContain('? true :');
    expect(
      mappedValueExpression(
        mapping({ onMissing: 'default', defaultValue: 'n/a', transform: 'trim' }),
      ),
    ).toContain('? "n/a" :');
  });

  it('keeps a text default as text even when it looks numeric', () => {
    expect(
      mappedValueExpression(
        mapping({ onMissing: 'default', defaultValue: '007', transform: 'text' }),
      ),
    ).toContain('? "007" :');
  });

  it('escapes a default that contains a quote', () => {
    const expression = mappedValueExpression(
      mapping({ onMissing: 'default', defaultValue: 'say "hi"', transform: 'trim' }),
    );

    expect(expression).toContain('? "say \\"hi\\"" :');
  });
});

describe('the transform catalogue', () => {
  it('resolves every published name to an applier and an output type', () => {
    for (const transform of MAPPING_TRANSFORMS) {
      expect(isMappingTransform(transform.name), transform.name).toBe(true);
      expect(transformOutput(transform.name), transform.name).toBe(transform.output);
    }
  });

  it('refuses a name the platform cannot apply', () => {
    // The mock fixtures used prose here: it reads well and compiles to nothing.
    expect(isMappingTransform('currency → EUR')).toBe(false);
    expect(isMappingTransform('lookup by ERP id')).toBe(false);
    expect(isMappingTransform(null)).toBe(false);
    expect(isMappingTransform('')).toBe(false);
  });

  it('normalises case and surrounding whitespace, the way a stored value arrives', () => {
    expect(isMappingTransform('  TRIM ')).toBe(true);
    expect(transformOutput(' Date_ISO ')).toBe('date');
  });

  it('lists the names an error message can offer', () => {
    expect(transformNames()).toContain('date_iso');
    expect(transformNames()).toEqual(MAPPING_TRANSFORMS.map((transform) => transform.name));
  });

  /**
   * Every catalogue entry has to compile to *something*: a name with no applier would be published,
   * accepted by validation and silently emit the untransformed value.
   */
  it('compiles every published name into a conversion, not a bare dereference', () => {
    const bare = mappedValueExpression(mapping({}));

    for (const transform of MAPPING_TRANSFORMS) {
      const expression = mappedValueExpression(mapping({ transform: transform.name }));
      expect(expression, transform.name).not.toBe(bare);
      expect(expression, transform.name).toContain('?');
      expect(expression, transform.name).toContain('$json.opportunity.amount');
    }
  });

  /** A name validation refuses still has to compile to something safe, not to `undefined`. */
  it('falls back to the value when the conversion cannot be resolved', () => {
    const expression = mappedValueExpression(
      mapping({ transform: 'currency → EUR', onMissing: 'skip' }),
    );

    expect(expression).toContain('? undefined : $json.opportunity.amount');
  });
});

describe('defaultValueProblem', () => {
  it('says nothing when the policy is not `default`', () => {
    expect(defaultValueProblem(mapping({ required: true }))).toBeNull();
    expect(defaultValueProblem(mapping({ onMissing: 'skip' }))).toBeNull();
  });

  it('refuses a default policy with no default to substitute', () => {
    expect(defaultValueProblem(mapping({ onMissing: 'default', defaultValue: null }))).toContain(
      'no default is set',
    );
    expect(defaultValueProblem(mapping({ onMissing: 'default', defaultValue: '   ' }))).toContain(
      'no default is set',
    );
  });

  it('refuses a default a numeric conversion would turn into NaN', () => {
    expect(
      defaultValueProblem(
        mapping({ onMissing: 'default', defaultValue: 'about 40', transform: 'number' }),
      ),
    ).toContain('not numeric');
    expect(
      defaultValueProblem(
        mapping({ onMissing: 'default', defaultValue: '40', transform: 'number' }),
      ),
    ).toBeNull();
  });

  it('refuses a default that is neither yes nor no for a boolean conversion', () => {
    expect(
      defaultValueProblem(
        mapping({ onMissing: 'default', defaultValue: 'maybe', transform: 'boolean' }),
      ),
    ).toContain('neither');
    expect(
      defaultValueProblem(
        mapping({ onMissing: 'default', defaultValue: 'No', transform: 'boolean' }),
      ),
    ).toBeNull();
  });

  it('accepts any text for a text conversion', () => {
    expect(
      defaultValueProblem(
        mapping({ onMissing: 'default', defaultValue: 'none', transform: 'trim' }),
      ),
    ).toBeNull();
  });

  it('refuses a fractional default for a whole-number conversion', () => {
    expect(
      defaultValueProblem(
        mapping({ onMissing: 'default', defaultValue: '1.5', transform: 'integer' }),
      ),
    ).toContain('not one');
    expect(
      defaultValueProblem(
        mapping({ onMissing: 'default', defaultValue: '-2', transform: 'integer' }),
      ),
    ).toBeNull();
  });

  /** A boolean default may be written the way the author says it; the compiler emits `false`. */
  it('accepts either spelling of a boolean default', () => {
    expect(
      mappedValueExpression(
        mapping({ onMissing: 'default', defaultValue: 'no', transform: 'boolean' }),
      ),
    ).toContain('? false :');
  });
});
