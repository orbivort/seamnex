import { describe, expect, it, vi } from 'vitest';
import { orangeHrmLogin } from '../../../../src/modules/m24-sign-in-relay/adapters/orangehrm-login';
import { loginAdapterFor } from '../../../../src/modules/m24-sign-in-relay/login-adapter';
import type {
  DriverOptions,
  ProductLoginInput,
} from '../../../../src/modules/m24-sign-in-relay/product-login.driver';

/**
 * The transport is replaced instead of stubbed: `productFetch` exists because `fetch` drops a
 * `Host` header it was given, so a suite that only ever injects `options.fetch` would leave the
 * default transport — the one production uses — completely unexercised.
 */
const { productFetchMock } = vi.hoisted(() => ({ productFetchMock: vi.fn() }));
vi.mock('../../../../src/modules/m24-sign-in-relay/product-http', () => ({
  productFetch: productFetchMock,
}));

/**
 * ADR-BE-22 — the D7 adapter's contract, pinned against the shapes OrangeHRM 5.9 actually answers
 * with (measured on a running instance, not taken from documentation):
 *
 *   * the login page is a Vue shell whose CSRF token is a component prop, and it carries no `<form>`;
 *   * a refused password is a `302` back to the login route, never a `422`;
 *   * the only durable confirmation for a self-service account is that the redirect lands on the
 *     application and that page answers `200` without the login component.
 *
 * Every case also asserts the invariant the ADR keeps across products: one attempt, and the
 * credential never appears in a result.
 */

const input: ProductLoginInput = {
  origin: 'http://orangehrm:80',
  publicOrigin: 'http://orangehrm.localhost:8020',
  username: 'jdoe',
  credential: 'correct-horse-battery-staple',
};

/** The real shell: `:token` is HTML-escaped inside the mounted component's props. */
const LOGIN_PAGE = `<html><body><div id="app">
  <auth-login :token="&quot;csrf-1&quot;"></auth-login>
</div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>`;

const APP_PAGE = '<html><body><div id="app"><oxd-layout>Dashboard</oxd-layout></div></body></html>';

function respond(init: {
  status: number;
  body?: string;
  location?: string;
  cookies?: readonly string[];
}): Response {
  const headers = new Headers();
  if (init.location !== undefined) headers.set('location', init.location);
  for (const cookie of init.cookies ?? []) headers.append('set-cookie', cookie);
  return new Response(init.body ?? '', { status: init.status, headers });
}

type Route = (request: { url: string; method: string; body: string | null }) => Response;

