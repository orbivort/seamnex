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
 * ADR-BE-22 — D2 Mautic 7.2.2, driven over plain HTTP.
 *
 * The mechanism is the one the other two adapters use: fetch the form, submit it, confirm the
 * session. The *observable* differences below come from Mautic's own Symfony firewall
 * (`app/config/security.php` and `app/bundles/UserBundle/`), not from documentation:
 *
 *   * The login page is server-rendered Twig (`SecurityController::loginAction`), so unlike
 *     OrangeHRM's Vue shell there *is* a `<form>` — and it is a `<form>` this driver can read. The
 *     submit target is `/s/login_check`, declared as the firewall's `check_path`; the admin UI paths
 *     carry the `/s` prefix.
 *   * The credentials are the firewall's own parameters, `_username` and `_password`
 *     (`FormAuthenticator` reads exactly those), and the CSRF token is the hidden `_csrf_token`
 *     input bound to the token id `authenticate`. There is no component prop and no JSON body.
 *   * A refused password and a rejected CSRF token take the **same** route: both raise an
 *     `AuthenticationException` that the firewall's `failure_handler`
 *     (`mautic.security.authentication_handler`) answers with a redirect to `/s/login`, and
 *     `loginAction` renders the flash afterwards. From outside they are indistinguishable, so this
 *     driver never retries — retrying would spend a second attempt on the one failure the ADR
 *     forbids repeating.
 *   * The session cookie's name is configuration, not a scheme derivative: `framework.session.name`
 *     is `%env(MAUTIC_SESSION_NAME)%`, fixed per installation, and `cookie_secure` is decided from
 *     `site_url`. That removes the OrangeHRM trap, and adds a different one: a deployment whose
 *     `site_url` is https mints a `Secure` cookie, which the launch hop re-emits unchanged — such a
 *     route is only usable over TLS, which is what the edge serves.
 *   * There is **no identity endpoint a session cookie may call**: `/api/users/self` is the API
 *     firewall's, and it authenticates a Basic/OAuth2 credential, never the `MAUTIC_SESSION_NAME`
 *     jar. Confirmation is therefore the product's own outcome, as it is for OrangeHRM:
 *     `SecurityController::onRequest` redirects an authenticated session away from the login route,
 *     so a POST that lands on an application path which answers `200` without the login form is the
 *     verdict. The controller resolves the submitted username, so a cookie for a different principal
 *     cannot be minted by this exchange.
 *
 * Live verification against a running 7.2.2 instance is still outstanding; until it happens the
 * driver is pinned by the shapes above rather than by a captured page.
 */

const LOGIN_PATH = '/s/login';
const CHECK_PATH = '/s/login_check';

/** Max redirects one confirmation walk follows before calling the walk a loop. */
const MAX_HOPS = 4;

/**
 * Form-shaped human challenges. Mautic's core ships no second factor — SSO arrives as a plugin —
 * so this is a guard against a future or third-party login screen, and it stays because automating a
 * challenge is the one thing the ADR refuses absolutely.
 */
const CHALLENGE_MARKERS = [
  'name="otp"',
  'name="totp"',
  "name='totp'",
  'class="g-recaptcha"',
  'data-sitekey=',
] as const;

