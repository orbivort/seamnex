import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../../src/config/config';
import { OrangeHrmApiClient } from '../../../../../src/modules/m24-sign-in-relay/adapters/orangehrm-api';
import type { ProductProvisioningTarget } from '../../../../../src/modules/m24-sign-in-relay/provisioning-adapter';

/**
 * ADR-BE-22 §Credentials — D7 OrangeHRM provisioning over the product's own REST API v2.
 *
 * Three measured facts drive the shape of this client, and each one is a way a copied OpenProject
 * adapter would fail:
 *
 *   * the API takes a **session**, not a token, so the administrator is signed in through the
 *     product's own form and the cookie is held in memory only;
 *   * a user needs an **employee**, so a failed user create has to remove the employee it just made;
 *   * an update requires **every** field plus `changePassword`, which is why rotation and disable
 *     read the record first instead of sending a partial body.
 */
const { productFetchMock, signInMock } = vi.hoisted(() => ({
  productFetchMock: vi.fn(),
  signInMock: vi.fn(),
}));

vi.mock('../../../../../src/modules/m24-sign-in-relay/product-http', () => ({
  productFetch: productFetchMock,
}));

vi.mock('../../../../../src/modules/m24-sign-in-relay/adapters/orangehrm-login', () => ({
  orangeHrmLogin: { name: 'orangehrm', signIn: signInMock, verify: vi.fn() },
}));

const target: ProductProvisioningTarget = {
  origin: 'http://orangehrm:80',
  publicOrigin: 'http://orangehrm.localhost:8020',
  credential: { kind: 'password', username: 'Admin', password: 'admin-secret' },
};

const user = {
  login: 'jdoe',
  password: 'generated-password',
  firstName: 'Jane',
  lastName: 'Doe',
  email: null,
};

const EMPLOYEES = '/web/index.php/api/v2/pim/employees';
const USERS = '/web/index.php/api/v2/admin/users';

function client(): OrangeHrmApiClient {
  return new OrangeHrmApiClient({
    SEAMNEX_RELAY_HTTP_TIMEOUT_MS: 1_000,
  } as unknown as AppConfig);
}

