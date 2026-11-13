import { describe, expect, it, vi } from 'vitest';
import { mintAdminToken } from '../../../../src/modules/m24-sign-in-relay/openproject-admin-token';

/**
 * ADR-BE-22 §Credentials (amendment) — every way the bootstrap can end without a token.
 *
 * `openproject-admin-token.test.ts` pins the two shapes that must succeed and the verdicts a person
 * can act on. This file is the other half: the branches nobody wants to learn about from a
 * redeployed stack — an unreachable product, a changed form, a session the product did not keep, a
 * redirect loop. Each of them must come back as a reason with no credential and no product HTML in
 * it, because the detail reaches the audit chain.
 *
 * The default transport is stubbed so one test can prove `mintAdminToken` falls back to
 * `productFetch` rather than `globalThis.fetch`; every other test injects its own replay.
 */
const { productFetchMock } = vi.hoisted(() => ({ productFetchMock: vi.fn() }));

vi.mock('../../../../src/modules/m24-sign-in-relay/product-http', () => ({
  productFetch: productFetchMock,
}));

const ORIGIN = 'http://openproject:80';
const PUBLIC_ORIGIN = 'http://openproject.localhost:8020';

const LOGIN_FORM = `<form class="user-login--form">
  <input type="hidden" name="authenticity_token" value="login-csrf" />
</form>`;

const TOKENS_PAGE = `<html><head><meta name="csrf-token" content="page-csrf"></head>
  <body><div id="api-tokens"></div></body></html>`;

const CREATED_DIALOG = `<template><input value="opapi-0123456789abcdef" readonly="readonly"
  type="text" name="openproject_api_access_token" /></template>`;

const INPUT = {
  origin: ORIGIN,
  publicOrigin: PUBLIC_ORIGIN,
  username: 'admin',
  password: 'seed-pass',
};

type Reply = { status: number; body?: string; location?: string };

function replay(routes: Record<string, Reply[]>) {
  const calls: { method: string; path: string; body: string | undefined }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    const reply = routes[`${method} ${url.pathname}`]?.shift();
    if (reply === undefined) throw new Error(`unexpected request ${method} ${url.pathname}`);
    return new Response(reply.body ?? null, {
      status: reply.status,
      headers: reply.location === undefined ? {} : { location: reply.location },
    });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

/** The happy path's last three hops, so a test only has to state what differs before them. */
function signedIn(extra: Record<string, Reply[]> = {}) {
  return replay({
    'GET /login': [{ status: 200, body: LOGIN_FORM }],
    'POST /login': [
      { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
    ],
    'GET /two_factor_authentication/request': [{ status: 302, location: `${PUBLIC_ORIGIN}/` }],
    'GET /': [{ status: 200, body: '<html>home</html>' }],
    'GET /my/access_tokens': [{ status: 200, body: TOKENS_PAGE }],
    'POST /my/access_tokens/generate_api_key': [{ status: 200, body: CREATED_DIALOG }],
    ...extra,
  });
}

const FORCED_CHANGE_FORM = (hidden: string) => `<div data-controller="password-requirements">
<form data-turbo="false" action="/account/change_password" method="post">
  <input type="hidden" name="authenticity_token" value="form-csrf" />
  ${hidden}
</form>
</div>`;

describe('the login page and the sign-in', () => {
  it('uses the shared product transport when no fetch is injected', async () => {
    productFetchMock.mockReset();
    productFetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const result = await mintAdminToken(INPUT, { timeoutMs: 1_000 });

    expect(productFetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'the login page could not be fetched: connect ECONNREFUSED',
    });
  });

  it('quotes a transport failure that is not an Error as the value it was', async () => {
    const fetch = (async () => {
      throw 'the socket closed';
    }) as unknown as typeof globalThis.fetch;

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'the login page could not be fetched: the socket closed',
    });
  });

  it('answers a login page that is not 200 with its status', async () => {
    const { fetch } = replay({ 'GET /login': [{ status: 503, body: 'starting' }] });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'the login page answered 503',
    });
  });

  it('does not try to solve a human challenge', async () => {
    const { fetch } = replay({
      'GET /login': [
        { status: 200, body: '<form class="user-login--form"></form><input name="otp" />' },
      ],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'human_challenge',
    });
  });

  it('calls a login form without its CSRF token a changed form', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: '<form class="user-login--form"></form>' }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'form_changed',
    });
  });

  it('reports a sign-in the transport could not submit', async () => {
    const { fetch } = replay({ 'GET /login': [{ status: 200, body: LOGIN_FORM }] });

    // No `POST /login` route: the replay refuses the request, which the driver must catch.
    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('the login form could not be submitted'),
    });
  });

  it('reads a CSRF rejection as a changed form, not as a refused password', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 422, body: '<p>invalid authenticity token</p>' }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'form_changed',
      detail: 'the login form rejected its CSRF token',
    });
  });

  it('reads an unrecognised 422 page as a changed form', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 422, body: '<h1>Something else entirely</h1>' }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'form_changed',
      detail: 'the product answered the sign-in with an unknown page',
    });
  });

  it('reports a 5xx sign-in as the product being unavailable', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 502, body: 'bad gateway' }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: 'sign-in answered 502',
    });
  });
});

