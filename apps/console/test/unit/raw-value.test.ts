import { describe, expect, it } from 'vitest';
import { rawValue } from '../../src/features/instances/rawValue';

/**
 * A masked secret must never be placed in an editable field: the operator would submit the mask
 * back as the value. The helper is the one place that decides this.
 */
describe('raw environment value', () => {
  it('leaves the field empty when the stored value is masked', () => {
    expect(rawValue('••••••••', true)).toBe('');
    expect(rawValue(null, true)).toBe('');
  });

  it('shows the value when it is not masked', () => {
    expect(rawValue('smtp://relay:2525', false)).toBe('smtp://relay:2525');
  });

  it('shows an empty string rather than null for an absent value', () => {
    expect(rawValue(null, false)).toBe('');
  });
});