function data(body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data: body }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function raw(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function refused(body: unknown, status = 422): Response {
  return new Response(JSON.stringify({ error: body }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The record shape `setUserParams` insists on: every field, or the update is a `422`. */
function accountRow(): Response {
  return data({
    userName: 'jdoe',
    status: true,
    userRole: { id: 2 },
    employee: { empNumber: 12 },
  });
}

beforeEach(() => {
  signInMock.mockResolvedValue({ ok: true, cookies: ['_orangehrm=session-1; path=/web'] });
});

afterEach(() => {
  productFetchMock.mockReset();
  signInMock.mockReset();
});

describe('OrangeHrmApiClient.createUser', () => {
  it('creates the employee, then the ESS user, with the administrator session', async () => {
    productFetchMock
      .mockResolvedValueOnce(data({ empNumber: 12 }))
      .mockResolvedValueOnce(data({ id: 5 }));

    const result = await client().createUser(target, user);

    expect(result).toEqual({ ok: true, value: { id: '5', login: 'jdoe' } });
    const [employeeUrl, employeeInit] = productFetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(employeeUrl)).toBe(`http://orangehrm:80${EMPLOYEES}`);
    expect(JSON.parse(String(employeeInit.body))).toEqual({ firstName: 'Jane', lastName: 'Doe' });
    // A session, not a token: the cookie comes from the administrator sign-in.
    expect((employeeInit.headers as Record<string, string>).cookie).toBe('_orangehrm=session-1');
    expect((employeeInit.headers as Record<string, string>).host).toBe('orangehrm.localhost:8020');

    const [userUrl, userInit] = productFetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(userUrl)).toBe(`http://orangehrm:80${USERS}`);
    expect(JSON.parse(String(userInit.body))).toEqual({
      username: 'jdoe',
      password: 'generated-password',
      status: true,
      // ESS: never an administrator. Least privilege is the ADR's rule, not a default.
      userRoleId: 2,
      empNumber: 12,
    });
  });

  it('reports a refusal to create the employee without trying to create the user', async () => {
    productFetchMock.mockResolvedValueOnce(refused({ message: 'Invalid Parameter' }));

    const result = await client().createUser(target, user);

    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(productFetchMock).toHaveBeenCalledOnce();
  });

  it('reports an employee record with no number', async () => {
    productFetchMock.mockResolvedValueOnce(data({}));

    await expect(client().createUser(target, user)).resolves.toEqual({
      ok: false,
      status: 0,
      detail: 'the product created no employee record',
    });
  });

  it('removes the employee it just created when the user cannot be attached', async () => {
    productFetchMock
      .mockResolvedValueOnce(data({ empNumber: 12 }))
      .mockResolvedValueOnce(
        refused({ status: 422, message: 'Invalid Parameter', data: { invalidParamKeys: ['foo'] } }),
      )
      // A 200 with no body is what the product answers the delete with.
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    const result = await client().createUser(target, user);

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      detail: 'answered 422: Invalid Parameter (foo)',
    });
    const [deleteUrl, deleteInit] = productFetchMock.mock.calls[2] as [string, RequestInit];
    expect(String(deleteUrl)).toBe(`http://orangehrm:80${EMPLOYEES}`);
    // An employee with no user is invisible in the product; leaving one per failed pass is how an
    // HR database fills with people the platform invented.
    expect(deleteInit.method).toBe('DELETE');
    expect(JSON.parse(String(deleteInit.body))).toEqual({ ids: [12] });
  });

  it('reports a user record with no id', async () => {
    productFetchMock.mockResolvedValueOnce(data({ empNumber: 12 })).mockResolvedValueOnce(data({}));

    await expect(client().createUser(target, user)).resolves.toEqual({
      ok: false,
      status: 0,
      detail: 'the product created no user record',
    });
  });
});

describe('OrangeHrmApiClient.resetPassword and disableUser', () => {
  it('reads the account first, then updates it with every required field', async () => {
    productFetchMock
      .mockResolvedValueOnce(accountRow())
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(client().resetPassword(target, '5', 'rotated-password')).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    const [readUrl] = productFetchMock.mock.calls[0] as [string];
    expect(String(readUrl)).toBe(`http://orangehrm:80${USERS}/5`);
    const [putUrl, putInit] = productFetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(putUrl)).toBe(`http://orangehrm:80${USERS}/5`);
    expect(putInit.method).toBe('PUT');
    expect(JSON.parse(String(putInit.body))).toEqual({
      username: 'jdoe',
      status: true,
      userRoleId: 2,
      empNumber: 12,
      changePassword: true,
      password: 'rotated-password',
    });
  });

  it('locks the account with changePassword off and an empty password', async () => {
    productFetchMock
      .mockResolvedValueOnce(accountRow())
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    await client().disableUser(target, '5');

    const [, putInit] = productFetchMock.mock.calls[1] as [string, RequestInit];
    // `password` is required on update whatever `changePassword` says; the product's own edit form
    // sends an empty string when the box is unchecked, and ignores the value.
    expect(JSON.parse(String(putInit.body))).toEqual({
      username: 'jdoe',
      status: false,
      userRoleId: 2,
      empNumber: 12,
      changePassword: false,
      password: '',
    });
  });

  it('returns the read failure instead of writing a partial body', async () => {
    productFetchMock.mockResolvedValueOnce(refused({ message: 'Record Not Found' }, 404));

    await expect(client().resetPassword(target, '5', 'x')).resolves.toMatchObject({
      ok: false,
      status: 404,
    });
    expect(productFetchMock).toHaveBeenCalledOnce();
  });

  it('names the fields an update needs when the record does not describe them', async () => {
    productFetchMock.mockResolvedValueOnce(data({ userName: 'jdoe' }));

    await expect(client().disableUser(target, '5')).resolves.toEqual({
      ok: false,
      status: 0,
      detail: 'the product described the account without the fields an update requires',
    });
  });
});

