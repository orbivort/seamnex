import { describe, expect, it } from 'vitest';
import { mintAdminToken } from '../../../../src/modules/m24-sign-in-relay/openproject-admin-token';

/**
 * ADR-BE-22 §Credentials (amendment) — deriving the provisioning token through the seeded admin.
 *
 * The shapes below are captured from OpenProject 17.9.6, because every step of this flow was a
 * measurement and every wrong guess in it is silent:
 *
 *   * the sign-in redirects to `/two_factor_authentication/request`, which redirects *again* for an
 *     account with no device — a driver that stops at the first redirect has no session;
 *   * the token page carries its CSRF token in a `<meta>` tag, and the generate call is a
 *     `turbo_stream` POST that answers `422` for a stale one;
 *   * the created token is rendered `value` before `name`, so a forward-only parser finds nothing.
 *
 * A wrong answer here must be a reason, never a guess: the product's lockout counter does not care
 * that the caller was optimistic.
 */

const ORIGIN = 'http://openproject:80';
const PUBLIC_ORIGIN = 'http://openproject.localhost:8020';

const LOGIN_FORM = `<form class="user-login--form">
  <input type="hidden" name="authenticity_token" value="login-csrf" />
</form>`;

/**
 * The `422` an account that owes a password change gets instead of `/login`. Measured shape on
 * 17.9.6: the sign-in form is rendered *first*, so the page's first `authenticity_token` belongs to
 * it — submitting that one on the change form is answered `422 CSRF validation error`, which reads
 * like a refused password.
 */
const PASSWORD_FORM = `<form action="/login" accept-charset="UTF-8" method="post">
  <input type="hidden" name="authenticity_token" value="login-csrf" />
  <input type="text" name="username" />
  <input type="password" name="password" />
</form>
<form data-turbo="false" data-controller="password-requirements" action="/account/change_password"
      accept-charset="UTF-8" method="post">
  <input type="hidden" name="authenticity_token" value="form-csrf" />
  <input value="admin" type="hidden" name="password_change_user" id="password_change_user" />
  <input type="password" name="new_password" />
  <input type="password" name="new_password_confirmation" />
</form>`;

/** The same demand rendered as a screen with nothing this driver may submit. */
const PASSWORD_SCREEN_WITHOUT_FORM = `<div data-controller="password-requirements">
  <h2>change_password_header_title</h2>
</div>`;

const TOKENS_PAGE = `<html><head><meta name="csrf-token" content="page-csrf"></head>
  <body><div id="api-tokens"></div></body></html>`;

const CREATED_DIALOG = `<turbo-stream action="replace" target="dialog">
  <template><input value="opapi-0123456789abcdef" readonly="readonly" type="text"
    name="openproject_api_access_token" id="openproject_api_access_token" /></template>
</turbo-stream>`;

const CREATED_DIALOG_REVERSED = `<template><input name="openproject_api_access_token"
  type="text" value="opapi-fedcba9876543210" /></template>`;

type Reply = { status: number; body?: string; location?: string };

/** Replay by `METHOD path`, in order, so two POSTs to the same path can answer differently. */
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
    const queue = routes[`${method} ${url.pathname}`];
    const reply = queue?.shift();
    if (reply === undefined) throw new Error(`unexpected request ${method} ${url.pathname}`);
    return new Response(reply.body ?? null, {
      status: reply.status,
      headers: reply.location === undefined ? {} : { location: reply.location },
    });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function options(fetch: typeof globalThis.fetch) {
  return { timeoutMs: 1_000, fetch };
}

