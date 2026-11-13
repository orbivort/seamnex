import { redactValue } from '../../common/logging/masking';
import { productFetch } from './product-http';
import type { RelayFailure } from './relay.contract';

/**
 * ADR-BE-22 — the product's own sign-in form, driven over plain HTTP.
 *
 * Why not a browser: OpenProject's password form is a server-rendered HTML POST with Turbo
 * disabled (`app/views/account/_password_login_form.html.erb`), so a cookie jar and three requests
 * reproduce what a person does, deterministically and in milliseconds. A headless browser would add
 * a dependency, hundreds of megabytes and DOM flakiness for a form that needs no JavaScript. If a
 * future release renders the form client-side, that is a defect this driver reports (`form_changed`)
 * — not a reason to add a browser silently.
 *
 * Two rules are load-bearing and must survive any edit here:
 *
 *   * **The credential is never emitted.** It is not in a URL, a header, a log line, a returned
 *     detail or an error message. The only place it appears is the POST body.
 *   * **Every unknown shape is a failure.** A page the driver does not recognise stops the attempt.
 *     The product's brute-force counter (20 failures → 30 minute lock) turns an optimistic parser
 *     into a person who cannot sign in.
 */

export type ProductLoginInput = {
  /** Internal origin on the instance network (`http://openproject:80`); never the public one. */
  readonly origin: string;
  /** What a browser uses (`http://openproject.localhost:8020`), for `Host`, `Origin`, `Referer`. */
  readonly publicOrigin: string;
  readonly username: string;
  /** The user's product password. Read from the secret store immediately before the attempt. */
  readonly credential: string;
};

export type ProductLoginResult =
  | { readonly ok: true; readonly cookies: readonly string[] }
  | { readonly ok: false; readonly reason: RelayFailure; readonly detail: string };

export type DriverOptions = {
  readonly timeoutMs: number;
  /** Injectable so a test can replay captured pages without a network. */
  readonly fetch?: typeof globalThis.fetch;
};

/**
 * A browser-shaped jar: `values` is what the next request sends, `raw` is what the product last set
 * for that name. Both are needed — the request header wants `name=value`, and the launch hop has to
 * re-emit the full `Set-Cookie` (its `Path` and `HttpOnly` are the product's decision) minus the
 * `Domain` attribute, which belongs to the product's public name, not to the platform's hop.
 */
export type CookieJar = {
  readonly values: Map<string, string>;
  readonly raw: Map<string, string>;
};

export function newJar(): CookieJar {
  return { values: new Map(), raw: new Map() };
}

/** The marker that says the page is the product's password form and not something else. */
const LOGIN_FORM_MARKER = 'user-login--form';

/**
 * Apache answers `200` with a placeholder page before Rails is up. Treating that as success is the
 * documented trap that once declared a healthy container unhealthy (`platform/upstream/D09-01`).
 */
const PLACEHOLDER_MARKER = 'expects to be reached on the following domain';

/** Form-shaped human challenges. Word matching alone would fire on ordinary help text. */
const CHALLENGE_MARKERS = [
  'name="otp"',
  'name="totp"',
  "name='totp'",
  'name="two_factor"',
  'class="g-recaptcha"',
  'data-sitekey=',
  'name="captcha"',
] as const;

/**
 * The forced-password-change screen. OpenProject renders it *in place* of the login page, from the
 * same POST and with the same 422 status as a rejected password (`render_password_change` →
 * `render "my/password", status: :unprocessable_entity`), never as a redirect — so a path check
 * alone cannot see it and only the body tells the two apart. Both markers come from the view
 * itself (`app/views/my/password.html.erb` and `my/_password.html.erb`); neither appears on
 * `/login`.
 */
const PASSWORD_CHANGE_MARKERS = [
  'data-controller="password-requirements"',
  'change_password_header_title',
] as const;

const CSRF_FIELD = 'authenticity_token';

/**
 * The product's own answer to "who am I?" — the only confirmation that names the principal. It is
 * read with the jar the login produced and is never written to; `GET` on it is side-effect free.
 */
const IDENTITY_PATH = '/api/v3/users/me';

