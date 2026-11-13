import { productFetch } from './product-http';
import {
  absorbCookies,
  csrfToken,
  makeCall,
  newJar,
  text,
  type Call,
  type CookieJar,
  type DriverOptions,
} from './product-login.driver';
import type { RelayFailure } from './relay.contract';

/**
 * ADR-BE-22 §Credentials (amendment) — mint the provisioning token through the seeded administrator.
 *
 * Why this exists: a `bearer` product has no admin API credential until someone creates a personal
 * access token *inside an authenticated session*, and every fresh deployment starts without one.
 * The result was a silent regression — a redeploy re-created the product's database, the sweep
 * recorded `admin_credential_missing`, and every launch fell back to the product's own login form.
 *
 * The one account the platform may use for this is the seed administrator: the deploy generated its
 * password and stored it as an instance secret. The entry's env schema sets
 * `OPENPROJECT_SEED_ADMIN_USER_PASSWORD_RESET=false`, so a fresh deployment signs in normally. An
 * instance seeded *before* that variable existed still owes the change its seeder demanded, and the
 * flag lives on the account, so editing the entry cannot clear it. The driver therefore completes the
 * pending change **with the password it already holds** — measured on 17.9.6: `new_password` equal to
 * the current value is accepted — which satisfies the product without rotating a break-glass
 * credential to a value nobody can read. A product that refuses an unchanged password is reported
 * with a remedy; nothing here guesses a new one.
 *
 * Never retried by this module. The product locks an account after a run of failed sign-ins, so the
 * caller owns the quiet period, and a rejected password here is a permanent verdict.
 *
 * What is measured on 17.9.6 (and why each step is not optional):
 *   * `POST /login` answers `302` to `/two_factor_authentication/request` even for an account with no
 *     device registered; that route is a pass-through, so it must be followed once or the session is
 *     not established and `/my/access_tokens` answers `302` to `/login`.
 *   * `/my/access_tokens` carries the CSRF token in `<meta name="csrf-token">`; the generate call is
 *     a `turbo_stream` POST and a stale header is answered `422 CSRF validation error`.
 *   * `POST /my/access_tokens/generate_api_key` needs `token_api[token_name]` — without it the
 *     controller raises `Unknown token type` and answers `500`.
 *   * the created token is rendered in a readonly input with `value` **before** `name`, so the parser
 *     reads both attribute orders.
 *   * the token name must be unique: `Token::Named` validates it while the previous token still
 *     exists (`before_save :delete_previous_token` runs later), so a repeat name is a `400`.
 */

const LOGIN_FORM_MARKER = 'user-login--form';
const PASSWORD_CHANGE_MARKERS = [
  'data-controller="password-requirements"',
  'change_password_header_title',
] as const;
const CHALLENGE_MARKERS = [
  'name="otp"',
  'name="totp"',
  'name="two_factor"',
  'class="g-recaptcha"',
] as const;
const PLACEHOLDER_MARKER = 'expects to be reached on the following domain';

const TOKENS_PATH = '/my/access_tokens';
const GENERATE_PATH = '/my/access_tokens/generate_api_key';
const TOKEN_NAME_PREFIX = 'seamnex-relay';

/** The remedy a person has when the product will not keep the password the platform holds. */
const PASSWORD_NOT_ROTATED =
  'the product will not accept the seeded password unchanged; a person must set a new administrator password and store a token minted from it';

export type AdminTokenResult =
  | {
      readonly ok: true;
      readonly token: string;
      /** The account still owed a seeder-imposed change, and this sign-in cleared it. */
      readonly completedPasswordChange?: boolean;
    }
  | { readonly ok: false; readonly reason: RelayFailure; readonly detail: string };

export type AdminTokenInput = {
  /** Internal origin on the instance network; never the public one. */
  readonly origin: string;
  /** What a browser uses, for `Host`, `Origin` and `Referer`. */
  readonly publicOrigin: string;
  readonly username: string;
  /** The seed password, read from the secret store immediately before the attempt. */
  readonly password: string;
};

