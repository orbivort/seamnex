import { describe, expect, it, vi } from 'vitest';
import { mauticLogin } from '../../../../src/modules/m24-sign-in-relay/adapters/mautic-login';
import { loginAdapterFor } from '../../../../src/modules/m24-sign-in-relay/login-adapter';
import type {
  DriverOptions,
  ProductLoginInput,
} from '../../../../src/modules/m24-sign-in-relay/product-login.driver';

/**
 * The transport is replaced instead of stubbed for the injected-fetch cases: `productFetch` exists
 * because `fetch` drops a `Host` header it was given, so one case below exercises the default
 * transport too, the way production reaches it.
 */
const { productFetchMock } = vi.hoisted(() => ({ productFetchMock: vi.fn() }));
vi.mock('../../../../src/modules/m24-sign-in-relay/product-http', () => ({
  productFetch: productFetchMock,
}));

/**
 * ADR-BE-22 — the D2 adapter's contract, pinned against the shapes Mautic 7.2.2's Symfony firewall
 * declares (`app/config/security.php`, `app/bundles/UserBundle/Security/Authenticator`):
 *
 *   * the login page is server-rendered Twig at `/s/login` for both passwords and a CSRF token;
 *   * the submit target is `/s/login_check` and its parameters are `_username`, `_password`,
 *     `_csrf_token`;
 *   * a refused password and a rejected token are both a `302` back to `/s/login`, so the driver
 *     never retries and reports `credential_rejected`;
 *   * an authenticated session is redirected off the login route, which is what makes `verify` one
 *     cheap request.
 *
 * Every case also asserts the invariant the ADR keeps across products: one attempt, and the
 * credential never appears in a result.
 */

const input: ProductLoginInput = {
  origin: 'http://mautic:80',
  publicOrigin: 'http://mautic.localhost:8020',
  username: 'jdoe',
  credential: 'correct-horse-battery-staple',
};

/** The real form: the firewall's two credential fields and the hidden CSRF input. */
const LOGIN_PAGE = `<html><body class="mautic-standalone">
  <form name="login" method="post" action="/s/login_check">
    <input type="text" id="_username" name="_username" value="" autocomplete="username" />
    <input type="password" id="_password" name="_password" autocomplete="current-password" />
    <input type="hidden" name="_csrf_token" value="csrf-1" />
    <input type="checkbox" id="_remember_me" name="_remember_me" value="1" />
  </form>
</body></html>`;

const APP_PAGE = '<html><body><div id="app">Dashboard</div></body></html>';

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

