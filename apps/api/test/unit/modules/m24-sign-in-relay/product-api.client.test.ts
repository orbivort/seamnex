import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { ProductApiClient } from '../../../../src/modules/m24-sign-in-relay/product-api.client';
import type { ProductProvisioningTarget } from '../../../../src/modules/m24-sign-in-relay/provisioning-adapter';

/**
 * The admin API client is the half of the relay that sends a password it generated. Its failure
 * detail is copied into `relay.account.provision_failed` (an audit row) and a log line, so the one
 * property worth pinning is that the product cannot put the submitted value back into it.
 *
 * The rest of the suite is the HAL contract OpenProject answers with, because a shallow client is
 * the difference between "the account was created" and "a pass that reports a parse failure":
 * `id` at the top level or through `_links.self`, `_embedded.elements` on a filtered list, and
 * `204` for every call that ignores the answer.
 */
const { productFetchMock } = vi.hoisted(() => ({ productFetchMock: vi.fn() }));
vi.mock('../../../../src/modules/m24-sign-in-relay/product-http', () => ({
  productFetch: productFetchMock,
}));

const target: ProductProvisioningTarget = {
  origin: 'http://openproject:80',
  publicOrigin: 'http://openproject.localhost:8020',
  credential: { kind: 'bearer', token: 'admin-token' },
};

function client(): ProductApiClient {
  return new ProductApiClient({ SEAMNEX_RELAY_HTTP_TIMEOUT_MS: 1_000 } as unknown as AppConfig);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const user = {
  login: 'jdoe',
  password: 'hunter2-battery',
  firstName: 'Jane',
  lastName: 'Doe',
  email: null,
};

afterEach(() => {
  productFetchMock.mockReset();
});

describe('ProductApiClient.createUser', () => {
  it('creates the account and reads the numeric id OpenProject answers with', async () => {
    productFetchMock.mockResolvedValueOnce(json({ id: 9, login: 'jdoe' }, 201));

    const result = await client().createUser(target, user);

    expect(result).toEqual({ ok: true, value: { id: '9', login: 'jdoe' } });
    const [, init] = productFetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(productFetchMock.mock.calls[0]?.[0])).toBe('http://openproject:80/api/v3/users');
    // The bearer token is the instance administrator's; the host is the public name the product
    // answers for, and it is the reason this client does not use `fetch`.
    expect((init.headers as Record<string, string>).host).toBe('openproject.localhost:8020');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer admin-token');
    // No email means no `email` key at all, not an empty string.
    expect(JSON.parse(String(init.body))).toEqual({
      login: 'jdoe',
      password: 'hunter2-battery',
      firstName: 'Jane',
      lastName: 'Doe',
    });
  });

  it('forwards an address when the caller has one', async () => {
    productFetchMock.mockResolvedValueOnce(json({ id: '9' }, 201));

    const result = await client().createUser(target, { ...user, email: 'jane@example.test' });

    expect(result).toMatchObject({ ok: true, value: { id: '9' } });
    const [, init] = productFetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).email).toBe('jane@example.test');
  });

  it('falls back to the id in _links.self when the representer omits the field', async () => {
    productFetchMock.mockResolvedValueOnce(
      json(
        { _links: { self: { href: 'http://openproject.localhost:8020/api/v3/users/42' } } },
        201,
      ),
    );

    await expect(client().createUser(target, user)).resolves.toEqual({
      ok: true,
      value: { id: '42', login: 'jdoe' },
    });
  });

  it('reports a success whose answer names no user', async () => {
    productFetchMock.mockResolvedValueOnce(json({ login: 'jdoe' }, 201));

    await expect(client().createUser(target, user)).resolves.toEqual({
      ok: false,
      status: 201,
      detail: 'the answer carried no user',
    });
  });

  it('reports a success with an unparseable body', async () => {
    productFetchMock.mockResolvedValueOnce(new Response('<html>created</html>', { status: 201 }));

    await expect(client().createUser(target, user)).resolves.toMatchObject({ ok: false });
  });
});

describe('ProductApiClient.resetPassword and disableUser', () => {
  it('accepts a 204, which is how OpenProject confirms an update', async () => {
    productFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(client().resetPassword(target, 'user/9', 'new-password')).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(String(productFetchMock.mock.calls[0]?.[0])).toBe(
      'http://openproject:80/api/v3/users/user%2F9',
    );
  });

  it('accepts a PATCH whose body is not a user resource', async () => {
    // The call ignores the answer, so a 200 with anything in it is still a success.
    productFetchMock.mockResolvedValueOnce(json({ status: 'locked' }));

    await expect(client().disableUser(target, '9')).resolves.toEqual({ ok: true, value: null });
    const [, init] = productFetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ status: 'locked' });
  });

  it('reads an update that answers with a rendered user resource', async () => {
    productFetchMock.mockResolvedValueOnce(json({ id: 9, login: 'jdoe' }));

    // Rotation ignores the answer, so a representable body and an empty one are the same success.
    await expect(client().resetPassword(target, '9', 'new-password')).resolves.toEqual({
      ok: true,
      value: null,
    });
  });
});