describe('walking the redirect after a sign-in', () => {
  it('reports a sign-in that ended on a client error', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 401, body: 'unauthorised' }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'sign-in ended on 401',
    });
  });

  it('reports a redirect that named no destination', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 302 }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'sign-in redirected nowhere',
    });
  });

  it('reads a redirect to the sign-in form with a trailing slash as a refusal', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 302, location: `${PUBLIC_ORIGIN}/login/` }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product did not accept the credential it was given',
    });
  });

  it('reports a hop that could not be read', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
    });

    // No route for the router hop: the follow-up fails inside `settle`, not at the sign-in.
    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('the product could not be read'),
    });
  });

  it('stops on a rendered challenge instead of treating it as the application', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [
        { status: 200, body: '<form><input name="totp" /></form>' },
      ],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'human_challenge',
      detail: 'the product asked for a second factor',
    });
  });

  it('stops on a password-change screen rendered behind the router', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [
        { status: 200, body: '<div data-controller="password-requirements"></div>' },
      ],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'force_password_change',
      detail: 'the product requires a password change',
    });
  });

  it('reports a redirect chain that never lands', async () => {
    const loop: Reply[] = [{ status: 302, location: `${PUBLIC_ORIGIN}/hop` }];
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 302, location: `${PUBLIC_ORIGIN}/hop` }],
      // Four follows, each answering the same redirect: the hop budget is what stops it.
      'GET /hop': [...loop, ...loop, ...loop, ...loop],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
    });
  });
});