describe('OrangeHrmApiClient.findUserByLogin', () => {
  it('filters by username and derives the administrator flag from the role', async () => {
    productFetchMock.mockResolvedValueOnce(data([{ id: 5, userRole: { name: 'Admin' } }]));

    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: true,
      value: { id: '5', admin: true },
    });
    expect(String(productFetchMock.mock.calls[0]?.[0])).toBe(
      `http://orangehrm:80${USERS}?username=jdoe`,
    );
  });

  it('reads a role that is not Admin as a self-service account', async () => {
    productFetchMock.mockResolvedValueOnce(data([{ id: 5, userRole: { name: 'ESS' } }]));
    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: true,
      value: { id: '5', admin: false },
    });

    productFetchMock.mockResolvedValueOnce(data([{ id: 5 }]));
    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: true,
      value: { id: '5', admin: false },
    });
  });

  it('reports no user for an empty list and for a row without a numeric id', async () => {
    productFetchMock.mockResolvedValueOnce(data([]));
    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: true,
      value: null,
    });

    productFetchMock.mockResolvedValueOnce(data([{ id: 'five' }]));
    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it('accepts a bare array when the product omits the data envelope', async () => {
    productFetchMock.mockResolvedValueOnce(raw(JSON.stringify([{ id: 5 }])));

    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: true,
      value: { id: '5', admin: false },
    });
  });
});

describe('OrangeHrmApiClient session handling', () => {
  it('holds the administrator session for the length of a sweep', async () => {
    productFetchMock
      .mockResolvedValueOnce(accountRow())
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(accountRow())
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    const api = client();
    await api.resetPassword(target, '5', 'one');
    await api.resetPassword(target, '6', 'two');

    // One product sign-in, not one per row.
    expect(signInMock).toHaveBeenCalledOnce();
  });

  it('re-signs-in once when the product drops the session, then repeats the call', async () => {
    productFetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(accountRow())
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(client().resetPassword(target, '5', 'one')).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    // A session that expired between passes is a cache miss, not a product failure.
    expect(signInMock).toHaveBeenCalledTimes(2);
  });

  it('retries once and reports the second 401 without looping', async () => {
    productFetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(refused({ message: 'Unauthorized' }, 401));

    const result = await client().disableUser(target, '5');

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(productFetchMock).toHaveBeenCalledTimes(2);
    expect(signInMock).toHaveBeenCalledTimes(2);
  });

  it('reports an administrator sign-in the product refused', async () => {
    signInMock.mockResolvedValueOnce({ ok: false, reason: 'credential_rejected', detail: 'no' });

    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: false,
      status: 0,
      detail: 'the administrator could not sign in: credential_rejected',
    });
    expect(productFetchMock).not.toHaveBeenCalled();
  });

  it('refuses a target that carries a token instead of a login pair', async () => {
    const result = await client().findUserByLogin(
      { ...target, credential: { kind: 'bearer', token: 'x' } },
      'jdoe',
    );

    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(productFetchMock).not.toHaveBeenCalled();
  });
});

describe('OrangeHrmApiClient transport refusals', () => {
  it('reports an unreachable product and a non-Error failure', async () => {
    productFetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: false,
      status: 0,
      detail: 'the product could not be reached: ECONNREFUSED',
    });

    productFetchMock.mockRejectedValueOnce('socket closed');
    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toMatchObject({
      detail: 'the product could not be reached: socket closed',
    });
  });

  it('renders a refusal that carries no JSON at all', async () => {
    productFetchMock.mockResolvedValueOnce(
      new Response('<html>Bad Gateway</html>', { status: 502 }),
    );

    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toEqual({
      ok: false,
      status: 502,
      detail: 'answered 502',
    });
  });

  it('renders a refusal whose error member carries no message', async () => {
    productFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { status: 422, data: 'x' } }), { status: 422 }),
    );

    await expect(client().findUserByLogin(target, 'jdoe')).resolves.toMatchObject({
      detail: 'answered 422: refused',
    });
  });
});
