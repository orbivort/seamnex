import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Configuration is parsed once, at boot, and a failure stops the process.
 *
 * Two rules that later phases depend on:
 *   - the stub identity provider is refused in production unless it is explicitly acknowledged,
 *     so nobody can ship the development sign-in by leaving a default in place;
 *   - a missing `DATABASE_URL` is a startup error, so a role never reports healthy while it has
 *     nowhere to write.
 */

/**
 * `GET /api/v1/...` is the only prefix; the SPAs are served from the same origin in production, so
 * a relative API base keeps cookies same-origin (design §5, deliverable 1.7).
 *
 * It lives in the config module rather than in `create-app` because the route table is built from
 * the contract and cannot import the file that creates the application (a cycle).
 */
export const API_PREFIX = 'api/v1';

export const ROLE_IDS = [
  'api',
  'deploy-worker',
  'sync-worker',
  'status-sampler',
  'backup-runner',
  'scheduler',
  'auth-gateway',
  'broker-proxy',
  'trigger-ingress',
  'relay',
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

/**
 * Per-role pool size (design §13.1).
 *
 * The API role serves requests and may use the configured ceiling. Every worker role holds a
 * connection for the duration of a step — and, for the deploy worker, for the length of a docker
 * operation — so it takes a quarter of it, with a floor of two. Applying `DATABASE_POOL_MAX`
 * verbatim to all nine roles multiplied the documented intent by nine, which is how a default of
 * ten became ninety connections against a cluster sized for a hundred.
 */
export function poolMaxForRole(role: RoleId, configuredMax: number): number {
  if (role === 'api') return configuredMax;
  return Math.max(2, Math.ceil(configuredMax / 4));
}

/** Every role's pool at once, which is what PostgreSQL actually sees. */
export function aggregateConnections(configuredMax: number): number {
  return ROLE_IDS.reduce((total, role) => total + poolMaxForRole(role, configuredMax), 0);
}

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

/**
 * Credential defaults that exist only so the development stack boots without a `.env`. They are
 * written in this repository, so they are public: `superRefine` refuses them under
 * `NODE_ENV=production`, and the schema defaults read from here so the two can never drift.
 */
const DEVELOPMENT_CREDENTIAL_DEFAULTS = {
  S3_ACCESS_KEY: 'seamnex_s3',
  S3_SECRET_KEY: 'seamnex_s3_dev_password',
} as const;

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SEAMNEX_ROLE: z.enum(ROLE_IDS).default('api'),
    /**
     * Build identity, not operator configuration: the release tag the image was built from and the
     * commit inside it. Both are build args (`apps/api/Dockerfile`), so the defaults describe a
     * checkout that was never packaged — `0.0.0` is the placeholder the whole workspace carries
     * between releases, never a claim that a release exists.
     */
    SEAMNEX_BUILD_VERSION: z.string().min(1).default('0.0.0'),
    SEAMNEX_BUILD_REVISION: z.string().min(1).default('unknown'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    HOST: z.string().min(1).default('0.0.0.0'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see .env.example)'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    /**
     * The cluster-wide ceiling every role's pool must fit inside. The platform runs one process per
     * role and each process opens its own pool, so `DATABASE_POOL_MAX` on its own says nothing about
     * how many connections reach PostgreSQL. Raising this is the deliberate act of raising
     * `max_connections` (or putting PgBouncer in front); it is not a tuning knob to leave at a guess.
     */
    DATABASE_CONNECTION_BUDGET: z.coerce.number().int().min(1).max(10_000).default(100),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required (see .env.example)'),

    SEAMNEX_ROOT_KEY_FILE: z.string().min(1).default('./temp/seamnex-root-key'),
    /**
     * Refuse a root key readable by other users. Off by default only in the development stack, where
     * a Docker Desktop bind mount reports mode 0777 for a file that is 0600 on disk.
     */
    SEAMNEX_ROOT_KEY_STRICT_MODE: booleanish.default(true),

    /**
     * `stub` is the Phase 3 identity provider: a local authorization-code + PKCE exchange with no
     * network call. `oidc` is the Phase 4D seam; booting it now fails fast so no environment can
     * believe Keycloak is wired when it is not.
     */
    AUTH_PROVIDER: z.enum(['stub', 'oidc']).default('stub'),
    /** Where the stub directory lives; absent entries fall back to the built-in development users. */
    AUTH_STUB_DIRECTORY: z.string().min(1).default('./temp/stub-identity.json'),
    /**
     * The registered callback path(s) an authorization code may be exchanged for. An origin is not
     * a redirect registry: accepting any path under an allow-listed origin turns a future provider
     * mistake into a code-leak open redirect, so the path is matched exactly (ADR-BE-13).
     */
    AUTH_REDIRECT_PATHS: z.string().min(1).default('/sign-in'),
    /** Comma-separated browser origins allowed to make cookie-authenticated unsafe requests. */
    APP_ORIGINS: z
      .string()
      .min(1)
      .default('http://localhost:5173,http://localhost:5174,http://localhost:8080'),
    /**
     * 4D — the OIDC relying party.
     *
     * The issuer is the address the *browser* is sent to and the value the ID token's `iss` must
     * carry. It is not necessarily the address this process can reach: in the development stack
     * Keycloak runs with `KC_HOSTNAME=http://localhost:8082` while the API resolves it as
     * `http://keycloak:8080`. `AUTH_INTERNAL_URL` is that second address; empty means "the same as
     * the issuer". Validating `iss` against the public value while calling the internal one is what
     * keeps a containerised IdP from producing "Invalid token issuer" on every sign-in.
     */
    AUTH_ISSUER_URL: z.string().default(''),
    AUTH_INTERNAL_URL: z.string().default(''),
    /** The client the browser flow was started for; also the token's expected audience. */
    AUTH_CLIENT_ID: z.string().min(1).default('seamnex-platform-ui'),
    /**
     * Only for a confidential client. Empty means the client is public and the code exchange is
     * authorised by PKCE alone, which is the shipped development shape.
     */
    AUTH_CLIENT_SECRET: z.string().default(''),
    /** `groups` is a Keycloak client scope that must exist on the realm, not a standard OIDC scope. */
    AUTH_SCOPES: z.string().min(1).default('openid profile email groups'),
    /** Tolerance for `exp`/`iat`/`nbf`. A large value widens the replay window of a stolen token. */
    AUTH_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(60),
    /** Discovery is re-read at most this often; zero refetches per call (tests, rotation drills). */
    AUTH_DISCOVERY_CACHE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(3_600),
    /**
     * Floor between refetches triggered by an unknown `kid`. Without it, a token with a random key
     * id turns every sign-in attempt into a request against the identity provider.
     */
    AUTH_JWKS_MIN_REFRESH_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    /** Timeout for discovery, JWKS and token calls. A dead IdP must fail fast, not hold a request. */
    AUTH_HTTP_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
    /**
     * Which peer may set `X-Forwarded-For`. Empty means "trust nobody": `request.ip` is then the
     * socket address, so a client cannot mint a fresh rate-limit bucket per request by sending its
     * own header. Set it to the edge's address or CIDR list (comma separated), or `1`/`true` when
     * the API is only reachable through that edge (the dev stack). See ADR-BE-13.
     */
    TRUST_PROXY: z.string().default(''),
    SESSION_COOKIE_NAME: z.string().min(1).default('seamnex_session'),
    CSRF_COOKIE_NAME: z.string().min(1).default('seamnex_csrf'),
    /**
     * Optional parent domain for the session cookie, for a deployment where the portal and its
     * products already share a registrable parent. Unset keeps the cookie host-only.
     *
     * The forward-auth gate does **not** depend on this: the launch ticket plants the session on
     * the product's own host (`/__seamnex/session`), because a browser will not carry `localhost`'s
     * cookie to `shop.localhost` — Chromium scopes such a cookie to the `localhost` host alone.
     */
    SESSION_COOKIE_DOMAIN: z.string().min(1).optional(),
    /** Production is HTTPS-only; the development stack runs on plain localhost. */
    SESSION_COOKIE_SECURE: booleanish.default(false),
    /**
     * How long a launch ticket stays redeemable. The portal mints one per open, so this only has to
     * survive the redirect; seconds rather than minutes keeps a leaked URL worthless.
     */
    LAUNCH_TICKET_TTL_SECONDS: z.coerce.number().int().min(5).max(900).default(60),
    /** Identity sync cadence and batch size (deliverable 3.6). */
    SEAMNEX_SYNC_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
    SEAMNEX_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(200),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    SEAMNEX_JOB_STREAM_MAX: z.coerce.number().int().min(1).max(10_000).default(100),
    SEAMNEX_METRICS_ENABLED: booleanish.default(true),
    SEAMNEX_SCHEDULER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(60_000),
    /** Days of `job_log` partitions kept ahead of today. A missing partition fails every append. */
    SEAMNEX_PARTITION_LOOKAHEAD_DAYS: z.coerce.number().int().min(1).max(180).default(9),
    SEAMNEX_JOB_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),
    /**
     * ADR-BE-09 D5: the catalogue working tree. A development default keeps `pnpm dev` working
     * without cloning; production sets it explicitly (ADR-BE-08).
     */
    SEAMNEX_CATALOG_REPO_PATH: z.string().min(1).default('./temp/catalog-repo'),

    // ---- Phase 4 adapters (ADR-BE-12) -------------------------------------------------------
    /**
     * `real` binds every external system; `disabled` refuses the affected operations with a `503`
     * that names the dependency instead of failing mid-job. No fake driver is shipped, so a
     * `disabled` platform is honest about what it cannot do rather than pretending to deploy.
     */
    SEAMNEX_ADAPTERS_MODE: z.enum(['real', 'disabled']).default('real'),

    /** Comma-separated hosts a customer-supplied source URL may use (4A.2, SSRF guard). */
    SEAMNEX_SOURCE_ALLOWED_HOSTS: z
      .string()
      .min(1)
      .default('github.com,gitlab.com,codeberg.org,git.sr.ht'),
    /**
     * Vendored upstream trees, one directory per catalog entry (`<dir>/<entryKey>/`). When an entry
     * has one, the resolver uses it instead of cloning: a host with no route to the git host (an
     * air-gapped SMB, a filtered network, a frozen audit baseline) can still deploy the exact
     * revision the operator reviewed. Empty resolves to `<SEAMNEX_CATALOG_REPO_PATH>/upstream`.
     */
    SEAMNEX_SOURCE_MIRROR_DIR: z.string().default(''),

    /** Docker Engine endpoint. In the stack this is the socket proxy, never the raw socket. */
    SEAMNEX_DOCKER_HOST: z.string().min(1).default('unix:///var/run/docker.sock'),
    SEAMNEX_DOCKER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    /**
     * How long the `verify` stage waits for containers to run and answer HTTP. A first install
     * creates its database schema inside the container (EspoCRM: tens of seconds), so a 60 s window
     * failed deployments that were still progressing — and the retry then passed, which is the worst
     * kind of flake.
     */
    SEAMNEX_VERIFY_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(1_800_000).default(300_000),
    /**
     * How many restarts of one container `verify` tolerates before it stops waiting.
     *
     * The timeout above is a budget, not a diagnosis: a container that aborts on a bad configuration
     * value every 60 s will never answer, and waiting the whole budget reported it as "did not become
     * ready within 1200 s" — a slow product — instead of "this process has crashed 3 times". One
     * restart is allowed because compose may recreate a container once during apply; three is a loop.
     */
    SEAMNEX_VERIFY_MAX_RESTARTS: z.coerce.number().int().min(1).max(50).default(3),
    /**
     * How long a container may report `unhealthy` before `verify` stops waiting. `0` disables the
     * signal, for a host whose healthchecks are known to be slow. The image's `start_period` is
     * honoured by Docker first: a container still in `starting` is not yet unhealthy.
     */
    SEAMNEX_VERIFY_UNHEALTHY_GRACE_MS: z.coerce.number().int().min(0).max(600_000).default(120_000),
    /**
     * Instance working trees: render sets, instance.yaml, scaffold drafts (no secrets).
     *
     * The capacity guard also measures this filesystem (design §13.2's volume pool). It used to
     * measure `process.cwd()`, which is the container image's overlay: on the dev stack that
     * reported the Docker VM's 1 TB overlay as "host disk" while instance data was on a different
     * volume (451 GB), so the disk axis judged a disk nothing was written to.
     */
    SEAMNEX_INSTANCE_DATA_DIR: z.string().min(1).default('./temp/instances'),
    /** Traefik file-provider directory; the route projection is the only writer. */
    SEAMNEX_TRAEFIK_DYNAMIC_DIR: z.string().min(1).default('./temp/traefik/dynamic'),
    /**
     * Container the route projection attaches to each instance network (the edge). Empty disables
     * it: a route written for an edge that is not on the network would be a published 502.
     */
    SEAMNEX_EDGE_CONTAINER: z.string().default(''),
    SEAMNEX_TRAEFIK_ACME_EMAIL: z.string().default(''),

    /** Keycloak Admin REST API; the client secret lives in M15, never in this file. */
    SEAMNEX_KEYCLOAK_ADMIN_URL: z.string().min(1).default('http://localhost:8082'),
    SEAMNEX_KEYCLOAK_REALM: z.string().min(1).default('seamnex'),
    SEAMNEX_KEYCLOAK_ADMIN_CLIENT_ID: z.string().min(1).default('seamnex-platform-admin'),
    SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: z.string().default(''),
    /**
     * 4D.5 — the identity the SSO check signs in as. A test account in the platform realm, never a
     * real user's. The password is a *file path*: the probe reads it per run, so rotating it does
     * not need a restart and the value never appears in process arguments or logs.
     *
     * Both empty means the check stops at "Keycloak accepted the authorization request" and says so
     * in its detail line, rather than claiming a login it did not perform.
     */
    SEAMNEX_SSO_PROBE_USERNAME: z.string().default(''),
    SEAMNEX_SSO_PROBE_PASSWORD_FILE: z.string().default(''),

    /** n8n REST API. An empty key means the broker refuses workflow activation with `503`. */
    SEAMNEX_N8N_URL: z.string().min(1).default('http://localhost:5678'),
    SEAMNEX_N8N_API_KEY: z.string().default(''),
    SEAMNEX_N8N_EXECUTION_POLL_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),

    /** Mailpit's HTTP send API (4B.3). The dev stack ships Mailpit; a production host points at its MTA. */
    SEAMNEX_MAILPIT_URL: z.string().min(1).default('http://localhost:8025'),
    SEAMNEX_NOTIFY_FROM: z.string().min(1).default('platform@seamnex.local'),
    /** Health alerts are de-duplicated per instance for this long. */
    SEAMNEX_NOTIFY_DEDUPE_MINUTES: z.coerce.number().int().min(1).max(1_440).default(30),

    /** Backup target (ADR-BE-11). Path-style addressing so VersityGW and S3 both work. */
    S3_ENDPOINT: z.string().min(1).default('http://localhost:9000'),
    S3_ACCESS_KEY: z.string().min(1).default(DEVELOPMENT_CREDENTIAL_DEFAULTS.S3_ACCESS_KEY),
    S3_SECRET_KEY: z.string().min(1).default(DEVELOPMENT_CREDENTIAL_DEFAULTS.S3_SECRET_KEY),
    S3_BUCKET: z.string().min(1).default('seamnex-backups'),
    S3_REGION: z.string().min(1).default('us-east-1'),
    SEAMNEX_BACKUP_TMP_DIR: z.string().min(1).default('./temp/backups'),
    /** `age` recipient used to encrypt every backup before it leaves the host. */
    SEAMNEX_AGE_RECIPIENT: z.string().default(''),
    SEAMNEX_AGE_IDENTITY_FILE: z.string().min(1).default('./temp/seamnex-age-identity'),
    SEAMNEX_AGE_BINARY: z.string().min(1).default('age'),

    /** 4D.2: the zone product routes are published under when an instance does not name a host. */
    /**
     * `localhost`, not a made-up zone: RFC 6761 reserves the name and every mainstream browser maps
     * `<slug>.localhost` to loopback, so a product route resolves on a fresh machine with no hosts
     * file. A real zone is still the production value — see `.env.example`.
     */
    SEAMNEX_INGRESS_DOMAIN: z.string().min(1).default('localhost'),
    /**
     * 4D.2: how a *browser* addresses a published product route. The platform publishes no host
     * port, so the edge owns the scheme and the port. `https` on 443 is the production default; the
     * dev edge terminates plain HTTP on 127.0.0.1:8020 and sets `http` + `8020`. A hardcoded
     * `https://<host>` made every launch link point at a port nothing was listening on.
     */
    SEAMNEX_PRODUCT_URL_SCHEME: z.enum(['http', 'https']).default('https'),
    SEAMNEX_PRODUCT_URL_PORT: z
      .string()
      .regex(/^$|^\d{1,5}$/, 'must be empty or a TCP port')
      .default(''),
    /**
     * 4D.1: the identity provider's container, joined to every instance network that has an OIDC
     * client. The token, JWKS and userinfo calls are made *by the product*, from its own network —
     * a Keycloak that only sits on the control network is unreachable from there, and the login
     * fails after the redirect with "could not resolve host". Empty disables the step.
     */
    SEAMNEX_IDP_CONTAINER: z.string().default(''),
    /**
     * The name the product uses for the IdP inside its network (`keycloak:8080`). A container joined
     * to a second network is not resolvable there by its compose service name unless that name is
     * passed as an alias, and Docker cannot add an alias to an existing attachment.
     */
    SEAMNEX_IDP_ALIAS: z.string().default('keycloak'),
    /**
     * The port the IdP listens on *inside* the instance network. The product is configured with
     * `http://<alias>:<port>`, and the SSO check proves that exact address answers from a container
     * on the instance network — the same call the product makes when it redeems a code.
     */
    SEAMNEX_IDP_INTERNAL_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    /**
     * 4D.5: how long a passing end-to-end SSO check is trusted. A label that says "single sign-on"
     * is a promise about the next launch, and the failure this window exists for — the IdP losing
     * its attachment to an instance network when a container is recreated — happens between checks.
     * Past the window the portal reports the sign-in path as unverified rather than as working.
     */
    SEAMNEX_SSO_EVIDENCE_TTL_MINUTES: z.coerce.number().int().min(1).max(10_080).default(60),
    /** How often the scheduler re-applies the IdP's attachment to each instance network. */
    SEAMNEX_IDP_RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(3_600_000)
      .default(60_000),
    /** 4D.6: a registry snapshot older than this is reported stale (never silently trusted). */
    SEAMNEX_REGISTRY_STALE_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),

    /** Restore fan-out: the design's floor is 4 and ceiling 12 (4C.4). */
    SEAMNEX_RESTORE_CONCURRENCY: z.coerce.number().int().min(4).max(12).default(4),
    /** Sampler cadence and per-probe timeout (4B.1). */
    SEAMNEX_SAMPLE_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(30_000),
    SEAMNEX_SAMPLE_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(16),
    SEAMNEX_SAMPLE_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(2_000),
    /** How often the sampler persists a `capacity_snapshot` row; the status probe stays faster. */
    SEAMNEX_CAPACITY_SAMPLE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(3_600_000)
      .default(60_000),

    /** Forward-auth decision cache lifetime; must stay well under a session idle timeout. */
    SEAMNEX_FORWARD_AUTH_CACHE_SECONDS: z.coerce.number().int().min(1).max(600).default(60),
    /** One-time break-glass credential reveal window (4F.1). */
    SEAMNEX_REVEAL_TTL_SECONDS: z.coerce.number().int().min(10).max(600).default(60),

    // ---- Sign-in relay (ADR-BE-22) -----------------------------------------------------------
    /**
     * Where Traefik sends `/__seamnex/session`. It is one deployment-wide value, not a per-instance
     * flag: the relay answers exactly today's pass-through for every product it must not touch, so
     * routing every launch through it keeps one hop instead of two code paths on the edge.
     *
     * The default is the `auth-gateway`, which is what a deployment that never enables the relay
     * keeps using unchanged.
     *
     * Validated as an origin because the value is written verbatim as a Traefik load-balancer
     * server, and one invalid server URL makes the file provider drop the instance's whole router:
     * the product 404s with nothing in the platform log to say why.
     */
    SEAMNEX_BOOTSTRAP_URL: z
      .string()
      .min(1)
      .refine(
        isHttpOrigin,
        'must be an http(s) origin with no path, query or fragment, e.g. http://relay:8091',
      )
      .default('http://auth-gateway:8090'),
    /**
     * Off by default, deliberately. Turning it on makes the platform the credential authority for a
     * product it does not own; that is a decision an operator records, not a default they inherit.
     * The development template (`.env.example`) opts in explicitly, because the dev stack runs the
     * relay role and a switch that disagrees with the hop is the silent failure ADR-BE-22 records.
     */
    SEAMNEX_RELAY_ENABLED: booleanish.default(false),
    SEAMNEX_RELAY_PORT: z.coerce.number().int().min(1).max(65_535).default(8091),
    /** Ceiling for one HTTP step of the relay. A slow login is a failed login, not a queued one. */
    SEAMNEX_RELAY_HTTP_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
    /**
     * 4E.4 — the broker listener. n8n calls this port; it is not part of the `/api/v1` contract and
     * never published by the edge, because a browser holding a workflow token must not reach a
     * product with it.
     */
    SEAMNEX_BROKER_PORT: z.coerce.number().int().min(1).max(65_535).default(8092),
    /**
     * What the **compiled** nodes call. It has to be an address n8n resolves, which is the broker's
     * service name on the control network — not the product, whose alias only exists on the instance
     * network, and not `https://<route host>`, which n8n cannot resolve at all (measured: the dev
     * n8n answers `EAI_AGAIN` for `orangehrm.localhost`).
     */
    SEAMNEX_BROKER_URL: z.string().url().default('http://broker-proxy:8092'),
    /** Ceiling for one brokered product call. A product that does not answer in this window fails. */
    SEAMNEX_EGRESS_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(30_000),
    /**
     * How long a discovered field list is trusted (FR-5.5). A day by default: a product's schema moves
     * at upgrade time, not during a session, and every drawer open must not become a product call.
     */
    SEAMNEX_FIELD_DISCOVERY_TTL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60 * 1_000)
      .default(24 * 60 * 60 * 1_000),
    /**
     * Days a captured node sample is kept (FR-5.5). Authoring data, not run history: the item exists
     * only to name fields, so it expires well before the run row it belongs to.
     */
    SEAMNEX_WORKFLOW_SAMPLE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /**
     * The platform's own ceiling on a cached product session. The product has no TTL enabled today
     * (`session_ttl_enabled` is false), so without this the cached cookie would outlive the
     * entitlement that justified it. The ADR's prerequisite (`OPENPROJECT_SESSION__TTL__ENABLED`)
     * caps it further; whichever is shorter wins.
     */
    SEAMNEX_RELAY_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(1_800).default(1_800),
    /**
     * How long one subject's login may hold the single-flight lock.
     *
     * It has to outlast the slowest sign-in, which is not one request: the driver fetches the form,
     * submits, may refetch once on a stale CSRF token, then walks up to four confirmation hops. At
     * the per-step ceiling that is a dozen HTTP steps, so a lock equal to three steps expires while
     * a slow login is still running — and the next tab then starts the second login the lock exists
     * to prevent.
     */
    SEAMNEX_RELAY_LOCK_SECONDS: z.coerce.number().int().min(5).max(120).default(60),
    SEAMNEX_RELAY_ROTATION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** Cadence of the provision/rotate sweep. Offboarding is event-driven and not on this timer. */
    SEAMNEX_RELAY_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(3_600_000)
      .default(300_000),
    /**
     * An explicit container to join to an instance network before the first product call (the product
     * is only reachable as `http://<slug>:<port>` from that network).
     *
     * Empty is the normal value and means "the caller joins itself": Docker sets `HOSTNAME` to the
     * container id, and both callers — the relay for sign-in, the scheduler for provisioning — need to
     * reach the product from their own namespace. A fixed name is only correct for a sidecar.
     */
    SEAMNEX_RELAY_CONTAINER: z.string().default(''),
    /**
     * Catalogue entries whose per-user accounts may be provisioned, addressed by their full
     * `catalog_entry.key`. `D09-01` is OpenProject, `D07-01` is OrangeHRM: the key is a primary key,
     * so it names one product and no other. The legacy short form (`D9`) is accepted and resolves to
     * the same entry, which keeps existing deployments working; it is an alias, not a second
     * selector.
     *
     * This list is consent, not capability: an entry also needs a registered adapter
     * (`login-adapter.ts`, `provisioning-adapters.ts`), and a listed entry without one is skipped
     * with `no_adapter` rather than guessed at. The default stays `D09-01` because adding a product
     * widens the FR-2.16 exception, which is a requirement change, not a config change.
     */
    SEAMNEX_RELAY_ENTRY_KEYS: z.string().default('D09-01'),
    /**
     * The instance-scoped secret holding the product's admin API token used for provisioning and
     * rotation (`bearer` adapters only). Absent means provisioning cannot run and says so; it is
     * never invented. Products whose API takes an administrator login pair name their own variables
     * on the adapter, and read them from the instance scope.
     */
    SEAMNEX_RELAY_ADMIN_SECRET_NAME: z.string().min(1).default('product_api_token'),
  })
  .superRefine((value, context) => {
    // ADR-BE-13: the stub provider accepts an authorization code the *browser* chose, so it is not
    // an authentication mechanism at all — it is a development affordance. There is no production
    // deployment of it to acknowledge: live OIDC (Phase 4D) is the only way to serve production.
    if (value.NODE_ENV === 'production' && value.AUTH_PROVIDER === 'stub') {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_PROVIDER'],
        message:
          'the stub identity provider is development-only; production must set AUTH_PROVIDER=oidc (Phase 4D)',
      });
    }
    if (value.NODE_ENV === 'production' && !value.SESSION_COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'SESSION_COOKIE_SECURE must be enabled when NODE_ENV=production',
      });
    }
    /*
     * The storage credentials have defaults so a development stack boots without a `.env`. They are
     * published in this repository, so they are not secrets: a production process that inherits
     * them encrypts every backup with a key everyone can read. The identity guards above are the
     * same rule; these close it for the adapter that actually moves data off the host.
     *
     * Only the *credentials* are refused. An endpoint default (`localhost:9000`) is a legitimate
     * single-host deployment and fails loudly on first use, which a boot refusal would not improve.
     */
    if (value.NODE_ENV === 'production') {
      for (const key of ['S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const) {
        if (value[key] === DEVELOPMENT_CREDENTIAL_DEFAULTS[key]) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is still the value published in this repository; production must set it explicitly`,
          });
        }
      }
    }
    /*
     * ADR-BE-22 residual risk: with the relay on, Redis holds the product's own session cookies —
     * bearer credentials for a product the platform does not own — as plain JSON. The ADR accepts
     * that only where Redis authenticates its clients and protects the transport, which was an
     * operator prerequisite the code never checked: a production boot with `redis://cache:6379`
     * started cleanly and cached credentials into a store anyone on the network could read.
     *
     * `rediss:` counts as transport protection; otherwise the URL has to carry a password. The
     * alternative recorded in the ADR — sealing the cached payload with the root key — is not taken:
     * the relay would then need the root key on its own boot path, widening that key's surface for a
     * value that a protected Redis already holds.
     */
    if (value.NODE_ENV === 'production' && value.SEAMNEX_RELAY_ENABLED) {
      if (!redisIsProtected(value.REDIS_URL)) {
        context.addIssue({
          code: 'custom',
          path: ['REDIS_URL'],
          message:
            'SEAMNEX_RELAY_ENABLED caches product session cookies in Redis, so production must ' +
            'protect that store: use rediss:// or a password in REDIS_URL (ADR-BE-22)',
        });
      }
    }
    // No role may configure a pool that cannot fit inside the cluster budget once every role is
    // running. Without this, `DATABASE_POOL_MAX=50` reads as "fifty per process" and fails at boot
    // with `too many clients already` under whichever role happens to connect last.
    const aggregate = aggregateConnections(value.DATABASE_POOL_MAX);
    if (aggregate > value.DATABASE_CONNECTION_BUDGET) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_POOL_MAX'],
        message:
          `DATABASE_POOL_MAX=${value.DATABASE_POOL_MAX} needs ${aggregate} connections across ` +
          `${ROLE_IDS.length} roles, above DATABASE_CONNECTION_BUDGET=${value.DATABASE_CONNECTION_BUDGET}. ` +
          'Lower DATABASE_POOL_MAX, or raise DATABASE_CONNECTION_BUDGET together with the ' +
          "database's max_connections (or add PgBouncer).",
      });
    }
    // The live provider is the only one that can serve production, so it has to be complete: an
    // issuer that is missing, relative or not a URL produces a boot that fails on the first
    // sign-in instead of at the moment the operator could still fix it.
    if (value.AUTH_PROVIDER === 'oidc') {
      for (const key of ['AUTH_ISSUER_URL', 'AUTH_INTERNAL_URL'] as const) {
        const raw = value[key].trim();
        if (raw.length === 0) {
          if (key === 'AUTH_ISSUER_URL') {
            context.addIssue({
              code: 'custom',
              path: [key],
              message:
                'AUTH_PROVIDER=oidc requires AUTH_ISSUER_URL (the realm issuer, e.g. https://idp.example/realms/seamnex)',
            });
          }
          continue;
        }
        // A relative issuer would validate nothing: `iss` is compared as an exact string.
        if (!/^https?:\/\/[^/\s]+/i.test(raw)) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'must be an absolute http(s) URL',
          });
        }
      }
    }
  });