/**
 * A `422` that is not about the password. Rails raises the exception in English whatever the locale,
 * while the flash rendered around it is translated — so this is the marker that survives, and without
 * it a stale token would be reported as a refused password and lose its one retry.
 */
const CSRF_FAILURE = /cross-site request forgery|invalid authenticity token/i;

export async function signInToProduct(
  input: ProductLoginInput,
  options: DriverOptions,
): Promise<ProductLoginResult> {
  const doFetch = options.fetch ?? productFetch;
  const jar = newJar();
  const call = makeCall(jar, input, options.timeoutMs, doFetch);

  // ---- ① Fetch the form ---------------------------------------------------------------------
  let first: Response;
  try {
    first = await call('/login', { method: 'GET' });
  } catch (error) {
    return failed('product_unavailable', `login page could not be fetched: ${messageOf(error)}`);
  }
  absorbCookies(first, jar);
  if (first.status !== 200) {
    return failed('product_unavailable', `login page answered ${first.status}`);
  }
  const loginHtml = await text(first);
  const shape = classifyLoginPage(loginHtml);
  if (shape !== 'form') return failed(shape, loginPageDetail(shape, loginHtml));

  // ---- ② Submit -----------------------------------------------------------------------------
  let page = loginHtml;
  let submitted: Response | null = null;
  for (let attempt = 0; attempt < 2 && submitted === null; attempt += 1) {
    const token = csrfToken(page);
    if (token === null) return failed('form_changed', 'the login form carries no CSRF token');
    let response: Response;
    try {
      response = await call('/login', {
        method: 'POST',
        body: new URLSearchParams({
          [CSRF_FIELD]: token,
          username: input.username,
          password: input.credential,
        }),
      });
    } catch (error) {
      return failed(
        'product_unavailable',
        `login form could not be submitted: ${messageOf(error)}`,
      );
    }
    absorbCookies(response, jar);

    if (response.status === 422) {
      /*
       * 422 is not only "stale CSRF". Measured on OpenProject 17.9.6: every wrong-password branch of
       * `AccountController#password_authentication` ends in `render status: :unprocessable_entity`,
       * and the forced-change screen is rendered the same way. Reading the body first is what keeps
       * a refused password from being retried — an extra attempt moves a person 1/20 closer to the
       * product's 30-minute lockout, and it reports the wrong reason to the operator.
       *
       * Only an unrecognisable 422 is treated as a stale token, where one refetch is exactly what a
       * person does after a session cookie expired mid-form.
       */
      const rejected = classifyRejection(await text(response), input.credential);
      if (rejected !== null) return rejected;
      if (attempt === 0) {
        const refetched = await refetchForm(call);
        if (!refetched.ok)
          return failed('csrf_stale', `the form could not be refetched (${refetched.reason})`);
        page = refetched.html;
        continue;
      }
      return failed('csrf_stale', 'the form was rejected twice');
    }
    submitted = response;
  }
  if (submitted === null) return failed('csrf_stale', 'the form was rejected twice');

  if (submitted.status >= 500) {
    return failed('product_unavailable', `login answered ${submitted.status}`);
  }
  if (submitted.status >= 300 && submitted.status < 400) {
    const location = submitted.headers.get('location');
    if (location === null)
      return failed('product_unavailable', 'login redirected without a location');
    const target = pathOf(location, input.publicOrigin);
    // A two-factor route is handed to `confirm` rather than judged here: it can be a pass-through
    // (see `throughChallenge`), and only the page it renders says whether a person is needed.
    if (isPasswordChangePath(target)) {
      return failed(
        'force_password_change',
        'the product requires a password change; the account was provisioned without one',
      );
    }
    return confirm(call, target, jar, {
      origin: input.origin,
      publicOrigin: input.publicOrigin,
      username: input.username,
    });
  }

  // A 200 (or a 4xx the loop kept) is the product re-rendering a page, or an interstitial.
  const body = await text(submitted);
  const classified = classifyRejection(body, input.credential);
  if (classified !== null) return classified;
  return failed(
    'session_unconfirmed',
    'the product answered without a session and without a reason',
  );
}