describe('minting the provisioning token through the seeded administrator', () => {
  it('signs in, walks the second-factor router and returns the created token', async () => {
    const { fetch, calls } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [{ status: 302, location: `${PUBLIC_ORIGIN}/` }],
      'GET /': [{ status: 200, body: '<html>home</html>' }],
      'GET /my/access_tokens': [{ status: 200, body: TOKENS_PAGE }],
      'POST /my/access_tokens/generate_api_key': [{ status: 200, body: CREATED_DIALOG }],
    });

    const result = await mintAdminToken(
      { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'seed-pass' },
      options(fetch),
    );

    expect(result).toEqual({ ok: true, token: 'opapi-0123456789abcdef' });
    // The generate call carries the page's CSRF token and a token name, and the password appears in
    // exactly one place: the sign-in body.
    const generate = calls.find((call) => call.path.endsWith('generate_api_key'));
    expect(generate?.body).toContain('token_api%5Btoken_name%5D=seamnex-relay-');
  });

  it('reads the created token when the input carries value before name', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [{ status: 302, location: `${PUBLIC_ORIGIN}/` }],
      'GET /': [{ status: 200, body: '<html>home</html>' }],
      'GET /my/access_tokens': [{ status: 200, body: TOKENS_PAGE }],
      'POST /my/access_tokens/generate_api_key': [{ status: 200, body: CREATED_DIALOG_REVERSED }],
    });

    await expect(
      mintAdminToken(
        { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'seed-pass' },
        options(fetch),
      ),
    ).resolves.toEqual({ ok: true, token: 'opapi-fedcba9876543210' });
  });

  /**
   * The state an older deployment is in: the seeder forced a password change. Completing it with the
   * value the platform already holds satisfies the product without rotating a break-glass credential
   * into a value nobody can read — the secret stays valid for the operator too.
   */
  it('completes a forced password change with the password it already holds', async () => {
    const { fetch, calls } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 422, body: PASSWORD_FORM }],
      'POST /account/change_password': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [{ status: 302, location: `${PUBLIC_ORIGIN}/` }],
      'GET /': [{ status: 200, body: '<html>home</html>' }],
      'GET /my/access_tokens': [{ status: 200, body: TOKENS_PAGE }],
      'POST /my/access_tokens/generate_api_key': [{ status: 200, body: CREATED_DIALOG }],
    });

    const result = await mintAdminToken(
      { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'seed-pass' },
      options(fetch),
    );

    expect(result).toEqual({
      ok: true,
      token: 'opapi-0123456789abcdef',
      completedPasswordChange: true,
    });
    const change = calls.find((call) => call.path === '/account/change_password');
    // The change form's own token, not the sign-in form's that precedes it on the page.
    expect(change?.body).toContain('authenticity_token=form-csrf');
    expect(change?.body).toContain('password_change_user=admin');
    expect(change?.body).toContain('password=seed-pass');
    expect(change?.body).toContain('new_password=seed-pass');
    expect(change?.body).toContain('new_password_confirmation=seed-pass');
  });

  it('reports the change when the product insists on a new password', async () => {
    const { fetch, calls } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 422, body: PASSWORD_FORM }],
      // The product re-renders the form: an unchanged password was refused, and no new attempt here
      // can succeed, so the verdict names the remedy a person has.
      'POST /account/change_password': [{ status: 422, body: PASSWORD_FORM }],
    });

    const result = await mintAdminToken(
      { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'seed-pass' },
      options(fetch),
    );

    expect(result).toMatchObject({ ok: false, reason: 'force_password_change' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('reports a change screen it cannot fill in rather than guessing fields', async () => {
    const { fetch, calls } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 422, body: PASSWORD_SCREEN_WITHOUT_FORM }],
    });

    await expect(
      mintAdminToken(
        { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'seed-pass' },
        options(fetch),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'force_password_change' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('reports a refused seed credential and does not retry', async () => {
    const { fetch, calls } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 422, body: LOGIN_FORM }],
    });

    const result = await mintAdminToken(
      { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'wrong' },
      options(fetch),
    );

    expect(result).toMatchObject({ ok: false, reason: 'credential_rejected' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    // The credential never reaches a result.
    expect(JSON.stringify(result)).not.toContain('wrong');
  });

  /**
   * Measured on 17.9.6 on 2026-11-11: the second-factor router hands back a hop *under* `/login`
   * (`/login/two_factor_authentication/<token>`) before the application. A prefix test read that as a
   * refused credential and the sweep logged `session_unconfirmed` for a password the product had just
   * accepted — the whole bootstrap failed on a successful sign-in.
   */
  it('follows the second-factor router through its /login-prefixed hop', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [
        { status: 302, location: `${PUBLIC_ORIGIN}/login/two_factor_authentication/abc123` },
      ],
      'GET /login/two_factor_authentication/abc123': [
        { status: 302, location: `${PUBLIC_ORIGIN}/?first_time_user=true` },
      ],
      'GET /': [{ status: 200, body: '<html>home</html>' }],
      'GET /my/access_tokens': [{ status: 200, body: TOKENS_PAGE }],
      'POST /my/access_tokens/generate_api_key': [{ status: 200, body: CREATED_DIALOG }],
    });

    await expect(
      mintAdminToken(
        { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'seed-pass' },
        options(fetch),
      ),
    ).resolves.toEqual({ ok: true, token: 'opapi-0123456789abcdef' });
  });

  it('still reads a redirect to the sign-in form as a refused credential', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [{ status: 302, location: `${PUBLIC_ORIGIN}/login?back_url=%2F` }],
    });

    await expect(
      mintAdminToken(
        { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'seed-pass' },
        options(fetch),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'session_unconfirmed' });
  });

  it('fails closed when the token page is not signed in', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [
        { status: 302, location: `${PUBLIC_ORIGIN}/login` },
      ],
    });

    await expect(
      mintAdminToken(
        { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'seed-pass' },
        options(fetch),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'session_unconfirmed' });
  });

  it('treats an unrecognised token response as a changed form, not as a token', async () => {
    const { fetch } = replay({
      'GET /login': [{ status: 200, body: LOGIN_FORM }],
      'POST /login': [
        { status: 302, location: `${PUBLIC_ORIGIN}/two_factor_authentication/request` },
      ],
      'GET /two_factor_authentication/request': [{ status: 302, location: `${PUBLIC_ORIGIN}/` }],
      'GET /': [{ status: 200, body: '<html>home</html>' }],
      'GET /my/access_tokens': [{ status: 200, body: TOKENS_PAGE }],
      'POST /my/access_tokens/generate_api_key': [
        { status: 500, body: '<html>Unknown token type</html>' },
      ],
    });

    const result = await mintAdminToken(
      { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'seed-pass' },
      options(fetch),
    );

    expect(result).toMatchObject({ ok: false, reason: 'form_changed' });
    // The product's HTML is not copied into a detail that reaches the audit chain.
    expect(JSON.stringify(result)).not.toContain('Unknown token type');
  });

  it('reports the placeholder page as product_unavailable rather than as a changed form', async () => {
    const { fetch } = replay({
      'GET /login': [
        {
          status: 200,
          body: '<h1>This application currently expects to be reached on the following domain</h1>',
        },
      ],
    });

    await expect(
      mintAdminToken(
        { origin: ORIGIN, publicOrigin: PUBLIC_ORIGIN, username: 'admin', password: 'seed-pass' },
        options(fetch),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'product_unavailable' });
  });
});