export const mauticLogin: ProductLoginAdapter = {
  name: 'mautic',

  async signIn(input: ProductLoginInput, options: DriverOptions): Promise<ProductLoginResult> {
    const jar = newJar();
    const call = makeCall(jar, input, options.timeoutMs, options.fetch ?? productFetch);

    // ---- ① Fetch the form and read the firewall's CSRF token ----------------------------------
    let first: Response;
    try {
      first = await call(LOGIN_PATH, { method: 'GET' });
    } catch (error) {
      return failed('product_unavailable', `login page could not be fetched: ${messageOf(error)}`);
    }
    absorbCookies(first, jar);

    /*
     * The jar is empty, so an authenticated session cannot be the reason for a redirect here: the
     * login route is not serving its form (an installer, a moved route, an edge interstitial). That
     * is a changed contract, not a refused credential, and guessing past it would submit to a page
     * the driver never read.
     */
    if (first.status >= 300 && first.status < 400) {
      return failed('form_changed', 'the login route answered with a redirect instead of the form');
    }
    if (first.status !== 200) {
      return failed('product_unavailable', `login page answered ${first.status}`);
    }

    const html = await text(first);
    if (hasChallenge(html)) return failed('human_challenge', 'the login page presents a challenge');
    const token = csrfToken(html);
    if (!hasLoginForm(html) || token === null) {
      return failed(
        'form_changed',
        `the login page no longer carries the firewall's form and CSRF token${html.length === 0 ? ' (empty body)' : ''}`,
      );
    }

    // ---- ② Submit ------------------------------------------------------------------------------
    let submitted: Response;
    try {
      submitted = await call(CHECK_PATH, {
        method: 'POST',
        body: new URLSearchParams({
          _username: input.username,
          _password: input.credential,
          _csrf_token: token,
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
     * The firewall intercepts `check_path` and always answers with a redirect: success to the target
     * path or the dashboard, failure back to the login route. A 2xx means the contract changed (a
     * client-side caller, an interstitial), and guessing past that is how a relayed sign-in ends up
     * planting a session it did not get.
     */
    if (submitted.status < 300 || submitted.status >= 400) {
      return failed('form_changed', `login answered ${submitted.status} instead of a redirect`);
    }

    const location = submitted.headers.get('location');
    if (location === null) {
      return failed('product_unavailable', 'login redirected without a location');
    }
    const target = pathOf(location, input.publicOrigin);

    /*
     * Both a refused password and a rejected token land back on the login route, so this is
     * `credential_rejected` and not "the form was stale": one attempt, then stop.
     */
    if (target.startsWith(LOGIN_PATH)) {
      return failed('credential_rejected', 'the product refused the sign-in');
    }

    // ---- ③ Confirm: the application answers with the jar the login produced ---------------------
    return confirm(call, jar, target, input);
  },

  async verify(input: SessionVerifyInput, options: DriverOptions): Promise<SessionCheck> {
    const jar = jarFromCookies(input.cookies);
    if (jar.values.size === 0) return { ok: false, reason: 'session_unconfirmed' };

    const call = makeCall(jar, input, options.timeoutMs, options.fetch ?? productFetch);
    /*
     * `SecurityController::onRequest` redirects an authenticated session off the login route and
     * renders the form for an anonymous one. That is one cheap request and it cannot mistake a
     * placeholder or an interstitial for a session.
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
 * A 200 that still carries the login form is the product handing back the form — a session that
 * looks present and is not — so it fails here rather than in the browser.
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
    if (hasLoginForm(body)) {
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
        // itself for (`site_url`), and `productFetch` exists because `fetch` drops a `Host` header.
        host: new URL(input.publicOrigin).host,
        /*
         * The edge terminates TLS, so the browser's scheme reaches the product only in this header.
         * Mautic believes it only from a peer listed in `trusted_proxies` — the render set writes
         * the private ranges into `local.php` — and needs it for the absolute URLs it builds. The
         * value is the browser's own view, `http` when the route is genuinely plain.
         */
        'x-forwarded-proto': new URL(input.publicOrigin).protocol.replace(':', ''),
        accept: 'text/html',
        ...(init.method === 'POST'
          ? {
              'content-type': 'application/x-www-form-urlencoded',
              // Symfony binds the CSRF token to the session, and a same-origin token manager reads
              // these two headers. Both describe the browser's view of the product, never the
              // container address.
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

/**
 * The hidden `_csrf_token` input of the firewall's form.
 *
 * Twig's escaping can move the value into a different attribute order, so both orders are read once
 * before the page is called changed.
 */
function csrfToken(html: string): string | null {
  const byName = /<input[^>]*name=["']_csrf_token["'][^>]*value=["']([^"']+)["'][^>]*>/i.exec(
    html,
  )?.[1];
  if (byName !== undefined && byName.length > 0) return byName;
  const byValue = /<input[^>]*value=["']([^"']+)["'][^>]*name=["']_csrf_token["'][^>]*>/i.exec(
    html,
  )?.[1];
  return byValue !== undefined && byValue.length > 0 ? byValue : null;
}

/**
 * The firewall's two credential fields, matched by `name` so a build may reorder or restyle the
 * inputs without the driver mistaking one layout for another product.
 */
function hasLoginForm(html: string): boolean {
  return (
    /<input[^>]*name=["']_username["']/i.test(html) &&
    /<input[^>]*name=["']_password["']/i.test(html)
  );
}

function hasChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

function failed(reason: RelayFailure, detail: string): ProductLoginResult {
  return { ok: false, reason, detail };
}
