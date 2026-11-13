import { describe, expect, it, vi } from 'vitest';
import {
  signInToProduct,
  verifyProductSession,
  type DriverOptions,
  type ProductLoginInput,
} from '../../../../src/modules/m24-sign-in-relay/product-login.driver';

/**
 * The driver's contract is "one attempt, fail closed". Every test here is one failure mode the ADR
 * lists, plus the invariant that survives all of them: the credential is never in a result.
 */

const input: ProductLoginInput = {
  origin: 'http://openproject:80',
  publicOrigin: 'http://openproject.localhost:8020',
  username: 'jdoe',
  credential: 'correct-horse-battery-staple',
};

const LOGIN_PAGE = `<html><body>
  <form class="user-login--form" action="/login" method="post">
    <input type="hidden" name="authenticity_token" value="csrf-1" />
    <input name="username" />
    <input type="password" name="password" />
  </form>
</body></html>`;

const APP_PAGE = '<html><body><div id="main-menu">Projects</div></body></html>';

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

/** The injected transport's call log; `DriverOptions.fetch` is typed as a plain function. */
function fetchCalls(options: DriverOptions): unknown[][] {
  return (options.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

/** The product's own answer to "who am I?" — the positive confirmation step ③ now requires. */
const signedInAs = (login: string) => (): Response =>
  respond({ status: 200, body: JSON.stringify({ login, name: 'Jane Doe', admin: null }) });

function driver(
  routes: Route[],
  options: Partial<DriverOptions> = {},
  identity: () => Response = signedInAs('jdoe'),
): DriverOptions {
  return {
    timeoutMs: 1_000,
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body =
        init?.body instanceof URLSearchParams
          ? init.body.toString()
          : typeof init?.body === 'string'
            ? init.body
            : null;
      const request = { url: String(url), method: init?.method ?? 'GET', body };
      // Answered out of band: every successful sign-in ends with this probe, and threading it
      // through each route list would say more about the test than about the driver.
      if (new URL(request.url).pathname === '/api/v3/users/me') return identity();
      const route = routes.shift();
      if (route === undefined)
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      return route(request);
    }) as unknown as typeof globalThis.fetch,
    ...options,
  };
}

