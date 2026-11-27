import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../../src/config/config';
import { MauticApiClient } from '../../../../../src/modules/m24-sign-in-relay/adapters/mautic-api';
import type { ProductProvisioningTarget } from '../../../../../src/modules/m24-sign-in-relay/provisioning-adapter';

/**
 * ADR-BE-22 §Credentials — D2 Mautic 7.2.2 provisioning, over the product's REST API.
 *
 * Every case below is pinned to something measured on the running instance on 2026-11-20, and each
 * one is a way a copied OpenProject or OrangeHRM client would silently do the wrong thing:
 *
 *   * `PATCH` accepts `plainPassword` and ignores it, so rotation must replace the account;
 *   * a listing is `{total, users: […]}`, and the exact-match filter is the `where` grammar;
 *   * the only role a fresh install ships is Administrator, so a least-privilege role is created;
 *   * the API is off by default, and its refusal has to name the switches an operator can flip.
 */
const { productFetchMock } = vi.hoisted(() => ({ productFetchMock: vi.fn() }));

vi.mock('../../../../../src/modules/m24-sign-in-relay/product-http', () => ({
  productFetch: productFetchMock,
}));

const target: ProductProvisioningTarget = {
  origin: 'http://mautic:80',
  publicOrigin: 'https://mautic.seamnex.localhost:8443',
  credential: { kind: 'password', username: 'admin', password: 'admin-secret' },
};

const user = {
  login: 'jdoe',
  password: 'generated-password',
  firstName: 'Jane',
  lastName: 'Doe',
  email: null,
};

