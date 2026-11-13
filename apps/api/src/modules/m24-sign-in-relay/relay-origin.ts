import type { Logger } from '@nestjs/common';
import type { AppConfig } from '../../config/config';
import type { DockerEngineClient } from '../../common/docker/docker.client';
import { instanceNetwork } from '../../common/docker/naming';

/**
 * Where the relay (and the provisioning client) talks to a product, and how it gets there.
 *
 * Both are shared because getting either wrong is silent: an address the container cannot resolve
 * fails as `product_unavailable`, and a `Host` that disagrees with `Origin` makes Rails answer `422`
 * to a correct password. One implementation means one place to fix.
 */

/** `http://<slug>:<httpPort>` — the alias the renderer attaches to the instance network. */
export function internalOriginFor(slug: string, payload: Record<string, unknown>): string | null {
  const port = Number(payload.httpPort ?? 0);
  if (!Number.isInteger(port) || port <= 0) return null;
  return `http://${slug}:${port}`;
}

/**
 * The origin a browser uses. `Host`, `Origin` and `Referer` all carry it: the product compares the
 * three, and builds its own redirects from them (measured — see `platform/upstream/D09-01`).
 *
 * The port is stripped from `routeHost` first. The edge forwards the browser's `Host` verbatim, and a
 * browser includes a non-default port (`openproject.localhost:8020`), so appending the configured
 * port to it produced `…:8020:8020`. Two symptoms, both silent until a real launch: Rails answers
 * `422` to an `Origin` it cannot match, and `new URL()` throws on the malformed port in the
 * provisioning client. The configured port is the deployment's public port, so it wins either way.
 */
export function publicOriginFor(config: AppConfig, routeHost: string): string {
  const host = bareHost(routeHost);
  const port =
    config.SEAMNEX_PRODUCT_URL_PORT.length === 0 ? '' : `:${config.SEAMNEX_PRODUCT_URL_PORT}`;
  return `${config.SEAMNEX_PRODUCT_URL_SCHEME}://${host}${port}`;
}

/** `Host` without its port, lowercased — the same normalisation the relaunch route match uses. */
export function bareHost(host: string): string {
  return host.replace(/:\d+$/, '').toLowerCase();
}

/**
 * The container this process runs in.
 *
 * Docker sets `HOSTNAME` to the container's short id unless a deployment overrides it. This is the
 * identity the join needs, because the process that dials the product must be the one that can
 * resolve it — and two roles dial it: the relay (sign-in) and the scheduler (provisioning).
 */
export function localContainerId(): string {
  return (process.env.HOSTNAME ?? '').trim();
}

/**
 * The container that must reach the product: an explicit override, else the caller itself.
 *
 * `SEAMNEX_RELAY_CONTAINER` cannot be the only answer. A fixed name can be right for exactly one of
 * the callers, and it was wrong for the other: the scheduler joined *the relay*, then dialled
 * `http://<slug>:<port>` from its own namespace and failed every product call as
 * `product_unavailable` — the sweep looked idle instead of misconfigured. The variable is kept for
 * the deployment where a sidecar makes the calls; otherwise a role joins itself.
 */
export function joinTargetFor(config: Pick<AppConfig, 'SEAMNEX_RELAY_CONTAINER'>): string {
  const configured = config.SEAMNEX_RELAY_CONTAINER.trim();
  return configured.length > 0 ? configured : localContainerId();
}

/**
 * How long a verified attachment is trusted before Docker is asked again.
 *
 * The memo it replaces was unbounded, and that is the whole defect: Docker membership dies with
 * either container (`compose up` recreates one, a reinstall recreates the network) while this
 * process still remembers joining, so every later product call resolved a name it could no longer
 * reach — `product_unavailable` on each launch, with nothing but a restart to clear it. A minute
 * heals the attachment inside one scheduler pass and still keeps the inspect off the launch path.
 */
const MEMBERSHIP_VERIFY_MS = 60_000;

/** Network name → when Docker last confirmed this process is attached to it. */
export type JoinedNetworks = Map<string, number>;

/**
 * Joins the calling container to the product's network before the first attempt.
 *
 * The edge and the IdP are attached by the same pattern, and for the same reason: a published
 * route's upstream (`http://<slug>:<port>`) resolves by an alias that only exists on the instance
 * network. When neither an override nor a hostname is available (a process outside Docker) there is
 * nothing to join, and the caller records `product_unavailable` rather than pretending.
 *
 * The attachment is *verified*, not assumed. `connectNetwork` is idempotent at the Docker level, so
 * asking again costs one inspect and removes the class of failure where the platform's own view of
 * the network outlives the network.
 */
export async function ensureInstanceJoined(
  docker: DockerEngineClient,
  config: AppConfig,
  logger: Logger,
  joined: JoinedNetworks,
  slug: string,
): Promise<void> {
  const container = joinTargetFor(config);
  if (container.length === 0) return;
  const network = instanceNetwork(slug);
  const verifiedAt = joined.get(network);
  if (verifiedAt !== undefined && Date.now() - verifiedAt < MEMBERSHIP_VERIFY_MS) return;
  try {
    const endpoints = await docker.networkEndpoints(network);
    if (endpoints.some((endpoint) => isSelf(endpoint, container))) {
      joined.set(network, Date.now());
      return;
    }
    await docker.connectNetwork(network, container);
    joined.set(network, Date.now());
  } catch (error) {
    logger.warn(
      `this process is not attached to ${network}: ${error instanceof Error ? error.message : String(error)}; the attempt will fall back to the product login`,
    );
  }
}

/**
 * Is this attachment the caller itself?
 *
 * Both identities occur: `HOSTNAME` is the short container id inside Docker, while a deployment may
 * set `SEAMNEX_RELAY_CONTAINER` to the container *name*. `NetworkEndpoint.id` is the full id and
 * `name` carries no leading slash in the Engine API, but a `/` is stripped anyway because the
 * compare is the whole point of this function.
 */
function isSelf(endpoint: { id: string; name: string }, container: string): boolean {
  const name = endpoint.name.replace(/^\//, '');
  return endpoint.id === container || endpoint.id.startsWith(container) || name === container;
}