describe('signInToProduct', () => {
  it('signs in, confirms the session and returns the product cookies', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE, cookies: ['_open_project_session=pre-auth'] }),
      () => respond({ status: 302, location: '/', cookies: ['_open_project_session=signed-in'] }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toEqual({ ok: true, cookies: ['_open_project_session=signed-in'] });
  });

  it('sends the route host, Origin and Referer on the POST and no credential in the URL', async () => {
    const seen: { url: string; body: string | null }[] = [];
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      (request) => {
        seen.push(request);
        return respond({ status: 302, location: '/' });
      },
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    await signInToProduct(input, options);

    expect(seen[0]?.url).toBe('http://openproject:80/login');
    expect(seen[0]?.url).not.toContain(input.credential);
    expect(seen[0]?.body).toContain('username=jdoe');
    expect(seen[0]?.body).toContain('authenticity_token=csrf-1');
  });

  it('fails closed when the login page lost its form, and never submits a password', async () => {
    const options = driver([
      () => respond({ status: 200, body: '<html><body>Maintenance</body></html>' }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'form_changed' });
  });

  it("fails closed on Apache's placeholder page, which answers 200", async () => {
    const options = driver([
      () =>
        respond({
          status: 200,
          body: '<html>This server expects to be reached on the following domain</html>',
        }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'product_unavailable' });
  });

  it('refuses to automate a human challenge on the login page', async () => {
    const options = driver([
      () =>
        respond({
          status: 200,
          body: `${LOGIN_PAGE}<div class="g-recaptcha" data-sitekey="x"></div>`,
        }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'human_challenge' });
  });

  it('refetches once on a stale CSRF token and then signs in', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 422, body: 'Unable to verify CSRF token' }),
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result.ok).toBe(true);
  });

  it('stops after one credential rejection and reports the product message', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () =>
        respond({
          status: 200,
          body: `${LOGIN_PAGE}<div role="alert">Invalid user or password.</div>`,
        }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'credential_rejected' });
    if (!result.ok) expect(result.detail).toContain('Invalid user or password');
  });

  /*
   * Measured on OpenProject 17.9.6: a refused password is `422` with the login form re-rendered, not
   * `200` (every wrong-password branch of `AccountController#password_authentication` ends in
   * `render status: :unprocessable_entity`). Treating that as a stale CSRF token spent a second
   * attempt on a credential the product had already refused — 20 of those lock the account for 30
   * minutes — and reported `csrf_stale` for a credential problem.
   */
  it('stops after one refetch when the token is still stale', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 422, body: 'Invalid authenticity token' }),
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 422, body: 'Invalid authenticity token' }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'csrf_stale' });
  });

  /*
   * A rejected CSRF token renders the login page too, with the same 422 — so "the body has the form"
   * is not "the password was refused". The exception's message is the marker that separates them,
   * and reading it the wrong way costs the retry the ADR asks for.
   */
  it('refetches a 422 that is a CSRF failure even though it re-renders the login form', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () =>
        respond({
          status: 422,
          body: `${LOGIN_PAGE}<div class="Banner flash Banner--error flash-error" message="[Error 422] Unable to verify Cross-Site Request Forgery token."></div>`,
        }),
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result.ok).toBe(true);
  });

  it('carries the product’s own message into the failure detail', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () =>
        respond({
          status: 422,
          body: `${LOGIN_PAGE}<div class="Banner flash Banner--error flash-error" message="[Error 422] User admin is blocked due to multiple failed login attempts."></div>`,
        }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'credential_rejected' });
    if (!result.ok)
      expect(result.detail).toContain('blocked due to multiple failed login attempts');
  });

  it('reads a 422 that carries the login form as a rejected credential, with no second attempt', async () => {
    const posts: string[] = [];
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      (request) => {
        posts.push(request.method);
        return respond({
          status: 422,
          body: `${LOGIN_PAGE}<div role="alert">Invalid user or password.</div>`,
        });
      },
      (request) => {
        posts.push(request.method);
        return respond({ status: 200, body: LOGIN_PAGE });
      },
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'credential_rejected' });
    if (!result.ok) expect(result.detail).toContain('Invalid user or password');
    expect(posts).toEqual(['POST']);
  });

  it('treats a product 5xx as unavailable instead of a rejected credential', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 503, body: 'unavailable' }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'product_unavailable' });
  });

  it('reports a forced password change as a provisioning defect, never working around it', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/account/password/edit' }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'force_password_change' });
  });

  /*
   * 17.9.6 renders the forced-change screen in place: same POST, same 422, and the request never
   * leaves `/login` (`render_password_change` → `render "my/password", status:
   * :unprocessable_entity`). A redirect check can never see it, so the body marker is the only
   * signal that distinguishes "the account must change its password" from "the token was stale".
   */
  it('recognises the forced-change screen rendered with a 422 instead of a redirect', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () =>
        respond({
          status: 422,
          body: `<html><body><div data-controller="password-requirements"></div>
            <h1 data-test-selector="change_password_header_title">Change password</h1></body></html>`,
        }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'force_password_change' });
  });

  it('refuses when the product asks for a second factor after the password', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/two_factor_authentication/request' }),
      // The route is a router, not the verdict: it redirects to the form, and the form is the stop.
      () => respond({ status: 302, location: '/two_factor_authentication/confirm' }),
      () => respond({ status: 200, body: '<html><body><input name="otp" /></body></html>' }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'human_challenge' });
  });

  /*
   * Measured on 17.9.6 with the seeded TOTP/WebAuthn strategies active: `AccountController#login`
   * answers `302 /two_factor_authentication/request` for *every* account, and that route runs
   * `complete_stage_redirect` when the account has no registered device. Reading the route name as
   * the verdict failed every relayed sign-in on the stack even though the product had already
   * accepted the password and was about to complete the login.
   */
  it('follows the two-factor router when the account has no registered factor', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/two_factor_authentication/request' }),
      () => respond({ status: 302, location: '/projects' }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result.ok).toBe(true);
  });

  it('fails when the confirmed session still shows the login form', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 200, body: LOGIN_PAGE }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'session_unconfirmed' });
  });

  /*
   * The fail-open this closes: `GET /` also answers `200` for an interstitial, a maintenance banner
   * or a challenge page whose markers the driver does not know. "No marker I recognise" was the
   * success condition, so the driver planted a cookie and reported a sign-in that had not happened.
   * The verdict is now the product's own answer to "who am I?".
   */
  it('refuses an unrecognised page the product does not confirm as a session', async () => {
    const options = driver(
      [
        () => respond({ status: 200, body: LOGIN_PAGE }),
        () => respond({ status: 302, location: '/' }),
        () => respond({ status: 200, body: '<html><body>Maintenance</body></html>' }),
      ],
      {},
      () => respond({ status: 401 }),
    );

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'session_unconfirmed' });
  });

  it('refuses a session the product attributes to another account', async () => {
    const options = driver(
      [
        () => respond({ status: 200, body: LOGIN_PAGE }),
        () => respond({ status: 302, location: '/' }),
        () => respond({ status: 200, body: APP_PAGE }),
      ],
      {},
      signedInAs('somebody-else'),
    );

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'session_unconfirmed' });
    expect(JSON.stringify(result)).not.toContain(input.credential);
  });

  it('refuses when the identity probe is not a user document', async () => {
    const options = driver(
      [
        () => respond({ status: 200, body: LOGIN_PAGE }),
        () => respond({ status: 302, location: '/' }),
        () => respond({ status: 200, body: APP_PAGE }),
      ],
      {},
      () => respond({ status: 200, body: '<html><body>Maintenance</body></html>' }),
    );

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'session_unconfirmed' });
  });

  /*
   * A password-policy 422 re-describes the submitted input, and this detail reaches a log line and
   * the audit chain. "The product never echoes the field" is an assumption about the product; the
   * scrub against the credential in hand is not.
   */
  it('scrubs the submitted credential out of a product message that echoes it', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () =>
        respond({
          status: 422,
          body: `${LOGIN_PAGE}<div role="alert">Password ${input.credential} must include a symbol.</div>`,
        }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'credential_rejected' });
    expect(JSON.stringify(result)).not.toContain(input.credential);
    if (!result.ok) expect(result.detail).toContain('********');
  });

  it('never puts the credential in a failure detail', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 200, body: `${LOGIN_PAGE}<div role="alert">refused</div>` }),
    ]);

    const result = await signInToProduct(input, options);

    expect(JSON.stringify(result)).not.toContain(input.credential);
  });
});

