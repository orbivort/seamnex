import { unauthorized } from './identity-errors';

/**
 * An origin allowlists a *host*, not a redirect: any path under it would let the exchange accept a
 * callback the client never registered, which is an open redirect the moment the code is added to
 * it. The path is therefore matched exactly against `AUTH_REDIRECT_PATHS`, and a query string or
 * fragment is refused — a registered callback URL carries neither.
 *
 * The live provider gets a second, independent check: Keycloak refuses a `redirect_uri` that is not
 * registered on the client. This assertion is what keeps the two registries saying the same thing.
 */
export function assertRedirectUri(
  redirectUri: string,
  allowedOrigins: readonly string[],
  redirectPaths: readonly string[],
): void {
  const parsed = parse(redirectUri);
  if (parsed === null) throw unauthorized();
  if (parsed.search.length > 0 || parsed.hash.length > 0) throw unauthorized();

  const origin = originOf(parsed);
  const path = parsed.pathname.replace(/\/$/, '').toLowerCase();
  const allowed =
    allowedOrigins.includes(origin) && redirectPaths.some((candidate) => candidate === path);
  if (!allowed) throw unauthorized();
}

/** `scheme://host[:port]`, lower-cased, with no trailing slash — the form `APP_ORIGINS` keeps. */
export function originOf(uri: URL | string): string {
  const parsed = typeof uri === 'string' ? parse(uri) : uri;
  if (parsed === null) return '';
  return `${parsed.protocol}//${parsed.host}`.toLowerCase();
}

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}