/**
 * Reads a rendered page for the reasons a sign-in can stop without anyone pressing anything.
 *
 * `null` means "this page is not one of them" — a CSRF rejection body carries none of the markers,
 * which is what makes the retry above safe.
 */
function classifyRejection(html: string, credential: string): ProductLoginResult | null {
  if (hasChallenge(html))
    return failed('human_challenge', 'the product presented a human challenge');
  /*
   * The CSRF failure re-renders the login form too, so the form alone does not mean "the password was
   * refused" — and a stale token is the one 422 worth repeating. The exception's own message is not
   * localised (the flash around it is), which is what makes it a reliable marker.
   */
  if (CSRF_FAILURE.test(html)) return null;
  if (PASSWORD_CHANGE_MARKERS.some((marker) => html.includes(marker))) {
    return failed(
      'force_password_change',
      'the product requires a password change; the account was provisioned without one',
    );
  }
  if (html.includes(LOGIN_FORM_MARKER)) {
    return failed(
      'credential_rejected',
      `the product refused the sign-in: ${errorText(html, credential)}`,
    );
  }
  return null;
}

/**
 * One request into a two-factor route, to tell a pass-through from a challenge.
 *
 * `continue` carries the path the login has moved to; anything else is the verdict. A rendered page
 * here is the form a person has to fill in — the only request in this driver that cannot be
 * completed without one.
 */
async function throughChallenge(
  call: (path: string, init: { method: 'GET' }) => Promise<Response>,
  path: string,
  jar: CookieJar,
  input: Pick<ProductLoginInput, 'origin' | 'publicOrigin'>,
): Promise<{ kind: 'continue'; path: string } | { kind: 'result'; result: ProductLoginResult }> {
  let response: Response;
  try {
    response = await call(path, { method: 'GET' });
  } catch (error) {
    return {
      kind: 'result',
      result: failed('product_unavailable', `the product could not be read: ${messageOf(error)}`),
    };
  }
  absorbCookies(response, jar);
  if (response.status < 300 || response.status >= 400) {
    return {
      kind: 'result',
      result: failed('human_challenge', 'the product asked for a second factor'),
    };
  }
  const location = response.headers.get('location');
  if (location === null) {
    return {
      kind: 'result',
      result: failed('session_unconfirmed', 'the second-factor route redirected nowhere'),
    };
  }
  const next = pathOf(location, input.publicOrigin);
  if (isHumanChallengePath(next) || isPasswordChangePath(next) || next.startsWith('/login')) {
    return {
      kind: 'result',
      result: failed('human_challenge', 'the product asked for a second factor'),
    };
  }
  return { kind: 'continue', path: next };
}

/**
 * ③ Confirm: the cookie is only worth planting if the product accepts it as *this* account.
 *
 * The redirect walk below is only a fast reject: `GET /` also answers `200` with Apache's
 * placeholder, with an interstitial, or with a challenge page that carries none of the markers this
 * driver knows. Treating "no marker I recognise" as success was the one fail-open step in the
 * mechanism, so the verdict is a positive one — the product's own API, which names the
 * authenticated principal.
 */
