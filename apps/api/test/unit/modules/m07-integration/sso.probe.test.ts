import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { SsoProbe } from '../../../../src/modules/m07-integration/sso.probe';

/**
 * 4D.5 — evidence that the product's OIDC client works.
 *
 * The check this replaced asked Keycloak for an admin token and called it "SSO test login": it
 * passed while the product's redirect URI did not exist. These tests drive both stages over a fake
 * transport and assert that every way the feature can fail produces its own sentence — and that no
 * sentence contains a token, a code or a credential.
 */
const ADMIN = 'http://keycloak:8080';
/** The host the browser sees; a server-side client reaches the same realm at `ADMIN`. */
const PUBLIC = 'http://localhost:8082';
const LOGIN_PATH = '/realms/seamnex/login-actions/authenticate?session_code=abc';
const FORM_ACTION = `${PUBLIC}${LOGIN_PATH}`;

const INPUT = {
  clientId: 'seamnex-instance-crm',
  redirectUri: 'http://crm.seamnex.local:8020/oauth-callback.php',
  clientSecret: 'client-secret-value',
};

const dirs: string[] = [];

function setup(overrides: Record<string, unknown> = {}) {
  const config = {
    SEAMNEX_SAMPLE_TIMEOUT_MS: 1_000,
    SEAMNEX_KEYCLOAK_ADMIN_URL: ADMIN,
    SEAMNEX_KEYCLOAK_REALM: 'seamnex',
    SEAMNEX_SSO_PROBE_USERNAME: '',
    SEAMNEX_SSO_PROBE_PASSWORD_FILE: '',
    ...overrides,
  } as unknown as AppConfig;
  return new SsoProbe(config);
}

function withPassword(content = 'probe-password'): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-sso-'));
  dirs.push(dir);
  const path = join(dir, 'password');
  writeFileSync(path, content, 'utf8');
  return { SEAMNEX_SSO_PROBE_USERNAME: 'probe-user', SEAMNEX_SSO_PROBE_PASSWORD_FILE: path };
}

function page(body: string, status = 200): Response {
  return new Response(body, { status });
}

function redirect(location: string | null, cookies: string[] = []): Response {
  const headers = new Headers();
  if (location !== null) headers.set('location', location);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function formHtml(form: string | null): string {
  return form === null
    ? '<html><body><p id="kc-feedback-text">Invalid parameter: redirect_uri</p></body></html>'
    : `<html><body><form id="kc-form-login" action="${form}" method="post"></form></body></html>`;
}

function idToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

function tokenResponse(claims: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ id_token: idToken(claims) }), { status: 200 });
}

