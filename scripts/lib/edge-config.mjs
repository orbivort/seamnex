/**
 * NFR-4.1 / ISSUE-07 — the product URL a deployment advertises has to be one the edge actually
 * serves.
 *
 * The edge terminates TLS on every route (ADR-BE-39). `.env` is only written when it is missing, so an
 * install created before that change keeps `http` + `8020` and gains no `SEAMNEX_EDGE_TLS_MODE`: its
 * launch links and OIDC redirect URIs name a port nothing listens on, and `.localhost` routes are
 * projected as ACME for a CA that cannot validate them. Neither failure appears at startup — the first
 * symptom is a dead link in a browser — so the check lives next to the entry point a developer runs.
 *
 * Kept free of I/O and of `process` so the same rule can be exercised directly, and so `dev.mjs` keeps
 * owning the wording of the failure.
 */

/** The port the dev edge used before it terminated TLS; still in `.env` files written before. */
const PRE_TLS_DEV_PORT = '8020';

const LOCAL_DOMAIN = /(^|\.)localhost$/;

/**
 * The values a browser is told to use, resolved with the same defaults `AppConfig` applies.
 * `process.env` is not consulted here: the caller decides which map wins.
 */
export function productUrlFor(env) {
  const scheme = env.SEAMNEX_PRODUCT_URL_SCHEME ?? 'https';
  const port = env.SEAMNEX_PRODUCT_URL_PORT ?? '';
  const domain = env.SEAMNEX_INGRESS_DOMAIN ?? 'localhost';
  const tlsMode = env.SEAMNEX_EDGE_TLS_MODE ?? 'acme';
  return {
    scheme,
    port,
    domain,
    tlsMode,
    url: `${scheme}://<slug>.${domain}${port === '' ? '' : `:${port}`}`,
  };
}

/**
 * Every reason this configuration cannot describe the edge's TLS, with the remedy in the same string,
 * so the caller can print them as a list without reconstructing the advice.
 */
export function edgeConfigProblems(env) {
  const { scheme, port, domain, tlsMode } = productUrlFor(env);
  const problems = [];

  if (scheme !== 'https') {
    problems.push(
      'SEAMNEX_PRODUCT_URL_SCHEME=http  ->  https (the edge publishes no plain port since ADR-BE-39)',
    );
  }
  if (LOCAL_DOMAIN.test(domain) && tlsMode === 'acme') {
    problems.push(
      'SEAMNEX_EDGE_TLS_MODE=acme (or unset)  ->  internal (no CA can validate `.localhost`; the dev edge serves its own certificate)',
    );
  }
  /*
   * A wildcard needs two labels. The edge's certificate carries `*.<domain>`, and no verifier matches
   * `*.localhost` — OpenSSL answers `error 62 hostname mismatch`, Chromium `ERR_CERT_COMMON_NAME_INVALID`.
   * An install whose `.env` still says `localhost` therefore certifies nothing, and it says so here
   * rather than in a browser on the first product the platform launches.
   */
  if (tlsMode === 'internal' && !domain.includes('.')) {
    problems.push(
      `SEAMNEX_INGRESS_DOMAIN=${domain}  ->  seamnex.localhost (the edge's certificate covers ` +
        '`*.<domain>`, and a wildcard whose base has no dot is rejected by every browser and client)',
    );
  }
  if (scheme === 'https' && port === PRE_TLS_DEV_PORT) {
    problems.push(
      `SEAMNEX_PRODUCT_URL_PORT=${PRE_TLS_DEV_PORT}  ->  8443 (the dev edge terminates TLS on 8443, not on the old plain port)`,
    );
  }

  return problems;
}