export async function mintAdminToken(
  input: AdminTokenInput,
  options: DriverOptions,
): Promise<AdminTokenResult> {
  const doFetch = options.fetch ?? productFetch;
  const jar = newJar();
  const call = makeCall(jar, input, options.timeoutMs, doFetch);

  // ---- ① The login form ------------------------------------------------------------------------
  let page: Response;
  try {
    page = await call('/login', { method: 'GET' });
  } catch (error) {
    return failed(
      'product_unavailable',
      `the login page could not be fetched: ${messageOf(error)}`,
    );
  }
  absorbCookies(page, jar);
  if (page.status !== 200)
    return failed('product_unavailable', `the login page answered ${page.status}`);
  const loginHtml = await text(page);
  if (loginHtml.includes(PLACEHOLDER_MARKER)) {
    return failed('product_unavailable', 'the product is not serving its application yet');
  }
  if (hasChallenge(loginHtml)) return failed('human_challenge', 'the login page asks for a human');
  const csrf = csrfToken(loginHtml);
  if (!loginHtml.includes(LOGIN_FORM_MARKER) || csrf === null) {
    return failed('form_changed', 'the login page no longer carries its form and a CSRF token');
  }

  // ---- ② Sign in -------------------------------------------------------------------------------
  let submitted: Response;
  try {
    submitted = await call('/login', {
      method: 'POST',
      body: new URLSearchParams({
        authenticity_token: csrf,
        username: input.username,
        password: input.password,
      }),
      // The product's form posts back to the page it was served from.
      referer: `${input.publicOrigin}/login`,
    });
  } catch (error) {
    return failed(
      'product_unavailable',
      `the login form could not be submitted: ${messageOf(error)}`,
    );
  }
  absorbCookies(submitted, jar);

  if (submitted.status === 422) {
    const body = await text(submitted);
    const change = forcedChangeForm(body);
    if (change !== null) {
      // The credential was accepted; the account only still owes the change its seeder demanded.
      // Completing it with the same value keeps the platform's copy — and the operator's — valid.
      const repaired = await completeForcedChange(call, change, input, jar);
      if (!repaired.ok) return repaired;
      const minted = await mintFromSession(call, input, jar);
      return minted.ok ? { ...minted, completedPasswordChange: true } : minted;
    }
    if (PASSWORD_CHANGE_MARKERS.some((marker) => body.includes(marker))) {
      // A change screen this parser cannot fill in: the product's form changed shape, and inventing
      // a password to satisfy it is not a decision this module may make.
      return failed('force_password_change', PASSWORD_NOT_ROTATED);
    }
    if (CSRF_FAILURE.test(body))
      return failed('form_changed', 'the login form rejected its CSRF token');
    if (body.includes(LOGIN_FORM_MARKER)) {
      return failed('credential_rejected', 'the product refused the seed administrator credential');
    }
    return failed('form_changed', 'the product answered the sign-in with an unknown page');
  }
  if (submitted.status >= 500) {
    return failed('product_unavailable', `sign-in answered ${submitted.status}`);
  }

  // ---- ③ Reach the application ------------------------------------------------------------------
  const landed = await settle(call, submitted, jar);
  if (!landed.ok) return landed;

  return mintFromSession(call, input, jar);
}

/**
 * ④ The tokens page and its CSRF token, ⑤ the token itself.
 *
 * Shared by the ordinary sign-in and the one that had to clear a forced password change first: both
 * arrive holding an established session, and a second copy of these steps would be a second place for
 * the token page's shape to drift.
 */