/** A transport that answers the four legs of a full probe by shape, not by call order. */
function flow(
  options: {
    loginPost?: (state: string) => Response | Promise<Response>;
    token?: () => Response | Promise<Response>;
    form?: string | null;
  } = {},
): ReturnType<typeof vi.fn> {
  // Captured from the authorization request so the callback can echo the state the probe minted.
  let state = '';
  const mock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/protocol/openid-connect/auth')) {
      state = url.searchParams.get('state') ?? '';
      // Keycloak publishes an absolute `Location` on its fixed public hostname.
      return redirect(`${PUBLIC}${LOGIN_PATH}`, [
        'AUTH_SESSION_ID=session-1; Path=/realms/seamnex; HttpOnly',
        'malformed-cookie',
      ]);
    }
    if (url.pathname.endsWith('/protocol/openid-connect/token')) {
      return options.token === undefined
        ? tokenResponse({ aud: INPUT.clientId, sub: 'probe-1', exp: future() })
        : options.token();
    }
    if (init.method === 'POST') {
      return options.loginPost === undefined
        ? redirect(`${INPUT.redirectUri}?state=${state}&code=authorization-code`)
        : options.loginPost(state);
    }
    return page(formHtml(options.form === undefined ? FORM_ACTION : options.form));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function future(): number {
  return Math.floor(Date.now() / 1_000) + 300;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('stage 1: the authorization request', () => {
  it('passes when the login form is served, and says stage 2 did not run', async () => {
    flow();

    await expect(setup().verify(INPUT)).resolves.toEqual({
      ok: true,
      detail:
        'stage 1 passed: the client and redirect URI are registered. Stage 2 (code exchange) was ' +
        'not run — set SEAMNEX_SSO_PROBE_USERNAME and SEAMNEX_SSO_PROBE_PASSWORD_FILE to exercise it.',
    });
  });

  it('asks for a code with the registered client, URI and a random state', async () => {
    const fetch = flow();

    await setup().verify(INPUT);

    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.origin).toBe(ADMIN);
    expect(url.pathname).toBe('/realms/seamnex/protocol/openid-connect/auth');
    expect(url.searchParams.get('client_id')).toBe(INPUT.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(INPUT.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((fetch.mock.calls[0]?.[1] as RequestInit).redirect).toBe('manual');
  });

  it('reports an unreachable provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))),
    );

    await expect(setup().verify(INPUT)).resolves.toEqual({
      ok: false,
      detail:
        'stage 1 (authorization request) could not reach the identity provider: connect ECONNREFUSED',
    });
  });

  it('quotes a non-Error transport failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject('socket closed')),
    );

    await expect(setup().verify(INPUT)).resolves.toMatchObject({
      detail: expect.stringContaining('socket closed'),
    });
  });

  it('reports the status when the client or the redirect URI is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(new Response('', { status: 400 }))),
    );

    await expect(setup().verify(INPUT)).resolves.toEqual({
      ok: false,
      detail:
        'stage 1 (authorization request) answered 400; the client or the redirect URI is refused',
    });
  });

  it('reports a redirect with no location', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(redirect(null))),
    );

    await expect(setup().verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 1 (authorization request) redirected without a location',
    });
  });

  it('reports a login form it could not fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(redirect(`${PUBLIC}${LOGIN_PATH}`))
        .mockRejectedValueOnce(new Error('timed out')),
    );

    await expect(setup().verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 1 (login form) could not be fetched: timed out',
    });
  });

  it('reads the error page when the provider refuses before rendering a login', async () => {
    // `invalid_redirect_uri` and an unknown client both arrive this way, with HTTP 200.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(page(formHtml(null)))),
    );

    await expect(setup().verify(INPUT)).resolves.toEqual({
      ok: false,
      detail:
        'stage 1 (authorization request) returned an error page: Invalid parameter: redirect_uri',
    });
  });

  it('summarises an error page that carries no message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(page('<html><body><script>var x = 1;</script></body></html>')),
      ),
    );

    await expect(setup().verify(INPUT)).resolves.toMatchObject({
      detail: expect.stringContaining('no message on the page'),
    });
  });

  it('re-points a form the provider published on its public host', async () => {
    const fetch = flow();

    await setup().verify(INPUT);

    // A server-side client reaches the container address, not the browser's hostname.
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      `${ADMIN}/realms/seamnex/login-actions/authenticate?session_code=abc`,
    );
    expect((fetch.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      cookie: 'AUTH_SESSION_ID=session-1',
    });
  });
});

describe('responses whose body cannot be read', () => {
  function unreadable(status = 200): Response {
    const response = new Response(null, { status });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('stream broke'));
    return response;
  }

  it('treats an unreadable login page as one with no form', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(redirect(`${PUBLIC}${LOGIN_PATH}`))
        .mockResolvedValueOnce(unreadable()),
    );

    await expect(setup().verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 1 (authorization request) returned an error page: no message on the page',
    });
  });

  it('treats an unreadable authorization answer as one with no form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(unreadable())),
    );

    await expect(setup().verify(INPUT)).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('no message on the page'),
    });
  });

  it('treats an unreadable refusal as a refusal with no message', async () => {
    flow({ loginPost: () => unreadable() });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 2 (login) was refused: no message on the page',
    });
  });
});

