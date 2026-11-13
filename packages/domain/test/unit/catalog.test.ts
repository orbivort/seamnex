import { describe, expect, it } from 'vitest';
import { OperationSchema } from '../../src/schemas/catalog';

/**
 * An operation is discovered before its endpoint is measured, so both `path` and `method` are
 * optional — "discovered but not callable" is a stated state. When `path` is present it is absolute
 * from the **product origin**, never from `integration.apiBaseUrl`: joining the two produced
 * `/api/v1/api/v1/Contact`, which is why the separator rules are asserted here rather than left to
 * the caller.
 */
const discovered = {
  id: 'contacts.list',
  label: 'List contacts',
  mode: 'read',
  description: 'Returns the contacts visible to the caller.',
};

describe('discovered operation', () => {
  it('accepts an operation whose endpoint nobody has measured yet', () => {
    const parsed = OperationSchema.safeParse(discovered);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.path).toBeUndefined();
    expect(parsed.data.method).toBeUndefined();
  });

  it('accepts a path that is absolute from the product origin', () => {
    expect(
      OperationSchema.safeParse({ ...discovered, path: '/api/v1/Contact', method: 'GET' }).success,
    ).toBe(true);
  });

  it('refuses a relative path, naming the rule the author has to follow', () => {
    const parsed = OperationSchema.safeParse({ ...discovered, path: 'api/v1/Contact' });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message)).toContain('path must start with "/"');
  });

  it('refuses an empty path, which would parse as "no endpoint"', () => {
    expect(OperationSchema.safeParse({ ...discovered, path: '' }).success).toBe(false);
  });

  it('refuses a verb the product API does not expose', () => {
    expect(
      OperationSchema.safeParse({ ...discovered, path: '/api/v1/Contact', method: 'TRACE' })
        .success,
    ).toBe(false);
  });

  it('refuses a mode other than read or write', () => {
    expect(OperationSchema.safeParse({ ...discovered, mode: 'delete' }).success).toBe(false);
  });
});
