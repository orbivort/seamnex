# D09-01 — OpenProject (vendored definition)

| Field | Value |
| --- | --- |
| Product | OpenProject |
| Pinned release | `openproject/openproject:17.9.6` (GitHub release `v17.9.6`, 2026-10-30) |
| Image digest | `sha256:c4802aca392506c389ff10a2766caf949000383f20ac752ee5913e1793fdff98` |
| Catalogue `httpPort` | `80` — the port the container listens on |
| Repository | <https://github.com/opf/openproject> |

## Why this tree exists

The D09-01 entry used to declare `packaging: dockerfile` with a repository clone as its source. That
path cannot work on this platform:

- `opf/openproject` ships a **build** Dockerfile (upstream `docker/prod/Dockerfile`). The executor runs
  `docker compose build` inside the deploy-worker, and that needs a BuildKit session the scoped
  socket proxy refuses — the job reaches `apply` and dies with
  `unable to upgrade to tcp, received 403`.
- The repository also ships no Compose file, so there is nothing to resolve to instead.

The published artefact of the project is the all-in-one image `openproject/openproject`, which is
what production deployments use. This tree pins it.

## What the image contains

A single container under supervisord with:

- PostgreSQL 17, cluster in `$PGDATA` = `/var/openproject/pgdata`
- memcached (the Rails cache store the image selects by default)
- the Rails/Puma application and its background worker
- Apache as the HTTP front end on **port 80**, `ServerName` from `SERVER_NAME`

Because PostgreSQL, the cache and the worker live inside the container, the entry's `database`,
`cache` and `worker` dependency roles are satisfied internally. Do not add services for them.

## Volumes

| Volume | Mount | Holds |
| --- | --- | --- |
| `pgdata` | `/var/openproject/pgdata` | the bundled PostgreSQL cluster |
| `assets` | `/var/openproject/assets` | attachments (`files/`), `git/`, `svn/` |

The application tree (`/app`) is deliberately **not** mounted: the image owns it.

## Operational notes

- **First boot is slow.** The entrypoint creates the cluster, runs `db:migrate` and seeds the
  database before Apache answers. The healthcheck's `start_period` is 900 s for that reason; the
  platform's own `verify` stage waits `SEAMNEX_VERIFY_TIMEOUT_MS` (20 min on this checkout).
- **`SECRET_KEY_BASE` is mandatory.** Upstream ships `OVERWRITE_ME`, which is not a default worth
  inheriting. It is a required secret in `platform/catalog/env/D09-01.json` and is injected by the
  executor.
- **The seeded `admin` account is mandatory too.** Without
  `OPENPROJECT_SEED__ADMIN__USER__PASSWORD` the seeder applies its documented default and the log
  prints `default admin credentials are login: admin, password: admin`. The seeder runs once, while
  no administrator exists.
- **`OPENPROJECT_HOST__NAME` must equal the route host.** OpenProject builds absolute URLs from it;
  a mismatch produces links to a host the browser cannot resolve (it is also what the login
  redirect uses).
- **Community edition.** Native OIDC/SAML and several board features are Enterprise. The entry's
  guarantee class is `fa_gate`: the edge requires a platform session and the product still shows its
  local sign-in, because it consumes no forwarded identity header. That gap is recorded as the
  entry's `deviation`, not hidden.

## What the first deployment taught (2026-10-31)

Four defects were found by running the entry end to end, not by reading the file:

1. **The catalogue said `httpPort: 8080`.** That is the *host* side of the canonical example
   mapping (`8080:80`). The policy rewrites `ports:` to `expose: ['80']`, so nothing exposed 8080
   and `render` would have refused with `HTTP_PORT_NOT_EXPOSED`. It is `80`.
2. **`packaging: dockerfile` had no vendored tree.** Resolving the repository clone would have
   reached `apply` and died in `docker compose build`. This tree replaced it.
3. **The first healthcheck was wrong.** `curl http://127.0.0.1:80/health_checks/default` without a
   `Host` header matches Apache's `_default_` vhost — the static placeholder — and gets a 404. The
   container would have been declared unhealthy 15 minutes into a boot that worked. The probe now
   sends `Host: ${SERVER_NAME}`, so it exercises the same vhost the edge proxies to.