function driver(
  routes: Route[],
  options: Partial<DriverOptions> = {},
): DriverOptions & {
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body =
      init?.body instanceof URLSearchParams
        ? init.body.toString()
        : typeof init?.body === 'string'
          ? init.body
          : null;
    const route = routes.shift();
    if (route === undefined) {
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${String(url)}`);
    }
    return route({ url: String(url), method: init?.method ?? 'GET', body });
  });
  return { timeoutMs: 1_000, ...options, fetch: fetch as unknown } as DriverOptions & {
    fetch: ReturnType<typeof vi.fn>;
  };
}

describe('orangeHrmLogin.signIn', () => {
  it('reads the token out of the component prop, submits, and confirms the landing page', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE, cookies: ['_orangehrm=pre-auth; path=/web'] }),
      () =>
        respond({
          status: 302,
          location: 'http://orangehrm.localhost/web/index.php/dashboard/index',
          cookies: ['_orangehrm=signed-in; path=/web'],
        }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The signed-in cookie replaces the pre-auth one, and the product's own attributes are kept.
    expect(result.cookies).toEqual(['_orangehrm=signed-in; path=/web']);
    // The submitted body carries the prop's value, not a form field named `authenticity_token`.
    const post = options.fetch.mock.calls[1] as [string, RequestInit];
    expect(String(post[0])).toBe('http://orangehrm:80/web/index.php/auth/validate');
    expect(String(post[1].body)).toContain('_token=csrf-1');
    expect(String(post[1].body)).toContain('username=jdoe');
    // The credential travels in the body and never comes back in the verdict.
    expect(JSON.stringify(result)).not.toContain(input.credential);
  });

  it('treats a redirect back to the login route as a refused credential, without a second attempt', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/web/index.php/auth/login' }),
    ]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result).toEqual({
      ok: false,
      reason: 'credential_rejected',
      detail: expect.any(String),
    });
    // A stale CSRF token is indistinguishable from a bad password from outside, so retrying would
    // spend a second attempt on the one failure the ADR forbids repeating.
    expect(options.fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the page no longer mounts the login component', async () => {
    const options = driver([
      () => respond({ status: 200, body: '<html><body><h1>Sign in</h1></body></html>' }),
    ]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('form_changed');
  });

  it('fails closed when the component mounts without a token', async () => {
    const options = driver([
      () => respond({ status: 200, body: '<html><auth-login></auth-login></html>' }),
    ]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('form_changed');
  });

  it('reports a product error status instead of guessing past it', async () => {
    const options = driver([() => respond({ status: 503, body: 'unavailable' })]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('product_unavailable');
  });

  it('refuses to automate a human challenge', async () => {
    const options = driver([
      () => respond({ status: 200, body: `${LOGIN_PAGE}<input name="totp" />` }),
    ]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('human_challenge');
  });

  it('refuses a 2xx answer to the submit, because the controller only ever redirects', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 200, body: '<html>interstitial</html>' }),
    ]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('form_changed');
  });

  it('does not claim a session when the landing page still shows the login form', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/web/index.php/dashboard/index' }),
      () => respond({ status: 200, body: LOGIN_PAGE }),
    ]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('session_unconfirmed');
  });

  it('reads a token prop the build did not HTML-escape', async () => {
    const plain = '<html><body><auth-login :token="csrf-plain"></auth-login></body></html>';
    const options = driver([
      () => respond({ status: 200, body: plain }),
      () => respond({ status: 302, location: '/web/index.php/dashboard/index' }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result.ok).toBe(true);
    const post = options.fetch.mock.calls[1] as [string, RequestInit];
    expect(String(post[1].body)).toContain('_token=csrf-plain');
  });

  it('reports an empty page as a changed form, because there is no component to mount', async () => {
    const options = driver([() => respond({ status: 200, body: '' })]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'form_changed' });
    if (!result.ok) expect(result.detail).toContain('(empty body)');
  });

  it('reports an unreachable login page instead of throwing', async () => {
    const options = driver([
      () => {
        throw new Error('connect ECONNREFUSED');
      },
    ]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result).toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('connect ECONNREFUSED'),
    });
  });

  it('reports an unreachable submit without claiming the credential was refused', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => {
        throw new Error('socket hang up');
      },
    ]);

    const result = await orangeHrmLogin.signIn(input, options);

    expect(result).toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('socket hang up'),
    });
  });

  it('treats a 5xx on the submit as unavailable', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 503, body: 'unavailable' }),
    ]);

    await expect(orangeHrmLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'login answered 503',
    });
  });

  it('refuses a redirect that names no location', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302 }),
    ]);

    await expect(orangeHrmLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'login redirected without a location',
    });
  });

  it('reports a product that cannot be read during confirmation', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/web/index.php/dashboard/index' }),
      () => {
        throw new Error('connection reset');
      },
    ]);

    await expect(orangeHrmLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('connection reset'),
    });
  });

  it('refuses a confirmation redirect that names no location', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/web/index.php/dashboard/index' }),
      () => respond({ status: 302 }),
    ]);

    await expect(orangeHrmLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product redirected nowhere',
    });
  });

  it('gives up when the confirmation walk only ever redirects', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/web/index.php/dashboard/index' }),
      () => respond({ status: 302, location: '/web/index.php/pim/viewOne' }),
      () => respond({ status: 302, location: '/web/index.php/pim/viewTwo' }),
      () => respond({ status: 302, location: '/web/index.php/pim/viewThree' }),
      () => respond({ status: 302, location: '/web/index.php/pim/viewFour' }),
    ]);

    await expect(orangeHrmLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product redirected in a loop',
    });
  });

  it('reports a confirmation page that answers neither 2xx nor 3xx', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/web/index.php/dashboard/index' }),
      () => respond({ status: 404, body: 'not found' }),
    ]);

    await expect(orangeHrmLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product answered 404',
    });
  });

  it('refuses a confirmation page that carries a challenge', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/web/index.php/dashboard/index' }),
      () => respond({ status: 200, body: '<html><input name="otp" /></html>' }),
    ]);

    await expect(orangeHrmLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'human_challenge',
    });
  });
});

describe('orangeHrmLogin.verify', () => {
  it('accepts a cookie the product still redirects away from the login route', async () => {
    const options = driver([
      () => respond({ status: 302, location: '/web/index.php/dashboard/index' }),
    ]);

    const check = await orangeHrmLogin.verify(
      { ...input, cookies: ['_orangehrm=still-valid; path=/web'] },
      options,
    );

    expect(check.ok).toBe(true);
    // The jar is rebuilt from the cached attribute string, so what the hop re-emits is unchanged.
    expect(check.ok && check.cookies).toEqual(['_orangehrm=still-valid; path=/web']);
  });

  it('rejects a cookie the product no longer honours', async () => {
    const options = driver([() => respond({ status: 200, body: LOGIN_PAGE })]);

    const check = await orangeHrmLogin.verify(
      { ...input, cookies: ['_orangehrm=expired; path=/web'] },
      options,
    );

    expect(check.ok).toBe(false);
  });

  it('rejects an empty jar without touching the product', async () => {
    const options = driver([]);

    const check = await orangeHrmLogin.verify({ ...input, cookies: [] }, options);

    expect(check.ok).toBe(false);
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('reports an unreachable product as a verdict, not as a thrown error', async () => {
    const options = driver([
      () => {
        throw new Error('connect ECONNREFUSED');
      },
    ]);

    await expect(
      orangeHrmLogin.verify({ ...input, cookies: ['_orangehrm=x; path=/web'] }, options),
    ).resolves.toEqual({ ok: false, reason: 'product_unavailable' });
  });

  it('rejects a redirect the product issued without a location', async () => {
    const options = driver([() => respond({ status: 302 })]);

    await expect(
      orangeHrmLogin.verify({ ...input, cookies: ['_orangehrm=x; path=/web'] }, options),
    ).resolves.toEqual({ ok: false, reason: 'session_unconfirmed' });
  });

  it('rejects a cookie the product sends back to the login route', async () => {
    const options = driver([() => respond({ status: 302, location: '/web/index.php/auth/login' })]);

    await expect(
      orangeHrmLogin.verify({ ...input, cookies: ['_orangehrm=x; path=/web'] }, options),
    ).resolves.toEqual({ ok: false, reason: 'session_unconfirmed' });
  });

  it('uses the product transport when the caller injects none', async () => {
    productFetchMock.mockReset();
    productFetchMock.mockResolvedValueOnce(
      respond({ status: 302, location: '/web/index.php/dashboard/index' }),
    );

    const check = await orangeHrmLogin.verify(
      { ...input, cookies: ['_orangehrm=x; path=/web'] },
      { timeoutMs: 1_000 },
    );

    expect(check.ok).toBe(true);
    expect(productFetchMock).toHaveBeenCalledOnce();
  });
});

describe('loginAdapterFor', () => {
  it('resolves both spellings of an entry to the same adapter', () => {
    expect(loginAdapterFor('D7')?.name).toBe('orangehrm');
    expect(loginAdapterFor('D07-01')?.name).toBe('orangehrm');
    expect(loginAdapterFor('d7')?.name).toBe('orangehrm');
  });

  it('keeps OpenProject on the driver it was verified with', () => {
    expect(loginAdapterFor('D9')?.name).toBe('openproject');
  });

  it('answers null for a product the platform cannot drive', () => {
    expect(loginAdapterFor('D11')).toBeNull();
    expect(loginAdapterFor('D1')).toBeNull();
  });
});