describe('ProductApiClient.findUserByLogin', () => {
  it('filters by login and reports the administrator flag the product sends', async () => {
    productFetchMock.mockResolvedValueOnce(
      json({ _embedded: { elements: [{ id: 9, admin: true }] } }),
    );

    const result = await client().findUserByLogin(target, 'jdoe');

    expect(result).toEqual({ ok: true, value: { id: '9', admin: true } });
    const url = String(productFetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/v3/users?filters=');
    expect(decodeURIComponent(url)).toContain('[{"login":{"operator":"=","values":["jdoe"]}}]');
    // A GET carries no body, so it must not claim a content type.
    const [, init] = productFetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('reads a representer without the administrator flag as "not an administrator"', async () => {
    productFetchMock.mockResolvedValueOnce(json({ _embedded: { elements: [{ id: 9 }] } }));

    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: true,
      value: { id: '9', admin: false },
    });
  });

  it('reports no user when the filtered list is empty', async () => {
    productFetchMock.mockResolvedValueOnce(json({ _embedded: { elements: [] } }));

    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: false,
      status: 200,
      detail: 'the answer carried no user',
    });
  });

  it('reports no user when the answer has no _embedded member', async () => {
    productFetchMock.mockResolvedValueOnce(json({ count: 0 }));
    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toMatchObject({ ok: false });

    productFetchMock.mockResolvedValueOnce(json({ _embedded: 'no' }));
    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toMatchObject({ ok: false });

    productFetchMock.mockResolvedValueOnce(json({ _embedded: { elements: 'no' } }));
    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toMatchObject({ ok: false });
  });

  it('resolves the matched user through _links.self', async () => {
    productFetchMock.mockResolvedValueOnce(
      json({
        _embedded: {
          elements: [{ _links: { self: { href: '/api/v3/users/7' } }, admin: false }],
        },
      }),
    );

    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: true,
      value: { id: '7', admin: false },
    });
  });

  it('reports no user when the matched element names no id at all', async () => {
    productFetchMock.mockResolvedValueOnce(
      json({ _embedded: { elements: [{ _links: { self: { href: '/' } } }] } }),
    );

    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toMatchObject({
      ok: false,
      detail: 'the answer carried no user',
    });
  });
});

describe('ProductApiClient refusals', () => {
  /*
   * OpenProject's password-policy `422` re-describes the submitted input. The detail leaves this
   * client for an audit row, so it is scrubbed against the value in hand rather than assumed clean.
   */
  it('removes the submitted password from a product error message', async () => {
    productFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: 'Password hunter2-battery must include a special character' }),
        { status: 422 },
      ),
    );

    const result = await client().createUser(target, user);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter2-battery');
    expect(result).toMatchObject({ detail: expect.stringContaining('********') });
  });

  it('keeps a product message that carries no credential', async () => {
    productFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Login is already taken' }), { status: 422 }),
    );

    const result = await client().createUser(target, user);

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      detail: expect.stringContaining('Login is already taken'),
    });
  });

  it('refuses a target that carries a login pair instead of a token', async () => {
    const result = await client().createUser(
      { ...target, credential: { kind: 'password', username: 'admin', password: 'x' } },
      user,
    );

    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(productFetchMock).not.toHaveBeenCalled();
  });

  it('reports an unreachable product without throwing', async () => {
    productFetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(client().createUser(target, user)).resolves.toEqual({
      ok: false,
      status: 0,
      detail: 'the product could not be reached: ECONNREFUSED',
    });
  });

  it('renders a non-Error transport failure', async () => {
    productFetchMock.mockRejectedValueOnce('socket closed');

    await expect(client().createUser(target, user)).resolves.toMatchObject({
      detail: 'the product could not be reached: socket closed',
    });
  });

  it('reports a refusal that carries no body at all', async () => {
    productFetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));

    await expect(client().resetPassword(target, '9', 'x')).resolves.toEqual({
      ok: false,
      status: 500,
      detail: 'answered 500',
    });
  });

  it('strips markup from an HTML refusal, which is what Apache answers with', async () => {
    productFetchMock.mockResolvedValueOnce(
      new Response(
        '<html><body><script>leak()</script><h1>Not Found</h1><p>The page moved.</p></body></html>',
        { status: 404 },
      ),
    );

    const result = await client().disableUser(target, '9');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('answered 404:');
    expect(result.detail).toContain('Not Found');
    // Tag-free: no angle brackets reach an audit row.
    expect(result.detail).not.toContain('<');
  });

  it('does not echo a password carried by a GET-style call', async () => {
    productFetchMock.mockResolvedValueOnce(json({ message: 'Invalid user or password' }, 401));

    const result = await client().resetPassword(target, '9', '');

    // An empty password is not a credential worth scrubbing, and it is not sent as one either.
    expect(result).toMatchObject({ ok: false, detail: 'answered 401: Invalid user or password' });
  });
});