async function mintFromSession(
  call: Call,
  input: AdminTokenInput,
  jar: CookieJar,
): Promise<AdminTokenResult> {
  let tokensPage: Response;
  try {
    tokensPage = await call(TOKENS_PATH, { method: 'GET' });
  } catch (error) {
    return failed('product_unavailable', `the token page could not be read: ${messageOf(error)}`);
  }
  absorbCookies(tokensPage, jar);
  if (tokensPage.status !== 200) {
    return failed('session_unconfirmed', `the token page answered ${tokensPage.status}`);
  }
  const tokensHtml = await text(tokensPage);
  if (tokensHtml.includes(LOGIN_FORM_MARKER)) {
    return failed(
      'session_unconfirmed',
      'the product did not keep the session the sign-in produced',
    );
  }
  const pageCsrf = metaCsrf(tokensHtml) ?? csrfToken(tokensHtml);
  if (pageCsrf === null) return failed('form_changed', 'the token page carries no CSRF token');

  let generated: Response;
  try {
    generated = await call(GENERATE_PATH, {
      method: 'POST',
      accept: 'text/vnd.turbo-stream.html',
      headers: { 'x-csrf-token': pageCsrf },
      referer: `${input.publicOrigin}${TOKENS_PATH}`,
      // A unique name: the previous token still exists when the name is validated, so reusing one
      // is answered `400` even though the save itself would delete the older token.
      body: new URLSearchParams({
        'token_api[token_name]': `${TOKEN_NAME_PREFIX}-${Date.now()}`,
      }),
    });
  } catch (error) {
    return failed('product_unavailable', `the token could not be requested: ${messageOf(error)}`);
  }
  absorbCookies(generated, jar);
  const generatedHtml = await text(generated);
  if (generated.status !== 200) {
    // No body in the detail: the response is HTML and may echo account data.
    return failed('form_changed', `token generation answered ${generated.status}`);
  }
  const token = tokenFrom(generatedHtml);
  if (token === null) {
    return failed('form_changed', 'the token page changed shape: no token in the response');
  }
  return { ok: true, token };
}

/**
 * Is this redirect back to the sign-in form — the product refusing the credential?
 *
 * Only the form itself. The second-factor router's pass-through hop lives *under* `/login`
 * (`/login/two_factor_authentication/<token>`, measured on 17.9.6), so a prefix test read a normal
 * sign-in as a refused one: the sweep reported `session_unconfirmed` for a credential the product had
 * just accepted.
 */
function isLoginForm(path: string): boolean {
  const pathname = path.split('?')[0] ?? path;
  return pathname === '/login' || pathname === '/login/';
}

/**
 * Walks the redirect a successful sign-in produces. OpenProject always routes through the second
 * factor *router*, which redirects again for an account with no device; a rendered challenge page is
 * the only stop that needs a person.
 */
async function settle(
  call: Call,
  response: Response,
  jar: CookieJar,
): Promise<{ readonly ok: true } | AdminTokenResult> {
  let current = response;
  for (let hop = 0; hop < 4; hop += 1) {
    if (current.status >= 200 && current.status < 300) return { ok: true };
    if (current.status < 300 || current.status >= 400) {
      return failed('session_unconfirmed', `sign-in ended on ${current.status}`);
    }
    const location = current.headers.get('location');
    if (location === null) return failed('session_unconfirmed', 'sign-in redirected nowhere');
    const next = pathOf(location);
    if (isLoginForm(next)) {
      return failed(
        'session_unconfirmed',
        'the product did not accept the credential it was given',
      );
    }
    // The second-factor route is a router: for an account with no device it redirects again and the
    // next hop lands on the application. A rendered page is the challenge, and `settle` only reads
    // the body to tell those two apart.
    let followed: Response;
    try {
      followed = await call(next, { method: 'GET' });
    } catch (error) {
      return failed('product_unavailable', `the product could not be read: ${messageOf(error)}`);
    }
    absorbCookies(followed, jar);
    if (followed.status === 200) {
      const body = await text(followed);
      if (hasChallenge(body)) {
        return failed('human_challenge', 'the product asked for a second factor');
      }
      if (PASSWORD_CHANGE_MARKERS.some((marker) => body.includes(marker))) {
        return failed('force_password_change', 'the product requires a password change');
      }
    }
    current = followed;
  }
  return failed('session_unconfirmed', 'the product redirected in a loop');
}

/**
 * The forced-change form, as the page renders it.
 *
 * The page carries two forms — the sign-in one and this one — so the token has to be read *inside*
 * the change form. Reaching for the page's first `authenticity_token` submits the wrong token and
 * gets a `422 CSRF validation error` that looks like a refused password.
 */