describe('the token page', () => {
  it('reports a token page that could not be read', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [{ status: 302, location: `${PUBLIC_ORIGIN}/` }],
      'GET /': [{ status: 200, body: '<html>home</html>' }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('the token page could not be read'),
    });
  });

  it('reports a token page answered with a status as an unconfirmed session', async () => {
    const { fetch } = signedIn({
      'GET /my/access_tokens': [{ status: 403, body: 'forbidden' }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the token page answered 403',
    });
  });

  it('reports a session the product did not keep', async () => {
    const { fetch } = signedIn({
      'GET /my/access_tokens': [{ status: 200, body: LOGIN_FORM }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'session_unconfirmed',
      detail: 'the product did not keep the session the sign-in produced',
    });
  });

  it('reports a token page with no CSRF token at all', async () => {
    const { fetch } = signedIn({
      'GET /my/access_tokens': [{ status: 200, body: '<html><body>no token</body></html>' }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'form_changed',
      detail: 'the token page carries no CSRF token',
    });
  });

  it('falls back to the hidden-token form when the page carries no meta tag', async () => {
    const { fetch, calls } = signedIn({
      'GET /my/access_tokens': [
        {
          status: 200,
          body: '<form><input type="hidden" name="authenticity_token" value="hidden-csrf" /></form>',
        },
      ],
    });

    await mintAdminToken(INPUT, { timeoutMs: 1_000, fetch });

    const generate = calls.find((call) => call.path.endsWith('generate_api_key'));
    expect(generate).toBeDefined();
  });

  it('reports a token request the transport could not make', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [{ status: 302, location: `${PUBLIC_ORIGIN}/` }],
      'GET /': [{ status: 200, body: '<html>home</html>' }],
      'GET /my/access_tokens': [{ status: 200, body: TOKENS_PAGE }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('the token could not be requested'),
    });
  });

  it('reports a generated page that carries no token', async () => {
    const { fetch } = signedIn({
      'POST /my/access_tokens/generate_api_key': [
        { status: 200, body: '<turbo-stream action="replace"></turbo-stream>' },
      ],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'form_changed',
      detail: 'the token page changed shape: no token in the response',
    });
  });
});

describe('the forced password change', () => {
  it('reports a change the transport could not submit', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 422, body: FORCED_CHANGE_FORM('') }],
      // No route for the change form: the POST is refused inside the driver.
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'product_unavailable',
      detail: expect.stringContaining('the forced password change could not be submitted'),
    });
  });

  it('reports a change answered with a page it cannot read', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 422, body: FORCED_CHANGE_FORM('') }],
      'POST /account/change_password': [{ status: 500, body: '<html>oops</html>' }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'form_changed',
      detail: 'the forced password change answered 500',
    });
  });

  it('signs in as the caller when the form hides no login and reads a reversed attribute order', async () => {
    const { fetch, calls } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        {
          status: 422,
          body: FORCED_CHANGE_FORM(
            '<input value="seed-admin" type="hidden" name="password_change_user" />',
          ),
        },
      ],
      'POST /account/change_password': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [{ status: 302, location: `${PUBLIC_ORIGIN}/` }],
      'GET /': [{ status: 200, body: '<html>home</html>' }],
      'GET /my/access_tokens': [{ status: 200, body: TOKENS_PAGE }],
      'POST /my/access_tokens/generate_api_key': [{ status: 200, body: CREATED_DIALOG }],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toEqual({
      ok: true,
      token: 'opapi-0123456789abcdef',
      completedPasswordChange: true,
    });

    const change = calls.find((call) => call.path === '/account/change_password');
    expect(change?.body).toContain('password_change_user=seed-admin');
  });

  it('does not claim the change was cleared when the token still could not be minted', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        {
          status: 422,
          body: FORCED_CHANGE_FORM(
            '<input type="hidden" name="password_change_user" value="admin" />',
          ),
        },
      ],
      'POST /account/change_password': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [{ status: 302, location: `${PUBLIC_ORIGIN}/` }],
      'GET /': [{ status: 200, body: '<html>home</html>' }],
      'GET /my/access_tokens': [{ status: 500, body: 'oops' }],
    });

    const result = await mintAdminToken(INPUT, { timeoutMs: 1_000, fetch });

    expect(result).toMatchObject({ ok: false, reason: 'session_unconfirmed' });
    expect(result).not.toHaveProperty('completedPasswordChange');
  });

  it('treats a change form it cannot parse as a screen it must not fill in', async () => {
    // Markers present, a change form started but never closed: nothing may be submitted blindly.
    const { fetch, calls } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        {
          status: 422,
          body: '<div data-controller="password-requirements"><form action="/account/change_password">',
        },
      ],
    });

    await expect(mintAdminToken(INPUT, { timeoutMs: 1_000, fetch })).resolves.toMatchObject({
      ok: false,
      reason: 'force_password_change',
    });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});
