import type { RelayFailure } from '../relay.contract';
import {
  absorbCookies,
  absolute,
  cookieHeader,
  emittedCookies,
  jarFromCookies,
  messageOf,
  newJar,
  pathOf,
  text,
  type CookieJar,
} from './shared';
import { productFetch } from '../product-http';
import type {
  DriverOptions,
  ProductLoginInput,
  ProductLoginResult,
  SessionCheck,
} from '../product-login.driver';
import type { ProductLoginAdapter, SessionVerifyInput } from '../login-adapter';

/**
 * ADR-BE-22 — D7 OrangeHRM 5.9, driven over plain HTTP.
 *
 * The mechanism is the same as OpenProject's: fetch the form, submit it, confirm the session. Every
 * *observable* differs, and each difference below was measured on the running instance rather than
 * inferred from documentation, because each one is a way a copied OpenProject driver would fail:
 *
 *   * The login page is a **Vue SPA**, not a server-rendered form. There is no `<form>` element at
 *     all (`<noscript>` says the product needs JavaScript), so "must contain a form" is not a usable
 *     freshness check. The CSRF token is a component **prop** — `:token="…"` — not a hidden input,
 *     and the page is only recognisable by the `auth-login` component it mounts.
 *   * The submit target is `/web/index.php/auth/validate`, not `/login`.
 *   * A refused password is a **302 back to the login URL**, not a 422. `ValidateController` has
 *     exactly one non-error exit (`HomePageService::getHomePagePath()`); every failure branch —
 *     wrong password, disabled user, terminated employee, stale CSRF — returns a redirect to the
 *     login route. The redirect target *is* the verdict, and because a stale CSRF token is
 *     indistinguishable from a bad password from the outside, this driver never retries: retrying
 *     would spend a second attempt on the one failure the ADR forbids repeating.
 *   * There is **no identity endpoint a self-service account may call**. `/api/v2/admin/users/{id}`
 *     answers 401 anonymously and 403 for an ESS session (measured). Confirmation is therefore the
 *     product's own authentication outcome: the POST redirected to an application path, and that
 *     path answers 200 with the same jar. A cookie for a different principal cannot be minted by
 *     this exchange — the controller resolves the submitted username — so the control the ADR asks
 *     for ("never plant a session for an account we did not authenticate") holds structurally.
 */

const LOGIN_PATH = '/web/index.php/auth/login';
const VALIDATE_PATH = '/web/index.php/auth/validate';

/** The component the login page mounts. Its absence means the page is no longer the login page. */
const LOGIN_COMPONENT = 'auth-login';

/**
 * Form-shaped human challenges. OrangeHRM 5.9 ships no second factor (only LDAP and OpenID
 * providers), so this is a guard against a future release, not a measured branch — and it stays
 * because automating a challenge is the one thing the ADR refuses absolutely.
 */
const CHALLENGE_MARKERS = [
  'name="otp"',
  'name="totp"',
  "name='totp'",
  'class="g-recaptcha"',
  'data-sitekey=',
] as const;

/** How many redirects a single confirmation walk follows before it calls the walk a loop. */
const MAX_HOPS = 4;

export const orangeHrmLogin: ProductLoginAdapter = {
  name: 'orangehrm',

  async signIn(input: ProductLoginInput, options: DriverOptions): Promise<ProductLoginResult> {
    const jar = newJar();
    const call = makeCall(jar, input, options.timeoutMs, options.fetch);

    // ---- ① Fetch the shell and read the token out of the component prop -----------------------
    let first: Response;
    try {
      first = await call(LOGIN_PATH, { method: 'GET' });
    } catch (error) {
      return failed('product_unavailable', `login page could not be fetched: ${messageOf(error)}`);
    }
    absorbCookies(first, jar);
    if (first.status !== 200) {
      return failed('product_unavailable', `login page answered ${first.status}`);
    }
    const html = await text(first);
    if (hasChallenge(html)) return failed('human_challenge', 'the login page presents a challenge');
    const token = csrfToken(html);
    if (!html.includes(LOGIN_COMPONENT) || token === null) {
      return failed(
        'form_changed',
        `the login page no longer mounts ${LOGIN_COMPONENT} with a CSRF token${html.length === 0 ? ' (empty body)' : ''}`,
      );
    }

    // ---- ② Submit ----------------------------------------------------------------------------
    let submitted: Response;
    try {
      submitted = await call(VALIDATE_PATH, {
        method: 'POST',
        body: new URLSearchParams({
          username: input.username,
          password: input.credential,
          _token: token,
        }),
      });
    } catch (error) {
      return failed(
        'product_unavailable',
        `login form could not be submitted: ${messageOf(error)}`,
      );
    }
    absorbCookies(submitted, jar);

    if (submitted.status >= 500) {
      return failed('product_unavailable', `login answered ${submitted.status}`);
    }
    /*
     * `ValidateController` always answers with a redirect. A 2xx means the contract changed (a
     * client-side caller, an interstitial), and guessing past that is how a relayed sign-in ends up
     * planting a session it did not get.
     */
    if (submitted.status < 300 || submitted.status >= 400) {
      return failed('form_changed', `login answered ${submitted.status} instead of a redirect`);
    }

    const location = submitted.headers.get('location');
    if (location === null)
      return failed('product_unavailable', 'login redirected without a location');
    const target = pathOf(location, input.publicOrigin);

    /*
     * Every failure branch lands back on the login route, so this is `credential_rejected` and not
     * "the form was stale": one attempt, then stop. See the file comment for why no retry exists
     * here when OpenProject's driver retries a stale CSRF token once.
     */
    if (target.startsWith(LOGIN_PATH))
      return failed('credential_rejected', 'the product refused the sign-in');

    // ---- ③ Confirm: the application answers with the jar the login produced --------------------
    return confirm(call, jar, target, input);
  },

  async verify(input: SessionVerifyInput, options: DriverOptions): Promise<SessionCheck> {
    const jar = jarFromCookies(input.cookies);
    if (jar.values.size === 0) return { ok: false, reason: 'session_unconfirmed' };

    const call = makeCall(jar, input, options.timeoutMs, options.fetch);
    /*
     * `LoginController::handle` redirects an authenticated session away from the login route and
     * renders it for an anonymous one. That is a cheaper and more universal probe than the
     * dashboard, whose module an installation may not enable.
     */
    let response: Response;
    try {
      response = await call(LOGIN_PATH, { method: 'GET' });
    } catch {
      // An unreachable product is a verdict, not a thrown error: the caller drops the cache and
      // falls back to the product's own page.
      return { ok: false, reason: 'product_unavailable' };
    }
    absorbCookies(response, jar);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      const next = location === null ? '' : pathOf(location, input.publicOrigin);
      if (next.length > 0 && !next.startsWith(LOGIN_PATH)) {
        return { ok: true, cookies: emittedCookies(jar) };
      }
    }
    return { ok: false, reason: 'session_unconfirmed' };
  },
};

