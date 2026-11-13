/**
 * ADR-BE-22 — the parts of a cookie-driven sign-in that are the same for every product.
 *
 * A product adapter owns what is genuinely product-specific: the login path, the CSRF field, the
 * shape of a refusal and the endpoint that confirms a session. Everything below is HTTP, not
 * product, and two copies of it would be two places to get `Set-Cookie` handling wrong — the
 * `Domain`/`Path` attributes and the difference between "what a browser sends" and "what the
 * product last set" are exactly the details that make a relayed cookie unusable when misread.
 */

/**
 * A browser-shaped jar: `values` is what the next request sends, `raw` is what the product last set
 * for that name. Both are needed — the request header wants `name=value`, and the launch hop has to
 * re-emit the full `Set-Cookie` (its `Path` and `HttpOnly` are the product's decision).
 */
export type CookieJar = {
  readonly values: Map<string, string>;
  readonly raw: Map<string, string>;
};

export function newJar(): CookieJar {
  return { values: new Map(), raw: new Map() };
}

/** A jar rebuilt from cookies the platform cached earlier (step ③ on a reused session). */
export function jarFromCookies(cookies: readonly string[]): CookieJar {
  const jar = newJar();
  for (const cookie of cookies) {
    if (typeof cookie !== 'string') continue;
    const pair = cookie.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    jar.values.set(name, pair.slice(index + 1).trim());
    jar.raw.set(name, cookie);
  }
  return jar;
}

/** Last write wins, exactly like a browser: a pre-auth cookie is replaced by the signed-in one. */
export function absorbCookies(response: Response, jar: CookieJar): void {
  for (const value of setCookieValues(response)) {
    const pair = value.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    jar.values.set(name, pair.slice(index + 1).trim());
    jar.raw.set(name, value);
  }
}

/** The product's own `Set-Cookie` values, one per name, as the launch hop will re-emit them. */
export function emittedCookies(jar: CookieJar): string[] {
  return [...jar.raw.values()];
}

export function setCookieValues(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.();
  if (values !== undefined && values.length > 0) return values;
  const single = response.headers.get('set-cookie');
  return single === null ? [] : [single];
}

export function cookieHeader(values: ReadonlyMap<string, string>): string {
  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Resolves a Location, keeping only the path: the internal origin is the only one we speak to. */
export function pathOf(location: string, publicOrigin: string): string {
  try {
    const url = new URL(location, publicOrigin);
    return `${url.pathname}${url.search}`;
  } catch {
    return location.startsWith('/') ? location : `/${location}`;
  }
}

export function absolute(pathOrUrl: string, origin: string): string {
  try {
    const url = new URL(pathOrUrl, origin);
    // A product that answers with an absolute URL to its public host must be rewritten: this client
    // is inside the network and cannot resolve the public name.
    return `${origin}${url.pathname}${url.search}`;
  } catch {
    return `${origin}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
  }
}

export function text(response: Response): Promise<string> {
  return response.text().catch(() => '');
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
