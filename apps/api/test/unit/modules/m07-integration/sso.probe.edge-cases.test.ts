import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { SsoProbe } from '../../../../src/modules/m07-integration/sso.probe';

/**
 * Two edges of the probe that only a hostile or broken identity provider produces.
 *
 * Every URL the probe receives is *data*: Keycloak publishes its own fixed hostname in the form
 * action and in the login redirect, and the probe re-points both at the address it can reach. A
 * provider that answers with something that is not a URL at all must not crash the check — the
 * rewrite is best-effort and the original string is used verbatim. Likewise, an `id_token` whose
 * payload segment is not JSON is a refused token, not an exception in the middle of a check run.
 */
const ADMIN = 'http://keycloak:8080';
const LOGIN_PATH = '/realms/seamnex/login-actions/authenticate?session_code=abc';

const INPUT = {
  clientId: 'seamnex-instance-crm',
  redirectUri: 'http://crm.seamnex.local:8020/oauth-callback.php',
  clientSecret: 'client-secret-value',
};

const dirs: string[] = [];

function setup(overrides: Record<string, unknown> = {}): SsoProbe {
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

function withPassword(): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-sso-edge-'));
  dirs.push(dir);
  const path = join(dir, 'password');
  writeFileSync(path, 'probe-password', 'utf8');
  return { SEAMNEX_SSO_PROBE_USERNAME: 'probe-user', SEAMNEX_SSO_PROBE_PASSWORD_FILE: path };
}

function page(body: string, status = 200): Response {
  return new Response(body, { status });
}

function redirect(location: string): Response {
  const headers = new Headers({ location });
  return new Response(null, { status: 302, headers });
}

function formHtml(action: string): string {
  return `<html><body><form id="kc-form-login" action="${action}" method="post"></form></body></html>`;
}

function idToken(payloadSegment: string): string {
  return `header.${payloadSegment}.signature`;
}

function tokenResponse(payloadSegment: string): Response {
  return new Response(JSON.stringify({ id_token: idToken(payloadSegment) }), { status: 200 });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('an identity provider that answers with something that is not a URL', () => {
  it('follows a login redirect verbatim when its location cannot be rewritten', async () => {
    const unparseable = 'this-is-not-a-url';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(redirect(unparseable))
      .mockResolvedValueOnce(page(formHtml(`${ADMIN}${LOGIN_PATH}`)));
    vi.stubGlobal('fetch', fetch);

    // The check still completes: stage 1 only needed a form, and it got one.
    await expect(setup().verify(INPUT)).resolves.toMatchObject({
      ok: true,
      detail: expect.stringContaining('stage 1 passed'),
    });
    expect(String(fetch.mock.calls[1]?.[0])).toBe(unparseable);
  });

  it('posts to a form action verbatim when it cannot be rewritten', async () => {
    const unparseable = 'this-is-not-a-url';
    let state = '';
    const fetch = vi.fn(async (input: unknown) => {
      const text = String(input);
      if (text === unparseable) return redirect(`${INPUT.redirectUri}?state=${state}&code=code-1`);
      const url = new URL(text);
      if (url.pathname.endsWith('/protocol/openid-connect/auth')) {
        state = url.searchParams.get('state') ?? '';
        // The IdP renders the form with an action that is not a URL.
        return page(formHtml(unparseable));
      }
      if (url.pathname.endsWith('/protocol/openid-connect/token')) {
        return tokenResponse(
          Buffer.from(JSON.stringify({ aud: INPUT.clientId }), 'utf8').toString('base64url'),
        );
      }
      return redirect(`${INPUT.redirectUri}?state=${state}&code=code-1`);
    });
    vi.stubGlobal('fetch', fetch);

    await expect(setup(withPassword()).verify(INPUT)).resolves.toMatchObject({ ok: true });

    // The form session, path and query stay exactly as the IdP issued them.
    expect(String(fetch.mock.calls[1]?.[0])).toBe(unparseable);
  });
});

describe('an id_token whose payload is not JSON', () => {
  it('refuses the token instead of failing the check', async () => {
    let state = '';
    const notJson = Buffer.from('not-json', 'utf8').toString('base64url');
    const fetch = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/protocol/openid-connect/auth')) {
        state = url.searchParams.get('state') ?? '';
        return page(formHtml(`${ADMIN}${LOGIN_PATH}`));
      }
      if (url.pathname.endsWith('/protocol/openid-connect/token')) return tokenResponse(notJson);
      return redirect(`${INPUT.redirectUri}?state=${state}&code=code-1`);
    });
    vi.stubGlobal('fetch', fetch);

    await expect(setup(withPassword()).verify(INPUT)).resolves.toEqual({
      ok: false,
      detail: 'stage 2 (token exchange) returned an id_token that could not be decoded',
    });
  });
});