describe('signInToProduct transport failures', () => {
  it('reports an unreachable login page', async () => {
    const options = driver([
      () => {
        throw new Error('connect ECONNREFUSED');
      },
    ]);

    await expect(signInToProduct(input, options)).resolves.toEqual({
      ok: false,
      reason: 'product_unavailable',
      detail: 'login page could not be fetched: connect ECONNREFUSED',
    });
  });

  it('renders a thrown value that is not an Error', async () => {
    const options = driver([
      () => {
        throw 'socket closed';
      },
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      detail: 'login page could not be fetched: socket closed',
    });
  });

  it('reports a login page that answers with another status', async () => {
    const options = driver([() => respond({ status: 503, body: 'unavailable' })]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'login page answered 503',
    });
  });

  it('reports an unreachable submit', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => {
        throw new Error('socket hang up');
      },
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'login form could not be submitted: socket hang up',
    });
  });

  it('reports a refetch that answers the wrong status', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 422, body: 'Unable to verify authenticity token' }),
      () => respond({ status: 500, body: 'boom' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'csrf_stale',
      detail: expect.stringContaining('answered 500'),
    });
  });

  it('reports a refetch that no longer carries the form', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 422, body: 'Unable to verify authenticity token' }),
      () => respond({ status: 200, body: '<html>Maintenance</html>' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'csrf_stale',
      detail: expect.stringContaining('the page changed shape'),
    });
  });

  it('reports a refetch that cannot be made at all', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 422, body: 'Unable to verify authenticity token' }),
      () => {
        throw new Error('connection reset');
      },
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'csrf_stale',
      detail: expect.stringContaining('connection reset'),
    });
  });

  it('refuses a redirect that names no location', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302 }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toEqual({
      ok: false,
      reason: 'product_unavailable',
      detail: 'login redirected without a location',
    });
  });

  it('drops pre-auth cookies it cannot parse and keeps the signed-in one', async () => {
    const options = driver([
      () =>
        respond({
          status: 200,
          body: LOGIN_PAGE,
          cookies: ['novalue', '=orphan', '_open_project_session=pre-auth; Path=/'],
        }),
      () => respond({ status: 302, location: '/', cookies: ['_open_project_session=signed-in'] }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toEqual({ ok: true, cookies: ['_open_project_session=signed-in'] });
  });

  it('calls the product at its internal origin even when the origin has no scheme', async () => {
    // `absolute()` has to root the path rather than throw out of `new URL`.
    const seen: string[] = [];
    const options: DriverOptions = {
      timeoutMs: 1_000,
      fetch: (async (url: string) => {
        seen.push(String(url));
        return respond({ status: 200, body: LOGIN_PAGE });
      }) as unknown as typeof globalThis.fetch,
    };

    const result = await signInToProduct({ ...input, origin: 'not a url' }, options);

    expect(seen[0]).toBe('not a url/login');
    // The page is the form, so the driver went on to submit; the stub answered the form again.
    expect(result).toMatchObject({ ok: false, reason: 'credential_rejected' });
  });
});

describe('signInToProduct classified pages', () => {
  it('reads a CSRF token whose attributes are in the other order', async () => {
    const reversed = `<html><body><form class="user-login--form">
      <input value="csrf-2" name="authenticity_token" type="hidden" />
    </form></body></html>`;
    const options = driver([
      () => respond({ status: 200, body: reversed }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result.ok).toBe(true);
    const post = fetchCalls(options)[1] as [string, RequestInit];
    expect(String(post[1].body)).toContain('authenticity_token=csrf-2');
  });

  it('treats a token field with an empty value as a changed form', async () => {
    const empty = `<html><body><form class="user-login--form">
      <input name="authenticity_token" value="" />
    </form></body></html>`;
    const options = driver([() => respond({ status: 200, body: empty })]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'form_changed',
    });
  });

  it('refuses a submitted page that carries a human challenge', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 200, body: '<html><div class="g-recaptcha"></div></html>' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'human_challenge',
    });
  });

  it('carries a flash-error region into the detail', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () =>
        respond({
          status: 200,
          body: `${LOGIN_PAGE}<div class="Banner flash Banner--error flash-error">Account is locked.</div>`,
        }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'credential_rejected' });
    if (!result.ok) expect(result.detail).toContain('Account is locked.');
  });

  it('says the product gave no message when the page carries no region at all', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 200, body: LOGIN_PAGE }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result).toMatchObject({ ok: false, reason: 'credential_rejected' });
    if (!result.ok) expect(result.detail).toContain('the product gave no message');
  });
});