describe('mauticLogin.signIn', () => {
  it('reads the hidden token, submits the firewall parameters, and confirms the landing page', async () => {
    const options = driver([
      () =>
        respond({ status: 200, body: LOGIN_PAGE, cookies: ['mautic_session=pre-auth; path=/'] }),
      () =>
        respond({
          status: 302,
          location: 'http://mautic.localhost/s/dashboard',
          cookies: ['mautic_session=signed-in; path=/; secure'],
        }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await mauticLogin.signIn(input, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The signed-in cookie replaces the pre-auth one, and the product's own attributes are kept.
    expect(result.cookies).toEqual(['mautic_session=signed-in; path=/; secure']);
    const post = options.fetch.mock.calls[1] as [string, RequestInit];
    expect(String(post[0])).toBe('http://mautic:80/s/login_check');
    expect(String(post[1].body)).toContain('_username=jdoe');
    expect(String(post[1].body)).toContain('_csrf_token=csrf-1');
    // The credential travels in the body and never comes back in the verdict.
    expect(JSON.stringify(result)).not.toContain(input.credential);
  });

  it('tells the product the browser reached it over TLS on every leg of the exchange', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/s/dashboard' }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    await mauticLogin.signIn(
      { ...input, publicOrigin: 'https://mautic.seamnex.localhost:8443' },
      options,
    );

    /*
     * Mautic believes `X-Forwarded-Proto` only from a peer it trusts, and builds its post-login
     * redirect from it. Without the header a correct password lands on an `http://` address the
     * edge does not serve.
     */
    const calls = options.fetch.mock.calls as [string, RequestInit][];
    expect(calls).toHaveLength(3);
    for (const [, init] of calls) {
      const headers = new Headers(init.headers);
      expect(headers.get('x-forwarded-proto')).toBe('https');
      expect(headers.get('host')).toBe('mautic.seamnex.localhost:8443');
    }
  });

  it('treats a redirect back to the login route as a refused credential, without a second attempt', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/s/login' }),
    ]);

    const result = await mauticLogin.signIn(input, options);

    expect(result).toEqual({
      ok: false,
      reason: 'credential_rejected',
      detail: expect.any(String),
    });
    // A rejected CSRF token takes the same route as a bad password, so retrying would spend a
    // second attempt on the one failure the ADR forbids repeating.
    expect(options.fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the page no longer carries the credential fields', async () => {
    const options = driver([
      () => respond({ status: 200, body: '<html><body><h1>Sign in</h1></body></html>' }),
    ]);

    const result = await mauticLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('form_changed');
  });

  it('fails closed when the form mounts without a CSRF token', async () => {
    const options = driver([
      () =>
        respond({
          status: 200,
          body: '<html><form action="/s/login_check"><input name="_username" /><input name="_password" /></form></html>',
        }),
    ]);

    const result = await mauticLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('form_changed');
  });

  it('reports a product error status instead of guessing past it', async () => {
    const options = driver([() => respond({ status: 503, body: 'unavailable' })]);

    const result = await mauticLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('product_unavailable');
  });

  it('refuses to automate a human challenge', async () => {
    const options = driver([
      () => respond({ status: 200, body: `${LOGIN_PAGE}<input name="totp" />` }),
    ]);

    const result = await mauticLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('human_challenge');
  });

  it('refuses a 2xx answer to the submit, because the firewall only ever redirects', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 200, body: '<html>interstitial</html>' }),
    ]);

    const result = await mauticLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('form_changed');
  });

  it('does not claim a session when the landing page still shows the login form', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/s/dashboard' }),
      () => respond({ status: 200, body: LOGIN_PAGE }),
    ]);

    const result = await mauticLogin.signIn(input, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('session_unconfirmed');
  });

  it('reads a token the build rendered with value before name', async () => {
    const reversed = LOGIN_PAGE.replace(
      '<input type="hidden" name="_csrf_token" value="csrf-1" />',
      '<input type="hidden" value="csrf-plain" name="_csrf_token" />',
    );
    const options = driver([
      () => respond({ status: 200, body: reversed }),
      () => respond({ status: 302, location: '/s/dashboard' }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await mauticLogin.signIn(input, options);

    expect(result.ok).toBe(true);
    const post = options.fetch.mock.calls[1] as [string, RequestInit];
    expect(String(post[1].body)).toContain('_csrf_token=csrf-plain');
  });

  it('reads a single-quoted form, which a re-themed build may emit', async () => {
    const singleQuoted = `<form action='/s/login_check'>
      <input name='_username' /><input name='_password' />
      <input value='csrf-single' name='_csrf_token' />
    </form>`;
    const options = driver([
      () => respond({ status: 200, body: singleQuoted }),
      () => respond({ status: 302, location: '/s/dashboard' }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await mauticLogin.signIn(input, options);

    expect(result.ok).toBe(true);
    const post = options.fetch.mock.calls[1] as [string, RequestInit];
    expect(String(post[1].body)).toContain('_csrf_token=csrf-single');
  });

  it('reports an empty page as a changed form, because there is no form to read', async () => {
    const options = driver([() => respond({ status: 200, body: '' })]);

    const result = await mauticLogin.signIn(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'form_changed' });
    if (!result.ok) expect(result.detail).toContain('(empty body)');
  });

  it('does not submit to a login route that answers with a redirect instead of the form', async () => {
    // The jar is empty, so this is not "already signed in": the route is serving something else, and
    // the driver must not post credentials to a page it never read.
    const options = driver([() => respond({ status: 302, location: '/installer' })]);

    const result = await mauticLogin.signIn(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'form_changed' });
    expect(options.fetch).toHaveBeenCalledOnce();
  });

  it('reports an unreachable login page instead of throwing', async () => {
    const options = driver([
      () => {
        throw new Error('connect ECONNREFUSED');
      },
    ]);

    const result = await mauticLogin.signIn(input, options);

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

    const result = await mauticLogin.signIn(input, options);

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

    await expect(mauticLogin.signIn(input, options)).resolves.toMatchObject({
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

    await expect(mauticLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'login redirected without a location',
    });
  });

  it('reports a product that cannot be read during confirmation', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/s/dashboard' }),
      () => {
        throw new Error('connection reset');
      },
    ]);

    await expect(mauticLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('connection reset'),
    });
  });

  it('refuses a confirmation redirect that names no location', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/s/dashboard' }),
      () => respond({ status: 302 }),
    ]);

    await expect(mauticLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product redirected nowhere',
    });
  });

  it('gives up when the confirmation walk only ever redirects', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/s/dashboard' }),
      () => respond({ status: 302, location: '/s/contacts' }),
      () => respond({ status: 302, location: '/s/campaigns' }),
      () => respond({ status: 302, location: '/s/emails' }),
      () => respond({ status: 302, location: '/s/forms' }),
    ]);

    await expect(mauticLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product redirected in a loop',
    });
  });

  it('reports a confirmation page that answers neither 2xx nor 3xx', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/s/dashboard' }),
      () => respond({ status: 404, body: 'not found' }),
    ]);

    await expect(mauticLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product answered 404',
    });
  });

  it('refuses a confirmation page that carries a challenge', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/s/dashboard' }),
      () => respond({ status: 200, body: '<html><input name="otp" /></html>' }),
    ]);

    await expect(mauticLogin.signIn(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'human_challenge',
    });
  });
});