type ForcedChangeForm = {
  readonly action: string;
  readonly csrf: string;
  readonly login: string;
};

function forcedChangeForm(html: string): ForcedChangeForm | null {
  if (!PASSWORD_CHANGE_MARKERS.some((marker) => html.includes(marker))) return null;
  const start = html.search(/<form[^>]*action=["'][^"']*change_password[^"']*["']/i);
  if (start < 0) return null;
  const end = html.indexOf('</form>', start);
  if (end < 0) return null;
  const block = html.slice(start, end);
  const action = /action=["']([^"']+)["']/i.exec(block)?.[1];
  const csrf = csrfToken(block);
  if (action === undefined || csrf === null) return null;
  return { action, csrf, login: hiddenValue(block, 'password_change_user') ?? '' };
}

/**
 * Complete a forced password change without rotating the credential.
 *
 * The account already accepted the seeded password — the product only insists whoever holds it picks
 * a new one. Re-submitting the same value satisfies that demand and leaves every copy of the secret
 * valid: the platform's, and the operator's. A product that refuses an unchanged password is
 * reported, because the only alternative is inventing a value nobody holds.
 */
async function completeForcedChange(
  call: Call,
  form: ForcedChangeForm,
  input: AdminTokenInput,
  jar: CookieJar,
): Promise<{ readonly ok: true } | AdminTokenResult> {
  let response: Response;
  try {
    response = await call(form.action, {
      method: 'POST',
      referer: `${input.publicOrigin}${form.action}`,
      body: new URLSearchParams({
        authenticity_token: form.csrf,
        password_change_user: form.login.length > 0 ? form.login : input.username,
        password: input.password,
        new_password: input.password,
        new_password_confirmation: input.password,
      }),
    });
  } catch (error) {
    return failed(
      'product_unavailable',
      `the forced password change could not be submitted: ${messageOf(error)}`,
    );
  }
  absorbCookies(response, jar);

  // Accepted: a redirect into the second-factor router, which `settle` walks to the application. A
  // re-rendered form is the product refusing an unchanged password, which no further attempt fixes.
  if (response.status < 300 || response.status >= 400) {
    const body = await text(response);
    return PASSWORD_CHANGE_MARKERS.some((marker) => body.includes(marker))
      ? failed('force_password_change', PASSWORD_NOT_ROTATED)
      : failed('form_changed', `the forced password change answered ${response.status}`);
  }
  return settle(call, response, jar);
}

/** A hidden input's value by name, in either attribute order the product has been seen to use. */
function hiddenValue(html: string, name: string): string | null {
  const direct = new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i').exec(
    html,
  )?.[1];
  if (direct !== undefined) return direct;
  const reversed = new RegExp(
    `<input[^>]*value=["']([^"']*)["'][^>]*name=["']${name}["']`,
    'i',
  ).exec(html)?.[1];
  return reversed ?? null;
}

/** The plain token from the created-token dialog; both attribute orders are measured shapes. */
function tokenFrom(html: string): string | null {
  const forward =
    /<input[^>]*name=["']openproject_api_access_token["'][^>]*value=["']([^"']+)["']/i.exec(
      html,
    )?.[1];
  if (forward !== undefined && forward.length > 0) return forward;
  const reversed =
    /<input[^>]*value=["']([^"']+)["'][^>]*name=["']openproject_api_access_token["']/i.exec(
      html,
    )?.[1];
  return reversed !== undefined && reversed.length > 0 ? reversed : null;
}

function metaCsrf(html: string): string | null {
  const match = /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i.exec(html);
  return match?.[1] ?? null;
}

function hasChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

function pathOf(location: string): string {
  try {
    const url = new URL(location, 'http://product.invalid');
    return `${url.pathname}${url.search}`;
  } catch {
    return location.startsWith('/') ? location : `/${location}`;
  }
}

const CSRF_FAILURE = /cross-site request forgery|invalid authenticity token/i;

function failed(reason: RelayFailure, detail: string): AdminTokenResult {
  return { ok: false, reason, detail };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