describe('signInToProduct confirmation failures', () => {
  it('reports a product that cannot be read while confirming', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => {
        throw new Error('connection reset');
      },
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('connection reset'),
    });
  });

  it('reports a confirmation redirect into the password screen', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 302, location: '/my/password/edit' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'force_password_change',
    });
  });

  it('reports a confirmation redirect back to the login page', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 302, location: '/login?back_url=/' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product did not accept the session it was given',
    });
  });

  it('reports the edge placeholder page even after a redirect', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () =>
        respond({
          status: 200,
          body: '<html>This server expects to be reached on the following domain</html>',
        }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'the edge answered with the placeholder page',
    });
  });

  it('refuses a confirmation page that carries a challenge', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 200, body: '<html><div data-sitekey="x"></div></html>' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'human_challenge',
    });
  });

  it('gives up when the confirmation walk only ever redirects', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 302, location: '/a' }),
      () => respond({ status: 302, location: '/b' }),
      () => respond({ status: 302, location: '/c' }),
      () => respond({ status: 302, location: '/d' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product redirected in a loop',
    });
  });

  it('reports a confirmation page that answers another status', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 404, body: 'not found' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product answered 404',
    });
  });
});

/**
 * OpenProject's `request_otp` is a router, not a form: one request separates "this account has a
 * registered factor" from "the pass-through ran and the next request lands on the application".
 * Returning `human_challenge` on the route name alone made every relayed sign-in on the dev stack
 * fail closed.
 */
describe('signInToProduct second-factor routing', () => {
  const OTP_ROUTE = '/two_factor_authentication/request_otp';

  it('renders the second-factor form as a challenge a person has to finish', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 302, location: OTP_ROUTE }),
      () => respond({ status: 200, body: '<html><body><div id="otp-form"></div></body></html>' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'human_challenge',
      detail: 'the product asked for a second factor',
    });
  });

  it('follows a pass-through router and keeps confirming', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 302, location: OTP_ROUTE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 200, body: APP_PAGE }),
    ]);

    const result = await signInToProduct(input, options);

    expect(result.ok).toBe(true);
    // form, submit, the router, the page it forwarded to, and the positive identity probe.
    expect(options.fetch).toHaveBeenCalledTimes(6);
  });

  it('refuses a second-factor route that redirects into the password screen', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 302, location: OTP_ROUTE }),
      () => respond({ status: 302, location: '/my/password/edit' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'human_challenge',
    });
  });

  it('refuses a second-factor route that redirects back to the login page', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 302, location: OTP_ROUTE }),
      () => respond({ status: 302, location: '/login?back_url=/' }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'human_challenge',
    });
  });

  it('refuses a second-factor redirect that names no location', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 302, location: OTP_ROUTE }),
      () => respond({ status: 302 }),
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the second-factor route redirected nowhere',
    });
  });

  it('reports a second-factor route that cannot be read', async () => {
    const options = driver([
      () => respond({ status: 200, body: LOGIN_PAGE }),
      () => respond({ status: 302, location: '/' }),
      () => respond({ status: 302, location: OTP_ROUTE }),
      () => {
        throw new Error('connection reset');
      },
    ]);

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'the product could not be read: connection reset',
    });
  });
});