4. **Apache answers the placeholder before Rails does**, and it answers **200**. That is what a
   host-side `GET http://<slug>:80/` sees, which is why the platform's `verify` stage can report
   `ready` while OpenProject is still migrating. The container health status is the trustworthy
   signal; `V6`/a browser check is what closes the gap.

## Verified behaviour (17.9.6, route `projects.localhost:8020`)

| Probe | Result |
| --- | --- |
| `GET /health_checks/default` with the route `Host` | `200` `default: PASSED Application is running` |
| `GET /` with the route `Host` | `302 → http://projects.localhost:8020/login` (the port survives) |
| `GET /login` | `200`, `Sign in | OpenProject` |
| Sign-in as the seeded `admin` | forced password change, then the application home page |
| `GET /api/v3/work_packages` with the session | `200`, `WorkPackageCollection` |
| `GET /` on the edge without a platform session | `401` (forward-auth, as designed) |

## Deployment record — 2026-11-01

Deployed through the catalogue by `product-check-and-deploy` (17 checks pass), from the entry as it
stands: no instance override, no environment profile value, slug `projects`.

| Fact | Observed |
| --- | --- |
| Entry / instance | `D09-01` · `394ba162-da80-44b2-b00f-1f58e8801881` (`projects`) |
| Deploy job | `7e820878-6448-4d99-9fb8-7e4822d1142b` `succeeded` in 52 s (7 stages) |
| Image | `openproject/openproject:17.9.6` @ `sha256:c4802aca…ff98` |
| Container | `seamnex-projects-openproject-1`, running, healthy, 0 restarts |
| Route | `projects.localhost` published (`fa_header`) |
| Identity client | `seamnex-projects`, redirect `http://projects.localhost:8020/oauth2/callback` |
| Env defaults used | `OPENPROJECT_HOST__NAME=projects.localhost`, `SERVER_NAME=projects.localhost`, `OPENPROJECT_HTTPS=false` |

What this run added to the file above:

1. **`OPENPROJECT_HOST__NAME` and `SERVER_NAME` were already the published host**, so the two values
   resolve from the catalogue default and the container received them unchanged. A sign-in redirect
   proves it: `GET /` answers `302 → http://projects.localhost/login`, not `localhost`.
2. **The "default admin credentials" log line is not a signal.** The all-in-one image prints it
   unconditionally after the database setup (`/app/docker/prod/supervisord` in the image), so it
   appeared even though `OPENPROJECT_SEED__ADMIN__USER__PASSWORD` was supplied. The account was
   verified directly instead:
   `User.find_by(login: "admin").check_password?(ENV[…])` → `true`, `force_password_change` → `true`.
3. **A scripted sign-in must send the dev port in `Host`.** `POST /login` answered `422 Unable to
   verify Cross-Site Request Forgery token` until the probe sent `Host: projects.localhost:8020`
   together with the matching `Origin`; with the port it reached the authenticated
   "Change password | Account settings" page. The platform's own readiness probe sends the bare host
   and only asserts `< 500`, which is why this never shows up in `verify`.

## What the second deployment taught (2026-11-02)

The instance deployed and reported `ready`, and every request through the edge answered
`400 Invalid host_name configuration`. The container was healthy by its own lights at the moment the
job finished, so nothing in `verify` could have distinguished it from a working product.

**The defect was in `platform/catalog/env/D09-01.json`, not in the deployment.** Both
`OPENPROJECT_HOST__NAME` and `SERVER_NAME` carried a **URL** as their default —
`http://openproject.localhost:8020` — while their own `constraint` says *"Valid hostname; no scheme, no
path"*. The renderer copies a catalog default into the container verbatim
(`apps/api/src/modules/m03-renderer/renderer.service.ts`), so the wrong shape reached the process
without anything validating it. The wizard then persisted the same string as an **instance-level
override**, which is where it survived a schema fix: correcting the file alone changes what a *new*
instance gets, not what a running one holds.

Why the URL shape is fatal here and merely untidy for other entries: OpenProject copies
`host_name` into Rails' host allowlist —

```ruby
if OpenProject::Configuration.host_name.present?
  config.hosts = [OpenProject::Configuration.host_name] + OpenProject::Configuration.additional_host_names
```

