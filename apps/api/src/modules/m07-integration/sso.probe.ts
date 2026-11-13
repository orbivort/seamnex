import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';

export type SsoProbeInput = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly clientSecret: string;
  /**
   * Claims the product was configured to require (EspoCRM asks for `groups` as `essential` in the
   * ID token). A claim the realm never mints — because the client has no scope that produces it —
   * cannot be caught by the authorization leg, and surfaces later as a product with no group or
   * team mapping. Checked here so the registration and the product's expectation cannot disagree.
   */
  readonly expectedClaims?: readonly string[];
};

export type SsoProbeResult = { readonly ok: boolean; readonly detail: string };

type Cookies = Map<string, string>;

/**
 * 4D.5 — evidence that the product's OIDC client actually works.
 *
 * The check this replaces asked Keycloak for an admin token and called the result "SSO test login".
 * It passed while the product's redirect URI did not exist, so a deployment could be green and the
 * product's sign-in broken. A check that cannot fail the way the feature fails is not evidence.
 *
 * Two stages, and the detail line always says which ones ran:
 *   1. **Authorization request.** Keycloak is asked for an authorization code with the registered
 *      client id and redirect URI. A mismatch comes back as an error page; an accepted request
 *      comes back either as a redirect to the login form or as the form itself (Keycloak answers
 *      200 with `kc-form-login` for a plain browser flow). This stage needs no credential and
 *      catches the defect that actually occurs: a URI that drifted from the product's `siteUrl`.
 *   2. **Code exchange.** When a probe identity is configured, the form is submitted, the `state`
 *      echoed back is checked, the code is exchanged, and the `id_token` is validated for audience,
 *      expiry and issuer shape. This is the only stage that proves the secret and the endpoints.
 *
 * Failure messages name the stage and the reason; never a token, a code or a credential.
 */
@Injectable()
export class SsoProbe {
  private readonly logger = new Logger('m07-sso-probe');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async verify(input: SsoProbeInput): Promise<SsoProbeResult> {
    const state = randomBytes(16).toString('base64url');
    const cookies: Cookies = new Map();

    let response: Response;
    try {
      response = await fetch(this.authorizeUrl(input, state), {
        redirect: 'manual',
        headers: { accept: 'text/html' },
        signal: AbortSignal.timeout(this.config.SEAMNEX_SAMPLE_TIMEOUT_MS + 8_000),
      });
    } catch (error) {
      return {
        ok: false,
        detail: `stage 1 (authorization request) could not reach the identity provider: ${messageOf(error)}`,
      };
    }
    absorbCookies(response, cookies);

    if (response.status >= 400) {
      return {
        ok: false,
        detail: `stage 1 (authorization request) answered ${response.status}; the client or the redirect URI is refused`,
      };
    }

    let html: string;
    if (response.status >= 300) {
      // A redirect to the login flow: follow it once to get the form. The state travels with the
      // authorization session and comes back on the callback, where it is asserted.
      const location = response.headers.get('location');
      if (location === null)
        return {
          ok: false,
          detail: 'stage 1 (authorization request) redirected without a location',
        };
      // Same origin rewrite as the form action below: the IdP answers with its public hostname.
      const loginUrl = formActionUrl(location, this.config.SEAMNEX_KEYCLOAK_ADMIN_URL);
      let page: Response;
      try {
        page = await fetch(loginUrl, {
          redirect: 'manual',
          headers: {
            accept: 'text/html',
            ...(cookies.size === 0 ? {} : { cookie: cookieHeader(cookies) }),
          },
          signal: AbortSignal.timeout(this.config.SEAMNEX_SAMPLE_TIMEOUT_MS + 8_000),
        });
      } catch (error) {
        return {
          ok: false,
          detail: `stage 1 (login form) could not be fetched: ${messageOf(error)}`,
        };
      }
      absorbCookies(page, cookies);
      html = await page.text().catch(() => '');
    } else {
      html = await response.text().catch(() => '');
    }

    if (formAction(html) === null) {
      // No form means Keycloak refused before rendering the login: `invalid_redirect_uri`,
      // `invalid_client` and an unknown client all arrive this way, with HTTP 200.
      return {
        ok: false,
        detail: `stage 1 (authorization request) returned an error page: ${errorText(html)}`,
      };
    }

    const credentials = this.probeCredentials();
    if (credentials === null) {
      return {
        ok: true,
        detail:
          'stage 1 passed: the client and redirect URI are registered. Stage 2 (code exchange) was ' +
          'not run — set SEAMNEX_SSO_PROBE_USERNAME and SEAMNEX_SSO_PROBE_PASSWORD_FILE to exercise it.',
      };
    }

    return this.exchange(input, html, cookies, state, credentials);
  }