/**
 * Walk the redirect the product issued and require the application to answer.
 *
 * A 200 that still mounts `auth-login` is the product handing back the form — a session that looks
 * present and is not — so it fails here rather than in the browser.
 */
async function confirm(
  call: Call,
  jar: CookieJar,
  startPath: string,
  input: Pick<ProductLoginInput, 'origin' | 'publicOrigin'>,
): Promise<ProductLoginResult> {
  let path = startPath;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    let response: Response;
    try {
      response = await call(path, { method: 'GET' });
    } catch (error) {
      return failed('product_unavailable', `the product could not be read: ${messageOf(error)}`);
    }
    absorbCookies(response, jar);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) return failed('session_unconfirmed', 'the product redirected nowhere');
      const next = pathOf(location, input.publicOrigin);
      if (next.startsWith(LOGIN_PATH)) {
        return failed('session_unconfirmed', 'the product did not accept the session it was given');
      }
      path = next;
      continue;
    }

    if (response.status !== 200) {
      return failed('session_unconfirmed', `the product answered ${response.status}`);
    }
    const body = await text(response);
    if (hasChallenge(body)) return failed('human_challenge', 'the product presented a challenge');
    if (body.includes(LOGIN_COMPONENT)) {
      return failed('session_unconfirmed', 'the product still shows its login form');
    }
    return { ok: true, cookies: emittedCookies(jar) };
  }
  return failed('session_unconfirmed', 'the product redirected in a loop');
}

type Call = (
  path: string,
  init: { method: 'GET' | 'POST'; body?: URLSearchParams },
) => Promise<Response>;

function makeCall(
  jar: CookieJar,
  input: Pick<ProductLoginInput, 'origin' | 'publicOrigin'>,
  timeoutMs: number,
  doFetch: DriverOptions['fetch'],
): Call {
  const transport = doFetch ?? (productFetch as typeof globalThis.fetch);
  return (path, init) =>
    transport(absolute(path, input.origin), {
      method: init.method,
      redirect: 'manual',
      headers: {
        // The product is reached by its container alias; only the public name is one it configured
        // itself for, and `productFetch` exists because `fetch` drops a `Host` header it was given.
        host: new URL(input.publicOrigin).host,
        accept: 'text/html',
        ...(init.method === 'POST'
          ? {
              'content-type': 'application/x-www-form-urlencoded',
              // The framework builds its own redirects from these; they describe the browser's view
              // of the product, never the container address.
              origin: input.publicOrigin,
              referer: `${input.publicOrigin}${LOGIN_PATH}`,
            }
          : {}),
        ...(jar.values.size === 0 ? {} : { cookie: cookieHeader(jar.values) }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
}

/** The `:token` prop of the mounted component, HTML-escaped (`&quot;`) or not, depending on build. */
function csrfToken(html: string): string | null {
  const escaped = /:token="&quot;([^"&]+)&quot;"/.exec(html)?.[1];
  if (escaped !== undefined && escaped.length > 0) return escaped;
  const plain = /:token="([^"]+)"/.exec(html)?.[1];
  return plain !== undefined && plain.length > 0 ? plain : null;
}

function hasChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

function failed(reason: RelayFailure, detail: string): ProductLoginResult {
  return { ok: false, reason, detail };
}
