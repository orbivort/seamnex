import { describe, expect, it } from 'vitest';
import {
  EnvProfileCreateRequestSchema,
  EnvProfileDeleteResponseSchema,
  EnvProfilePatchRequestSchema,
  EnvProfileValueWriteSchema,
  EnvProfileValuesRequestSchema,
  OperationSchema,
  RolePushSchema,
} from '../../src/schemas/catalog';

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

/**
 * FR-2.4 — the role-push declaration.
 *
 * The platform never invents an admin API path: an entry either declares the endpoint its product
 * exposes or is never pushed to, and its entitlements stay `pending` with a reason. The schema is
 * therefore strict about the parts that would otherwise become a guess at runtime.
 */
describe('role push declaration', () => {
  it('defaults the verb and the role field so the common case stays short', () => {
    const parsed = RolePushSchema.safeParse({
      path: '/api/users/roles',
      secretName: 'admin-token',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({
      path: '/api/users/roles',
      method: 'POST',
      roleField: 'role',
      secretName: 'admin-token',
    });
  });

  it('refuses a verb the helper container cannot issue', () => {
    // The push runs from a `busybox` helper whose `wget` only POSTs; accepting PUT would be a lie.
    expect(
      RolePushSchema.safeParse({
        path: '/api/users/roles',
        method: 'PUT',
        secretName: 'admin-token',
      }).success,
    ).toBe(false);
  });

  it('requires a path absolute from the instance origin and a stored credential name', () => {
    expect(RolePushSchema.safeParse({ path: 'api/users/roles', secretName: 'x' }).success).toBe(
      false,
    );
    expect(RolePushSchema.safeParse({ path: '/api/users/roles', secretName: '' }).success).toBe(
      false,
    );
  });
});

/**
 * FR-1.26 / AC-51 — the profile writes an operator may issue.
 *
 * The key is the identifier an instance pins itself to, so the shape is constrained here rather
 * than by whatever an operator types; a value or a secret reference is accepted, never both.
 */
describe('environment profile requests', () => {
  it('accepts a key an instance can pin and refuses one that would not be addressable', () => {
    expect(
      EnvProfileCreateRequestSchema.safeParse({
        key: 'production-eu',
        name: 'Production EU',
        target: 'production',
      }).success,
    ).toBe(true);

    for (const key of ['Production', '-leading', 'x', 'has space']) {
      expect(
        EnvProfileCreateRequestSchema.safeParse({ key, name: 'n', target: 'production' }).success,
        key,
      ).toBe(false);
    }
  });

  it('refuses a patch that changes nothing, which would only re-sign the row', () => {
    expect(EnvProfilePatchRequestSchema.safeParse({}).success).toBe(false);
    expect(EnvProfilePatchRequestSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
    expect(EnvProfilePatchRequestSchema.safeParse({ target: 'staging' }).success).toBe(true);
  });

  it('accepts exactly one source per value, naming the source that is wrong', () => {
    expect(
      EnvProfileValueWriteSchema.safeParse({ varName: 'ADMIN_EMAIL', value: 'ops@example.test' })
        .success,
    ).toBe(true);
    expect(
      EnvProfileValueWriteSchema.safeParse({ varName: 'DB_PASSWORD', secretRef: 'prod-db' })
        .success,
    ).toBe(true);

    const both = EnvProfileValueWriteSchema.safeParse({
      varName: 'DB_PASSWORD',
      value: 'plaintext',
      secretRef: 'prod-db',
    });
    expect(both.success).toBe(false);
    if (both.success) return;
    expect(both.error.issues[0]?.message).toBe(
      'Provide either a value or a secret reference, not both.',
    );

    const neither = EnvProfileValueWriteSchema.safeParse({ varName: 'DB_PASSWORD' });
    expect(neither.success).toBe(false);
    if (neither.success) return;
    expect(neither.error.issues[0]?.message).toBe(
      'Provide a value, or a secret reference for a secret variable.',
    );
  });

  it('replaces the whole value list, so a removal is expressible', () => {
    expect(EnvProfileValuesRequestSchema.safeParse({ values: [] }).success).toBe(true);
    expect(
      EnvProfileValuesRequestSchema.safeParse({
        values: [{ varName: 'ADMIN_EMAIL', value: 'ops@example.test' }],
      }).success,
    ).toBe(true);
    expect(
      EnvProfileValuesRequestSchema.safeParse({ values: [{ varName: 'DB_PASSWORD' }] }).success,
    ).toBe(false);
  });

  it('reports the deletion of the profile it names', () => {
    expect(EnvProfileDeleteResponseSchema.parse({ key: 'production-eu', deleted: true })).toEqual({
      key: 'production-eu',
      deleted: true,
    });
  });
});