— and Rails compares that entry against the request's `Host` header. `http://openproject.localhost:8020`
matches no header a browser or the edge can send, so `HostAuthorization` answers its own
`400 Invalid host_name configuration` before the application is reached. `D01-01`/`D02-01`/`D06-01`/`D11-01` are not
affected by the same mistake: those products take an absolute base URL, which is what a URL default is.

Measured on the broken instance:

| Probe | Result |
| --- | --- |
| `curl -H "Host: openproject.localhost:8020" http://127.0.0.1/` in the container | `400` `Invalid host_name configuration` |
| the same without a `Host` header | `200` Apache `_default_` placeholder ("expects to be reached on the following domain: http://openproject.localhost:8020") |
| the container healthcheck | `curl: (22) The requested URL returned error: 400` — it forwards `SERVER_NAME` as `Host` |

Fix, and what it took to land it:

1. `platform/catalog/env/D09-01.json` (both the checked-in baseline and the working tree) — defaults
   are now `openproject.localhost`; each `purpose` states the bare-host rule and the 400 it prevents.
   `POST /catalog/reload` reported `environment.changed: 2` for `D09-01`.
2. The two instance overrides were replaced with the bare host through `PUT /instances/<id>/env`.
   A catalog-default fix alone would have left the running instance on the stored override.
3. `Setting.host_name` carries **no** `settings` row on this image, so it is read from the env var on
   every boot; there was nothing to repair in the database (`Setting.where(name: "host_name").count`
   → `0`).

The first `reconfigure` job then failed for an unrelated reason worth recording: `STATE_CONFLICT`,
*"instances/openproject/instance.yaml does not match its recorded hash"*. The message comes from the
sticky `instanceParamDrift` flag on `instance.payload`, not from a live comparison — the file and
`instance_param.content_hash` were equal (both `edcddbb2…b647`, verified on the host and inside the
`api` container). Only `InstanceParamsService.verifyAll()` clears the flag, and it runs at API start,
so a drifted-then-reconciled definition stays blocked until the control plane restarts. Clearing it
is the reconciliation `verifyAll()` itself performs; the next `reconfigure` reached `succeeded`.

Verified after the fix (route `openproject.localhost:8020`):

| Probe | Result |
| --- | --- |
| `GET /health_checks/default` with `Host: openproject.localhost` | `200` |
| `GET /` with the route `Host` | `302 → http://openproject.localhost/login` |
| `GET /` on the edge without a platform session | `401` (forward-auth) |
| `GET /` on the edge with a session | `302 → http://openproject.localhost:8020/login` (the port survives) |
| `GET /login` | `200`, `Sign in | OpenProject` |
| container health | `healthy`, failing streak 0 |

## Single sign-on — what the image can and cannot do (measured 2026-11-04)

The image ships `modules/openid_connect` in full: a seeding path, an admin UI, attribute and group
mapping, and back-channel logout. **None of it runs on the Community edition.** The OmniAuth
strategy is registered only when the Enterprise token allows the feature
(`modules/auth_plugins/lib/open_project/plugins/auth_plugin.rb`):

```ruby
def self.filtered_strategy?(_strategy_key, provider)
  name = provider[:name]&.to_s
  EnterpriseToken.allows_to?(:sso_auth_providers) || name == "developer"
end
```

Measured on this image (`openproject/openproject:17.9.6`, `OPENPROJECT_EDITION=standard`):

| Probe | Result |
| --- | --- |
| `EnterpriseToken.allows_to?(:sso_auth_providers)` | `false` |
| `OpenIDConnect::Provider.count` | `0` |
| forwarded identity header consumed by the product | none — a search of `/app` finds no consumer of `X-Platform-*`, `REMOTE_USER` or any `HTTP_X_*` identity |
| `GET /` through the edge **with** a platform session | `302 → /login` — the product asks for its own password |

Consequences for the platform:

- the entry is `fa_gate` (FR-2.16 c), not `fa_header`: the route is protected, the product is not
  signed in by the edge;
- the identity client registered for the instance is unused, and its redirect URI is now
  `/auth/keycloak/callback` (`AuthProvider#callback_url`), which is what the product would serve;
- `OPENPROJECT_SEED__ADMIN__USER__PASSWORD` is the only product credential the platform holds, and
  it is read once, on the first boot.

Enabling native OIDC needs an Enterprise token first, and its environment keys carry a non-obvious
escaping rule. The provider is seeded from the environment on every container start, so the flip
itself is a catalogue change.