async function confirm(
  call: (path: string, init: { method: 'GET' }) => Promise<Response>,
  startPath: string,
  jar: CookieJar,
  input: Pick<ProductLoginInput, 'origin' | 'publicOrigin' | 'username'>,
): Promise<ProductLoginResult> {
  let path = startPath;
  for (let hop = 0; hop < 4; hop += 1) {
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
      if (isHumanChallengePath(next)) {
        /*
         * Not every two-factor route is a challenge. OpenProject's `request_otp` is a router: for an
         * account with no registered device and no enforcement it runs `complete_stage_redirect` and
         * the very next request lands on the application, while an account that does have a factor
         * gets the OTP form. Measured on 17.9.6 with the seeded strategies active — treating the
         * route name as the verdict made every relayed sign-in fail closed as `human_challenge`.
         * One request separates the two: another redirect is a pass-through, a rendered page is not.
         */
        const resolved = await throughChallenge(call, next, jar, input);
        if (resolved.kind === 'continue') {
          path = resolved.path;
          continue;
        }
        return resolved.result;
      }
      if (isPasswordChangePath(next)) {
        return failed('force_password_change', 'the product requires a password change');
      }
      if (next.startsWith('/login')) {
        return failed('session_unconfirmed', 'the product did not accept the session it was given');
      }
      path = next;
      continue;
    }

    if (response.status !== 200) {
      return failed('session_unconfirmed', `the product answered ${response.status}`);
    }
    const body = await text(response);
    if (body.includes(PLACEHOLDER_MARKER)) {
      return failed('product_unavailable', 'the edge answered with the placeholder page');
    }
    if (hasChallenge(body)) {
      return failed('human_challenge', 'the product presented a human challenge');
    }
    if (body.includes(LOGIN_FORM_MARKER)) {
      return failed('session_unconfirmed', 'the product still shows its login form');
    }
    return probeIdentity(call, jar, input);
  }
  return failed('session_unconfirmed', 'the product redirected in a loop');
}

/**
 * The positive confirmation: which principal does the product think this cookie belongs to?
 *
 * ADR-BE-22 left this as an open question and then answered it on 17.9.6 — `/api/v3/users/me`
 * answers `200` with `login`, `name` and `admin` from the same jar the login produced. That is
 * strictly better than `GET /`, which also answers `200` for the placeholder page and for any
 * interstitial the marker list does not know.
 *
 * A different login than the one submitted is a failure, not a success with a caveat: it would mean
 * the platform planted a session for an account it did not authenticate.
 */
async function probeIdentity(
  call: (path: string, init: { method: 'GET'; accept?: string }) => Promise<Response>,
  jar: CookieJar,
  input: Pick<ProductLoginInput, 'origin' | 'publicOrigin' | 'username'>,
): Promise<ProductLoginResult> {
  let response: Response;
  try {
    response = await call(IDENTITY_PATH, { method: 'GET', accept: 'application/json' });
  } catch (error) {
    return failed(
      'product_unavailable',
      `the identity probe could not be read: ${messageOf(error)}`,
    );
  }
  absorbCookies(response, jar);

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    const next = location === null ? '' : pathOf(location, input.publicOrigin);
    if (isHumanChallengePath(next))
      return failed('human_challenge', 'the product asked for a second factor');
    if (isPasswordChangePath(next))
      return failed('force_password_change', 'the product requires a password change');
    return failed('session_unconfirmed', 'the product did not accept the session it was given');
  }
  if (response.status !== 200) {
    // A 401 here is the product saying the cookie is worthless — the one answer the planting step
    // must never ignore, because the user would land signed out with no explanation.
    return failed('session_unconfirmed', `the identity probe answered ${response.status}`);
  }

  const login = jsonLogin(await text(response));
  if (login === null) {
    return failed('session_unconfirmed', 'the product answered without an identity');
  }
  if (login.toLowerCase() !== input.username.toLowerCase()) {
    return failed('session_unconfirmed', 'the product authenticated a different account');
  }
  return { ok: true, cookies: emittedCookies(jar) };
}

/** The `login` of a HAL user resource, or `null` when the body is not one. */
function jsonLogin(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const login = (parsed as Record<string, unknown>)['login'];
    return typeof login === 'string' && login.length > 0 ? login : null;
  } catch {
    return null;
  }
}

/**
 * ADR-BE-22 step ③ on its own: is a cached product cookie still worth planting?
 *
 * One `GET /` answers it. The alternative — trusting the cache until its TTL expires — would keep
 * handing out a session the product has already dropped (a restart, a server-side expiry, a
 * revocation), which is the failure the cached path exists to prevent, not to cause.
 */
export type SessionCheck =
  | { readonly ok: true; readonly cookies: readonly string[] }
  | { readonly ok: false; readonly reason: RelayFailure };