function client(): MauticApiClient {
  return new MauticApiClient({ SEAMNEX_RELAY_HTTP_TIMEOUT_MS: 1_000 } as unknown as AppConfig);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function roles(list: { id: number; name: string; isAdmin: boolean }[]): Response {
  return json({ total: list.length, roles: list });
}

function created(id: number): Response {
  return json({ user: { id, username: 'jdoe' } }, 201);
}

function call(index: number): { url: string; init: RequestInit } {
  const entry = productFetchMock.mock.calls[index] as [string, RequestInit];
  return { url: String(entry[0]), init: entry[1] };
}

function body(index: number): Record<string, unknown> {
  return JSON.parse(String(call(index).init.body)) as Record<string, unknown>;
}

afterEach(() => {
  productFetchMock.mockReset();
});

describe('MauticApiClient', () => {
  it('creates a non-administrator role with no permissions, then the account in it', async () => {
    productFetchMock
      .mockResolvedValueOnce(roles([{ id: 1, name: 'Administrator', isAdmin: true }]))
      .mockResolvedValueOnce(json({ role: { id: 4, name: 'Relay', isAdmin: false } }, 201))
      .mockResolvedValueOnce(created(2));

    const result = await client().createUser(target, user);

    expect(result).toEqual({ ok: true, value: { id: '2', login: 'jdoe' } });

    const roleCall = call(1);
    expect(roleCall.url).toBe('http://mautic:80/api/roles/new');
    expect(body(1)).toMatchObject({
      name: 'Relay',
      isAdmin: false,
      rawPermissions: [],
    });

    const createCall = call(2);
    expect(createCall.url).toBe('http://mautic:80/api/users/new');
    expect(createCall.init.method).toBe('POST');
    expect(body(2)).toEqual({
      username: 'jdoe',
      firstName: 'Jane',
      lastName: 'Doe',
      // Mautic requires an address; one is derived from the public host, never invented as a name.
      email: 'jdoe@mautic.seamnex.localhost',
      plainPassword: { password: 'generated-password', confirm: 'generated-password' },
      role: 4,
      isPublished: 1,
    });
  });

  it('reuses the role the product already has and caches it across calls', async () => {
    productFetchMock
      .mockResolvedValueOnce(roles([{ id: 4, name: 'Relay', isAdmin: false }]))
      .mockResolvedValueOnce(created(2))
      .mockResolvedValueOnce(created(3));

    const clientUnderTest = client();
    await clientUnderTest.createUser(target, user);
    await clientUnderTest.createUser(target, { ...user, login: 'asmith', email: 'asmith@x' });

    // role listing, create, create — no second listing and no role creation.
    expect(productFetchMock).toHaveBeenCalledTimes(3);
    expect(call(0).url).toBe('http://mautic:80/api/roles?limit=100');
    expect(body(2)).toMatchObject({ username: 'asmith', role: 4 });
  });

  it('refuses to assign a Relay role that is an administrator', async () => {
    productFetchMock.mockResolvedValueOnce(roles([{ id: 4, name: 'Relay', isAdmin: true }]));

    const result = await client().createUser(target, user);

    expect(result).toMatchObject({ ok: false, status: 0 });
    if (!result.ok) expect(result.detail).toContain('administrator');
    // No account was created with rights the platform did not grant.
    expect(productFetchMock).toHaveBeenCalledOnce();
  });

  it('adopts a role another pass created when its own creation is refused', async () => {
    productFetchMock
      .mockResolvedValueOnce(roles([{ id: 1, name: 'Administrator', isAdmin: true }]))
      .mockResolvedValueOnce(json({ errors: [{ message: 'duplicate' }] }, 400))
      .mockResolvedValueOnce(roles([{ id: 5, name: 'Relay', isAdmin: false }]))
      .mockResolvedValueOnce(created(7));

    const result = await client().createUser(target, user);

    expect(result.ok).toBe(true);
    expect(body(3)).toMatchObject({ role: 5 });
  });

  it('finds a login through the exact-match filter and reads admin from the role', async () => {
    productFetchMock
      .mockResolvedValueOnce(
        json({
          total: 1,
          users: [{ id: 2, username: 'jdoe', role: { id: 1, isAdmin: true } }],
        }),
      )
      .mockResolvedValueOnce(json({ total: 0, users: [] }));

    const found = await client().findUserByLogin(target, 'jdoe');
    expect(found).toEqual({ ok: true, value: { id: '2', admin: true } });

    const query = call(0).url;
    // `?search=` would let `jdoe` adopt `jdoe2`; the `where` grammar is an exact match.
    expect(query).toContain('where[0][col]=username');
    expect(query).toContain('where[0][expr]=eq');
    expect(query).toContain('where[0][val]=jdoe');

    await expect(client().findUserByLogin(target, 'nobody')).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it('treats a row without a role object as a non-administrator', async () => {
    productFetchMock.mockResolvedValueOnce(json({ total: 1, users: [{ id: 9 }] }));

    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: true,
      value: { id: '9', admin: false },
    });
  });

  it('rotates by reading, deleting and recreating — never by PATCHing a password', async () => {
    productFetchMock
      .mockResolvedValueOnce(
        json({
          user: {
            id: 2,
            username: 'jdoe',
            firstName: 'Jane',
            lastName: 'Doe',
            email: 'jdoe@mautic.seamnex.localhost',
            role: { id: 4 },
            isPublished: 1,
          },
        }),
      )
      .mockResolvedValueOnce(json({ user: { id: 2 } }))
      .mockResolvedValueOnce(created(3));

    const result = await client().resetPassword(target, '2', 'next-password');

    expect(result).toEqual({ ok: true, value: null });

    const methods = productFetchMock.mock.calls.map((entry) => (entry[1] as RequestInit).method);
    // The API answers `200` to a PATCH that changes nothing, so a PATCH here would store a password
    // the product never accepted.
    expect(methods).toEqual(['GET', 'DELETE', 'POST']);
    expect(call(1).url).toBe('http://mautic:80/api/users/2/delete');
    expect(body(2)).toMatchObject({
      username: 'jdoe',
      email: 'jdoe@mautic.seamnex.localhost',
      role: 4,
      plainPassword: { password: 'next-password', confirm: 'next-password' },
    });
  });

  it('does not delete an account it could not first describe', async () => {
    productFetchMock.mockResolvedValueOnce(json({ user: { id: 2, username: 'jdoe' } }));

    const result = await client().resetPassword(target, '2', 'next-password');

    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(productFetchMock).toHaveBeenCalledOnce();
  });

  it('reports a replacement that was removed but not recreated', async () => {
    productFetchMock
      .mockResolvedValueOnce(
        json({
          user: {
            id: 2,
            username: 'jdoe',
            firstName: 'Jane',
            lastName: 'Doe',
            email: 'jdoe@x',
            role: { id: 4 },
          },
        }),
      )
      .mockResolvedValueOnce(json({ user: { id: 2 } }))
      .mockResolvedValueOnce(json({ user: {} }, 201));

    const result = await client().resetPassword(target, '2', 'next-password');

    expect(result).toMatchObject({ ok: false, status: 0 });
    if (!result.ok) expect(result.detail).toContain('created no replacement');
  });

  it('locks an account with isPublished instead of deleting it', async () => {
    productFetchMock.mockResolvedValueOnce(json({ user: { id: 2, isPublished: false } }));

    const result = await client().disableUser(target, '2');

    expect(result.ok).toBe(true);
    expect(call(0).url).toBe('http://mautic:80/api/users/2/edit');
    expect(call(0).init.method).toBe('PATCH');
    expect(body(0)).toEqual({ isPublished: false });
  });

  it('names the config switches when the product API is off', async () => {
    productFetchMock.mockResolvedValueOnce(
      json({ errors: [{ message: 'API disabled', code: 403, type: 'api_disabled' }] }, 403),
    );

    const result = await client().findUserByLogin(target, 'jdoe');

    expect(result).toMatchObject({ ok: false, status: 403 });
    if (!result.ok) expect(result.detail).toContain('api_enabled');
  });

  it('names the basic-auth switch when the API refuses the header', async () => {
    productFetchMock.mockResolvedValueOnce(
      json({ errors: [{ message: 'Basic Auth disabled', code: 403 }] }, 403),
    );

    const result = await client().disableUser(target, '2');

    expect(result).toMatchObject({ ok: false, status: 403 });
    if (!result.ok) expect(result.detail).toContain('api_enable_basic_auth');
  });

  it('speaks to the product the way the edge would: host, forwarded scheme and basic auth', async () => {
    productFetchMock.mockResolvedValueOnce(roles([{ id: 4, name: 'Relay', isAdmin: false }]));
    productFetchMock.mockResolvedValueOnce(created(2));

    await client().createUser(target, user);

    const headers = new Headers(call(1).init.headers);
    expect(headers.get('host')).toBe('mautic.seamnex.localhost:8443');
    expect(headers.get('x-forwarded-proto')).toBe('https');
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from('admin:admin-secret').toString('base64')}`,
    );
    // The per-user credential is never in a header; it only ever travels in the create body.
    expect(JSON.stringify(headers)).not.toContain('generated-password');
  });

  it('reports an unreachable product instead of throwing', async () => {
    productFetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const result = await client().findUserByLogin(target, 'jdoe');

    expect(result).toMatchObject({
      ok: false,
      status: 0,
      detail: expect.stringContaining('connect ECONNREFUSED'),
    });
  });

  it('reports a non-Error rejection without losing the reason', async () => {
    // A fetch polyfill can reject with anything; the detail still has to say what happened.
    productFetchMock.mockRejectedValueOnce('socket hang up');

    const result = await client().findUserByLogin(target, 'jdoe');

    expect(result).toMatchObject({ ok: false, status: 0 });
    if (!result.ok) expect(result.detail).toContain('socket hang up');
  });

  it('refuses a target that carries a token instead of an administrator login pair', async () => {
    const result = await client().findUserByLogin(
      { ...target, credential: { kind: 'bearer', token: 'bearer-secret' } },
      'jdoe',
    );

    expect(result).toMatchObject({ ok: false, status: 0 });
    if (!result.ok) expect(result.detail).toContain('administrator login pair');
    // Nothing was sent: the wrong credential never reaches the product.
    expect(productFetchMock).not.toHaveBeenCalled();
  });

  it('reports the refusal when the product will not create the account', async () => {
    productFetchMock
      .mockResolvedValueOnce(roles([{ id: 4, name: 'Relay', isAdmin: false }]))
      .mockResolvedValueOnce(json({ errors: [{ message: 'username already in use' }] }, 400));

    const result = await client().createUser(target, user);

    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.detail).toContain('username already in use');
  });

  it('reports a create the product answered without a user record', async () => {
    productFetchMock
      .mockResolvedValueOnce(roles([{ id: 4, name: 'Relay', isAdmin: false }]))
      .mockResolvedValueOnce(json({ user: { username: 'jdoe' } }, 201));

    const result = await client().createUser(target, user);

    expect(result).toMatchObject({ ok: false, status: 0 });
    if (!result.ok) expect(result.detail).toContain('created no user record');
  });

  it('reports a role listing the product refused, without trying to create anything', async () => {
    productFetchMock.mockResolvedValueOnce(json({ errors: [{ message: 'forbidden' }] }, 403));

    const result = await client().createUser(target, user);

    expect(result).toMatchObject({ ok: false, status: 403 });
    // A listing failure is not an invitation to create a second role.
    expect(productFetchMock).toHaveBeenCalledOnce();
  });

  it('creates the role when the listing carries no roles array at all', async () => {
    productFetchMock
      .mockResolvedValueOnce(json({ total: 0 }))
      .mockResolvedValueOnce(json({ role: { id: 4, name: 'Relay', isAdmin: false } }, 201))
      .mockResolvedValueOnce(created(2));

    const result = await client().createUser(target, user);

    expect(result).toEqual({ ok: true, value: { id: '2', login: 'jdoe' } });
    expect(call(1).url).toBe('http://mautic:80/api/roles/new');
  });

  it('surfaces the creation refusal when the retry listing also fails', async () => {
    productFetchMock
      .mockResolvedValueOnce(roles([{ id: 1, name: 'Administrator', isAdmin: true }]))
      .mockResolvedValueOnce(json({ errors: [{ message: 'duplicate role' }] }, 400))
      .mockResolvedValueOnce(json({ errors: [{ message: 'forbidden' }] }, 403));

    const result = await client().createUser(target, user);

    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.detail).toContain('duplicate role');
  });

  it('reports a creation that answered without a role id when the retry listing fails', async () => {
    productFetchMock
      .mockResolvedValueOnce(roles([{ id: 1, name: 'Administrator', isAdmin: true }]))
      .mockResolvedValueOnce(json({ role: { name: 'Relay' } }, 201))
      .mockResolvedValueOnce(json({ errors: [{ message: 'forbidden' }] }, 403));

    const result = await client().createUser(target, user);

    expect(result).toMatchObject({ ok: false, status: 0 });
    if (!result.ok) expect(result.detail).toContain('created no Relay role');
  });

  it('reports a Relay role the product never exposes', async () => {
    productFetchMock
      .mockResolvedValueOnce(roles([{ id: 1, name: 'Administrator', isAdmin: true }]))
      // Accepted, but with no id: the client cannot tell what it just made.
      .mockResolvedValueOnce(json({ role: { name: 'Relay' } }, 201))
      .mockResolvedValueOnce(roles([{ id: 1, name: 'Administrator', isAdmin: true }]));

    const result = await client().createUser(target, user);

    expect(result).toMatchObject({ ok: false, status: 0 });
    if (!result.ok) expect(result.detail).toContain('did not expose a Relay role');
    expect(productFetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports a user record the product refused to read', async () => {
    productFetchMock.mockResolvedValueOnce(json({ errors: [{ message: 'not found' }] }, 404));

    const result = await client().resetPassword(target, '2', 'next-password');

    expect(result).toMatchObject({ ok: false, status: 404 });
    // An unread account is never deleted on the strength of a guess.
    expect(productFetchMock).toHaveBeenCalledOnce();
  });

  it('does not recreate an account whose delete was refused', async () => {
    productFetchMock
      .mockResolvedValueOnce(
        json({
          user: {
            id: 2,
            username: 'jdoe',
            firstName: 'Jane',
            lastName: 'Doe',
            email: 'jdoe@x',
            role: { id: 4 },
          },
        }),
      )
      .mockResolvedValueOnce(json({ errors: [{ message: 'cannot delete' }] }, 500));

    const result = await client().resetPassword(target, '2', 'next-password');

    expect(result).toMatchObject({ ok: false, status: 500 });
    if (!result.ok) expect(result.detail).toContain('cannot delete');
    // Deleting then failing to recreate would leave the mapping without an account.
    expect(productFetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a replacement the product refused to create', async () => {
    productFetchMock
      .mockResolvedValueOnce(
        json({
          user: {
            id: 2,
            username: 'jdoe',
            firstName: 'Jane',
            lastName: 'Doe',
            email: 'jdoe@x',
            role: { id: 4 },
          },
        }),
      )
      .mockResolvedValueOnce(json({ user: { id: 2 } }))
      .mockResolvedValueOnce(json({ errors: [{ message: 'username already in use' }] }, 400));

    const result = await client().resetPassword(target, '2', 'next-password');

    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.detail).toContain('username already in use');
  });

  it('accepts an empty answer as success', async () => {
    productFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await client().disableUser(target, '2');

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('treats a non-object JSON answer as empty', async () => {
    productFetchMock.mockResolvedValueOnce(json('ok'));

    const result = await client().disableUser(target, '2');

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('treats an unparseable body as empty', async () => {
    // Mautic can answer a `200` with HTML when a proxy rewrites the route.
    productFetchMock.mockResolvedValueOnce(new Response('<html>proxy</html>', { status: 200 }));

    const result = await client().disableUser(target, '2');

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('accepts a body it could not read at all', async () => {
    productFetchMock.mockResolvedValueOnce({
      status: 200,
      text: () => Promise.reject(new Error('stream aborted')),
    } as unknown as Response);

    const result = await client().disableUser(target, '2');

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('answers with the status alone when the refusal carries no message', async () => {
    productFetchMock.mockResolvedValueOnce(json({ errors: ['denied'] }, 403));

    const result = await client().findUserByLogin(target, 'jdoe');

    expect(result).toMatchObject({ ok: false, status: 403, detail: 'answered 403' });
  });

  it('answers with the status alone when the refusal carries no JSON body', async () => {
    productFetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));

    const result = await client().findUserByLogin(target, 'jdoe');

    expect(result).toMatchObject({ ok: false, status: 502, detail: 'answered 502' });
  });
});