export type AppConfig = Readonly<
  z.infer<typeof EnvironmentSchema> & {
    readonly isProduction: boolean;
    readonly isDevelopment: boolean;
    /** Anonymous operations: probe endpoints and the contract document (ADR-BE-06). */
    readonly anonymousPaths: readonly string[];
    /** Parsed `APP_ORIGINS`, lower-cased and trailing-slash-free. */
    readonly allowedOrigins: readonly string[];
    /** Parsed `AUTH_REDIRECT_PATHS`, leading-slash, lower-cased. */
    readonly authRedirectPaths: readonly string[];
    /** The expected `iss`, trailing slash removed. Empty when the stub is the provider. */
    readonly authIssuer: string;
    /** Where this process reaches the realm; equals `authIssuer` when `AUTH_INTERNAL_URL` is unset. */
    readonly authInternalBase: string;
    /** Parsed `AUTH_SCOPES`. */
    readonly authScopes: readonly string[];
    /** The registered callback path an SPA appends to its own origin (`/sign-in` by default). */
    readonly authRedirectPath: string;
    /**
     * Fastify's `trustProxy`: `false` (trust the socket), `true` (trust the whole chain, only safe
     * behind a single controlled edge) or the CIDR list that may set `X-Forwarded-For`.
     */
    readonly trustProxy: boolean | string[];
    /** Parsed `SEAMNEX_SOURCE_ALLOWED_HOSTS`, lower-cased. */
    readonly sourceAllowedHosts: readonly string[];
    /**
     * The pool size this process must open, derived from `DATABASE_POOL_MAX` and the role. Never
     * read `DATABASE_POOL_MAX` directly for a pool: that applies the API ceiling to every worker.
     */
    readonly poolMax: number;
  }