export async function verifyProductSession(
  input: {
    readonly origin: string;
    readonly publicOrigin: string;
    readonly cookies: readonly string[];
    /** The login this session is supposed to belong to; a different principal is a failure. */
    readonly username: string;
  },
  options: DriverOptions,
): Promise<SessionCheck> {
  const jar = newJar();
  for (const cookie of input.cookies) {
    if (typeof cookie !== 'string') continue;
    const pair = cookie.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    jar.values.set(name, pair.slice(index + 1).trim());
    jar.raw.set(name, cookie);
  }
  if (jar.values.size === 0) return { ok: false, reason: 'session_unconfirmed' };

  const call = makeCall(jar, input, options.timeoutMs, options.fetch ?? productFetch);
  const result = await confirm(call, '/', jar, {
    origin: input.origin,
    publicOrigin: input.publicOrigin,
    username: input.username,
  });
  return result.ok ? { ok: true, cookies: result.cookies } : { ok: false, reason: result.reason };
}

/**
 * One request in a form session: the jar is applied, `Host`/`Origin` come from the browser's view of
 * the product, and redirects are never followed implicitly (the caller decides what a 302 means).
 *
 * Exported because the administrator-token bootstrap is the same kind of session — login form,
 * CSRF token, one POST — and a second copy of this logic would be a second place to get `Origin`
 * wrong. `headers` and `referer` exist for the one call that needs `X-CSRF-Token` and a Turbo accept.
 */
export type Call = (
  pathOrUrl: string,
  init: {
    method: 'GET' | 'POST';
    body?: URLSearchParams;
    accept?: string;
    headers?: Record<string, string>;
    referer?: string;
  },
) => Promise<Response>;