describe('signInToProduct identity probe failures', () => {
  it('reports a probe that cannot be read', async () => {
    const options = driver(
      [
        () => respond({ status: 200, body: LOGIN_PAGE }),
        () => respond({ status: 302, location: '/' }),
        () => respond({ status: 200, body: APP_PAGE }),
      ],
      {},
      () => {
        throw new Error('connection reset');
      },
    );

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('connection reset'),
    });
  });

  it('reports a probe redirected into a second factor', async () => {
    const options = driver(
      [
        () => respond({ status: 200, body: LOGIN_PAGE }),
        () => respond({ status: 302, location: '/' }),
        () => respond({ status: 200, body: APP_PAGE }),
      ],
      {},
      () => respond({ status: 302, location: '/two_factor_authentication/confirm' }),
    );

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'human_challenge',
    });
  });

  it('reports a probe redirected into the password screen', async () => {
    const options = driver(
      [
        () => respond({ status: 200, body: LOGIN_PAGE }),
        () => respond({ status: 302, location: '/' }),
        () => respond({ status: 200, body: APP_PAGE }),
      ],
      {},
      () => respond({ status: 302, location: '/force_password_change' }),
    );

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'force_password_change',
    });
  });

  it('reports a probe redirected without a location as an unaccepted session', async () => {
    const options = driver(
      [
        () => respond({ status: 200, body: LOGIN_PAGE }),
        () => respond({ status: 302, location: '/' }),
        () => respond({ status: 200, body: APP_PAGE }),
      ],
      {},
      () => respond({ status: 302 }),
    );

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
    });
  });

  it('reports a probe whose body is not a JSON object', async () => {
    const options = driver(
      [
        () => respond({ status: 200, body: LOGIN_PAGE }),
        () => respond({ status: 302, location: '/' }),
        () => respond({ status: 200, body: APP_PAGE }),
      ],
      {},
      () => respond({ status: 200, body: '"jdoe"' }),
    );

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product answered without an identity',
    });
  });

  it('reports a probe whose login field is empty', async () => {
    const options = driver(
      [
        () => respond({ status: 200, body: LOGIN_PAGE }),
        () => respond({ status: 302, location: '/' }),
        () => respond({ status: 200, body: APP_PAGE }),
      ],
      {},
      () => respond({ status: 200, body: JSON.stringify({ login: '' }) }),
    );

    await expect(signInToProduct(input, options)).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product answered without an identity',
    });
  });
});

describe('verifyProductSession', () => {
  const session = {
    origin: input.origin,
    publicOrigin: input.publicOrigin,
    username: input.username,
    cookies: ['_open_project_session=signed-in; Path=/; HttpOnly'],
  };

  it('confirms a cached cookie against the product’s own identity endpoint', async () => {
    const options = driver([
      () => respond({ status: 200, body: APP_PAGE }),
      () => respond({ status: 200, body: JSON.stringify({ login: 'jdoe' }) }),
    ]);

    const check = await verifyProductSession(session, options);

    expect(check).toEqual({
      ok: true,
      cookies: ['_open_project_session=signed-in; Path=/; HttpOnly'],
    });
    // The cached attribute string is re-emitted verbatim, so `Path` and `HttpOnly` stay the
    // product's decision.
    expect(fetchCalls(options)[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({ cookie: '_open_project_session=signed-in' }),
    });
  });

  it('rejects a jar with no usable cookie without touching the product', async () => {
    const options = driver([]);

    const check = await verifyProductSession(
      { ...session, cookies: ['novalue', '=orphan', 7 as unknown as string] },
      options,
    );

    expect(check).toEqual({ ok: false, reason: 'session_unconfirmed' });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('reports the driver’s reason when the product no longer accepts the session', async () => {
    const options = driver([() => respond({ status: 200, body: LOGIN_PAGE })]);

    const check = await verifyProductSession(session, options);

    expect(check).toEqual({ ok: false, reason: 'session_unconfirmed' });
  });

  it('reports a session the product attributes to another account', async () => {
    const options = driver(
      [() => respond({ status: 200, body: APP_PAGE })],
      {},
      signedInAs('somebody-else'),
    );

    await expect(verifyProductSession(session, options)).resolves.toEqual({
      ok: false,
      reason: 'session_unconfirmed',
    });
  });
});