>;

const ANONYMOUS_PATHS = ['/healthz', '/readyz', '/metrics', '/openapi.json'] as const;

export class ConfigError extends Error {
  readonly issues: readonly { path: string; message: string }[];

  constructor(issues: readonly { path: string; message: string }[]) {
    super(
      `Invalid configuration: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  return Object.freeze({
    ...parsed.data,
    /*
     * Every filesystem setting is resolved against the repository root, not against the process
     * working directory — one rule for the whole class, because two rules is how this went wrong.
     *
     * `turbo run dev` starts this package from `apps/api`, so the documented `./temp/catalog-repo`
     * resolved to `apps/api/temp/catalog-repo`: a directory nothing creates, which the loader reports
     * as `absent` and a reload reconciles by deleting every projection. The same base applies to the
     * instance data, the route projection, the vendored-source mirror and the backup scratch: an
     * operator who reasons about `./temp/…` means the repository's own `temp/`, and the seed
     * (`packages/db/src/seed/default-catalog.ts`) resolves the catalogue path the same way. Absolute
     * values — the container's `/var/lib/seamnex/…` — are used verbatim.
     */
    SEAMNEX_CATALOG_REPO_PATH: resolveFromRepoRoot(parsed.data.SEAMNEX_CATALOG_REPO_PATH),
    SEAMNEX_SOURCE_MIRROR_DIR: resolveFromRepoRoot(parsed.data.SEAMNEX_SOURCE_MIRROR_DIR),
    SEAMNEX_INSTANCE_DATA_DIR: resolveFromRepoRoot(parsed.data.SEAMNEX_INSTANCE_DATA_DIR),
    SEAMNEX_TRAEFIK_DYNAMIC_DIR: resolveFromRepoRoot(parsed.data.SEAMNEX_TRAEFIK_DYNAMIC_DIR),
    SEAMNEX_BACKUP_TMP_DIR: resolveFromRepoRoot(parsed.data.SEAMNEX_BACKUP_TMP_DIR),
    SEAMNEX_AGE_IDENTITY_FILE: resolveFromRepoRoot(parsed.data.SEAMNEX_AGE_IDENTITY_FILE),
    isProduction: parsed.data.NODE_ENV === 'production',
    isDevelopment: parsed.data.NODE_ENV !== 'production',
    anonymousPaths: ANONYMOUS_PATHS,
    allowedOrigins: parsed.data.APP_ORIGINS.split(',')
      .map((origin) => origin.trim().replace(/\/$/, '').toLowerCase())
      .filter((origin) => origin.length > 0),
    authRedirectPaths: parsed.data.AUTH_REDIRECT_PATHS.split(',')
      .map((path) => path.trim().toLowerCase())
      .filter((path) => path.length > 0)
      .map((path) => (path.startsWith('/') ? path : `/${path}`)),
    authIssuer: trimTrailingSlash(parsed.data.AUTH_ISSUER_URL),
    authInternalBase: trimTrailingSlash(
      parsed.data.AUTH_INTERNAL_URL.trim().length > 0
        ? parsed.data.AUTH_INTERNAL_URL
        : parsed.data.AUTH_ISSUER_URL,
    ),
    authScopes: parsed.data.AUTH_SCOPES.split(/\s+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
    authRedirectPath:
      parsed.data.AUTH_REDIRECT_PATHS.split(',')
        .map((path) => path.trim().toLowerCase())
        .filter((path) => path.length > 0)
        .map((path) => (path.startsWith('/') ? path : `/${path}`))[0] ?? '/sign-in',
    trustProxy: parseTrustProxy(parsed.data.TRUST_PROXY),
    sourceAllowedHosts: parsed.data.SEAMNEX_SOURCE_ALLOWED_HOSTS.split(',')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
    poolMax: poolMaxForRole(parsed.data.SEAMNEX_ROLE, parsed.data.DATABASE_POOL_MAX),
  });
}

/** Repository root from `apps/api/src/config`; the image keeps the same layout under `/app`. */
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * A configured filesystem path, resolved against the repository root when it is relative.
 *
 * `process.cwd()` is the wrong base for these settings: the API is started from its own package
 * directory by `turbo run dev`, while `.env` and the documentation speak from the repository root.
 * Resolving here makes the two agree, and leaves an absolute path (every deployment) untouched.
 */
function resolveFromRepoRoot(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || isAbsolute(trimmed)) return trimmed;
  return resolve(REPO_ROOT, trimmed);
}

/**
 * `TRUST_PROXY` is a security boundary, not a convenience flag: with it on, the leftmost
 * `X-Forwarded-For` entry becomes `request.ip`, and that header is attacker-controlled unless the
 * peer is the edge. Empty is therefore "trust nobody".
 */
function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Whether a Redis URL authenticates its clients or encrypts the transport.
 *
 * `rediss:` is TLS all the way to the server; a password is the `AUTH` the URL carries. Neither says
 * anything about who else can reach the instance, which is why the relay still documents Redis as a
 * credential store rather than a scratch cache.
 */
function redisIsProtected(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'rediss:' || url.password.length > 0;
  } catch {
    // An unparseable URL cannot be shown to be protected; refuse it rather than assume.
    return false;
  }
}

/**
 * Whether the value is a bare `http(s)` origin.
 *
 * The relay hop is copied into a Traefik server URL without rewriting it, so a path, a query, a
 * fragment or a missing scheme does not degrade — it makes the projection invalid and the product
 * disappears. Credentials have no business in it either: the value is written to a file the edge
 * reads.
 */
function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function parseTrustProxy(value: string): boolean | string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (['1', 'true', 'yes', 'on'].includes(trimmed.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(trimmed.toLowerCase())) return false;
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Redacts everything a log line must never contain, for boot-time diagnostics. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    // `role` is already a pino base field; repeating it here produced a duplicate JSON key.
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    host: config.HOST,
    // What the boot line calls this release: the one field an operator quotes in a bug report.
    buildVersion: config.SEAMNEX_BUILD_VERSION,
    buildRevision: config.SEAMNEX_BUILD_REVISION,
    database: redactUrl(config.DATABASE_URL),
    // The connection count this process opens: the number to compare against `max_connections`
    // when a role reports "too many clients", without guessing which ceiling was applied.
    poolMax: config.poolMax,
    redis: redactUrl(config.REDIS_URL),
    authProvider: config.AUTH_PROVIDER,
    authIssuer: config.authIssuer.length > 0 ? config.authIssuer : '(stub)',
    authRedirectPaths: config.authRedirectPaths,
    trustProxy: config.trustProxy,
    adaptersMode: config.SEAMNEX_ADAPTERS_MODE,
    logLevel: config.LOG_LEVEL,
    metrics: config.SEAMNEX_METRICS_ENABLED,
    // The resolved tree, not the configured string: "the catalogue is absent" is the diagnosis an
    // operator has to make from this line, and a relative value cannot answer which directory was read.
    catalogRepoPath: config.SEAMNEX_CATALOG_REPO_PATH,
  };
}

const SENSITIVE_QUERY_KEYS =
  /^(password|pass|pwd|secret|token|sslkey|sslpassword|apikey|api_key)$/i;

/**
 * A connection string carries credentials in the userinfo *and* in query parameters
 * (`?sslpassword=`, `?password=`). Redacting only the former left the latter in the boot log.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password.length > 0) url.password = '********';
    if (url.username.length > 0) url.username = '********';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, '********');
    }
    return url.toString();
  } catch {
    return '********';
  }
}