export function makeCall(
  jar: CookieJar,
  input: Pick<ProductLoginInput, 'origin' | 'publicOrigin'>,
  timeoutMs: number,
  doFetch: typeof globalThis.fetch,
): Call {
  return (pathOrUrl, init) =>
    doFetch(absolute(pathOrUrl, input.origin), {
      method: init.method,
      redirect: 'manual',
      headers: {
        // The product's `config.hosts` compares the header, and a bare IP request reaches Apache's
        // `_default_` vhost — which answers `200` with a placeholder page.
        host: new URL(input.publicOrigin).host,
        accept: init.accept ?? 'text/html',
        ...(init.method === 'POST'
          ? {
              'content-type': 'application/x-www-form-urlencoded',
              // Rails rejects a POST whose Origin does not match the Host it was given (measured:
              // `422 Unable to verify Cross-Site Request Forgery token`). Both come from the
              // browser's view of the product, not from the internal address.
              origin: input.publicOrigin,
              referer: init.referer ?? `${input.publicOrigin}/login`,
            }
          : {}),
        ...(init.headers ?? {}),
        ...(jar.values.size === 0 ? {} : { cookie: cookieHeader(jar.values) }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
}

async function refetchForm(
  call: (path: string, init: { method: 'GET' }) => Promise<Response>,
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  try {
    const response = await call('/login', { method: 'GET' });
    if (response.status !== 200) return { ok: false, reason: `answered ${response.status}` };
    const html = await text(response);
    return classifyLoginPage(html) === 'form'
      ? { ok: true, html }
      : { ok: false, reason: 'the page changed shape' };
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
}

type LoginPageShape = 'form' | 'form_changed' | 'human_challenge' | 'product_unavailable';

function classifyLoginPage(html: string): LoginPageShape {
  if (html.includes(PLACEHOLDER_MARKER)) return 'product_unavailable';
  if (hasChallenge(html)) return 'human_challenge';
  if (!html.includes(LOGIN_FORM_MARKER) || csrfToken(html) === null) return 'form_changed';
  return 'form';
}

function loginPageDetail(shape: LoginPageShape, html: string): string {
  switch (shape) {
    case 'product_unavailable':
      return 'the product is not serving its application yet';
    case 'human_challenge':
      return 'the login page presents a human challenge';
    default:
      return `the login page no longer carries ${LOGIN_FORM_MARKER} and a CSRF token${html.length === 0 ? ' (empty body)' : ''}`;
  }
}

function hasChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

/** OpenProject renders a hidden `authenticity_token`; its absence is a changed form, not a retry. */
export function csrfToken(html: string): string | null {
  const pattern = /<input[^>]*name=["']authenticity_token["'][^>]*value=["']([^"']+)["'][^>]*>/i;
  const direct = pattern.exec(html)?.[1];
  if (direct !== undefined && direct.length > 0) return direct;
  // The attribute order is not guaranteed; try value-before-name once before giving up.
  const reversed =
    /<input[^>]*value=["']([^"']+)["'][^>]*name=["']authenticity_token["'][^>]*>/i.exec(html)?.[1];
  return reversed !== undefined && reversed.length > 0 ? reversed : null;
}

function isHumanChallengePath(path: string): boolean {
  // OpenProject names the route `/two_factor_authentication`, so the segment boundary is `_`, `-`,
  // `/` or the end of the path — not only a slash.
  return /\/(two_factor|two-factor|2fa|otp)(?=[/_-]|$)/i.test(path);
}

function isPasswordChangePath(path: string): boolean {
  // OpenProject's forced change lands on a password screen, not on the app. `/my/change_password`
  // is the modern route; `/account/change_password` is the legacy one that still exists in 17.x.
  return /\/account\/(password|change_password)|\/my\/(password|change_password)|\/force_password_change/i.test(
    path,
  );
}

/** Resolves a Location, keeping only the path: the internal origin is the only one we speak to. */
function pathOf(location: string, publicOrigin: string): string {
  try {
    const url = new URL(location, publicOrigin);
    return `${url.pathname}${url.search}`;
  } catch {
    return location.startsWith('/') ? location : `/${location}`;
  }
}

function absolute(pathOrUrl: string, origin: string): string {
  try {
    const url = new URL(pathOrUrl, origin);
    // A product that answers with an absolute URL to its public host must be rewritten: this client
    // is inside the network and cannot resolve the public name.
    return `${origin}${url.pathname}${url.search}`;
  } catch {
    return `${origin}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
  }
}

export function absorbCookies(response: Response, jar: CookieJar): void {
  for (const value of setCookieValues(response)) {
    const pair = value.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    jar.values.set(name, pair.slice(index + 1).trim());
    // Last write wins, exactly like a browser: the pre-auth cookie from ① is replaced by the
    // signed-in one from ②, and only the latter is worth planting.
    jar.raw.set(name, value);
  }
}

/** The product's own `Set-Cookie` values, one per name, as the launch hop will re-emit them. */
function emittedCookies(jar: CookieJar): string[] {
  return [...jar.raw.values()];
}

function setCookieValues(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.();
  if (values !== undefined && values.length > 0) return values;
  const single = response.headers.get('set-cookie');
  return single === null ? [] : [single];
}

function cookieHeader(values: Map<string, string>): string {
  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export async function text(response: Response): Promise<string> {
  return response.text().catch(() => '');
}

/**
 * A short, tag-free rendering of whatever the product said, with the submitted credential removed.
 *
 * "The page does not echo a form field" is an assumption about the product, not a property of this
 * code: OpenProject's password-policy `422` re-describes the submitted input, and the result of this
 * function reaches a log line and the audit chain. The credential is scrubbed before the length cut,
 * because truncating first could leave a recognisable prefix of it in the detail.
 */
function errorText(html: string, credential: string): string {
  /*
   * OpenProject repeats a toast in a `message="[Error 422] …"` attribute as well as in the banner
   * body, and the attribute is the only carrier that does not depend on the class names of the
   * component library — a `class="… flash-error"` selector found nothing and the audit row said
   * "the product gave no message" exactly when a message existed.
   */
  const attribute = /message="\[Error \d+\]\s*([^"]{1,400})"/i.exec(html)?.[1];
  const region =
    attribute ??
    /<[^>]*(?:role=["']alert["']|class=["'][^"']*\b(?:flash-)?error\b[^"']*["'])[^>]*>([\s\S]{0,600}?)<\//i.exec(
      html,
    )?.[1] ??
    '';
  const text = region
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length === 0
    ? 'the product gave no message'
    : redactValue(text, credential).slice(0, 200);
}

function failed(reason: RelayFailure, detail: string): ProductLoginResult {
  return { ok: false, reason, detail };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