describe('stage 2: the code exchange', () => {
  it('proves the secret and the endpoints, and names the identity', async () => {
    flow();

    const result = await setup(withPassword()).verify(INPUT);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('stages 1–2 passed');
    expect(result.detail).toContain('as probe-1');
    expect(result.detail).not.toContain(INPUT.clientSecret);
  });

  it('posts the probe identity to the form and exchanges the returned code', async () => {
    const fetch = flow();

    await setup(withPassword()).verify(INPUT);

    const post = fetch.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    const body = new URLSearchParams(String((post?.[1] as RequestInit).body));
    expect(body.get('username')).toBe('probe-user');
    expect(body.get('password')).toBe('probe-password');

    const tokenCall = fetch.mock.calls.find((call) => String(call[0]).endsWith('/token'));
    const tokenBody = new URLSearchParams(String((tokenCall?.[1] as RequestInit).body));
    expect(tokenBody.get('grant_type')).toBe('authorization_code');
    expect(tokenBody.get('client_secret')).toBe(INPUT.clientSecret);
    expect(tokenBody.get('redirect_uri')).toBe(INPUT.redirectUri);
  });

  it('reports the claims the product requires when they are present', async () => {
    flow({
      token: () =>
        tokenResponse({
          aud: INPUT.clientId,
          preferred_username: 'probe-user',
          groups: ['/seamnex-users'],
          exp: future(),
        }),
    });

    const result = await setup(withPassword()).verify({ ...INPUT, expectedClaims: ['groups'] });

    expect(result.detail).toContain('carrying groups');
  });

  it('refuses a login the provider rejected', async () => {
    flow({
      loginPost: () =>
        page(
          '<html><body><p id="kc-feedback-text">Invalid username or password.</p></body></html>',
        ),
    });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 2 (login) was refused: Invalid username or password.',
    });
  });

  it('reports a login submission it could not send', async () => {
    flow({
      loginPost: () => Promise.reject(new Error('connection reset')) as never,
    });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 2 (login) could not be submitted: connection reset',
    });
  });

  it('reports a login redirect with no location', async () => {
    flow({ loginPost: () => redirect(null) });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 2 (login) redirected without a location',
    });
  });

  it('names the provider error when the callback carries no code', async () => {
    flow({
      loginPost: () =>
        redirect('http://crm.seamnex.local:8020/oauth-callback.php?error=access_denied'),
    });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toMatchObject({
      ok: false,
      detail: 'stage 2 (login) was refused by the identity provider: access_denied',
    });
  });

  it('says so when the callback carries nothing at all', async () => {
    flow({ loginPost: () => redirect(INPUT.redirectUri) });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toMatchObject({
      detail: 'stage 2 (login) was refused by the identity provider: no code parameter',
    });
  });

  it('refuses a code minted for a different state', async () => {
    flow({ loginPost: () => redirect(`${INPUT.redirectUri}?state=someone-else&code=abc`) });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('different state'),
    });
  });

  it('reports a token endpoint that refused the exchange', async () => {
    flow({ token: () => new Response('', { status: 401 }) });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail:
        'stage 2 (token exchange) answered 401; the client secret or the redirect URI is wrong',
    });
  });

  it('reports a token endpoint it could not reach', async () => {
    flow({
      token: () => Promise.reject(new Error('token endpoint down')) as never,
    });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 2 (token exchange) failed: token endpoint down',
    });
  });

  it('refuses a token response with no id_token', async () => {
    flow({ token: () => new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }) });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 2 (token exchange) returned no id_token',
    });
  });

  it('refuses a token response that is not JSON', async () => {
    flow({ token: () => new Response('<html>gateway</html>', { status: 200 }) });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 2 (token exchange) returned no id_token',
    });
  });

  it('refuses an id_token it cannot decode', async () => {
    flow({
      token: () => new Response(JSON.stringify({ id_token: 'not-a-jwt' }), { status: 200 }),
    });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 2 (token exchange) returned an id_token that could not be decoded',
    });
  });

  it('refuses an id_token minted for another client', async () => {
    flow({ token: () => tokenResponse({ aud: 'another-client', exp: future() }) });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: `stage 2 (token exchange): the id_token audience does not include ${INPUT.clientId}`,
    });
  });

  it('accepts an audience array that names the client among others', async () => {
    flow({ token: () => tokenResponse({ aud: ['other', INPUT.clientId], exp: future() }) });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toMatchObject({ ok: true });
  });

  it('refuses an id_token that has already expired', async () => {
    flow({ token: () => tokenResponse({ aud: INPUT.clientId, exp: 1_700_000_000 }) });

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 2 (token exchange): the id_token is already expired (clock skew?)',
    });
  });

  it('refuses a token that omits a claim the product requires', async () => {
    flow({ token: () => tokenResponse({ aud: INPUT.clientId, sub: 'probe-1', exp: future() }) });

    await expect(
      setup(withPassword()).verify({ ...INPUT, expectedClaims: ['groups', 'email'] }),
    ).resolves.toEqual({
      ok: false,
      detail:
        'stage 2 (token exchange): the id_token carries no groups, email claim; the client needs the scope that mints it',
    });
  });
});

describe('the probe identity', () => {
  it('skips stage 2 when only half of it is configured', async () => {
    flow();

    await expect(
      setup({ SEAMNEX_SSO_PROBE_USERNAME: 'probe-user' }).verify(INPUT),
    ).resolves.toMatchObject({
      ok: true,
      detail: expect.stringContaining('Stage 2 (code exchange) was not run'),
    });
  });

  it('skips stage 2 when the password file is unreadable, and warns', async () => {
    flow();

    await expect(
      setup({
        SEAMNEX_SSO_PROBE_USERNAME: 'probe-user',
        SEAMNEX_SSO_PROBE_PASSWORD_FILE: './temp/absent-probe-secret',
      }).verify(INPUT),
    ).resolves.toMatchObject({ ok: true, detail: expect.stringContaining('Stage 2') });
  });

  it('skips stage 2 when the password file is empty', async () => {
    flow();

    await expect(setup(withPassword('  ')).verify(INPUT)).resolves.toMatchObject({ ok: true });
  });
});