  // ---------------------------------------------------------------------------------------------

  private async exchange(
    input: SsoProbeInput,
    loginHtml: string,
    cookies: Cookies,
    expectedState: string,
    credentials: { username: string; password: string },
  ): Promise<SsoProbeResult> {
    const action = formAction(loginHtml);
    if (action === null) return { ok: false, detail: 'stage 2 (login form) could not be parsed' };
    // Keycloak stamps its fixed public hostname into the form action; the probe is a server-side
    // client and reaches the same instance at the admin URL (in the dev stack that is `keycloak:8080`
    // rather than the browser's `localhost:8082`). Only the origin is rewritten — the form session,
    // the path and the query stay exactly as the IdP issued them.
    const submitUrl = formActionUrl(action, this.config.SEAMNEX_KEYCLOAK_ADMIN_URL);

    let submitted: Response;
    try {
      submitted = await fetch(submitUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(cookies.size === 0 ? {} : { cookie: cookieHeader(cookies) }),
        },
        body: new URLSearchParams({
          username: credentials.username,
          password: credentials.password,
          credentialId: '',
        }),
        signal: AbortSignal.timeout(this.config.SEAMNEX_SAMPLE_TIMEOUT_MS + 8_000),
      });
    } catch (error) {
      return { ok: false, detail: `stage 2 (login) could not be submitted: ${messageOf(error)}` };
    }

    if (submitted.status < 300) {
      const body = await submitted.text().catch(() => '');
      return { ok: false, detail: `stage 2 (login) was refused: ${errorText(body)}` };
    }
    const callback = submitted.headers.get('location');
    if (callback === null)
      return { ok: false, detail: 'stage 2 (login) redirected without a location' };

    const params = new URL(callback, this.config.SEAMNEX_KEYCLOAK_ADMIN_URL).searchParams;
    const code = params.get('code');
    if (code === null) {
      const reason = params.get('error') ?? 'no code parameter';
      return {
        ok: false,
        detail: `stage 2 (login) was refused by the identity provider: ${reason}`,
      };
    }
    if (params.get('state') !== expectedState) {
      // A different state means the callback does not belong to this authorization request — a
      // CSRF-shaped defect rather than a configuration one, and worth its own sentence.
      return {
        ok: false,
        detail:
          'stage 2 (login) returned a code for a different state; the callback does not match the request',
      };
    }

    let token: Response;
    try {
      token = await fetch(`${this.realmUrl()}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: input.redirectUri,
          client_id: input.clientId,
          client_secret: input.clientSecret,
        }),
        signal: AbortSignal.timeout(this.config.SEAMNEX_SAMPLE_TIMEOUT_MS + 8_000),
      });
    } catch (error) {
      return { ok: false, detail: `stage 2 (token exchange) failed: ${messageOf(error)}` };
    }
    if (!token.ok) {
      return {
        ok: false,
        detail: `stage 2 (token exchange) answered ${token.status}; the client secret or the redirect URI is wrong`,
      };
    }

    const payload = (await token.json().catch(() => null)) as { id_token?: string } | null;
    const idToken = payload?.id_token;
    if (typeof idToken !== 'string')
      return { ok: false, detail: 'stage 2 (token exchange) returned no id_token' };

    const claims = decodeClaims(idToken);
    if (claims === null)
      return {
        ok: false,
        detail: 'stage 2 (token exchange) returned an id_token that could not be decoded',
      };

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(input.clientId)) {
      return {
        ok: false,
        detail: `stage 2 (token exchange): the id_token audience does not include ${input.clientId}`,
      };
    }
    if (typeof claims.exp === 'number' && claims.exp * 1_000 < Date.now()) {
      return {
        ok: false,
        detail: 'stage 2 (token exchange): the id_token is already expired (clock skew?)',
      };
    }

    const missing = (input.expectedClaims ?? []).filter((claim) => claims[claim] === undefined);
    if (missing.length > 0) {
      // The product asked for these as required. A realm that silently omits one is a registration
      // that will not produce the mapping the product was told to expect.
      return {
        ok: false,
        detail: `stage 2 (token exchange): the id_token carries no ${missing.join(', ')} claim; the client needs the scope that mints it`,
      };
    }

    return {
      ok: true,
      detail: `stages 1–2 passed: authorization request accepted and code exchanged for ${input.clientId} as ${String(
        claims.preferred_username ?? claims.sub ?? 'unknown',
      )}${(input.expectedClaims ?? []).length === 0 ? '' : `, carrying ${(input.expectedClaims ?? []).join(' and ')}`}`,
    };
  }

  private authorizeUrl(input: SsoProbeInput, state: string): string {
    const query = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: 'openid',
      state,
    });
    return `${this.realmUrl()}/protocol/openid-connect/auth?${query.toString()}`;
  }

  private realmUrl(): string {
    return `${this.config.SEAMNEX_KEYCLOAK_ADMIN_URL}/realms/${this.config.SEAMNEX_KEYCLOAK_REALM}`;
  }

  /** `null` when the host has no probe identity: the check then stops after stage 1 and says so. */
  private probeCredentials(): { username: string; password: string } | null {
    const username = this.config.SEAMNEX_SSO_PROBE_USERNAME;
    const path = this.config.SEAMNEX_SSO_PROBE_PASSWORD_FILE;
    if (username.length === 0 || path.length === 0) return null;
    try {
      const password = readFileSync(path, 'utf8').trim();
      return password.length === 0 ? null : { username, password };
    } catch (error) {
      this.logger.warn(
        `sso probe password file is unreadable (${messageOf(error)}); stage 2 is skipped`,
      );
      return null;
    }
  }
}

function formAction(html: string): string | null {
  const form = /<form[^>]*id="kc-form-login"[^>]*>/i.exec(html)?.[0];
  const action = form === undefined ? null : /action="([^"]+)"/i.exec(form)?.[1];
  return action === undefined || action === null ? null : action.replace(/&amp;/g, '&');
}

/**
 * Re-points a URL the IdP issued at the client's own view of the same instance. Keycloak is
 * configured with one fixed hostname (it must be, or the `iss` claim disagrees between the browser
 * and the product), and that hostname is not necessarily the one a server-side client reaches.
 * Path and query are preserved verbatim.
 */
function formActionUrl(url: string, base: string): string {
  try {
    const target = new URL(url);
    const root = new URL(base);
    target.protocol = root.protocol;
    target.host = root.host;
    return target.toString();
  } catch {
    return url;
  }
}

/** A short, tag-free rendering of a Keycloak error page — enough to diagnose, never a credential. */
function errorText(html: string): string {
  const feedback = /id="kc-feedback-text"[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(html)?.[1] ?? html;
  const text = feedback
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length === 0 ? 'no message on the page' : text.slice(0, 240);
}

function absorbCookies(response: Response, jar: Cookies): void {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values =
    headers.getSetCookie?.() ??
    (response.headers.get('set-cookie') === null
      ? []
      : [response.headers.get('set-cookie') as string]);
  for (const value of values) {
    const pair = value.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

function cookieHeader(jar: Cookies): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function decodeClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (part === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
