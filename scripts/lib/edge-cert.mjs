/**
 * NFR-4.1 / ISSUE-07 — the certificate the development edge terminates products with.
 *
 * `https://<slug>.<domain>:8443` is served by Traefik, not by Vite, and Traefik's built-in default is
 * a self-signed `CN=TRAEFIK DEFAULT CERT` whose only SAN is `*.traefik.default`. A browser therefore
 * reported an untrusted issuer *and* a hostname mismatch on every product URL, and scripted clients
 * (Playwright, Node, `curl`) refused the handshake — the development CA trusted for
 * `https://localhost:5173` was never presented by the edge at all.
 *
 * The edge now serves the leaf `packages/config/vite/dev-cert.ts` mints
 * (`docker/traefik/dynamic/tls.yml`, mounted from `temp/certs` by `docker/compose.dev.yml`). That leaf
 * carries `*.<SEAMNEX_INGRESS_DOMAIN>`, so one certificate covers every product slug and a deployment
 * never has to re-mint anything.
 *
 * The pair is produced here, before `up`, for the reason the other credential files are: Docker does
 * not treat a missing bind-mount source as an error, so a stack started before any dev server had run
 * would mount an empty directory — and a *directory* created at `temp/certs/dev.crt` breaks the next
 * mint as well. The module is TypeScript and imported as-is: Node 24 strips the types on load, so
 * `scripts/*.mjs` and the Vite config factory mint through one implementation instead of two that
 * can drift.
 */

/**
 * @param {string} root repository root
 * @param {(message: string) => void} [log]
 * @returns {Promise<boolean>} whether a usable pair is on disk
 */
export async function ensureEdgeCertificate(root, log = () => {}) {
  const module = await import('@seamnex/config/vite/dev-cert');

  let result;
  try {
    result = module.resolveDevCertificate(root);
  } catch (error) {
    // Never a startup failure: the datastores, the API and the dev servers do not need this file, and
    // an edge serving its own certificate is a worse browser experience, not an outage.
    log(
      `the edge certificate could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  if (result.certificate !== undefined) return true;

  // The reason already names the remedy; the consequence is what the operator cannot see from here.
  log(
    `${result.reason ?? 'no development certificate is available'}\n` +
      '  The edge will fall back to its own certificate: product URLs answer ' +
      'ERR_CERT_AUTHORITY_INVALID and a scripted client refuses them. See ' +
      'docs/operations/certificates.md.',
  );
  return false;
}