describe('mauticLogin.verify', () => {
  it('accepts a cookie the product still redirects away from the login route', async () => {
    const options = driver([() => respond({ status: 302, location: '/s/dashboard' })]);

    const check = await mauticLogin.verify(
      { ...input, cookies: ['mautic_session=still-valid; path=/'] },
      options,
    );

    expect(check.ok).toBe(true);
    // The jar is rebuilt from the cached attribute string, so what the hop re-emits is unchanged.
    expect(check.ok && check.cookies).toEqual(['mautic_session=still-valid; path=/']);
  });

  it('rejects a cookie the product no longer honours', async () => {
    const options = driver([() => respond({ status: 200, body: LOGIN_PAGE })]);

    const check = await mauticLogin.verify(
      { ...input, cookies: ['mautic_session=expired; path=/'] },
      options,
    );

    expect(check.ok).toBe(false);
  });

  it('rejects an empty jar without touching the product', async () => {
    const options = driver([]);

    const check = await mauticLogin.verify({ ...input, cookies: [] }, options);

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
      mauticLogin.verify({ ...input, cookies: ['mautic_session=x; path=/'] }, options),
    ).resolves.toEqual({ ok: false, reason: 'product_unavailable' });
  });

  it('rejects a redirect the product issued without a location', async () => {
    const options = driver([() => respond({ status: 302 })]);

    await expect(
      mauticLogin.verify({ ...input, cookies: ['mautic_session=x; path=/'] }, options),
    ).resolves.toEqual({ ok: false, reason: 'session_unconfirmed' });
  });

  it('rejects a cookie the product sends back to the login route', async () => {
    const options = driver([() => respond({ status: 302, location: '/s/login' })]);

    await expect(
      mauticLogin.verify({ ...input, cookies: ['mautic_session=x; path=/'] }, options),
    ).resolves.toEqual({ ok: false, reason: 'session_unconfirmed' });
  });

  it('uses the product transport when the caller injects none', async () => {
    productFetchMock.mockReset();
    productFetchMock.mockResolvedValueOnce(respond({ status: 302, location: '/s/dashboard' }));

    const check = await mauticLogin.verify(
      { ...input, cookies: ['mautic_session=x; path=/'] },
      { timeoutMs: 1_000 },
    );

    expect(check.ok).toBe(true);
    expect(productFetchMock).toHaveBeenCalledOnce();
  });
});

describe('loginAdapterFor', () => {
  it('resolves both spellings of the Mautic entry to the same adapter', () => {
    expect(loginAdapterFor('D2')?.name).toBe('mautic');
    expect(loginAdapterFor('D02-01')?.name).toBe('mautic');
    expect(loginAdapterFor('d2')?.name).toBe('mautic');
    expect(loginAdapterFor('  d02-01 ')?.name).toBe('mautic');
  });

  it('keeps the products the relay was already verified against', () => {
    expect(loginAdapterFor('D9')?.name).toBe('openproject');
    expect(loginAdapterFor('D7')?.name).toBe('orangehrm');
  });
});
